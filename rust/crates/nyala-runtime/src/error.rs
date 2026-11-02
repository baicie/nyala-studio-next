/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Structured errors (`nyala/rpc/README.md` §7).
//!
//! `kind`, `code` and `retryable` come from [`crate::contract`], which is generated from
//! `nyala/rpc/v1/error-codes.json` (N-110): a kind added to the contract without regenerating is a
//! compile error here, and a kind removed from it leaves a dangling `contract::` path. Only the
//! human-readable `message` is written in this file.

use std::fmt;

use serde_json::{json, Map, Value};

use crate::contract::{self, ErrorKindSpec};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorKind {
	ParseError,
	InvalidRequest,
	MethodNotFound,
	InvalidParams,
	Internal,
	AuthFailed,
	NetworkUnreachable,
	TlsError,
	QueryTimeout,
	QueryCancelled,
	SqlSyntax,
	ReadOnlyDenied,
	PermissionDenied,
	ResultExpired,
	InvalidSession,
	ProtocolMismatch,
	RuntimeLost,
	UnknownCommitStatus,
	ResourceLimit,
}

struct Spec {
	kind: &'static str,
	code: i64,
	retryable: bool,
	message: &'static str,
}

impl ErrorKind {
	pub const ALL: [ErrorKind; contract::ERROR_KIND_COUNT] = [
		ErrorKind::ParseError,
		ErrorKind::InvalidRequest,
		ErrorKind::MethodNotFound,
		ErrorKind::InvalidParams,
		ErrorKind::Internal,
		ErrorKind::AuthFailed,
		ErrorKind::NetworkUnreachable,
		ErrorKind::TlsError,
		ErrorKind::QueryTimeout,
		ErrorKind::QueryCancelled,
		ErrorKind::SqlSyntax,
		ErrorKind::ReadOnlyDenied,
		ErrorKind::PermissionDenied,
		ErrorKind::ResultExpired,
		ErrorKind::InvalidSession,
		ErrorKind::ProtocolMismatch,
		ErrorKind::RuntimeLost,
		ErrorKind::UnknownCommitStatus,
		ErrorKind::ResourceLimit,
	];

	const fn spec(self) -> Spec {
		const fn spec(contract: ErrorKindSpec, message: &'static str) -> Spec {
			Spec {
				kind: contract.kind,
				code: contract.code,
				retryable: contract.retryable,
				message,
			}
		}
		match self {
			ErrorKind::ParseError => spec(contract::PARSE_ERROR, "Parse error"),
			ErrorKind::InvalidRequest => spec(contract::INVALID_REQUEST, "Invalid request"),
			ErrorKind::MethodNotFound => spec(contract::METHOD_NOT_FOUND, "Method not found"),
			ErrorKind::InvalidParams => spec(contract::INVALID_PARAMS, "Invalid params"),
			ErrorKind::Internal => spec(contract::INTERNAL, "Internal error"),
			ErrorKind::AuthFailed => spec(contract::AUTH_FAILED, "Authentication failed"),
			ErrorKind::NetworkUnreachable => {
				spec(contract::NETWORK_UNREACHABLE, "Network unreachable")
			}
			ErrorKind::TlsError => spec(contract::TLS_ERROR, "TLS error"),
			ErrorKind::QueryTimeout => spec(contract::QUERY_TIMEOUT, "Query timed out"),
			ErrorKind::QueryCancelled => spec(contract::QUERY_CANCELLED, "Query cancelled"),
			ErrorKind::SqlSyntax => spec(contract::SQL_SYNTAX, "SQL syntax error"),
			ErrorKind::ReadOnlyDenied => spec(
				contract::READ_ONLY_DENIED,
				"Read-only session denied the statement",
			),
			ErrorKind::PermissionDenied => spec(contract::PERMISSION_DENIED, "Permission denied"),
			ErrorKind::ResultExpired => spec(contract::RESULT_EXPIRED, "Result handle expired"),
			ErrorKind::InvalidSession => spec(contract::INVALID_SESSION, "Invalid session"),
			ErrorKind::ProtocolMismatch => spec(contract::PROTOCOL_MISMATCH, "Protocol mismatch"),
			ErrorKind::RuntimeLost => spec(contract::RUNTIME_LOST, "Runtime lost"),
			ErrorKind::UnknownCommitStatus => {
				spec(contract::UNKNOWN_COMMIT_STATUS, "Commit status unknown")
			}
			ErrorKind::ResourceLimit => spec(contract::RESOURCE_LIMIT, "Resource limit exceeded"),
		}
	}

	/// Stable identifier sent as `error.data.kind`. Clients branch on it, not on `message`.
	pub fn as_str(self) -> &'static str {
		self.spec().kind
	}

	pub fn code(self) -> i64 {
		self.spec().code
	}

	pub fn retryable(self) -> bool {
		self.spec().retryable
	}
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcError {
	pub kind: ErrorKind,
	/// Sent as `safeDetail`. Must not contain secrets, connection strings, SQL text, row data or
	/// user names inside paths.
	pub safe_detail: Option<String>,
	/// Sent as `sessionId`: the session the failed request named.
	pub session_id: Option<String>,
	/// Sent as `executionId`: the execution the failed request named or produced.
	pub execution_id: Option<String>,
	/// Sent as `sqlState`: the database's own result code, when a database reported the failure.
	/// SQLite has no SQLSTATE codes, so this is its extended result code in decimal
	/// (`README.md` §7 allows any string); it tells a constraint violation (`19`, `1555`, `2067`)
	/// from one the preparer rejected (`1`).
	pub sql_state: Option<String>,
}

impl RpcError {
	pub fn new(kind: ErrorKind) -> Self {
		RpcError {
			kind,
			safe_detail: None,
			session_id: None,
			execution_id: None,
			sql_state: None,
		}
	}

	pub fn with_detail(kind: ErrorKind, detail: impl Into<String>) -> Self {
		RpcError {
			kind,
			safe_detail: Some(detail.into()),
			session_id: None,
			execution_id: None,
			sql_state: None,
		}
	}

	/// Attaches the session the request named. Callers pass only ids that match the contract's id
	/// pattern, because `data.sessionId` is checked against it.
	pub fn for_session(mut self, session_id: impl Into<String>) -> Self {
		self.session_id = Some(session_id.into());
		self
	}

	/// Attaches the execution the request named. Callers pass only ids that match the contract's id
	/// pattern, because `data.executionId` is checked against it.
	pub fn for_execution(mut self, execution_id: impl Into<String>) -> Self {
		self.execution_id = Some(execution_id.into());
		self
	}

	/// Attaches the database's own result code (`data.sqlState`).
	pub fn with_sql_state(mut self, sql_state: impl Into<String>) -> Self {
		self.sql_state = Some(sql_state.into());
		self
	}

	/// The `error` member of a failure envelope.
	pub fn to_json(&self) -> Value {
		let mut data = Map::new();
		data.insert("kind".into(), json!(self.kind.as_str()));
		data.insert("retryable".into(), json!(self.kind.retryable()));
		if let Some(detail) = &self.safe_detail {
			data.insert("safeDetail".into(), json!(detail));
		}
		if let Some(session_id) = &self.session_id {
			data.insert("sessionId".into(), json!(session_id));
		}
		if let Some(execution_id) = &self.execution_id {
			data.insert("executionId".into(), json!(execution_id));
		}
		if let Some(sql_state) = &self.sql_state {
			data.insert("sqlState".into(), json!(sql_state));
		}
		json!({
			"code": self.kind.code(),
			"message": self.kind.spec().message,
			"data": data,
		})
	}
}

impl fmt::Display for RpcError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match &self.safe_detail {
			Some(detail) => write!(f, "{}: {detail}", self.kind.as_str()),
			None => f.write_str(self.kind.as_str()),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn error_object_has_the_contract_shape() {
		let error =
			RpcError::with_detail(ErrorKind::ResultExpired, "result released or ttl exceeded");
		assert_eq!(
			error.to_json(),
			json!({
				"code": -32009,
				"message": "Result handle expired",
				"data": {
					"kind": "RESULT_EXPIRED",
					"retryable": false,
					"safeDetail": "result released or ttl exceeded",
				},
			})
		);
	}

	#[test]
	fn safe_detail_is_optional() {
		let data = RpcError::new(ErrorKind::RuntimeLost).to_json()["data"].clone();
		assert_eq!(data, json!({"kind": "RUNTIME_LOST", "retryable": true}));
	}

	#[test]
	fn a_database_result_code_is_reported_as_sql_state() {
		let error = RpcError::with_detail(ErrorKind::SqlSyntax, "rejected")
			.with_sql_state("2067")
			.for_execution("s_1e1");
		assert_eq!(
			error.to_json()["data"],
			json!({
				"kind": "SQL_SYNTAX",
				"retryable": false,
				"safeDetail": "rejected",
				"executionId": "s_1e1",
				"sqlState": "2067",
			})
		);
	}
}
