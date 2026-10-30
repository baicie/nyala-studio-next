/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Structured errors (`nyala/rpc/README.md` §7).
//!
//! The table mirrors `nyala/rpc/v1/error-codes.json`; `tests/conformance.rs` compares the two
//! entry by entry, so neither can change alone.

use std::fmt;

use serde_json::{json, Map, Value};

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
	pub const ALL: [ErrorKind; 19] = [
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
		const fn spec(
			kind: &'static str,
			code: i64,
			retryable: bool,
			message: &'static str,
		) -> Spec {
			Spec {
				kind,
				code,
				retryable,
				message,
			}
		}
		match self {
			ErrorKind::ParseError => spec("PARSE_ERROR", -32700, false, "Parse error"),
			ErrorKind::InvalidRequest => spec("INVALID_REQUEST", -32600, false, "Invalid request"),
			ErrorKind::MethodNotFound => {
				spec("METHOD_NOT_FOUND", -32601, false, "Method not found")
			}
			ErrorKind::InvalidParams => spec("INVALID_PARAMS", -32602, false, "Invalid params"),
			ErrorKind::Internal => spec("INTERNAL", -32603, false, "Internal error"),
			ErrorKind::AuthFailed => spec("AUTH_FAILED", -32001, false, "Authentication failed"),
			ErrorKind::NetworkUnreachable => {
				spec("NETWORK_UNREACHABLE", -32002, true, "Network unreachable")
			}
			ErrorKind::TlsError => spec("TLS_ERROR", -32003, false, "TLS error"),
			ErrorKind::QueryTimeout => spec("QUERY_TIMEOUT", -32004, false, "Query timed out"),
			ErrorKind::QueryCancelled => spec("QUERY_CANCELLED", -32005, false, "Query cancelled"),
			ErrorKind::SqlSyntax => spec("SQL_SYNTAX", -32006, false, "SQL syntax error"),
			ErrorKind::ReadOnlyDenied => spec(
				"READ_ONLY_DENIED",
				-32007,
				false,
				"Read-only session denied the statement",
			),
			ErrorKind::PermissionDenied => {
				spec("PERMISSION_DENIED", -32008, false, "Permission denied")
			}
			ErrorKind::ResultExpired => {
				spec("RESULT_EXPIRED", -32009, false, "Result handle expired")
			}
			ErrorKind::InvalidSession => spec("INVALID_SESSION", -32010, false, "Invalid session"),
			ErrorKind::ProtocolMismatch => {
				spec("PROTOCOL_MISMATCH", -32011, false, "Protocol mismatch")
			}
			ErrorKind::RuntimeLost => spec("RUNTIME_LOST", -32012, true, "Runtime lost"),
			ErrorKind::UnknownCommitStatus => spec(
				"UNKNOWN_COMMIT_STATUS",
				-32013,
				false,
				"Commit status unknown",
			),
			ErrorKind::ResourceLimit => {
				spec("RESOURCE_LIMIT", -32014, false, "Resource limit exceeded")
			}
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
}

impl RpcError {
	pub fn new(kind: ErrorKind) -> Self {
		RpcError {
			kind,
			safe_detail: None,
		}
	}

	pub fn with_detail(kind: ErrorKind, detail: impl Into<String>) -> Self {
		RpcError {
			kind,
			safe_detail: Some(detail.into()),
		}
	}

	/// The `error` member of a failure envelope.
	pub fn to_json(&self) -> Value {
		let mut data = Map::new();
		data.insert("kind".into(), json!(self.kind.as_str()));
		data.insert("retryable".into(), json!(self.kind.retryable()));
		if let Some(detail) = &self.safe_detail {
			data.insert("safeDetail".into(), json!(detail));
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
}
