/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Validation of the RPC parameters that may cross the renderer bridge (ADR 0006). The main
// process is the boundary: whatever the renderer sends is checked here against the v1 method
// schemas before it becomes a runtime request, and results the renderer receives are checked
// against the same generated contract. Nothing here reads a database or a file.

import { INyalaRuntimeErrorObject } from './nyalaRuntimeProtocol.js';

/** A request the runtime would refuse, raised before it is sent. */
export class NyalaRequestError extends Error {

	constructor(readonly safeDetail: string) {
		super(safeDetail);
		this.name = 'NyalaRequestError';
	}
}

/** A v1 id (`README.md` section 2): the generated id pattern, applied to session ids. */
const ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export interface INyalaConnectionTarget {
	readonly driver: 'sqlite';
	readonly path: string;
	readonly readOnly: boolean;
}

export interface INyalaSessionRef {
	readonly sessionId: string;
	readonly sessionGeneration: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(detail: string): never {
	throw new NyalaRequestError(detail);
}

function id(value: unknown, field: string): string {
	if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
		fail(`${field} must be a contract id`);
	}
	return value;
}

function generation(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
		fail('sessionGeneration must be a positive integer');
	}
	return value;
}

function limit(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 1000) {
		fail('limit must be an integer between 1 and 1000');
	}
	return value;
}

/**
 * `connection.test` / `connection.open` parameters. The path must be absolute: it names an
 * existing database file and never a `file:` URI, an in-memory database or a relative path
 * (`sqlite::resolve` enforces the rest before SQLite sees it).
 */
export function connectionTarget(params: unknown): INyalaConnectionTarget {
	if (!isRecord(params)) {
		fail('parameters must be an object');
	}
	if (params.driver !== 'sqlite') {
		fail('driver must be sqlite');
	}
	const path = params.path;
	if (typeof path !== 'string' || path.length === 0) {
		fail('path must be a non-empty string');
	}
	if (!isAbsolutePath(path)) {
		fail('path must be absolute');
	}
	if (typeof params.readOnly !== 'boolean') {
		fail('readOnly must be a boolean');
	}
	// Only the fields the v1 schema of these methods declares are forwarded; anything else the
	// renderer sent is dropped rather than reaching the runtime.
	return { driver: 'sqlite', path, readOnly: params.readOnly };
}

/** Windows drive paths and POSIX absolute paths, without a `file:` URI. */
function isAbsolutePath(path: string): boolean {
	if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) {
		return true;
	}
	return path.startsWith('/') && !path.startsWith('//');
}

/** `connection.close` parameters. */
export function sessionRef(params: unknown): INyalaSessionRef {
	if (!isRecord(params)) {
		fail('parameters must be an object');
	}
	return { sessionId: id(params.sessionId, 'sessionId'), sessionGeneration: generation(params.sessionGeneration) };
}

/** `metadata.listObjects` parameters. */
export function listObjectsParams(params: unknown): { sessionId: string; sessionGeneration: number; schema?: string; kinds?: string[]; cursor?: string | null; limit: number } {
	if (!isRecord(params)) {
		fail('parameters must be an object');
	}
	const session = sessionRef(params);
	const result: { sessionId: string; sessionGeneration: number; schema?: string; kinds?: string[]; cursor?: string | null; limit: number } = {
		...session,
		limit: limit(params.limit),
	};
	if (params.schema !== undefined) {
		if (typeof params.schema !== 'string' || params.schema.length === 0) {
			fail('schema must be a non-empty string');
		}
		result.schema = params.schema;
	}
	if (params.kinds !== undefined) {
		if (!Array.isArray(params.kinds) || params.kinds.length === 0) {
			fail('kinds must be a non-empty array');
		}
		for (const kind of params.kinds) {
			if (kind !== 'table' && kind !== 'view' && kind !== 'index') {
				fail('kinds may only name table, view or index');
			}
		}
		result.kinds = [...params.kinds];
	}
	if (params.cursor !== undefined && params.cursor !== null) {
		if (typeof params.cursor !== 'string') {
			fail('cursor must be a string or null');
		}
		result.cursor = params.cursor;
	}
	return result;
}

/** `metadata.describe` parameters. */
export function describeParams(params: unknown): { sessionId: string; sessionGeneration: number; object: { schema?: string; name: string } } {
	if (!isRecord(params)) {
		fail('parameters must be an object');
	}
	const session = sessionRef(params);
	const object = params.object;
	if (!isRecord(object) || typeof object.name !== 'string' || object.name.length === 0) {
		fail('object must name a table or view');
	}
	if (object.schema !== undefined && (typeof object.schema !== 'string' || object.schema.length === 0)) {
		fail('object.schema must be a non-empty string');
	}
	return {
		...session,
		object: object.schema === undefined ? { name: object.name } : { schema: object.schema, name: object.name },
	};
}

/** The generated error object a failed bridge call carries back, when `error` is one. */
export function asRuntimeError(error: unknown): INyalaRuntimeErrorObject | undefined {
	if (!isRecord(error) || typeof error.code !== 'number' || typeof error.message !== 'string' || !isRecord(error.data)) {
		return undefined;
	}
	const data = error.data;
	if (typeof data.kind !== 'string' || typeof data.retryable !== 'boolean') {
		return undefined;
	}
	return error as unknown as INyalaRuntimeErrorObject;
}
