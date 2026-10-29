/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Request dispatch, the `runtime.hello` handshake (`nyala/rpc/README.md` §3) and the stream loop.
//!
//! [`Server`] maps one frame payload to at most one reply and performs no I/O. [`serve`] drives
//! it over any `Read`/`Write` pair; `main.rs` passes stdin, stdout and stderr.

use std::collections::HashSet;
use std::io::{self, Read, Write};
use std::time::Instant;

use serde_json::{json, Map, Value};

use crate::error::{ErrorKind, RpcError};
use crate::framing::{
	encode_frame, FrameDecoder, FrameError, DEFAULT_FRAME_MAX_BYTES, PRE_HELLO_FRAME_MAX_BYTES,
};
use crate::protocol::{
	parse_message, Incoming, Request, JSONRPC_VERSION, MAX_CONCURRENT_EXECUTIONS, MAX_INITIAL_ROWS,
	MAX_PAGE_ROWS, MAX_RESULT_TTL_SECS, PROTOCOL_MAJOR, PROTOCOL_MINOR, RUNTIME_BUILD,
	RUNTIME_FEATURES, V1_REQUEST_METHODS,
};

/// Process exit status. Only [`ExitStatus::ProtocolMismatch`] (2) is fixed by the contract
/// (README §3); the other codes are this implementation's choice (see `docs/adr/0002-rust-runtime-workspace.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitStatus {
	/// The input ended on a frame boundary.
	Clean,
	/// The byte stream can no longer be trusted: a zero-length, oversize or truncated frame, or
	/// an I/O error.
	StreamError,
	/// `runtime.hello` asked for a different `protocolMajor`.
	ProtocolMismatch,
}

impl ExitStatus {
	pub fn code(self) -> u8 {
		match self {
			ExitStatus::Clean => 0,
			ExitStatus::StreamError => 1,
			ExitStatus::ProtocolMismatch => 2,
		}
	}
}

#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
	/// Envelope to send back; `None` for notifications, which get no response.
	pub message: Option<Value>,
	/// Set when the process must exit once `message` has been written.
	pub exit: Option<ExitStatus>,
}

impl Reply {
	fn send(message: Value) -> Self {
		Reply {
			message: Some(message),
			exit: None,
		}
	}
}

pub fn success(id: &str, result: Value) -> Value {
	json!({"jsonrpc": JSONRPC_VERSION, "id": id, "result": result})
}

/// Builds a failure envelope. `id` is `None` when no request id could be read; the envelope then
/// carries `"id": null` as in JSON-RPC 2.0 (the v1 schema does not allow this yet, see `docs/adr/0002-rust-runtime-workspace.md`).
pub fn failure(id: Option<&str>, error: &RpcError) -> Value {
	json!({"jsonrpc": JSONRPC_VERSION, "id": id, "error": error.to_json()})
}

/// The reply sent before the stream is closed because of a framing error.
pub fn frame_error_reply(error: &FrameError) -> Value {
	let kind = match error {
		FrameError::ZeroLength => ErrorKind::InvalidRequest,
		FrameError::Oversize { .. } => ErrorKind::ResourceLimit,
	};
	failure(None, &RpcError::with_detail(kind, error.to_string()))
}

/// Connection state for one client.
#[derive(Debug)]
pub struct Server {
	started: Instant,
	hello_completed: bool,
}

impl Default for Server {
	fn default() -> Self {
		Self::new()
	}
}

impl Server {
	pub fn new() -> Self {
		Server {
			started: Instant::now(),
			hello_completed: false,
		}
	}

	/// Largest frame accepted from the client: 1 MiB until `runtime.hello` succeeds, then the
	/// advertised `frameMaxBytes`.
	pub fn frame_max_bytes(&self) -> u32 {
		if self.hello_completed {
			DEFAULT_FRAME_MAX_BYTES
		} else {
			PRE_HELLO_FRAME_MAX_BYTES
		}
	}

	pub fn handle_payload(&mut self, payload: &[u8]) -> Reply {
		match parse_message(payload) {
			Ok(Incoming::Request(request)) => self.dispatch(&request),
			// v1 defines no client-to-runtime notifications, and notifications get no response.
			Ok(Incoming::Notification) => Reply {
				message: None,
				exit: None,
			},
			Err(rejected) => Reply::send(failure(rejected.id.as_deref(), &rejected.error)),
		}
	}

	fn dispatch(&mut self, request: &Request) -> Reply {
		let result = match request.method.as_str() {
			"runtime.hello" => return self.hello(request),
			"runtime.health" => self.health(&request.params),
			method if !V1_REQUEST_METHODS.contains(&method) => Err(RpcError::with_detail(
				ErrorKind::MethodNotFound,
				"method is not in the v1 catalog",
			)),
			_ if !self.hello_completed => Err(RpcError::with_detail(
				ErrorKind::ProtocolMismatch,
				"runtime.hello must complete before this method",
			)),
			// Every other v1 method sits behind a feature, and this build advertises none yet.
			_ => Err(RpcError::with_detail(
				ErrorKind::ProtocolMismatch,
				"method needs a feature this runtime did not negotiate",
			)),
		};
		Reply::send(match result {
			Ok(result) => success(&request.id, result),
			Err(error) => failure(Some(&request.id), &error),
		})
	}

	fn hello(&mut self, request: &Request) -> Reply {
		let fail = |error: RpcError| Reply::send(failure(Some(&request.id), &error));
		if self.hello_completed {
			return fail(RpcError::with_detail(
				ErrorKind::InvalidRequest,
				"runtime.hello is allowed once per connection",
			));
		}

		// Compare the major before validating anything else: a client of another major may send
		// hello params this version cannot read, and it must still learn that the majors differ.
		let major = request.params.get("protocolMajor").and_then(Value::as_i64);
		if major.is_some_and(|major| major >= 1 && major != PROTOCOL_MAJOR) {
			let error = RpcError::with_detail(
				ErrorKind::ProtocolMismatch,
				format!("runtime speaks protocolMajor {PROTOCOL_MAJOR}"),
			);
			return Reply {
				message: Some(failure(Some(&request.id), &error)),
				exit: Some(ExitStatus::ProtocolMismatch),
			};
		}

		let client_features = match hello_features(&request.params) {
			Ok(features) => features,
			Err(error) => return fail(error),
		};
		// A newer minor may list features this build does not know; they are not echoed back.
		let features: Vec<&str> = RUNTIME_FEATURES
			.iter()
			.copied()
			.filter(|feature| client_features.contains(feature))
			.collect();

		self.hello_completed = true;
		Reply::send(success(
			&request.id,
			json!({
				"protocolMajor": PROTOCOL_MAJOR,
				"protocolMinor": PROTOCOL_MINOR,
				"runtimeBuild": RUNTIME_BUILD,
				"features": features,
				"limits": {
					"frameMaxBytes": DEFAULT_FRAME_MAX_BYTES,
					"maxInitialRows": MAX_INITIAL_ROWS,
					"maxPageRows": MAX_PAGE_ROWS,
					"maxResultTtlSecs": MAX_RESULT_TTL_SECS,
					"maxConcurrentExecutions": MAX_CONCURRENT_EXECUTIONS,
				},
			}),
		))
	}

	fn health(&self, params: &Map<String, Value>) -> Result<Value, RpcError> {
		if !params.is_empty() {
			return Err(RpcError::with_detail(
				ErrorKind::InvalidParams,
				"runtime.health takes no parameters",
			));
		}
		let uptime_ms = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
		Ok(json!({
			"status": "ok",
			"uptimeMs": uptime_ms,
			// Sessions, executions and result handles arrive with N-104..N-107.
			"activeSessions": 0,
			"activeExecutions": 0,
			"pendingResults": 0,
		}))
	}
}

/// Checks `runtime.hello` params against `method.runtime.hello.params` and returns the client's
/// `supportedFeatures`.
fn hello_features(params: &Map<String, Value>) -> Result<HashSet<&str>, RpcError> {
	const KNOWN: [&str; 4] = [
		"protocolMajor",
		"protocolMinor",
		"clientBuild",
		"supportedFeatures",
	];
	let invalid = |detail: &str| RpcError::with_detail(ErrorKind::InvalidParams, detail);

	if params.keys().any(|key| !KNOWN.contains(&key.as_str())) {
		return Err(invalid("unexpected runtime.hello parameter"));
	}
	if params
		.get("protocolMajor")
		.and_then(Value::as_i64)
		.is_none_or(|major| major < 1)
	{
		return Err(invalid("protocolMajor must be an integer >= 1"));
	}
	if params
		.get("protocolMinor")
		.and_then(Value::as_i64)
		.is_none_or(|minor| minor < 0)
	{
		return Err(invalid("protocolMinor must be an integer >= 0"));
	}
	if params
		.get("clientBuild")
		.and_then(Value::as_str)
		.is_none_or(str::is_empty)
	{
		return Err(invalid("clientBuild must be a non-empty string"));
	}
	let Some(Value::Array(items)) = params.get("supportedFeatures") else {
		return Err(invalid("supportedFeatures must be an array"));
	};
	let mut features = HashSet::with_capacity(items.len());
	for item in items {
		match item.as_str() {
			Some(feature) if !feature.is_empty() && features.insert(feature) => {}
			_ => {
				return Err(invalid(
					"supportedFeatures must hold unique non-empty strings",
				))
			}
		}
	}
	Ok(features)
}

/// Size of each read from the input stream.
const READ_CHUNK_BYTES: usize = 64 * 1024;

/// Serves one connection until the input ends or the stream has to be closed.
///
/// `output` receives protocol frames only. `diagnostics` receives log lines (stderr in
/// production); they never include payload content, which can carry SQL, paths or credentials.
pub fn serve(
	mut input: impl Read,
	mut output: impl Write,
	mut diagnostics: impl Write,
) -> ExitStatus {
	let mut log = |args: std::fmt::Arguments<'_>| {
		// Losing a log line must not stop the runtime.
		let _ = writeln!(diagnostics, "nyala-runtime: {args}");
	};
	log(format_args!(
		"{RUNTIME_BUILD} serving protocol {PROTOCOL_MAJOR}.{PROTOCOL_MINOR}"
	));

	let mut server = Server::new();
	let mut decoder = FrameDecoder::new(server.frame_max_bytes());
	let mut chunk = vec![0; READ_CHUNK_BYTES];
	loop {
		decoder.set_max_frame_bytes(server.frame_max_bytes());
		match decoder.next_frame() {
			Ok(Some(payload)) => {
				let reply = server.handle_payload(&payload);
				if let Some(message) = &reply.message {
					if let Err(error) = write_message(&mut output, message) {
						log(format_args!("output write failed: {error}"));
						return ExitStatus::StreamError;
					}
				}
				if let Some(exit) = reply.exit {
					log(format_args!(
						"protocol mismatch, exiting with code {}",
						exit.code()
					));
					return exit;
				}
				continue;
			}
			Ok(None) => {}
			Err(error) => {
				log(format_args!("closing the stream: {error}"));
				if let Err(write_error) = write_message(&mut output, &frame_error_reply(&error)) {
					log(format_args!("output write failed: {write_error}"));
				}
				return ExitStatus::StreamError;
			}
		}

		match input.read(&mut chunk) {
			Ok(0) if decoder.pending_bytes() == 0 => return ExitStatus::Clean,
			Ok(0) => {
				log(format_args!(
					"input ended inside a frame ({} bytes pending)",
					decoder.pending_bytes()
				));
				return ExitStatus::StreamError;
			}
			Ok(read) => decoder.push(&chunk[..read]),
			Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
			Err(error) => {
				log(format_args!("input read failed: {error}"));
				return ExitStatus::StreamError;
			}
		}
	}
}

fn write_message(output: &mut impl Write, message: &Value) -> io::Result<()> {
	let payload = serde_json::to_vec(message)?;
	let frame = encode_frame(&payload, DEFAULT_FRAME_MAX_BYTES).map_err(io::Error::other)?;
	output.write_all(&frame)?;
	output.flush()
}

#[cfg(test)]
mod tests {
	use super::*;

	fn call(server: &mut Server, method: &str, params: Value) -> Reply {
		let request = json!({"jsonrpc": "2.0", "id": "rq_1", "method": method, "params": params});
		server.handle_payload(request.to_string().as_bytes())
	}

	fn hello_params(major: i64, minor: i64) -> Value {
		json!({
			"protocolMajor": major,
			"protocolMinor": minor,
			"clientBuild": "0.0.1-dev.0",
			"supportedFeatures": ["sqlite"],
		})
	}

	fn message(reply: &Reply) -> &Value {
		reply.message.as_ref().expect("reply must carry a message")
	}

	fn error_kind(reply: &Reply) -> &str {
		message(reply)["error"]["data"]["kind"]
			.as_str()
			.expect("reply must be a failure")
	}

	#[test]
	fn hello_negotiates_version_features_and_limits() {
		let mut server = Server::new();
		let reply = call(&mut server, "runtime.hello", hello_params(1, 0));
		assert_eq!(reply.exit, None);
		let result = &message(&reply)["result"];
		assert_eq!(result["protocolMajor"], 1);
		assert_eq!(result["protocolMinor"], 0);
		assert_eq!(result["runtimeBuild"], RUNTIME_BUILD);
		assert_eq!(
			result["limits"],
			json!({
				"frameMaxBytes": 8388608,
				"maxInitialRows": 200,
				"maxPageRows": 1000,
				"maxResultTtlSecs": 300,
				"maxConcurrentExecutions": 4,
			})
		);
		for feature in result["features"].as_array().unwrap() {
			let feature = feature.as_str().unwrap();
			assert!(RUNTIME_FEATURES.contains(&feature) && feature == "sqlite");
		}
	}

	#[test]
	fn frame_limit_rises_only_after_a_successful_hello() {
		let mut server = Server::new();
		assert_eq!(server.frame_max_bytes(), PRE_HELLO_FRAME_MAX_BYTES);
		call(&mut server, "runtime.hello", json!({"protocolMajor": 1}));
		assert_eq!(
			server.frame_max_bytes(),
			PRE_HELLO_FRAME_MAX_BYTES,
			"invalid hello"
		);
		call(&mut server, "runtime.hello", hello_params(1, 0));
		assert_eq!(server.frame_max_bytes(), DEFAULT_FRAME_MAX_BYTES);
	}

	#[test]
	fn hello_is_accepted_once() {
		let mut server = Server::new();
		assert!(
			message(&call(&mut server, "runtime.hello", hello_params(1, 0)))
				.get("result")
				.is_some()
		);
		let again = call(&mut server, "runtime.hello", hello_params(1, 0));
		assert_eq!(error_kind(&again), "INVALID_REQUEST");
		assert_eq!(again.exit, None);
	}

	#[test]
	fn hello_rejects_params_outside_the_schema() {
		let valid = hello_params(1, 0);
		let with = |key: &str, value: Value| {
			let mut params = valid.clone();
			params[key] = value;
			params
		};
		let without = |key: &str| {
			let mut params = valid.clone();
			params.as_object_mut().unwrap().remove(key);
			params
		};
		let cases = [
			without("protocolMajor"),
			without("protocolMinor"),
			without("clientBuild"),
			without("supportedFeatures"),
			with("protocolMajor", json!(0)),
			with("protocolMajor", json!("1")),
			with("protocolMinor", json!(-1)),
			with("protocolMinor", json!(0.5)),
			with("clientBuild", json!("")),
			with("clientBuild", json!(7)),
			with("supportedFeatures", json!("sqlite")),
			with("supportedFeatures", json!(["sqlite", "sqlite"])),
			with("supportedFeatures", json!([""])),
			with("supportedFeatures", json!([1])),
			with("debug", json!(true)),
		];
		for params in cases {
			let mut server = Server::new();
			let reply = call(&mut server, "runtime.hello", params.clone());
			assert_eq!(error_kind(&reply), "INVALID_PARAMS", "{params}");
			assert_eq!(reply.exit, None, "{params}");
		}
	}

	#[test]
	fn major_mismatch_is_rejected_and_ends_the_connection() {
		for params in [
			hello_params(2, 0),
			hello_params(9, 3),
			// A future major may reshape hello; the major alone decides the mismatch.
			json!({"protocolMajor": 2, "client": {"build": "2.0.0"}}),
		] {
			let mut server = Server::new();
			let reply = call(&mut server, "runtime.hello", params.clone());
			assert_eq!(error_kind(&reply), "PROTOCOL_MISMATCH", "{params}");
			assert_eq!(message(&reply)["id"], "rq_1");
			assert_eq!(reply.exit, Some(ExitStatus::ProtocolMismatch));
			assert_eq!(ExitStatus::ProtocolMismatch.code(), 2);
		}
	}

	#[test]
	fn minor_difference_is_negotiated_through_features() {
		let mut server = Server::new();
		let mut params = hello_params(1, 7);
		params["supportedFeatures"] = json!(["sqlite", "blob.readChunk"]);
		let reply = call(&mut server, "runtime.hello", params);
		let result = &message(&reply)["result"];
		assert_eq!(result["protocolMinor"], PROTOCOL_MINOR);
		assert!(!result["features"]
			.as_array()
			.unwrap()
			.contains(&json!("blob.readChunk")));
	}

	#[test]
	fn health_works_before_hello_and_takes_no_params() {
		let mut server = Server::new();
		let reply = call(&mut server, "runtime.health", json!({}));
		let result = &message(&reply)["result"];
		assert_eq!(result["status"], "ok");
		assert!(result["uptimeMs"].is_u64());
		for counter in ["activeSessions", "activeExecutions", "pendingResults"] {
			assert_eq!(result[counter], 0, "{counter}");
		}

		let reply = call(&mut server, "runtime.health", json!({"verbose": true}));
		assert_eq!(error_kind(&reply), "INVALID_PARAMS");
	}

	#[test]
	fn unknown_methods_are_method_not_found_before_and_after_hello() {
		let mut server = Server::new();
		for _ in 0..2 {
			for method in ["runtime.shutdown", "transaction.begin", "query.Execute", ""] {
				let reply = call(&mut server, method, json!({}));
				assert_eq!(error_kind(&reply), "METHOD_NOT_FOUND", "{method:?}");
				assert_eq!(reply.exit, None);
			}
			call(&mut server, "runtime.hello", hello_params(1, 0));
		}
	}

	#[test]
	fn catalog_methods_need_the_handshake_and_a_negotiated_feature() {
		let mut server = Server::new();
		for method in &V1_REQUEST_METHODS[2..] {
			let reply = call(&mut server, method, json!({}));
			assert_eq!(
				error_kind(&reply),
				"PROTOCOL_MISMATCH",
				"{method} before hello"
			);
			assert_eq!(reply.exit, None, "{method} must not end the connection");
		}
		call(&mut server, "runtime.hello", hello_params(1, 0));
		for method in &V1_REQUEST_METHODS[2..] {
			let reply = call(&mut server, method, json!({}));
			assert_eq!(
				error_kind(&reply),
				"PROTOCOL_MISMATCH",
				"{method} after hello"
			);
			assert_eq!(reply.exit, None);
		}
	}

	#[test]
	fn notifications_get_no_reply() {
		let mut server = Server::new();
		let notification = json!({"jsonrpc": "2.0", "method": "query.stateChanged", "params": {}});
		assert_eq!(
			server.handle_payload(notification.to_string().as_bytes()),
			Reply {
				message: None,
				exit: None
			}
		);
	}

	#[test]
	fn unreadable_payloads_reply_with_a_null_id() {
		let mut server = Server::new();
		let reply = server.handle_payload(b"{\"jsonrpc\":\"2.0\",");
		assert_eq!(error_kind(&reply), "PARSE_ERROR");
		assert_eq!(message(&reply)["id"], Value::Null);
		assert_eq!(
			reply.exit, None,
			"a bad payload inside a good frame keeps the stream in sync"
		);
	}

	#[test]
	fn frame_errors_map_to_contract_kinds() {
		let zero = frame_error_reply(&FrameError::ZeroLength);
		assert_eq!(zero["error"]["data"]["kind"], "INVALID_REQUEST");
		assert_eq!(zero["id"], Value::Null);
		let oversize = frame_error_reply(&FrameError::Oversize { length: 9, max: 8 });
		assert_eq!(oversize["error"]["code"], -32014);
		assert_eq!(oversize["error"]["data"]["kind"], "RESOURCE_LIMIT");
	}
}
