/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Contract conformance: the runtime against `nyala/rpc/v1/`, the same files that
//! `npm run nyala:validate-rpc` checks on the Node side. Nothing here copies a sample or a code;
//! every expectation is read from the contract files.
//!
//! Since N-108 `query.execute` is answered asynchronously: the worker prepares the first statement
//! and reports back, and `query.stateChanged` notifications follow as the execution moves through
//! the state machine. A replay therefore handles a request, then reads the reports its worker
//! queued, in the order the client would have received them ([`Reply`] carries them all).

mod support;

use std::collections::{BTreeSet, HashMap};
use std::path::Path;

use nyala_runtime::error::{ErrorKind, RpcError};
use nyala_runtime::framing::{
	encode_frame, FrameDecoder, FrameError, DEFAULT_FRAME_MAX_BYTES, FRAME_PREFIX_BYTES,
};
use nyala_runtime::protocol::V1_REQUEST_METHODS;
use nyala_runtime::server::{failure, frame_error_reply, Reply, Server};
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

/// Checks a `query.stateChanged` notification against the contract schema.
fn assert_notification_conforms(schema: &Schema, notification: &Value) {
	let errors = schema.envelope_errors(notification);
	assert!(
		errors.is_empty(),
		"notification violates the envelope schema: {errors:?}\n{notification}"
	);
	assert_eq!(notification["method"], "query.stateChanged");
}

/// The reply to `request` produced by one round trip: its own answer, then the reports its worker
/// queued. Fails unless the request was answered exactly once.
fn answered(server: &mut Server, request: &Value) -> Value {
	let reply = server.round_trip(request.to_string().as_bytes());
	assert_eq!(reply.exit, None, "{request}");
	let id = &request["id"];
	let mut answers = reply
		.messages
		.iter()
		.filter(|message| !is_notification(message) && message.get("id") == Some(id));
	assert_eq!(
		answers.clone().count(),
		1,
		"every request gets exactly one reply: {request}\n{}",
		serde_json::to_string(&reply.messages).unwrap()
	);
	answers.next().unwrap().clone()
}

/// The notifications `messages` holds.
fn notifications(messages: &[Value]) -> Vec<&Value> {
	messages
		.iter()
		.filter(|message| is_notification(message))
		.collect()
}

/// The state sequence of `execution` in `messages`.
fn states(messages: &[Value], execution: &str) -> Vec<String> {
	notifications(messages)
		.iter()
		.filter(|notification| notification["params"]["executionId"] == execution)
		.map(|notification| {
			notification["params"]["state"]
				.as_str()
				.expect("a state")
				.to_owned()
		})
		.collect()
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

/// The expected response of `request` in the sample stream.
fn expected_response(samples: &[(String, Value)], request: &Value) -> Value {
	samples
		.iter()
		.find(|(_, later)| later["id"] == request["id"] && !is_request(later))
		.expect("every request is followed by its response")
		.1
		.clone()
}

/// Whether a later sample cancels the execution `request` produces, i.e. the sample treats it as
/// still running when the next request arrives (rq_010 → rq_011). Such an execution must not be
/// waited for: it is `SELECT count(*) FROM customers` without `cancel_requested` in the sample, and
/// here it is the statement the cancel interrupts.
fn cancelled_later(samples: &[(String, Value)], request: &Value) -> bool {
	let Some(response) = samples
		.iter()
		.map(|(_, value)| value)
		.find(|value| value["id"] == request["id"] && !is_request(value))
	else {
		return false;
	};
	let Some(execution) = response["result"]["executionId"].as_str() else {
		return false;
	};
	samples.iter().any(|(_, value)| {
		value["method"] == "query.cancel" && value["params"]["executionId"] == execution
	})
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
	// Sample executionId/resultId to the one this runtime issued, for the same replay reason.
	let mut issued_ids: HashMap<String, Value> = HashMap::new();
	// The last `sequence` each execution reported as a notification, so `query.getState` can be
	// checked against it regardless of how the cancel raced with the statement.
	let mut last_sequence: HashMap<String, u64> = HashMap::new();
	let mut server = Server::new();
	let mut answered_count = 0;
	for (index, (line, sample)) in samples.iter().enumerate() {
		if is_notification(sample) {
			// The sample's notifications are produced by this build's own executions (its
			// `query.stateChanged` lines are checked against the sequence the runtime emitted when
			// it ran rq_006, below). `runtime.restarted` is emitted by the client-facing supervisor,
			// not by this process, so it is not replayed.
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

		// Sample execution and result ids are replaced by the ones this process issued, exactly as
		// for the session, so that the sample's own flow can be replayed end to end.
		for field in ["executionId", "resultId"] {
			let Some(sample_id) = request["params"][field].as_str().map(str::to_owned) else {
				continue;
			};
			if let Some(issued) = issued_ids.get(&sample_id) {
				request["params"][field] = issued.clone();
			}
		}

		let reply = server.round_trip(request.to_string().as_bytes());
		assert_eq!(reply.exit, None, "{line}");
		let message = answered_from(&reply, &request, &schema, &registry);
		let method = request["method"].as_str().unwrap();
		let mut messages = reply.messages;
		// `query.stateChanged` notifications follow the reply asynchronously. The replay reads
		// them where the sample reads them too: an execution the sample cancels later (rq_010) is
		// left running, and every other execution is settled before the next request.
		if method == "query.cancel"
			|| (method == "query.execute" && !cancelled_later(&samples, &request))
		{
			messages.extend(server.settle().messages);
		}
		let produced = notifications(&messages);
		for notification in &produced {
			assert_notification_conforms(&schema, notification);
			if let (Some(execution), Some(sequence)) = (
				notification["params"]["executionId"].as_str(),
				notification["params"]["sequence"].as_u64(),
			) {
				last_sequence.insert(execution.to_owned(), sequence);
			}
		}
		let expected = expected_response(&samples, &request);
		match method {
			"runtime.hello" | "runtime.health" | "connection.test" | "connection.open"
			| "connection.close" => {
				let result = message
					.get("result")
					.unwrap_or_else(|| panic!("{method}: {message}"));
				assert_eq!(
					keys(result),
					keys(&expected["result"]),
					"{method} result fields"
				);
				if method == "connection.open" {
					// The sample session advertises transactions and metadata; this build declares
					// only what it implements. Cancellation is cooperative because a timeout ends a
					// running statement through SQLite's progress callback; `transaction.*` has no
					// implementation, so it stays false.
					assert_eq!(
						result["capabilities"],
						json!({
							"driver": "sqlite",
							"readOnly": request["params"]["readOnly"],
							"cancel": "cooperative",
							"supportsTransactions": false,
							"supportsMetadata": true,
						}),
						"connection.open capabilities"
					);
					issued.insert(
						expected["result"]["sessionId"].as_str().unwrap().to_owned(),
						(
							result["sessionId"].clone(),
							result["sessionGeneration"].clone(),
						),
					);
				}
			}
			"metadata.listObjects" => {
				// The fixture below holds exactly the objects the sample session lists.
				let result = message
					.get("result")
					.unwrap_or_else(|| panic!("{method}: {message}"));
				assert_eq!(result, &expected["result"], "metadata.listObjects result");
			}
			"metadata.describe" => {
				let result = message
					.get("result")
					.unwrap_or_else(|| panic!("{method}: {message}"));
				assert!(
					!result["columns"].as_array().unwrap().is_empty(),
					"metadata.describe returns columns"
				);
			}
			"query.execute" => {
				// A statement that does not compile is answered with an error, not a result
				// (rq_009); the sample records the error kind the client must act on.
				if let Some(expected) = expected.get("result") {
					let result = message
						.get("result")
						.unwrap_or_else(|| panic!("{method}: {message}"));
					// rq_006: the reply is `queued`, then `running` and `completed` arrive as
					// notifications, exactly as the sample records them.
					assert_eq!(keys(result), keys(expected), "query.execute result fields");
					let sample_id = expected["executionId"]
						.as_str()
						.expect("the sample names its execution")
						.to_owned();
					let execution = result["executionId"].clone();
					issued_ids.insert(sample_id.clone(), execution.clone());
					if expected["state"] == "queued" {
						assert_eq!(result["state"], "queued", "the reply names queued");
						assert_eq!(result["sequence"], 1);
						// The notifications the sample records for this execution, in order. They
						// arrive asynchronously, so an execution the sample cancels later (rq_010)
						// only gets them from `query.cancel`'s reply.
						if !cancelled_later(&samples, &request) {
							let expected_states: Vec<String> = samples[index..]
								.iter()
								.map(|(_, later)| later)
								.filter(|later| is_notification(later))
								.filter(|later| {
									later["params"]["executionId"] == expected["executionId"]
								})
								.map(|later| later["params"]["state"].as_str().unwrap().to_owned())
								.collect();
							assert_eq!(
								states(&messages, result["executionId"].as_str().unwrap()),
								expected_states,
								"the state sequence the sample records"
							);
							let sequences: Vec<&Value> = notifications(&messages)
								.iter()
								.map(|notification| &notification["params"]["sequence"])
								.collect();
							let expected_sequences: Vec<&Value> = samples[index..]
								.iter()
								.map(|(_, later)| later)
								.filter(|later| is_notification(later))
								.filter(|later| {
									later["params"]["executionId"] == expected["executionId"]
								})
								.map(|later| &later["params"]["sequence"])
								.collect();
							assert_eq!(sequences, expected_sequences, "sequences");
							// The sample's notifications name its result ids; ours name the ones
							// this process issued, so the sample's `result.fetchPage` can be replayed.
							let sample_results: Vec<Value> = samples[index..]
								.iter()
								.map(|(_, later)| later)
								.filter(|later| is_notification(later))
								.filter(|later| {
									later["params"]["executionId"] == expected["executionId"]
								})
								.flat_map(|later| {
									later["params"]["resultIds"]
										.as_array()
										.cloned()
										.unwrap_or_default()
								})
								.collect();
							let issued_results: Vec<Value> = notifications(&messages)
								.iter()
								.filter(|notification| {
									notification["params"]["executionId"] == execution
								})
								.flat_map(|notification| {
									notification["params"]["resultIds"]
										.as_array()
										.cloned()
										.unwrap_or_default()
								})
								.collect();
							assert_eq!(
								issued_results.len(),
								sample_results.len(),
								"the result handles the sample records"
							);
							for (sample_id, issued) in sample_results.iter().zip(issued_results) {
								issued_ids.insert(
									sample_id.as_str().expect("a result id").to_owned(),
									issued,
								);
							}
						}
					}
				} else {
					assert_eq!(
						message["error"]["data"]["kind"], expected["error"]["data"]["kind"],
						"query.execute error kind: {message}"
					);
					// The sample records the database's own result code next to the kind; SQLite
					// reports the preparer's `SQLITE_ERROR` as `1` for a statement it cannot compile.
					assert_eq!(
						message["error"]["data"]["sqlState"], expected["error"]["data"]["sqlState"],
						"query.execute error sqlState: {message}"
					);
				}
			}
			"query.cancel" => {
				let result = message
					.get("result")
					.unwrap_or_else(|| panic!("{method}: {message}"));
				// rq_011: the sample cancels an execution while it runs. Whether the interrupt still
				// finds the statement depends on the machine: the reply reports what the registry held
				// when the cancel arrived — `cancel_requested` when the worker had reported `running`,
				// the terminal state when it had already reported the outcome, which §5 answers with
				// `accepted: false`. Both are honest; the real interruption is proven deterministically
				// in `tests/cancellation.rs`.
				let execution = request["params"]["executionId"].as_str().unwrap();
				// Every state the execution reported, including `running` from an earlier reply: the
				// cancel's own notification is the last one when it was accepted.
				let reported = states(&messages, execution);
				match result["accepted"].as_bool() {
					Some(true) => {
						assert_eq!(
							result["state"], "cancel_requested",
							"query.cancel: {message}"
						);
						assert_eq!(reported[0], "cancel_requested", "{messages:?}");
						// The sample's statement was slow enough for the interrupt to win, so it
						// recorded `cancelled`. `SELECT count(*) FROM customers` over the fixture's two
						// rows is already past its last interruptible step when the cancel arrives, and
						// §5 allows `cancel_requested` to end as `completed`.
						assert!(
							matches!(
								reported.get(1).map(String::as_str),
								Some("cancelled" | "completed")
							),
							"cancel_requested ends as cancelled or completed: {messages:?}"
						);
					}
					Some(false) => {
						assert!(
							matches!(result["state"].as_str(), Some("cancelled" | "completed")),
							"a refused cancel reports the terminal state: {message}"
						);
						assert_eq!(
							reported.last().map(String::as_str),
							result["state"].as_str(),
							"the reply repeats a state the worker reported: {messages:?}"
						);
					}
					None => panic!("query.cancel accepted: {message}"),
				}
			}
			"query.getState" => {
				let result = message
					.get("result")
					.unwrap_or_else(|| panic!("{method}: {message}"));
				// rq_012: the execution the sample cancelled reports its terminal state without an
				// error, at the sequence the notification that reported it carried: three states
				// when the cancel was accepted, two when the statement had already ended (§5).
				assert!(
					matches!(result["state"].as_str(), Some("cancelled" | "completed")),
					"query.getState: {result}"
				);
				let id = result["executionId"].as_str().unwrap();
				let sequence = last_sequence.get(id).copied().unwrap_or(1);
				assert_eq!(
					result["sequence"], sequence,
					"query.getState repeats the sequence its last notification reported"
				);
				assert!(
					result.get("error").is_none(),
					"a user cancellation carries no error: {result}"
				);
			}
			"result.fetchPage" => {
				// The sample fetches twice: once while the handle is live, once after
				// `result.release`, which must fail as RESULT_EXPIRED. The expected record
				// therefore has either a `result` or an `error`.
				if let Some(expected) = expected.get("result") {
					let result = message
						.get("result")
						.unwrap_or_else(|| panic!("{method}: {message}"));
					assert_eq!(
						keys(result),
						keys(expected),
						"result.fetchPage result fields"
					);
					// `SELECT 1 AS answer` is the sample's first result: one INT64 cell.
					assert_eq!(result["columns"], expected["columns"], "columns");
					assert_eq!(result["rows"], expected["rows"], "rows");
					assert_eq!(result["hasMore"], false);
					assert_eq!(result["nextCursor"], Value::Null);
				} else {
					assert_eq!(
						message["error"]["data"]["kind"], "RESULT_EXPIRED",
						"a released handle cannot be fetched: {message}"
					);
				}
			}
			"result.release" => {
				let result = message
					.get("result")
					.unwrap_or_else(|| panic!("{method}: {message}"));
				assert_eq!(result, &json!({"released": true}), "result.release");
			}
			other => panic!("no conformance replay for {other}"),
		}
		answered_count += 1;
	}
	let requests = samples
		.iter()
		.filter(|(_, value)| is_request(value))
		.count();
	assert!(requests > 0);
	assert_eq!(answered_count, requests);
	assert_eq!(issued.len(), 1, "the sample session opens one session");

	// conformance.ndjson has no connection.listSessions sample; its reply is checked here.
	let request = json!({"jsonrpc": "2.0", "id": "rq_list", "method": "connection.listSessions", "params": {}});
	let message = answered(&mut server, &request);
	assert_conforms(&schema, &registry, &request, &message);
	let states: Vec<&Value> = message["result"]["sessions"]
		.as_array()
		.unwrap()
		.iter()
		.map(|session| &session["state"])
		.collect();
	assert_eq!(states, [&json!("closed")], "the sample session closes it");
}

/// The one reply to `request` inside `reply`, checked against the contract.
fn answered_from(reply: &Reply, request: &Value, schema: &Schema, registry: &Value) -> Value {
	let id = &request["id"];
	let mut answers = reply
		.messages
		.iter()
		.filter(|message| !is_notification(message) && message.get("id") == Some(id));
	assert_eq!(
		answers.clone().count(),
		1,
		"every request gets exactly one reply: {request}\n{:?}",
		reply.messages
	);
	let message = answers.next().unwrap().clone();
	assert_conforms(schema, registry, request, &message);
	message
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
		let message = answered(server, &request);
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

	let reply = Server::new().round_trip(line.as_bytes());
	assert_eq!(reply.exit, None);
	let reply = &reply.messages[0];
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
	let reply = |payload: &[u8]| Server::new().handle_payload(payload).messages[0].clone();
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
