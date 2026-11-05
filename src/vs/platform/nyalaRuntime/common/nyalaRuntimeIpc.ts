/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The typed bridge between the Workbench renderer and the Electron Main process that owns the
// `nyala-runtime` sidecar (`docs/adr/0004-runtime-supervisor.md` section 9, ADR 0006 for the P2
// bridge). The renderer never spawns a process and never names an RPC method directly: it calls
// one of the commands below, each of which maps to exactly one whitelisted v1 method.

import { INyalaRuntimeErrorObject } from './nyalaRuntimeProtocol.js';

/** Name of the IPC channel both sides register. */
export const NYALA_RUNTIME_CHANNEL = 'nyalaRuntime';

/** Commands the renderer may invoke. Anything else is refused by the channel. */
export const enum NyalaRuntimeCommand {
	/** Current runtime state of the calling window: generation and readiness. */
	GetRuntimeState = 'getRuntimeState',
	TestConnection = 'connection.test',
	OpenConnection = 'connection.open',
	CloseConnection = 'connection.close',
	ListObjects = 'metadata.listObjects',
	DescribeObject = 'metadata.describe',
	/** Starts one execution against an already opened session (`query.execute`). */
	QueryExecute = 'query.execute',
	/** Asks a running execution to stop; the reply is a request outcome, not the final state. */
	QueryCancel = 'query.cancel',
	/** Reads the authoritative state of one execution, used to calibrate a sequence gap. */
	QueryGetState = 'query.getState',
	/** Reads one page of a result handle. */
	ResultFetchPage = 'result.fetchPage',
	/** Releases a result handle. Idempotent at the runtime; the service sends it at most once. */
	ResultRelease = 'result.release',
}

/**
 * `supportedFeatures` the supervisor negotiates in `runtime.hello`. It is every v1 feature the
 * bridge can reach, because the handshake happens once per process and a later call cannot add
 * one. A feature the renderer never uses is still requested here so that the *only* gate is the
 * command whitelist, not an accidental negotiation gap.
 */
export const NYALA_RUNTIME_FEATURES: readonly string[] = [
	'sqlite',
	'metadata.listObjects',
	'query.execute',
	'query.cancel',
	'result.fetchPage',
	'result.release',
];

/** Events the renderer may listen to. */
export const enum NyalaRuntimeEvent {
	/** The window's runtime generation changed; every session of the old generation is void. */
	RuntimeStateChanged = 'runtimeStateChanged',
	/**
	 * `query.stateChanged`, relayed with the generation of the process that sent it. A listener
	 * must drop an event whose generation is not the one it knows: the same execution id never
	 * exists in two generations, and a stale event must not move a newer run.
	 */
	QueryStateChanged = 'queryStateChanged',
}

/** One `query.stateChanged` notification as the renderer receives it. */
export interface INyalaQueryStateChangedEvent {
	/** The generation of the runtime process that emitted the notification. */
	readonly runtimeGeneration: number;
	readonly executionId: string;
	readonly sequence: number;
	readonly state: 'queued' | 'running' | 'streaming' | 'completed' | 'failed' | 'cancel_requested' | 'cancelled' | 'unknown';
	readonly resultIds?: readonly string[];
	readonly elapsedMs?: number;
	readonly error?: { readonly code: number; readonly message: string; readonly data: { readonly kind: string; readonly retryable: boolean; readonly safeDetail?: string; readonly executionRollback?: 'rolled_back' | 'unknown' } };
}

/**
 * What the renderer learns about the runtime behind it. `generation` is 0 before the first
 * process exists; a session opened against one generation is void in the next, because the new
 * process never heard of it.
 */
export interface INyalaRuntimeState {
	readonly generation: number;
	readonly status: 'idle' | 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped';
	/** Present when `status` is `failed`; already sanitized by the supervisor. */
	readonly reason?: string;
}

/** The result of a call, discriminated so that a structured runtime error survives the IPC. */
export type INyalaRuntimeCallResult<T = unknown> =
	| { readonly ok: true; readonly runtimeGeneration: number; readonly result: T }
	| {
		readonly ok: false;
		readonly runtimeGeneration: number;
		readonly error: INyalaRuntimeErrorObject;
		/**
		 * Whether the request was handed to the supervisor. `false` means it provably never left
		 * the Main process (a rejected parameter or no runtime at all), so the caller may say the
		 * operation did not happen. Absent on old replies; treat as `true` when unsure.
		 */
		readonly sent?: boolean;
		/**
		 * Whether the runtime itself answered with a structured error. `false` means there is no
		 * usable answer (the process went away, or its reply had the wrong shape); for a request
		 * that was sent, the outcome is then unknown, not failed.
		 */
		readonly answered?: boolean;
	};

