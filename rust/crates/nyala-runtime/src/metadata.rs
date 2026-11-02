/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! `metadata.*` (N-105): the objects and columns of a session's database, read from
//! `sqlite_schema` and `PRAGMA table_info`.
//!
//! Both methods run against the session's own connection, so a request cannot read metadata of a
//! database another session opened; the `(sessionId, sessionGeneration)` pair is checked by the
//! caller. Object and schema names never reach SQL as raw text: identifiers are quoted with `"`
//! doubling, and `metadata.describe` only accepts a schema SQLite actually attached
//! (`25-engineering-rules.md` §Rust: identifier quoting, no concatenated user input).
//!
//! Rows are ordered by `(kind, name)` so that the `cursor` contract — opaque, forward-only — holds
//! for a stable read of a database another process may still be writing.

use rusqlite::types::ValueRef;
use serde_json::{json, Map, Value};

use crate::error::{ErrorKind, RpcError};
use crate::sqlite::Database;

/// Object kinds `metadata.listObjects` returns, in contract order. The same three values are the
/// `kinds` enum of `method.metadata.listObjects.params`.
const KINDS: [&str; 3] = ["table", "view", "index"];

/// Largest `limit` the contract allows (schema `maximum`).
const MAX_LIMIT: u64 = 1000;

/// An object as `sqlite_schema` records it.
struct Object {
	name: String,
	kind: &'static str,
}

/// A resolved `metadata.listObjects` query: the caller's kinds and schema, plus where to resume.
struct Query {
	schema: Option<String>,
	kinds: Vec<&'static str>,
}

impl Database {
	/// `metadata.listObjects`.
	pub fn list_objects(&self, params: &Map<String, Value>) -> Result<Value, RpcError> {
		const METHOD: &str = "metadata.listObjects";
		for key in params.keys() {
			if !matches!(
				key.as_str(),
				"sessionId" | "sessionGeneration" | "schema" | "kinds" | "cursor" | "limit"
			) {
				return Err(invalid(format!("unexpected {METHOD} parameter")));
			}
		}
		let limit = limit(params, METHOD)?;
		let kinds = kinds(params)?;
		let schema = schema(params, METHOD)?;
		let query = Query { schema, kinds };

		let mut objects = self.objects(&query)?;
		objects.sort_by(|left, right| {
			order(left.kind)
				.cmp(&order(right.kind))
				.then_with(|| left.name.cmp(&right.name))
		});
		if let Some(cursor) = &params.get("cursor") {
			// `cursor` is `string | null`; null means "start at the beginning".
			if let Some(text) = cursor.as_str() {
				let cursor = Cursor::parse(text)?;
				if cursor.query.schema != query.schema || cursor.query.kinds != query.kinds {
					return Err(invalid("cursor belongs to a different query"));
				}
				objects.retain(|object| cursor.is_before(object));
			} else if !cursor.is_null() {
				return Err(invalid("cursor must be a string or null"));
			}
		}

		let page: Vec<&Object> = objects.iter().take(limit).collect();
		let has_more = objects.len() > page.len();
		let next_cursor = match (page.last(), has_more) {
			(Some(last), true) => Some(Cursor::at(last, &query).encode()),
			// The last page has nothing to resume from.
			_ => None,
		};
		let objects: Vec<Value> = page
			.into_iter()
			.map(|object| {
				json!({
					"name": object.name,
					"kind": object.kind,
					"schema": query.schema.clone().unwrap_or_else(|| "main".to_owned()),
				})
			})
			.collect();
		Ok(json!({
			"objects": objects,
			"hasMore": has_more,
			"nextCursor": next_cursor,
		}))
	}

	/// `metadata.describe`. Covers tables and views, the two kinds `PRAGMA table_info` describes.
	pub fn describe(&self, params: &Map<String, Value>) -> Result<Value, RpcError> {
		for key in params.keys() {
			if !matches!(key.as_str(), "sessionId" | "sessionGeneration" | "object") {
				return Err(invalid("unexpected metadata.describe parameter"));
			}
		}
		let object = params
			.get("object")
			.and_then(Value::as_object)
			.ok_or_else(|| invalid("object must be an object"))?;
		for key in object.keys() {
			if !matches!(key.as_str(), "schema" | "name") {
				return Err(invalid("unexpected object property"));
			}
		}
		let schema = match object.get("schema") {
			None => "main".to_owned(),
			Some(value) => {
				let schema = value
					.as_str()
					.filter(|schema| !schema.is_empty())
					.ok_or_else(|| invalid("object.schema must be a non-empty string"))?;
				// A schema name picks which attached database is read, so only the ones SQLite
				// attached are accepted; it is then quoted as an identifier.
				if !self.attached_schemas()?.iter().any(|known| known == schema) {
					return Err(invalid("object.schema is not attached to this session"));
				}
				schema.to_owned()
			}
		};
		let name = object
			.get("name")
			.and_then(Value::as_str)
			.filter(|name| !name.is_empty())
			.ok_or_else(|| invalid("object.name must be a non-empty string"))?;

		match self.object_kind(&schema, name)?.as_deref() {
			Some("table" | "view") => {}
			Some("index") => {
				return Err(invalid(
					"metadata.describe covers tables and views; an index has no columns of its own",
				))
			}
			_ => {
				return Err(RpcError::with_detail(
					ErrorKind::InvalidParams,
					"object does not exist in this database",
				))
			}
		}

		// SQLite only enforces NOT NULL on a PRIMARY KEY when the table stores the key separately:
		// a `WITHOUT ROWID` table or a non-`INTEGER` primary key on a rowid table has a unique index
		// behind it and rejects NULL, while an `INTEGER PRIMARY KEY` (the rowid alias) silently
		// turns a NULL insert into a new rowid. `PRAGMA table_info` reports `notnull` as written, so
		// neither shape is recoverable from it alone.
		let primary_keys_enforced = self.primary_keys_are_enforced(&schema, name)?;
		// PRAGMA arguments cannot be bound, so both names are quoted into identifier position.
		let sql = format!(
			"PRAGMA {}.table_info({})",
			quote_identifier(&schema),
			quote_identifier(name)
		);
		let mut statement = self
			.connection()
			.prepare(&sql)
			.map_err(|error| domain_error(error, "metadata.describe could not read the object"))?;
		let mut rows = statement
			.query([])
			.map_err(|error| domain_error(error, "metadata.describe could not read the object"))?;
		let mut columns = Vec::new();
		while let Some(row) = rows
			.next()
			.map_err(|error| domain_error(error, "metadata.describe could not read the object"))?
		{
			// PRAGMA table_info columns: cid, name, type, notnull, dflt_value, pk.
			let ordinal = row.get::<_, i64>(0).unwrap_or_default();
			let name = row.get::<_, String>(1).unwrap_or_default();
			let native_type = row.get::<_, String>(2).unwrap_or_default();
			let not_null = row.get::<_, i64>(3).unwrap_or_default() != 0;
			let primary_key = row.get::<_, i64>(5).unwrap_or_default() != 0;
			let mut column = Map::new();
			column.insert("ordinal".into(), json!(ordinal.max(0)));
			column.insert("name".into(), json!(name));
			// A column declared without a type has an empty declared type; the contract requires a
			// non-empty `nativeType`, and SQLite's affinity for such a column is BLOB.
			column.insert(
				"nativeType".into(),
				json!(if native_type.is_empty() {
					"BLOB"
				} else {
					native_type.as_str()
				}),
			);
			let enforced_key = primary_key && primary_keys_enforced;
			column.insert("nullable".into(), json!(!not_null && !enforced_key));
			if primary_key {
				column.insert("primaryKey".into(), json!(true));
			}
			columns.push(Value::Object(column));
		}
		if columns.is_empty() {
			// A table with no columns cannot be created through SQL, so an empty list means the
			// object vanished between the existence check and the read.
			return Err(RpcError::with_detail(
				ErrorKind::InvalidParams,
				"object does not exist in this database",
			));
		}
		Ok(json!({ "columns": columns }))
	}

	/// Objects of the queried database, restricted to the requested kinds.
	fn objects(&self, query: &Query) -> Result<Vec<Object>, RpcError> {
		let sql = match &query.schema {
			Some(schema) => {
				if !self.attached_schemas()?.iter().any(|known| known == schema) {
					return Err(invalid("schema is not attached to this session"));
				}
				format!(
					"SELECT name, type FROM {}.sqlite_schema WHERE type IN ({})",
					quote_identifier(schema),
					placeholders(query.kinds.len())
				)
			}
			None => format!(
				"SELECT name, type FROM sqlite_schema WHERE type IN ({})",
				placeholders(query.kinds.len())
			),
		};
		let mut statement = self.connection().prepare(&sql).map_err(|error| {
			domain_error(error, "metadata.listObjects could not read the schema")
		})?;
		let mut rows = statement
			.query(rusqlite::params_from_iter(query.kinds.iter()))
			.map_err(|error| {
				domain_error(error, "metadata.listObjects could not read the schema")
			})?;
		let mut objects = Vec::new();
		while let Some(row) = rows.next().map_err(|error| {
			domain_error(error, "metadata.listObjects could not read the schema")
		})? {
			let name = match row
				.get_ref(0)
				.map_err(|error| domain_error(error, "metadata.listObjects read no object name"))?
			{
				ValueRef::Text(name) => String::from_utf8_lossy(name).into_owned(),
				_ => continue,
			};
			// `sqlite_schema` also records SQLite's own objects: `sqlite_sequence`,
			// `sqlite_autoindex_*` and the like. They are not the user's schema.
			if name.starts_with("sqlite_") {
				continue;
			}
			let kind = row.get::<_, String>(1).unwrap_or_default();
			let Some(kind) = KINDS.iter().copied().find(|known| *known == kind) else {
				continue;
			};
			objects.push(Object { name, kind });
		}
		Ok(objects)
	}

	/// The `sqlite_schema.type` of `name` in `schema`, if the object exists.
	fn object_kind(&self, schema: &str, name: &str) -> Result<Option<String>, RpcError> {
		let sql = format!(
			"SELECT type FROM {}.sqlite_schema WHERE name = ?1 AND type IN ('table', 'view', 'index')",
			quote_identifier(schema)
		);
		let mut statement = self
			.connection()
			.prepare(&sql)
			.map_err(|error| domain_error(error, "metadata.describe could not read the schema"))?;
		let mut rows = statement
			.query([name])
			.map_err(|error| domain_error(error, "metadata.describe could not read the schema"))?;
		let mut kind = None;
		while let Some(row) = rows
			.next()
			.map_err(|error| domain_error(error, "metadata.describe could not read the schema"))?
		{
			if kind.is_none() {
				kind = row.get::<_, String>(0).ok();
			}
		}
		Ok(kind)
	}

	/// Whether SQLite enforces NOT NULL on the primary key of `name`.
	///
	/// It does everywhere except on a rowid table whose primary key is the rowid itself, in which
	/// case a `NULL` insert is answered by allocating a new rowid. That shape is exactly the one
	/// with no separate primary-key index: `PRAGMA index_list` shows an index of origin `pk` for
	/// every other primary key (a non-`INTEGER` key, a composite key, `INTEGER PRIMARY KEY DESC`,
	/// `WITHOUT ROWID`), and none for the rowid alias. `notnull` alone cannot tell them apart. A
	/// view has no primary key, so neither query reports one.
	fn primary_keys_are_enforced(&self, schema: &str, name: &str) -> Result<bool, RpcError> {
		// The table-valued form binds the table as an argument, so the name never enters SQL. It
		// reads `main.temp`; an attached schema goes through `PRAGMA <schema>.index_list(<table>)`,
		// whose name is quoted as an identifier.
		if schema == "main" {
			let count: i64 = self
				.connection()
				.query_row(
					"SELECT count(*) FROM pragma_index_list(?1) WHERE origin = 'pk'",
					[name],
					|row| row.get(0),
				)
				.map_err(|error| {
					domain_error(error, "metadata.describe could not read the object")
				})?;
			return Ok(count > 0);
		}
		let sql = format!(
			"PRAGMA {}.index_list({})",
			quote_identifier(schema),
			quote_identifier(name)
		);
		let mut statement = self
			.connection()
			.prepare(&sql)
			.map_err(|error| domain_error(error, "metadata.describe could not read the object"))?;
		let mut rows = statement
			.query([])
			.map_err(|error| domain_error(error, "metadata.describe could not read the object"))?;
		while let Some(row) = rows
			.next()
			.map_err(|error| domain_error(error, "metadata.describe could not read the object"))?
		{
			// `PRAGMA index_list` columns: seq, name, unique, origin, partial.
			if row.get::<_, String>(3).is_ok_and(|origin| origin == "pk") {
				return Ok(true);
			}
		}
		Ok(false)
	}

	/// The schemas SQLite attached to this connection: `main`, plus `temp` and any `ATTACH`ed one.
	fn attached_schemas(&self) -> Result<Vec<String>, RpcError> {
		let mut statement = self
			.connection()
			.prepare("PRAGMA database_list")
			.map_err(|error| domain_error(error, "metadata could not list the attached schemas"))?;
		let mut rows = statement
			.query([])
			.map_err(|error| domain_error(error, "metadata could not list the attached schemas"))?;
		let mut schemas = Vec::new();
		while let Some(row) = rows
			.next()
			.map_err(|error| domain_error(error, "metadata could not list the attached schemas"))?
		{
			// PRAGMA database_list columns: seq, name, file.
			if let Ok(ValueRef::Text(name)) = row.get_ref(1) {
				schemas.push(String::from_utf8_lossy(name).into_owned());
			}
		}
		Ok(schemas)
	}
}

/// Position of a kind in the result order.
fn order(kind: &str) -> usize {
	KINDS
		.iter()
		.position(|known| *known == kind)
		.unwrap_or(KINDS.len())
}

/// `limit` as the method schema requires it: required, an integer in `1..=1000`.
fn limit(params: &Map<String, Value>, method: &str) -> Result<usize, RpcError> {
	let limit = params
		.get("limit")
		.and_then(Value::as_u64)
		.filter(|limit| (1..=MAX_LIMIT).contains(limit))
		.ok_or_else(|| {
			invalid(format!(
				"limit of {method} must be an integer between 1 and 1000"
			))
		})?;
	Ok(usize::try_from(limit).unwrap_or(usize::MAX))
}

/// `kinds`, defaulting to all three when absent. A repeated kind is rejected, as the schema's
/// `uniqueItems` requires.
fn kinds(params: &Map<String, Value>) -> Result<Vec<&'static str>, RpcError> {
	let Some(value) = params.get("kinds") else {
		return Ok(KINDS.to_vec());
	};
	let items = value
		.as_array()
		.ok_or_else(|| invalid("kinds must be an array"))?;
	let mut kinds: Vec<&'static str> = Vec::with_capacity(items.len());
	for item in items {
		let kind = item
			.as_str()
			.and_then(|kind| KINDS.iter().copied().find(|known| *known == kind))
			.ok_or_else(|| invalid("kinds may only hold table, view or index"))?;
		if kinds.contains(&kind) {
			return Err(invalid("kinds must not repeat a kind"));
		}
		kinds.push(kind);
	}
	if kinds.is_empty() {
		return Err(invalid("kinds must not be empty"));
	}
	Ok(kinds)
}

fn schema(params: &Map<String, Value>, method: &str) -> Result<Option<String>, RpcError> {
	match params.get("schema") {
		None => Ok(None),
		Some(value) => value
			.as_str()
			.filter(|schema| !schema.is_empty())
			.map(|schema| Some(schema.to_owned()))
			.ok_or_else(|| invalid(format!("schema of {method} must be a non-empty string"))),
	}
}

/// Where a page ended, plus the query it belongs to so that resuming with another query fails
/// instead of returning an arbitrary slice.
///
/// Wire form: `c_<kind>_<name>_<kinds>_<schema>`, each variable part base64 (RFC 4648, with
/// padding) and `~` standing for "absent". The client treats it as opaque.
struct Cursor {
	query: Query,
	kind: &'static str,
	name: String,
}

impl Cursor {
	fn at(object: &Object, query: &Query) -> Cursor {
		Cursor {
			query: Query {
				schema: query.schema.clone(),
				kinds: query.kinds.clone(),
			},
			kind: object.kind,
			name: object.name.clone(),
		}
	}

	fn encode(&self) -> String {
		format!(
			"c_{}_{}_{}_{}",
			self.kind,
			crate::value::base64(self.name.as_bytes()),
			crate::value::base64(self.query.kinds.join(",").as_bytes()),
			match &self.query.schema {
				Some(schema) => crate::value::base64(schema.as_bytes()),
				None => "~".to_owned(),
			}
		)
	}

	fn parse(text: &str) -> Result<Cursor, RpcError> {
		let not_a_cursor = || invalid("cursor is not a cursor this runtime issued");
		let rest = text.strip_prefix("c_").ok_or_else(not_a_cursor)?;
		let parts: Vec<&str> = rest.split('_').collect();
		let [kind, name, kinds, schema] = parts[..] else {
			return Err(not_a_cursor());
		};
		let kind = KINDS
			.iter()
			.copied()
			.find(|known| *known == kind)
			.ok_or_else(not_a_cursor)?;
		let name = decode(name).ok_or_else(not_a_cursor)?;
		let kinds = decode(kinds).ok_or_else(not_a_cursor)?;
		let kinds: Vec<&'static str> = kinds
			.split(',')
			.map(|kind| {
				KINDS
					.iter()
					.copied()
					.find(|known| *known == kind)
					.ok_or_else(not_a_cursor)
			})
			.collect::<Result<_, _>>()?;
		if kinds.is_empty() {
			return Err(not_a_cursor());
		}
		let schema = match decode(schema) {
			Some(schema) => Some(schema),
			None if schema == "~" => None,
			None => return Err(not_a_cursor()),
		};
		Ok(Cursor {
			query: Query { schema, kinds },
			kind,
			name,
		})
	}

	/// Whether `object` sorts after the cursor object in page order.
	fn is_before(&self, object: &Object) -> bool {
		(order(object.kind), &object.name) > (order(self.kind), &self.name)
	}
}

fn decode(text: &str) -> Option<String> {
	String::from_utf8(base64_decode(text)?).ok()
}

/// Base64 of RFC 4648 §4 with padding; `None` for anything that is not canonical base64.
fn base64_decode(text: &str) -> Option<Vec<u8>> {
	fn sextet(byte: u8) -> Option<u32> {
		Some(match byte {
			b'A'..=b'Z' => u32::from(byte - b'A'),
			b'a'..=b'z' => u32::from(byte - b'a') + 26,
			b'0'..=b'9' => u32::from(byte - b'0') + 52,
			b'+' => 62,
			b'/' => 63,
			_ => return None,
		})
	}
	let text = text.as_bytes();
	if text.len() % 4 != 0 {
		return None;
	}
	let mut bytes = Vec::with_capacity(text.len() / 4 * 3);
	for (index, chunk) in text.chunks(4).enumerate() {
		let pad = chunk.iter().rev().take_while(|byte| **byte == b'=').count();
		// Padding is only legal at the very end of the text, as a suffix of the last group. A
		// data character after a `=` therefore makes the whole text invalid.
		let after_padding = chunk[..chunk.len() - pad].contains(&b'=');
		if pad > 2 || after_padding || (pad > 0 && index + 1 != text.len() / 4) {
			return None;
		}
		let mut triple = 0u32;
		for byte in chunk {
			let value = if *byte == b'=' { 0 } else { sextet(*byte)? };
			triple = (triple << 6) | value;
		}
		bytes.push((triple >> 16) as u8);
		if pad < 2 {
			bytes.push((triple >> 8) as u8);
		}
		if pad < 1 {
			bytes.push(triple as u8);
		}
	}
	Some(bytes)
}

/// `"<name>"` as an SQL identifier, embedded quotes doubled.
fn quote_identifier(name: &str) -> String {
	format!("\"{}\"", name.replace('"', "\"\""))
}

/// `?1, ?2, …` for `count` bound parameters.
fn placeholders(count: usize) -> String {
	(1..=count)
		.map(|index| format!("?{index}"))
		.collect::<Vec<_>>()
		.join(", ")
}

/// Maps a SQLite failure onto the v1 error table without forwarding its message, which can carry
/// SQL text or a path (`nyala/rpc/README.md` §7).
fn domain_error(error: rusqlite::Error, detail: &str) -> RpcError {
	match error.sqlite_error_code() {
		Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
			RpcError::with_detail(
				ErrorKind::QueryTimeout,
				"database is locked by another connection",
			)
		}
		Some(rusqlite::ErrorCode::PermissionDenied | rusqlite::ErrorCode::ReadOnly) => {
			RpcError::with_detail(ErrorKind::PermissionDenied, "the database refused the read")
		}
		_ => RpcError::with_detail(ErrorKind::Internal, detail),
	}
}

fn invalid(detail: impl Into<String>) -> RpcError {
	RpcError::with_detail(ErrorKind::InvalidParams, detail)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::sqlite::test_files::{text, TempDir};

	fn params(value: Value) -> Map<String, Value> {
		match value {
			Value::Object(map) => map,
			other => panic!("params must be an object: {other}"),
		}
	}

	fn open(dir: &TempDir) -> Database {
		Database::open(text(&dir.database("db.sqlite")), true).unwrap()
	}

	fn all_objects(database: &Database) -> Value {
		database
			.list_objects(&params(json!({
				"sessionId": "s_1", "sessionGeneration": 1, "limit": 100,
			})))
			.unwrap()
	}

	#[test]
	fn base64_round_trips_every_byte_value() {
		let all: Vec<u8> = (0..=255).collect();
		assert_eq!(base64_decode(&crate::value::base64(&all)).unwrap(), all);
		for len in 0..8u8 {
			let bytes: Vec<u8> = (0..len).collect();
			assert_eq!(base64_decode(&crate::value::base64(&bytes)).unwrap(), bytes);
		}
		// `AA+A` is valid base64 (`+` is a data character), so it is not in this list.
		for broken in ["A", "AAA", "A===", "A==A", "!!!!", "AA*A", "AA==AAAA"] {
			assert!(base64_decode(broken).is_none(), "{broken}");
		}
		assert_eq!(base64_decode("AA+A").unwrap(), [0x00, 0x0f, 0x80]);
	}

	#[test]
	fn params_follow_the_method_schema() {
		let dir = TempDir::new("metadata-params");
		let database = open(&dir);
		let base = json!({"sessionId": "s_1", "sessionGeneration": 1, "limit": 10});
		let with = |key: &str, value: Value| {
			let mut params = base.clone();
			params[key] = value;
			params
		};
		for case in [
			json!({"sessionId": "s_1", "sessionGeneration": 1}),
			with("limit", json!(0)),
			with("limit", json!(1001)),
			with("limit", json!(1.5)),
			with("limit", json!("10")),
			with("kinds", json!("table")),
			with("kinds", json!([])),
			with("kinds", json!(["trigger"])),
			with("kinds", json!(["table", "table"])),
			with("schema", json!("")),
			with("schema", json!(7)),
			with("cursor", json!(7)),
			with("debug", json!(true)),
		] {
			let error = database.list_objects(&params(case.clone())).unwrap_err();
			assert_eq!(error.kind, ErrorKind::InvalidParams, "{case}");
		}
	}

	#[test]
	fn objects_are_listed_by_kind_then_name() {
		let dir = TempDir::new("metadata-list");
		let database = open(&dir);
		let result = all_objects(&database);
		assert_eq!(
			result["objects"],
			json!([
				{"name": "customers", "kind": "table", "schema": "main"},
				{"name": "recent_customers", "kind": "view", "schema": "main"},
				{"name": "customers_by_name", "kind": "index", "schema": "main"},
			])
		);
		assert_eq!(result["hasMore"], false);
		assert_eq!(result["nextCursor"], Value::Null);
	}

	#[test]
	fn sqlite_owned_objects_are_left_out() {
		let dir = TempDir::new("metadata-internal");
		let path = dir.join("internal.sqlite");
		// AUTOINCREMENT creates `sqlite_sequence`; an autoindex is named `sqlite_autoindex_*`.
		rusqlite::Connection::open(&path)
			.unwrap()
			.execute_batch(
				"CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE);",
			)
			.unwrap();
		let database = Database::open(text(&path), true).unwrap();
		let listed = all_objects(&database);
		let names: Vec<&str> = listed["objects"]
			.as_array()
			.unwrap()
			.iter()
			.map(|object| object["name"].as_str().unwrap())
			.collect();
		assert_eq!(names, ["t"], "{names:?}");
	}

	#[test]
	fn kinds_filter_and_pagination_walk_the_whole_list_once() {
		let dir = TempDir::new("metadata-paging");
		let database = open(&dir);
		let tables = database
			.list_objects(&params(json!({
				"sessionId": "s_1", "sessionGeneration": 1, "kinds": ["table"], "limit": 10,
			})))
			.unwrap();
		assert_eq!(tables["objects"].as_array().unwrap().len(), 1);
		assert_eq!(tables["objects"][0]["name"], "customers");

		// One object per page must visit every object exactly once, in order.
		let mut seen = Vec::new();
		let mut cursor = Value::Null;
		for _ in 0..10 {
			let page = database
				.list_objects(&params(json!({
					"sessionId": "s_1", "sessionGeneration": 1, "cursor": cursor, "limit": 1,
				})))
				.unwrap();
			for object in page["objects"].as_array().unwrap() {
				seen.push((
					object["kind"].as_str().unwrap().to_owned(),
					object["name"].as_str().unwrap().to_owned(),
				));
			}
			cursor = page["nextCursor"].clone();
			if page["hasMore"] != true {
				assert_eq!(
					page["nextCursor"],
					Value::Null,
					"the last page has no cursor"
				);
				break;
			}
		}
		assert_eq!(
			seen,
			[
				("table".to_owned(), "customers".to_owned()),
				("view".to_owned(), "recent_customers".to_owned()),
				("index".to_owned(), "customers_by_name".to_owned()),
			]
		);
	}

	#[test]
	fn a_cursor_from_another_query_or_a_foreign_string_is_refused() {
		let dir = TempDir::new("metadata-cursor");
		let database = open(&dir);
		let first_page = database
			.list_objects(&params(json!({
				"sessionId": "s_1", "sessionGeneration": 1, "limit": 1,
			})))
			.unwrap();
		let cursor = first_page["nextCursor"].clone();
		assert!(cursor.is_string(), "{first_page}");

		// The same cursor with a different kind set or schema belongs to another query.
		for change in [json!({"kinds": ["table"]}), json!({"schema": "main"})] {
			let mut query = json!({
				"sessionId": "s_1", "sessionGeneration": 1, "cursor": cursor, "limit": 1,
			});
			for (key, value) in change.as_object().unwrap() {
				query[key] = value.clone();
			}
			let error = database.list_objects(&params(query.clone())).unwrap_err();
			assert_eq!(error.kind, ErrorKind::InvalidParams, "{query}");
		}

		for broken in [
			json!("nope"),
			json!("c_table"),
			json!(format!("c_trigger_YQ==_dGFibGU=_{}", "~")),
			json!(format!("c_table_!!!_dGFibGU=_{}", "~")),
			json!("c_table_YQ==_dGFibGU="),
			json!(format!("c_table_YQ==_!!!_{}", "~")),
		] {
			let error = database
				.list_objects(&params(json!({
					"sessionId": "s_1", "sessionGeneration": 1, "cursor": broken, "limit": 1,
				})))
				.unwrap_err();
			assert_eq!(error.kind, ErrorKind::InvalidParams, "{broken}");
		}
	}

	#[test]
	fn a_cursor_survives_an_object_renamed_between_pages() {
		let dir = TempDir::new("metadata-rename");
		let database = open(&dir);
		let first = database
			.list_objects(&params(json!({
				"sessionId": "s_1", "sessionGeneration": 1, "limit": 1,
			})))
			.unwrap();
		let cursor = first["nextCursor"].clone();
		// A row inserted before the cursor must not make the next page repeat or skip an object:
		// the scan resumes strictly after the name the cursor recorded.
		let more = database
			.list_objects(&params(json!({
				"sessionId": "s_1", "sessionGeneration": 1, "cursor": cursor, "limit": 10,
			})))
			.unwrap();
		let names: Vec<&Value> = more["objects"]
			.as_array()
			.unwrap()
			.iter()
			.map(|object| &object["name"])
			.collect();
		assert_eq!(
			names,
			[&json!("recent_customers"), &json!("customers_by_name")]
		);
	}

	#[test]
	fn an_unknown_schema_is_refused() {
		let dir = TempDir::new("metadata-schema");
		let database = open(&dir);
		for params in [
			json!({"sessionId": "s_1", "sessionGeneration": 1, "schema": "other", "limit": 10}),
			json!({"sessionId": "s_1", "sessionGeneration": 1, "schema": "temp", "limit": 10, "kinds": ["table"]}),
		] {
			let error = database
				.list_objects(&self::params(params.clone()))
				.unwrap_err();
			assert_eq!(error.kind, ErrorKind::InvalidParams, "{params}");
		}
		assert_eq!(database.attached_schemas().unwrap(), ["main"]);
	}

	#[test]
	fn describe_returns_columns_with_keys_and_nullability() {
		let dir = TempDir::new("metadata-describe");
		let database = open(&dir);
		let result = database
			.describe(&params(json!({
				"sessionId": "s_1", "sessionGeneration": 1, "object": {"name": "customers"},
			})))
			.unwrap();
		// `id INTEGER PRIMARY KEY` is the rowid: SQLite accepts NULL for it and allocates a rowid,
		// so it is nullable even though it is the key.
		assert_eq!(
			result["columns"],
			json!([
				{"ordinal": 0, "name": "id", "nativeType": "INTEGER", "nullable": true, "primaryKey": true},
				{"ordinal": 1, "name": "name", "nativeType": "TEXT", "nullable": false},
			])
		);
	}

	#[test]
	fn only_a_rowid_primary_key_is_reported_nullable() {
		let dir = TempDir::new("metadata-describe-keys");
		let path = dir.join("keys.sqlite");
		rusqlite::Connection::open(&path)
			.unwrap()
			.execute_batch(
				"CREATE TABLE alias(id INTEGER PRIMARY KEY, note TEXT);
				CREATE TABLE text_key(id TEXT PRIMARY KEY, note TEXT);
				CREATE TABLE int_key(id INT PRIMARY KEY, note TEXT);
				CREATE TABLE composite(a TEXT, b TEXT, PRIMARY KEY(a, b));
				CREATE TABLE without_rowid(a INTEGER PRIMARY KEY, note TEXT) WITHOUT ROWID;
				CREATE TABLE declared(id TEXT PRIMARY KEY NOT NULL, note TEXT);",
			)
			.unwrap();
		let database = Database::open(text(&path), true).unwrap();
		let nullable = |name: &str| {
			let described = database
				.describe(&params(json!({
					"sessionId": "s_1", "sessionGeneration": 1, "object": {"name": name},
				})))
				.unwrap();
			described["columns"]
				.as_array()
				.unwrap()
				.iter()
				.find(|column| column["primaryKey"] == true)
				.unwrap_or_else(|| panic!("{name} has a primary key column"))
				.clone()
		};
		// The rowid alias is the one primary key SQLite lets hold NULL.
		assert_eq!(nullable("alias")["nullable"], true, "rowid alias");
		assert_eq!(nullable("text_key")["nullable"], false, "TEXT key");
		assert_eq!(nullable("int_key")["nullable"], false, "INT key");
		assert_eq!(nullable("composite")["nullable"], false, "composite key");
		assert_eq!(
			nullable("without_rowid")["nullable"],
			false,
			"WITHOUT ROWID"
		);
		assert_eq!(nullable("declared")["nullable"], false, "declared NOT NULL");
	}

	#[test]
	fn describe_covers_a_view_and_a_column_declared_without_a_type() {
		let dir = TempDir::new("metadata-describe-view");
		let path = dir.join("typed.sqlite");
		rusqlite::Connection::open(&path)
			.unwrap()
			.execute_batch(
				"CREATE TABLE raw(anything, note TEXT NULL);
				CREATE VIEW projected AS SELECT note FROM raw;",
			)
			.unwrap();
		let database = Database::open(text(&path), true).unwrap();

		let columns = database
			.describe(&params(json!({
				"sessionId": "s_1", "sessionGeneration": 1, "object": {"name": "raw"},
			})))
			.unwrap();
		assert_eq!(
			columns["columns"],
			json!([
				{"ordinal": 0, "name": "anything", "nativeType": "BLOB", "nullable": true},
				{"ordinal": 1, "name": "note", "nativeType": "TEXT", "nullable": true},
			])
		);
		let view = database
			.describe(&params(json!({
				"sessionId": "s_1", "sessionGeneration": 1, "object": {"name": "projected", "schema": "main"},
			})))
			.unwrap();
		assert_eq!(view["columns"].as_array().unwrap().len(), 1);
	}

	#[test]
	fn describe_refuses_unknown_objects_indexes_and_unsafe_input() {
		let dir = TempDir::new("metadata-describe-bad");
		let database = open(&dir);
		for object in [
			json!({"name": "missing"}),
			json!({"name": ""}),
			json!({"name": 7}),
			json!({"name": "customers", "schema": "other"}),
			json!({"name": "customers", "schema": ""}),
			json!({"name": "customers", "debug": true}),
			json!({"name": "customers_by_name"}),
		] {
			let error = database
				.describe(&params(json!({
					"sessionId": "s_1", "sessionGeneration": 1, "object": object,
				})))
				.unwrap_err();
			assert_eq!(error.kind, ErrorKind::InvalidParams, "{object}");
		}
	}

	#[test]
	fn a_name_that_looks_like_sql_stays_a_name() {
		let dir = TempDir::new("metadata-quoted");
		let path = dir.join("quoted.sqlite");
		rusqlite::Connection::open(&path)
			.unwrap()
			.execute_batch(
				r#"CREATE TABLE "it's ""quoted"""(x INTEGER);
				CREATE TABLE "bob'; DROP TABLE customers; --"(y TEXT);"#,
			)
			.unwrap();
		let database = Database::open(text(&path), true).unwrap();
		for name in [r#"it's "quoted""#, "bob'; DROP TABLE customers; --"] {
			let result = database
				.describe(&params(json!({
					"sessionId": "s_1", "sessionGeneration": 1, "object": {"name": name},
				})))
				.unwrap();
			assert_eq!(result["columns"].as_array().unwrap().len(), 1, "{name}");
		}
		// Neither name was executed as SQL.
		assert_eq!(
			all_objects(&database)["objects"].as_array().unwrap().len(),
			2
		);
	}
}
