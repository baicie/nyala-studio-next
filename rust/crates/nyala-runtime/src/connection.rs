/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! The `connection.*` methods (`nyala/rpc/README.md` §4, N-104) and the registry that owns the
//! sessions they create.
//!
//! `connection.open` gives every session a new `sessionId` and `sessionGeneration`, and a request
//! that names a session must carry both. A pair this process did not issue is `INVALID_SESSION`,
//! so a client that confuses two sessions, or kept ids from an earlier runtime process, never
//! reaches the wrong database. The allocation and retention rules are recorded in
//! `docs/adr/0002-rust-runtime-workspace.md`.
//!
//! Since N-108 every session owns a [`Worker`] thread: rusqlite's `Connection` is `Send` but not
//! `Sync`, so the connection moves to that thread and the registry keeps only what the request
//! loop may touch — the executions with their states and result handles. A `metadata.*` call runs
//! on the worker and is answered when the worker returns it; `query.execute` is answered when the
//! worker reports that the first statement was prepared (`crate::query`).

use std::collections::hash_map::RandomState;
use std::collections::VecDeque;
use std::hash::{BuildHasher, Hasher};
use std::process;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

use crate::error::{ErrorKind, RpcError};
use crate::events::{self, Event};
use crate::protocol::{is_valid_id, MAX_RESULT_TTL_SECS};
use crate::query::{self, CancelOutcome, Executions};
use crate::sqlite::{self, Database};
use crate::worker::{MetadataCall, Worker};

/// Sessions that may be open at once. `connection.open` beyond this fails with `RESOURCE_LIMIT`.
pub const MAX_OPEN_SESSIONS: usize = 32;

/// Closed sessions that stay listed and can be closed again. When one more closes, the session
/// that closed first is forgotten and its id becomes unknown.
pub const MAX_CLOSED_SESSIONS: usize = 32;

/// The only driver in protocol v1.
const DRIVER: &str = "sqlite";

/// Result handles expire after `maxResultTtlSecs` (`nyala/rpc/README.md` §7).
fn result_ttl() -> Duration {
	Duration::from_secs(u64::from(MAX_RESULT_TTL_SECS))
}

/// The `sessionId` and `sessionGeneration` a session was issued.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionKey {
	id: String,
	generation: u64,
}

#[derive(Debug)]
struct OpenSession {
	key: SessionKey,
	read_only: bool,
	/// Created with the session so its ids start with the session id.
	executions: Executions,
	/// The thread that owns the connection.
	worker: Worker,
}

/// A session that was closed while one of its executions was still stopping. Its worker is joined
/// and its connection closed, but its registry stays so that the terminal `query.stateChanged`
/// notification can be written and `query.getState` keeps answering (`README.md` §5: `cancelled`
/// follows `cancel_requested`).
#[derive(Debug)]
struct ClosingSession {
	key: SessionKey,
	executions: Executions,
}

/// The sessions of one client connection. Dropping the registry closes every open session.
#[derive(Debug)]
pub struct Sessions {
	/// `s_` followed by 16 hex digits that differ between runtime processes.
	id_prefix: String,
	/// Sessions opened so far. The n-th session gets the id `<id_prefix><n>` and generation n.
	opened: u64,
	open: Vec<OpenSession>,
	/// Sessions whose close interrupted an execution; dropped once it reports its terminal state.
	closing: Vec<ClosingSession>,
	/// Oldest first.
	closed: VecDeque<SessionKey>,
	/// Where workers report what they ran; the request loop holds the receiving end.
	events: events::Sender,
}

/// The answer to a `query.execute` whose worker has prepared the job.
pub(crate) struct PreparedReply {
	/// The `result` for the deferred success reply, or the error for the failure reply.
	pub(crate) result: Result<Value, RpcError>,
	/// Notifications that are due before the reply is written (a cancel that arrived first).
	pub(crate) notifications: Vec<Value>,
}

/// An execution whose job reached its session worker.
pub struct StartedExecution {
	/// The session that owns the execution.
	pub session: String,
	/// The execution id the reply will name.
	pub execution: String,
}

impl Sessions {
	pub(crate) fn new(events: events::Sender) -> Self {
		Sessions {
			id_prefix: process_id_prefix(),
			opened: 0,
			open: Vec::new(),
			closing: Vec::new(),
			closed: VecDeque::new(),
			events,
		}
	}

	/// Reported as `activeSessions` by `runtime.health`.
	pub fn open_count(&self) -> usize {
		self.open.len()
	}

	/// `connection.open`.
	pub fn open(&mut self, params: &Map<String, Value>) -> Result<Value, RpcError> {
		let target = Target::parse(
			params,
			"connection.open",
			&["driver", "path", "readOnly", "profileId"],
		)?;
		// No v1 result carries profileId back, so it is checked and not kept.
		if params
			.get("profileId")
			.is_some_and(|id| id.as_str().is_none_or(str::is_empty))
		{
			return Err(invalid("profileId must be a non-empty string"));
		}
		if self.open.len() >= MAX_OPEN_SESSIONS {
			return Err(RpcError::with_detail(
				ErrorKind::ResourceLimit,
				format!("at most {MAX_OPEN_SESSIONS} sessions can be open"),
			));
		}

		let database = Database::open(target.path, target.read_only)?;
		self.opened += 1;
		let key = SessionKey {
			id: format!("{}{}", self.id_prefix, self.opened),
			generation: self.opened,
		};
		let worker = Worker::spawn(&key.id, database, self.events.clone())?;
		let result = json!({
			"sessionId": key.id,
			"sessionGeneration": key.generation,
			"capabilities": {
				"driver": DRIVER,
				"readOnly": target.read_only,
				// A timeout ends the running statement from inside SQLite's VM, and `query.cancel`
				// interrupts it through `sqlite3_interrupt`; both are cooperative, because SQLite
				// finishes its own VM step before it gives up. See `query.rs`.
				"cancel": "cooperative",
				// v1 has no transaction.* methods.
				"supportsTransactions": false,
				// N-105 added metadata.*.
				"supportsMetadata": true,
			},
		});
		let executions = Executions::new(&key.id);
		self.open.push(OpenSession {
			key,
			read_only: target.read_only,
			executions,
			worker,
		});
		Ok(result)
	}

	/// `connection.close`. Closing a closed session again returns the same result.
	///
	/// A close that interrupted an execution also returns the `cancel_requested` notifications the
	/// registry owes, so the reply and the notification leave the request loop together.
	pub(crate) fn close(
		&mut self,
		params: &Map<String, Value>,
	) -> Result<(Value, Vec<Value>), RpcError> {
		let (id, generation) = session_key(params, "connection.close")?;
		let closed = json!({"closed": true});

		if let Some(index) = self.open.iter().position(|session| session.key.id == id) {
			check_generation(&self.open[index].key, generation)?;
			let session = &mut self.open[index];
			// Ends whatever runs on the connection before it closes under it; a running execution
			// is reported `cancel_requested` first, then `cancelled` when the statement stops.
			let (notifications, interrupt) = session.executions.request_stop();
			if interrupt {
				session.worker.interrupt();
			}
			let worker = session.worker.shutdown();
			if let Err(error) = worker {
				// The connection is still open, so the session stays open and usable: its later
				// executions get their own stop flags, and only the cancelled ones report
				// `cancelled`.
				return Err(error.for_session(id));
			}
			let OpenSession {
				key, executions, ..
			} = self.open.remove(index);
			// The registry keeps answering `query.getState` for what it ran, exactly as a closed
			// session stays listed. A close that stopped an execution has notifications in flight
			// that only this registry can turn into `cancelled`.
			self.closing.push(ClosingSession {
				key: key.clone(),
				executions,
			});
			if self.closing.len() > MAX_CLOSED_SESSIONS {
				self.closing.remove(0);
			}
			self.closed.push_back(key);
			if self.closed.len() > MAX_CLOSED_SESSIONS {
				self.closed.pop_front();
			}
			return Ok((closed, notifications));
		}

		match self.closed.iter().find(|key| key.id == id) {
			Some(key) => check_generation(key, generation).map(|()| (closed, Vec::new())),
			None => Err(
				RpcError::with_detail(ErrorKind::InvalidSession, "sessionId is unknown")
					.for_session(id),
			),
		}
	}

	/// The open session `(sessionId, sessionGeneration)` names. Every method that works on a
	/// session's database goes through here, so ids from another process, another session or a
	/// closed session never reach a connection.
	fn open_session(&self, params: &Map<String, Value>) -> Result<&OpenSession, RpcError> {
		let (id, generation) = session_key_from(params)?;
		let session = self
			.open
			.iter()
			.find(|session| session.key.id == id)
			.ok_or_else(|| {
				RpcError::with_detail(
					ErrorKind::InvalidSession,
					"sessionId is unknown, closed, or from another runtime process",
				)
				.for_session(id)
			})?;
		check_generation(&session.key, generation)?;
		Ok(session)
	}

	/// `metadata.listObjects` and `metadata.describe`: the call is queued on the session worker and
	/// its reply follows as [`Event::Metadata`] (`server.rs`). Returns the session that owes the
	/// answer.
	pub(crate) fn metadata(
		&self,
		params: &Map<String, Value>,
		call: MetadataCall,
		request: &str,
	) -> Result<String, RpcError> {
		let session = self.open_session(params)?;
		session
			.worker
			.metadata(request.to_owned(), call, params.clone())
			.map_err(|error| error.for_session(session.key.id.clone()))?;
		Ok(session.key.id.clone())
	}

	/// `query.execute`: checks the session, validates the parameters and hands the job to the
	/// worker. The reply follows with [`Sessions::prepared`].
	pub fn begin_execution(
		&mut self,
		params: &Map<String, Value>,
	) -> Result<StartedExecution, RpcError> {
		let (id, generation) = session_key_from(params)?;
		let index = self
			.open
			.iter()
			.position(|session| session.key.id == id)
			.ok_or_else(|| {
				RpcError::with_detail(
					ErrorKind::InvalidSession,
					"sessionId is unknown, closed, or from another runtime process",
				)
				.for_session(id)
			})?;
		check_generation(&self.open[index].key, generation)?;
		let session = &mut self.open[index];
		let job = session
			.executions
			.begin(params, session.read_only)
			.map_err(|error| error.for_session(id))?;
		let execution = job.execution().to_owned();
		if let Err(error) = session.worker.execute(job) {
			// The worker is gone; the execution provably ran nothing.
			session.executions.worker_gone();
			return Err(error.for_session(id));
		}
		Ok(StartedExecution {
			session: id.to_owned(),
			execution,
		})
	}

	/// The open session that `session` names. Worker reports carry the session id itself, not an
	/// execution or result id, so they cannot go through [`Sessions::owner`].
	fn session_index(&self, session: &str) -> Option<usize> {
		self.open.iter().position(|open| open.key.id == session)
	}

	/// The reply to the `query.execute` of `execution`, once its worker reports the outcome of
	/// preparing the first statement.
	pub(crate) fn prepared(
		&mut self,
		session: &str,
		execution: &str,
		error: Option<RpcError>,
	) -> Option<PreparedReply> {
		let index = self.session_index(session)?;
		let registry = &mut self.open[index].executions;
		match error {
			Some(error) => {
				// The reply names the execution and the session, so the client can follow it with
				// `query.getState` even though the statement never ran.
				let error = error.for_session(session).for_execution(execution);
				// The execution is retained as `failed`, so `query.getState` answers for it exactly
				// as for one that failed while running (`conformance.ndjson` rq_009).
				registry.fail_prepared(execution, &error);
				Some(PreparedReply {
					result: Err(error),
					notifications: Vec::new(),
				})
			}
			None => {
				let result = registry.queued(execution)?;
				Some(PreparedReply {
					notifications: registry.mark_replied(execution),
					result: Ok(result),
				})
			}
		}
	}

	// Execution and result ids start with the id of the session that issued them, so the methods
	// below route on that prefix instead of trying every session: an error from the owning session
	// must reach the client unchanged, not be replaced by a "not found" of the next one.

	/// Index of the open session that issued `id`, if any.
	///
	/// Execution and result ids are `<sessionId>e<n>` and `<sessionId>r<n>`. Session ids end in a
	/// decimal counter, so the character after a real session id is a marker, never a digit: the
	/// id of session 1 (`s_…1`) is a textual prefix of the id of session 11 (`s_…11`), but the
	/// character after it in `s_…11e1` is `1`, so the prefix alone must not claim the id.
	fn owner(&self, id: &str) -> Option<usize> {
		self.open.iter().position(|session| {
			id.strip_prefix(session.key.id.as_str())
				.is_some_and(|rest| {
					// `<marker><digits>`, marker `e` for an execution or `r` for a result.
					let Some((&marker, digits)) = rest.as_bytes().split_first() else {
						return false;
					};
					matches!(marker, b'e' | b'r')
						&& !digits.is_empty()
						&& digits.iter().all(u8::is_ascii_digit)
				})
		})
	}

	fn id_param<'a>(
		params: &'a Map<String, Value>,
		field: &str,
		method: &str,
	) -> Result<&'a str, RpcError> {
		params
			.get(field)
			.and_then(Value::as_str)
			.filter(|id| is_valid_id(id))
			.ok_or_else(|| invalid(format!("{field} of {method} must be a contract id")))
	}

	/// `query.getState`. A session that was closed while an execution stopped still answers, so the
	/// client can read the terminal state the notification reported (`README.md` §4, "补偿读").
	pub fn get_state(&self, params: &Map<String, Value>) -> Result<Value, RpcError> {
		let id = Self::id_param(params, "executionId", "query.getState")?;
		if let Some(index) = self.owner(id) {
			return self.open[index].executions.get_state(params);
		}
		if let Some(closing) = self
			.closing
			.iter()
			.find(|session| id.starts_with(&session.key.id))
		{
			// The registry itself checks that the id is one it issued.
			return closing.executions.get_state(params);
		}
		Err(invalid("executionId is unknown"))
	}

	/// `query.cancel`. `interrupt` tells the caller to stop the statement on the worker.
	pub(crate) fn cancel(
		&mut self,
		params: &Map<String, Value>,
	) -> Result<CancelOutcome, RpcError> {
		let id = Self::id_param(params, "executionId", "query.cancel")?;
		match self.owner(id) {
			Some(index) => {
				let outcome = self.open[index].executions.cancel(params)?;
				if outcome.interrupt {
					self.open[index].worker.interrupt();
				}
				Ok(outcome)
			}
			None => Err(invalid("executionId is unknown")),
		}
	}

	/// `result.fetchPage`.
	pub fn fetch_page(&mut self, params: &Map<String, Value>) -> Result<Value, RpcError> {
		let id = Self::id_param(params, "resultId", "result.fetchPage")?;
		match self.owner(id) {
			Some(index) => self.open[index].executions.fetch_page(params),
			None => Err(query::expired()),
		}
	}

	/// `result.release`. An id of a closed session counts as released: its handles are gone.
	pub fn release(&mut self, params: &Map<String, Value>) -> Result<Value, RpcError> {
		let id = Self::id_param(params, "resultId", "result.release")?;
		match self.owner(id) {
			Some(index) => self.open[index].executions.release(params),
			None => Ok(json!({ "released": true })),
		}
	}

	/// Counters for `runtime.health`, summed over the open sessions.
	pub fn counters(&self) -> (usize, usize) {
		self.open
			.iter()
			.fold((0, 0), |(executions, results), session| {
				(
					executions + session.executions.active(),
					results + session.executions.pending_results(),
				)
			})
	}

	/// `connection.listSessions`: open and retained closed sessions, in the order they opened.
	pub fn list(&self, params: &Map<String, Value>) -> Result<Value, RpcError> {
		if !params.is_empty() {
			return Err(invalid("connection.listSessions takes no parameters"));
		}
		let mut sessions: Vec<(&SessionKey, &str)> = self
			.open
			.iter()
			.map(|session| (&session.key, "open"))
			.chain(self.closed.iter().map(|key| (key, "closed")))
			.collect();
		sessions.sort_by_key(|(key, _)| key.generation);
		let sessions: Vec<Value> = sessions
			.into_iter()
			.map(|(key, state)| {
				json!({
					"sessionId": key.id,
					"sessionGeneration": key.generation,
					"driver": DRIVER,
					"state": state,
				})
			})
			.collect();
		Ok(json!({ "sessions": sessions }))
	}

	/// Applies one report from a session worker and returns the notifications to write. A report
	/// naming a session this process does not know is dropped: its executions went with it.
	pub(crate) fn apply_event(&mut self, event: Event) -> Vec<Value> {
		if let Some(index) = self.session_index(event.session()) {
			let registry = &mut self.open[index].executions;
			return match event {
				// Answered by `Sessions::prepared`; the request loop holds the pending request.
				Event::Prepared { .. } => Vec::new(),
				// Answered by `server::Server::handle_event`; the reply names no session state.
				Event::Metadata { .. } => Vec::new(),
				Event::Started { execution, .. } => registry.started(&execution),
				Event::Finished {
					execution, outcome, ..
				} => registry.finished(&execution, outcome, result_ttl()),
				Event::WorkerGone { .. } => registry.worker_gone(),
			};
		}

		// A session that closed while its execution was stopping: the terminal notification is
		// still owed to the client, and its registry stays until nothing is active in it.
		let Some(index) = self
			.closing
			.iter()
			.position(|session| session.key.id == event.session())
		else {
			return Vec::new();
		};
		let registry = &mut self.closing[index].executions;
		let notifications = match event {
			Event::Finished {
				execution, outcome, ..
			} => registry.finished(&execution, outcome, result_ttl()),
			Event::Started { execution, .. } => registry.started(&execution),
			Event::WorkerGone { .. } => registry.worker_gone(),
			Event::Prepared { .. } | Event::Metadata { .. } => Vec::new(),
		};
		// The registry stays so that `query.getState` answers for the executions it holds; it is
		// forgotten like a closed session once a later session takes its place.
		if self.closing.len() > MAX_CLOSED_SESSIONS {
			self.closing.remove(0);
		}
		notifications
	}

	/// The worker of `session` panicked: its open executions end as `unknown` or `cancelled`, and
	/// the session itself stays listed so `query.getState` keeps answering for them.
	pub(crate) fn worker_gone(&mut self, session: &str) -> Vec<Value> {
		match self.session_index(session) {
			Some(index) => self.open[index].executions.worker_gone(),
			None => Vec::new(),
		}
	}
}

impl Drop for Sessions {
	fn drop(&mut self) {
		// The request loop is going away; end what runs on every connection and close it. The
		// workers are joined so that the process leaves no thread behind.
		for session in &mut self.open {
			let (_, interrupt) = session.executions.request_stop();
			if interrupt {
				session.worker.interrupt();
			}
		}
		for session in &mut self.open {
			session.worker.stop();
		}
	}
}

/// `connection.test`: checks and opens the file exactly like `connection.open`, then closes it
/// without creating a session. A file that cannot be opened gets the same error as
/// `connection.open`, so a result always carries `ok: true`.
pub fn test(params: &Map<String, Value>) -> Result<Value, RpcError> {
	let started = Instant::now();
	let target = Target::parse(params, "connection.test", &["driver", "path", "readOnly"])?;
	let database = Database::open(target.path, target.read_only)?;
	database.close().map_err(|(_, error)| error)?;
	let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
	Ok(json!({
		"ok": true,
		"serverVersion": sqlite::library_version(),
		"elapsedMs": elapsed_ms,
	}))
}

/// `driver`, `path` and `readOnly`, shared by `connection.test` and `connection.open`.
struct Target<'a> {
	path: &'a str,
	read_only: bool,
}

impl<'a> Target<'a> {
	fn parse(
		params: &'a Map<String, Value>,
		method: &str,
		known: &[&str],
	) -> Result<Self, RpcError> {
		if params.keys().any(|key| !known.contains(&key.as_str())) {
			return Err(invalid(format!("unexpected {method} parameter")));
		}
		if params.get("driver").and_then(Value::as_str) != Some(DRIVER) {
			return Err(invalid("driver must be \"sqlite\""));
		}
		let path = params
			.get("path")
			.and_then(Value::as_str)
			.filter(|path| !path.is_empty())
			.ok_or_else(|| invalid("path must be a non-empty string"))?;
		let read_only = params
			.get("readOnly")
			.and_then(Value::as_bool)
			.ok_or_else(|| invalid("readOnly must be a boolean"))?;
		Ok(Target { path, read_only })
	}
}

/// Checks `sessionId` and `sessionGeneration` against the method schema, for methods whose only
/// parameters are the session key.
fn session_key<'a>(
	params: &'a Map<String, Value>,
	method: &str,
) -> Result<(&'a str, u64), RpcError> {
	if params
		.keys()
		.any(|key| key != "sessionId" && key != "sessionGeneration")
	{
		return Err(invalid(format!("unexpected {method} parameter")));
	}
	session_key_from(params)
}

/// Reads and checks the session key of a method that has more parameters than the key; the
/// method's own parser rejects unknown parameters.
fn session_key_from(params: &Map<String, Value>) -> Result<(&str, u64), RpcError> {
	let id = params
		.get("sessionId")
		.and_then(Value::as_str)
		.filter(|id| is_valid_id(id))
		.ok_or_else(|| {
			invalid("sessionId must be a string matching ^[a-z]{1,4}_[A-Za-z0-9]{1,64}$")
		})?;
	let generation = params
		.get("sessionGeneration")
		.and_then(Value::as_u64)
		.filter(|generation| *generation >= 1)
		.ok_or_else(|| invalid("sessionGeneration must be an integer >= 1"))?;
	Ok((id, generation))
}

fn check_generation(key: &SessionKey, generation: u64) -> Result<(), RpcError> {
	if key.generation == generation {
		return Ok(());
	}
	Err(RpcError::with_detail(
		ErrorKind::InvalidSession,
		"sessionGeneration does not match the session",
	)
	.for_session(key.id.clone()))
}

/// The id prefix of this process. It is not a secret and grants nothing: it only has to differ
/// between processes, so that ids a client kept from an earlier runtime are unknown to the next
/// one. `RandomState` is seeded from the operating system's random source.
fn process_id_prefix() -> String {
	let mut hasher = RandomState::new().build_hasher();
	hasher.write_u32(process::id());
	if let Ok(since_epoch) = SystemTime::now().duration_since(UNIX_EPOCH) {
		hasher.write_u128(since_epoch.as_nanos());
	}
	format!("s_{:016x}", hasher.finish())
}

fn invalid(detail: impl Into<String>) -> RpcError {
	RpcError::with_detail(ErrorKind::InvalidParams, detail)
}

#[cfg(test)]
mod tests {
	use std::path::Path;
	use std::sync::mpsc::{self, Receiver};

	use super::*;
	use crate::events::Input;
	use crate::sqlite::test_files::{text, TempDir};

	fn params(value: Value) -> Map<String, Value> {
		match value {
			Value::Object(map) => map,
			other => panic!("params must be an object: {other}"),
		}
	}

	fn kind<T: std::fmt::Debug>(result: Result<T, RpcError>) -> ErrorKind {
		result.expect_err("expected a failure").kind
	}

	/// A registry whose worker reports are dropped: enough for the methods that answer without a
	/// worker.
	fn registry() -> Sessions {
		let (sender, _reports) = mpsc::channel();
		Sessions::new(sender)
	}

	/// A registry and the receiving end of its worker reports.
	fn paired() -> (Sessions, Receiver<Input>) {
		let (sender, reports) = mpsc::channel();
		(Sessions::new(sender), reports)
	}

	#[test]
	fn session_ids_match_the_contract_pattern_and_differ_between_registries() {
		let first = registry();
		let second = registry();
		assert_ne!(first.id_prefix, second.id_prefix);
		for registry in [&first, &second] {
			let prefix = registry.id_prefix.strip_prefix("s_").unwrap();
			assert_eq!(prefix.len(), 16);
			assert!(prefix.bytes().all(|byte| byte.is_ascii_hexdigit()));
			for sequence in [1, u64::MAX] {
				let id = format!("{}{sequence}", registry.id_prefix);
				assert!(is_valid_id(&id), "{id}");
			}
		}
	}

	#[test]
	fn target_params_follow_the_method_schemas() {
		let valid = json!({"driver": "sqlite", "path": "/db.sqlite", "readOnly": true});
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
			without("driver"),
			without("path"),
			without("readOnly"),
			with("driver", json!("postgres")),
			with("driver", json!(null)),
			with("path", json!("")),
			with("path", json!(7)),
			with("readOnly", json!("true")),
			with("readOnly", json!(1)),
			with("debug", json!(true)),
		];
		let mut sessions = registry();
		for case in &cases {
			assert_eq!(
				kind(test(&params(case.clone()))),
				ErrorKind::InvalidParams,
				"{case}"
			);
			assert_eq!(
				kind(sessions.open(&params(case.clone()))),
				ErrorKind::InvalidParams,
				"{case}"
			);
		}
		// profileId belongs to connection.open only.
		let profile = with("profileId", json!("local-demo"));
		assert_eq!(kind(test(&params(profile))), ErrorKind::InvalidParams);
		for profile in [json!(""), json!(7), json!(null)] {
			let case = with("profileId", profile);
			assert_eq!(
				kind(sessions.open(&params(case.clone()))),
				ErrorKind::InvalidParams,
				"{case}"
			);
		}
		assert_eq!(sessions.open_count(), 0);
	}

	#[test]
	fn close_params_follow_the_method_schema() {
		let mut sessions = registry();
		for case in [
			json!({}),
			json!({"sessionId": "s_1"}),
			json!({"sessionGeneration": 1}),
			json!({"sessionId": "S_1", "sessionGeneration": 1}),
			json!({"sessionId": "session_1", "sessionGeneration": 1}),
			json!({"sessionId": 1, "sessionGeneration": 1}),
			json!({"sessionId": "s_1", "sessionGeneration": 0}),
			json!({"sessionId": "s_1", "sessionGeneration": -1}),
			json!({"sessionId": "s_1", "sessionGeneration": 1.5}),
			json!({"sessionId": "s_1", "sessionGeneration": "1"}),
			json!({"sessionId": "s_1", "sessionGeneration": 1, "force": true}),
		] {
			assert_eq!(
				kind(sessions.close(&params(case.clone()))),
				ErrorKind::InvalidParams,
				"{case}"
			);
		}
	}

	#[test]
	fn closing_an_unknown_session_names_it_in_the_error() {
		let mut sessions = registry();
		let error = sessions
			.close(&params(
				json!({"sessionId": "s_001", "sessionGeneration": 1}),
			))
			.expect_err("the session was never opened");
		assert_eq!(error.kind, ErrorKind::InvalidSession);
		assert_eq!(error.to_json()["data"]["sessionId"], "s_001");
	}

	#[test]
	fn list_starts_empty_and_takes_no_params() {
		let sessions = registry();
		assert_eq!(sessions.list(&Map::new()).unwrap(), json!({"sessions": []}));
		assert_eq!(
			kind(sessions.list(&params(json!({"all": true})))),
			ErrorKind::InvalidParams
		);
	}

	fn target(path: &Path, read_only: bool) -> Map<String, Value> {
		params(json!({"driver": "sqlite", "path": text(path), "readOnly": read_only}))
	}

	fn key(opened: &Value) -> Map<String, Value> {
		params(json!({
			"sessionId": opened["sessionId"],
			"sessionGeneration": opened["sessionGeneration"],
		}))
	}

	fn query(opened: &Value, sql: &str) -> Map<String, Value> {
		params(json!({
			"sessionId": opened["sessionId"],
			"sessionGeneration": opened["sessionGeneration"],
			"sql": sql,
			"mode": "statement",
			"timeoutMs": 600_000,
			"maxInitialRows": 10,
		}))
	}

	fn states(sessions: &Sessions) -> Vec<(String, String)> {
		sessions.list(&Map::new()).unwrap()["sessions"]
			.as_array()
			.unwrap()
			.iter()
			.map(|session| {
				(
					session["sessionId"].as_str().unwrap().to_owned(),
					session["state"].as_str().unwrap().to_owned(),
				)
			})
			.collect()
	}

	/// Applies the worker's reports for one execution and returns the result handle it produced.
	fn complete(sessions: &mut Sessions, reports: &Receiver<Input>, execution: &str) -> String {
		loop {
			let event = match reports.recv().expect("the worker reports") {
				Input::Event(event) => event,
				other => panic!("expected a worker report: {other:?}"),
			};
			if let Event::Prepared {
				session,
				execution: prepared,
				error,
			} = &event
			{
				let reply = sessions
					.prepared(session, prepared, error.clone())
					.expect("the reply of a prepared execution");
				reply.result.expect("the statement prepared");
			}
			let finished = matches!(event, Event::Finished { .. });
			sessions.apply_event(event);
			if finished {
				break;
			}
		}
		let state = sessions
			.get_state(&params(json!({"executionId": execution})))
			.unwrap();
		state["resultIds"][0]
			.as_str()
			.expect("a completed execution hands over a result")
			.to_owned()
	}

	#[test]
	fn test_opens_and_closes_the_file_without_creating_a_session() {
		let dir = TempDir::new("test");
		let path = dir.database("db.sqlite");
		let result = test(&target(&path, true)).unwrap();
		assert_eq!(result["ok"], true);
		assert_eq!(result["serverVersion"], sqlite::library_version());
		assert!(result["elapsedMs"].is_u64());

		let missing = test(&target(&dir.join("missing.sqlite"), true)).unwrap_err();
		assert_eq!(missing.kind, ErrorKind::InvalidParams);
	}

	#[test]
	fn open_list_and_close_follow_the_session_lifecycle() {
		let dir = TempDir::new("lifecycle");
		let path = dir.database("db.sqlite");
		let mut sessions = registry();

		let first = sessions.open(&target(&path, true)).unwrap();
		let mut with_profile = target(&path, false);
		with_profile.insert("profileId".into(), json!("local-demo"));
		let second = sessions.open(&with_profile).unwrap();
		assert_eq!(first["sessionGeneration"], 1);
		assert_eq!(second["sessionGeneration"], 2);
		assert_ne!(first["sessionId"], second["sessionId"]);
		// Only readOnly follows the request; the rest is what this build serves (N-105, N-108).
		for (session, read_only) in [(&first, true), (&second, false)] {
			assert_eq!(
				session["capabilities"],
				json!({
					"driver": "sqlite",
					"readOnly": read_only,
					"cancel": "cooperative",
					"supportsTransactions": false,
					"supportsMetadata": true,
				})
			);
		}
		assert_eq!(sessions.open_count(), 2);

		let first_id = first["sessionId"].as_str().unwrap().to_owned();
		let second_id = second["sessionId"].as_str().unwrap().to_owned();
		assert_eq!(
			states(&sessions),
			[
				(first_id.clone(), "open".into()),
				(second_id.clone(), "open".into())
			]
		);

		assert_eq!(
			sessions.close(&key(&first)).unwrap().0,
			json!({"closed": true})
		);
		// Closing again is idempotent.
		assert_eq!(
			sessions.close(&key(&first)).unwrap().0,
			json!({"closed": true})
		);
		assert_eq!(sessions.open_count(), 1);
		assert_eq!(
			states(&sessions),
			[(first_id, "closed".into()), (second_id, "open".into())]
		);
	}

	#[test]
	fn a_generation_that_does_not_match_is_refused_and_changes_nothing() {
		let dir = TempDir::new("generation");
		let path = dir.database("db.sqlite");
		let mut sessions = registry();
		let first = sessions.open(&target(&path, true)).unwrap();
		let second = sessions.open(&target(&path, true)).unwrap();

		// The id of one session with the generation of the other.
		let mut crossed = key(&first);
		crossed.insert(
			"sessionGeneration".into(),
			second["sessionGeneration"].clone(),
		);
		let error = sessions.close(&crossed).expect_err("the pair is refused");
		assert_eq!(error.kind, ErrorKind::InvalidSession);
		assert_eq!(error.to_json()["data"]["sessionId"], first["sessionId"]);
		assert_eq!(sessions.open_count(), 2, "the open session stays open");

		// A closed session keeps checking its generation.
		sessions.close(&key(&first)).unwrap();
		assert_eq!(kind(sessions.close(&crossed)), ErrorKind::InvalidSession);
	}

	#[test]
	fn an_id_is_owned_by_the_session_that_issued_it_even_when_ids_nest() {
		let dir = TempDir::new("routing");
		let path = dir.database("db.sqlite");
		let (mut sessions, reports) = paired();
		// Session 1's id is a textual prefix of session 11's id: `s_<hex>1` and `s_<hex>11`.
		let opened: Vec<Value> = (0..=11)
			.map(|_| sessions.open(&target(&path, true)).unwrap())
			.collect();
		let first = opened[0]["sessionId"].as_str().unwrap().to_owned();
		let eleventh = opened[10]["sessionId"].as_str().unwrap().to_owned();
		assert!(
			format!("{eleventh}e1").starts_with(&first),
			"the eleventh session's id starts with the first session's id"
		);

		// Each execution and result id belongs to the session that issued it.
		for index in [0usize, 10] {
			let started = sessions
				.begin_execution(&query(&opened[index], "SELECT 1 AS answer"))
				.unwrap();
			let execution = started.execution;
			assert_eq!(
				sessions.owner(&execution),
				Some(index),
				"{execution} belongs to session {index}"
			);
			let result = complete(&mut sessions, &reports, &execution);
			assert_eq!(sessions.owner(&result), Some(index), "{result}");
			// `fetch_page` routes by the id alone, so the handle is reached through its owner.
			let page = sessions
				.fetch_page(&params(json!({"resultId": result, "limit": 1})))
				.unwrap();
			assert_eq!(page["rows"], json!([[{"type": "int64", "text": "1"}]]));
			sessions
				.release(&params(json!({"resultId": result})))
				.unwrap();
		}

		// Ids that only look like they start with a session id are not owned by it.
		for foreign in [
			format!("{first}e"),   // no digits
			format!("{first}x1"),  // wrong marker
			format!("{first}e1x"), // not all digits
			format!("{first}r"),   // no digits
			first.clone(),         // the bare session id
		] {
			assert_eq!(sessions.owner(&foreign), None, "{foreign}");
		}
		assert_eq!(sessions.owner(&format!("{eleventh}e1")), Some(10));
	}

	#[test]
	fn open_sessions_are_limited_and_the_registry_stays_usable() {
		let dir = TempDir::new("limit");
		let path = dir.database("db.sqlite");
		let mut sessions = registry();
		let opened: Vec<Value> = (0..MAX_OPEN_SESSIONS)
			.map(|_| sessions.open(&target(&path, true)).unwrap())
			.collect();
		let error = sessions.open(&target(&path, true)).unwrap_err();
		assert_eq!(error.kind, ErrorKind::ResourceLimit);
		assert_eq!(sessions.open_count(), MAX_OPEN_SESSIONS);

		sessions.close(&key(&opened[0])).unwrap();
		let next = sessions.open(&target(&path, true)).unwrap();
		// The refused open did not use up a generation.
		assert_eq!(next["sessionGeneration"], MAX_OPEN_SESSIONS as u64 + 1);
	}

	#[test]
	fn the_oldest_closed_session_is_forgotten_beyond_the_retention_limit() {
		let dir = TempDir::new("retention");
		let path = dir.database("db.sqlite");
		let mut sessions = registry();
		let closed: Vec<Value> = (0..=MAX_CLOSED_SESSIONS)
			.map(|_| {
				let opened = sessions.open(&target(&path, true)).unwrap();
				sessions.close(&key(&opened)).unwrap();
				opened
			})
			.collect();
		assert_eq!(states(&sessions).len(), MAX_CLOSED_SESSIONS);
		assert_eq!(
			kind(sessions.close(&key(&closed[0]))),
			ErrorKind::InvalidSession
		);
		assert!(sessions.close(&key(&closed[1])).is_ok());
	}

	#[test]
	fn a_close_while_a_statement_runs_reports_its_terminal_state() {
		let dir = TempDir::new("close-running");
		let path = dir.database("db.sqlite");
		let (mut sessions, reports) = paired();
		let opened = sessions.open(&target(&path, true)).unwrap();
		let started = sessions
			.begin_execution(&query(
				&opened,
				"WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n",
			))
			.unwrap();
		// The worker prepared the statement; the close therefore interrupts one that runs.
		match reports.recv().expect("the worker reports") {
			Input::Event(Event::Prepared {
				session,
				execution,
				error,
			}) => {
				assert!(error.is_none());
				sessions
					.prepared(&session, &execution, error)
					.expect("the reply of a prepared execution")
					.result
					.expect("the statement prepared");
			}
			other => panic!("expected a prepared report: {other:?}"),
		}

		let (closed, notifications) = sessions.close(&key(&opened)).unwrap();
		assert_eq!(closed, json!({"closed": true}));
		assert_eq!(notifications.len(), 1);
		assert_eq!(notifications[0]["params"]["state"], "cancel_requested");
		assert_eq!(notifications[0]["params"]["executionId"], started.execution);

		// The worker interrupts the statement and reports `cancelled`; the closed session's
		// registry still turns that into a notification, and `query.getState` keeps answering.
		let terminal = loop {
			let event = match reports.recv().expect("the worker reports") {
				Input::Event(event) => event,
				other => panic!("expected a worker report: {other:?}"),
			};
			let finished = matches!(event, Event::Finished { .. });
			let produced = sessions.apply_event(event);
			if finished {
				break produced;
			}
		};
		assert_eq!(terminal[0]["params"]["state"], "cancelled");
		assert_eq!(terminal[0]["params"]["executionId"], started.execution);
		let state = sessions
			.get_state(&params(json!({"executionId": started.execution})))
			.unwrap();
		assert_eq!(state["state"], "cancelled");
		assert_eq!(sessions.open_count(), 0);
	}

	#[test]
	fn a_failed_open_creates_no_session() {
		let dir = TempDir::new("failed-open");
		let mut sessions = registry();
		let error = sessions
			.open(&target(&dir.text_file("notes.txt"), true))
			.unwrap_err();
		assert_eq!(error.kind, ErrorKind::InvalidParams);
		assert_eq!(sessions.open_count(), 0);
		let opened = sessions
			.open(&target(&dir.database("db.sqlite"), true))
			.unwrap();
		assert_eq!(opened["sessionGeneration"], 1);
	}
}
