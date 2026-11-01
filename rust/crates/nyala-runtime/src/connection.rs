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

use std::collections::hash_map::RandomState;
use std::collections::VecDeque;
use std::hash::{BuildHasher, Hasher};
use std::process;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

use crate::error::{ErrorKind, RpcError};
use crate::protocol::is_valid_id;
use crate::sqlite::{self, Database};

/// Sessions that may be open at once. `connection.open` beyond this fails with `RESOURCE_LIMIT`.
pub const MAX_OPEN_SESSIONS: usize = 32;

/// Closed sessions that stay listed and can be closed again. When one more closes, the session
/// that closed first is forgotten and its id becomes unknown.
pub const MAX_CLOSED_SESSIONS: usize = 32;

/// The only driver in protocol v1.
const DRIVER: &str = "sqlite";

/// The `sessionId` and `sessionGeneration` a session was issued.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionKey {
	id: String,
	generation: u64,
}

#[derive(Debug)]
struct OpenSession {
	key: SessionKey,
	database: Database,
}

/// The sessions of one client connection. Dropping the registry closes every open session.
#[derive(Debug)]
pub struct Sessions {
	/// `s_` followed by 16 hex digits that differ between runtime processes.
	id_prefix: String,
	/// Sessions opened so far. The n-th session gets the id `<id_prefix><n>` and generation n.
	opened: u64,
	open: Vec<OpenSession>,
	/// Oldest first.
	closed: VecDeque<SessionKey>,
}

impl Default for Sessions {
	fn default() -> Self {
		Self::new()
	}
}

impl Sessions {
	pub fn new() -> Self {
		Sessions {
			id_prefix: process_id_prefix(),
			opened: 0,
			open: Vec::new(),
			closed: VecDeque::new(),
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
		let result = json!({
			"sessionId": key.id,
			"sessionGeneration": key.generation,
			"capabilities": {
				"driver": DRIVER,
				"readOnly": database.read_only(),
				// Interrupting a statement arrives with cancellation (N-108).
				"cancel": "none",
				// v1 has no transaction.* methods, and metadata.* arrives with N-105.
				"supportsTransactions": false,
				"supportsMetadata": false,
			},
		});
		self.open.push(OpenSession { key, database });
		Ok(result)
	}

	/// `connection.close`. Closing a closed session again returns the same result.
	pub fn close(&mut self, params: &Map<String, Value>) -> Result<Value, RpcError> {
		let (id, generation) = session_key(params, "connection.close")?;
		let closed = json!({"closed": true});

		if let Some(index) = self.open.iter().position(|session| session.key.id == id) {
			check_generation(&self.open[index].key, generation)?;
			let OpenSession { key, database } = self.open.remove(index);
			if let Err((database, error)) = database.close() {
				// The connection is still open, so the session stays open.
				self.open.insert(index, OpenSession { key, database });
				return Err(error.for_session(id));
			}
			self.closed.push_back(key);
			if self.closed.len() > MAX_CLOSED_SESSIONS {
				self.closed.pop_front();
			}
			return Ok(closed);
		}

		match self.closed.iter().find(|key| key.id == id) {
			Some(key) => check_generation(key, generation).map(|()| closed),
			None => Err(
				RpcError::with_detail(ErrorKind::InvalidSession, "sessionId is unknown")
					.for_session(id),
			),
		}
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

/// Checks `sessionId` and `sessionGeneration` against the method schema.
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

	use super::*;
	use crate::sqlite::test_files::{text, TempDir};

	fn params(value: Value) -> Map<String, Value> {
		match value {
			Value::Object(map) => map,
			other => panic!("params must be an object: {other}"),
		}
	}

	fn kind(result: Result<Value, RpcError>) -> ErrorKind {
		result.expect_err("expected a failure").kind
	}

	#[test]
	fn session_ids_match_the_contract_pattern_and_differ_between_registries() {
		let first = Sessions::new();
		let second = Sessions::new();
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
		let mut sessions = Sessions::new();
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
		let mut sessions = Sessions::new();
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
		let mut sessions = Sessions::new();
		let error = sessions
			.close(&params(
				json!({"sessionId": "s_001", "sessionGeneration": 1}),
			))
			.unwrap_err();
		assert_eq!(error.kind, ErrorKind::InvalidSession);
		assert_eq!(error.to_json()["data"]["sessionId"], "s_001");
	}

	#[test]
	fn list_starts_empty_and_takes_no_params() {
		let sessions = Sessions::new();
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
		let mut sessions = Sessions::new();

		let first = sessions.open(&target(&path, true)).unwrap();
		let mut with_profile = target(&path, false);
		with_profile.insert("profileId".into(), json!("local-demo"));
		let second = sessions.open(&with_profile).unwrap();
		assert_eq!(first["sessionGeneration"], 1);
		assert_eq!(second["sessionGeneration"], 2);
		assert_ne!(first["sessionId"], second["sessionId"]);
		assert_eq!(first["capabilities"]["readOnly"], true);
		assert_eq!(second["capabilities"]["readOnly"], false);
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
			sessions.close(&key(&first)).unwrap(),
			json!({"closed": true})
		);
		// Closing again is idempotent.
		assert_eq!(
			sessions.close(&key(&first)).unwrap(),
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
		let mut sessions = Sessions::new();
		let first = sessions.open(&target(&path, true)).unwrap();
		let second = sessions.open(&target(&path, true)).unwrap();

		// The id of one session with the generation of the other.
		let mut crossed = key(&first);
		crossed.insert(
			"sessionGeneration".into(),
			second["sessionGeneration"].clone(),
		);
		let error = sessions.close(&crossed).unwrap_err();
		assert_eq!(error.kind, ErrorKind::InvalidSession);
		assert_eq!(error.to_json()["data"]["sessionId"], first["sessionId"]);
		assert_eq!(sessions.open_count(), 2, "the open session stays open");

		// A closed session keeps checking its generation.
		sessions.close(&key(&first)).unwrap();
		assert_eq!(kind(sessions.close(&crossed)), ErrorKind::InvalidSession);
	}

	#[test]
	fn open_sessions_are_limited_and_the_registry_stays_usable() {
		let dir = TempDir::new("limit");
		let path = dir.database("db.sqlite");
		let mut sessions = Sessions::new();
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
		let mut sessions = Sessions::new();
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
	fn a_failed_open_creates_no_session() {
		let dir = TempDir::new("failed-open");
		let mut sessions = Sessions::new();
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
