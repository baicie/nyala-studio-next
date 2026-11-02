/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Query execution and the result handles it leaves behind: `query.execute`, `query.getState`,
//! `query.cancel`, `result.fetchPage` and `result.release` (N-106).
//!
//! v1 serves one request at a time on one connection and has no async runtime yet (ADR 0002 §2),
//! so an execution runs to its terminal state inside `query.execute`. A statement that succeeds
//! replies with `completed` and its result ids; a statement that fails replies with the structured
//! error (`data.executionId` and `data.sessionId` name what failed), and the execution stays in the
//! registry so `query.getState` reports the same terminal `failed`/`cancelled` state — that is the
//! shape `conformance.ndjson` records for rq_009. The contract's `query.stateChanged`
//! notifications exist for a runtime that answers before the query is over; this build sends none,
//! which `README.md` §4 allows — `query.getState` is the compensation read for a missed
//! notification. For the same reason `query.cancel` cannot observe a running execution and reports
//! `accepted: false` with the terminal state instead of pretending the statement was interrupted.
//!
//! A timeout does interrupt a running statement: SQLite's progress callback ends it from inside the
//! VM, and the execution then ends as `cancelled` carrying `QUERY_TIMEOUT` — it never reports
//! `completed`. A session that closes under a running statement ends it the same way with
//! `QUERY_CANCELLED`.
//!
//! Read-only sessions rely on `SQLITE_OPEN_READONLY`, never on inspecting the SQL text
//! (`25-engineering-rules.md` §7). `READ_ONLY_DENIED` is reported only when SQLite itself refuses
//! the statement because of that mode.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rusqlite::fallible_iterator::FallibleIterator;
use rusqlite::{Batch, ErrorCode, Statement};
use serde_json::{json, Map, Value};

use crate::error::{ErrorKind, RpcError};
use crate::framing::DEFAULT_FRAME_MAX_BYTES;
use crate::protocol::{is_valid_id, MAX_PAGE_ROWS};
use crate::sqlite::Database;
use crate::value::cell;

/// Executions one session may have whose results nobody released yet. Advertised as
/// `maxConcurrentExecutions` (`nyala/rpc/README.md` §7); also the number of result handles a
/// session holds at once.
pub const MAX_CONCURRENT_EXECUTIONS: usize = 4;

/// Executions remembered after their terminal state, so `query.getState` can answer for a while.
pub const MAX_RETAINED_EXECUTIONS: usize = 32;

/// Rows one result may hold. Collection stops here rather than silently truncating
/// (`README.md` §7); a larger result needs the streaming cursor of N-107.
pub const MAX_RESULT_ROWS: usize = 10_000;

/// Approximate bytes one result may hold, counted as the length of the text and blob cells plus
/// one word per cell. A cheap bound on what a single query can pin in memory.
pub const MAX_RESULT_BYTES: usize = 16 * 1024 * 1024;

/// Statement polls between two looks at the clock, so a timeout is noticed quickly without a
/// syscall per instruction.
const PROGRESS_OPS: std::ffi::c_int = 1_000;

/// Bytes one `result.fetchPage` reply spends on anything but its rows: the JSON-RPC envelope,
/// `columns`, `rowCountEstimate`, `hasMore` and `nextCursor`. A page's rows get what is left of
/// `frameMaxBytes`, so the reply always fits one frame.
const PAGE_ENVELOPE_RESERVE: usize = 16 * 1024;

/// Why the progress callback ended a statement, stored in [`Executions::stop`].
///
/// Every execution owns its deadline, so a statement that `timeoutMs` ends is a timeout even if
/// the session starts closing at the same moment; a stop the session asked for is a cancellation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
	Running = 0,
	TimedOut = 1,
	Cancelled = 2,
}

impl Stop {
	fn load(stop: &AtomicU8) -> Stop {
		match stop.load(Ordering::SeqCst) {
			1 => Stop::TimedOut,
			2 => Stop::Cancelled,
			_ => Stop::Running,
		}
	}

	/// The terminal state and error of a statement this stop ended.
	fn outcome(self) -> Option<(State, RpcError)> {
		match self {
			Stop::Running => None,
			Stop::TimedOut => Some((
				State::Cancelled,
				RpcError::with_detail(ErrorKind::QueryTimeout, "the statement exceeded timeoutMs"),
			)),
			Stop::Cancelled => Some((
				State::Cancelled,
				RpcError::with_detail(ErrorKind::QueryCancelled, "the statement was cancelled"),
			)),
		}
	}
}

/// A state of the `README.md` §5 machine. Only the states this build reaches are listed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
	Completed,
	Failed,
	Cancelled,
}

impl State {
	fn as_str(self) -> &'static str {
		match self {
			State::Completed => "completed",
			State::Failed => "failed",
			State::Cancelled => "cancelled",
		}
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
	/// Exactly one statement.
	Single,
	/// Every statement of the text, in order.
	Script,
}

/// The validated parameters of `query.execute`.
struct Request {
	sql: String,
	mode: Mode,
	timeout: Duration,
	read_only: bool,
	max_rows: usize,
	max_bytes: usize,
}

impl Request {
	fn parse(params: &Map<String, Value>, read_only: bool) -> Result<Request, RpcError> {
		for key in params.keys() {
			if !matches!(
				key.as_str(),
				"sessionId"
					| "sessionGeneration"
					| "sql" | "mode"
					| "timeoutMs" | "maxInitialRows"
					| "cancelTokenId"
			) {
				return Err(invalid("unexpected query.execute parameter"));
			}
		}
		let sql = params
			.get("sql")
			.and_then(Value::as_str)
			.filter(|sql| !sql.is_empty())
			.ok_or_else(|| invalid("sql must be a non-empty string"))?;
		let mode = match params.get("mode").and_then(Value::as_str) {
			Some("statement" | "selection") => Mode::Single,
			Some("script") => Mode::Script,
			_ => return Err(invalid("mode must be statement, selection or script")),
		};
		let timeout_ms = params
			.get("timeoutMs")
			.and_then(Value::as_u64)
			.filter(|timeout| (1..=600_000).contains(timeout))
			.ok_or_else(|| invalid("timeoutMs must be an integer between 1 and 600000"))?;
		let max_initial_rows = params
			.get("maxInitialRows")
			.and_then(Value::as_u64)
			.filter(|rows| (1..=10_000).contains(rows))
			.ok_or_else(|| invalid("maxInitialRows must be an integer between 1 and 10000"))?;
		if let Some(token) = params.get("cancelTokenId") {
			if token.as_str().is_none_or(str::is_empty) {
				return Err(invalid("cancelTokenId must be a non-empty string"));
			}
		}
		// `maxInitialRows` caps the rows one execution collects, so a client that asks for fewer
		// rows gets the memory bound it asked for instead of the runtime's default.
		let max_rows = usize::try_from(max_initial_rows).unwrap_or(MAX_RESULT_ROWS);
		Ok(Request {
			sql: sql.to_owned(),
			mode,
			timeout: Duration::from_millis(timeout_ms),
			read_only,
			max_rows,
			max_bytes: MAX_RESULT_BYTES,
		})
	}
}

/// A query that reached a terminal state.
struct Execution {
	id: String,
	sequence: u64,
	state: State,
	elapsed_ms: u64,
	result_ids: Vec<String>,
	error: Option<RpcError>,
}

/// A fetchable result: the columns and cells of one statement, read forward only.
struct ResultSet {
	id: String,
	/// The value of [`Executions::results`] that named this handle, so the execution that created
	/// it can drop exactly its own handles when it fails.
	sequence: u64,
	columns: Vec<Value>,
	rows: Vec<Vec<Value>>,
	/// Index of the first row not returned yet; also the cursor for the next page.
	next: usize,
	expires_at: Instant,
}

/// The executions and results of one session. Dropping it releases every handle.
pub struct Executions {
	/// Session id; every id issued here starts with it and already satisfies `$defs/id`.
	prefix: String,
	executions: u64,
	results: u64,
	retained: Vec<Execution>,
	handles: Vec<ResultSet>,
	/// Why a running statement must end, or [`Stop::Running`]: the timeout sets it from the
	/// progress callback, `request_stop` sets it when the session goes away.
	stop: Arc<AtomicU8>,
}

impl std::fmt::Debug for Executions {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Executions")
			.field("retained", &self.retained.len())
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
			retained: Vec::new(),
			handles: Vec::new(),
			stop: Arc::new(AtomicU8::new(Stop::Running as u8)),
		}
	}

	/// `runtime.health` `activeExecutions`.
	///
	/// An execution runs to its terminal state inside `query.execute`, so none is active while a
	/// reply is built; the sample session itself reports `activeExecutions: 0` next to
	/// `pendingResults: 1` with a result still unread. Unread results are [`Self::pending_results`].
	pub fn active(&self) -> usize {
		0
	}

	/// `runtime.health` `pendingResults`: result handles nobody released yet.
	pub fn pending_results(&self) -> usize {
		self.handles.len()
	}

	/// `query.execute`. The reply carries the terminal state (see the module comment).
	pub fn execute(
		&mut self,
		database: &Database,
		params: &Map<String, Value>,
		ttl: Duration,
	) -> Result<Value, RpcError> {
		let request = Request::parse(params, database.read_only())?;
		self.expire(Instant::now());
		// `maxConcurrentExecutions` (README §7) is what this limit is advertised as. In this build
		// an execution ends before its reply is built, so the executions still "open" are exactly
		// those whose results nobody released. Refusing here, before the statement runs, keeps
		// `INSERT … RETURNING` from performing its write and only then failing to hand over a result.
		if self.pending_results() >= MAX_CONCURRENT_EXECUTIONS {
			return Err(RpcError::with_detail(
				ErrorKind::ResourceLimit,
				format!("at most {MAX_CONCURRENT_EXECUTIONS} executions can be open at once"),
			));
		}

		self.executions += 1;
		let id = format!("{}e{}", self.prefix, self.executions);
		let started = Instant::now();
		let results_before = self.results;
		let result = self.run(database, &request, started, ttl);
		let elapsed_ms = milliseconds(started.elapsed());
		let execution = match result {
			Ok(result_ids) => Execution {
				id: id.clone(),
				// The reply is the send point of `completed`; a runtime that answered early would
				// have sent `running`/`streaming` before it.
				sequence: 2,
				state: State::Completed,
				elapsed_ms,
				result_ids,
				error: None,
			},
			Err((state, error)) => {
				// A script that failed partway leaves the results of its earlier statements behind.
				// Nobody can learn their ids — the reply names no result — so they are dropped here
				// instead of pinning memory until the session ends. Handles are matched by the
				// sequence numbers this run issued, so a handle that expired meanwhile cannot make
				// one of this run's handles survive.
				self.handles
					.retain(|handle| handle.sequence <= results_before);
				Execution {
					id: id.clone(),
					sequence: 2,
					state,
					elapsed_ms,
					result_ids: Vec::new(),
					error: Some(error),
				}
			}
		};
		let reply = json!({
			"executionId": execution.id,
			"state": execution.state.as_str(),
			"sequence": execution.sequence,
		});
		let failed = execution.error.clone();
		// Retained either way: `query.getState` must answer for an execution that failed, exactly as
		// for one that completed (`conformance.ndjson` rq_009 fails, rq_012 is the compensation read).
		self.remember(execution);
		match failed {
			Some(error) => Err(error.for_execution(id)),
			None => Ok(reply),
		}
	}

	/// `query.getState`: the compensation read for a notification this build never sends.
	pub fn get_state(&self, params: &Map<String, Value>) -> Result<Value, RpcError> {
		if params.keys().any(|key| key != "executionId") {
			return Err(invalid("unexpected query.getState parameter"));
		}
		let id = execution_id(params)?;
		let execution = self.lookup(id)?;
		let mut result = Map::new();
		result.insert("executionId".into(), json!(execution.id));
		result.insert("state".into(), json!(execution.state.as_str()));
		result.insert("sequence".into(), json!(execution.sequence));
		if !execution.result_ids.is_empty() {
			result.insert("resultIds".into(), json!(execution.result_ids));
		}
		if let Some(error) = &execution.error {
			result.insert("error".into(), error.to_json());
		}
		result.insert("elapsedMs".into(), json!(execution.elapsed_ms));
		Ok(Value::Object(result))
	}

	/// `query.cancel` (see the module comment: nothing is running while this reply is built).
	pub fn cancel(&mut self, params: &Map<String, Value>) -> Result<Value, RpcError> {
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
		let execution = self.lookup(id)?;
		Ok(json!({
			"accepted": false,
			"state": execution.state.as_str(),
		}))
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

	/// Ends the statement that may be running when the session goes away.
	pub fn request_stop(&self) {
		self.stop.store(Stop::Cancelled as u8, Ordering::SeqCst);
	}

	/// Cancels a [`Self::request_stop`] that did not end in the session closing, so that the
	/// session stays usable.
	pub fn resume(&self) {
		self.stop.store(Stop::Running as u8, Ordering::SeqCst);
	}

	fn lookup(&self, id: &str) -> Result<&Execution, RpcError> {
		self.retained
			.iter()
			.find(|execution| execution.id == id)
			.ok_or_else(|| {
				RpcError::with_detail(ErrorKind::InvalidParams, "executionId is unknown")
					.for_execution(id)
			})
	}

	fn expire(&mut self, now: Instant) {
		self.handles.retain(|handle| handle.expires_at > now);
	}

	/// Arms the timeout, runs the statements and disarms it again.
	fn run(
		&mut self,
		database: &Database,
		request: &Request,
		started: Instant,
		ttl: Duration,
	) -> Result<Vec<String>, (State, RpcError)> {
		let deadline = started + request.timeout;
		self.arm(database, deadline)
			.map_err(|error| (State::Failed, error))?;
		let result = self.statements(database, request, ttl);
		self.disarm(database);
		// A timeout belongs to the execution that hit it; the next one gets its own deadline. A
		// cancellation stays: the session is closing and must end whatever runs next.
		let _ = self.stop.compare_exchange(
			Stop::TimedOut as u8,
			Stop::Running as u8,
			Ordering::SeqCst,
			Ordering::SeqCst,
		);
		result
	}

	/// Walks the text with SQLite's own preparer through `Batch`, so a `;` inside a string literal
	/// is never mistaken for a statement separator and comments are skipped as SQLite skips them.
	fn statements(
		&mut self,
		database: &Database,
		request: &Request,
		ttl: Duration,
	) -> Result<Vec<String>, (State, RpcError)> {
		let connection = database.connection();
		let mut batch = Batch::new(connection, &request.sql);
		let mut result_ids = Vec::new();
		let mut found = false;
		loop {
			let statement = batch
				.next()
				.map_err(|error| (State::Failed, query_error(error, request.read_only)))?;
			let Some(statement) = statement else {
				break;
			};
			found = true;
			if request.mode == Mode::Single {
				// A second statement means the caller sent more than one; answering the first and
				// dropping the rest would be a silent partial execution of a write script.
				if batch
					.next()
					.map_err(|error| (State::Failed, query_error(error, request.read_only)))?
					.is_some()
				{
					return Err((
						State::Failed,
						invalid("mode statement and selection run one statement; use mode script"),
					));
				}
			}
			let id = self.step(statement, request, ttl)?;
			result_ids.extend(id);
			if request.mode == Mode::Single {
				break;
			}
		}
		if !found {
			return Err((State::Failed, invalid("the SQL text contains no statement")));
		}
		Ok(result_ids)
	}

	/// Runs one prepared statement. Returns the result id it produced, if it produced columns.
	fn step(
		&mut self,
		mut statement: Statement<'_>,
		request: &Request,
		ttl: Duration,
	) -> Result<Option<String>, (State, RpcError)> {
		let mut columns = column_objects(&statement);
		if columns.is_empty() {
			// No columns: DML or DDL. Its affected-row count has no field in the v1
			// `query.execute` result, which is a recorded contract gap.
			let cancelled = Arc::clone(&self.stop);
			let executed = statement.execute([]);
			// A timeout or a session closing under `INSERT INTO … SELECT` ends the statement from
			// inside SQLite; that ends the execution as `cancelled`, not as a failure SQLite reported.
			if let Some(outcome) = Stop::load(&cancelled).outcome() {
				return Err(outcome);
			}
			executed.map_err(|error| (State::Failed, query_error(error, request.read_only)))?;
			return Ok(None);
		}

		let mut rows: Vec<Vec<Value>> = Vec::new();
		let mut bytes = 0usize;
		// The first storage class seen in each column. SQLite has no declared type for an
		// expression, and a value's own class is what the contract's `nativeType` names, so it
		// fills in where `sqlite3_column_decltype` returns nothing.
		let mut seen: Vec<Option<&'static str>> = vec![None; columns.len()];
		let cancelled = Arc::clone(&self.stop);
		let collection = (|| -> Result<(), RpcError> {
			let mut query = statement
				.query([])
				.map_err(|error| query_error(error, request.read_only))?;
			while let Some(row) = query
				.next()
				.map_err(|error| query_error(error, request.read_only))?
			{
				let mut cells = Vec::with_capacity(columns.len());
				let mut row_bytes = 0usize;
				for (index, slot) in seen.iter_mut().enumerate() {
					let value = row
						.get_ref(index)
						.map_err(|error| query_error(error, request.read_only))?;
					row_bytes += cell_size(&value);
					slot.get_or_insert(storage_class(&value));
					cells.push(cell(value)?);
				}
				bytes += row_bytes;
				rows.push(cells);
				if rows.len() > request.max_rows || bytes > request.max_bytes {
					return Err(RpcError::with_detail(
						ErrorKind::ResourceLimit,
						format!(
							"the result exceeded the limit of {} rows or {} bytes",
							request.max_rows, request.max_bytes
						),
					));
				}
			}
			Ok(())
		})();
		// A statement ended by the progress callback (timeout, or the session going away) never
		// completes, whatever SQLite reports for the interrupted step.
		if let Some(outcome) = Stop::load(&cancelled).outcome() {
			return Err(outcome);
		}
		collection.map_err(|error| (State::Failed, error))?;
		for (column, class) in columns.iter_mut().zip(&seen) {
			if column["nativeType"] == "ANY" {
				if let Some(class) = class {
					column["nativeType"] = json!(class);
				}
			}
		}

		let now = Instant::now();
		self.expire(now);
		// A script can produce more results than the session may hold. Dropping the oldest handle to
		// make room would expire it without telling its client, which `README.md` §7 forbids; the
		// statement fails with `RESOURCE_LIMIT` instead.
		if self.handles.len() >= MAX_CONCURRENT_EXECUTIONS {
			return Err((
				State::Failed,
				RpcError::with_detail(
					ErrorKind::ResourceLimit,
					format!(
						"at most {MAX_CONCURRENT_EXECUTIONS} executions can hold results at once"
					),
				),
			));
		}
		self.results += 1;
		let id = format!("{}r{}", self.prefix, self.results);
		self.handles.push(ResultSet {
			id: id.clone(),
			sequence: self.results,
			columns,
			rows,
			next: 0,
			expires_at: now + ttl,
		});
		Ok(Some(id))
	}

	/// Ends a statement once its deadline passes or the session is stopping.
	fn arm(&self, database: &Database, deadline: Instant) -> Result<(), RpcError> {
		let stop = Arc::clone(&self.stop);
		// A stop the session asked for keeps its reason; otherwise the deadline decides.
		database
			.connection()
			.progress_handler(
				PROGRESS_OPS,
				Some(move || {
					if Stop::load(&stop) != Stop::Running {
						return true;
					}
					if Instant::now() >= deadline {
						stop.store(Stop::TimedOut as u8, Ordering::SeqCst);
						return true;
					}
					false
				}),
			)
			.map_err(|error| {
				RpcError::with_detail(
					ErrorKind::Internal,
					format!("the query timeout could not be armed: {error}"),
				)
			})
	}

	fn disarm(&self, database: &Database) {
		database
			.connection()
			.progress_handler(0, None::<fn() -> bool>)
			.ok();
	}

	/// Keeps the replies bounded: the oldest execution and its handles go first.
	///
	/// Only a `getState` for an execution this old fails afterwards; forgetting a handle that early
	/// cannot happen, because a new result is only created while there is room for it (`step`).
	fn remember(&mut self, execution: Execution) {
		self.retained.push(execution);
		while self.retained.len() > MAX_RETAINED_EXECUTIONS {
			let stale = self.retained.remove(0);
			self.handles
				.retain(|handle| !stale.result_ids.contains(&handle.id));
		}
		self.expire(Instant::now());
	}
}

/// SQLite's name for the storage class of a value, which is what a column without a declared type
/// reports as its `nativeType`.
fn storage_class(value: &rusqlite::types::ValueRef<'_>) -> &'static str {
	use rusqlite::types::ValueRef;
	match value {
		ValueRef::Null => "NULL",
		ValueRef::Integer(_) => "INTEGER",
		ValueRef::Real(_) => "REAL",
		ValueRef::Text(_) => "TEXT",
		ValueRef::Blob(_) => "BLOB",
	}
}

/// Rough memory of one cell: the payload bytes it carries, plus a word for the JSON wrapper.
fn cell_size(value: &rusqlite::types::ValueRef<'_>) -> usize {
	use rusqlite::types::ValueRef;
	match value {
		ValueRef::Null => 0,
		ValueRef::Integer(_) | ValueRef::Real(_) => 8,
		ValueRef::Text(text) | ValueRef::Blob(text) => text.len(),
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

/// The `column` objects of a result page. An expression has no declared type, so its column
/// reports `ANY` — the storage class SQLite gives a value of any type — because the contract
/// requires a non-empty `nativeType`.
fn column_objects(statement: &Statement<'_>) -> Vec<Value> {
	statement
		.columns()
		.into_iter()
		.enumerate()
		.map(|(ordinal, column)| {
			let name = if column.name().is_empty() {
				format!("column{}", ordinal + 1)
			} else {
				column.name().to_owned()
			};
			let native_type = column
				.decl_type()
				.filter(|kind| !kind.is_empty())
				.unwrap_or("ANY");
			json!({"ordinal": ordinal, "name": name, "nativeType": native_type})
		})
		.collect()
}

/// Maps a SQLite failure during preparation or stepping onto the v1 error table without using its
/// message, which can carry SQL text or a file path (`README.md` §7).
///
/// The v1 table has no constraint kind and `v1/` is frozen (§8), so a statement the database
/// refused for its data — a `UNIQUE` or `NOT NULL` violation, an integer overflow, a malformed
/// function argument — is reported as `SQL_SYNTAX`: the statement was rejected, it just ran far
/// enough for SQLite to reject its input rather than its text. `sqlState` carries SQLite's extended
/// result code, so a client can tell the two apart without parsing `safeDetail`.
fn query_error(error: rusqlite::Error, read_only: bool) -> RpcError {
	// The bundled SQLite (3.38+) reports text the preparer rejects as `SqlInputError`, which
	// carries the SQL and an offset and whose `sqlite_error_code` is `None`; it is a statement
	// SQLite could not compile, which is what `SQL_SYNTAX` names. Its `error` member is the result
	// code SQLite attached (`1`, `SQLITE_ERROR`), which is the `sqlState` the sample records.
	if let rusqlite::Error::SqlInputError { error, .. } = &error {
		return RpcError::with_detail(
			ErrorKind::SqlSyntax,
			"the database rejected the SQL statement",
		)
		.with_sql_state(error.extended_code.to_string());
	}
	let Some(code) = error.sqlite_error_code() else {
		return RpcError::with_detail(ErrorKind::Internal, "unexpected SQLite driver error");
	};
	// The extended code is the base code plus SQLite's own sub-code (`2067` is
	// `SQLITE_CONSTRAINT_UNIQUE`); `sqlite_error_code` reads the same field, so it is always there.
	let extended = error
		.sqlite_extended_error_code()
		.unwrap_or_default()
		.to_string();
	let mapped = match code {
		ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => RpcError::with_detail(
			ErrorKind::QueryTimeout,
			"database is locked by another connection",
		),
		// SQLite reports every write attempt on a read-only connection this way, so the read-only
		// denial is recognized by the mode the driver was opened in, not by the SQL text.
		ErrorCode::ReadOnly => RpcError::with_detail(
			if read_only {
				ErrorKind::ReadOnlyDenied
			} else {
				ErrorKind::PermissionDenied
			},
			"the statement needs write access to the database",
		),
		ErrorCode::PermissionDenied | ErrorCode::AuthorizationForStatementDenied => {
			RpcError::with_detail(
				ErrorKind::PermissionDenied,
				"the database refused the statement",
			)
		}
		ErrorCode::OperationInterrupted => {
			RpcError::with_detail(ErrorKind::QueryCancelled, "the statement was interrupted")
		}
		ErrorCode::DiskFull | ErrorCode::TooBig | ErrorCode::OutOfMemory => RpcError::with_detail(
			ErrorKind::ResourceLimit,
			"the database ran out of resources",
		),
		// A `RAISE(ABORT, …)` trigger and every data-level rejection (constraint violation,
		// `TypeMismatch`, malformed input to a function) reach the client as `SQL_SYNTAX`; see the
		// function comment for why v1 has nowhere better to put them.
		ErrorCode::OperationAborted | ErrorCode::ConstraintViolation | ErrorCode::TypeMismatch => {
			RpcError::with_detail(ErrorKind::SqlSyntax, "the database rejected the statement")
		}
		_ => RpcError::with_detail(
			ErrorKind::SqlSyntax,
			"the database rejected the SQL statement",
		),
	};
	mapped.with_sql_state(extended)
}

fn milliseconds(elapsed: Duration) -> u64 {
	u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
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

/// The `RESULT_EXPIRED` error, for a handle this process does not hold (`README.md` §4:
/// "expired after release"). The session registry uses it for an id it never issued.
pub fn expired() -> RpcError {
	RpcError::with_detail(ErrorKind::ResultExpired, "result released or ttl exceeded")
}

fn invalid(detail: impl Into<String>) -> RpcError {
	RpcError::with_detail(ErrorKind::InvalidParams, detail)
}

#[cfg(test)]
mod tests {
	use std::path::Path;

	use super::*;
	use crate::sqlite::test_files::{text, TempDir};

	const TTL: Duration = Duration::from_secs(300);

	fn object(value: Value) -> Map<String, Value> {
		match value {
			Value::Object(map) => map,
			other => panic!("params must be an object: {other}"),
		}
	}

	fn request(sql: &str, mode: &str) -> Map<String, Value> {
		object(json!({
			"sessionId": "s_1",
			"sessionGeneration": 1,
			"sql": sql,
			"mode": mode,
			"timeoutMs": 30_000,
			"maxInitialRows": 200,
		}))
	}

	fn open(path: &Path, read_only: bool) -> Database {
		Database::open(text(path), read_only).unwrap()
	}

	/// Runs one statement and returns the registry and the ids of its results.
	fn executed(
		database: &Database,
		mut registry: Executions,
		sql: &str,
	) -> (Executions, Value, Vec<String>) {
		let reply = registry
			.execute(database, &request(sql, "statement"), TTL)
			.unwrap();
		let execution_id = reply["executionId"].clone();
		let state = registry
			.get_state(&object(json!({ "executionId": execution_id })))
			.unwrap();
		let ids = state["resultIds"]
			.as_array()
			.map(|ids| {
				ids.iter()
					.map(|id| id.as_str().unwrap().to_owned())
					.collect()
			})
			.unwrap_or_default();
		(registry, state, ids)
	}

	/// Runs `sql` in `script` mode and returns the registry and the ids of its results.
	fn scripted(
		database: &Database,
		mut registry: Executions,
		sql: &str,
	) -> (Executions, Value, Vec<String>) {
		let reply = registry
			.execute(database, &request(sql, "script"), TTL)
			.unwrap();
		let execution_id = reply["executionId"].clone();
		let state = registry
			.get_state(&object(json!({ "executionId": execution_id })))
			.unwrap();
		let ids = state["resultIds"]
			.as_array()
			.map(|ids| {
				ids.iter()
					.map(|id| id.as_str().unwrap().to_owned())
					.collect()
			})
			.unwrap_or_default();
		(registry, state, ids)
	}

	fn page(registry: &mut Executions, id: &str, cursor: Value, limit: u64) -> Value {
		registry
			.fetch_page(&object(
				json!({"resultId": id, "cursor": cursor, "limit": limit}),
			))
			.unwrap()
	}

	fn kind(result: Result<Value, RpcError>) -> ErrorKind {
		result.expect_err("expected a failure").kind
	}

	fn ids(prefix: &str) -> Executions {
		Executions::new(prefix)
	}

	#[test]
	fn execute_params_follow_the_method_schema() {
		let dir = TempDir::new("query-params");
		let database = open(&dir.database("db.sqlite"), true);
		let valid = request("SELECT 1", "statement");
		let with = |key: &str, value: Value| {
			let mut params = valid.clone();
			params.insert(key.to_owned(), value);
			params
		};
		let without = |key: &str| {
			let mut params = valid.clone();
			params.remove(key);
			params
		};
		let cases = [
			without("sql"),
			with("sql", json!("")),
			with("sql", json!(7)),
			without("mode"),
			with("mode", json!("batch")),
			without("timeoutMs"),
			with("timeoutMs", json!(0)),
			with("timeoutMs", json!(600_001)),
			with("timeoutMs", json!(1.5)),
			without("maxInitialRows"),
			with("maxInitialRows", json!(0)),
			with("maxInitialRows", json!(10_001)),
			with("cancelTokenId", json!("")),
			with("cancelTokenId", json!(7)),
			with("debug", json!(true)),
		];
		for case in cases {
			assert_eq!(
				kind(ids("s_1").execute(&database, &case, TTL)),
				ErrorKind::InvalidParams,
				"{case:?}"
			);
		}
		// The optional token is accepted when it is a non-empty string.
		assert!(ids("s_1")
			.execute(&database, &with("cancelTokenId", json!("cu_1")), TTL)
			.is_ok());
	}

	#[test]
	fn a_select_reports_completed_and_supplies_typed_cells() {
		let dir = TempDir::new("query-select");
		let database = open(&dir.database("db.sqlite"), true);
		let (mut registry, state, results) = executed(
			&database,
			ids("s_1"),
			"SELECT id, name FROM customers ORDER BY id",
		);
		assert_eq!(state["state"], "completed");
		assert_eq!(results.len(), 1);
		assert_eq!(state["resultIds"], json!([results[0]]));
		assert_eq!(state["error"], Value::Null);

		let page = page(&mut registry, &results[0], Value::Null, 200);
		assert_eq!(
			page["columns"],
			json!([
				{"ordinal": 0, "name": "id", "nativeType": "INTEGER"},
				{"ordinal": 1, "name": "name", "nativeType": "TEXT"},
			])
		);
		assert_eq!(
			page["rows"],
			json!([
				[{"type": "int64", "text": "1"}, {"type": "string", "value": "Ada"}],
				[{"type": "int64", "text": "2"}, {"type": "string", "value": "Grace"}],
			])
		);
		assert_eq!(page["hasMore"], false);
		assert_eq!(page["nextCursor"], Value::Null);
		assert_eq!(page["rowCountEstimate"], 2);
		assert_eq!(
			registry.active(),
			0,
			"the execution is over before the reply"
		);
		assert_eq!(registry.pending_results(), 1, "its result is still unread");
	}

	#[test]
	fn a_result_without_a_declared_type_reports_the_storage_class_it_holds() {
		let dir = TempDir::new("query-native-type");
		let database = open(&dir.database("db.sqlite"), true);
		let (mut registry, _, results) = executed(&database, ids("s_1"), "SELECT 1 AS answer");
		let fetched = page(&mut registry, &results[0], Value::Null, 200);
		assert_eq!(
			fetched["columns"],
			json!([{"ordinal": 0, "name": "answer", "nativeType": "INTEGER"}])
		);
		let (mut registry, _, results) =
			executed(&database, registry, "SELECT NULL AS empty_value");
		let fetched = page(&mut registry, &results[0], Value::Null, 200);
		assert_eq!(
			fetched["columns"],
			json!([{"ordinal": 0, "name": "empty_value", "nativeType": "NULL"}])
		);
	}

	#[test]
	fn pages_move_forward_only_and_the_cursor_is_checked() {
		let dir = TempDir::new("query-paging");
		let database = open(&dir.database("db.sqlite"), true);
		let (mut registry, _, results) = executed(
			&database,
			ids("s_1"),
			"SELECT name FROM customers ORDER BY name",
		);
		let id = &results[0];

		let first = page(&mut registry, id, Value::Null, 1);
		assert_eq!(first["rows"].as_array().unwrap().len(), 1);
		assert_eq!(first["hasMore"], true);
		assert_eq!(first["rowCountEstimate"], 2);
		let cursor = first["nextCursor"].clone();
		assert_eq!(cursor, "1");

		let second = page(&mut registry, id, cursor.clone(), 1);
		assert_eq!(
			second["rows"],
			json!([[{"type": "string", "value": "Grace"}]])
		);
		assert_eq!(second["hasMore"], false);
		assert_eq!(second["nextCursor"], Value::Null);

		// Replaying an earlier page would repeat rows, and skipping ahead would drop them.
		for stale in [cursor, json!("1")] {
			assert_eq!(
				kind(registry.fetch_page(&object(json!({
					"resultId": id, "cursor": stale, "limit": 1,
				})))),
				ErrorKind::InvalidParams,
				"{stale}"
			);
		}
		// `null` is "from where the handle is now", which is empty once the last page was read.
		let none = page(&mut registry, id, Value::Null, 1);
		assert_eq!(none["rows"], json!([]));
		for broken in [json!("x"), json!(1), json!(-1)] {
			assert_eq!(
				kind(registry.fetch_page(&object(json!({
					"resultId": id, "cursor": broken, "limit": 1,
				})))),
				ErrorKind::InvalidParams,
				"{broken}"
			);
		}
		// A third page past the end is empty, not an error.
		let end = page(&mut registry, id, json!("2"), 10);
		assert_eq!(end["rows"], json!([]));
		assert_eq!(end["hasMore"], false);
	}

	#[test]
	fn fetch_page_and_release_check_their_parameters() {
		let dir = TempDir::new("query-handles");
		let database = open(&dir.database("db.sqlite"), true);
		let (mut registry, _, results) = executed(&database, ids("s_1"), "SELECT 1 AS answer");
		let id = &results[0];

		for params in [
			json!({"resultId": id}),
			json!({"resultId": id, "limit": 0}),
			json!({"resultId": id, "limit": u64::from(MAX_PAGE_ROWS) + 1}),
			json!({"resultId": id, "limit": 1.5}),
			json!({"resultId": id, "limit": 1, "extra": true}),
			json!({"limit": 1}),
			json!({"resultId": "not an id", "limit": 1}),
			json!({"resultId": 7, "limit": 1}),
		] {
			assert_eq!(
				kind(registry.fetch_page(&object(params.clone()))),
				ErrorKind::InvalidParams,
				"{params}"
			);
		}
		for params in [
			json!({}),
			json!({"resultId": "not an id"}),
			json!({"resultId": id, "cursor": "0"}),
		] {
			assert_eq!(
				kind(registry.release(&object(params.clone()))),
				ErrorKind::InvalidParams,
				"{params}"
			);
		}

		// Release is idempotent and an unknown handle is expired, not an error of its own.
		assert_eq!(
			registry.release(&object(json!({"resultId": id}))).unwrap(),
			json!({"released": true})
		);
		assert_eq!(
			registry.release(&object(json!({"resultId": id}))).unwrap(),
			json!({"released": true})
		);
		assert_eq!(
			kind(registry.fetch_page(&object(json!({"resultId": id, "limit": 1})))),
			ErrorKind::ResultExpired
		);
		assert_eq!(registry.pending_results(), 0);
	}

	#[test]
	fn invalid_sql_fails_with_sql_syntax_and_get_state_keeps_the_execution() {
		let dir = TempDir::new("query-syntax");
		let database = open(&dir.database("db.sqlite"), true);
		let mut registry = ids("s_1");
		let error = registry
			.execute(&database, &request("SELECT FROM WHERE", "statement"), TTL)
			.unwrap_err();
		assert_eq!(error.kind, ErrorKind::SqlSyntax);
		let execution = error
			.execution_id
			.clone()
			.expect("the failure names its execution");
		assert!(is_valid_id(&execution));

		let state = registry
			.get_state(&object(json!({"executionId": execution})))
			.unwrap();
		assert_eq!(state["state"], "failed");
		assert_eq!(state["error"]["data"]["kind"], "SQL_SYNTAX");
		assert_eq!(state["resultIds"], Value::Null);
		assert_eq!(registry.pending_results(), 0);
	}

	#[test]
	fn a_stop_that_did_not_close_the_session_can_be_taken_back() {
		let dir = TempDir::new("query-resume");
		let database = open(&dir.database("db.sqlite"), true);
		let mut registry = ids("s_1");
		registry.request_stop();
		// A stop ends whatever runs next, which is what a closing session needs.
		let error = registry
			.execute(&database, &request("SELECT 1 AS answer", "statement"), TTL)
			.unwrap_err();
		assert_eq!(error.kind, ErrorKind::QueryCancelled);

		// The session stays usable once the stop is taken back, as `connection.close` does when
		// the database refuses to close and the session has to stay open.
		registry.resume();
		let (_, state, results) = executed(&database, registry, "SELECT 1 AS answer");
		assert_eq!(state["state"], "completed");
		assert_eq!(results.len(), 1);
	}

	#[test]
	fn a_read_only_session_lets_sqlite_refuse_every_kind_of_write() {
		let dir = TempDir::new("query-read-only");
		let path = dir.database("db.sqlite");
		let read_only = open(&path, true);
		let mut registry = ids("s_1");
		// The enforcement is SQLite's own read-only mode, so it covers DML, DDL and a PRAGMA with
		// a side effect alike, with no inspection of the SQL text (`25-engineering-rules.md` §7).
		for sql in [
			"INSERT INTO customers(name) VALUES ('Turing')",
			"UPDATE customers SET name = 'Turing'",
			"DELETE FROM customers",
			"CREATE TABLE extra(x INTEGER)",
			"DROP TABLE customers",
			"CREATE INDEX extra_index ON customers(name)",
			"ALTER TABLE customers ADD COLUMN note TEXT",
		] {
			let error = registry
				.execute(&read_only, &request(sql, "statement"), TTL)
				.unwrap_err();
			assert_eq!(error.kind, ErrorKind::ReadOnlyDenied, "{sql}");
		}

		// Nothing was written, and reads still work on the same session.
		let (mut registry, state, results) =
			executed(&read_only, registry, "SELECT count(*) FROM customers");
		assert_eq!(state["state"], "completed");
		let page = page(&mut registry, &results[0], Value::Null, 10);
		assert_eq!(page["rows"], json!([[{"type": "int64", "text": "2"}]]));
		let objects = read_only
			.list_objects(&object(json!({
				"sessionId": "s_1", "sessionGeneration": 1, "limit": 50,
			})))
			.unwrap();
		assert_eq!(
			objects["objects"].as_array().unwrap().len(),
			3,
			"the schema is untouched: {objects}"
		);
	}

	#[test]
	fn a_statement_that_writes_reports_no_result_and_fails_on_a_read_only_session() {
		let dir = TempDir::new("query-write");
		let path = dir.database("db.sqlite");

		let read_only = open(&path, true);
		let mut registry = ids("s_1");
		let error = registry
			.execute(
				&read_only,
				&request("DELETE FROM customers", "statement"),
				TTL,
			)
			.unwrap_err();
		assert_eq!(error.kind, ErrorKind::ReadOnlyDenied);

		// The same statement on a read-write session runs and leaves no result handle.
		let writable = open(&path, false);
		let (registry, state, results) = executed(
			&writable,
			ids("s_2"),
			"INSERT INTO customers(name) VALUES ('Turing')",
		);
		assert_eq!(state["state"], "completed");
		assert_eq!(results, Vec::<String>::new());
		assert_eq!(state["resultIds"], Value::Null);
		assert_eq!(registry.pending_results(), 0);

		let count = open(&path, true);
		let (mut registry, _, results) =
			executed(&count, registry, "SELECT count(*) FROM customers");
		let page = page(&mut registry, &results[0], Value::Null, 200);
		assert_eq!(page["rows"], json!([[{"type": "int64", "text": "3"}]]));
	}

	#[test]
	fn script_mode_runs_every_statement_and_statement_mode_refuses_more_than_one() {
		let dir = TempDir::new("query-script");
		let database = open(&dir.database("db.sqlite"), true);
		let script = "SELECT 1 AS a; SELECT 2 AS b;";
		let (mut registry, state, results) = scripted(&database, ids("s_1"), script);
		assert_eq!(state["state"], "completed");
		assert_eq!(results.len(), 2);
		for (id, value) in results.iter().zip(["1", "2"]) {
			let page = page(&mut registry, id, Value::Null, 200);
			assert_eq!(page["rows"], json!([[{"type": "int64", "text": value}]]));
		}

		// A semicolon inside a literal is not a statement separator.
		let (mut registry, state, results) =
			executed(&database, ids("s_2"), "SELECT 'a;b' AS text_value");
		assert_eq!(state["state"], "completed");
		let page = page(&mut registry, &results[0], Value::Null, 200);
		assert_eq!(page["rows"], json!([[{"type": "string", "value": "a;b"}]]));

		// `statement` mode answers one statement only; a second one is refused rather than dropped.
		let mut registry = ids("s_3");
		let error = registry
			.execute(&database, &request(script, "statement"), TTL)
			.unwrap_err();
		assert_eq!(error.kind, ErrorKind::InvalidParams);
		// Nothing from the refused call is left behind.
		assert_eq!(registry.pending_results(), 0);

		// Empty text holds no statement.
		for sql in ["", " ", "-- just a comment", ";"] {
			let mut registry = ids("s_4");
			let error = registry
				.execute(&database, &request(sql, "script"), TTL)
				.unwrap_err();
			assert!(
				matches!(error.kind, ErrorKind::InvalidParams),
				"{sql:?}: {error}"
			);
		}
	}

	#[test]
	fn results_are_bounded_by_rows_and_released_with_the_session() {
		let dir = TempDir::new("query-limits");
		let database = open(&dir.database("db.sqlite"), true);
		let mut registry = ids("s_1");
		// Three rows are more than the two the client allowed.
		let mut params = request(
			"SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3",
			"statement",
		);
		params.insert("maxInitialRows".into(), json!(2));
		let error = registry.execute(&database, &params, TTL).unwrap_err();
		assert_eq!(error.kind, ErrorKind::ResourceLimit);
		assert_eq!(registry.pending_results(), 0);

		// Unread results are held up to the advertised limit; one more is refused until a release.
		let mut registry = ids("s_2");
		let mut last = None;
		for _ in 0..MAX_CONCURRENT_EXECUTIONS {
			let (next, _, results) = executed(&database, registry, "SELECT 1 AS answer");
			registry = next;
			last = results.first().cloned();
		}
		assert_eq!(registry.pending_results(), MAX_CONCURRENT_EXECUTIONS);
		let error = registry
			.execute(&database, &request("SELECT 1", "statement"), TTL)
			.unwrap_err();
		assert_eq!(error.kind, ErrorKind::ResourceLimit);
		registry
			.release(&object(json!({"resultId": last.unwrap()})))
			.unwrap();
		let (registry, _, results) = executed(&database, registry, "SELECT 1 AS answer");
		assert_eq!(registry.pending_results(), MAX_CONCURRENT_EXECUTIONS);
		assert_eq!(results.len(), 1);
	}

	#[test]
	fn a_session_holds_at_most_four_unread_results() {
		let dir = TempDir::new("query-concurrent");
		let database = open(&dir.database("db.sqlite"), true);
		let mut registry = ids("s_1");
		let mut first = None;
		for _ in 0..MAX_CONCURRENT_EXECUTIONS {
			let (next, _, results) = executed(&database, registry, "SELECT 1 AS answer");
			registry = next;
			first.get_or_insert(results[0].clone());
		}
		let error = registry
			.execute(&database, &request("SELECT 1", "statement"), TTL)
			.unwrap_err();
		assert_eq!(error.kind, ErrorKind::ResourceLimit);
		// The refused call ran nothing: it names no execution and holds no result.
		assert_eq!(error.execution_id, None);
		assert_eq!(registry.pending_results(), MAX_CONCURRENT_EXECUTIONS);
		registry
			.release(&object(json!({"resultId": first.unwrap()})))
			.unwrap();
		let (_, _, results) = executed(&database, registry, "SELECT 1 AS answer");
		assert_eq!(
			results.len(),
			1,
			"a release makes room for the next execution"
		);
	}

	#[test]
	fn a_query_that_runs_past_its_deadline_ends_cancelled_as_a_timeout() {
		let dir = TempDir::new("query-timeout");
		let database = open(&dir.database("db.sqlite"), true);
		let mut registry = ids("s_1");
		// A recursive count large enough that the deadline passes while it runs.
		let mut params = request(
			"WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 200000000)
			SELECT count(*) FROM n",
			"statement",
		);
		params.insert("timeoutMs".into(), json!(20));
		let started = Instant::now();
		let error = registry.execute(&database, &params, TTL).unwrap_err();
		assert_eq!(error.kind, ErrorKind::QueryTimeout);
		assert!(
			started.elapsed() < Duration::from_secs(20),
			"the statement did not end at its deadline"
		);
		// The execution it named ended as cancelled, not completed, and holds no result.
		let execution = error
			.execution_id
			.clone()
			.expect("the failure names its execution");
		let state = registry
			.get_state(&object(json!({"executionId": execution})))
			.unwrap();
		assert_eq!(state["state"], "cancelled", "{state}");
		assert_eq!(state["error"]["data"]["kind"], "QUERY_TIMEOUT");
		assert_eq!(registry.pending_results(), 0);
		// The next execution starts with a fresh deadline.
		let (registry, state, _) = executed(&database, registry, "SELECT 1 AS answer");
		assert_eq!(state["state"], "completed");
		assert_eq!(registry.pending_results(), 1);
	}

	#[test]
	fn get_state_and_cancel_check_their_parameters_and_names() {
		let dir = TempDir::new("query-state");
		let database = open(&dir.database("db.sqlite"), true);
		let (mut registry, state, _) = executed(&database, ids("s_1"), "SELECT 1 AS answer");
		let id = state["executionId"].as_str().unwrap().to_owned();

		assert_eq!(
			kind(registry.get_state(&object(json!({"executionId": id, "wait": true})))),
			ErrorKind::InvalidParams
		);
		assert_eq!(
			kind(registry.get_state(&object(json!({"executionId": "nope"})))),
			ErrorKind::InvalidParams
		);
		assert_eq!(
			kind(registry.get_state(&object(json!({})))),
			ErrorKind::InvalidParams
		);
		// An execution id of another session is unknown here.
		assert_eq!(
			kind(registry.get_state(&object(json!({"executionId": "s_other_e1"})))),
			ErrorKind::InvalidParams
		);
		// Nothing runs while a request is served, so cancel is refused and reports the state.
		let refused = registry
			.cancel(&object(json!({"executionId": id, "reason": "user"})))
			.unwrap();
		assert_eq!(refused, json!({"accepted": false, "state": "completed"}));
		for params in [
			json!({"executionId": id, "reason": "later"}),
			json!({"executionId": id, "extra": 1}),
			json!({"executionId": 7}),
		] {
			assert_eq!(
				kind(registry.cancel(&object(params.clone()))),
				ErrorKind::InvalidParams,
				"{params}"
			);
		}

		// The oldest retained executions are forgotten, and their handles with them. Each result is
		// released right away so that the handle limit does not stop the loop first.
		let mut registry = ids("s_2");
		let mut oldest = None;
		for _ in 0..MAX_RETAINED_EXECUTIONS {
			let (mut next, state, results) = executed(&database, registry, "SELECT 1 AS answer");
			for result in &results {
				next.release(&object(json!({"resultId": result}))).unwrap();
			}
			registry = next;
			oldest.get_or_insert((state, results));
		}
		let (state, results) = oldest.unwrap();
		let id = state["executionId"].as_str().unwrap().to_owned();
		assert!(registry
			.get_state(&object(json!({"executionId": id})))
			.is_ok());
		let (mut registry, ..) = executed(&database, registry, "SELECT 1 AS answer");
		assert_eq!(
			kind(registry.get_state(&object(json!({"executionId": id})))),
			ErrorKind::InvalidParams,
			"the oldest execution was forgotten"
		);
		assert_eq!(
			kind(registry.fetch_page(&object(json!({"resultId": results[0], "limit": 1})))),
			ErrorKind::ResultExpired,
			"its handle went with it"
		);
	}

	#[test]
	fn a_rejected_statement_carries_the_database_result_code() {
		let dir = TempDir::new("query-sql-state");
		let path = dir.database("db.sqlite");
		let writable = open(&path, false);
		let mut registry = ids("s_1");

		// Text SQLite cannot compile: `SQLITE_ERROR` (1), the value the sample records.
		let error = registry
			.execute(&writable, &request("SELECT FROM", "statement"), TTL)
			.unwrap_err();
		assert_eq!(error.kind, ErrorKind::SqlSyntax);
		assert_eq!(
			error.sql_state.as_deref(),
			Some("1"),
			"a preparer rejection reports SQLITE_ERROR"
		);

		writable
			.connection()
			.execute_batch("CREATE TABLE keyed(id INTEGER PRIMARY KEY, code TEXT UNIQUE);")
			.unwrap();
		// A constraint violation rejects the data, not the text. v1 has no constraint kind, so it
		// is reported as a rejection with SQLite's own extended code: `SQLITE_CONSTRAINT_PRIMARYKEY`
		// (1555) and `SQLITE_CONSTRAINT_UNIQUE` (2067).
		for (sql, code) in [
			(
				"INSERT INTO keyed(id, code) VALUES (1, 'a'); INSERT INTO keyed(id, code) VALUES (1, 'b')",
				"1555",
			),
			(
				"INSERT INTO keyed(id, code) VALUES (2, 'a')",
				"2067",
			),
		] {
			let error = registry.execute(&writable, &request(sql, "script"), TTL).unwrap_err();
			assert_eq!(error.kind, ErrorKind::SqlSyntax, "{sql}");
			assert_eq!(error.sql_state.as_deref(), Some(code), "{sql}");
		}
		// Only the first insert of the first script committed; nothing was written twice.
		let rows: i64 = writable
			.connection()
			.query_row("SELECT count(*) FROM keyed", [], |row| row.get(0))
			.unwrap();
		assert_eq!(rows, 1);

		// A failure that is not a statement rejection keeps its own kind and still names the code.
		writable
			.connection()
			.execute_batch("PRAGMA journal_mode = DELETE;")
			.unwrap();
		let error = registry
			.execute(
				&writable,
				&request("INSERT INTO missing_table VALUES (1)", "statement"),
				TTL,
			)
			.unwrap_err();
		assert_eq!(error.kind, ErrorKind::SqlSyntax);
		assert_eq!(error.sql_state.as_deref(), Some("1"));
	}

	#[test]
	fn a_timeout_on_a_statement_without_columns_ends_cancelled_as_a_timeout() {
		let dir = TempDir::new("query-timeout-dml");
		let path = dir.database("db.sqlite");
		let writable = open(&path, false);
		let mut registry = ids("s_1");
		// `INSERT … SELECT` has no result columns, so it takes the `execute` path rather than the
		// row walk; the timeout must still end it as a timeout, not as an interruption SQLite
		// reported on its own.
		let mut params = request(
			"INSERT INTO customers(name)
			WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 200000000)
			SELECT 'slow' FROM n",
			"statement",
		);
		params.insert("timeoutMs".into(), json!(20));
		let error = registry.execute(&writable, &params, TTL).unwrap_err();
		assert_eq!(error.kind, ErrorKind::QueryTimeout);
		let execution = error.execution_id.clone().expect("named execution");
		let state = registry
			.get_state(&object(json!({"executionId": execution})))
			.unwrap();
		assert_eq!(
			state["state"], "cancelled",
			"a timeout is a cancellation, not a failure of the statement: {state}"
		);
		assert_eq!(state["error"]["data"]["kind"], "QUERY_TIMEOUT");
		// Nothing of the interrupted write is visible.
		let rows: i64 = writable
			.connection()
			.query_row("SELECT count(*) FROM customers", [], |row| row.get(0))
			.unwrap();
		assert_eq!(rows, 2);
	}

	#[test]
	fn a_page_is_bounded_by_the_frame_the_reply_has_to_fit_in() {
		let dir = TempDir::new("query-page-frame");
		let path = dir.join("blobs.sqlite");
		// Seven blobs of 1 MiB each: one row is about 9.3 MiB of base64 in JSON, which no frame can
		// hold, and the second row would push a two-row page past `frameMaxBytes` as well.
		rusqlite::Connection::open(&path)
			.unwrap()
			.execute_batch(
				"CREATE TABLE blobs(a BLOB, b BLOB, c BLOB, d BLOB, e BLOB, f BLOB, g BLOB);
				INSERT INTO blobs VALUES (zeroblob(1048576), zeroblob(1048576), zeroblob(1048576),
					zeroblob(1048576), zeroblob(1048576), zeroblob(1048576), zeroblob(1048576));
				INSERT INTO blobs VALUES (zeroblob(1048576), zeroblob(1048576), zeroblob(1048576),
					zeroblob(1048576), zeroblob(1048576), zeroblob(1048576), zeroblob(1048576));",
			)
			.unwrap();
		let database = Database::open(text(&path), true).unwrap();
		let mut registry = ids("s_1");
		// `SELECT *` of one row already exceeds the frame budget, so the statement itself is
		// refused rather than collected into a result no page could return.
		let mut small = request("SELECT * FROM blobs", "statement");
		small.insert("maxInitialRows".into(), json!(1));
		let error = registry.execute(&database, &small, TTL).unwrap_err();
		assert_eq!(
			error.kind,
			ErrorKind::ResourceLimit,
			"a result the transport could never carry is refused at collection time"
		);

		// Many rows of manageable size: the page stops at the frame budget with `hasMore`, and the
		// client walks the rest with the cursor instead of losing the connection.
		// 2500 rows of about 4 KiB are ~10 MiB of JSON, over `frameMaxBytes` but under the
		// collection limit: a 1000-row page must be cut at the frame budget even though `limit`
		// allows more.
		let mut registry = ids("s_2");
		let mut params = request(
			"WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 2500)
			SELECT x, hex(zeroblob(2000)) AS padding FROM n",
			"statement",
		);
		params.insert("maxInitialRows".into(), json!(2500));
		let reply = registry.execute(&database, &params, TTL).unwrap();
		let execution = reply["executionId"].clone();
		let state = registry
			.get_state(&object(json!({"executionId": execution})))
			.unwrap();
		let result = state["resultIds"][0].as_str().unwrap().to_owned();
		let mut pages = 0;
		let mut rows = 0;
		let mut cursor = Value::Null;
		loop {
			let page = registry
				.fetch_page(&object(json!({
					"resultId": result, "cursor": cursor, "limit": 1000,
				})))
				.unwrap();
			let fetched = page["rows"].as_array().unwrap().len();
			assert!(
				fetched as u64 <= 1000,
				"the limit is an upper bound, a page never exceeds it"
			);
			assert!(
				serde_json::to_vec(&page).unwrap().len() <= DEFAULT_FRAME_MAX_BYTES as usize,
				"every page fits one frame"
			);
			rows += fetched;
			pages += 1;
			if page["hasMore"] != true {
				break;
			}
			cursor = page["nextCursor"].clone();
		}
		assert_eq!(rows, 2500, "no row is lost at a page boundary");
		assert!(pages > 1, "the frame budget forced more than one page");
	}
}
