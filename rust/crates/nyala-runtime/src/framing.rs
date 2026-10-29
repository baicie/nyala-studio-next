/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Length-prefixed framing (`nyala/rpc/README.md` §1).
//!
//! A frame is a 4-byte little-endian unsigned payload length `N` followed by `N` bytes of UTF-8
//! JSON. The decoder is push-based: it never assumes that one `read` returns one frame.

use std::fmt;

/// Size of the length prefix in bytes.
pub const FRAME_PREFIX_BYTES: usize = 4;

/// `frameMaxBytes` default for protocol v1 (8 MiB).
pub const DEFAULT_FRAME_MAX_BYTES: u32 = 8 * 1024 * 1024;

/// Largest frame a client may send before it has received the `runtime.hello` result (1 MiB).
pub const PRE_HELLO_FRAME_MAX_BYTES: u32 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
	/// `N = 0`. Answered with `INVALID_REQUEST`.
	ZeroLength,
	/// `N > frameMaxBytes`. Answered with `RESOURCE_LIMIT`; the rest of the stream cannot be
	/// skipped safely.
	Oversize { length: u32, max: u32 },
}

impl fmt::Display for FrameError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			FrameError::ZeroLength => write!(f, "zero-length frame"),
			FrameError::Oversize { length, max } => {
				write!(f, "frame of {length} bytes exceeds frameMaxBytes {max}")
			}
		}
	}
}

impl std::error::Error for FrameError {}

/// Encodes `payload` as one frame. Empty payloads and payloads above `max` are rejected.
pub fn encode_frame(payload: &[u8], max: u32) -> Result<Vec<u8>, FrameError> {
	if payload.is_empty() {
		return Err(FrameError::ZeroLength);
	}
	let length = match u32::try_from(payload.len()) {
		Ok(length) if length <= max => length,
		_ => {
			return Err(FrameError::Oversize {
				length: u32::try_from(payload.len()).unwrap_or(u32::MAX),
				max,
			})
		}
	};
	let mut frame = Vec::with_capacity(FRAME_PREFIX_BYTES + payload.len());
	frame.extend_from_slice(&length.to_le_bytes());
	frame.extend_from_slice(payload);
	Ok(frame)
}

/// Incremental decoder that accepts arbitrarily split chunks, so it handles partial and
/// coalesced frames.
#[derive(Debug)]
pub struct FrameDecoder {
	buffer: Vec<u8>,
	/// Offset of the first byte not yet returned as part of a frame.
	start: usize,
	max_frame_bytes: u32,
}

impl FrameDecoder {
	pub fn new(max_frame_bytes: u32) -> Self {
		FrameDecoder {
			buffer: Vec::new(),
			start: 0,
			max_frame_bytes,
		}
	}

	pub fn max_frame_bytes(&self) -> u32 {
		self.max_frame_bytes
	}

	/// Changes the limit for every frame not yet returned, including frames already buffered.
	pub fn set_max_frame_bytes(&mut self, max_frame_bytes: u32) {
		self.max_frame_bytes = max_frame_bytes;
	}

	pub fn push(&mut self, chunk: &[u8]) {
		if self.start > 0 {
			self.buffer.drain(..self.start);
			self.start = 0;
		}
		self.buffer.extend_from_slice(chunk);
	}

	/// Returns the next complete payload, or `Ok(None)` when more bytes are needed.
	///
	/// The length is checked as soon as the prefix arrives, so an oversize frame is rejected
	/// without buffering its payload. After an error the stream is out of sync and the caller
	/// must stop decoding.
	pub fn next_frame(&mut self) -> Result<Option<Vec<u8>>, FrameError> {
		let pending = &self.buffer[self.start..];
		let Some(prefix) = pending.first_chunk::<FRAME_PREFIX_BYTES>() else {
			return Ok(None);
		};
		let length = u32::from_le_bytes(*prefix);
		if length == 0 {
			return Err(FrameError::ZeroLength);
		}
		if length > self.max_frame_bytes {
			return Err(FrameError::Oversize {
				length,
				max: self.max_frame_bytes,
			});
		}
		let end = FRAME_PREFIX_BYTES + length as usize;
		if pending.len() < end {
			return Ok(None);
		}
		let payload = pending[FRAME_PREFIX_BYTES..end].to_vec();
		self.start += end;
		Ok(Some(payload))
	}

	/// Bytes received but not yet returned as a frame.
	pub fn pending_bytes(&self) -> usize {
		self.buffer.len() - self.start
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn frame(payload: &str) -> Vec<u8> {
		encode_frame(payload.as_bytes(), DEFAULT_FRAME_MAX_BYTES).unwrap()
	}

	fn drain(decoder: &mut FrameDecoder) -> Vec<Vec<u8>> {
		let mut frames = Vec::new();
		while let Some(payload) = decoder.next_frame().unwrap() {
			frames.push(payload);
		}
		frames
	}

	#[test]
	fn encodes_little_endian_prefix() {
		assert_eq!(frame("{}"), vec![2, 0, 0, 0, b'{', b'}']);
		let long = "x".repeat(0x0102);
		assert_eq!(&frame(&long)[..FRAME_PREFIX_BYTES], &[0x02, 0x01, 0, 0]);
	}

	#[test]
	fn encode_rejects_empty_and_oversize_payloads() {
		assert_eq!(encode_frame(b"", 16), Err(FrameError::ZeroLength));
		assert_eq!(
			encode_frame(&[b'x'; 17], 16),
			Err(FrameError::Oversize {
				length: 17,
				max: 16
			})
		);
		assert!(encode_frame(&[b'x'; 16], 16).is_ok());
	}

	#[test]
	fn half_frame_waits_for_the_rest() {
		let bytes = frame(r#"{"a":1}"#);
		let mut decoder = FrameDecoder::new(DEFAULT_FRAME_MAX_BYTES);

		decoder.push(&bytes[..2]);
		assert_eq!(decoder.next_frame(), Ok(None), "partial prefix");
		decoder.push(&bytes[2..bytes.len() - 1]);
		assert_eq!(decoder.next_frame(), Ok(None), "partial payload");
		assert_eq!(decoder.pending_bytes(), bytes.len() - 1);

		decoder.push(&bytes[bytes.len() - 1..]);
		assert_eq!(decoder.next_frame(), Ok(Some(br#"{"a":1}"#.to_vec())));
		assert_eq!(decoder.pending_bytes(), 0);
	}

	#[test]
	fn glued_frames_are_split() {
		let mut bytes = frame(r#"{"a":1}"#);
		bytes.extend(frame(r#"{"b":2}"#));
		bytes.extend(&frame(r#"{"c":3}"#)[..3]);

		let mut decoder = FrameDecoder::new(DEFAULT_FRAME_MAX_BYTES);
		decoder.push(&bytes);
		assert_eq!(
			drain(&mut decoder),
			vec![br#"{"a":1}"#.to_vec(), br#"{"b":2}"#.to_vec()]
		);
		assert_eq!(
			decoder.pending_bytes(),
			3,
			"trailing partial prefix is kept"
		);
	}

	#[test]
	fn byte_by_byte_feed_recovers_every_frame() {
		let payloads = [r#"{"a":1}"#, r#"{"b":"two"}"#, r#"{"c":[3]}"#];
		let bytes: Vec<u8> = payloads.iter().flat_map(|p| frame(p)).collect();

		let mut decoder = FrameDecoder::new(DEFAULT_FRAME_MAX_BYTES);
		let mut frames = Vec::new();
		for byte in bytes {
			decoder.push(&[byte]);
			frames.extend(drain(&mut decoder));
		}
		let expected: Vec<Vec<u8>> = payloads.iter().map(|p| p.as_bytes().to_vec()).collect();
		assert_eq!(frames, expected);
		assert_eq!(decoder.pending_bytes(), 0);
	}

	#[test]
	fn zero_length_frame_is_an_error() {
		let mut decoder = FrameDecoder::new(DEFAULT_FRAME_MAX_BYTES);
		decoder.push(&[0, 0, 0, 0]);
		assert_eq!(decoder.next_frame(), Err(FrameError::ZeroLength));
	}

	#[test]
	fn oversize_frame_is_rejected_from_the_prefix_alone() {
		let mut decoder = FrameDecoder::new(16);
		decoder.push(&17u32.to_le_bytes());
		assert_eq!(
			decoder.next_frame(),
			Err(FrameError::Oversize {
				length: 17,
				max: 16
			})
		);

		let mut decoder = FrameDecoder::new(DEFAULT_FRAME_MAX_BYTES);
		decoder.push(&u32::MAX.to_le_bytes());
		assert!(matches!(
			decoder.next_frame(),
			Err(FrameError::Oversize { .. })
		));
	}

	#[test]
	fn frame_at_exactly_the_limit_is_accepted() {
		let mut decoder = FrameDecoder::new(16);
		decoder.push(&encode_frame(&[b' '; 16], 16).unwrap());
		assert_eq!(decoder.next_frame(), Ok(Some(vec![b' '; 16])));
	}

	#[test]
	fn limit_change_applies_to_buffered_frames() {
		let mut decoder = FrameDecoder::new(4);
		let mut bytes = frame("{}");
		bytes.extend(frame(r#"{"long":true}"#));
		decoder.push(&bytes);

		assert_eq!(decoder.next_frame(), Ok(Some(b"{}".to_vec())));
		assert!(matches!(
			decoder.next_frame(),
			Err(FrameError::Oversize { length: 13, max: 4 })
		));
		decoder.set_max_frame_bytes(DEFAULT_FRAME_MAX_BYTES);
		assert_eq!(decoder.next_frame(), Ok(Some(br#"{"long":true}"#.to_vec())));
	}
}
