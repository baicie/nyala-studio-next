/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Nyala SQL Runtime: the sidecar process that speaks Nyala RPC v1 over stdio.
//!
//! The contract is `nyala/rpc/README.md` plus `nyala/rpc/v1/`; this crate follows it and never
//! defines fields, methods or error codes of its own. It covers framing (N-101), the
//! `runtime.hello` / `runtime.health` handshake with structured errors (N-102), SQLite sessions
//! through `connection.*` (N-104), `metadata.*` (N-105), query execution with result pages
//! (N-106) and cancellation of a running statement (N-108).
//!
//! Each session owns its SQLite connection on a worker thread ([`worker`]); the request loop keeps
//! the execution state ([`query`]) and interrupts statements through SQLite's own interrupt
//! handle. One channel ([`events`]) carries the client's bytes and the workers' reports to the
//! same loop, so `query.stateChanged` notifications are written when they happen.
//!
//! Nothing here depends on Electron or Tauri: [`server::serve`] works on any `Read`/`Write` pair
//! and `main.rs` only hands it stdin, stdout and stderr.

pub mod connection;
pub mod contract;
pub mod error;
pub mod events;
pub mod framing;
pub mod metadata;
pub mod protocol;
pub mod query;
pub mod server;
pub mod sqlite;
pub mod value;
pub mod worker;
