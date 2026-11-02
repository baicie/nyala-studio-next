/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! What the request loop receives: bytes from the client, the end of its input, and reports from
//! the session workers (`query.rs`).
//!
//! One channel carries all three, so the loop has a single total order to follow and needs no
//! polling: a `query.stateChanged` notification is written as soon as the worker reports the
//! state, even while the client sends nothing. `server::serve` reads stdin on a thread of its own
//! because a blocked `read` would otherwise hold every notification back until the next request.

use std::io;
use std::sync::mpsc;

use serde_json::Value;

use crate::error::RpcError;
use crate::worker::Outcome;

/// One item on the request loop's queue.
#[derive(Debug)]
pub(crate) enum Input {
	/// Bytes read from the client. The loop decodes them, so the frame limit in force after
	/// `runtime.hello` applies even to bytes that arrived before it was negotiated.
	Bytes(Vec<u8>),
	/// The client's input ended.
	Ended(EndOfInput),
	/// A session worker reported something.
	Event(Event),
}

/// How the client's input ended.
#[derive(Debug)]
pub(crate) enum EndOfInput {
	/// The stream ended at a byte boundary.
	Input,
	/// Reading the stream failed.
	Read(io::Error),
}

/// What a session worker reports to the request loop. Every event names its session, so one
/// channel carries the events of every worker.
#[derive(Debug)]
pub(crate) enum Event {
	/// The first statement of an execution was prepared, or preparing it failed. This is what
	/// completes a deferred `query.execute` reply.
	Prepared {
		session: String,
		execution: String,
		error: Option<RpcError>,
	},
	/// The execution started running its statements.
	Started { session: String, execution: String },
	/// The execution reached its terminal state.
	Finished {
		session: String,
		execution: String,
		outcome: Outcome,
	},
	/// A `metadata.*` call finished on the worker. The answer carries the id of the request it
	/// completes, so the loop can reply while a query keeps running on the same session.
	Metadata {
		session: String,
		request: String,
		result: Result<Value, RpcError>,
	},
	/// The worker panicked. Whether a running statement committed cannot be proven, so the
	/// registry reports `unknown` (`nyala/rpc/README.md` section 5).
	WorkerGone { session: String },
}

impl Event {
	pub(crate) fn session(&self) -> &str {
		match self {
			Event::Prepared { session, .. }
			| Event::Started { session, .. }
			| Event::Finished { session, .. }
			| Event::Metadata { session, .. }
			| Event::WorkerGone { session } => session,
		}
	}
}

/// The sending end, shared by the input reader and every session worker.
pub(crate) type Sender = mpsc::Sender<Input>;

/// Reports an event to the request loop. The loop may be gone; that is not an error for the
/// worker, which is shutting down in that case anyway.
pub(crate) fn report(sender: &Sender, event: Event) {
	let _ = sender.send(Input::Event(event));
}
