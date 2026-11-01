/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Client side of the Nyala RPC v1 stdio contract (`nyala/rpc/README.md`): length-prefixed
// framing and the envelope, hello, health and restart shapes the Electron Main supervisor needs.
// The contract under `nyala/rpc/v1/` is the source of truth. These declarations are checked
// against it by `test/node/nyalaRuntimeProtocol.test.ts` until N-110 generates them.

import { VSBuffer } from '../../../base/common/buffer.js';
import { isObject } from '../../../base/common/types.js';
import { ChunkStream } from '../../../base/parts/ipc/common/ipc.net.js';

//#region Framing

/** Size of the little-endian length prefix in front of every frame (README section 1). */
const FRAME_HEADER_BYTES = 4;

/** Default `frameMaxBytes` of protocol v1 (README section 1). */
export const NYALA_FRAME_MAX_BYTES = 8 * 1024 * 1024;

/** Frame limit before `runtime.hello` has completed (README section 1). */
export const NYALA_PRE_HELLO_FRAME_MAX_BYTES = 1024 * 1024;

/**
 * A frame that cannot be read. The rest of the byte stream cannot be trusted afterwards, because
 * the reader cannot skip a payload whose length it rejected.
 */
export class NyalaFrameError extends Error {

	constructor(
		readonly reason: 'zeroLength' | 'oversize',
		readonly length: number,
		readonly maxBytes: number,
	) {
		super(reason === 'zeroLength' ? 'Zero-length frame' : `Frame of ${length} bytes exceeds the limit of ${maxBytes} bytes`);
		this.name = 'NyalaFrameError';
	}
}

/**
 * Prefixes `payload` with its length. Throws {@link NyalaFrameError} for an empty payload or one
 * larger than `maxBytes`, which the peer would reject and then close the stream.
 */
export function encodeNyalaFrame(payload: VSBuffer, maxBytes: number): VSBuffer {
	if (payload.byteLength === 0) {
		throw new NyalaFrameError('zeroLength', 0, maxBytes);
	}
	if (payload.byteLength > maxBytes) {
		throw new NyalaFrameError('oversize', payload.byteLength, maxBytes);
	}
	const frame = VSBuffer.alloc(FRAME_HEADER_BYTES + payload.byteLength);
	frame.writeUInt32LE(payload.byteLength, 0);
	frame.set(payload, FRAME_HEADER_BYTES);
	return frame;
}

/**
 * Reassembles frames from arbitrarily split chunks: half frames wait for more bytes, and one chunk
 * may hold several frames. An oversize length is rejected as soon as the prefix is complete,
 * without buffering the payload.
 */
export class NyalaFrameDecoder {

	private readonly stream = new ChunkStream();

	constructor(
		/** Largest payload accepted; raised or lowered after `runtime.hello`. */
		public maxFrameBytes: number,
	) { }

	/** Bytes received but not yet returned as a frame. */
	get pendingBytes(): number {
		return this.stream.byteLength;
	}

	push(chunk: VSBuffer): void {
		if (chunk.byteLength > 0) {
			this.stream.acceptChunk(chunk);
		}
	}

	/**
	 * Returns the next complete payload, or `undefined` when more bytes are needed.
	 * Throws {@link NyalaFrameError} when the next frame is empty or too large.
	 */
	next(): VSBuffer | undefined {
		if (this.stream.byteLength < FRAME_HEADER_BYTES) {
			return undefined;
		}
		// `readUInt32LE` combines bytes with `|`, which yields a signed number above 2^31 - 1.
		const length = this.stream.peek(FRAME_HEADER_BYTES).readUInt32LE(0) >>> 0;
		if (length === 0) {
			throw new NyalaFrameError('zeroLength', 0, this.maxFrameBytes);
		}
		if (length > this.maxFrameBytes) {
			throw new NyalaFrameError('oversize', length, this.maxFrameBytes);
		}
		if (this.stream.byteLength < FRAME_HEADER_BYTES + length) {
			return undefined;
		}
		this.stream.read(FRAME_HEADER_BYTES);
		return this.stream.read(length);
	}
}

//#endregion

//#region Envelope and errors

export const NYALA_PROTOCOL_MAJOR = 1;
export const NYALA_PROTOCOL_MINOR = 0;

/** `error.data` of a failure response (README section 7). */
export interface INyalaRuntimeErrorData {
	readonly kind: string;
	readonly retryable: boolean;
	readonly safeDetail?: string;
	readonly executionId?: string;
	readonly sessionId?: string;
	readonly sqlState?: string | null;
}

export interface INyalaRuntimeErrorObject {
	readonly code: number;
	readonly message: string;
	readonly data: INyalaRuntimeErrorData;
}

/**
 * Error kinds the client raises itself. `code` and `retryable` repeat `nyala/rpc/v1/error-codes.json`;
 * a test compares them with the table.
 */
export const NyalaRuntimeClientErrors = {
	/** The runtime process exited or was stopped; every handle it issued is void. */
	runtimeLost: { kind: 'RUNTIME_LOST', code: -32012, retryable: true },
	/** `protocolMajor` differs, or the runtime's hello reply is not a v1 reply. */
	protocolMismatch: { kind: 'PROTOCOL_MISMATCH', code: -32011, retryable: false },
	/** A request does not fit into the negotiated frame limit; it is not truncated. */
	resourceLimit: { kind: 'RESOURCE_LIMIT', code: -32014, retryable: false },
} as const;

/**
 * A structured RPC failure, either replied by the runtime or raised by the client for a lost
 * process. Callers branch on `data.kind`, never on `message` (README section 7).
 */
export class NyalaRuntimeError extends Error {

	static fromKind(error: typeof NyalaRuntimeClientErrors[keyof typeof NyalaRuntimeClientErrors], message: string, safeDetail?: string): NyalaRuntimeError {
		return new NyalaRuntimeError({ code: error.code, message, data: { kind: error.kind, retryable: error.retryable, safeDetail } });
	}

	readonly code: number;
	readonly data: INyalaRuntimeErrorData;

	constructor(error: INyalaRuntimeErrorObject) {
		super(error.message);
		this.name = 'NyalaRuntimeError';
		this.code = error.code;
		this.data = error.data;
	}

	get kind(): string {
		return this.data.kind;
	}
}

export type NyalaRuntimeMessage =
	| { readonly type: 'success'; readonly id: string; readonly result: object }
	| { readonly type: 'failure'; readonly id: string | null; readonly error: INyalaRuntimeErrorObject }
	| { readonly type: 'notification'; readonly method: string; readonly params: object };

interface IRawEnvelope {
	readonly jsonrpc?: unknown;
	readonly id?: unknown;
	readonly method?: unknown;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: unknown;
}

interface IRawError {
	readonly code?: unknown;
	readonly message?: unknown;
	readonly data?: { readonly kind?: unknown; readonly retryable?: unknown; readonly safeDetail?: unknown };
}

const ID_PATTERN = /^[a-z]{1,4}_[A-Za-z0-9]{1,64}$/;

/** Whether `value` is a request id as `$defs/id` of the v1 schema defines it. */
export function isNyalaRequestId(value: unknown): value is string {
	return typeof value === 'string' && ID_PATTERN.test(value);
}

function isErrorObject(value: unknown): value is INyalaRuntimeErrorObject {
	if (!isObject(value)) {
		return false;
	}
	const error = value as IRawError;
	return Number.isInteger(error.code)
		&& typeof error.message === 'string'
		&& isObject(error.data)
		&& typeof error.data.kind === 'string'
		&& typeof error.data.retryable === 'boolean'
		&& (error.data.safeDetail === undefined || typeof error.data.safeDetail === 'string');
}

/**
 * Parses one frame payload sent by the runtime. Returns `undefined` when the payload is not a v1
 * response or notification; the caller treats that as a broken stream.
 */
export function parseNyalaRuntimeMessage(payload: VSBuffer): NyalaRuntimeMessage | undefined {
	let value: unknown;
	try {
		value = JSON.parse(payload.toString());
	} catch {
		return undefined;
	}
	if (!isObject(value)) {
		return undefined;
	}
	const envelope = value as IRawEnvelope;
	if (envelope.jsonrpc !== '2.0') {
		return undefined;
	}
	if (envelope.id === undefined) {
		if (typeof envelope.method === 'string' && isObject(envelope.params) && envelope.result === undefined && envelope.error === undefined) {
			return { type: 'notification', method: envelope.method, params: envelope.params };
		}
		return undefined;
	}
	if (envelope.method !== undefined) {
		return undefined; // the runtime sends no requests in v1
	}
	if (isNyalaRequestId(envelope.id) && isObject(envelope.result) && envelope.error === undefined) {
		return { type: 'success', id: envelope.id, result: envelope.result };
	}
	if ((envelope.id === null || isNyalaRequestId(envelope.id)) && isErrorObject(envelope.error) && envelope.result === undefined) {
		return { type: 'failure', id: envelope.id, error: envelope.error };
	}
	return undefined;
}

//#endregion

//#region runtime.hello, runtime.health, runtime.restarted

export interface INyalaRuntimeHelloParams {
	readonly protocolMajor: number;
	readonly protocolMinor: number;
	readonly clientBuild: string;
	readonly supportedFeatures: readonly string[];
}

export interface INyalaRuntimeLimits {
	readonly frameMaxBytes: number;
	readonly maxInitialRows: number;
	readonly maxPageRows: number;
	readonly maxResultTtlSecs: number;
	readonly maxConcurrentExecutions: number;
}

export interface INyalaRuntimeHelloResult {
	readonly protocolMajor: number;
	readonly protocolMinor: number;
	readonly runtimeBuild: string;
	readonly features: readonly string[];
	readonly limits: INyalaRuntimeLimits;
}

export interface INyalaRuntimeHealthResult {
	readonly status: 'ok' | 'degraded';
	readonly uptimeMs: number;
	readonly activeSessions: number;
	readonly activeExecutions: number;
	readonly pendingResults: number;
}

/**
 * Params of the `runtime.restarted` notification. After it, every session, execution and result
 * handle of the previous process is void, and no write is replayed automatically (README section 4).
 */
export interface INyalaRuntimeRestartedParams {
	readonly reason: string;
	readonly pendingExecutions: 'unknown' | 'none';
	readonly previousBuild?: string;
}

function isCount(value: unknown, minimum = 0): value is number {
	return Number.isInteger(value) && (value as number) >= minimum;
}

function isFeatureList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0) && new Set(value).size === value.length;
}

/** Checks a `runtime.hello` result against `method.runtime.hello.result` of the v1 schema. */
export function isNyalaRuntimeHelloResult(value: object): value is INyalaRuntimeHelloResult {
	const result = value as Partial<Record<keyof INyalaRuntimeHelloResult, unknown>>;
	if (!isCount(result.protocolMajor, 1) || !isCount(result.protocolMinor) || typeof result.runtimeBuild !== 'string' || result.runtimeBuild.length === 0 || !isFeatureList(result.features) || !isObject(result.limits)) {
		return false;
	}
	const limits = result.limits as Partial<Record<keyof INyalaRuntimeLimits, unknown>>;
	return isCount(limits.frameMaxBytes, 1024) && limits.frameMaxBytes <= NYALA_FRAME_MAX_BYTES
		&& isCount(limits.maxInitialRows, 1)
		&& isCount(limits.maxPageRows, 1)
		&& isCount(limits.maxResultTtlSecs, 1)
		&& isCount(limits.maxConcurrentExecutions, 1);
}

/** Checks a `runtime.health` result against `method.runtime.health.result` of the v1 schema. */
export function isNyalaRuntimeHealthResult(value: object): value is INyalaRuntimeHealthResult {
	const result = value as Partial<Record<keyof INyalaRuntimeHealthResult, unknown>>;
	return (result.status === 'ok' || result.status === 'degraded')
		&& isCount(result.uptimeMs)
		&& isCount(result.activeSessions)
		&& isCount(result.activeExecutions)
		&& isCount(result.pendingResults);
}

/** Checks `runtime.restarted` params against `method.runtime.restarted.params` of the v1 schema. */
export function isNyalaRuntimeRestartedParams(value: object): value is INyalaRuntimeRestartedParams {
	const params = value as Partial<Record<keyof INyalaRuntimeRestartedParams, unknown>>;
	const known: readonly string[] = ['reason', 'pendingExecutions', 'previousBuild'];
	return Object.keys(value).every(key => known.includes(key))
		&& typeof params.reason === 'string' && params.reason.length > 0
		&& (params.pendingExecutions === 'unknown' || params.pendingExecutions === 'none')
		&& (params.previousBuild === undefined || (typeof params.previousBuild === 'string' && params.previousBuild.length > 0));
}

//#endregion
