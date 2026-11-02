/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Generated from `nyala/rpc/v1/` by `scripts/nyala/generate-rpc-contract.ts`.
//!
//! Do not edit: change the contract and run `npm run nyala:generate-rpc`.
//! `npm run nyala:check-rpc-generated` fails when this file no longer matches it.

/// One entry of `nyala/rpc/v1/error-codes.json`: the stable `kind`, its JSON-RPC `code` and
/// whether a client may retry it automatically.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ErrorKindSpec {
	pub kind: &'static str,
	pub code: i64,
	pub retryable: bool,
}

/// Request methods of the v1 catalog (`nyala/rpc/README.md` section 4), in contract order.
pub const REQUEST_METHODS: [&str; 13] = [
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

/// Notification methods of the v1 catalog. v1 defines none in the client-to-runtime direction.
pub const NOTIFICATION_METHODS: [&str; 2] = ["query.stateChanged", "runtime.restarted"];

/// The `id` pattern of `$defs/id`.
pub const ID_PATTERN: &str = "^[a-z]{1,4}_[A-Za-z0-9]{1,64}$";

/// Entries of `error-codes.json`; `error.rs` names them in its `match`.
pub const ERROR_KIND_COUNT: usize = 19;

pub const PARSE_ERROR: ErrorKindSpec = ErrorKindSpec {
	kind: "PARSE_ERROR",
	code: -32700,
	retryable: false,
};

pub const INVALID_REQUEST: ErrorKindSpec = ErrorKindSpec {
	kind: "INVALID_REQUEST",
	code: -32600,
	retryable: false,
};

pub const METHOD_NOT_FOUND: ErrorKindSpec = ErrorKindSpec {
	kind: "METHOD_NOT_FOUND",
	code: -32601,
	retryable: false,
};

pub const INVALID_PARAMS: ErrorKindSpec = ErrorKindSpec {
	kind: "INVALID_PARAMS",
	code: -32602,
	retryable: false,
};

pub const INTERNAL: ErrorKindSpec = ErrorKindSpec {
	kind: "INTERNAL",
	code: -32603,
	retryable: false,
};

pub const AUTH_FAILED: ErrorKindSpec = ErrorKindSpec {
	kind: "AUTH_FAILED",
	code: -32001,
	retryable: false,
};

pub const NETWORK_UNREACHABLE: ErrorKindSpec = ErrorKindSpec {
	kind: "NETWORK_UNREACHABLE",
	code: -32002,
	retryable: true,
};

pub const TLS_ERROR: ErrorKindSpec = ErrorKindSpec {
	kind: "TLS_ERROR",
	code: -32003,
	retryable: false,
};

pub const QUERY_TIMEOUT: ErrorKindSpec = ErrorKindSpec {
	kind: "QUERY_TIMEOUT",
	code: -32004,
	retryable: false,
};

pub const QUERY_CANCELLED: ErrorKindSpec = ErrorKindSpec {
	kind: "QUERY_CANCELLED",
	code: -32005,
	retryable: false,
};

pub const SQL_SYNTAX: ErrorKindSpec = ErrorKindSpec {
	kind: "SQL_SYNTAX",
	code: -32006,
	retryable: false,
};

pub const READ_ONLY_DENIED: ErrorKindSpec = ErrorKindSpec {
	kind: "READ_ONLY_DENIED",
	code: -32007,
	retryable: false,
};

pub const PERMISSION_DENIED: ErrorKindSpec = ErrorKindSpec {
	kind: "PERMISSION_DENIED",
	code: -32008,
	retryable: false,
};

pub const RESULT_EXPIRED: ErrorKindSpec = ErrorKindSpec {
	kind: "RESULT_EXPIRED",
	code: -32009,
	retryable: false,
};

pub const INVALID_SESSION: ErrorKindSpec = ErrorKindSpec {
	kind: "INVALID_SESSION",
	code: -32010,
	retryable: false,
};

pub const PROTOCOL_MISMATCH: ErrorKindSpec = ErrorKindSpec {
	kind: "PROTOCOL_MISMATCH",
	code: -32011,
	retryable: false,
};

pub const RUNTIME_LOST: ErrorKindSpec = ErrorKindSpec {
	kind: "RUNTIME_LOST",
	code: -32012,
	retryable: true,
};

pub const UNKNOWN_COMMIT_STATUS: ErrorKindSpec = ErrorKindSpec {
	kind: "UNKNOWN_COMMIT_STATUS",
	code: -32013,
	retryable: false,
};

pub const RESOURCE_LIMIT: ErrorKindSpec = ErrorKindSpec {
	kind: "RESOURCE_LIMIT",
	code: -32014,
	retryable: false,
};
