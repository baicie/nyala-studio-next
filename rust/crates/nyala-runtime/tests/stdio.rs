/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Runs the real `nyala-runtime` executable over pipes: frames in on stdin, frames out on stdout,
//! logs on stderr, and the exit codes the contract and `docs/adr/0002-rust-runtime-workspace.md` define.

mod support;

use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use nyala_runtime::framing::{encode_frame, DEFAULT_FRAME_MAX_BYTES, PRE_HELLO_FRAME_MAX_BYTES};
use serde_json::{json, Value};
use support::{conformance_samples, decode_frames};

struct Run {
	code: Option<i32>,
	messages: Vec<Value>,
	stdout: Vec<u8>,
	stderr: String,
}

fn spawn() -> Child {
	Command::new(env!("CARGO_BIN_EXE_nyala-runtime"))
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
		.expect("spawn nyala-runtime")
}

/// Writes `chunks` to stdin one write at a time, closes stdin and collects everything.
fn run(chunks: Vec<Vec<u8>>) -> Run {
	let mut child = spawn();
	let mut stdin = child.stdin.take().unwrap();
	let writer = thread::spawn(move || {
		for chunk in chunks {
			// The runtime may exit early (protocol mismatch, framing error) and close the pipe.
			if stdin
				.write_all(&chunk)
				.and_then(|()| stdin.flush())
				.is_err()
			{
				break;
			}
		}
	});
	let output = child.wait_with_output().expect("wait for nyala-runtime");
	writer.join().unwrap();
	Run {
		code: output.status.code(),
		messages: decode_frames(&output.stdout),
		stdout: output.stdout,
		stderr: String::from_utf8(output.stderr).expect("stderr is UTF-8"),
	}
}

fn frame(payload: impl AsRef<[u8]>) -> Vec<u8> {
	encode_frame(payload.as_ref(), DEFAULT_FRAME_MAX_BYTES).unwrap()
}

fn request(id: &str, method: &str, params: Value) -> Vec<u8> {
	frame(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string())
}

fn sample_hello() -> Vec<u8> {
	let line = conformance_samples()
		.into_iter()
		.find(|line| line.contains(r#""method":"runtime.hello""#))
		.unwrap();
	frame(line)
}

fn hello(id: &str, major: i64) -> Vec<u8> {
	request(
		id,
		"runtime.hello",
		json!({"protocolMajor": major, "protocolMinor": 0, "clientBuild": "test", "supportedFeatures": []}),
	)
}

fn health(id: &str) -> Vec<u8> {
	request(id, "runtime.health", json!({}))
}

fn kind(message: &Value) -> &str {
	message["error"]["data"]["kind"]
		.as_str()
		.unwrap_or_else(|| panic!("expected a failure: {message}"))
}

#[test]
fn empty_input_exits_cleanly() {
	let run = run(vec![]);
	assert_eq!(run.code, Some(0));
	assert!(run.messages.is_empty());
}

#[test]
fn hello_and_health_round_trip_and_logs_go_to_stderr() {
	let run = run(vec![sample_hello(), health("rq_002")]);
	assert_eq!(run.code, Some(0), "{}", run.stderr);
	assert_eq!(run.messages.len(), 2);
	assert_eq!(run.messages[0]["id"], "rq_001");
	assert_eq!(run.messages[0]["result"]["protocolMajor"], 1);
	assert_eq!(run.messages[1]["id"], "rq_002");
	assert_eq!(run.messages[1]["result"]["status"], "ok");
	assert!(run.stderr.contains("nyala-runtime: "), "{}", run.stderr);
}

#[test]
fn frames_split_byte_by_byte_or_glued_cross_the_pipe() {
	let stream = [
		sample_hello(),
		health("rq_2"),
		request("rq_3", "runtime.shutdown", json!({})),
	]
	.concat();
	let byte_by_byte = run(stream.iter().map(|byte| vec![*byte]).collect());
	let glued = run(vec![stream]);
	for run in [byte_by_byte, glued] {
		assert_eq!(run.code, Some(0), "{}", run.stderr);
		let ids: Vec<&Value> = run.messages.iter().map(|message| &message["id"]).collect();
		assert_eq!(ids, [&json!("rq_001"), &json!("rq_2"), &json!("rq_3")]);
		assert_eq!(kind(&run.messages[2]), "METHOD_NOT_FOUND");
	}
}

#[test]
fn major_mismatch_is_refused_with_exit_code_2() {
	let run = run(vec![hello("rq_1", 2), health("rq_2")]);
	assert_eq!(run.code, Some(2), "{}", run.stderr);
	assert_eq!(
		run.messages.len(),
		1,
		"nothing is answered after the mismatch"
	);
	assert_eq!(run.messages[0]["id"], "rq_1");
	assert_eq!(kind(&run.messages[0]), "PROTOCOL_MISMATCH");
}

#[test]
fn zero_length_frame_is_answered_then_the_connection_closes() {
	let run = run(vec![health("rq_1"), vec![0, 0, 0, 0], health("rq_2")]);
	assert_eq!(run.code, Some(1), "{}", run.stderr);
	assert_eq!(run.messages.len(), 2);
	assert_eq!(run.messages[0]["result"]["status"], "ok");
	assert_eq!(kind(&run.messages[1]), "INVALID_REQUEST");
	assert_eq!(run.messages[1]["id"], Value::Null);
}

#[test]
fn oversize_frame_is_refused_without_waiting_for_its_payload() {
	let mut child = spawn();
	let mut stdin = child.stdin.take().unwrap();
	stdin
		.write_all(&(PRE_HELLO_FRAME_MAX_BYTES + 1).to_le_bytes())
		.unwrap();
	stdin.flush().unwrap();

	// stdin stays open: the runtime must decide from the prefix alone.
	let deadline = Instant::now() + Duration::from_secs(20);
	let status = loop {
		if let Some(status) = child.try_wait().unwrap() {
			break status;
		}
		if Instant::now() > deadline {
			child.kill().unwrap();
			panic!("the runtime waited for the payload of an oversize frame");
		}
		thread::sleep(Duration::from_millis(20));
	};
	drop(stdin);

	let mut stdout = Vec::new();
	child
		.stdout
		.take()
		.unwrap()
		.read_to_end(&mut stdout)
		.unwrap();
	let messages = decode_frames(&stdout);
	assert_eq!(status.code(), Some(1));
	assert_eq!(messages.len(), 1);
	assert_eq!(kind(&messages[0]), "RESOURCE_LIMIT");
}

#[test]
fn frame_limit_is_1_mib_before_hello_and_8_mib_after() {
	let payload = json!({"jsonrpc": "2.0", "id": "rq_9", "method": "runtime.health", "params": {}})
		.to_string();
	let padding = PRE_HELLO_FRAME_MAX_BYTES as usize + 1 - payload.len();
	// Trailing whitespace keeps the payload valid JSON.
	let large_health = frame(payload + &" ".repeat(padding));

	let before = run(vec![large_health.clone()]);
	assert_eq!(before.code, Some(1), "{}", before.stderr);
	assert_eq!(before.messages.len(), 1);
	assert_eq!(kind(&before.messages[0]), "RESOURCE_LIMIT");

	let after = run(vec![hello("rq_1", 1), large_health]);
	assert_eq!(after.code, Some(0), "{}", after.stderr);
	assert_eq!(after.messages.len(), 2);
	assert_eq!(after.messages[1]["id"], "rq_9");
	assert_eq!(after.messages[1]["result"]["status"], "ok");
}

#[test]
fn malformed_payloads_get_errors_and_the_connection_continues() {
	let run = run(vec![
		frame("{not json"),
		frame([0xff, 0xfe]),
		frame("[]"),
		frame(r#"{"jsonrpc":"2.0","id":"rq_4","method":"runtime.health"}"#),
		request("rq_5", "runtime.shutdown", json!({})),
		request("rq_6", "query.execute", json!({})),
		health("rq_7"),
	]);
	assert_eq!(run.code, Some(0), "{}", run.stderr);
	let replies: Vec<(&Value, &str)> = run
		.messages
		.iter()
		.map(|message| {
			let outcome = message["error"]["data"]["kind"]
				.as_str()
				.unwrap_or("result");
			(&message["id"], outcome)
		})
		.collect();
	assert_eq!(
		replies,
		[
			(&Value::Null, "PARSE_ERROR"),
			(&Value::Null, "PARSE_ERROR"),
			(&Value::Null, "INVALID_REQUEST"),
			(&json!("rq_4"), "INVALID_REQUEST"),
			(&json!("rq_5"), "METHOD_NOT_FOUND"),
			(&json!("rq_6"), "PROTOCOL_MISMATCH"),
			(&json!("rq_7"), "result"),
		]
	);
}

#[test]
fn input_ending_inside_a_frame_is_a_stream_error() {
	let truncated = health("rq_2")[..6].to_vec();
	let run = run(vec![health("rq_1"), truncated]);
	assert_eq!(run.code, Some(1), "{}", run.stderr);
	assert_eq!(run.messages.len(), 1);
	assert_eq!(run.messages[0]["id"], "rq_1");
}

#[test]
fn payload_content_is_never_echoed_to_stdout_or_stderr() {
	const MARKER: &str = "hunter2-alice";
	let run = run(vec![
		frame(format!("{{\"password\":\"{MARKER}\"")),
		request(
			"rq_1",
			"connection.test",
			json!({"driver": "sqlite", "path": format!("/home/{MARKER}/db.sqlite"), "readOnly": true}),
		),
		request("rq_2", "runtime.hello", json!({"clientBuild": MARKER})),
		request("rq_3", MARKER, json!({})),
	]);
	assert_eq!(run.code, Some(0), "{}", run.stderr);
	assert_eq!(run.messages.len(), 4);
	assert!(!run.stderr.contains(MARKER), "{}", run.stderr);
	assert!(
		!String::from_utf8_lossy(&run.stdout).contains(MARKER),
		"replies must not echo request content"
	);
}
