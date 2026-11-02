/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! The registry on its own: the state machine of `README.md` §5, the cancel race and the result
//! handles. The registry never touches SQLite, so these tests drive it with outcomes the worker
//! would report; the statements themselves are tested in `worker.rs` and over the pipe in
//! `tests/stdio.rs` and `tests/cancellation.rs`.

use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::{json, Map, Value};

use super::*;
use crate::worker::{Collected, Outcome};

const TTL: Duration = Duration::from_secs(300);

fn ids(prefix: &str) -> Executions {
	Executions::new(prefix)
}

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

fn completed_outcome(results: Vec<Collected>) -> Outcome {
	Outcome {
		state: State::Completed,
		error: None,
		results,
		elapsed_ms: 11,
	}
}

fn collected(rows: usize) -> Collected {
	Collected {
		columns: vec![json!({"ordinal": 0, "name": "answer", "nativeType": "INTEGER"})],
		rows: (0..rows)
			.map(|row| vec![json!({"type": "int64", "text": row.to_string()})])
			.collect(),
	}
}

/// Begins one execution and marks its reply sent, which is the state the request loop leaves the
/// registry in once `query.execute` was answered.
fn begun(registry: &mut Executions, sql: &str, mode: &str) -> String {
	let job = registry.begin(&request(sql, mode), true).unwrap();
	let execution = job.execution().to_owned();
	registry.mark_replied(&execution);
	execution
}

#[test]
fn execute_params_follow_the_method_schema() {
	let valid = request("SELECT 1", "statement");
	let with = |key: &str, value: Value| {
		let mut params = valid.clone();
		params.insert(key.to_owned(), value);
		params
	};
	let mut registry = ids("s_1");
	for params in [
		with("mode", json!("batch")),
		with("timeoutMs", json!(0)),
		with("timeoutMs", json!(600_001)),
		with("maxInitialRows", json!(0)),
		with("maxInitialRows", json!(10_001)),
		with("cancelTokenId", json!("")),
		with("extra", json!(1)),
	] {
		let error = registry.begin(&params, true).map(|_| ()).unwrap_err();
		assert_eq!(error.kind, ErrorKind::InvalidParams, "{params:?}");
		// A refused request names no execution.
		assert_eq!(error.execution_id, None, "{params:?}");
	}
	// A refused request changes nothing, not even the id counter.
	assert_eq!(registry.active(), 0);
	assert_eq!(begun(&mut registry, "SELECT 1", "statement"), "s_1e1");
}

#[test]
fn the_life_of_an_execution_follows_the_state_machine() {
	let mut registry = ids("s_1");
	let job = registry
		.begin(&request("SELECT 1", "statement"), true)
		.unwrap();
	let id = job.execution().to_owned();
	assert_eq!(registry.active(), 1);
	// The reply is `queued` at sequence 1, and nothing was reported yet.
	assert_eq!(
		registry.queued(&id).unwrap(),
		json!({"executionId": "s_1e1", "state": "queued", "sequence": 1})
	);
	assert!(registry.mark_replied(&id).is_empty());
	assert_eq!(
		registry
			.get_state(&object(json!({"executionId": id})))
			.unwrap()["state"],
		"queued"
	);

	let running = registry.started(&id);
	assert_eq!(running[0]["params"]["state"], "running");
	assert_eq!(running[0]["params"]["sequence"], 2);
	assert!(
		running[0]["params"].get("elapsedMs").is_none(),
		"only a terminal state reports it"
	);

	let finished = registry.finished(&id, completed_outcome(vec![collected(2)]), TTL);
	assert_eq!(finished[0]["params"]["state"], "completed");
	assert_eq!(finished[0]["params"]["sequence"], 3);
	assert_eq!(finished[0]["params"]["elapsedMs"], 11);
	assert_eq!(finished[0]["params"]["resultIds"], json!(["s_1r1"]));
	assert_eq!(registry.active(), 0);
	assert_eq!(registry.pending_results(), 1);
	assert_eq!(
		registry
			.get_state(&object(json!({"executionId": id})))
			.unwrap(),
		json!({
			"executionId": "s_1e1",
			"state": "completed",
			"sequence": 3,
			"resultIds": ["s_1r1"],
			"elapsedMs": 11,
		})
	);
}

#[test]
fn a_cancel_is_a_request_of_its_own_and_reports_the_state_it_changed() {
	let mut registry = ids("s_1");
	let id = begun(&mut registry, "SELECT 1", "statement");
	registry.started(&id);

	let outcome = registry
		.cancel(&object(json!({"executionId": id, "reason": "user"})))
		.unwrap();
	assert!(
		outcome.interrupt,
		"a running statement has to be interrupted"
	);
	assert_eq!(
		outcome.reply,
		json!({"accepted": true, "state": "cancel_requested"})
	);
	assert_eq!(
		outcome.notifications[0]["params"]["state"],
		"cancel_requested"
	);
	assert_eq!(outcome.notifications[0]["params"]["sequence"], 3);

	// A second cancel changes nothing and interrupts again: the statement may not have stopped.
	let again = registry
		.cancel(&object(json!({"executionId": id})))
		.unwrap();
	assert!(again.interrupt);
	assert_eq!(
		again.reply,
		json!({"accepted": true, "state": "cancel_requested"})
	);
	assert!(again.notifications.is_empty(), "the state did not change");

	// CancelRequested is not Cancelled: the statement still ends as something.
	let finished = registry.finished(
		&id,
		Outcome {
			state: State::Cancelled,
			error: Some(RpcError::with_detail(
				ErrorKind::QueryCancelled,
				"cancelled",
			)),
			results: Vec::new(),
			elapsed_ms: 5,
		},
		TTL,
	);
	assert_eq!(finished[0]["params"]["state"], "cancelled");
	assert_eq!(finished[0]["params"]["sequence"], 4);
	// A user cancellation carries no error (conformance.ndjson rq_012).
	assert!(
		finished[0]["params"].get("error").is_none(),
		"{}",
		finished[0]
	);

	// A terminal execution cannot be cancelled again.
	let late = registry
		.cancel(&object(json!({"executionId": id})))
		.unwrap();
	assert!(!late.interrupt);
	assert_eq!(late.reply, json!({"accepted": false, "state": "cancelled"}));
}

#[test]
fn a_cancel_that_overtakes_the_reply_is_reported_after_it() {
	let mut registry = ids("s_1");
	let job = registry
		.begin(&request("SELECT 1", "statement"), true)
		.unwrap();
	let id = job.execution().to_owned();
	// The worker prepared the statement, but the reply has not been written yet.
	let outcome = registry
		.cancel(&object(json!({"executionId": id})))
		.unwrap();
	assert_eq!(
		outcome.reply,
		json!({"accepted": true, "state": "cancel_requested"})
	);
	assert!(
		outcome.notifications.is_empty(),
		"the reply must reach the client first"
	);

	// The reply goes out, and the state it changed is reported right behind it.
	let after = registry.mark_replied(&id);
	assert_eq!(after[0]["params"]["state"], "cancel_requested");
	assert_eq!(after[0]["params"]["sequence"], 2);
	// The worker's own report does not repeat it.
	assert!(registry.started(&id).is_empty());
}

#[test]
fn a_closing_session_moves_its_executions_to_cancel_requested() {
	let mut registry = ids("s_1");
	let first = begun(&mut registry, "SELECT 1", "statement");
	let second = begun(&mut registry, "SELECT 2", "statement");
	registry.finished(&first, completed_outcome(Vec::new()), TTL);

	let (notifications, interrupt) = registry.request_stop();
	// Neither execution was started, so neither statement is stepping: the flags stop them before
	// they run, and no interrupt is sent (it would hit whatever the connection runs instead).
	assert!(!interrupt);
	// Only the execution that has not finished is reported.
	assert_eq!(notifications.len(), 1);
	assert_eq!(notifications[0]["params"]["executionId"], second);
	assert_eq!(notifications[0]["params"]["state"], "cancel_requested");
	// The registry does not decide how it ended; the worker reports that.
	assert_eq!(registry.active(), 1);
}

#[test]
fn a_stop_is_shared_with_the_worker_through_the_job() {
	let mut registry = ids("s_1");
	let job = registry
		.begin(&request("SELECT 1", "statement"), true)
		.unwrap();
	let flag = job.stop();
	let id = job.execution().to_owned();
	assert_eq!(flag.load(Ordering::SeqCst), 0);
	registry
		.cancel(&object(json!({"executionId": id})))
		.unwrap();
	// The registry sets the flag the worker's progress callback reads (`worker::Stop`).
	assert_eq!(flag.load(Ordering::SeqCst), STOP_CANCELLED);
}

#[test]
fn an_execution_the_worker_never_started_ends_cancelled_when_the_worker_dies() {
	let mut registry = ids("s_1");
	let id = begun(&mut registry, "SELECT 1", "statement");
	let notifications = registry.worker_gone();
	assert_eq!(notifications[0]["params"]["state"], "cancelled");
	assert_eq!(
		notifications[0]["params"]["error"]["data"]["kind"],
		"QUERY_CANCELLED"
	);
	assert_eq!(notifications[0]["params"]["executionId"], id);
}

#[test]
fn an_execution_the_worker_was_running_ends_unknown_when_the_worker_dies() {
	let mut registry = ids("s_1");
	let id = begun(&mut registry, "SELECT 1", "statement");
	registry.started(&id);
	let notifications = registry.worker_gone();
	// Whether the statement committed cannot be proven, so neither `failed` nor `cancelled` may
	// be claimed (§5).
	assert_eq!(notifications[0]["params"]["state"], "unknown");
	assert_eq!(
		notifications[0]["params"]["error"]["data"]["kind"],
		"UNKNOWN_COMMIT_STATUS"
	);
}

#[test]
fn pages_move_forward_only_and_the_cursor_is_checked() {
	let mut registry = ids("s_1");
	let id = begun(&mut registry, "SELECT 1", "statement");
	registry.finished(&id, completed_outcome(vec![collected(3)]), TTL);

	let first = registry
		.fetch_page(&object(
			json!({"resultId": "s_1r1", "cursor": null, "limit": 2}),
		))
		.unwrap();
	assert_eq!(first["rows"].as_array().unwrap().len(), 2);
	assert_eq!(first["hasMore"], true);
	assert_eq!(first["nextCursor"], "2");
	assert_eq!(first["rowCountEstimate"], 3);

	let second = registry
		.fetch_page(&object(
			json!({"resultId": "s_1r1", "cursor": "2", "limit": 2}),
		))
		.unwrap();
	assert_eq!(second["rows"].as_array().unwrap().len(), 1);
	assert_eq!(second["hasMore"], false);
	assert_eq!(second["nextCursor"], Value::Null);

	// A cursor that does not continue this page would repeat or skip rows.
	for cursor in [json!("0"), json!("9"), json!("two")] {
		assert_eq!(
			registry
				.fetch_page(&object(
					json!({"resultId": "s_1r1", "cursor": cursor, "limit": 2})
				))
				.unwrap_err()
				.kind,
			ErrorKind::InvalidParams,
			"{cursor}"
		);
	}
	// A handle this process does not hold is expired, not unknown.
	assert_eq!(
		registry
			.fetch_page(&object(
				json!({"resultId": "s_9r9", "cursor": null, "limit": 2})
			))
			.unwrap_err()
			.kind,
		ErrorKind::ResultExpired
	);
}

#[test]
fn fetch_page_and_release_check_their_parameters() {
	let mut registry = ids("s_1");
	for params in [
		json!({"resultId": "s_1r1", "limit": 0}),
		json!({"resultId": "s_1r1", "limit": 1001}),
		json!({"resultId": "s_1r1", "limit": 2, "cursor": 2}),
		json!({"resultId": "s_1r1", "limit": 2, "extra": true}),
		json!({"resultId": "nope", "limit": 2}),
		json!({"limit": 2}),
	] {
		assert_eq!(
			registry
				.fetch_page(&object(params.clone()))
				.unwrap_err()
				.kind,
			ErrorKind::InvalidParams,
			"{params}"
		);
	}
	assert_eq!(
		registry
			.release(&object(json!({"resultId": "s_1r1", "extra": 1})))
			.unwrap_err()
			.kind,
		ErrorKind::InvalidParams
	);
	// Releasing an id this process never issued is idempotent.
	assert_eq!(
		registry
			.release(&object(json!({"resultId": "s_9r9"})))
			.unwrap(),
		json!({"released": true})
	);
}

#[test]
fn a_session_holds_at_most_four_unread_results() {
	let mut registry = ids("s_1");
	for _ in 0..MAX_CONCURRENT_EXECUTIONS {
		let id = begun(&mut registry, "SELECT 1", "statement");
		registry.finished(&id, completed_outcome(vec![collected(1)]), TTL);
	}
	assert_eq!(registry.pending_results(), MAX_CONCURRENT_EXECUTIONS);
	let refused = registry.begin(&request("SELECT 1", "statement"), true);
	assert_eq!(
		refused.map(|_| ()).unwrap_err().kind,
		ErrorKind::ResourceLimit
	);
	// The refused call holds no result.
	assert_eq!(registry.pending_results(), MAX_CONCURRENT_EXECUTIONS);

	// A release makes room for the next execution.
	registry
		.release(&object(json!({"resultId": "s_1r1"})))
		.unwrap();
	let id = begun(&mut registry, "SELECT 1", "statement");
	registry.finished(&id, completed_outcome(vec![collected(1)]), TTL);
	assert_eq!(registry.pending_results(), MAX_CONCURRENT_EXECUTIONS);
}

#[test]
fn a_script_is_told_how_many_results_its_session_can_still_hold() {
	let mut registry = ids("s_1");
	for _ in 0..2 {
		let id = begun(&mut registry, "SELECT 1", "statement");
		registry.finished(&id, completed_outcome(vec![collected(1)]), TTL);
	}
	let job = registry
		.begin(&request("SELECT 1; SELECT 2; SELECT 3", "script"), true)
		.unwrap();
	assert_eq!(
		job.spare_results(),
		MAX_CONCURRENT_EXECUTIONS - 2,
		"the worker needs the count to refuse a script that would overflow the session"
	);
}

#[test]
fn get_state_and_cancel_check_their_parameters_and_names() {
	let mut registry = ids("s_1");
	let id = begun(&mut registry, "SELECT 1", "statement");
	for params in [
		json!({"executionId": id, "wait": true}),
		json!({"executionId": "nope"}),
		json!({}),
	] {
		assert_eq!(
			registry
				.get_state(&object(params.clone()))
				.unwrap_err()
				.kind,
			ErrorKind::InvalidParams,
			"{params}"
		);
	}
	// An execution id of another session is unknown here.
	for params in [
		json!({"executionId": "s_other_e1"}),
		json!({"executionId": 7}),
	] {
		assert_eq!(
			registry
				.get_state(&object(params.clone()))
				.unwrap_err()
				.kind,
			ErrorKind::InvalidParams,
			"{params}"
		);
	}
	for params in [
		json!({"executionId": id, "reason": "later"}),
		json!({"executionId": id, "extra": 1}),
		json!({"executionId": 7}),
	] {
		assert_eq!(
			registry
				.cancel(&object(params.clone()))
				.map(|_| ())
				.unwrap_err()
				.kind,
			ErrorKind::InvalidParams,
			"{params}"
		);
	}
}

#[test]
fn an_execution_prepared_from_bad_sql_is_retained_as_failed() {
	let mut registry = ids("s_1");
	let id = begun(&mut registry, "SELECT FROM WHERE", "statement");
	let error = RpcError::with_detail(ErrorKind::SqlSyntax, "rejected").for_execution(&id);
	registry.fail_prepared(&id, &error);
	assert_eq!(registry.active(), 0);
	let state = registry
		.get_state(&object(json!({"executionId": id})))
		.unwrap();
	assert_eq!(state["state"], "failed");
	assert_eq!(state["sequence"], 2);
	assert_eq!(state["error"]["data"]["kind"], "SQL_SYNTAX");
}

#[test]
fn the_oldest_terminal_executions_are_forgotten_first() {
	let mut registry = ids("s_1");
	let mut oldest = None;
	for _ in 0..=MAX_RETAINED_EXECUTIONS {
		let id = begun(&mut registry, "SELECT 1", "statement");
		registry.finished(&id, completed_outcome(Vec::new()), TTL);
		oldest.get_or_insert(id);
	}
	let oldest = oldest.unwrap();
	assert_eq!(
		registry
			.get_state(&object(json!({"executionId": oldest})))
			.unwrap_err()
			.kind,
		ErrorKind::InvalidParams,
		"the first execution is forgotten"
	);
	assert_eq!(registry.active(), 0);
}

#[test]
fn jobs_admitted_behind_each_other_cannot_put_more_than_four_results_into_the_session() {
	let mut registry = ids("s_1");
	// The budget is a snapshot taken at admission: while nothing has finished, every admitted job
	// sees four free handles, so a queued script and a queued statement would otherwise each hand
	// over its own result and push the session past the advertised limit.
	let script = begun(&mut registry, "SELECT 1; SELECT 2", "script");
	let statement = begun(&mut registry, "SELECT 3", "statement");
	let mut installed = Vec::new();
	for id in [&script, &statement] {
		registry.finished(id, completed_outcome(vec![collected(1)]), TTL);
		installed.push(id.clone());
	}
	// Two finished executions produced two handles, which is within the limit.
	assert_eq!(registry.pending_results(), 2);

	// Fill the session to the limit, then start two more queued jobs at the same moment.
	for _ in 0..MAX_CONCURRENT_EXECUTIONS - 2 {
		let id = begun(&mut registry, "SELECT 1", "statement");
		registry.finished(&id, completed_outcome(vec![collected(1)]), TTL);
	}
	assert_eq!(registry.pending_results(), MAX_CONCURRENT_EXECUTIONS);
	// Nothing may be admitted now.
	assert_eq!(
		registry
			.begin(&request("SELECT 1", "statement"), true)
			.map(|_| ())
			.unwrap_err()
			.kind,
		ErrorKind::ResourceLimit
	);

	// A released handle makes room for one, and the handle that arrives late still fits.
	registry
		.release(&object(json!({"resultId": "s_1r1"})))
		.unwrap();
	let late = begun(&mut registry, "SELECT 1", "statement");
	let notifications = registry.finished(&late, completed_outcome(vec![collected(1)]), TTL);
	assert_eq!(notifications[0]["params"]["state"], "completed");
	assert_eq!(
		registry.pending_results(),
		MAX_CONCURRENT_EXECUTIONS,
		"the session never holds more than the advertised limit"
	);
}

#[test]
fn a_job_whose_results_exceed_the_session_reports_the_limit_instead_of_handing_one_out() {
	let mut registry = ids("s_1");
	// Two queued jobs, both admitted while the session was empty, both carrying a full budget.
	let first = begun(&mut registry, "SELECT 1; SELECT 2; SELECT 3", "script");
	let second = begun(&mut registry, "SELECT 1; SELECT 2; SELECT 3", "script");
	registry.finished(
		&first,
		completed_outcome(vec![collected(1), collected(1), collected(1)]),
		TTL,
	);
	// Three handles are live, so only one more fits. The second job collected three rows above the
	// row limits, so its execution reports the limit and installs nothing.
	let notifications = registry.finished(
		&second,
		completed_outcome(vec![collected(1), collected(1), collected(1)]),
		TTL,
	);
	assert_eq!(notifications[0]["params"]["state"], "failed");
	assert_eq!(
		notifications[0]["params"]["error"]["data"]["kind"],
		"RESOURCE_LIMIT"
	);
	assert!(notifications[0]["params"].get("resultIds").is_none());
	assert_eq!(registry.pending_results(), 3);
}

#[test]
fn a_cancel_of_a_queued_execution_does_not_interrupt_the_running_one() {
	let mut registry = ids("s_1");
	let running = begun(&mut registry, "SELECT 1", "statement");
	registry.started(&running);
	let queued = begun(&mut registry, "SELECT 2", "statement");

	// The interrupt stops whatever the session's connection is stepping, which is not this
	// execution: it is stopped by its flag alone.
	let outcome = registry
		.cancel(&object(json!({"executionId": queued})))
		.unwrap();
	assert!(!outcome.interrupt, "a queued execution is not stepping");
	assert_eq!(outcome.reply["state"], "cancel_requested");
	assert!(
		registry
			.cancel(&object(json!({"executionId": running})))
			.unwrap()
			.interrupt,
		"the running execution is the one to interrupt"
	);
}

#[test]
fn a_worker_that_dies_does_not_notify_before_the_queued_reply() {
	let mut registry = ids("s_1");
	// Neither reply went out yet: neither execution has a state the client has heard of, so the
	// failure the request loop writes for each request is the only thing it may receive.
	let id = registry
		.begin(&request("SELECT 1", "statement"), true)
		.unwrap()
		.execution()
		.to_owned();
	registry
		.begin(&request("SELECT 2", "statement"), true)
		.unwrap();
	let notifications = registry.worker_gone();
	assert!(
		notifications
			.iter()
			.all(|notification| notification["params"]["executionId"] != id),
		"an execution the client has not been told about has no state to report: {notifications:?}"
	);
}
