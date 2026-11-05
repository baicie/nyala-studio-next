/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The main-process half of the renderer bridge (ADR 0006). It answers only the commands in
// `NYALA_RUNTIME_COMMANDS`, validates their parameters against the v1 method schemas, and forwards
// them to the runtime process of the window that asked. The IPC server hands the channel the
// renderer's own context (`window:<id>`), so a renderer can never address another window's
// runtime (ADR 0004 section 3).
//
// Results are returned as values, not thrown: a structured runtime error (`kind`, `code`,
// `retryable`) has to survive the IPC boundary intact, because the UI branches on the kind.

import { Event } from '../../../base/common/event.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { ILogger } from '../../log/common/log.js';
import { INyalaQueryStateChangedEvent, INyalaRuntimeCallResult, INyalaRuntimeState, NyalaRuntimeCommand, NyalaRuntimeEvent } from '../common/nyalaRuntimeIpc.js';
import { INyalaRuntimeErrorObject, NyalaRuntimeError } from '../common/nyalaRuntimeProtocol.js';
import { asRuntimeError, cancelParams, connectionTarget, describeParams, executeParams, executionRef, fetchPageParams, listObjectsParams, NyalaRequestError, resultRef, sessionRef } from '../common/nyalaRuntimeRequest.js';
import { NyalaRuntimeSupervisor } from '../node/nyalaRuntimeSupervisor.js';

/** What the channel needs from the handler that owns the supervisors. */
export interface INyalaRuntimeSupervisors {
	/** The supervisor of the window whose renderer sent the request, once it exists. */
	get(windowId: number): NyalaRuntimeSupervisor | undefined;
}

/** Reads the window id out of the IPC client context (`window:<id>`). */
export function windowIdFromContext(context: unknown): number | undefined {
	if (typeof context !== 'string') {
		return undefined;
	}
	const match = /^window:(\d+)$/.exec(context);
	return match ? Number(match[1]) : undefined;
}

/** The runtime state of one window, as the renderer sees it. */
export function runtimeStateOf(supervisor: NyalaRuntimeSupervisor | undefined): INyalaRuntimeState {
	if (!supervisor) {
		return { generation: 0, status: 'idle' };
	}
	const state = supervisor.state;
	switch (state.type) {
		case 'ready':
			return { generation: state.generation, status: 'ready' };
		case 'starting':
			return { generation: state.generation, status: 'starting' };
		case 'restarting':
			return { generation: supervisor.generation, status: 'restarting', reason: state.reason };
		case 'failed':
			return { generation: supervisor.generation, status: 'failed', reason: state.reason };
		case 'stopped':
			return { generation: supervisor.generation, status: 'stopped' };
		default:
			return { generation: supervisor.generation, status: 'idle' };
	}
}

/** Turns whatever the runtime rejected with into the wire shape. */
function toWireError(error: unknown): INyalaRuntimeErrorObject {
	const runtimeError = asRuntimeError(error);
	if (runtimeError) {
		return runtimeError;
	}
	if (error instanceof NyalaRuntimeError) {
		return { code: error.code, message: error.message, data: { ...error.data } };
	}
	const detail = error instanceof Error ? error.message : String(error);
	return {
		code: -32603,
		message: 'The Nyala runtime could not be reached',
		data: { kind: 'INTERNAL', retryable: false, safeDetail: detail },
	};
}

/**
 * One channel for every window. All state an instance keeps is per window, and the window is
 * taken from the IPC context of each call, never from the request body.
 */
export class NyalaRuntimeChannel implements IServerChannel<string> {

	constructor(
		private readonly supervisors: INyalaRuntimeSupervisors,
		private readonly logService: ILogger,
	) { }

	/** The handler passes the logger it created for the runtime. */
	static withLogger(supervisors: INyalaRuntimeSupervisors, logger: ILogger): NyalaRuntimeChannel {
		return new NyalaRuntimeChannel(supervisors, logger);
	}

	async call<T>(context: string, command: string, params?: object, _cancellationToken?: CancellationToken): Promise<T> {
		const windowId = windowIdFromContext(context);
		if (windowId === undefined) {
			throw new Error(`Nyala runtime channel: unknown client context ${String(context)}`);
		}
		if (command === NyalaRuntimeCommand.GetRuntimeState) {
			return { ok: true, runtimeGeneration: this.supervisors.get(windowId)?.generation ?? 0, result: runtimeStateOf(this.supervisors.get(windowId)) } as T;
		}
		const method = NYALA_RUNTIME_METHODS.get(command as NyalaRuntimeCommand);
		if (!method) {
			// Not a whitelisted command: refuse it instead of forwarding an arbitrary method.
			throw new Error(`Nyala runtime channel: command ${command} is not allowed`);
		}
		const supervisor = this.supervisors.get(windowId);
		const generation = supervisor?.generation ?? 0;
		let validated: object;
		try {
			validated = validate(command as NyalaRuntimeCommand, params);
		} catch (error) {
			// Rejected here: the request provably never left the Main process.
			const result: INyalaRuntimeCallResult = { ok: false, runtimeGeneration: generation, error: toWireError(error), sent: false, answered: false };
			return result as T;
		}
		if (!supervisor) {
			const result: INyalaRuntimeCallResult = {
				ok: false,
				runtimeGeneration: 0,
				error: { code: -32012, message: 'The Nyala runtime is not available', data: { kind: 'RUNTIME_LOST', retryable: true, safeDetail: 'no runtime has been started for this window' } },
				sent: false,
				answered: false,
			};
			return result as T;
		}
		try {
			const result = await supervisor.request(method, validated);
			// A malformed answer is a failed *call*, not a statement about the SQL: the runtime may
			// have run it. The caller turns this into `unknown`, never into "it did not run".
			const shapeError = checkResultShape(command as NyalaRuntimeCommand, result, validated);
			if (shapeError) {
				this.logService.trace(`Nyala runtime: ${command} answered with an unexpected shape for window ${windowId}`);
				// The runtime answered, but the answer is unusable: the request definitely left the
				// bridge, so the caller must not conclude that nothing ran.
				const malformed: INyalaRuntimeCallResult = {
					ok: false,
					runtimeGeneration: generation,
					error: { code: -32603, message: 'The Nyala runtime answered with an unexpected shape', data: { kind: 'INTERNAL', retryable: false, safeDetail: shapeError } },
					sent: true,
					answered: false,
				};
				return malformed as T;
			}
			return { ok: true, runtimeGeneration: generation, result } as T;
		} catch (error) {
			this.logService.trace(`Nyala runtime: ${command} failed for window ${windowId}`);
			// A transport failure (RUNTIME_LOST/PROTOCOL_MISMATCH) means there is no usable answer;
			// a structured domain error is the runtime's own reply, so nothing ran for a request
			// that failed before its statement was prepared.
			const wire = toWireError(error);
			const answered = wire.data.kind !== 'RUNTIME_LOST' && wire.data.kind !== 'PROTOCOL_MISMATCH' && wire.data.kind !== 'PARSE_ERROR';
			return { ok: false, runtimeGeneration: generation, error: wire, sent: true, answered } as T;
		}
	}

	listen<T>(context: string, event: string): Event<T> {
		const windowId = windowIdFromContext(context);
		const supervisor = windowId === undefined ? undefined : this.supervisors.get(windowId);
		if (!supervisor) {
			// An event nobody will fire; the renderer polls through `getRuntimeState` if the
			// generation was not announced (for example before this window had a supervisor).
			return Event.None as Event<T>;
		}
		if (event === NyalaRuntimeEvent.QueryStateChanged) {
			return this.queryStateEvents(supervisor) as Event<T>;
		}
		if (event !== NyalaRuntimeEvent.RuntimeStateChanged) {
			return Event.None as Event<T>;
		}
		return Event.map(supervisor.onDidChangeState, () => runtimeStateOf(supervisor)) as Event<T>;
	}

	/**
	 * Relays `query.stateChanged` with the generation of the live process at the moment it arrived.
	 * A listener that already moved to a newer generation drops it: an execution id of a dead
	 * process must never be applied to the run that replaced it.
	 */
	private queryStateEvents(supervisor: NyalaRuntimeSupervisor): Event<INyalaQueryStateChangedEvent> {
		return Event.filter(Event.map(supervisor.onDidNotify, notification => queryStateEvent(notification, supervisor.generation)), event => event !== undefined) as Event<INyalaQueryStateChangedEvent>;
	}
}

/** The v1 method behind every allowed command. */
export const NYALA_RUNTIME_METHODS: ReadonlyMap<string, string> = new Map([
	[NyalaRuntimeCommand.TestConnection, 'connection.test'],
	[NyalaRuntimeCommand.OpenConnection, 'connection.open'],
	[NyalaRuntimeCommand.CloseConnection, 'connection.close'],
	[NyalaRuntimeCommand.ListObjects, 'metadata.listObjects'],
	[NyalaRuntimeCommand.DescribeObject, 'metadata.describe'],
	[NyalaRuntimeCommand.QueryExecute, 'query.execute'],
	[NyalaRuntimeCommand.QueryCancel, 'query.cancel'],
	[NyalaRuntimeCommand.QueryGetState, 'query.getState'],
	[NyalaRuntimeCommand.ResultFetchPage, 'result.fetchPage'],
	[NyalaRuntimeCommand.ResultRelease, 'result.release'],
]);

function validate(command: NyalaRuntimeCommand, params: unknown): object {
	try {
		switch (command) {
			case NyalaRuntimeCommand.TestConnection:
			case NyalaRuntimeCommand.OpenConnection:
				return connectionTarget(params);
			case NyalaRuntimeCommand.CloseConnection:
				return sessionRef(params);
			case NyalaRuntimeCommand.ListObjects:
				return listObjectsParams(params);
			case NyalaRuntimeCommand.DescribeObject:
				return describeParams(params);
			case NyalaRuntimeCommand.QueryExecute:
				return executeParams(params);
			case NyalaRuntimeCommand.QueryCancel:
				return cancelParams(params);
			case NyalaRuntimeCommand.QueryGetState:
				return executionRef(params);
			case NyalaRuntimeCommand.ResultFetchPage:
				return fetchPageParams(params);
			case NyalaRuntimeCommand.ResultRelease:
				return resultRef(params);
			default:
				throw new NyalaRequestError(`command ${command} is not allowed`);
		}
	} catch (error) {
		if (error instanceof NyalaRequestError) {
			throw new NyalaRuntimeError({
				code: -32602,
				message: 'Invalid Nyala request',
				data: { kind: 'INVALID_PARAMS', retryable: false, safeDetail: error.safeDetail },
			});
		}
		throw error;
	}
}

/**
 * Turns one notification into the renderer event, or `undefined` for anything else. The shape is
 * checked here so a malformed notification never reaches the execution service, where it could be
 * mistaken for a real state transition.
 */
export function queryStateEvent(notification: { readonly method: string; readonly params: object }, runtimeGeneration: number): INyalaQueryStateChangedEvent | undefined {
	if (notification.method !== 'query.stateChanged') {
		return undefined;
	}
	const params = notification.params as Record<string, unknown>;
	if (typeof params !== 'object' || params === null || Array.isArray(params)) {
		return undefined;
	}
	if (typeof params.executionId !== 'string' || !BRIDGE_ID_PATTERN.test(params.executionId)) {
		return undefined;
	}
	if (typeof params.sequence !== 'number' || !Number.isSafeInteger(params.sequence) || params.sequence < 2) {
		return undefined;
	}
	if (!isExecutionState(params.state)) {
		return undefined;
	}
	const event: { runtimeGeneration: number; executionId: string; sequence: number; state: INyalaQueryStateChangedEvent['state']; resultIds?: readonly string[]; elapsedMs?: number; error?: INyalaQueryStateChangedEvent['error'] } = {
		runtimeGeneration,
		executionId: params.executionId,
		sequence: params.sequence,
		state: params.state,
	};
	if (params.resultIds !== undefined) {
		if (!Array.isArray(params.resultIds) || !params.resultIds.every(id => typeof id === 'string' && BRIDGE_ID_PATTERN.test(id))) {
			return undefined;
		}
		event.resultIds = [...params.resultIds as string[]];
	}
	if (params.elapsedMs !== undefined) {
		if (typeof params.elapsedMs !== 'number' || !Number.isSafeInteger(params.elapsedMs) || params.elapsedMs < 0) {
			return undefined;
		}
		event.elapsedMs = params.elapsedMs;
	}
	if (params.error !== undefined && params.error !== null) {
		const error = asRuntimeError(params.error);
		if (!error) {
			return undefined;
		}
		event.error = error;
	}
	return event;
}

/** Mirrors the contract id pattern the request validators use; kept local so the channel does not re-export it. */
const BRIDGE_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

const EXECUTION_STATES = new Set(['queued', 'running', 'streaming', 'completed', 'failed', 'cancel_requested', 'cancelled', 'unknown']);

function isExecutionState(value: unknown): value is INyalaQueryStateChangedEvent['state'] {
	return typeof value === 'string' && EXECUTION_STATES.has(value);
}

/**
 * Checks an answer against the v1 schema before it reaches the renderer. Only the fields the
 * workbench reads are validated; anything extra is left to the runtime, which owns the contract.
 * Returns a safe description of the problem, or `undefined` when the answer is usable.
 */
export function checkResultShape(command: NyalaRuntimeCommand, result: unknown, params: object): string | undefined {
	if (typeof result !== 'object' || result === null || Array.isArray(result)) {
		return 'the reply is not an object';
	}
	const answer = result as Record<string, unknown>;
	switch (command) {
		case NyalaRuntimeCommand.QueryExecute: {
			if (typeof answer.executionId !== 'string' || !BRIDGE_ID_PATTERN.test(answer.executionId)) {
				return 'executionId is not a contract id';
			}
			if (!isExecutionState(answer.state)) {
				return 'state is not a contract state';
			}
			if (typeof answer.sequence !== 'number' || !Number.isSafeInteger(answer.sequence) || answer.sequence < 1) {
				return 'sequence is not a positive integer';
			}
			return undefined;
		}
		case NyalaRuntimeCommand.QueryGetState: {
			if (typeof answer.executionId !== 'string' || !BRIDGE_ID_PATTERN.test(answer.executionId)) {
				return 'executionId is not a contract id';
			}
			if (!isExecutionState(answer.state)) {
				return 'state is not a contract state';
			}
			if (typeof answer.sequence !== 'number' || !Number.isSafeInteger(answer.sequence) || answer.sequence < 1) {
				return 'sequence is not a positive integer';
			}
			if (answer.resultIds !== undefined && (!Array.isArray(answer.resultIds) || !answer.resultIds.every(id => typeof id === 'string' && BRIDGE_ID_PATTERN.test(id)))) {
				return 'resultIds is not a list of contract ids';
			}
			return undefined;
		}
		case NyalaRuntimeCommand.QueryCancel: {
			if (typeof answer.accepted !== 'boolean') {
				return 'accepted is not a boolean';
			}
			if (!isExecutionState(answer.state)) {
				return 'state is not a contract state';
			}
			return undefined;
		}
		case NyalaRuntimeCommand.ResultFetchPage: {
			if (!Array.isArray(answer.columns) || !Array.isArray(answer.rows)) {
				return 'columns and rows must be arrays';
			}
			const limit = (params as { limit?: number }).limit;
			if (typeof limit === 'number' && answer.rows.length > limit) {
				return 'the reply carries more rows than were asked for';
			}
			if (typeof answer.hasMore !== 'boolean') {
				return 'hasMore is not a boolean';
			}
			if (answer.nextCursor !== null && typeof answer.nextCursor !== 'string') {
				return 'nextCursor is neither a string nor null';
			}
			return undefined;
		}
		case NyalaRuntimeCommand.ResultRelease: {
			if (typeof answer.released !== 'boolean') {
				return 'released is not a boolean';
			}
			return undefined;
		}
		default:
			return undefined;
	}
}
