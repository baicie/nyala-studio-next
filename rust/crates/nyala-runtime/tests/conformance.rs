/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Contract conformance: the runtime against `nyala/rpc/v1/`, the same files that
//! `npm run nyala:validate-rpc` checks on the Node side. Nothing here copies a sample or a code;
//! every expectation is read from the contract files.

mod support;

use std::collections::{BTreeSet, HashMap};
use std::path::Path;

use nyala_runtime::error::{ErrorKind, RpcError};
use nyala_runtime::framing::{
	encode_frame, FrameDecoder, FrameError, DEFAULT_FRAME_MAX_BYTES, FRAME_PREFIX_BYTES,
};
use nyala_runtime::protocol::V1_REQUEST_METHODS;
use nyala_runtime::server::{failure, frame_error_reply, Server};
use serde_json::{json, Value};
use support::{
	conformance_samples, path_param, read_json, Schema, TempDir, CONFORMANCE_PATH, ERROR_CODES_PATH,
};

/// Conformance lines paired with their parsed value.
fn samples() -> Vec<(String, Value)> {
	conformance_samples()
		.into_iter()
		.map(|line| {
			let value = serde_json::from_str(&line).expect("conformance lines are JSON");
			(line, value)
		})
		.collect()
}

fn is_request(message: &Value) -> bool {
	message.get("method").is_some() && message.get("id").is_some()
}

fn is_notification(message: &Value) -> bool {
	message.get("method").is_some() && message.get("id").is_none()
}

/// Checks an `error` member against `error-codes.json`, not against the runtime's own table.
fn assert_registered(registry: &Value, error: &Value) {
	let kind = error["data"]["kind"].as_str().expect("error.data.kind");
	let entry = registry["codes"]
		.as_array()
		.expect("codes")
		.iter()
		.find(|entry| entry["kind"] == kind)
		.unwrap_or_else(|| panic!("{kind} is not registered in {ERROR_CODES_PATH}"));
	assert_eq!(error["code"], entry["code"], "{kind} code");
	assert_eq!(
		error["data"]["retryable"], entry["retryable"],
		"{kind} retryable"
	);
}

/// Checks a runtime reply to `request` against the envelope schema, the method's result schema
/// and the error registry.
fn assert_conforms(schema: &Schema, registry: &Value, request: &Value, reply: &Value) {
	let errors = schema.envelope_errors(reply);
	assert!(
		errors.is_empty(),
		"reply to {} violates the envelope schema: {errors:?}\n{reply}",
		request["id"]
	);
	assert_eq!(reply["id"], request["id"], "reply must echo the request id");
	if let Some(result) = reply.get("result") {
		let method = request["method"].as_str().expect("method");
		let errors = schema.def_errors(result, &format!("method.{method}.result"));
		assert!(
			errors.is_empty(),
			"{method} result violates its schema: {errors:?}"
		);
	}
	if let Some(error) = reply.get("error") {
		assert_registered(registry, error);
	}
}

#[test]
fn error_table_matches_error_codes_json() {
	let registry = read_json(ERROR_CODES_PATH);
	let entries = registry["codes"].as_array().expect("codes");
	let mut seen = BTreeSet::new();
	for entry in entries {
		let name = entry["kind"].as_str().expect("kind");
		assert!(seen.insert(name), "{name} is listed twice");
		let kind = ErrorKind::ALL
			.iter()
			.copied()
			.find(|kind| kind.as_str() == name)
			.unwrap_or_else(|| panic!("{name} from {ERROR_CODES_PATH} has no ErrorKind"));
		assert_eq!(Some(kind.code()), entry["code"].as_i64(), "{name} code");
		assert_eq!(
			Some(kind.retryable()),
			entry["retryable"].as_bool(),
			"{name} retryable"
		);
	}
	assert_eq!(
		seen.len(),
		ErrorKind::ALL.len(),
		"every ErrorKind must be registered in {ERROR_CODES_PATH}"
	);
}

#[test]
fn request_catalog_matches_the_schema() {
	let schema = Schema::load();
	let from_schema: BTreeSet<&str> = schema.def("request")["oneOf"]
		.as_array()
		.expect("request branches")
		.iter()
		.map(|branch| {
			branch["properties"]["method"]["const"]
				.as_str()
				.expect("method const")
		})
		.collect();
	let from_runtime: BTreeSet<&str> = V1_REQUEST_METHODS.iter().copied().collect();
	assert_eq!(
		V1_REQUEST_METHODS.len(),
		from_runtime.len(),
		"duplicate methods"
	);
	assert_eq!(from_runtime, from_schema);
}

#[test]
fn every_sample_survives_rust_framing_byte_by_byte_and_glued() {
	let samples = conformance_samples();
	assert!(!samples.is_empty(), "{CONFORMANCE_PATH} has no samples");
	let frames: Vec<Vec<u8>> = samples
		.iter()
		.map(|sample| encode_frame(sample.as_bytes(), DEFAULT_FRAME_MAX_BYTES).unwrap())
		.collect();
	for (sample, frame) in samples.iter().zip(&frames) {
		let length = u32::try_from(sample.len()).unwrap();
		assert_eq!(frame[..FRAME_PREFIX_BYTES], length.to_le_bytes());
		assert_eq!(&frame[FRAME_PREFIX_BYTES..], sample.as_bytes());
	}
	let expected: Vec<Vec<u8>> = samples
		.iter()
		.map(|sample| sample.as_bytes().to_vec())
		.collect();
	let stream = frames.concat();

	let mut decoder = FrameDecoder::new(DEFAULT_FRAME_MAX_BYTES);
	let mut decoded = Vec::new();
	for byte in &stream {
		decoder.push(std::slice::from_ref(byte));
		while let Some(payload) = decoder.next_frame().unwrap() {
			decoded.push(payload);
		}
	}
	assert_eq!(decoded, expected, "byte-by-byte");
	assert_eq!(decoder.pending_bytes(), 0);

	let mut decoder = FrameDecoder::new(DEFAULT_FRAME_MAX_BYTES);
	decoder.push(&stream);
	let mut decoded = Vec::new();
	while let Some(payload) = decoder.next_frame().unwrap() {
		decoded.push(payload);
	}
	assert_eq!(decoded, expected, "glued");

	let first = &frames[0];
	let mut decoder = FrameDecoder::new(DEFAULT_FRAME_MAX_BYTES);
	decoder.push(&first[..first.len() - 4]);
	assert_eq!(decoder.next_frame(), Ok(None), "half frame");
}

#[test]
fn schema_evaluator_accepts_the_samples_and_rejects_the_negative_controls() {
	let schema = Schema::load();
	let samples = samples();
	for (index, (_, sample)) in samples.iter().enumerate() {
		let errors = schema.envelope_errors(sample);
		assert!(
			errors.is_empty(),
			"{CONFORMANCE_PATH}:{} {errors:?}",
			index + 1
		);
		if sample.get("result").is_some() {
			let (_, request) = samples[..index]
				.iter()
				.find(|(_, earlier)| is_request(earlier) && earlier["id"] == sample["id"])
				.expect("every response follows its request");
			let method = request["method"].as_str().unwrap();
			let errors = schema.def_errors(&sample["result"], &format!("method.{method}.result"));
			assert!(
				errors.is_empty(),
				"{CONFORMANCE_PATH}:{} {errors:?}",
				index + 1
			);
		}
	}

	// The same negative controls as scripts/nyala/validate-rpc-contract.ts.
	let find = |method: &str| {
		samples
			.iter()
			.map(|(_, value)| value)
			.find(|value| is_request(value) && value["method"] == method)
			.unwrap()
			.clone()
	};
	let mut missing_params = find("runtime.hello");
	missing_params.as_object_mut().unwrap().remove("params");
	let mut unexpected_property = find("runtime.hello");
	unexpected_property["nyalaDebug"] = json!(true);
	let mut invalid_enum = find("query.execute");
	invalid_enum["params"]["mode"] = json!("batch");
	for (label, broken) in [
		("missing params", missing_params),
		("unexpected property", unexpected_property),
		("invalid enum", invalid_enum),
	] {
		assert!(
			!schema.envelope_errors(&broken).is_empty(),
			"{label} must fail"
		);
	}
}

#[test]
fn every_sample_request_gets_exactly_one_conforming_reply() {
	let schema = Schema::load();
	let registry = read_json(ERROR_CODES_PATH);
	let samples = samples();
	let dir = TempDir::new("conformance");
	let database = dir.database("demo.sqlite");
	// The sample session's sessionId, mapped to the sessionId and generation this runtime issued
	// for the sample's connection.open.
	let mut issued: HashMap<String, (Value, Value)> = HashMap::new();
	let mut server = Server::new();
	let mut answered = 0;
	for (index, (line, sample)) in samples.iter().enumerate() {
		if is_notification(sample) {
			let reply = server.handle_payload(line.as_bytes());
			assert_eq!(reply.message, None, "notifications get no reply: {line}");
			assert_eq!(reply.exit, None);
			continue;
		}
		if !is_request(sample) {
			continue;
		}

		// The sample path does not exist here, and sample session ids were never issued by this
		// process; both are replaced so that the connection methods can succeed.
		let mut request = sample.clone();
		if request["params"].get("path").is_some() {
			request["params"]["path"] = json!(path_param(&database));
		}
		let sample_session = request["params"]["sessionId"].as_str().map(str::to_owned);
		if let Some((id, generation)) = sample_session.and_then(|id| issued.get(&id).cloned()) {
			request["params"]["sessionId"] = id;
			request["params"]["sessionGeneration"] = generation;
		}

		let reply = server.handle_payload(request.to_string().as_bytes());
		assert_eq!(reply.exit, None, "{line}");
		let message = reply.message.expect("every request gets a response");
		assert_conforms(&schema, &registry, &request, &message);
		let method = request["method"].as_str().unwrap();
		match method {
			"runtime.hello" | "runtime.health" | "connection.test" | "connection.open"
			| "connection.close" => {
				let result = message
					.get("result")
					.unwrap_or_else(|| panic!("{method}: {message}"));
				let (_, expected) = samples[index..]
					.iter()
					.find(|(_, later)| later["id"] == sample["id"] && !is_request(later))
					.expect("every request is followed by its response");
				assert_eq!(
					keys(result),
					keys(&expected["result"]),
					"{method} result fields"
				);
				if method == "connection.open" {
					issued.insert(
						expected["result"]["sessionId"].as_str().unwrap().to_owned(),
						(
							result["sessionId"].clone(),
							result["sessionGeneration"].clone(),
						),
					);
				}
			}
			// The metadata, query and result features arrive with N-105..N-107.
			method => assert_eq!(
				message["error"]["data"]["kind"], "PROTOCOL_MISMATCH",
				"{method}"
			),
		}
		answered += 1;
	}
	let requests = samples
		.iter()
		.filter(|(_, value)| is_request(value))
		.count();
	assert!(requests > 0);
	assert_eq!(answered, requests);
	assert_eq!(issued.len(), 1, "the sample session opens one session");

	// conformance.ndjson has no connection.listSessions sample; its reply is checked here.
	let request = json!({"jsonrpc": "2.0", "id": "rq_list", "method": "connection.listSessions", "params": {}});
	let message = server
		.handle_payload(request.to_string().as_bytes())
		.message
		.unwrap();
	assert_conforms(&schema, &registry, &request, &message);
	let states: Vec<&Value> = message["result"]["sessions"]
		.as_array()
		.unwrap()
		.iter()
		.map(|session| &session["state"])
		.collect();
	assert_eq!(states, [&json!("closed")], "the sample session closes it");
}

fn keys(value: &Value) -> BTreeSet<&str> {
	value
		.as_object()
		.expect("an object")
		.keys()
		.map(String::as_str)
		.collect()
}

#[test]
fn connection_failures_conform_to_the_contract_and_name_no_path() {
	const MARKER: &str = "marker7f3a";
	let schema = Schema::load();
	let registry = read_json(ERROR_CODES_PATH);
	let dir = TempDir::new(MARKER);
	let database = dir.database("db.sqlite");
	let mut server = Server::new();
	let mut next = 0;
	let mut call = |server: &mut Server, method: &str, params: Value| {
		next += 1;
		let request = json!({"jsonrpc": "2.0", "id": format!("rq_{next}"), "method": method, "params": params});
		let message = server
			.handle_payload(request.to_string().as_bytes())
			.message
			.unwrap();
		assert_conforms(&schema, &registry, &request, &message);
		assert!(!message.to_string().contains(MARKER), "{message}");
		message
	};
	let target =
		|path: &Path| json!({"driver": "sqlite", "path": path_param(path), "readOnly": true});

	let hello = json!({"protocolMajor": 1, "protocolMinor": 0, "clientBuild": "test", "supportedFeatures": ["sqlite"]});
	call(&mut server, "runtime.hello", hello);
	let opened = call(&mut server, "connection.open", target(&database))["result"].clone();

	let files = [
		dir.join("missing.sqlite"),
		dir.folder("folder"),
		dir.file("empty.sqlite", b""),
		dir.file("notes.txt", &b"plain text\n".repeat(64)),
		dir.truncated_database("truncated.sqlite"),
	];
	for path in &files {
		for method in ["connection.test", "connection.open"] {
			let message = call(&mut server, method, target(path));
			assert_eq!(
				message["error"]["data"]["kind"], "INVALID_PARAMS",
				"{path:?}"
			);
		}
	}
	let relative = json!({"driver": "sqlite", "path": "db.sqlite", "readOnly": true});
	let message = call(&mut server, "connection.open", relative);
	assert_eq!(message["error"]["data"]["kind"], "INVALID_PARAMS");

	let mismatch = json!({"sessionId": opened["sessionId"], "sessionGeneration": 2});
	let message = call(&mut server, "connection.close", mismatch);
	assert_eq!(message["error"]["data"]["kind"], "INVALID_SESSION");
	assert_eq!(message["error"]["data"]["sessionId"], opened["sessionId"]);
	let unknown = json!({"sessionId": "s_001", "sessionGeneration": 1});
	let message = call(&mut server, "connection.close", unknown);
	assert_eq!(message["error"]["data"]["kind"], "INVALID_SESSION");

	// metadata.* needs a feature this build does not implement, even for a valid session.
	let session = json!({"sessionId": opened["sessionId"], "sessionGeneration": opened["sessionGeneration"], "limit": 50});
	let message = call(&mut server, "metadata.listObjects", session);
	assert_eq!(message["error"]["data"]["kind"], "PROTOCOL_MISMATCH");
}

#[test]
fn hello_reply_agrees_with_the_sample_session() {
	let samples = samples();
	let (line, request) = samples
		.iter()
		.find(|(_, value)| is_request(value) && value["method"] == "runtime.hello")
		.unwrap();
	let (_, expected) = samples
		.iter()
		.find(|(_, value)| value["id"] == request["id"] && value.get("result").is_some())
		.unwrap();

	let reply = Server::new()
		.handle_payload(line.as_bytes())
		.message
		.unwrap();
	let (result, expected) = (&reply["result"], &expected["result"]);
	assert_eq!(result["protocolMajor"], expected["protocolMajor"]);
	assert_eq!(result["protocolMinor"], expected["protocolMinor"]);
	assert_eq!(result["limits"], expected["limits"]);
	// The sample session advertises every v1 feature; this build only answers with features it
	// implements, and never with one the client did not offer.
	let offered = request["params"]["supportedFeatures"].as_array().unwrap();
	for feature in result["features"].as_array().unwrap() {
		assert!(offered.contains(feature), "{feature} was not offered");
	}
}

#[test]
fn every_error_reply_uses_a_registered_kind_and_the_contract_shape() {
	let schema = Schema::load();
	let registry = read_json(ERROR_CODES_PATH);
	for kind in ErrorKind::ALL {
		for error in [
			RpcError::new(kind),
			RpcError::with_detail(kind, "detail"),
			RpcError::with_detail(kind, "detail").for_session("s_0123456789abcdef1"),
		] {
			let reply = failure(Some("rq_1"), &error);
			let errors = schema.envelope_errors(&reply);
			assert!(errors.is_empty(), "{kind:?}: {errors:?}");
			assert_registered(&registry, &reply["error"]);
		}
	}

	// Replies to payloads that carry no readable request id.
	let reply = |payload: &[u8]| Server::new().handle_payload(payload).message.unwrap();
	let id_less = [
		("PARSE_ERROR", reply(b"{not json")),
		("PARSE_ERROR", reply(&[0xff, 0xfe])),
		("INVALID_REQUEST", reply(b"[]")),
		("INVALID_REQUEST", reply(b"{}")),
		(
			"INVALID_REQUEST",
			reply(br#"{"jsonrpc":"2.0","id":7,"method":"runtime.health","params":{}}"#),
		),
		(
			"INVALID_REQUEST",
			frame_error_reply(&FrameError::ZeroLength),
		),
		(
			"RESOURCE_LIMIT",
			frame_error_reply(&FrameError::Oversize { length: 9, max: 8 }),
		),
	];
	for (kind, reply) in id_less {
		assert_eq!(reply["error"]["data"]["kind"], kind, "{reply}");
		assert_eq!(reply["id"], Value::Null, "{reply}");
		assert_registered(&registry, &reply["error"]);
		// The v1.0 erratum (2026-10-30, `docs/adr/0001-rpc-contract-v1.md`) allows `"id": null` in failure
		// envelopes, so these replies validate as-is.
		let errors = schema.envelope_errors(&reply);
		assert!(errors.is_empty(), "{errors:?}");
	}
}
