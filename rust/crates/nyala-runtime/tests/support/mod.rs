/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Shared by the integration tests: the contract files under `nyala/rpc/v1/` and a JSON Schema
//! evaluator for the keywords that contract uses.
//!
//! `scripts/nyala/validate-rpc-contract.ts` evaluates the same schema on the Node side. This
//! evaluator refuses any keyword it does not implement, so a schema change cannot pass unchecked.

// Each test crate uses a different subset of these helpers.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};

use nyala_runtime::framing::{FrameDecoder, DEFAULT_FRAME_MAX_BYTES};
use regex::Regex;
use serde_json::Value;

pub const SCHEMA_PATH: &str = "nyala/rpc/v1/nyala-rpc.v1.schema.json";
pub const ERROR_CODES_PATH: &str = "nyala/rpc/v1/error-codes.json";
pub const CONFORMANCE_PATH: &str = "nyala/rpc/v1/conformance.ndjson";

/// Path of a file relative to the repository root.
pub fn repo_file(relative: &str) -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR"))
		.join("../../..")
		.join(relative)
}

fn read(relative: &str) -> String {
	let path = repo_file(relative);
	fs::read_to_string(&path)
		.unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()))
}

pub fn read_json(relative: &str) -> Value {
	serde_json::from_str(&read(relative))
		.unwrap_or_else(|error| panic!("{relative} is not JSON: {error}"))
}

/// Lines of `conformance.ndjson` without line terminators; the checkout may use CRLF.
pub fn conformance_samples() -> Vec<String> {
	read(CONFORMANCE_PATH)
		.lines()
		.filter(|line| !line.trim().is_empty())
		.map(str::to_owned)
		.collect()
}

/// Decodes a byte stream that must consist of whole frames and nothing else.
pub fn decode_frames(bytes: &[u8]) -> Vec<Value> {
	let mut decoder = FrameDecoder::new(DEFAULT_FRAME_MAX_BYTES);
	decoder.push(bytes);
	let mut messages = Vec::new();
	while let Some(payload) = decoder.next_frame().expect("output must be valid frames") {
		messages.push(serde_json::from_slice(&payload).expect("every frame must hold JSON"));
	}
	assert_eq!(
		decoder.pending_bytes(),
		0,
		"output must hold nothing but whole frames"
	);
	messages
}

const KEYWORDS: &[&str] = &[
	"$schema",
	"$id",
	"$defs",
	"$ref",
	"title",
	"description",
	"oneOf",
	"type",
	"const",
	"enum",
	"minLength",
	"pattern",
	"minimum",
	"maximum",
	"minItems",
	"maxItems",
	"uniqueItems",
	"items",
	"minProperties",
	"maxProperties",
	"required",
	"properties",
	"additionalProperties",
];

pub struct Schema {
	root: Value,
}

impl Schema {
	pub fn load() -> Self {
		let root = read_json(SCHEMA_PATH);
		assert_supported(&root, "#");
		Schema { root }
	}

	/// `$defs/<name>` of the contract schema.
	pub fn def(&self, name: &str) -> &Value {
		self.root["$defs"]
			.get(name)
			.unwrap_or_else(|| panic!("schema has no $defs/{name}"))
	}

	/// Violations of `value` against the whole envelope schema.
	pub fn envelope_errors(&self, value: &Value) -> Vec<String> {
		self.errors_at(value, &self.root, "$")
	}

	/// Violations of `value` against `$defs/<name>`.
	pub fn def_errors(&self, value: &Value, name: &str) -> Vec<String> {
		self.errors_at(value, self.def(name), "$")
	}

	fn errors_at(&self, value: &Value, schema: &Value, path: &str) -> Vec<String> {
		let mut errors = Vec::new();
		self.validate(value, schema, path, &mut errors);
		errors
	}

	fn resolve(&self, reference: &str) -> &Value {
		let pointer = reference
			.strip_prefix('#')
			.unwrap_or_else(|| panic!("only local $ref is supported: {reference}"));
		self.root
			.pointer(pointer)
			.unwrap_or_else(|| panic!("unresolvable $ref: {reference}"))
	}

	fn validate(&self, value: &Value, schema: &Value, path: &str, errors: &mut Vec<String>) {
		if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
			self.validate(value, self.resolve(reference), path, errors);
			return;
		}

		if let Some(branches) = schema.get("oneOf").and_then(Value::as_array) {
			let matched = branches
				.iter()
				.filter(|branch| self.errors_at(value, branch, path).is_empty())
				.count();
			if matched != 1 {
				errors.push(format!(
					"{path}: expected exactly one oneOf branch to match, matched {matched}"
				));
			}
		}

		if let Some(types) = schema.get("type") {
			let types: Vec<&str> = match types {
				Value::String(name) => vec![name.as_str()],
				Value::Array(names) => names
					.iter()
					.map(|name| name.as_str().expect("type names are strings"))
					.collect(),
				_ => panic!("{path}: unsupported type declaration {types}"),
			};
			if !types.iter().any(|name| matches_type(value, name)) {
				errors.push(format!(
					"{path}: expected type {}, got {}",
					types.join("|"),
					type_name(value)
				));
				return;
			}
		}

		if let Some(expected) = schema.get("const") {
			if value != expected {
				errors.push(format!("{path}: expected const {expected}, got {value}"));
			}
		}

		if let Some(Value::Array(allowed)) = schema.get("enum") {
			if !allowed.contains(value) {
				errors.push(format!("{path}: value {value} is not in enum"));
			}
		}

		match value {
			Value::String(text) => {
				if let Some(min) = schema.get("minLength").and_then(Value::as_u64) {
					if (text.chars().count() as u64) < min {
						errors.push(format!("{path}: string shorter than {min}"));
					}
				}
				if let Some(pattern) = schema.get("pattern").and_then(Value::as_str) {
					let regex = Regex::new(pattern)
						.unwrap_or_else(|error| panic!("bad pattern {pattern}: {error}"));
					if !regex.is_match(text) {
						errors.push(format!("{path}: string does not match {pattern}"));
					}
				}
			}
			Value::Number(number) => {
				let number = number.as_f64().expect("JSON numbers are finite");
				if let Some(min) = schema.get("minimum").and_then(Value::as_f64) {
					if number < min {
						errors.push(format!("{path}: number below minimum {min}"));
					}
				}
				if let Some(max) = schema.get("maximum").and_then(Value::as_f64) {
					if number > max {
						errors.push(format!("{path}: number above maximum {max}"));
					}
				}
			}
			Value::Array(items) => {
				let count = items.len() as u64;
				if let Some(min) = schema.get("minItems").and_then(Value::as_u64) {
					if count < min {
						errors.push(format!("{path}: fewer than {min} items"));
					}
				}
				if let Some(max) = schema.get("maxItems").and_then(Value::as_u64) {
					if count > max {
						errors.push(format!("{path}: more than {max} items"));
					}
				}
				if schema.get("uniqueItems") == Some(&Value::Bool(true)) {
					for (index, item) in items.iter().enumerate() {
						if items[..index].contains(item) {
							errors.push(format!("{path}: items are not unique"));
							break;
						}
					}
				}
				if let Some(item_schema) = schema.get("items") {
					for (index, item) in items.iter().enumerate() {
						self.validate(item, item_schema, &format!("{path}[{index}]"), errors);
					}
				}
			}
			Value::Object(object) => {
				let count = object.len() as u64;
				if let Some(min) = schema.get("minProperties").and_then(Value::as_u64) {
					if count < min {
						errors.push(format!("{path}: fewer than {min} properties"));
					}
				}
				if let Some(max) = schema.get("maxProperties").and_then(Value::as_u64) {
					if count > max {
						errors.push(format!("{path}: more than {max} properties"));
					}
				}
				for required in schema
					.get("required")
					.and_then(Value::as_array)
					.into_iter()
					.flatten()
				{
					let required = required.as_str().expect("required names are strings");
					if !object.contains_key(required) {
						errors.push(format!("{path}: missing required property \"{required}\""));
					}
				}
				let properties = schema.get("properties");
				for (key, child) in object {
					let child_path = format!("{path}.{key}");
					match (
						properties.and_then(|declared| declared.get(key)),
						schema.get("additionalProperties"),
					) {
						(Some(declared), _) => self.validate(child, declared, &child_path, errors),
						(None, Some(Value::Bool(false))) => {
							errors.push(format!("{path}: unexpected property \"{key}\""));
						}
						(None, Some(extra @ Value::Object(_))) => {
							self.validate(child, extra, &child_path, errors);
						}
						(None, _) => {}
					}
				}
			}
			Value::Null | Value::Bool(_) => {}
		}
	}
}

fn type_name(value: &Value) -> &'static str {
	match value {
		Value::Null => "null",
		Value::Bool(_) => "boolean",
		Value::Number(_) => "number",
		Value::String(_) => "string",
		Value::Array(_) => "array",
		Value::Object(_) => "object",
	}
}

fn matches_type(value: &Value, name: &str) -> bool {
	match name {
		"integer" => {
			value.is_i64()
				|| value.is_u64()
				|| value.as_f64().is_some_and(|number| number.fract() == 0.0)
		}
		"number" => value.is_number(),
		other => type_name(value) == other,
	}
}

/// Fails on any schema keyword the evaluator above does not implement.
fn assert_supported(schema: &Value, path: &str) {
	let Value::Object(object) = schema else {
		panic!("{path}: a schema must be an object");
	};
	for (key, child) in object {
		assert!(
			KEYWORDS.contains(&key.as_str()),
			"{path}: schema keyword {key} is not implemented by the test evaluator"
		);
		match key.as_str() {
			"$defs" | "properties" => {
				for (name, sub) in child.as_object().expect("a map of schemas") {
					assert_supported(sub, &format!("{path}/{key}/{name}"));
				}
			}
			"oneOf" => {
				for (index, branch) in child
					.as_array()
					.expect("a list of schemas")
					.iter()
					.enumerate()
				{
					assert_supported(branch, &format!("{path}/oneOf/{index}"));
				}
			}
			"items" => assert_supported(child, &format!("{path}/items")),
			"additionalProperties" if child.is_object() => {
				assert_supported(child, &format!("{path}/additionalProperties"));
			}
			_ => {}
		}
	}
}
