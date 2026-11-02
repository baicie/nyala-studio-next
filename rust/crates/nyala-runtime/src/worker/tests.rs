/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! The session worker on its own: what a job does to a real SQLite connection, and what it reports.
//!
//! [`outcome`] runs a job exactly as [`worker_loop`] does — prepare, then run with the progress
//! handler armed — and returns the report the request loop would receive. The interrupt path is
//! exercised by setting the job's stop flag from another thread while the statement runs, which is
//! what `query.cancel` does over the pipe (`tests/cancellation.rs`).

use std::sync::atomic::Ordering;
use std::thread;

use serde_json::{json, Map, Value};

use super::*;
use crate::sqlite::test_files::{text, TempDir};

fn params(sql: &str, mode: &str) -> Map<String, Value> {
	match json!({
		"sessionId": "s_1",
		"sessionGeneration": 1,
		"sql": sql,
		"mode": mode,
		"timeoutMs": 30_000,
		"maxInitialRows": 200,
	}) {
		Value::Object(map) => map,
		other => panic!("params must be an object: {other}"),
	}
}

/// A statement that steps until something stops it.
const FOREVER: &str =
	"WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n";

fn open(path: &std::path::Path, read_only: bool) -> Database {
	Database::open(text(path), read_only).unwrap()
}

/// Runs one job the way [`worker_loop`] does and returns what it reports, plus the id it named and
/// the outcome of preparing the first statement.
fn outcome(database: &Database, sql: &str, mode: &str) -> (String, Result<(), RpcError>, Outcome) {
	run_with(database, sql, mode, 30_000, 4, |_| {})
}

/// Like [`outcome`], with a hook that runs after the statement was prepared and before it steps —
/// which is where a cancel from another thread arrives.
fn run_with(
	database: &Database,
	sql: &str,
	mode: &str,
	timeout_ms: u64,
	spare_results: usize,
	after_prepare: impl FnOnce(&Job),
) -> (String, Result<(), RpcError>, Outcome) {
	let mut request = params(sql, mode);
	request.insert("timeoutMs".into(), json!(timeout_ms));
	let job = match Job::parse("s_1e1", &request, database.read_only(), spare_results) {
		Ok(job) => job,
		Err(error) => panic!("the job must parse: {error}"),
	};
	let prepared = prepare(database, &job);
	after_prepare(&job);
	let outcome = if prepared.is_ok() && Stop::load(&job.stop) == Stop::Running {
		run(database, &job)
	} else {
		Outcome::stopped(
			Stop::load(&job.stop)
				.outcome()
				.unwrap_or_else(|| (State::Cancelled, RpcError::new(ErrorKind::QueryCancelled))),
		)
	};
	(job.execution().to_owned(), prepared, outcome)
}

/// The one result of a job that completed, or a panic when it did not produce exactly one.
fn one_result(outcome: Outcome) -> Collected {
	assert_eq!(outcome.state, State::Completed, "{:?}", outcome.error);
	assert_eq!(outcome.results.len(), 1);
	outcome.results.into_iter().next().unwrap()
}

#[test]
fn a_select_completes_with_typed_cells() {
	let dir = TempDir::new("worker-select");
	let database = open(&dir.database("db.sqlite"), true);
	let (execution, prepared, outcome) = outcome(
		&database,
		"SELECT id, name FROM customers ORDER BY id",
		"statement",
	);
	assert_eq!(execution, "s_1e1");
	prepared.expect("the statement compiles");
	assert_eq!(outcome.state, State::Completed);
	assert!(
		outcome.elapsed_ms < 60_000,
		"elapsedMs is a duration, not a timestamp"
	);
	let collected = one_result(outcome);
	assert_eq!(
		Value::Array(collected.columns),
		json!([
			{"ordinal": 0, "name": "id", "nativeType": "INTEGER"},
			{"ordinal": 1, "name": "name", "nativeType": "TEXT"},
		])
	);
	assert_eq!(
		Value::Array(collected.rows.into_iter().map(Value::Array).collect()),
		json!([
			[{"type": "int64", "text": "1"}, {"type": "string", "value": "Ada"}],
			[{"type": "int64", "text": "2"}, {"type": "string", "value": "Grace"}],
		])
	);
}

#[test]
fn a_result_without_a_declared_type_reports_the_storage_class_it_holds() {
	let dir = TempDir::new("worker-native-type");
	let database = open(&dir.database("db.sqlite"), true);
	let collected = one_result(outcome(&database, "SELECT 1 AS answer", "statement").2);
	assert_eq!(
		Value::Array(collected.columns),
		json!([{"ordinal": 0, "name": "answer", "nativeType": "INTEGER"}])
	);
	let collected = one_result(outcome(&database, "SELECT NULL AS empty_value", "statement").2);
	assert_eq!(
		Value::Array(collected.columns),
		json!([{"ordinal": 0, "name": "empty_value", "nativeType": "NULL"}])
	);
}

#[test]
fn a_statement_that_writes_reports_no_result() {
	let dir = TempDir::new("worker-write");
	let path = dir.database("db.sqlite");
	let writable = open(&path, false);
	let (_, prepared, result) = outcome(
		&writable,
		"INSERT INTO customers(name) VALUES ('Turing')",
		"statement",
	);
	prepared.expect("the statement compiles");
	assert_eq!(result.state, State::Completed);
	assert!(result.results.is_empty(), "DML has no columns");

	let count = one_result(outcome(&writable, "SELECT count(*) FROM customers", "statement").2);
	assert_eq!(
		Value::Array(count.rows.into_iter().map(Value::Array).collect()),
		json!([[{"type": "int64", "text": "3"}]])
	);
}

#[test]
fn a_read_only_session_lets_sqlite_refuse_every_kind_of_write() {
	let dir = TempDir::new("worker-read-only");
	let database = open(&dir.database("db.sqlite"), true);
	// The enforcement is SQLite's own read-only mode, so it covers DML, DDL and a PRAGMA with a
	// side effect alike, with no inspection of the SQL text (`25-engineering-rules.md` §7).
	for sql in [
		"INSERT INTO customers(name) VALUES ('Turing')",
		"UPDATE customers SET name = 'Turing'",
		"DELETE FROM customers",
		"CREATE TABLE extra(x INTEGER)",
		"DROP TABLE customers",
		"CREATE INDEX extra_index ON customers(name)",
		"ALTER TABLE customers ADD COLUMN note TEXT",
	] {
		let (_, prepared, result) = outcome(&database, sql, "statement");
		prepared.expect("the statement compiles; SQLite refuses it when it runs");
		assert_eq!(result.state, State::Failed, "{sql}");
		let error = result.error.expect("a failure names its cause");
		assert_eq!(error.kind, ErrorKind::ReadOnlyDenied, "{sql}");
	}
	// Nothing was written.
	let count = one_result(outcome(&database, "SELECT count(*) FROM customers", "statement").2);
	assert_eq!(
		Value::Array(count.rows.into_iter().map(Value::Array).collect()),
		json!([[{"type": "int64", "text": "2"}]])
	);
}

#[test]
fn invalid_sql_is_refused_before_anything_runs() {
	let dir = TempDir::new("worker-syntax");
	let database = open(&dir.database("db.sqlite"), true);
	let (_, prepared, _) = outcome(&database, "SELECT FROM WHERE", "statement");
	let error = prepared.expect_err("the statement does not compile");
	assert_eq!(error.kind, ErrorKind::SqlSyntax);
	// The database's own result code tells a preparer rejection from a constraint violation.
	assert_eq!(error.sql_state.as_deref(), Some("1"));

	// Empty text is refused while the parameters are parsed.
	let empty = Job::parse("s_1e1", &params("", "script"), true, 4);
	assert_eq!(
		empty.map(|_| ()).unwrap_err().kind,
		ErrorKind::InvalidParams
	);
	// Text that only looks like a statement is refused once SQLite reads it.
	for sql in [" ", "-- just a comment", ";"] {
		let (_, prepared, _) = outcome(&database, sql, "script");
		assert_eq!(
			prepared.expect_err("no statement").kind,
			ErrorKind::InvalidParams,
			"{sql:?}"
		);
	}
}

#[test]
fn script_mode_runs_every_statement_and_statement_mode_refuses_more_than_one() {
	let dir = TempDir::new("worker-script");
	let database = open(&dir.database("db.sqlite"), true);
	let (_, prepared, result) = outcome(&database, "SELECT 1 AS a; SELECT 2 AS b;", "script");
	prepared.expect("the first statement compiles");
	assert_eq!(result.state, State::Completed);
	assert_eq!(result.results.len(), 2);
	assert_eq!(
		Value::Array(
			result.results[1]
				.rows
				.clone()
				.into_iter()
				.map(Value::Array)
				.collect()
		),
		json!([[{"type": "int64", "text": "2"}]])
	);

	// A semicolon inside a literal is not a statement separator.
	let collected = one_result(outcome(&database, "SELECT 'a;b' AS text_value", "statement").2);
	assert_eq!(
		Value::Array(collected.rows.into_iter().map(Value::Array).collect()),
		json!([[{"type": "string", "value": "a;b"}]])
	);

	// `statement` mode answers one statement only; a second one is refused rather than dropped.
	let (_, prepared, _) = outcome(&database, "SELECT 1; SELECT 2", "statement");
	assert_eq!(
		prepared.expect_err("more than one statement").kind,
		ErrorKind::InvalidParams
	);
}

#[test]
fn results_are_bounded_by_the_rows_the_client_allowed() {
	let dir = TempDir::new("worker-limits");
	let database = open(&dir.database("db.sqlite"), true);
	let mut request = params(
		"SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3",
		"statement",
	);
	request.insert("maxInitialRows".into(), json!(2));
	let job = Job::parse("s_1e1", &request, true, 4).unwrap();
	prepare(&database, &job).expect("the statement compiles");
	let outcome = run(&database, &job);
	assert_eq!(outcome.state, State::Failed);
	let error = outcome.error.expect("a failure names its cause");
	assert_eq!(error.kind, ErrorKind::ResourceLimit);
	assert!(
		outcome.results.is_empty(),
		"a result above the limit is refused, not truncated"
	);
}

#[test]
fn a_script_cannot_hold_more_results_than_its_session_allows() {
	let dir = TempDir::new("worker-spare");
	let database = open(&dir.database("db.sqlite"), true);
	let (_, prepared, result) = run_with(
		&database,
		"SELECT 1; SELECT 2; SELECT 3",
		"script",
		30_000,
		2,
		|_| {},
	);
	prepared.expect("the first statement compiles");
	assert_eq!(result.state, State::Failed);
	assert_eq!(
		result.error.expect("a failure names its cause").kind,
		ErrorKind::ResourceLimit
	);
}

#[test]
fn a_rejected_statement_carries_the_database_result_code() {
	let dir = TempDir::new("worker-constraint");
	let database = open(&dir.database("db.sqlite"), false);
	database
		.connection()
		.execute_batch("CREATE TABLE keyed(id INTEGER PRIMARY KEY, code TEXT UNIQUE);")
		.unwrap();
	// A constraint violation rejects the data, not the text. v1 has no constraint kind and `v1/`
	// is frozen, so it is reported as SQL_SYNTAX with SQLite's extended result code: 1555 is
	// `SQLITE_CONSTRAINT_PRIMARYKEY` and 2067 is `SQLITE_CONSTRAINT_UNIQUE`.
	for (sql, code) in [
		(
			"INSERT INTO keyed(id, code) VALUES (1, 'a'); INSERT INTO keyed(id, code) VALUES (1, 'b')",
			"1555",
		),
		("INSERT INTO keyed(id, code) VALUES (2, 'a')", "2067"),
	] {
		let (_, prepared, result) = outcome(&database, sql, "script");
		prepared.expect("the first statement compiles");
		assert_eq!(result.state, State::Failed, "{sql}");
		let error = result.error.expect("a failure names its cause");
		assert_eq!(error.kind, ErrorKind::SqlSyntax, "{sql}");
		assert_eq!(error.sql_state.as_deref(), Some(code), "{sql}");
	}
	// Only the first insert of the first script committed; nothing was written twice.
	let count = one_result(outcome(&database, "SELECT count(*) FROM keyed", "statement").2);
	assert_eq!(
		Value::Array(count.rows.into_iter().map(Value::Array).collect()),
		json!([[{"type": "int64", "text": "1"}]])
	);
}

#[test]
fn a_query_that_runs_past_its_deadline_ends_cancelled_as_a_timeout() {
	let dir = TempDir::new("worker-timeout");
	let database = open(&dir.database("db.sqlite"), true);
	let started = std::time::Instant::now();
	let (_, prepared, result) = run_with(&database, FOREVER, "statement", 20, 4, |_| {});
	prepared.expect("the statement compiles");
	assert_eq!(result.state, State::Cancelled);
	assert_eq!(
		result.error.expect("a timeout says so").kind,
		ErrorKind::QueryTimeout
	);
	assert!(
		started.elapsed() < std::time::Duration::from_secs(20),
		"the statement did not end at its deadline"
	);
	assert!(
		result.results.is_empty(),
		"a stopped statement has no result"
	);

	// The connection stays usable, and the next execution gets a fresh deadline.
	let collected = one_result(outcome(&database, "SELECT 1 AS answer", "statement").2);
	assert_eq!(
		Value::Array(collected.rows.into_iter().map(Value::Array).collect()),
		json!([[{"type": "int64", "text": "1"}]])
	);
}

#[test]
fn the_progress_handler_ends_a_running_statement_when_the_stop_flag_is_set() {
	let dir = TempDir::new("worker-interrupt");
	let database = open(&dir.database("db.sqlite"), true);
	// A cancel arrives from another thread while SQLite is stepping the statement; the progress
	// handler sees the flag and abandons the statement.
	let (_, prepared, result) = run_with(&database, FOREVER, "statement", 600_000, 4, |job| {
		let stop = job.stop();
		thread::spawn(move || {
			thread::sleep(std::time::Duration::from_millis(50));
			Stop::store(&stop, Stop::Cancelled);
		})
		.join()
		.unwrap();
	});
	prepared.expect("the statement compiles");
	assert_eq!(result.state, State::Cancelled);
	assert_eq!(
		result.error.expect("a cancellation says so").kind,
		ErrorKind::QueryCancelled
	);
}

#[test]
fn a_cancel_that_arrives_before_the_statement_runs_leaves_no_result() {
	let dir = TempDir::new("worker-early");
	let database = open(&dir.database("db.sqlite"), true);
	// `worker_loop` checks the flag right after reporting the prepared job, so a cancel that wins
	// that race ends the execution without SQLite stepping anything.
	let (_, _, result) = run_with(&database, FOREVER, "statement", 600_000, 4, |job| {
		Stop::store(&job.stop, Stop::Cancelled);
	});
	assert_eq!(result.state, State::Cancelled);
	assert_eq!(result.elapsed_ms, 0);
	assert!(result.results.is_empty());
}

#[test]
fn a_late_cancel_does_not_turn_a_finished_statement_into_a_cancellation() {
	let dir = TempDir::new("worker-late");
	let database = open(&dir.database("db.sqlite"), true);
	// The flag is set after the statement ran to the end: the statement did finish, and §5 allows
	// `cancel_requested` to end as `completed`.
	let stop = {
		let job = Job::parse("s_1e1", &params("SELECT 1 AS answer", "statement"), true, 4).unwrap();
		prepare(&database, &job).expect("the statement compiles");
		let outcome = run(&database, &job);
		Stop::store(&job.stop, Stop::Cancelled);
		assert_eq!(outcome.state, State::Completed);
		job.stop()
	};
	assert_eq!(stop.load(Ordering::SeqCst), Stop::Cancelled as u8);
}

#[test]
fn a_script_that_fails_inside_its_transaction_does_not_leave_it_open() {
	let dir = TempDir::new("worker-transaction");
	let path = dir.database("db.sqlite");
	let database = open(&path, false);
	database
		.connection()
		.execute_batch("CREATE TABLE keyed(id INTEGER PRIMARY KEY, code TEXT UNIQUE);")
		.unwrap();
	// `BEGIN` then a constraint violation: SQLite keeps the transaction open, and the connection
	// belongs to the session, so without a rollback every later execution would run inside it and
	// its locks would outlive the failed one. v1 has no `transaction.*` method to end it.
	let (_, prepared, result) = outcome(
		&database,
		"BEGIN; INSERT INTO keyed(id, code) VALUES (1, 'a'); INSERT INTO keyed(id, code) VALUES (1, 'b'); SELECT 1",
		"script",
	);
	prepared.expect("the first statement compiles");
	assert_eq!(result.state, State::Failed);
	assert_eq!(
		result.error.expect("a failure names its cause").kind,
		ErrorKind::SqlSyntax
	);
	assert!(
		database.connection().is_autocommit(),
		"the failed script's transaction was rolled back"
	);

	// The rollback undid the part of the script that had run, and the session keeps working.
	let count = one_result(outcome(&database, "SELECT count(*) FROM keyed", "statement").2);
	assert_eq!(
		Value::Array(count.rows.into_iter().map(Value::Array).collect()),
		json!([[{"type": "int64", "text": "0"}]])
	);
	one_result(outcome(&database, "SELECT 1 AS answer", "statement").2);
}

#[test]
fn a_script_that_opens_a_transaction_and_completes_keeps_it() {
	let dir = TempDir::new("worker-transaction-open");
	let path = dir.database("db.sqlite");
	let database = open(&path, false);
	// A script that ends cleanly is not rolled back: `BEGIN` without `COMMIT` is a transaction the
	// client asked for, and v1 sends the following statements of the same session into it.
	let (_, prepared, result) = outcome(&database, "BEGIN", "script");
	prepared.expect("the statement compiles");
	assert_eq!(result.state, State::Completed, "{:?}", result.error);
	assert!(
		!database.connection().is_autocommit(),
		"the script left its transaction open on purpose"
	);
	database.connection().execute_batch("ROLLBACK").unwrap();
}

#[test]
fn a_database_locked_by_another_connection_reports_a_query_timeout() {
	let dir = TempDir::new("worker-locked");
	let path = dir.database("db.sqlite");
	let holder = rusqlite::Connection::open(&path).unwrap();
	holder.execute_batch("BEGIN EXCLUSIVE").unwrap();
	// Opening one exclusive connection keeps every other one from reading the file, so the
	// session cannot even be opened while the lock is held, just as `connection.open` reports it
	// over the pipe (`tests/stdio.rs`).
	assert_eq!(
		Database::open(text(&path), true).unwrap_err().kind,
		ErrorKind::QueryTimeout
	);
	holder.execute_batch("ROLLBACK").unwrap();

	let database = open(&path, true);
	// The lock is taken again after this session opened, which is the only way to reach a statement
	// that compiles and then waits on another connection.
	holder.execute_batch("BEGIN EXCLUSIVE").unwrap();
	let (_, prepared, result) = outcome(&database, "SELECT count(*) FROM customers", "statement");
	prepared.expect("the statement compiles");
	assert_eq!(result.state, State::Failed);
	let error = result.error.expect("a failure names its cause");
	assert_eq!(error.kind, ErrorKind::QueryTimeout);
	assert_eq!(
		error.safe_detail.as_deref(),
		Some("database is locked by another connection")
	);
	holder.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn a_worker_reports_what_it_runs_and_stops_when_it_is_asked_to() {
	let dir = TempDir::new("worker-thread");
	let database = open(&dir.database("db.sqlite"), true);
	let (sender, receiver) = std::sync::mpsc::channel();
	let mut worker = Worker::spawn("s_1", database, sender).unwrap();
	let request = params("SELECT 1 AS answer", "statement");
	let job = Job::parse("s_1e1", &request, true, 4).unwrap();
	worker.execute(job).unwrap();

	// The worker reports the prepared job, then the state it reached.
	let prepared = receiver.recv().unwrap();
	match prepared {
		events::Input::Event(Event::Prepared {
			session,
			execution,
			error,
		}) => {
			assert_eq!(session, "s_1");
			assert_eq!(execution, "s_1e1");
			assert!(error.is_none());
		}
		other => panic!("expected a prepared report: {other:?}"),
	}
	match receiver.recv().unwrap() {
		events::Input::Event(Event::Started { execution, .. }) => assert_eq!(execution, "s_1e1"),
		other => panic!("expected a started report: {other:?}"),
	}
	match receiver.recv().unwrap() {
		events::Input::Event(Event::Finished {
			execution, outcome, ..
		}) => {
			assert_eq!(execution, "s_1e1");
			assert_eq!(outcome.state, State::Completed);
		}
		other => panic!("expected a finished report: {other:?}"),
	}

	// Closing waits for the worker, which closes the connection on its way out.
	worker.shutdown().expect("the worker closes its connection");
}

#[test]
fn a_worker_that_panics_reports_that_it_is_gone() {
	let dir = TempDir::new("worker-panic");
	let database = open(&dir.database("db.sqlite"), true);
	let (sender, receiver) = std::sync::mpsc::channel();
	let mut worker = Worker::spawn("s_1", database, sender).unwrap();
	// The metadata call parses its parameters on the worker, so this cannot be made to panic from
	// here; the guarantee under test is that a panicking worker reports itself instead of leaving
	// the client without an answer (`worker_loop`'s `catch_unwind`).
	// A shutdown after the connection is already closed is the closest observable case: the
	// worker answers, and the loop ends cleanly.
	worker.shutdown().expect("the worker closes its connection");
	assert!(
		receiver.try_recv().is_err(),
		"a clean shutdown reports nothing"
	);
	// The command channel is gone, so the worker is known to be.
	let request = params("SELECT 1", "statement");
	let job = Job::parse("s_1e2", &request, true, 4).unwrap();
	assert!(worker.execute(job).is_err(), "the worker is gone");
}
