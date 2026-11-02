/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Result cells (`nyala/rpc/README.md` §6, `$defs/cell` in `nyala/rpc/v1/`).
//!
//! SQLite stores values with one of five storage classes; the cell type is chosen from the storage
//! class of the value, not from the declared column type, because a SQLite column holds values of
//! any class. `int64` and `decimal` carry text so that no precision is lost on the way to a
//! JavaScript client (`09-drivers-metadata.md`: "不得自动丢失 64-bit 整数和十进制精度").
//!
//! A blob can be larger than one frame; `bytes` cells are capped by [`MAX_BLOB_BYTES`] and a
//! larger value fails with `RESOURCE_LIMIT` instead of being truncated silently.

use rusqlite::types::ValueRef;
use serde_json::{json, Value};

use crate::error::{ErrorKind, RpcError};

/// Largest blob that becomes a `bytes` cell. Protocol v1 caps only the frame; a blob above this
/// size would push a page past `frameMaxBytes` once several rows are collected.
pub const MAX_BLOB_BYTES: usize = 1024 * 1024;

/// Base64 of `bytes` (RFC 4648 §4, with padding). Hand-written because the crate has no base64
/// dependency for this one call site (ADR 0002 §2 keeps the dependency list short).
pub fn base64(bytes: &[u8]) -> String {
	const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
	for chunk in bytes.chunks(3) {
		let b0 = u32::from(chunk[0]);
		let b1 = chunk.get(1).map_or(0, |byte| u32::from(*byte));
		let b2 = chunk.get(2).map_or(0, |byte| u32::from(*byte));
		let triple = (b0 << 16) | (b1 << 8) | b2;
		encoded.push(char::from(ALPHABET[(triple >> 18) as usize & 0x3f]));
		encoded.push(char::from(ALPHABET[(triple >> 12) as usize & 0x3f]));
		encoded.push(if chunk.len() > 1 {
			char::from(ALPHABET[(triple >> 6) as usize & 0x3f])
		} else {
			'='
		});
		encoded.push(if chunk.len() > 2 {
			char::from(ALPHABET[triple as usize & 0x3f])
		} else {
			'='
		});
	}
	encoded
}

/// One cell of a result row.
pub fn cell(value: ValueRef<'_>) -> Result<Value, RpcError> {
	Ok(match value {
		ValueRef::Null => json!({"type": "null"}),
		ValueRef::Integer(number) => json!({"type": "int64", "text": number.to_string()}),
		// JSON has no NaN or infinity. The contract's `float64` cell carries a JSON number, and
		// Rust's serializer writes non-finite floats as `null`, which would change the value
		// silently; the v1 schema has no cell type for them either.
		ValueRef::Real(number) if !number.is_finite() => {
			return Err(RpcError::with_detail(
				ErrorKind::ResourceLimit,
				"float64 cells cannot hold NaN or infinity in protocol v1",
			))
		}
		ValueRef::Real(number) => json!({"type": "float64", "value": number}),
		ValueRef::Text(text) => match std::str::from_utf8(text) {
			Ok(text) => json!({"type": "string", "value": text}),
			// SQLite does not enforce UTF-8 in TEXT values, and a replacement character would change
			// the data. A bytes cell keeps the exact bytes visible.
			Err(_) => bytes_cell(text)?,
		},
		ValueRef::Blob(blob) => bytes_cell(blob)?,
	})
}

fn bytes_cell(bytes: &[u8]) -> Result<Value, RpcError> {
	if bytes.len() > MAX_BLOB_BYTES {
		return Err(RpcError::with_detail(
			ErrorKind::ResourceLimit,
			format!("a bytes cell is limited to {MAX_BLOB_BYTES} bytes"),
		));
	}
	// An empty blob stays a blob. Its base64 is the empty string, which the contract accepts since
	// the 2026-11-03 erratum (`nyala/rpc/README.md` §6); encoding it as `null` would make `X''`
	// indistinguishable from SQL NULL, and a `string` cell would claim the value is text.
	Ok(json!({"type": "bytes", "encoding": "base64", "data": base64(bytes)}))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn base64_matches_rfc_4648_vectors() {
		for (plain, encoded) in [
			("", ""),
			("f", "Zg=="),
			("fo", "Zm8="),
			("foo", "Zm9v"),
			("foob", "Zm9vYg=="),
			("fooba", "Zm9vYmE="),
			("foobar", "Zm9vYmFy"),
		] {
			assert_eq!(base64(plain.as_bytes()), encoded, "{plain:?}");
		}
		// Every byte value, so that no index is misplaced.
		let all: Vec<u8> = (0..=255).collect();
		assert_eq!(base64(&all), "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/w==");
	}

	#[test]
	fn cells_follow_the_storage_class() {
		assert_eq!(cell(ValueRef::Null).unwrap(), json!({"type": "null"}));
		assert_eq!(
			cell(ValueRef::Integer(i64::MIN)).unwrap(),
			json!({"type": "int64", "text": "-9223372036854775808"})
		);
		assert_eq!(
			cell(ValueRef::Real(1.5)).unwrap(),
			json!({"type": "float64", "value": 1.5})
		);
		assert_eq!(
			cell(ValueRef::Text(b"Ada")).unwrap(),
			json!({"type": "string", "value": "Ada"})
		);
		assert_eq!(
			cell(ValueRef::Blob(&[0x66, 0x6f, 0x6f])).unwrap(),
			json!({"type": "bytes", "encoding": "base64", "data": "Zm9v"})
		);
		// Text that is not UTF-8 keeps its bytes instead of gaining replacement characters.
		assert_eq!(
			cell(ValueRef::Text(&[0xff, 0xfe])).unwrap(),
			json!({"type": "bytes", "encoding": "base64", "data": "//4="})
		);
	}

	#[test]
	fn non_finite_reals_and_oversize_blobs_are_refused() {
		for number in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
			let error = cell(ValueRef::Real(number)).unwrap_err();
			assert_eq!(error.kind, ErrorKind::ResourceLimit);
		}
		let too_large = vec![0; MAX_BLOB_BYTES + 1];
		assert_eq!(
			cell(ValueRef::Blob(&too_large)).unwrap_err().kind,
			ErrorKind::ResourceLimit
		);
	}

	#[test]
	fn an_empty_blob_stays_a_blob_and_differs_from_null_and_empty_text() {
		// Every zero-length value keeps its storage class: a client must be able to tell `NULL`,
		// `''` and `X''` apart (`README.md` §6, erratum 2026-11-03).
		assert_eq!(
			cell(ValueRef::Null).unwrap(),
			json!({"type": "null"}),
			"SQL NULL"
		);
		assert_eq!(
			cell(ValueRef::Text(&[])).unwrap(),
			json!({"type": "string", "value": ""}),
			"an empty string stays a string"
		);
		assert_eq!(
			cell(ValueRef::Blob(&[])).unwrap(),
			json!({"type": "bytes", "encoding": "base64", "data": ""}),
			"an empty blob stays a blob"
		);
		// A one-byte blob is the smallest non-empty blob, so the two are distinguishable.
		assert_eq!(
			cell(ValueRef::Blob(&[0])).unwrap(),
			json!({"type": "bytes", "encoding": "base64", "data": "AA=="})
		);
	}
}
