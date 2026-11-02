/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! The execution registry of one session: `query.execute`, `query.getState`, `query.cancel`,
//! `result.fetchPage` and `result.release` (N-106), and the state machine of
//! `nyala/rpc/README.md` §5 as the request loop sees it (N-108).
//!
//! The registry never touches SQLite. It issues execution and result ids, keeps every execution's
//! state, sequence and result handles, and applies what the session worker reports
//! ([`crate::worker`]) — that split is what lets `query.cancel` reach a running statement.
//!
//! The life of one execution:
//!
//! 1. `query.execute` validates the parameters, takes an id and hands the job to the worker
//!    ([`Executions::begin`]). Its reply is `queued` with `sequence: 1` and is sent once the
//!    worker has prepared the first statement ([`Executions::mark_replied`]), so a statement
//!    SQLite cannot compile is answered with the structured error, as `conformance.ndjson`
//!    rq_009 records ([`Executions::fail_prepared`]). A session has one connection, so a second
//!    `query.execute` waits until the first execution ends.
//! 2. The worker reports `running` before its first statement steps (`sequence: 2`).
//! 3. `query.cancel` moves a queued or running execution to `cancel_requested` — a state of its
//!    own, with its own sequence — and interrupts the statement. The execution then ends as
//!    `cancelled`, or as `completed` when the statement was already past its last interruptible
//!    point: `cancel_requested` is a request, not an outcome.
//! 4. A timeout ends the statement from inside SQLite's progress callback and reports `cancelled`
//!    carrying `QUERY_TIMEOUT`; a session closing under a statement reports `QUERY_CANCELLED`, and
//!    a user cancellation reports `cancelled` without an error, as rq_012 records.
//! 5. If the session worker dies, an execution it was running ends as `unknown` — whether the
//!    statement committed cannot be proven — while one that had not started ran nothing and ends
//!    as `cancelled` (§5).
//!
//! A `query.stateChanged` notification is emitted for every state after `queued`, in sequence
//! order, with the execution's own `sequence`. The reply to `query.execute` always precedes them.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::error::{ErrorKind, RpcError};
use crate::framing::DEFAULT_FRAME_MAX_BYTES;
use crate::protocol::{is_valid_id, JSONRPC_VERSION, MAX_PAGE_ROWS};
use crate::worker::{Job, Outcome, State};

/// Executions one session may have open at once: queued, running, or holding a result nobody
/// released yet. Advertised as `maxConcurrentExecutions` (`nyala/rpc/README.md` §7); the advertised
/// value and the enforced one are the same constant.
pub const MAX_CONCURRENT_EXECUTIONS: usize = crate::protocol::MAX_CONCURRENT_EXECUTIONS as usize;

/// Executions remembered after their terminal state, so `query.getState` can answer for a while.
pub const MAX_RETAINED_EXECUTIONS: usize = 32;

/// Bytes one `result.fetchPage` reply spends on anything but its rows: the JSON-RPC envelope,
/// `columns`, `rowCountEstimate`, `hasMore` and `nextCursor`. A page's rows get what is left of
/// `frameMaxBytes`, so the reply always fits one frame.
const PAGE_ENVELOPE_RESERVE: usize = 16 * 1024;

/// The flag a cancellable execution shares with its worker: `0` running, `1` timed out, `2`
/// cancelled (`worker::Stop`). The registry only ever sets `2`.
type StopFlag = Arc<AtomicU8>;

/// The value of `worker::Stop::Cancelled`.
const STOP_CANCELLED: u8 = 2;

/// A fetchable result: the columns and cells of one statement, read forward only.
struct ResultSet {
	id: String,
	columns: Vec<Value>,
	rows: Vec<Vec<Value>>,
	/// Index of the first row not returned yet; also the cursor for the next page.
	next: usize,
	expires_at: Instant,
}

/// One execution the registry knows about.
struct Entry {
	id: String,
	sequence: u64,
	state: State,
	elapsed_ms: u64,
	result_ids: Vec<String>,
	error: Option<RpcError>,
	/// Why a running statement must end; `None` once the execution is terminal.
	stop: Option<StopFlag>,
	/// Whether the `queued` reply has been sent. A cancel that arrives earlier is reported once
	/// the reply is out, so the client sees `queued` before `cancel_requested`.
	replied: bool,
	/// A cancel arrived before the reply and still has to be reported as a notification.
	cancel_pending: bool,
	/// Whether the worker ran any statement yet.
	started: bool,
	/// Whether `query.cancel` asked for the stop, as opposed to a timeout or the session closing.
	/// A user cancellation is reported without an error (`conformance.ndjson` rq_012).
	user_cancel: bool,
}

impl Entry {
	/// The `query.stateChanged` notification for the current state.
	fn notification(&self) -> Value {
		let mut params = Map::new();
		params.insert("executionId".into(), json!(self.id));
		params.insert("sequence".into(), json!(self.sequence));
		params.insert("state".into(), json!(self.state.as_str()));
		if !self.result_ids.is_empty() {
			params.insert("resultIds".into(), json!(self.result_ids));
		}
		if self.state.is_terminal() {
			params.insert("elapsedMs".into(), json!(self.elapsed_ms));
		}
		if let Some(error) = &self.error {
			params.insert("error".into(), error.to_json());
		}
		json!({
			"jsonrpc": JSONRPC_VERSION,
			"method": "query.stateChanged",
			"params": params,
		})
	}
}

/// What `query.cancel` produced: the reply, the notifications to send, and whether the worker has
/// to interrupt its connection.
pub(crate) struct CancelOutcome {
	pub(crate) reply: Value,
	pub(crate) notifications: Vec<Value>,
	pub(crate) interrupt: bool,
}

/// The executions and result handles of one session. Lives on the request loop; dropping it
/// releases every handle.
pub struct Executions {
	/// Session id; every id issued here starts with it and already satisfies `$defs/id`.
	prefix: String,
	executions: u64,
	results: u64,
	entries: Vec<Entry>,
	handles: Vec<ResultSet>,
}

impl std::fmt::Debug for Executions {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Executions")
			.field("entries", &self.entries.len())
			.field("handles", &self.handles.len())
			.finish_non_exhaustive()
	}
}

impl Executions {
	/// `prefix` is the session id the registry belongs to.
	pub fn new(prefix: &str) -> Executions {
		Executions {
			prefix: prefix.to_owned(),
			executions: 0,
			results: 0,
			entries: Vec::new(),
			handles: Vec::new(),
		}
	}

	/// `runtime.health` `activeExecutions`: executions that are queued, running or waiting for a
	/// cancel to take effect.
	pub fn active(&self) -> usize {
		self.entries
			.iter()
			.filter(|entry| !entry.state.is_terminal())
			.count()
	}

	/// `runtime.health` `pendingResults`: result handles nobody released yet.
	pub fn pending_results(&self) -> usize {
		self.handles.len()
	}

	/// `query.execute`: validates the parameters, takes an execution id and returns the job for
	/// the session worker. The reply is not built here; it waits for [`Self::mark_replied`] or
	/// [`Self::fail_prepared`] (see the module comment).
	pub(crate) fn begin(
		&mut self,
		params: &Map<String, Value>,
		read_only: bool,
	) -> Result<Job, RpcError> {
		self.expire(Instant::now());
		// `maxConcurrentExecutions` (§7) counts everything that is open: executions not finished
		// yet and results nobody released. Refusing here, before the statement runs, keeps
		// `INSERT … RETURNING` from performing its write and only then failing to hand over a
		// result.
		if self.active() + self.pending_results() >= MAX_CONCURRENT_EXECUTIONS {
			return Err(RpcError::with_detail(
				ErrorKind::ResourceLimit,
				format!("at most {MAX_CONCURRENT_EXECUTIONS} executions can be open at once"),
			));
		}

		let spare_results = MAX_CONCURRENT_EXECUTIONS.saturating_sub(self.pending_results());
		// Parsing first means a malformed request changes nothing, not even the id counter; the
		// next id is therefore computed and only taken once the job is valid.
		let id = format!("{}e{}", self.prefix, self.executions + 1);
		let job = Job::parse(&id, params, read_only, spare_results)?;
		self.executions += 1;
		self.entries.push(Entry {
			id,
			sequence: 1,
			state: State::Queued,
			elapsed_ms: 0,
			result_ids: Vec::new(),
			error: None,
			stop: Some(job.stop()),
			replied: false,
			cancel_pending: false,
			started: false,
			user_cancel: false,
		});
		Ok(job)
	}

	/// The worker prepared the job: the deferred `query.execute` reply can be sent. Returns the
	/// notifications the registry owes for a cancel that arrived before the reply.
	pub(crate) fn mark_replied(&mut self, execution: &str) -> Vec<Value> {
		let Some(entry) = self.entry_mut(execution) else {
			return Vec::new();
		};
		entry.replied = true;
		if !entry.cancel_pending {
			return Vec::new();
		}
		entry.cancel_pending = false;
		entry.sequence += 1;
		vec![entry.notification()]
	}

	/// The worker could not prepare the job: the execution is retained as `failed`, so
	/// `query.getState` answers for it exactly as for one that failed later.
	pub(crate) fn fail_prepared(&mut self, execution: &str, error: &RpcError) {
		let Some(entry) = self.entry_mut(execution) else {
			return;
		};
		entry.state = State::Failed;
		entry.sequence += 1;
		entry.error = Some(error.clone());
		entry.replied = true;
		entry.stop = None;
		self.trim();
	}

	/// The deferred `query.execute` reply of an execution the worker prepared.
	pub(crate) fn queued(&self, execution: &str) -> Option<Value> {
		self.entry(execution).map(|entry| {
			json!({
				"executionId": entry.id,
				"state": State::Queued.as_str(),
				"sequence": 1,
			})
		})
	}

	/// The worker started running the statements.
	pub(crate) fn started(&mut self, execution: &str) -> Vec<Value> {
		let Some(entry) = self.entry_mut(execution) else {
			return Vec::new();
		};
		entry.started = true;
		// A cancel that arrived first already moved the execution to `cancel_requested`; the
		// contract has no `running` after it.
		if entry.state != State::Queued {
			return Vec::new();
		}
		entry.state = State::Running;
		entry.sequence += 1;
		vec![entry.notification()]
	}

	/// The worker reached the terminal state.
	pub(crate) fn finished(
		&mut self,
		execution: &str,
		outcome: Outcome,
		ttl: Duration,
	) -> Vec<Value> {
		let now = Instant::now();
		let mut outcome = outcome;
		// Handles are numbered before the entry is borrowed, because the borrow checker cannot
		// see that the id counter and the entry are different fields of this struct.
		let mut handles = Vec::with_capacity(outcome.results.len());
		for collected in std::mem::take(&mut outcome.results) {
			self.results += 1;
			handles.push((format!("{}r{}", self.prefix, self.results), collected));
		}
		// A job's result budget is a snapshot taken when it was admitted, and a job that queued
		// behind another one took the same snapshot, so the session-wide cap is enforced here, where
		// the handles are actually installed. The rows are dropped whole rather than truncated
		// (`README.md` §7) and the execution reports the limit instead of handing out a handle it
		// cannot keep. The worker's own check stays as the early refusal that runs before a script
		// collects more than the session could hold.
		if self.pending_results() + handles.len() > MAX_CONCURRENT_EXECUTIONS {
			handles.clear();
			outcome.state = State::Failed;
			outcome.error = Some(RpcError::with_detail(
				ErrorKind::ResourceLimit,
				format!("at most {MAX_CONCURRENT_EXECUTIONS} executions can hold results at once"),
			));
		}
		let Some(entry) = self.entry_mut(execution) else {
			return Vec::new();
		};
		entry.state = outcome.state;
		entry.elapsed_ms = outcome.elapsed_ms;
		entry.error = outcome.error;
		entry.stop = None;
		entry.sequence += 1;
		// A user cancellation says everything in the state; the sample records no error for it.
		if entry.state == State::Cancelled && entry.user_cancel {
			entry.error = None;
		}
		let mut result_ids = Vec::with_capacity(handles.len());
		for (id, _) in &handles {
			result_ids.push(id.clone());
		}
		let notification = {
			entry.result_ids = result_ids;
			entry.notification()
		};
		for (id, collected) in handles {
			self.handles.push(ResultSet {
				id,
				columns: collected.columns,
				rows: collected.rows,
				next: 0,
				expires_at: now + ttl,
			});
		}
		self.trim();
		vec![notification]
	}

	/// `query.cancel`: a request, not an outcome. See [`CancelOutcome`].
	pub(crate) fn cancel(
		&mut self,
		params: &Map<String, Value>,
	) -> Result<CancelOutcome, RpcError> {
		for key in params.keys() {
			if !matches!(key.as_str(), "executionId" | "reason") {
				return Err(invalid("unexpected query.cancel parameter"));
			}
		}
		if let Some(reason) = params.get("reason") {
			if !matches!(reason.as_str(), Some("user" | "timeout" | "shutdown")) {
				return Err(invalid("reason must be user, timeout or shutdown"));
			}
		}
		let id = execution_id(params)?;
		let Some(entry) = self.entry_mut(id) else {
			return Err(invalid("executionId is unknown"));
		};
		if entry.state.is_terminal() {
			// Nothing left to stop: the reply reports the terminal state instead.
			return Ok(CancelOutcome {
				reply: json!({"accepted": false, "state": entry.state.as_str()}),
				notifications: Vec::new(),
				interrupt: false,
			});
		}
		if entry.state == State::CancelRequested {
			// A second cancel changes nothing; the first one is still in flight.
			return Ok(CancelOutcome {
				reply: json!({"accepted": true, "state": State::CancelRequested.as_str()}),
				notifications: Vec::new(),
				interrupt: entry.started,
			});
		}
		entry.state = State::CancelRequested;
		entry.user_cancel = true;
		if let Some(stop) = &entry.stop {
			stop.store(STOP_CANCELLED, Ordering::SeqCst);
		}
		let notifications = if entry.replied {
			entry.sequence += 1;
			vec![entry.notification()]
		} else {
			entry.cancel_pending = true;
			Vec::new()
		};
		// `sqlite3_interrupt` stops whatever the session's one connection is stepping, not the
		// execution the id names. A queued execution is stopped by its flag: the worker reads it
		// before it runs anything. Interrupting for it would abort the statement that is running.
		Ok(CancelOutcome {
			reply: json!({"accepted": true, "state": State::CancelRequested.as_str()}),
			notifications,
			interrupt: entry.started,
		})
	}

	/// Moves every queued or running execution to `cancel_requested` because the session is
	/// closing. Returns the notifications to send and whether the worker has to be interrupted.
	pub(crate) fn request_stop(&mut self) -> (Vec<Value>, bool) {
		let mut notifications = Vec::new();
		let mut interrupt = false;
		for entry in &mut self.entries {
			if entry.state.is_terminal() {
				continue;
			}
			// The flag is set even for an execution another cancel already moved to
			// `cancel_requested`: the worker may not have read it yet.
			if let Some(stop) = &entry.stop {
				stop.store(STOP_CANCELLED, Ordering::SeqCst);
			}
			interrupt |= entry.started;
			if entry.state == State::CancelRequested {
				continue;
			}
			entry.state = State::CancelRequested;
			if entry.replied {
				entry.sequence += 1;
				notifications.push(entry.notification());
			} else {
				entry.cancel_pending = true;
			}
		}
		(notifications, interrupt)
	}

	/// The worker thread panicked. An execution it was running cannot be proven to have committed
	/// or failed, so it ends as `unknown`; one that had not started ran nothing and ends as
	/// `cancelled` (§5).
	pub(crate) fn worker_gone(&mut self) -> Vec<Value> {
		let mut notifications = Vec::new();
		for entry in &mut self.entries {
			if entry.state.is_terminal() {
				continue;
			}
			entry.stop = None;
			entry.sequence += 1;
			entry.state = if entry.started {
				State::Unknown
			} else {
				State::Cancelled
			};
			entry.error = Some(if entry.started {
				RpcError::with_detail(
					ErrorKind::UnknownCommitStatus,
					"the session worker stopped while the statement was running",
				)
			} else {
				RpcError::with_detail(
					ErrorKind::QueryCancelled,
					"the session worker stopped before the statement ran",
				)
			});
			// An execution whose `queued` reply was never sent has no state to report: its reply is
			// the failure the request loop writes for it, and a notification before that would name
			// an execution the client has not been told about (`README.md` §5: the reply comes first).
			if entry.replied {
				notifications.push(entry.notification());
			}
		}
		self.trim();
		notifications
	}

	/// Drops the executions of a session whose worker exited before it prepared a job: no report
	/// will arrive for them, so nothing here can be answered any more. The result handles stay,
	/// because a client may still be reading a result of an execution that did finish.
	pub(crate) fn forget(&mut self) {
		self.entries.clear();
	}

	/// `query.getState`.
	pub fn get_state(&self, params: &Map<String, Value>) -> Result<Value, RpcError> {
		if params.keys().any(|key| key != "executionId") {
			return Err(invalid("unexpected query.getState parameter"));
		}
		let id = execution_id(params)?;
		let entry = self.entry(id).ok_or_else(unknown_execution)?;
		let mut result = Map::new();
		result.insert("executionId".into(), json!(entry.id));
		result.insert("state".into(), json!(entry.state.as_str()));
		result.insert("sequence".into(), json!(entry.sequence));
		if !entry.result_ids.is_empty() {
			result.insert("resultIds".into(), json!(entry.result_ids));
		}
		if let Some(error) = &entry.error {
			result.insert("error".into(), error.to_json());
		}
		result.insert("elapsedMs".into(), json!(entry.elapsed_ms));
		Ok(Value::Object(result))
	}

	/// `result.fetchPage`. Pages move forward only; `cursor` is the row index the handle last
	/// reached.
	pub fn fetch_page(&mut self, params: &Map<String, Value>) -> Result<Value, RpcError> {
		for key in params.keys() {
			if !matches!(key.as_str(), "resultId" | "cursor" | "limit") {
				return Err(invalid("unexpected result.fetchPage parameter"));
			}
		}
		let limit = params
			.get("limit")
			.and_then(Value::as_u64)
			.filter(|limit| (1..=u64::from(MAX_PAGE_ROWS)).contains(limit))
			.ok_or_else(|| {
				invalid(format!(
					"limit must be an integer between 1 and {MAX_PAGE_ROWS}"
				))
			})?;
		let id = params
			.get("resultId")
			.and_then(Value::as_str)
			.filter(|id| is_valid_id(id))
			.ok_or_else(|| invalid("resultId must be a contract id"))?;
		let cursor = match params.get("cursor") {
			None | Some(Value::Null) => None,
			Some(Value::String(cursor)) => Some(
				cursor
					.parse::<usize>()
					.map_err(|_| invalid("cursor is not a cursor this runtime issued"))?,
			),
			Some(_) => return Err(invalid("cursor must be a string or null")),
		};

		self.expire(Instant::now());
		let handle = self
			.handles
			.iter_mut()
			.find(|handle| handle.id == id)
			.ok_or_else(expired)?;
		// A cursor this handle did not reach would either repeat or skip rows.
		match cursor {
			Some(cursor) if cursor != handle.next => {
				return Err(invalid("cursor does not continue this result"))
			}
			_ => {}
		}
		let limit = usize::try_from(limit).unwrap_or(usize::MAX);
		// The reply is one frame, and a frame above `frameMaxBytes` cannot be written at all: the
		// runtime would have to close the stream, ending every session instead of answering this
		// one request. The page therefore stops early with `hasMore: true` and a cursor, so the
		// client reads the rest in another page. That is a page boundary, not truncation: the rows
		// are all still in the handle and `nextCursor` names where to continue.
		//
		// Sizes are the rows' own JSON, measured as the encoder will write them (escaping included),
		// plus the columns object, which every page repeats.
		let columns_size = array_len(&handle.columns)?;
		let mut budget = usize::try_from(DEFAULT_FRAME_MAX_BYTES)
			.unwrap_or(usize::MAX)
			.saturating_sub(PAGE_ENVELOPE_RESERVE)
			.saturating_sub(columns_size);
		let mut end = handle.next;
		while end < handle.rows.len() && end - handle.next < limit {
			// A row is its cells, their brackets and the comma before it.
			let size = array_len(&handle.rows[end])?.saturating_add(1);
			if size > budget {
				// A row that cannot share a frame with the envelope is not a page boundary: there is
				// no page to walk it in, and answering with a frame the transport cannot carry would
				// end the whole connection. `RESOURCE_LIMIT` is the one honest answer (§7).
				if end == handle.next {
					return Err(RpcError::with_detail(
						ErrorKind::ResourceLimit,
						"a single row does not fit in one frame",
					));
				}
				break;
			}
			budget -= size;
			end += 1;
		}
		let rows = handle.rows[handle.next..end].to_vec();
		handle.next = end;
		let has_more = end < handle.rows.len();
		Ok(json!({
			"columns": handle.columns,
			"rows": rows,
			"hasMore": has_more,
			"nextCursor": if has_more { Some(end.to_string()) } else { None },
			"rowCountEstimate": handle.rows.len() as u64,
		}))
	}

	/// `result.release`, idempotent. An id this process never issued counts as released: it is
	/// gone either way, and a distinct error would read as a protocol failure to the client.
	pub fn release(&mut self, params: &Map<String, Value>) -> Result<Value, RpcError> {
		for key in params.keys() {
			if key != "resultId" {
				return Err(invalid("unexpected result.release parameter"));
			}
		}
		let id = params
			.get("resultId")
			.and_then(Value::as_str)
			.filter(|id| is_valid_id(id))
			.ok_or_else(|| invalid("resultId must be a contract id"))?;
		self.handles.retain(|handle| handle.id != id);
		Ok(json!({ "released": true }))
	}

	fn entry(&self, id: &str) -> Option<&Entry> {
		self.entries.iter().find(|entry| entry.id == id)
	}

	fn entry_mut(&mut self, id: &str) -> Option<&mut Entry> {
		self.entries.iter_mut().find(|entry| entry.id == id)
	}

	fn expire(&mut self, now: Instant) {
		self.handles.retain(|handle| handle.expires_at > now);
	}

	/// Keeps the replies bounded: terminal executions beyond the retention limit are forgotten,
	/// and their handles with them. An execution that has not finished is never forgotten.
	fn trim(&mut self) {
		let mut terminal = self
			.entries
			.iter()
			.filter(|entry| entry.state.is_terminal())
			.count();
		if terminal <= MAX_RETAINED_EXECUTIONS {
			return;
		}
		let mut index = 0;
		while terminal > MAX_RETAINED_EXECUTIONS && index < self.entries.len() {
			if !self.entries[index].state.is_terminal() {
				index += 1;
				continue;
			}
			let stale = self.entries.remove(index);
			self.handles
				.retain(|handle| !stale.result_ids.contains(&handle.id));
			terminal -= 1;
		}
		self.expire(Instant::now());
	}
}

/// Bytes the JSON array `values` occupies in a frame, as `serde_json` writes it (compact, no
/// separators but `,`).
///
/// Used to keep one page inside one frame: the bound has to count escaping (a text cell of quotes
/// and control characters is several times its own length) and base64 expansion, which a byte
/// count of the payload would miss.
fn array_len(values: &[Value]) -> Result<usize, RpcError> {
	let mut length = 2; // The brackets.
	for (index, value) in values.iter().enumerate() {
		if index > 0 {
			length += 1; // The comma.
		}
		length += serde_json::to_vec(value)
			.map_err(|error| {
				RpcError::with_detail(
					ErrorKind::Internal,
					format!("a result page could not be measured: {error}"),
				)
			})?
			.len();
	}
	Ok(length)
}

/// Reads `executionId`; each caller has already rejected the parameters it does not accept, so
/// this only checks the field itself.
fn execution_id(params: &Map<String, Value>) -> Result<&str, RpcError> {
	params
		.get("executionId")
		.and_then(Value::as_str)
		.filter(|id| is_valid_id(id))
		.ok_or_else(|| invalid("executionId must be a contract id"))
}

fn unknown_execution() -> RpcError {
	RpcError::with_detail(ErrorKind::InvalidParams, "executionId is unknown")
}

/// The `RESULT_EXPIRED` error, for a handle this process does not hold (`README.md` §4:
/// "expired after release"). The session registry uses it for an id it never issued.
pub fn expired() -> RpcError {
	RpcError::with_detail(ErrorKind::ResultExpired, "result released or ttl exceeded")
}

fn invalid(detail: impl Into<String>) -> RpcError {
	RpcError::with_detail(ErrorKind::InvalidParams, detail)
}

#[cfg(test)]
mod tests;
