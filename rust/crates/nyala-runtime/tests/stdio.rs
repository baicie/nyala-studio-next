/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Runs the real `nyala-runtime` executable over pipes: frames in on stdin, frames out on stdout,
//! logs on stderr, and the exit codes the contract and `docs/adr/0002-rust-runtime-workspace.md` define.

mod support;

use std::io::{Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use nyala_runtime::connection::MAX_OPEN_SESSIONS;
use nyala_runtime::framing::{
	encode_frame, FrameDecoder, DEFAULT_FRAME_MAX_BYTES, PRE_HELLO_FRAME_MAX_BYTES,
};
use nyala_runtime::sqlite::OPEN_BUSY_TIMEOUT;
use serde_json::{json, Value};
use support::{conformance_samples, decode_frames, path_param, ReadOnly, TempDir};

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

/// `runtime.hello` that negotiates the `sqlite` feature.
fn sqlite_hello(id: &str) -> Vec<u8> {
	request(
		id,
		"runtime.hello",
		json!({"protocolMajor": 1, "protocolMinor": 0, "clientBuild": "test", "supportedFeatures": ["sqlite"]}),
	)
}

/// `runtime.hello` that negotiates every feature the runtime advertises.
fn full_hello(id: &str) -> Vec<u8> {
	request(
		id,
		"runtime.hello",
		json!({
			"protocolMajor": 1,
			"protocolMinor": 0,
			"clientBuild": "test",
			"supportedFeatures": [
				"sqlite",
				"metadata.listObjects",
				"query.execute",
				"query.cancel",
				"result.fetchPage",
				"result.release"
			],
		}),
	)
}

/// `connection.test` or `connection.open` for `path`.
fn connect(id: &str, method: &str, path: &str, read_only: bool) -> Vec<u8> {
	request(
		id,
		method,
		json!({"driver": "sqlite", "path": path, "readOnly": read_only}),
	)
}

fn close(id: &str, session_id: &Value, generation: &Value) -> Vec<u8> {
	request(
		id,
		"connection.close",
		json!({"sessionId": session_id, "sessionGeneration": generation}),
	)
}

fn list(id: &str) -> Vec<u8> {
	request(id, "connection.listSessions", json!({}))
}

/// A runtime process driven one request at a time, for requests that use ids from earlier
/// replies.
struct Live {
	child: Child,
	stdin: ChildStdin,
	stdout: ChildStdout,
	decoder: FrameDecoder,
	stderr: JoinHandle<String>,
}

impl Live {
	fn start() -> Self {
		let mut child = spawn();
		let stdin = child.stdin.take().unwrap();
		let stdout = child.stdout.take().unwrap();
		let mut stderr = child.stderr.take().unwrap();
		// Drained on its own thread so that a full stderr pipe can never block the runtime.
		let stderr = thread::spawn(move || {
			let mut text = String::new();
			stderr.read_to_string(&mut text).expect("stderr is UTF-8");
			text
		});
		Live {
			child,
			stdin,
			stdout,
			decoder: FrameDecoder::new(DEFAULT_FRAME_MAX_BYTES),
			stderr,
		}
	}

	/// Sends one request frame and waits for its reply.
	fn call(&mut self, frame: &[u8]) -> Value {
		self.stdin
			.write_all(frame)
			.and_then(|()| self.stdin.flush())
			.expect("write a request");
		let mut chunk = [0; 4096];
		loop {
			if let Some(payload) = self.decoder.next_frame().expect("replies are valid frames") {
				return serde_json::from_slice(&payload).expect("replies are JSON");
			}
			let read = self.stdout.read(&mut chunk).expect("read a reply");
			assert!(read > 0, "the runtime closed stdout without replying");
			self.decoder.push(&chunk[..read]);
		}
	}

	/// Closes stdin, checks that nothing but the replies was written to stdout, and returns the
	/// exit code and stderr.
	fn finish(self) -> (Option<i32>, String) {
		let Live {
			mut child,
			stdin,
			mut stdout,
			mut decoder,
			stderr,
		} = self;
		drop(stdin);
		let mut rest = Vec::new();
		stdout
			.read_to_end(&mut rest)
			.expect("read stdout to the end");
		decoder.push(&rest);
		assert_eq!(decoder.next_frame(), Ok(None), "a reply nobody asked for");
		assert_eq!(decoder.pending_bytes(), 0, "stdout holds a partial frame");
		let status = child.wait().expect("wait for nyala-runtime");
		(status.code(), stderr.join().unwrap())
	}
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

fn result(message: &Value) -> &Value {
	message
		.get("result")
		.unwrap_or_else(|| panic!("expected a result: {message}"))
}

#[test]
fn a_session_is_tested_opened_listed_and_closed_over_the_pipe() {
	let dir = TempDir::new("session");
	let database = dir.database("db.sqlite");
	let path = path_param(&database);
	let mut runtime = Live::start();
	assert_eq!(
		result(&runtime.call(&sqlite_hello("rq_1")))["features"],
		json!(["sqlite"])
	);

	let tested = runtime.call(&connect("rq_2", "connection.test", path, true));
	assert_eq!(result(&tested)["ok"], true);
	assert!(result(&tested)["serverVersion"].is_string(), "{tested}");
	assert_eq!(
		result(&runtime.call(&list("rq_3")))["sessions"],
		json!([]),
		"connection.test creates no session"
	);

	let session = result(&runtime.call(&connect("rq_4", "connection.open", path, true))).clone();
	assert_eq!(session["sessionGeneration"], 1);
	assert_eq!(session["capabilities"]["readOnly"], true);
	let (id, generation) = (&session["sessionId"], &session["sessionGeneration"]);
	assert_eq!(
		result(&runtime.call(&list("rq_5")))["sessions"],
		json!([{"sessionId": id, "sessionGeneration": generation, "driver": "sqlite", "state": "open"}])
	);
	assert_eq!(result(&runtime.call(&health("rq_6")))["activeSessions"], 1);

	// Closing is idempotent.
	for request_id in ["rq_7", "rq_8"] {
		assert_eq!(
			result(&runtime.call(&close(request_id, id, generation))),
			&json!({"closed": true})
		);
	}
	assert_eq!(
		result(&runtime.call(&list("rq_9")))["sessions"][0]["state"],
		"closed"
	);
	assert_eq!(result(&runtime.call(&health("rq_10")))["activeSessions"], 0);

	let (code, stderr) = runtime.finish();
	assert_eq!(code, Some(0), "{stderr}");
}

#[test]
fn a_generation_that_does_not_match_is_refused_and_the_sessions_stay_open() {
	let dir = TempDir::new("generation");
	let database = dir.database("db.sqlite");
	let path = path_param(&database);
	let mut runtime = Live::start();
	runtime.call(&sqlite_hello("rq_1"));
	let first = result(&runtime.call(&connect("rq_2", "connection.open", path, true))).clone();
	let second = result(&runtime.call(&connect("rq_3", "connection.open", path, false))).clone();
	assert_ne!(first["sessionId"], second["sessionId"]);
	assert_eq!(second["sessionGeneration"], 2);
	assert_eq!(second["capabilities"]["readOnly"], false);

	// Each session's id with the other session's generation.
	for (request_id, id, generation) in [
		("rq_4", &first["sessionId"], &second["sessionGeneration"]),
		("rq_5", &second["sessionId"], &first["sessionGeneration"]),
	] {
		let refused = runtime.call(&close(request_id, id, generation));
		assert_eq!(kind(&refused), "INVALID_SESSION", "{refused}");
		assert_eq!(refused["error"]["data"]["sessionId"], *id);
	}
	let listed = runtime.call(&list("rq_6"));
	let states: Vec<&Value> = result(&listed)["sessions"]
		.as_array()
		.unwrap()
		.iter()
		.map(|session| &session["state"])
		.collect();
	assert_eq!(states, [&json!("open"), &json!("open")]);

	// Both sessions are still open when stdin closes; the runtime closes them on its way out.
	let (code, stderr) = runtime.finish();
	assert_eq!(code, Some(0), "{stderr}");
}

#[test]
fn session_ids_from_another_runtime_process_are_unknown() {
	let dir = TempDir::new("processes");
	let database = dir.database("db.sqlite");
	let path = path_param(&database);
	let mut a = Live::start();
	let mut b = Live::start();
	let mut sessions = Vec::new();
	for runtime in [&mut a, &mut b] {
		runtime.call(&sqlite_hello("rq_1"));
		sessions
			.push(result(&runtime.call(&connect("rq_2", "connection.open", path, true))).clone());
	}
	let (from_a, from_b) = (&sessions[0], &sessions[1]);
	assert_ne!(from_a["sessionId"], from_b["sessionId"]);
	// Both processes number their sessions from 1, so only the id tells them apart.
	assert_eq!(from_a["sessionGeneration"], from_b["sessionGeneration"]);

	let refused = b.call(&close(
		"rq_3",
		&from_a["sessionId"],
		&from_a["sessionGeneration"],
	));
	assert_eq!(kind(&refused), "INVALID_SESSION", "{refused}");
	assert_eq!(
		result(&b.call(&list("rq_4")))["sessions"][0]["state"],
		"open",
		"the refused close must not touch the session of B"
	);
	assert_eq!(
		result(&a.call(&close(
			"rq_3",
			&from_a["sessionId"],
			&from_a["sessionGeneration"]
		))),
		&json!({"closed": true})
	);

	for runtime in [a, b] {
		let (code, stderr) = runtime.finish();
		assert_eq!(code, Some(0), "{stderr}");
	}
}

#[test]
fn files_that_are_not_usable_databases_are_refused_without_naming_the_path() {
	const MARKER: &str = "hunter2-alice";
	let dir = TempDir::new(&format!("{MARKER}-paths"));
	let database = path_param(&dir.database("db.sqlite")).to_owned();
	let mut cases: Vec<(String, &str)> = vec![
		(
			"db.sqlite".into(),
			"path must be an absolute local file path",
		),
		(
			":memory:".into(),
			"in-memory and URI databases are not supported",
		),
		(
			format!("file:{database}"),
			"in-memory and URI databases are not supported",
		),
		(
			path_param(&dir.join("missing.sqlite")).into(),
			"file does not exist",
		),
		(
			path_param(&dir.folder("folder")).into(),
			"path is a directory",
		),
		(
			path_param(&dir.file("empty.sqlite", b"")).into(),
			"file is empty",
		),
		(
			path_param(&dir.file("notes.txt", &b"plain text, not a database\n".repeat(64))).into(),
			"file is not a SQLite database",
		),
		(
			path_param(&dir.truncated_database("truncated.sqlite")).into(),
			"database file is corrupt",
		),
	];
	if cfg!(windows) {
		// Refused from the string alone, so no SMB connection is attempted; `.invalid` never
		// resolves in any case.
		cases.extend([
			(
				r"\\nyala.invalid\share\db.sqlite".to_owned(),
				"path must be an absolute local file path",
			),
			(
				format!(r"\\?\{database}"),
				"path must be an absolute local file path",
			),
			(
				"C:db.sqlite".to_owned(),
				"path must be an absolute local file path",
			),
		]);
	} else {
		cases.push(("/dev/null".into(), "path is not a regular file"));
	}

	let mut chunks = vec![sqlite_hello("rq_1")];
	for (index, (path, _)) in cases.iter().enumerate() {
		chunks.push(connect(
			&format!("rq_t{index}"),
			"connection.test",
			path,
			true,
		));
		chunks.push(connect(
			&format!("rq_o{index}"),
			"connection.open",
			path,
			false,
		));
	}
	chunks.push(list("rq_l"));
	let run = run(chunks);
	assert_eq!(run.code, Some(0), "{}", run.stderr);
	assert_eq!(run.messages.len(), 2 * cases.len() + 2);
	for (index, (path, detail)) in cases.iter().enumerate() {
		// connection.test and connection.open refuse the file in the same way.
		for message in &run.messages[1 + 2 * index..][..2] {
			assert_eq!(kind(message), "INVALID_PARAMS", "{path}: {message}");
			assert_eq!(message["error"]["data"]["safeDetail"], *detail, "{path}");
		}
	}
	assert_eq!(
		run.messages.last().unwrap()["result"]["sessions"],
		json!([])
	);
	assert!(!run.stderr.contains(MARKER), "{}", run.stderr);
	assert!(
		!String::from_utf8_lossy(&run.stdout).contains(MARKER),
		"replies must not name the path"
	);
}

#[test]
fn a_read_write_open_of_a_read_only_file_is_refused() {
	let dir = TempDir::new("read-only");
	let database = dir.database("db.sqlite");
	let Some(_read_only) = ReadOnly::set(&database) else {
		// Root can write any file on Unix, so there is no downgrade to observe.
		return;
	};
	let path = path_param(&database);
	let run = run(vec![
		sqlite_hello("rq_1"),
		connect("rq_2", "connection.open", path, false),
		connect("rq_3", "connection.test", path, false),
		connect("rq_4", "connection.open", path, true),
	]);
	assert_eq!(run.code, Some(0), "{}", run.stderr);
	for message in &run.messages[1..3] {
		assert_eq!(kind(message), "PERMISSION_DENIED", "{message}");
		assert_eq!(
			message["error"]["data"]["safeDetail"],
			"the database file is not writable"
		);
	}
	assert_eq!(run.messages[3]["result"]["capabilities"]["readOnly"], true);
}

#[test]
fn a_database_locked_by_another_process_fails_with_query_timeout() {
	let dir = TempDir::new("locked");
	let database = dir.database("db.sqlite");
	let holder = rusqlite::Connection::open(&database).expect("open the lock holder");
	// An exclusive transaction keeps every other connection from reading the file.
	holder
		.execute_batch("BEGIN EXCLUSIVE")
		.expect("take the exclusive lock");
	let path = path_param(&database);
	let mut runtime = Live::start();
	runtime.call(&sqlite_hello("rq_1"));
	// Each request is timed on its own, so that a runtime that waits only once cannot pass.
	for (request_id, method) in [("rq_2", "connection.test"), ("rq_3", "connection.open")] {
		let started = Instant::now();
		let message = runtime.call(&connect(request_id, method, path, true));
		let elapsed = started.elapsed();
		assert_eq!(kind(&message), "QUERY_TIMEOUT", "{method}: {message}");
		assert_eq!(
			message["error"]["data"]["safeDetail"], "database is locked by another connection",
			"{method}"
		);
		assert_eq!(message["error"]["data"]["retryable"], false, "{method}");
		assert!(
			elapsed >= OPEN_BUSY_TIMEOUT,
			"{method} gave up after {elapsed:?}, before the busy timeout"
		);
	}
	assert_eq!(result(&runtime.call(&list("rq_4")))["sessions"], json!([]));
	holder.execute_batch("ROLLBACK").unwrap();

	let (code, stderr) = runtime.finish();
	assert_eq!(code, Some(0), "{stderr}");
}

#[test]
fn a_query_is_executed_paged_and_released_over_the_pipe() {
	let dir = TempDir::new("query");
	let database = dir.database("db.sqlite");
	let path = path_param(&database);
	let mut runtime = Live::start();
	let hello = result(&runtime.call(&full_hello("rq_1"))).clone();
	assert_eq!(hello["features"].as_array().unwrap().len(), 6, "{hello}");

	let session = result(&runtime.call(&connect("rq_2", "connection.open", path, true))).clone();
	let (id, generation) = (&session["sessionId"], &session["sessionGeneration"]);
	let params = |sql: &str, mode: &str| {
		json!({
			"sessionId": id,
			"sessionGeneration": generation,
			"sql": sql,
			"mode": mode,
			"timeoutMs": 30_000,
			"maxInitialRows": 200,
		})
	};

	// Metadata: every object the fixture holds, tables and views before indexes.
	let listed = result(&runtime.call(&request(
		"rq_3",
		"metadata.listObjects",
		json!({"sessionId": id, "sessionGeneration": generation, "limit": 50}),
	)))
	.clone();
	let names: Vec<(&str, &str)> = listed["objects"]
		.as_array()
		.unwrap()
		.iter()
		.map(|object| {
			(
				object["name"].as_str().unwrap(),
				object["kind"].as_str().unwrap(),
			)
		})
		.collect();
	assert_eq!(
		names,
		[
			("customers", "table"),
			("recent_orders", "view"),
			("customers_by_name", "index"),
		],
		"{listed}"
	);
	assert_eq!(listed["hasMore"], false);
	let described = result(&runtime.call(&request(
		"rq_4",
		"metadata.describe",
		json!({"sessionId": id, "sessionGeneration": generation, "object": {"schema": "main", "name": "customers"}}),
	)))
	.clone();
	assert_eq!(
		described["columns"][0]["name"], "id",
		"the primary key comes first: {described}"
	);

	// A statement with columns: completed immediately, with one result handle.
	let executed = result(&runtime.call(&request(
		"rq_5",
		"query.execute",
		params("SELECT id, name FROM customers ORDER BY id", "statement"),
	)))
	.clone();
	assert_eq!(executed["state"], "completed", "{executed}");
	let execution_id = executed["executionId"].clone();
	let state = result(&runtime.call(&request(
		"rq_6",
		"query.getState",
		json!({"executionId": execution_id}),
	)))
	.clone();
	assert_eq!(state["state"], "completed");
	let result_id = state["resultIds"][0].clone();

	let page = result(&runtime.call(&request(
		"rq_7",
		"result.fetchPage",
		json!({"resultId": result_id, "cursor": null, "limit": 200}),
	)))
	.clone();
	assert_eq!(
		page["rows"],
		json!([
			[{"type": "int64", "text": "1"}, {"type": "string", "value": "Ada"}],
			[{"type": "int64", "text": "2"}, {"type": "string", "value": "Grace"}],
		]),
		"{page}"
	);
	assert_eq!(page["hasMore"], false);
	assert_eq!(page["rowCountEstimate"], 2);

	// Releasing is idempotent and takes the handle away.
	for request_id in ["rq_8", "rq_9"] {
		assert_eq!(
			result(&runtime.call(&request(
				request_id,
				"result.release",
				json!({"resultId": result_id}),
			))),
			&json!({"released": true})
		);
	}
	assert_eq!(
		kind(&runtime.call(&request(
			"rq_10",
			"result.fetchPage",
			json!({"resultId": result_id, "cursor": null, "limit": 200}),
		))),
		"RESULT_EXPIRED"
	);

	// Invalid SQL fails as SQL_SYNTAX and still names its execution, which getState reports.
	let failed = runtime.call(&request(
		"rq_11",
		"query.execute",
		params("SELECT FROM WHERE", "statement"),
	));
	assert_eq!(kind(&failed), "SQL_SYNTAX", "{failed}");
	assert_eq!(failed["error"]["data"]["sessionId"], id.clone());
	let failed_id = failed["error"]["data"]["executionId"].clone();
	let failed_state = result(&runtime.call(&request(
		"rq_12",
		"query.getState",
		json!({"executionId": failed_id}),
	)))
	.clone();
	assert_eq!(failed_state["state"], "failed", "{failed_state}");
	assert_eq!(failed_state["error"]["data"]["kind"], "SQL_SYNTAX");

	// A write on a read-only session is refused by SQLite's mode, not by reading the SQL.
	let denied = runtime.call(&request(
		"rq_13",
		"query.execute",
		params("INSERT INTO customers(name) VALUES ('Turing')", "statement"),
	));
	assert_eq!(kind(&denied), "READ_ONLY_DENIED", "{denied}");
	let after = result(&runtime.call(&request(
		"rq_14",
		"query.execute",
		params("SELECT count(*) FROM customers", "statement"),
	)))
	.clone();
	let count_id = result(&runtime.call(&request(
		"rq_15",
		"query.getState",
		json!({"executionId": after["executionId"]}),
	)))["resultIds"][0]
		.clone();
	let count = result(&runtime.call(&request(
		"rq_16",
		"result.fetchPage",
		json!({"resultId": count_id, "cursor": null, "limit": 200}),
	)))
	.clone();
	assert_eq!(
		count["rows"],
		json!([[{"type": "int64", "text": "2"}]]),
		"{count}"
	);

	let (code, stderr) = runtime.finish();
	assert_eq!(code, Some(0), "{stderr}");
}

#[test]
fn a_page_too_large_for_a_frame_is_paged_instead_of_ending_the_stream() {
	let dir = TempDir::new("big-page");
	let path = dir.join("rows.sqlite");
	rusqlite::Connection::open(&path)
		.unwrap()
		.execute_batch(
			"CREATE TABLE padded(payload TEXT);
			WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 2500)
			INSERT INTO padded SELECT hex(zeroblob(2000)) FROM n;",
		)
		.unwrap();
	let path = path_param(&path);
	let mut runtime = Live::start();
	runtime.call(&full_hello("rq_1"));
	let session = result(&runtime.call(&connect("rq_2", "connection.open", path, true))).clone();
	let (id, generation) = (&session["sessionId"], &session["sessionGeneration"]);

	let executed = result(&runtime.call(&request(
		"rq_3",
		"query.execute",
		json!({
			"sessionId": id,
			"sessionGeneration": generation,
			"sql": "SELECT payload FROM padded",
			"mode": "statement",
			"timeoutMs": 30_000,
			"maxInitialRows": 2500,
		}),
	)))
	.clone();
	let result_id = result(&runtime.call(&request(
		"rq_4",
		"query.getState",
		json!({"executionId": executed["executionId"]}),
	)))
	.clone()["resultIds"][0]
		.clone();

	// 2500 rows of ~4 KiB each are ~10 MiB of JSON: more than one frame. Asking for all of them at
	// once must come back as a smaller page with a cursor, never as a frame the stream cannot carry
	// (which would end the process and every session with it).
	let mut pages = 0;
	let mut rows = 0;
	let mut cursor = Value::Null;
	loop {
		let page = result(&runtime.call(&request(
			&format!("rq_p{pages}"),
			"result.fetchPage",
			json!({"resultId": result_id, "cursor": cursor, "limit": 1000}),
		)))
		.clone();
		rows += page["rows"].as_array().unwrap().len();
		pages += 1;
		if page["hasMore"] != true {
			assert_eq!(page["nextCursor"], Value::Null);
			break;
		}
		cursor = page["nextCursor"].clone();
	}
	assert_eq!(rows, 2500, "every row crosses the pipe exactly once");
	assert!(pages > 1, "{pages} pages");

	// The connection is still healthy after the big result.
	assert_eq!(
		result(&runtime.call(&health("rq_h")))["status"],
		"ok",
		"the stream survived the paging"
	);
	let (code, stderr) = runtime.finish();
	assert_eq!(code, Some(0), "{stderr}");
}

#[test]
fn opening_beyond_the_session_limit_is_refused_and_the_connection_continues() {
	let dir = TempDir::new("limit");
	let database = dir.database("db.sqlite");
	let path = path_param(&database);
	let mut runtime = Live::start();
	runtime.call(&sqlite_hello("rq_1"));
	let mut first = None;
	for index in 0..MAX_OPEN_SESSIONS {
		let request_id = format!("rq_o{index}");
		let opened =
			result(&runtime.call(&connect(&request_id, "connection.open", path, true))).clone();
		first.get_or_insert(opened);
	}

	let refused = runtime.call(&connect("rq_x", "connection.open", path, true));
	assert_eq!(kind(&refused), "RESOURCE_LIMIT", "{refused}");
	assert_eq!(
		result(&runtime.call(&health("rq_h")))["activeSessions"],
		MAX_OPEN_SESSIONS
	);

	// Closing one session makes room for another.
	let first = first.unwrap();
	result(&runtime.call(&close(
		"rq_c",
		&first["sessionId"],
		&first["sessionGeneration"],
	)));
	let reopened = runtime.call(&connect("rq_y", "connection.open", path, true));
	assert_eq!(
		result(&reopened)["sessionGeneration"],
		MAX_OPEN_SESSIONS + 1
	);

	let (code, stderr) = runtime.finish();
	assert_eq!(code, Some(0), "{stderr}");
}
