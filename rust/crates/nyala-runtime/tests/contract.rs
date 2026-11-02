/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! The generated declarations against the contract files (N-110).
//!
//! `contract.rs` is produced by `scripts/nyala/generate-rpc-contract.ts` from `nyala/rpc/v1/`.
//! These tests read the same files and compare every generated value with them, so a contract
//! change without regenerating fails here even in a checkout whose generator never ran.

mod support;

use std::collections::BTreeSet;

use nyala_runtime::contract;
use nyala_runtime::error::ErrorKind;
use nyala_runtime::protocol::V1_REQUEST_METHODS;
use support::{read_json, ERROR_CODES_PATH, SCHEMA_PATH};

#[test]
fn generated_methods_match_the_request_union() {
	let schema = read_json(SCHEMA_PATH);
	let from_schema: Vec<&str> = schema["$defs"]["request"]["oneOf"]
		.as_array()
		.expect("request branches")
		.iter()
		.map(|branch| {
			branch["properties"]["method"]["const"]
				.as_str()
				.expect("method const")
		})
		.collect();
	assert_eq!(contract::REQUEST_METHODS.as_slice(), from_schema);
	assert_eq!(V1_REQUEST_METHODS, from_schema.as_slice());
}

#[test]
fn generated_notifications_match_the_notification_union() {
	let schema = read_json(SCHEMA_PATH);
	let from_schema: Vec<&str> = schema["$defs"]["notification"]["oneOf"]
		.as_array()
		.expect("notification branches")
		.iter()
		.map(|branch| {
			branch["properties"]["method"]["const"]
				.as_str()
				.expect("method const")
		})
		.collect();
	assert_eq!(contract::NOTIFICATION_METHODS.as_slice(), from_schema);
}

#[test]
fn generated_identifier_pattern_matches_the_contract() {
	let schema = read_json(SCHEMA_PATH);
	assert_eq!(contract::ID_PATTERN, schema["$defs"]["id"]["pattern"]);
}

#[test]
fn generated_error_kinds_match_the_error_table() {
	let registry = read_json(ERROR_CODES_PATH);
	let entries = registry["codes"].as_array().expect("codes");
	let mut seen = BTreeSet::new();
	for entry in entries {
		let kind = entry["kind"].as_str().expect("kind");
		assert!(seen.insert(kind), "{kind} is listed twice");
		let code = entry["code"].as_i64().expect("code");
		let retryable = entry["retryable"].as_bool().expect("retryable");
		// `ErrorKind` reads `code` and `retryable` from the generated table, so this compares the
		// generated constants with the contract file they were generated from.
		let spec = ErrorKind::ALL
			.iter()
			.copied()
			.find(|candidate| candidate.as_str() == kind)
			.unwrap_or_else(|| panic!("{kind} from {ERROR_CODES_PATH} has no ErrorKind"));
		assert_eq!((spec.code(), spec.retryable()), (code, retryable), "{kind}");
	}
	assert_eq!(seen.len(), contract::ERROR_KIND_COUNT);
	assert_eq!(seen.len(), ErrorKind::ALL.len());
}
