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
import { INyalaRuntimeCallResult, INyalaRuntimeState, NyalaRuntimeCommand, NyalaRuntimeEvent } from '../common/nyalaRuntimeIpc.js';
import { INyalaRuntimeErrorObject, NyalaRuntimeError } from '../common/nyalaRuntimeProtocol.js';
import { asRuntimeError, connectionTarget, describeParams, listObjectsParams, NyalaRequestError, sessionRef } from '../common/nyalaRuntimeRequest.js';
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
			const result: INyalaRuntimeCallResult = { ok: false, runtimeGeneration: generation, error: toWireError(error) };
			return result as T;
		}
		if (!supervisor) {
			const result: INyalaRuntimeCallResult = {
				ok: false,
				runtimeGeneration: 0,
				error: { code: -32012, message: 'The Nyala runtime is not available', data: { kind: 'RUNTIME_LOST', retryable: true, safeDetail: 'no runtime has been started for this window' } },
			};
			return result as T;
		}
		try {
			const result = await supervisor.request(method, validated);
			return { ok: true, runtimeGeneration: generation, result } as T;
		} catch (error) {
			this.logService.trace(`Nyala runtime: ${command} failed for window ${windowId}`);
			return { ok: false, runtimeGeneration: generation, error: toWireError(error) } as T;
		}
	}

	listen<T>(context: string, event: string): Event<T> {
		const windowId = windowIdFromContext(context);
		const supervisor = windowId === undefined ? undefined : this.supervisors.get(windowId);
		if (event !== NyalaRuntimeEvent.RuntimeStateChanged || !supervisor) {
			// An event nobody will fire; the renderer polls through `getRuntimeState` if the
			// generation was not announced (for example before this window had a supervisor).
			return Event.None as Event<T>;
		}
		return Event.map(supervisor.onDidChangeState, () => runtimeStateOf(supervisor)) as Event<T>;
	}
}

/** The v1 method behind every allowed command. */
export const NYALA_RUNTIME_METHODS: ReadonlyMap<string, string> = new Map([
	[NyalaRuntimeCommand.TestConnection, 'connection.test'],
	[NyalaRuntimeCommand.OpenConnection, 'connection.open'],
	[NyalaRuntimeCommand.CloseConnection, 'connection.close'],
	[NyalaRuntimeCommand.ListObjects, 'metadata.listObjects'],
	[NyalaRuntimeCommand.DescribeObject, 'metadata.describe'],
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
