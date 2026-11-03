/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! The session worker: the thread that owns one session's SQLite connection, runs its
//! statements and reports what it found (N-106, N-108).
//!
//! rusqlite's `Connection` is `Send` but not `Sync`, so at most one thread may use it at a time.
//! A session therefore moves its `Database` into a [`Worker`] thread and the request loop keeps
//! only an interrupt handle, which SQLite accepts from any thread. That is what lets
//! `query.cancel` reach a statement while it runs: the loop calls `sqlite3_interrupt`, the worker's
//! step fails with `SQLITE_INTERRUPT`, and the execution ends as `cancelled` (`query.rs`).
//!
//! A worker runs one command at a time, because one connection does: a `query.execute` that
//! arrives while another execution runs waits in the command queue. It reports the first
//! prepared statement before it runs anything, so that a statement SQLite cannot compile is
//! answered with the structured error (`conformance.ndjson` rq_009) rather than with `queued`.
//!
//! The worker owns the session's only connection, so it also owns the session's transaction
//! state. v1 has no `transaction.*` method: a script that opens a transaction with `BEGIN` or
//! `SAVEPOINT` is the only way to one. When such a script ends in an error or a stop, the worker
//! rolls back to the level it found, so a half-run script cannot leave its locks and its partial
//! writes on the connection for the next execution.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use rusqlite::fallible_iterator::FallibleIterator;
use rusqlite::{Batch, ErrorCode, Statement};
use serde_json::{json, Map, Value};

use crate::error::{ErrorKind, Rollback, RpcError};
use crate::events::{self, Event};
use crate::sqlite::{ConnectionInterrupt, Database};
use crate::value::cell;

/// Rows one result may hold. Collection stops here rather than silently truncating
/// (`nyala/rpc/README.md` §7); a larger result needs the streaming cursor of N-107.
pub const MAX_RESULT_ROWS: usize = 10_000;

/// Approximate bytes one result may hold, counted as the length of the text and blob cells plus
/// one word per cell. A cheap bound on what a single query can pin in memory.
pub const MAX_RESULT_BYTES: usize = 16 * 1024 * 1024;

/// Statement polls between two looks at the clock, so a timeout is noticed quickly without a
/// syscall per instruction.
const PROGRESS_OPS: std::ffi::c_int = 1_000;

/// How long `connection.close` waits for the worker to close its connection before reporting that
/// it could not.
const WORKER_STOP_TIMEOUT: Duration = Duration::from_secs(5);

/// Why a statement was stopped, stored in the flag the worker shares with the request loop.
///
/// Every execution owns its flag, so a statement that `timeoutMs` ends is a timeout even if the
/// session starts closing at the same moment; a stop the session or a client asked for is a
/// cancellation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
	Running = 0,
	TimedOut = 1,
	Cancelled = 2,
}

impl Stop {
	fn flag() -> Arc<AtomicU8> {
		Arc::new(AtomicU8::new(Stop::Running as u8))
	}

	fn load(stop: &AtomicU8) -> Stop {
		match stop.load(Ordering::SeqCst) {
			1 => Stop::TimedOut,
			2 => Stop::Cancelled,
			_ => Stop::Running,
		}
	}

	fn store(stop: &AtomicU8, reason: Stop) {
		stop.store(reason as u8, Ordering::SeqCst);
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

/// A state of the `README.md` §5 machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
	Queued,
	Running,
	Completed,
	Failed,
	Cancelled,
	CancelRequested,
	Unknown,
}

impl State {
	pub fn as_str(self) -> &'static str {
		match self {
			State::Queued => "queued",
			State::Running => "running",
			State::Completed => "completed",
			State::Failed => "failed",
			State::Cancelled => "cancelled",
			State::CancelRequested => "cancel_requested",
			State::Unknown => "unknown",
		}
	}

	/// A state the execution does not leave; the contract sends no notification after one.
	pub fn is_terminal(self) -> bool {
		matches!(
			self,
			State::Completed | State::Failed | State::Cancelled | State::Unknown
		)
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

/// One execution as the worker receives it.
pub(crate) struct Job {
	/// The execution id, issued by the registry before the job was handed over.
	pub(crate) execution: String,
	request: Request,
	/// Set by `query.cancel` or by the session closing; the worker's progress callback reads it.
	stop: Arc<AtomicU8>,
	/// Result handles this execution may still create, so a script cannot push the session over
	/// `maxConcurrentExecutions` on its own. It is the count the registry saw at admission; jobs
	/// admitted while another one is queued share it, so the registry re-checks the total when it
	/// installs the handles ([`crate::query::Executions::finished`]).
	spare_results: usize,
}

impl Job {
	/// Validates `params` and builds the job. `spare_results` is how many result handles the
	/// session may still hold.
	pub(crate) fn parse(
		execution: &str,
		params: &Map<String, Value>,
		read_only: bool,
		spare_results: usize,
	) -> Result<Job, RpcError> {
		Ok(Job {
			execution: execution.to_owned(),
			request: Request::parse(params, read_only)?,
			stop: Stop::flag(),
			spare_results,
		})
	}

	/// The flag `query.cancel` and the session closing set. The registry keeps a clone.
	pub(crate) fn stop(&self) -> Arc<AtomicU8> {
		Arc::clone(&self.stop)
	}

	/// The execution id the reply names.
	pub(crate) fn execution(&self) -> &str {
		&self.execution
	}

	/// How many result handles the session can still hold when the job starts.
	#[cfg(test)]
	pub(crate) fn spare_results(&self) -> usize {
		self.spare_results
	}
}

/// The columns and rows one statement produced. The registry turns this into a result handle
/// with an id and an expiry when the execution ends.
pub(crate) struct Collected {
	pub(crate) columns: Vec<Value>,
	pub(crate) rows: Vec<Vec<Value>>,
}

impl std::fmt::Debug for Collected {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Collected")
			.field("rows", &self.rows.len())
			.finish_non_exhaustive()
	}
}

/// How an execution ended on the worker.
#[derive(Debug)]
pub(crate) struct Outcome {
	pub(crate) state: State,
	pub(crate) error: Option<RpcError>,
	pub(crate) results: Vec<Collected>,
	pub(crate) elapsed_ms: u64,
	/// Set when the execution failed without handing over its results.
	pub(crate) rollback: Option<Rollback>,
}

impl Outcome {
	/// The outcome of an execution the worker never ran.
	fn stopped(outcome: (State, RpcError)) -> Outcome {
		Outcome {
			state: outcome.0,
			error: Some(outcome.1),
			results: Vec::new(),
			elapsed_ms: 0,
			rollback: None,
		}
	}
}

/// One `metadata.*` call the worker runs on the session's connection.
#[derive(Debug, Clone, Copy)]
pub(crate) enum MetadataCall {
	ListObjects,
	Describe,
}

/// What the request loop asks a session worker to do.
enum Command {
	Execute(Job),
	Metadata {
		call: MetadataCall,
		params: Map<String, Value>,
		/// The request the answer completes; it travels back in [`Event::Metadata`].
		request: String,
	},
	Shutdown {
		ack: mpsc::Sender<Result<(), RpcError>>,
	},
}

/// The worker thread of one session: it owns the [`Database`] and runs what the request loop hands
/// over. The request loop keeps only [`Worker::interrupt`], which SQLite allows from any thread.
pub(crate) struct Worker {
	session: String,
	commands: mpsc::Sender<Command>,
	interrupt: Arc<ConnectionInterrupt>,
	joined: Option<thread::JoinHandle<()>>,
}

impl std::fmt::Debug for Worker {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Worker")
			.field("session", &self.session)
			.finish_non_exhaustive()
	}
}

impl Worker {
	/// Starts the thread that owns `database`. It reports what it runs through `events`.
	pub(crate) fn spawn(
		session: &str,
		database: Database,
		events: events::Sender,
	) -> Result<Worker, RpcError> {
		let interrupt = Arc::new(database.interrupt_handle());
		let (commands, receiver) = mpsc::channel();
		let name = format!("nyala-session-{session}");
		let worker_session = session.to_owned();
		let worker_events = events.clone();
		let joined = thread::Builder::new()
			.name(name)
			.spawn(move || {
				// A panic is a bug, but it must not leave the client without an answer: the
				// executions in flight become `unknown` (`README.md` §5).
				let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
					worker_loop(database, receiver, &worker_session, &worker_events);
				}))
				.is_err();
				if panicked {
					events::report(
						&worker_events,
						Event::WorkerGone {
							session: worker_session,
						},
					);
				}
			})
			.map_err(|error| {
				RpcError::with_detail(
					ErrorKind::Internal,
					format!("the session worker could not be started: {error}"),
				)
			})?;
		Ok(Worker {
			session: session.to_owned(),
			commands,
			interrupt,
			joined: Some(joined),
		})
	}

	/// Hands one execution to the worker. `Err` means the worker is gone.
	pub(crate) fn execute(&self, job: Job) -> Result<(), RpcError> {
		self.send(Command::Execute(job))
	}

	/// Runs one `metadata.*` call on the connection and reports the answer to the request loop.
	/// The loop does not wait for it: the connection serves one call at a time, and a call queued
	/// behind a running statement must not hold back `query.cancel`.
	pub(crate) fn metadata(
		&self,
		request: String,
		call: MetadataCall,
		params: Map<String, Value>,
	) -> Result<(), RpcError> {
		self.send(Command::Metadata {
			call,
			params,
			request,
		})
	}

	/// Ends the statement running on this connection, if any. Safe to call from the request loop:
	/// SQLite accepts the interrupt from another thread, and the handle does nothing once the
	/// connection has closed.
	pub(crate) fn interrupt(&self) {
		self.interrupt.interrupt();
	}

	/// Asks the worker to close the connection and waits for its answer. On `Err` the connection
	/// is still open and the worker keeps serving, so the session stays usable.
	pub(crate) fn shutdown(&mut self) -> Result<(), RpcError> {
		let (ack, answer) = mpsc::channel();
		if self.commands.send(Command::Shutdown { ack }).is_err() {
			self.join();
			return Ok(());
		}
		match answer.recv_timeout(WORKER_STOP_TIMEOUT) {
			Ok(Ok(())) => {
				self.join();
				Ok(())
			}
			Ok(Err(error)) => Err(error),
			Err(_) => Err(RpcError::with_detail(
				ErrorKind::Internal,
				"the session worker did not close its connection in time",
			)),
		}
	}

	/// Stops serving without an answer: used when the whole registry goes away.
	pub(crate) fn stop(&mut self) {
		let (ack, _answer) = mpsc::channel();
		let _ = self.commands.send(Command::Shutdown { ack });
		self.interrupt();
		self.join();
	}

	fn join(&mut self) {
		if let Some(joined) = self.joined.take() {
			let _ = joined.join();
		}
	}

	fn send(&self, command: Command) -> Result<(), RpcError> {
		self.commands
			.send(command)
			.map_err(|_| RpcError::with_detail(ErrorKind::Internal, "the session worker is gone"))
	}
}

impl Drop for Worker {
	fn drop(&mut self) {
		// Stopping first gives the connection a chance to close in order; dropping the command
		// sender alone would make the worker loop exit without waiting for it.
		if self.joined.is_some() {
			self.stop();
		}
	}
}

/// The worker main loop: owns `database` for as long as it runs.
fn worker_loop(
	mut database: Database,
	commands: mpsc::Receiver<Command>,
	session: &str,
	events: &events::Sender,
) {
	while let Ok(command) = commands.recv() {
		match command {
			Command::Execute(job) => {
				if let Err(error) = prepare(&database, &job) {
					events::report(
						events,
						Event::Prepared {
							session: session.to_owned(),
							execution: job.execution,
							error: Some(error),
						},
					);
					continue;
				}
				let execution = job.execution.clone();
				events::report(
					events,
					Event::Prepared {
						session: session.to_owned(),
						execution: execution.clone(),
						error: None,
					},
				);
				// A cancel can arrive before the worker gets here; the statement must then not run
				// at all.
				if let Some(outcome) = Stop::load(&job.stop).outcome() {
					events::report(
						events,
						Event::Finished {
							session: session.to_owned(),
							execution,
							outcome: Outcome::stopped(outcome),
						},
					);
					continue;
				}
				events::report(
					events,
					Event::Started {
						session: session.to_owned(),
						execution: execution.clone(),
					},
				);
				let outcome = run(&database, &job);
				events::report(
					events,
					Event::Finished {
						session: session.to_owned(),
						execution,
						outcome,
					},
				);
			}
			Command::Metadata {
				call,
				params,
				request,
			} => {
				let result = match call {
					MetadataCall::ListObjects => database.list_objects(&params),
					MetadataCall::Describe => database.describe(&params),
				};
				events::report(
					events,
					Event::Metadata {
						session: session.to_owned(),
						request,
						result,
					},
				);
			}
			Command::Shutdown { ack } => match database.close() {
				Ok(()) => {
					let _ = ack.send(Ok(()));
					return;
				}
				Err((open, error)) => {
					// The connection is still open, so the worker keeps serving and the session
					// stays usable, exactly as `connection.close` reports it.
					database = open;
					let _ = ack.send(Err(error));
				}
			},
		}
	}
	// Every command sender is gone: close the connection on the way out.
	let _ = database.close();
}

/// Prepares the first statement of the job and checks the statement-count rules, without running
/// anything. Its error is the one `query.execute` replies with (`conformance.ndjson` rq_009).
fn prepare(database: &Database, job: &Job) -> Result<(), RpcError> {
	let request = &job.request;
	let mut batch = Batch::new(database.connection(), &request.sql);
	let Some(_statement) = batch
		.next()
		.map_err(|error| query_error(error, request.read_only))?
	else {
		return Err(invalid("the SQL text contains no statement"));
	};
	if request.mode == Mode::Single {
		// A second statement means the caller sent more than one; answering the first and
		// dropping the rest would be a silent partial execution of a write script.
		if batch
			.next()
			.map_err(|error| query_error(error, request.read_only))?
			.is_some()
		{
			return Err(invalid(
				"mode statement and selection run one statement; use mode script",
			));
		}
	}
	Ok(())
}

/// Arms the timeout, runs the statements and disarms it again.
///
/// When the script ends in an error or a stop, a transaction it opened is rolled back before the
/// outcome is reported. The connection belongs to the session, not to the execution: leaving it
/// inside a transaction would keep its locks and its half-applied writes for every later
/// execution, and v1 has no `transaction.*` method with which a client could end it. Only what
/// this script opened is rolled back; a transaction that was already open on the connection is
/// left to whoever opened it.
///
/// A failed execution reports what it did to the database in `rollback` (`executionRollback` on
/// the error): a failure whose statements all changed nothing or were undone says `rolled_back`,
/// and one that may have committed is reported as `unknown` instead of being claimed as rolled
/// back (ADR 0002 follow-up 14).
fn run(database: &Database, job: &Job) -> Outcome {
	let started = Instant::now();
	let autocommit = database.connection().is_autocommit();
	let mut results = Vec::new();
	let result = match arm(database, started + job.request.timeout, job.stop()) {
		Ok(()) => {
			let result = run_statements(database, job, &mut results);
			disarm(database);
			result
		}
		Err(error) => Err((State::Failed, error)),
	};
	if result.is_err() && autocommit {
		// The rollback is best effort: its own failure must not replace the outcome the client
		// is owed, and the next `BEGIN` reports the connection if it is still unusable.
		let _ = database.connection().execute_batch("ROLLBACK");
	}
	let elapsed_ms = milliseconds(started.elapsed());
	match result {
		Ok(()) => Outcome {
			state: State::Completed,
			error: None,
			results,
			elapsed_ms,
			rollback: None,
		},
		Err((state, error)) => {
			// `run_statements` always decides this for a failure it observed; a failure raised
			// before the statements ran changed nothing.
			let rollback = match error.rollback {
				Some(Rollback::RolledBack) => Rollback::RolledBack,
				_ => Rollback::Unknown,
			};
			Outcome {
				state,
				error: Some(error),
				results: Vec::new(),
				elapsed_ms,
				rollback: Some(rollback),
			}
		}
	}
}

/// Walks the text with SQLite's own preparer through `Batch`, so a `;` inside a string literal
/// is never mistaken for a statement separator and comments are skipped as SQLite skips them.
///
/// A failure reports what it may have left in the database (`Rollback`), using SQLite's own
/// `sqlite3_stmt_readonly` instead of reading the SQL: a statement that failed changed nothing
/// (SQLite undoes a failed statement, an implicit transaction included), but a script whose earlier
/// statements completed cannot promise that their writes are gone. v1 has no execution-level
/// transaction — a script's own `BEGIN`/`COMMIT` is the client's, not the runtime's — so wrapping
/// every script here would change the semantics of exactly the scripts that manage transactions
/// (`README.md` §5; ADR 0002 follow-up 14).
fn run_statements(
	database: &Database,
	job: &Job,
	results: &mut Vec<Collected>,
) -> Result<(), (State, RpcError)> {
	let request = &job.request;
	let mut batch = Batch::new(database.connection(), &request.sql);
	// A statement that completed and was allowed to write may have committed; one that only read
	// left nothing behind.
	let mut completed_write = false;
	// A writer that failed may still have committed part of its work before the failure, so it is
	// never reported as rolled back.
	let mut failed_write = false;
	let result = loop {
		let statement = batch
			.next()
			.map_err(|error| (State::Failed, query_error(error, request.read_only)));
		let statement = match statement {
			Ok(Some(statement)) => statement,
			Ok(None) => break Ok(()),
			Err(error) => break Err(error),
		};
		if request.mode == Mode::Single
			&& batch
				.next()
				.map_err(|error| (State::Failed, query_error(error, request.read_only)))
				.is_ok_and(|statement| statement.is_some())
		{
			break Err((
				State::Failed,
				invalid("mode statement and selection run one statement; use mode script"),
			));
		}
		let read_only = statement.readonly();
		match step(statement, job, results) {
			Ok(()) => completed_write |= !read_only,
			// A write statement that fails after it started stepping may have committed some of
			// its rows: `INSERT … RETURNING` stopped by the row limit or a cancel does (proven by
			// the probes in this suite). Only a writer that never ran is provably undone, so a
			// failed writer keeps `unknown`.
			Err((state, error)) => {
				if read_only {
					break Err((state, error.with_rollback(Rollback::RolledBack)));
				}
				failed_write = true;
				break Err((state, error));
			}
		}
		if request.mode == Mode::Single {
			break Ok(());
		}
	};
	result.map_err(|(state, error)| {
		// The failing statement filled this in when it knows its own answer (a writer reports
		// `unknown` even when the error came from the result limit). A statement that failed
		// outside its own step, or a script whose earlier statement completed, may have committed
		// something too; only a statement that never ran is provably undone.
		let rollback = if error.rollback.is_some() {
			return (state, error);
		} else if completed_write || failed_write {
			Rollback::Unknown
		} else {
			Rollback::RolledBack
		};
		(state, error.with_rollback(rollback))
	})
}

/// Runs one prepared statement and collects its result, if it produced columns.
fn step(
	mut statement: Statement<'_>,
	job: &Job,
	results: &mut Vec<Collected>,
) -> Result<(), (State, RpcError)> {
	let request = &job.request;
	let mut columns = column_objects(&statement);
	if columns.is_empty() {
		// No columns: DML or DDL. Its affected-row count has no field in the v1
		// `query.execute` result, which is a recorded contract gap.
		let executed = statement.execute([]);
		// A statement that returns Ok has finished, committed included: a stop flag set afterwards
		// must not report it as cancelled. Only a statement SQLite did not finish can be stopped
		// from inside it, and then it returns an error (`SQLITE_INTERRUPT`) instead.
		if let Err(error) = executed {
			if let Some(outcome) = Stop::load(&job.stop).outcome() {
				return Err(outcome);
			}
			return Err((State::Failed, query_error(error, request.read_only)));
		}
		return Ok(());
	}

	let mut rows: Vec<Vec<Value>> = Vec::new();
	let mut bytes = 0usize;
	// The first storage class seen in each column. SQLite has no declared type for an
	// expression, and a value's own class is what the contract's `nativeType` names, so it
	// fills in where `sqlite3_column_decltype` returns nothing.
	let mut seen: Vec<Option<&'static str>> = vec![None; columns.len()];
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
	// A statement the progress callback ended never completes: its step fails with
	// `SQLITE_INTERRUPT`, and the flag says whether a timeout, a cancel or the session closing did
	// it. A statement that read every row before a late cancel arrived did complete, and is
	// reported as such (`cancel_requested` may end as `completed`; `README.md` §5).
	if let Err(error) = collection {
		if let Some(outcome) = Stop::load(&job.stop).outcome() {
			return Err(outcome);
		}
		return Err((State::Failed, error));
	}
	for (column, class) in columns.iter_mut().zip(&seen) {
		if column["nativeType"] == "ANY" {
			if let Some(class) = class {
				column["nativeType"] = json!(class);
			}
		}
	}

	// A script can produce more results than the session may hold. Dropping the oldest handle to
	// make room would expire it without telling its client, which `README.md` §7 forbids; the
	// statement fails with `RESOURCE_LIMIT` instead.
	if results.len() >= job.spare_results {
		return Err((
			State::Failed,
			RpcError::with_detail(
				ErrorKind::ResourceLimit,
				format!(
					"at most {} executions can hold results at once",
					crate::query::MAX_CONCURRENT_EXECUTIONS
				),
			),
		));
	}
	results.push(Collected { columns, rows });
	Ok(())
}

/// Ends a statement once its deadline passes or the execution is stopping.
fn arm(database: &Database, deadline: Instant, stop: Arc<AtomicU8>) -> Result<(), RpcError> {
	// A stop that already happened keeps its reason; otherwise the deadline decides.
	database
		.connection()
		.progress_handler(
			PROGRESS_OPS,
			Some(move || {
				if Stop::load(&stop) != Stop::Running {
					return true;
				}
				if Instant::now() >= deadline {
					Stop::store(&stop, Stop::TimedOut);
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

fn disarm(database: &Database) {
	database
		.connection()
		.progress_handler(0, None::<fn() -> bool>)
		.ok();
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

fn invalid(detail: impl Into<String>) -> RpcError {
	RpcError::with_detail(ErrorKind::InvalidParams, detail)
}

#[cfg(test)]
mod tests;
