/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Envelope parsing and protocol constants (`nyala/rpc/README.md` §2–§4).
//!
//! Payloads are kept as [`serde_json::Value`] and checked explicitly instead of being mapped to
//! hand-written DTOs: generated TS/Rust types are N-110's job, and a second DTO set here would
//! be a second source of truth.

use serde_json::{Map, Value};

use crate::error::{ErrorKind, RpcError};

pub const JSONRPC_VERSION: &str = "2.0";
pub const PROTOCOL_MAJOR: i64 = 1;
pub const PROTOCOL_MINOR: i64 = 0;

/// Reported as `runtimeBuild` in the `runtime.hello` result.
pub const RUNTIME_BUILD: &str = env!("CARGO_PKG_VERSION");

/// Request methods of the v1 catalog (README §4). Anything else is `METHOD_NOT_FOUND`.
pub const V1_REQUEST_METHODS: &[&str] = &[
	"runtime.hello",
	"runtime.health",
	"connection.test",
	"connection.open",
	"connection.close",
	"connection.listSessions",
	"metadata.listObjects",
	"metadata.describe",
	"query.execute",
	"query.cancel",
	"query.getState",
	"result.fetchPage",
	"result.release",
];

/// v1 features this build implements. Empty until a driver lands (N-104): the runtime must not
/// advertise capabilities it cannot serve.
pub const RUNTIME_FEATURES: &[&str] = &[];

/// Resource limits advertised in the `runtime.hello` result (README §7 defaults).
pub const MAX_INITIAL_ROWS: u32 = 200;
pub const MAX_PAGE_ROWS: u32 = 1000;
pub const MAX_RESULT_TTL_SECS: u32 = 300;
pub const MAX_CONCURRENT_EXECUTIONS: u32 = 4;

/// Checks the schema's id pattern `^[a-z]{1,4}_[A-Za-z0-9]{1,64}$`.
pub fn is_valid_id(id: &str) -> bool {
	let Some((prefix, rest)) = id.split_once('_') else {
		return false;
	};
	(1..=4).contains(&prefix.len())
		&& prefix.bytes().all(|byte| byte.is_ascii_lowercase())
		&& (1..=64).contains(&rest.len())
		&& rest.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

#[derive(Debug, Clone, PartialEq)]
pub struct Request {
	pub id: String,
	pub method: String,
	pub params: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
	Request(Request),
	/// A message without `id`. v1 defines no client-to-runtime notifications.
	Notification,
}

/// A payload that is not a valid envelope.
#[derive(Debug, Clone, PartialEq)]
pub struct Rejected {
	/// The request id, when the payload carried a valid one; otherwise the reply uses `null`.
	pub id: Option<String>,
	pub error: RpcError,
}

/// Parses one frame payload into an envelope.
///
/// Envelope-level problems are `PARSE_ERROR` or `INVALID_REQUEST`. Method names and parameter
/// contents are checked by the caller.
pub fn parse_message(payload: &[u8]) -> Result<Incoming, Rejected> {
	let value: Value = serde_json::from_slice(payload).map_err(|_| Rejected {
		id: None,
		error: RpcError::with_detail(ErrorKind::ParseError, "payload is not valid UTF-8 JSON"),
	})?;
	let Value::Object(mut envelope) = value else {
		return Err(invalid(None, "payload must be a JSON object"));
	};

	// Read the id first so that later errors can be correlated with the request.
	let id = match envelope.remove("id") {
		None => None,
		Some(Value::String(id)) if is_valid_id(&id) => Some(id),
		Some(_) => {
			return Err(invalid(
				None,
				"id must be a string matching ^[a-z]{1,4}_[A-Za-z0-9]{1,64}$",
			))
		}
	};
	if envelope.remove("jsonrpc").as_ref().and_then(Value::as_str) != Some(JSONRPC_VERSION) {
		return Err(invalid(id, "jsonrpc must be \"2.0\""));
	}
	let method = match envelope.remove("method") {
		Some(Value::String(method)) => method,
		_ => return Err(invalid(id, "method must be a string")),
	};
	let params = match envelope.remove("params") {
		Some(Value::Object(params)) => params,
		Some(_) => return Err(invalid(id, "params must be an object")),
		None => return Err(invalid(id, "params is required; send {} for no parameters")),
	};
	if !envelope.is_empty() {
		return Err(invalid(id, "unexpected envelope property"));
	}

	Ok(match id {
		Some(id) => Incoming::Request(Request { id, method, params }),
		None => Incoming::Notification,
	})
}

fn invalid(id: Option<String>, detail: &str) -> Rejected {
	Rejected {
		id,
		error: RpcError::with_detail(ErrorKind::InvalidRequest, detail),
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;

	fn parse(value: Value) -> Result<Incoming, Rejected> {
		parse_message(value.to_string().as_bytes())
	}

	fn rejected_kind(result: Result<Incoming, Rejected>) -> (Option<String>, ErrorKind) {
		let rejected = result.expect_err("payload must be rejected");
		(rejected.id, rejected.error.kind)
	}

	#[test]
	fn id_pattern() {
		for id in [
			"rq_001",
			"a_1",
			"abcd_Z9",
			&format!("ex_{}", "a".repeat(64)),
		] {
			assert!(is_valid_id(id), "{id} must be valid");
		}
		for id in [
			"",
			"rq001",
			"RQ_1",
			"abcde_1",
			"rq_",
			"_1",
			"rq_00-1",
			"rq_1_2",
			"rq_1\n",
			"rq_\u{e9}",
			&format!("ex_{}", "a".repeat(65)),
		] {
			assert!(!is_valid_id(id), "{id:?} must be invalid");
		}
	}

	#[test]
	fn parses_a_request() {
		let parsed = parse(
			json!({"jsonrpc": "2.0", "id": "rq_1", "method": "runtime.health", "params": {}}),
		);
		assert_eq!(
			parsed,
			Ok(Incoming::Request(Request {
				id: "rq_1".into(),
				method: "runtime.health".into(),
				params: Map::new(),
			}))
		);
	}

	#[test]
	fn message_without_id_is_a_notification() {
		let parsed = parse(json!({"jsonrpc": "2.0", "method": "query.stateChanged", "params": {}}));
		assert_eq!(parsed, Ok(Incoming::Notification));
	}

	#[test]
	fn malformed_json_and_invalid_utf8_are_parse_errors() {
		for payload in [&b"{\"jsonrpc\":"[..], b"{} {}", b"\xff\xfe", b"not json"] {
			assert_eq!(
				rejected_kind(parse_message(payload)),
				(None, ErrorKind::ParseError),
				"{payload:?}"
			);
		}
	}

	#[test]
	fn non_object_payloads_are_invalid_requests() {
		for value in [
			json!([]),
			json!([{"jsonrpc": "2.0"}]),
			json!("text"),
			json!(1),
			json!(null),
			json!({}),
		] {
			assert_eq!(
				rejected_kind(parse(value.clone())),
				(None, ErrorKind::InvalidRequest),
				"{value}"
			);
		}
	}

	#[test]
	fn ids_must_be_contract_strings() {
		for id in [json!(1), json!(null), json!("1"), json!("RQ_1")] {
			let envelope =
				json!({"jsonrpc": "2.0", "id": id, "method": "runtime.health", "params": {}});
			assert_eq!(
				rejected_kind(parse(envelope)),
				(None, ErrorKind::InvalidRequest),
				"{id}"
			);
		}
	}

	#[test]
	fn envelope_errors_echo_a_valid_id() {
		let cases = [
			json!({"jsonrpc": "1.0", "id": "rq_1", "method": "runtime.health", "params": {}}),
			json!({"id": "rq_1", "method": "runtime.health", "params": {}}),
			json!({"jsonrpc": "2.0", "id": "rq_1", "method": 7, "params": {}}),
			json!({"jsonrpc": "2.0", "id": "rq_1", "params": {}}),
			json!({"jsonrpc": "2.0", "id": "rq_1", "method": "runtime.health", "params": []}),
			json!({"jsonrpc": "2.0", "id": "rq_1", "method": "runtime.health"}),
			json!({"jsonrpc": "2.0", "id": "rq_1", "method": "runtime.health", "params": {}, "debug": true}),
			json!({"jsonrpc": "2.0", "id": "rq_1", "result": {}}),
		];
		for envelope in cases {
			assert_eq!(
				rejected_kind(parse(envelope.clone())),
				(Some("rq_1".into()), ErrorKind::InvalidRequest),
				"{envelope}"
			);
		}
	}
}
