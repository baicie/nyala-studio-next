/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Request dispatch, the `runtime.hello` handshake (`nyala/rpc/README.md` §3) and the stream loop.
//!
//! [`Server`] owns the request loop's input queue (`crate::events`): frame payloads from the
//! client and reports from the session workers arrive on the same queue, so the loop has a single
//! order to follow and a `query.stateChanged` notification is written the moment its execution
//! changes state — even while the client sends nothing. [`Server::step`] hands out one frame or
//! one report at a time; [`serve`] writes what it produces. The server performs no I/O of its own
//! except through the diagnostics sink it is given.
//!
//! `query.execute` answers in two steps. The request validates and hands the job to the session
//! worker; its reply (`queued`, `sequence: 1`) is written when the worker reports that the first
//! statement was prepared. A statement SQLite cannot compile is answered with the structured error
//! instead (`conformance.ndjson` rq_009), and nothing runs (`crate::query`).

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{self, Read, Write};
use std::sync::mpsc;
use std::thread;
use std::time::Instant;

use serde_json::{json, Map, Value};

use crate::connection::{self, Sessions};
use crate::error::{ErrorKind, RpcError};
use crate::events::{self, EndOfInput, Event, Input};
use crate::framing::{
	encode_frame, FrameDecoder, FrameError, DEFAULT_FRAME_MAX_BYTES, PRE_HELLO_FRAME_MAX_BYTES,
};
use crate::protocol::{
	parse_message, Incoming, Request, JSONRPC_VERSION, MAX_CONCURRENT_EXECUTIONS, MAX_INITIAL_ROWS,
	MAX_PAGE_ROWS, MAX_RESULT_TTL_SECS, PROTOCOL_MAJOR, PROTOCOL_MINOR, RUNTIME_BUILD,
	RUNTIME_FEATURES, V1_REQUEST_METHODS,
};
use crate::worker::MetadataCall;

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

/// What one frame or one worker report produced.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
	/// Envelopes to send back, in order. Empty for notifications, which get no response, and for
	/// a `query.execute` whose reply waits for its worker.
	pub messages: Vec<Value>,
	/// Set when the process must exit once `messages` have been written.
	pub exit: Option<ExitStatus>,
}

impl Reply {
	fn none() -> Self {
		Reply {
			messages: Vec::new(),
			exit: None,
		}
	}

	fn send(message: Value) -> Self {
		Reply {
			messages: vec![message],
			exit: None,
		}
	}

	fn send_all(messages: Vec<Value>) -> Self {
		Reply {
			messages,
			exit: None,
		}
	}

	fn end(status: ExitStatus) -> Self {
		Reply {
			messages: Vec::new(),
			exit: Some(status),
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

/// A `query.execute` whose reply is owed to the client.
#[derive(Debug)]
struct Pending {
	session: String,
	request: String,
	execution: String,
}

/// Connection state for one client. Dropping it closes every open session.
pub struct Server {
	started: Instant,
	hello_completed: bool,
	/// Features both sides support, fixed by `runtime.hello`.
	features: HashSet<&'static str>,
	sessions: Sessions,
	/// `query.execute` requests whose worker has not reported the first statement yet.
	pending: Vec<Pending>,
	/// Request ids whose reply is still owed by a session worker, with the session that owes it:
	/// the deferred `query.execute` replies and the `metadata.*` calls queued behind them.
	/// [`Server::round_trip`] waits for these; the stream loop does not, because a blocked request
	/// loop is what it exists to avoid.
	owed: HashMap<String, String>,
	/// Frames and worker reports, in arrival order.
	input: mpsc::Receiver<Input>,
	/// Handed to the input reader thread and to every session worker.
	sender: events::Sender,
	decoder: FrameDecoder,
	/// Payloads decoded from the last chunk and not handled yet.
	frames: VecDeque<Vec<u8>>,
	/// Log lines go here (stderr in production) and never include payload content.
	diagnostics: Box<dyn Write + Send>,
}

impl Default for Server {
	fn default() -> Self {
		Self::new()
	}
}

impl std::fmt::Debug for Server {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Server")
			.field("hello_completed", &self.hello_completed)
			.field("open_sessions", &self.sessions.open_count())
			.finish_non_exhaustive()
	}
}

impl Server {
	/// A server whose log lines are discarded; the integration tests and the unit tests use it.
	pub fn new() -> Self {
		Self::with_diagnostics(io::sink())
	}

	/// A server logging to `diagnostics`, which never receives payload content: it can carry SQL,
	/// paths or credentials.
	pub fn with_diagnostics(diagnostics: impl Write + Send + 'static) -> Self {
		let (sender, input) = mpsc::channel();
		let mut server = Server {
			started: Instant::now(),
			hello_completed: false,
			features: HashSet::new(),
			sessions: Sessions::new(sender.clone()),
			pending: Vec::new(),
			owed: HashMap::new(),
			input,
			sender,
			decoder: FrameDecoder::new(PRE_HELLO_FRAME_MAX_BYTES),
			frames: VecDeque::new(),
			diagnostics: Box::new(diagnostics),
		};
		server.log(format_args!(
			"{RUNTIME_BUILD} serving protocol {PROTOCOL_MAJOR}.{PROTOCOL_MINOR}"
		));
		server
	}

	/// Reads `input` on a thread of its own and feeds the queue. A blocked read would otherwise
	/// hold back every notification the session workers report in the meantime.
	pub fn read_from(&mut self, mut input: impl Read + Send + 'static) {
		let sender = self.sender.clone();
		thread::Builder::new()
			.name("nyala-input".into())
			.spawn(move || {
				let mut chunk = vec![0; READ_CHUNK_BYTES];
				loop {
					match input.read(&mut chunk) {
						Ok(0) => {
							let _ = sender.send(Input::Ended(EndOfInput::Input));
							return;
						}
						Ok(read) => {
							if sender.send(Input::Bytes(chunk[..read].to_vec())).is_err() {
								return;
							}
						}
						Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
						Err(error) => {
							let _ = sender.send(Input::Ended(EndOfInput::Read(error)));
							return;
						}
					}
				}
			})
			.expect("the input reader thread could not be started");
	}

	/// Waits for the next frame or worker report and handles it. Blocks; a frame that arrives in
	/// pieces is completed from later reads. Frame decode errors end the stream.
	///
	/// Frames are decoded one at a time and with the limit in force at that moment, so two frames
	/// that arrive in one read are still handled in order: `runtime.hello` widens the limit before
	/// the frame behind it is looked at.
	pub fn step(&mut self) -> Reply {
		loop {
			if let Some(payload) = self.frames.pop_front() {
				let reply = self.handle_payload(&payload);
				if !reply.messages.is_empty() || reply.exit.is_some() {
					return reply;
				}
				// A deferred reply leaves this frame unanswered; the loop keeps going, because the
				// buffered chunk may hold the next frame.
				continue;
			}
			if let Some(reply) = self.decode_one() {
				return reply;
			}
			// `decode_one` leaves the frame it completed on the queue; handle it now, so that a
			// frame decoded with the pre-hello limit is only ever a `runtime.hello`-shaped one.
			if !self.frames.is_empty() {
				continue;
			}
			match self.input.recv() {
				Ok(Input::Bytes(bytes)) => self.decoder.push(&bytes),
				Ok(Input::Ended(EndOfInput::Input)) => {
					if self.decoder.pending_bytes() == 0 {
						return Reply::end(ExitStatus::Clean);
					}
					self.log(format_args!(
						"input ended inside a frame ({} bytes pending)",
						self.decoder.pending_bytes()
					));
					return Reply::end(ExitStatus::StreamError);
				}
				Ok(Input::Ended(EndOfInput::Read(error))) => {
					self.log(format_args!("input read failed: {error}"));
					return Reply::end(ExitStatus::StreamError);
				}
				Ok(Input::Event(event)) => return self.handle_event(event),
				// The server holds a sender itself, so this cannot happen; ending cleanly beats
				// spinning if it ever does.
				Err(_) => return Reply::end(ExitStatus::Clean),
			}
		}
	}

	/// Queues at most one complete frame from the buffered bytes. Returns the reply that ends the
	/// stream on a framing error.
	fn decode_one(&mut self) -> Option<Reply> {
		self.decoder.set_max_frame_bytes(self.frame_max_bytes());
		match self.decoder.next_frame() {
			Ok(Some(payload)) => {
				self.frames.push_back(payload);
				None
			}
			Ok(None) => None,
			Err(error) => {
				self.log(format_args!("closing the stream: {error}"));
				Some(Reply {
					messages: vec![frame_error_reply(&error)],
					exit: Some(ExitStatus::StreamError),
				})
			}
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

	/// Dispatches one frame payload.
	pub fn handle_payload(&mut self, payload: &[u8]) -> Reply {
		match parse_message(payload) {
			Ok(Incoming::Request(request)) => self.dispatch(&request),
			// v1 defines no client-to-runtime notifications, and notifications get no response.
			Ok(Incoming::Notification) => Reply::none(),
			Err(rejected) => Reply::send(failure(rejected.id.as_deref(), &rejected.error)),
		}
	}

	/// Dispatches `payload` and waits until every reply it made the session workers owe has been
	/// written, collecting the notifications that arrive in between. The tests and an embedder that
	/// drives the server request by request use it. It does not wait for the executions to finish:
	/// `query.stateChanged` notifications that come later belong to whoever sends the next request
	/// (or to [`Server::settle`]).
	///
	/// The events the workers already reported are applied first. Their order against the request
	/// is therefore "everything reported before it": a cancel is then dispatched with the state the
	/// worker reached, not a `running` the client has already been told about.
	pub fn round_trip(&mut self, payload: &[u8]) -> Reply {
		let mut reply = Reply::none();
		self.drain(&mut reply);
		let produced = self.handle_payload(payload);
		reply.messages.extend(produced.messages);
		if reply.exit.is_none() {
			reply.exit = produced.exit;
		}
		self.drain(&mut reply);
		while !self.owed.is_empty() {
			match self.input.recv() {
				Ok(Input::Event(event)) => {
					let produced = self.handle_event(event);
					reply.messages.extend(produced.messages);
				}
				// The stream loop owns frames; they are only buffered here for `step` to handle.
				Ok(Input::Bytes(bytes)) => {
					self.decoder.push(&bytes);
					if let Some(produced) = self.decode_one() {
						reply.messages.extend(produced.messages);
						if reply.exit.is_none() {
							reply.exit = produced.exit;
						}
					}
				}
				Ok(Input::Ended(_)) | Err(_) => break,
			}
		}
		reply
	}

	/// Waits for the next worker report and applies it, together with the reports already queued.
	/// Blocks until one arrives, so a test can follow an execution's notifications one state at a
	/// time; the stream loop gets the same reports through [`Server::step`].
	pub fn wait_report(&mut self) -> Reply {
		let mut reply = Reply::none();
		loop {
			match self.input.recv() {
				Ok(Input::Event(event)) => {
					let produced = self.handle_event(event);
					reply.messages.extend(produced.messages);
					break;
				}
				// Frames are buffered for `step`; the caller asked for a report.
				Ok(Input::Bytes(bytes)) => self.decoder.push(&bytes),
				Ok(Input::Ended(_)) | Err(_) => break,
			}
		}
		self.drain(&mut reply);
		reply
	}

	/// Applies the worker reports already queued, appending what they produce. Does not block: a
	/// report that has not arrived yet is the worker's business, not this call's.
	pub fn drain(&mut self, reply: &mut Reply) {
		while let Ok(Input::Event(event)) = self.input.try_recv() {
			let produced = self.handle_event(event);
			reply.messages.extend(produced.messages);
			if reply.exit.is_none() {
				reply.exit = produced.exit;
			}
		}
	}

	/// Waits until no execution is active and no reply is owed, applying the reports that arrive
	/// in between. Tests use it to read a terminal notification; the stream loop gets the same
	/// reports through [`Server::step`] instead.
	pub fn settle(&mut self) -> Reply {
		let mut reply = Reply::none();
		self.drain(&mut reply);
		loop {
			let (active, _) = self.sessions.counters();
			if active == 0 && self.owed.is_empty() {
				return reply;
			}
			match self.input.recv() {
				Ok(Input::Event(event)) => {
					let produced = self.handle_event(event);
					reply.messages.extend(produced.messages);
				}
				// The stream loop owns frames; they are only buffered here for `step` to handle.
				Ok(Input::Bytes(bytes)) => {
					self.decoder.push(&bytes);
					if let Some(produced) = self.decode_one() {
						reply.messages.extend(produced.messages);
						if reply.exit.is_none() {
							reply.exit = produced.exit;
						}
					}
				}
				Ok(Input::Ended(_)) | Err(_) => return reply,
			}
		}
	}

	fn log(&mut self, args: std::fmt::Arguments<'_>) {
		// Losing a log line must not stop the runtime.
		let _ = writeln!(self.diagnostics, "nyala-runtime: {args}");
	}

	/// Applies one report from a session worker: the notifications it produces, and the reply of
	/// a `query.execute` it prepared.
	fn handle_event(&mut self, event: Event) -> Reply {
		match event {
			Event::Prepared {
				session,
				execution,
				error,
			} => {
				let Some(pending) = self.take_pending(&execution) else {
					return Reply::none();
				};
				let Some(prepared) = self.sessions.prepared(&session, &execution, error) else {
					return Reply::none();
				};
				self.owed.remove(&pending.request);
				let mut messages = Vec::with_capacity(prepared.notifications.len() + 1);
				messages.push(match prepared.result {
					Ok(result) => success(&pending.request, result),
					Err(error) => failure(Some(&pending.request), &error),
				});
				messages.extend(prepared.notifications);
				Reply::send_all(messages)
			}
			Event::Metadata {
				request, result, ..
			} => {
				self.owed.remove(&request);
				// The request id is echoed back as the worker received it, so a metadata call
				// queued behind a running statement is answered when it finally runs.
				Reply::send(match result {
					Ok(result) => success(&request, result),
					Err(error) => failure(Some(&request), &error),
				})
			}
			Event::WorkerGone { session } => {
				let mut messages = self.sessions.worker_gone(&session);
				// A request whose worker died before preparing is still owed an answer.
				let mut index = 0;
				while index < self.pending.len() {
					if self.pending[index].session != session {
						index += 1;
						continue;
					}
					let pending = self.pending.remove(index);
					let error = RpcError::with_detail(
						ErrorKind::Internal,
						"the session worker stopped before the statement ran",
					);
					messages.push(failure(Some(&pending.request), &error));
				}
				// A metadata call queued on the worker dies with it.
				self.owed.retain(|_, owner| owner != &session);
				Reply::send_all(messages)
			}
			Event::Started { .. } | Event::Finished { .. } => {
				Reply::send_all(self.sessions.apply_event(event))
			}
		}
	}

	fn take_pending(&mut self, execution: &str) -> Option<Pending> {
		let index = self
			.pending
			.iter()
			.position(|pending| pending.execution == execution)?;
		Some(self.pending.remove(index))
	}

	fn dispatch(&mut self, request: &Request) -> Reply {
		// `query.cancel` answers with its reply first, then with the notification it produced.
		if request.method == "query.cancel" && self.ready_for("query.cancel") {
			return match self.sessions.cancel(&request.params) {
				Ok(outcome) => {
					let mut messages = Vec::with_capacity(outcome.notifications.len() + 1);
					messages.push(success(&request.id, outcome.reply));
					messages.extend(outcome.notifications);
					Reply::send_all(messages)
				}
				Err(error) => Reply::send(failure(Some(&request.id), &error)),
			};
		}
		// `query.execute` answers once its worker has prepared the statement; see the module
		// comment.
		if request.method == "query.execute" && self.ready_for("query.execute") {
			return match self.sessions.begin_execution(&request.params) {
				Ok(started) => {
					self.owed
						.insert(request.id.clone(), started.session.clone());
					self.pending.push(Pending {
						session: started.session,
						request: request.id.clone(),
						execution: started.execution,
					});
					Reply::none()
				}
				Err(error) => Reply::send(failure(Some(&request.id), &error)),
			};
		}
		// `metadata.*` runs on the session worker too, so that a call queued behind a running
		// statement cannot hold the request loop and keep `query.cancel` from reaching it. Its
		// reply follows as `Event::Metadata`.
		if matches!(
			request.method.as_str(),
			"metadata.listObjects" | "metadata.describe"
		) && self.ready_for(&request.method)
		{
			let call = if request.method == "metadata.listObjects" {
				MetadataCall::ListObjects
			} else {
				MetadataCall::Describe
			};
			return match self.sessions.metadata(&request.params, call, &request.id) {
				Ok(session) => {
					self.owed.insert(request.id.clone(), session);
					Reply::none()
				}
				Err(error) => Reply::send(failure(Some(&request.id), &error)),
			};
		}

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
			"connection.close" => {
				// A close that stopped an execution owes its `cancel_requested` notification too, and
				// sends the reply first.
				return match self.sessions.close(&request.params) {
					Ok((closed, notifications)) => {
						let mut messages = Vec::with_capacity(notifications.len() + 1);
						messages.push(success(&request.id, closed));
						messages.extend(notifications);
						Reply::send_all(messages)
					}
					Err(error) => Reply::send(failure(Some(&request.id), &error)),
				};
			}
			"connection.listSessions" => self.sessions.list(&request.params),
			"metadata.listObjects" | "metadata.describe" => Err(RpcError::with_detail(
				ErrorKind::Internal,
				"metadata is dispatched on the session worker",
			)),
			"query.getState" => self.sessions.get_state(&request.params),
			"result.fetchPage" => self.sessions.fetch_page(&request.params),
			"result.release" => self.sessions.release(&request.params),
			// `query.cancel` and `query.execute` were answered above; `required_feature` names only
			// methods with a handler, and this arm keeps a future mismatch from panicking.
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

	/// Whether the method is in the catalog, the handshake is done and the client negotiated the
	/// feature it needs — the three gates `dispatch` applies before a handler runs.
	fn ready_for(&self, method: &str) -> bool {
		V1_REQUEST_METHODS.contains(&method)
			&& self.hello_completed
			&& required_feature(method).is_some_and(|feature| self.features.contains(&feature))
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
				messages: vec![failure(Some(&request.id), &error)],
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
	input: impl Read + Send + 'static,
	mut output: impl Write,
	diagnostics: impl Write + Send + 'static,
) -> ExitStatus {
	let mut server = Server::with_diagnostics(diagnostics);
	server.read_from(input);
	loop {
		let reply = server.step();
		for message in &reply.messages {
			if let Err(error) = write_message(&mut output, message) {
				// The diagnostics stream is owned by the server; a failed stdout ends the stream
				// either way.
				let _ = error;
				return ExitStatus::StreamError;
			}
		}
		if let Some(exit) = reply.exit {
			return exit;
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
	use crate::sqlite::test_files::{text, TempDir};

	fn call(server: &mut Server, method: &str, params: Value) -> Reply {
		let request = json!({"jsonrpc": "2.0", "id": "rq_1", "method": method, "params": params});
		server.handle_payload(request.to_string().as_bytes())
	}

	/// Sends a request and waits for every reply its workers owe, keeping the notifications that
	/// arrive in between. `round_trip` answers for the requests a worker completes.
	fn answered(server: &mut Server, request: Value) -> Reply {
		server.round_trip(request.to_string().as_bytes())
	}

	fn hello_params(major: i64, minor: i64) -> Value {
		json!({
			"protocolMajor": major,
			"protocolMinor": minor,
			"clientBuild": "0.0.1-dev.0",
			"supportedFeatures": ["sqlite"],
		})
	}

	fn reply_to<'a>(reply: &'a Reply, id: &str) -> &'a Value {
		reply
			.messages
			.iter()
			.find(|message| message["id"] == id)
			.unwrap_or_else(|| panic!("no reply for {id}: {:?}", reply.messages))
	}

	fn notifications(reply: &Reply) -> Vec<&Value> {
		reply
			.messages
			.iter()
			.filter(|message| message.get("id").is_none())
			.collect()
	}

	fn states(reply: &Reply) -> Vec<&str> {
		notifications(reply)
			.iter()
			.map(|notification| {
				notification["params"]["state"]
					.as_str()
					.expect("a state notification")
			})
			.collect()
	}

	fn error_kind(reply: &Reply) -> &str {
		reply_to(reply, "rq_1")["error"]["data"]["kind"]
			.as_str()
			.expect("reply must be a failure")
	}

	#[test]
	fn hello_negotiates_version_features_and_limits() {
		let mut server = Server::new();
		let reply = call(&mut server, "runtime.hello", hello_params(1, 0));
		assert_eq!(reply.exit, None);
		let result = &reply_to(&reply, "rq_1")["result"];
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
		assert!(reply_to(
			&call(&mut server, "runtime.hello", hello_params(1, 0)),
			"rq_1"
		)
		.get("result")
		.is_some());
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
			assert_eq!(reply_to(&reply, "rq_1")["id"], "rq_1");
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
		let result = &reply_to(&reply, "rq_1")["result"];
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
		let result = &reply_to(&reply, "rq_1")["result"];
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

	/// The server past the handshake, with every feature this build serves negotiated.
	fn negotiated() -> Server {
		let mut server = Server::new();
		call(&mut server, "runtime.hello", hello_with(&FEATURES));
		server
	}

	/// Opens a read-only session on `path` and returns its `(sessionId, sessionGeneration)`.
	fn open(server: &mut Server, path: &std::path::Path) -> Value {
		let reply = call(
			server,
			"connection.open",
			json!({"driver": "sqlite", "path": text(path), "readOnly": true}),
		);
		reply_to(&reply, "rq_1")["result"].clone()
	}

	/// A `query.execute` request for `sql` on `session`.
	fn execute_request(id: &str, session: &Value, sql: &str, timeout_ms: u64) -> Value {
		json!({
			"jsonrpc": "2.0",
			"id": id,
			"method": "query.execute",
			"params": {
				"sessionId": session["sessionId"],
				"sessionGeneration": session["sessionGeneration"],
				"sql": sql,
				"mode": "statement",
				"timeoutMs": timeout_ms,
				"maxInitialRows": 10,
			},
		})
	}

	/// A statement that steps until something stops it.
	const FOREVER: &str =
		"WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n";

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
			let message = reply_to(&reply, "rq_1");
			let outcome = message["error"]["data"]["kind"]
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
			let message = reply_to(&reply, "rq_1");
			let outcome = message["error"]["data"]["kind"]
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
				let message = reply_to(&reply, "rq_1");
				let outcome = message["error"]["data"]["kind"]
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
		let dir = TempDir::new("server-health");
		let path = dir.database("health.sqlite");

		let mut server = negotiated();
		let open = |server: &mut Server| {
			call(
				server,
				"connection.open",
				json!({"driver": "sqlite", "path": text(&path), "readOnly": true}),
			)
		};
		let first = open(&mut server);
		open(&mut server);
		let health = call(&mut server, "runtime.health", json!({}));
		assert_eq!(reply_to(&health, "rq_1")["result"]["activeSessions"], 2);

		let session = &reply_to(&first, "rq_1")["result"];
		call(
			&mut server,
			"connection.close",
			json!({"sessionId": session["sessionId"], "sessionGeneration": session["sessionGeneration"]}),
		);
		let health = call(&mut server, "runtime.health", json!({}));
		assert_eq!(reply_to(&health, "rq_1")["result"]["activeSessions"], 1);
	}

	#[test]
	fn notifications_get_no_reply() {
		let mut server = Server::new();
		let notification = json!({"jsonrpc": "2.0", "method": "query.stateChanged", "params": {}});
		assert_eq!(
			server.handle_payload(notification.to_string().as_bytes()),
			Reply {
				messages: Vec::new(),
				exit: None,
			}
		);
	}

	#[test]
	fn unreadable_payloads_reply_with_a_null_id() {
		let mut server = Server::new();
		let reply = server.handle_payload(b"{\"jsonrpc\":\"2.0\",");
		let message = &reply.messages[0];
		assert_eq!(message["error"]["data"]["kind"], "PARSE_ERROR");
		assert_eq!(message["id"], Value::Null);
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

	#[test]
	fn a_query_is_answered_queued_and_then_reported_by_its_worker() {
		let dir = TempDir::new("server-query");
		let path = dir.database("db.sqlite");
		let mut server = negotiated();
		let session = open(&mut server, &path);

		// The reply waits for the worker's prepared report, so the first round trip carries it.
		let reply = answered(
			&mut server,
			execute_request(
				"rq_2",
				&session,
				"SELECT id FROM customers ORDER BY id",
				30_000,
			),
		);
		let queued = &reply_to(&reply, "rq_2")["result"];
		assert_eq!(queued["state"], "queued");
		assert_eq!(queued["sequence"], 1);
		let execution = queued["executionId"].as_str().unwrap().to_owned();

		// The notifications follow, one state each, until the execution ends. A fast statement may
		// report `running` (or even `completed`) before `answered` returns, so both replies are read.
		let settled = server.settle();
		assert_eq!(settled.exit, None);
		let reported: Vec<&Value> = notifications(&reply)
			.into_iter()
			.chain(notifications(&settled))
			.collect();
		let states: Vec<&str> = reported
			.iter()
			.map(|notification| notification["params"]["state"].as_str().unwrap())
			.collect();
		assert_eq!(states, ["running", "completed"]);
		let sequences: Vec<u64> = reported
			.iter()
			.map(|notification| notification["params"]["sequence"].as_u64().unwrap())
			.collect();
		assert_eq!(sequences, [2, 3]);
		let last = reported[1]["params"].clone();
		assert_eq!(last["executionId"], execution.as_str());
		let result_id = last["resultIds"][0].as_str().unwrap().to_owned();

		let page = call(
			&mut server,
			"result.fetchPage",
			json!({"resultId": result_id, "limit": 10}),
		);
		assert_eq!(
			reply_to(&page, "rq_1")["result"]["rows"],
			json!([[{"type": "int64", "text": "1"}], [{"type": "int64", "text": "2"}]])
		);
		assert!(notifications(&page).is_empty(), "no execution was started");
	}

	#[test]
	fn a_cancel_reaches_a_running_statement_through_the_request_loop() {
		let dir = TempDir::new("server-cancel");
		let path = dir.database("db.sqlite");
		let mut server = negotiated();
		let session = open(&mut server, &path);
		let reply = answered(
			&mut server,
			execute_request("rq_2", &session, FOREVER, 600_000),
		);
		let execution = reply_to(&reply, "rq_2")["result"]["executionId"]
			.as_str()
			.unwrap()
			.to_owned();
		// The worker reports `running` while the statement steps; the cancel can only arrive after
		// that, because the request loop is free while the statement runs.
		let running = server.wait_report();
		assert_eq!(states(&running), ["running"]);

		let cancel = answered(
			&mut server,
			json!({
				"jsonrpc": "2.0",
				"id": "rq_3",
				"method": "query.cancel",
				"params": {"executionId": execution},
			}),
		);
		assert_eq!(
			reply_to(&cancel, "rq_3")["result"],
			json!({"accepted": true, "state": "cancel_requested"})
		);
		// The interrupt can stop the statement before the reply is drained, so the terminal
		// notification is read from either reply.
		let settled = server.settle();
		let reported: Vec<&str> = states(&cancel)
			.into_iter()
			.chain(states(&settled))
			.collect();
		assert_eq!(
			reported,
			["cancel_requested", "cancelled"],
			"the statement stopped at the interrupt, not at its deadline"
		);
		let state = call(
			&mut server,
			"query.getState",
			json!({"executionId": execution}),
		);
		assert_eq!(reply_to(&state, "rq_1")["result"]["state"], "cancelled");
	}

	#[test]
	fn a_statement_that_does_not_compile_is_answered_with_the_error() {
		let dir = TempDir::new("server-syntax");
		let path = dir.database("db.sqlite");
		let mut server = negotiated();
		let session = open(&mut server, &path);
		let reply = answered(
			&mut server,
			execute_request("rq_2", &session, "SELECT FROM WHERE", 30_000),
		);
		let error = &reply_to(&reply, "rq_2")["error"]["data"];
		assert_eq!(error["kind"], "SQL_SYNTAX");
		assert_eq!(error["sqlState"], "1");
		assert_eq!(error["sessionId"], session["sessionId"]);
		assert!(
			error["executionId"].as_str().is_some(),
			"the error names the execution it was prepared for"
		);
		// Nothing runs, so the execution reports no state of its own.
		assert!(notifications(&reply).is_empty());

		// The failed execution still answers `query.getState`, so a client can follow it up.
		let state = call(
			&mut server,
			"query.getState",
			json!({"executionId": error["executionId"]}),
		);
		assert_eq!(reply_to(&state, "rq_1")["result"]["state"], "failed");
	}

	#[test]
	fn a_metadata_call_queued_behind_a_running_statement_is_answered_after_it() {
		let dir = TempDir::new("server-metadata");
		let path = dir.database("db.sqlite");
		let mut server = negotiated();
		let session = open(&mut server, &path);
		let reply = answered(
			&mut server,
			execute_request("rq_2", &session, FOREVER, 600_000),
		);
		let execution = reply_to(&reply, "rq_2")["result"]["executionId"]
			.as_str()
			.unwrap()
			.to_owned();
		server.wait_report();

		// The metadata call waits behind the statement on the session's one connection. The request
		// loop stays free while it waits, which is what lets the cancel reach the statement at all.
		let cancel = answered(
			&mut server,
			json!({
				"jsonrpc": "2.0",
				"id": "rq_3",
				"method": "query.cancel",
				"params": {"executionId": execution},
			}),
		);
		assert_eq!(
			reply_to(&cancel, "rq_3")["result"]["state"],
			"cancel_requested"
		);
		let settled = server.settle();
		let reported: Vec<&str> = states(&cancel)
			.into_iter()
			.chain(states(&settled))
			.collect();
		assert_eq!(reported, ["cancel_requested", "cancelled"]);

		let metadata = answered(
			&mut server,
			json!({
				"jsonrpc": "2.0",
				"id": "rq_4",
				"method": "metadata.listObjects",
				"params": {
					"sessionId": session["sessionId"],
					"sessionGeneration": session["sessionGeneration"],
					"limit": 100,
				},
			}),
		);
		let objects = reply_to(&metadata, "rq_4")["result"]["objects"]
			.as_array()
			.unwrap_or_else(|| panic!("metadata reply: {:?}", metadata.messages));
		assert!(
			objects.iter().any(|object| object["name"] == "customers"),
			"{:?}",
			metadata.messages
		);
	}
}
