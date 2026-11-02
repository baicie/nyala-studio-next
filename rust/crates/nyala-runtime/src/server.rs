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

use crate::connection::{self, Sessions};
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
/// carries `"id": null` as in JSON-RPC 2.0 §5, which the v1 schema allows via `$defs/failureId`
/// (2026-10-30 erratum, see `docs/adr/0001-rpc-contract-v1.md`).
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

/// Connection state for one client. Dropping it closes every open session.
#[derive(Debug)]
pub struct Server {
	started: Instant,
	hello_completed: bool,
	/// Features both sides support, fixed by `runtime.hello`.
	features: HashSet<&'static str>,
	sessions: Sessions,
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
			features: HashSet::new(),
			sessions: Sessions::new(),
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
			method
				if !required_feature(method)
					.is_some_and(|feature| self.features.contains(&feature)) =>
			{
				Err(RpcError::with_detail(
					ErrorKind::ProtocolMismatch,
					"method needs a feature this runtime did not negotiate",
				))
			}
			"connection.test" => connection::test(&request.params),
			"connection.open" => self.sessions.open(&request.params),
			"connection.close" => self.sessions.close(&request.params),
			"connection.listSessions" => self.sessions.list(&request.params),
			"metadata.listObjects" => self.sessions.list_objects(&request.params),
			"metadata.describe" => self.sessions.describe(&request.params),
			"query.execute" => self.sessions.execute(&request.params),
			"query.cancel" => self.sessions.cancel(&request.params),
			"query.getState" => self.sessions.get_state(&request.params),
			"result.fetchPage" => self.sessions.fetch_page(&request.params),
			"result.release" => self.sessions.release(&request.params),
			// required_feature names only methods with a handler above; this arm keeps a future
			// mismatch between the two from panicking.
			_ => Err(RpcError::with_detail(
				ErrorKind::Internal,
				"negotiated method has no handler",
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
		let features: Vec<&'static str> = RUNTIME_FEATURES
			.iter()
			.copied()
			.filter(|feature| client_features.contains(feature))
			.collect();

		self.hello_completed = true;
		self.features = features.iter().copied().collect();
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
		let (active_executions, pending_results) = self.sessions.counters();
		Ok(json!({
			"status": "ok",
			"uptimeMs": uptime_ms,
			"activeSessions": self.sessions.open_count(),
			"activeExecutions": active_executions,
			"pendingResults": pending_results,
		}))
	}
}

/// The feature a v1 method needs, for the methods this build implements. `None` means no
/// negotiation unlocks the method yet, so it is always refused with `PROTOCOL_MISMATCH`.
/// The `features` bit a method needs. The contract's §3 list is what clients read, so each method
/// maps to its own bit; `metadata.describe` has none of its own and rides on `metadata.listObjects`.
fn required_feature(method: &str) -> Option<&'static str> {
	match method {
		"connection.test" | "connection.open" | "connection.close" | "connection.listSessions" => {
			Some("sqlite")
		}
		"metadata.listObjects" | "metadata.describe" => Some("metadata.listObjects"),
		"query.execute" | "query.getState" => Some("query.execute"),
		"query.cancel" => Some("query.cancel"),
		"result.fetchPage" => Some("result.fetchPage"),
		"result.release" => Some("result.release"),
		_ => None,
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

		// A client that offers no features unlocks nothing.
		let mut params = hello_params(1, 0);
		params["supportedFeatures"] = json!([]);
		call(&mut server, "runtime.hello", params);
		for method in &V1_REQUEST_METHODS[2..] {
			let reply = call(&mut server, method, json!({}));
			assert_eq!(
				error_kind(&reply),
				"PROTOCOL_MISMATCH",
				"{method} without features"
			);
			assert_eq!(reply.exit, None);
		}
	}

	/// The feature a method needs, as `required_feature` maps it. The contract's §3 list is what a
	/// client reads, so this is the list the test unlocks method by method.
	const FEATURES: [&str; 6] = [
		"sqlite",
		"metadata.listObjects",
		"query.execute",
		"query.cancel",
		"result.fetchPage",
		"result.release",
	];

	fn hello_with(features: &[&str]) -> Value {
		let mut params = hello_params(1, 0);
		params["supportedFeatures"] = json!(features);
		params
	}

	#[test]
	fn sqlite_alone_unlocks_only_the_connection_methods() {
		let mut server = Server::new();
		call(&mut server, "runtime.hello", hello_params(1, 0));
		for method in &V1_REQUEST_METHODS[2..] {
			let reply = call(&mut server, method, json!({}));
			// The connection methods reach their handlers, which reject the empty params; every
			// other method needs a feature the client did not offer.
			let expected = match *method {
				"connection.listSessions" => "result",
				"connection.test" | "connection.open" | "connection.close" => "INVALID_PARAMS",
				_ => "PROTOCOL_MISMATCH",
			};
			let outcome = message(&reply)["error"]["data"]["kind"]
				.as_str()
				.unwrap_or("result");
			assert_eq!(outcome, expected, "{method}");
			assert_eq!(reply.exit, None);
		}
	}

	#[test]
	fn every_catalog_method_is_reachable_once_its_feature_is_negotiated() {
		let mut server = Server::new();
		call(&mut server, "runtime.hello", hello_with(&FEATURES));
		for method in &V1_REQUEST_METHODS[2..] {
			let reply = call(&mut server, method, json!({}));
			// Empty params fail for every method except the one that takes none; nothing may be
			// refused for want of a feature.
			let outcome = message(&reply)["error"]["data"]["kind"]
				.as_str()
				.unwrap_or("result");
			assert_ne!(outcome, "PROTOCOL_MISMATCH", "{method} after negotiating");
			assert_eq!(reply.exit, None, "{method}");
		}
	}

	#[test]
	fn dropping_one_feature_refuses_exactly_the_methods_that_need_it() {
		let needs = required_feature;
		for withheld in FEATURES {
			let offered: Vec<&str> = FEATURES
				.into_iter()
				.filter(|feature| *feature != withheld)
				.collect();
			let mut server = Server::new();
			call(&mut server, "runtime.hello", hello_with(&offered));
			for method in &V1_REQUEST_METHODS[2..] {
				let reply = call(&mut server, method, json!({}));
				let outcome = message(&reply)["error"]["data"]["kind"]
					.as_str()
					.unwrap_or("result");
				if needs(method) == Some(withheld) {
					assert_eq!(outcome, "PROTOCOL_MISMATCH", "{method} without {withheld}");
				} else {
					assert_ne!(
						outcome, "PROTOCOL_MISMATCH",
						"{method} with {withheld} missing"
					);
				}
			}
		}
	}

	#[test]
	fn health_counts_open_sessions() {
		let directory = std::env::temp_dir().join(format!(
			"nyala-server-health-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap()
				.as_nanos()
		));
		std::fs::create_dir_all(&directory).unwrap();
		let path = directory.join("health.sqlite");
		rusqlite::Connection::open(&path)
			.unwrap()
			.execute_batch("CREATE TABLE t(x)")
			.unwrap();

		let mut server = Server::new();
		call(&mut server, "runtime.hello", hello_params(1, 0));
		let open = |server: &mut Server| {
			call(
				server,
				"connection.open",
				json!({"driver": "sqlite", "path": path.to_str().unwrap(), "readOnly": true}),
			)
		};
		let first = open(&mut server);
		open(&mut server);
		let health = call(&mut server, "runtime.health", json!({}));
		assert_eq!(message(&health)["result"]["activeSessions"], 2);

		let session = &message(&first)["result"];
		call(
			&mut server,
			"connection.close",
			json!({"sessionId": session["sessionId"], "sessionGeneration": session["sessionGeneration"]}),
		);
		let health = call(&mut server, "runtime.health", json!({}));
		assert_eq!(message(&health)["result"]["activeSessions"], 1);

		drop(server);
		std::fs::remove_dir_all(&directory).unwrap();
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
