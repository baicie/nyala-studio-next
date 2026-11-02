/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Cancellation, timeouts and the honest `unknown` state (N-108), against the real executable.
//!
//! `conformance.ndjson` records a cancel of a statement the sample runtime happened to interrupt,
//! but its fixture (`SELECT count(*)` over two rows) finishes before a cancel can reach it — §5
//! allows `cancel_requested` to end as `completed`, and that is what this build reports there.
//! These tests make the interruption deterministic instead: a recursive CTE that steps for far
//! longer than the test waits, so the cancel or the deadline always arrives while SQLite runs.
//!
//! The tests assert the properties `README.md` §5 fixes — a `cancel_requested` state of its own,
//! strictly increasing `sequence`, a terminal state that ends the notifications, no error on a user
//! cancellation — and not one exact interleaving, because arriving `running` before the cancel is a
//! race the contract allows either way.

mod support;

use std::io::{Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::thread::{self, JoinHandle};

use nyala_runtime::framing::{encode_frame, FrameDecoder, DEFAULT_FRAME_MAX_BYTES};
use serde_json::{json, Value};
use support::{path_param, TempDir};

/// A statement that steps until something stops it. `WITH RECURSIVE` without a depth limit is
/// exactly what a timeout and a cancel exist for.
const FOREVER: &str =
	"WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n";

struct Runtime {
	child: Child,
	stdin: ChildStdin,
	stdout: ChildStdout,
	decoder: FrameDecoder,
	stderr: JoinHandle<String>,
	/// Notifications read while waiting for a reply, never consumed.
	seen: Vec<Value>,
}

impl Runtime {
	fn start() -> Self {
		let mut child = Command::new(env!("CARGO_BIN_EXE_nyala-runtime"))
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.spawn()
			.expect("spawn nyala-runtime");
		let stdin = child.stdin.take().unwrap();
		let stdout = child.stdout.take().unwrap();
		let mut stderr = child.stderr.take().unwrap();
		let stderr = thread::spawn(move || {
			let mut text = String::new();
			stderr.read_to_string(&mut text).expect("stderr is UTF-8");
			text
		});
		Runtime {
			child,
			stdin,
			stdout,
			decoder: FrameDecoder::new(DEFAULT_FRAME_MAX_BYTES),
			stderr,
			seen: Vec::new(),
		}
	}

	fn send(&mut self, message: Value) {
		let frame = encode_frame(message.to_string().as_bytes(), DEFAULT_FRAME_MAX_BYTES).unwrap();
		self.stdin
			.write_all(&frame)
			.and_then(|()| self.stdin.flush())
			.expect("write a frame");
	}

	fn read(&mut self) -> Value {
		let mut chunk = [0; 4096];
		loop {
			if let Some(payload) = self.decoder.next_frame().expect("valid frames") {
				return serde_json::from_slice(&payload).expect("frames hold JSON");
			}
			let read = self.stdout.read(&mut chunk).expect("read stdout");
			assert!(read > 0, "the runtime closed stdout without replying");
			self.decoder.push(&chunk[..read]);
		}
	}

	/// Reads until the reply carrying `id`, keeping the notifications that came first.
	fn reply_to(&mut self, id: &str) -> Value {
		loop {
			let message = self.read();
			if message["id"] == id {
				return message;
			}
			assert!(
				message.get("id").is_none(),
				"a reply nobody asked for: {message}"
			);
			self.seen.push(message);
		}
	}

	/// Reads until the `query.stateChanged` that reports `state` for `execution`, keeping what came
	/// before.
	fn state_of(&mut self, execution: &str, state: &str) -> Value {
		if let Some(found) = self
			.seen
			.iter()
			.find(|message| reports(message, execution, state))
		{
			return found.clone();
		}
		loop {
			let message = self.read();
			assert!(
				message.get("id").is_none(),
				"a reply nobody asked for: {message}"
			);
			let found = reports(&message, execution, state);
			self.seen.push(message.clone());
			if found {
				return message;
			}
		}
	}

	/// The states reported for `execution`, in order.
	fn states(&self, execution: &str) -> Vec<String> {
		self.seen
			.iter()
			.filter(|message| message["params"]["executionId"] == execution)
			.map(|message| message["params"]["state"].as_str().unwrap().to_owned())
			.collect()
	}

	/// The sequences reported for `execution`, in order.
	fn sequences(&self, execution: &str) -> Vec<u64> {
		self.seen
			.iter()
			.filter(|message| message["params"]["executionId"] == execution)
			.map(|message| message["params"]["sequence"].as_u64().unwrap())
			.collect()
	}

	fn hello(&mut self) {
		self.send(json!({
			"jsonrpc": "2.0",
			"id": "rq_hello",
			"method": "runtime.hello",
			"params": {
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
			},
		}));
		let reply = self.reply_to("rq_hello");
		assert_eq!(reply["result"]["protocolMajor"], 1, "{reply}");
	}

	/// Opens `path` and returns `(sessionId, sessionGeneration)`.
	fn open(&mut self, path: &str, read_only: bool) -> (Value, Value) {
		self.send(json!({
			"jsonrpc": "2.0",
			"id": "rq_open",
			"method": "connection.open",
			"params": {"driver": "sqlite", "path": path, "readOnly": read_only},
		}));
		let reply = self.reply_to("rq_open");
		assert_eq!(reply["result"]["sessionGeneration"], 1, "{reply}");
		(
			reply["result"]["sessionId"].clone(),
			reply["result"]["sessionGeneration"].clone(),
		)
	}

	fn execute_request(
		request: &str,
		session: &(Value, Value),
		sql: &str,
		timeout_ms: u64,
	) -> Value {
		json!({
			"jsonrpc": "2.0",
			"id": request,
			"method": "query.execute",
			"params": {
				"sessionId": session.0,
				"sessionGeneration": session.1,
				"sql": sql,
				"mode": "statement",
				"timeoutMs": timeout_ms,
				"maxInitialRows": 200,
			},
		})
	}

	/// Sends a `query.execute` and returns the execution id of its `queued` reply.
	fn execute(
		&mut self,
		request: &str,
		session: &(Value, Value),
		sql: &str,
		timeout_ms: u64,
	) -> String {
		self.send(Self::execute_request(request, session, sql, timeout_ms));
		let reply = self.reply_to(request);
		assert_eq!(reply["result"]["state"], "queued", "{reply}");
		assert_eq!(reply["result"]["sequence"], 1, "{reply}");
		reply["result"]["executionId"]
			.as_str()
			.expect("a queued execution names itself")
			.to_owned()
	}

	fn cancel(&mut self, request: &str, execution: &str) -> Value {
		self.send(json!({
			"jsonrpc": "2.0",
			"id": request,
			"method": "query.cancel",
			"params": {"executionId": execution, "reason": "user"},
		}));
		self.reply_to(request)
	}

	fn get_state(&mut self, request: &str, execution: &str) -> Value {
		self.send(json!({
			"jsonrpc": "2.0",
			"id": request,
			"method": "query.getState",
			"params": {"executionId": execution},
		}));
		self.reply_to(request)
	}

	fn finish(mut self) -> (Option<i32>, String) {
		drop(self.stdin);
		let mut rest = Vec::new();
		self.stdout.read_to_end(&mut rest).expect("read stdout");
		self.decoder.push(&rest);
		while self.decoder.next_frame().expect("valid frames").is_some() {}
		let status = self.child.wait().expect("wait for nyala-runtime");
		(status.code(), self.stderr.join().unwrap())
	}
}

fn reports(message: &Value, execution: &str, state: &str) -> bool {
	message["method"] == "query.stateChanged"
		&& message["params"]["executionId"] == execution
		&& message["params"]["state"] == state
}

/// §5: the notifications of one execution carry strictly increasing sequences and a terminal
/// state ends them.
fn assert_state_machine(runtime: &Runtime, execution: &str, terminal: &str) {
	let sequences = runtime.sequences(execution);
	// The reply is `sequence: 1`, so the notifications count from 2 without a gap.
	assert_eq!(
		sequences,
		(2..=sequences.len() as u64 + 1).collect::<Vec<_>>(),
		"notification sequences start at 2 and increase by one: {sequences:?}"
	);
	let states = runtime.states(execution);
	assert_eq!(
		states.last().map(String::as_str),
		Some(terminal),
		"{states:?}"
	);
	// `running` and `cancel_requested` may or may not be reported before the terminal state, but
	// the terminal state itself is reported exactly once and last.
	assert_eq!(
		states
			.iter()
			.filter(|state| state.as_str() == terminal)
			.count(),
		1,
		"{states:?}"
	);
}

#[test]
fn cancel_interrupts_a_running_statement_and_reports_request_then_outcome() {
	let dir = TempDir::new("cancel");
	let database = dir.database("db.sqlite");
	let mut runtime = Runtime::start();
	runtime.hello();
	let session = runtime.open(path_param(&database), true);
	let execution = runtime.execute("rq_1", &session, FOREVER, 600_000);
	runtime.state_of(&execution, "running");

	let reply = runtime.cancel("rq_2", &execution);
	// The reply says the request was accepted; it does not claim the statement stopped.
	assert_eq!(
		reply["result"],
		json!({"accepted": true, "state": "cancel_requested"}),
		"{reply}"
	);
	// A state of its own, with its own sequence: `CancelRequested ≠ Cancelled` (§4).
	let requested = runtime.state_of(&execution, "cancel_requested");
	assert_eq!(requested["params"]["sequence"], 3, "{requested}");
	let cancelled = runtime.state_of(&execution, "cancelled");
	assert!(
		cancelled["params"]["elapsedMs"].is_number(),
		"a terminal state reports elapsedMs: {cancelled}"
	);
	// A user cancellation is not a database error (conformance.ndjson rq_012).
	assert!(cancelled["params"].get("error").is_none(), "{cancelled}");
	assert_state_machine(&runtime, &execution, "cancelled");

	// The compensation read gives the same answer.
	let state = runtime.get_state("rq_3", &execution);
	assert_eq!(state["result"]["state"], "cancelled", "{state}");
	assert_eq!(
		state["result"]["sequence"], cancelled["params"]["sequence"],
		"{state}"
	);
	assert!(state["result"].get("error").is_none(), "{state}");

	let (code, stderr) = runtime.finish();
	assert_eq!(code, Some(0), "{stderr}");
}

#[test]
fn a_late_cancel_reports_that_the_execution_already_ended() {
	let dir = TempDir::new("late-cancel");
	let database = dir.database("db.sqlite");
	let mut runtime = Runtime::start();
	runtime.hello();
	let session = runtime.open(path_param(&database), true);
	let execution = runtime.execute("rq_1", &session, "SELECT 1 AS answer", 30_000);
	runtime.state_of(&execution, "completed");

	let reply = runtime.cancel("rq_2", &execution);
	assert_eq!(
		reply["result"],
		json!({"accepted": false, "state": "completed"}),
		"a finished execution cannot be stopped: {reply}"
	);
	// A terminal state sends nothing more.
	assert_eq!(runtime.states(&execution), ["running", "completed"]);
}

#[test]
fn a_timeout_ends_a_running_statement_as_cancelled_with_query_timeout() {
	let dir = TempDir::new("timeout");
	let database = dir.database("db.sqlite");
	let mut runtime = Runtime::start();
	runtime.hello();
	let session = runtime.open(path_param(&database), true);
	let execution = runtime.execute("rq_1", &session, FOREVER, 50);
	runtime.state_of(&execution, "running");

	let cancelled = runtime.state_of(&execution, "cancelled");
	// A timeout is a cancellation with a cause, and the cause is the contract's query error.
	assert_eq!(
		cancelled["params"]["error"]["data"]["kind"], "QUERY_TIMEOUT",
		"{cancelled}"
	);
	let state = runtime.get_state("rq_2", &execution);
	assert_eq!(state["result"]["state"], "cancelled", "{state}");
	assert_eq!(
		state["result"]["error"]["data"]["kind"], "QUERY_TIMEOUT",
		"{state}"
	);
}

#[test]
fn closing_the_session_stops_its_execution_and_reports_the_terminal_state() {
	let dir = TempDir::new("close");
	let database = dir.database("db.sqlite");
	let mut runtime = Runtime::start();
	runtime.hello();
	let session = runtime.open(path_param(&database), true);
	let execution = runtime.execute("rq_1", &session, FOREVER, 600_000);
	runtime.state_of(&execution, "running");

	runtime.send(json!({
		"jsonrpc": "2.0",
		"id": "rq_2",
		"method": "connection.close",
		"params": {"sessionId": session.0, "sessionGeneration": session.1},
	}));
	let reply = runtime.reply_to("rq_2");
	assert_eq!(reply["result"], json!({"closed": true}), "{reply}");
	// The close stops the statement, and the client still learns how it ended: §5 requires
	// `cancel_requested` to reach a terminal state, and the session's registry keeps answering
	// until it has.
	let requested = runtime.state_of(&execution, "cancel_requested");
	assert_eq!(requested["params"]["sequence"], 3, "{requested}");
	let cancelled = runtime.state_of(&execution, "cancelled");
	assert_eq!(
		cancelled["params"]["error"]["data"]["kind"], "QUERY_CANCELLED",
		"{cancelled}"
	);
	// A client that missed the notification reads the same answer back from the closed session.
	let state = runtime.get_state("rq_3", &execution);
	assert_eq!(state["result"]["state"], "cancelled", "{state}");
	assert_eq!(
		state["result"]["sequence"], cancelled["params"]["sequence"],
		"{state}"
	);
}

#[test]
fn a_cancel_that_arrives_before_the_statement_runs_still_ends_the_execution() {
	let dir = TempDir::new("early-cancel");
	let database = dir.database("db.sqlite");
	let mut runtime = Runtime::start();
	runtime.hello();
	let session = runtime.open(path_param(&database), true);
	// `query.execute` is answered once the statement is prepared and before it steps, so this
	// cancel can overtake the worker: the execution is stopped before it runs anything.
	let execution = runtime.execute("rq_1", &session, FOREVER, 600_000);
	let reply = runtime.cancel("rq_2", &execution);
	assert_eq!(reply["result"]["accepted"], true, "{reply}");
	runtime.state_of(&execution, "cancelled");
	assert_state_machine(&runtime, &execution, "cancelled");
	let state = runtime.get_state("rq_3", &execution);
	assert_eq!(state["result"]["state"], "cancelled", "{state}");
}

#[test]
fn executions_queued_behind_a_running_statement_run_in_order() {
	let dir = TempDir::new("serial");
	let database = dir.database("db.sqlite");
	let mut runtime = Runtime::start();
	runtime.hello();
	let session = runtime.open(path_param(&database), true);
	let first = runtime.execute("rq_1", &session, FOREVER, 600_000);
	runtime.state_of(&first, "running");

	// One connection runs one statement at a time. The second job waits in the worker's queue and
	// reports nothing until the first ends; its reply names it only then.
	runtime.send(Runtime::execute_request(
		"rq_2",
		&session,
		"SELECT 2 AS answer",
		30_000,
	));
	runtime.cancel("rq_3", &first);
	runtime.state_of(&first, "cancelled");

	let reply = runtime.reply_to("rq_2");
	assert_eq!(reply["result"]["state"], "queued", "{reply}");
	let second = reply["result"]["executionId"].as_str().unwrap().to_owned();
	assert_ne!(first, second, "every execution gets its own id");
	let completed = runtime.state_of(&second, "completed");
	assert_eq!(
		completed["params"]["resultIds"].as_array().map(Vec::len),
		Some(1),
		"{completed}"
	);
	assert_state_machine(&runtime, &second, "completed");
}
