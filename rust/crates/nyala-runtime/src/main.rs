/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! `nyala-runtime` executable: Nyala RPC v1 frames on stdin/stdout, log lines on stderr.

use std::io;
use std::process::ExitCode;

use nyala_runtime::server::serve;

fn main() -> ExitCode {
	let status = serve(io::stdin().lock(), io::stdout().lock(), io::stderr());
	ExitCode::from(status.code())
}
