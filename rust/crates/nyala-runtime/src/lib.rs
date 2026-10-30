/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Nyala SQL Runtime: the sidecar process that speaks Nyala RPC v1 over stdio.
//!
//! The contract is `nyala/rpc/README.md` plus `nyala/rpc/v1/`; this crate follows it and never
//! defines fields, methods or error codes of its own. It currently covers framing (N-101) and the
//! `runtime.hello` / `runtime.health` handshake with structured errors (N-102).
//!
//! Nothing here depends on Electron or Tauri: [`server::serve`] works on any `Read`/`Write` pair
//! and `main.rs` only hands it stdin, stdout and stderr.

pub mod error;
pub mod framing;
pub mod protocol;
pub mod server;
