/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout } from '../../../../base/common/async.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { AbstractMessageLogger, LogLevel } from '../../../log/common/log.js';
import { NyalaRuntimeError } from '../../common/nyalaRuntimeProtocol.js';
import { NyalaRuntimeSupervisor, NyalaRuntimeSupervisorState } from '../../node/nyalaRuntimeSupervisor.js';

/** Keeps every line at Info level and above as `<Level> <message>`. */
export class TestRuntimeLogger extends AbstractMessageLogger {
	readonly lines: string[] = [];

	protected log(level: LogLevel, message: string): void {
		this.lines.push(`${LogLevel[level]} ${message}`);
	}
}

/** Whether a process with this id exists. Signal 0 only tests for existence, on Windows too. */
export function isRunning(pid: number | undefined): boolean {
	if (pid === undefined) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Resolves with the first state, current or future, that matches `predicate`. */
export async function untilState(supervisor: NyalaRuntimeSupervisor, predicate: (state: NyalaRuntimeSupervisorState) => boolean, what: string, timeoutMs = 15_000): Promise<NyalaRuntimeSupervisorState> {
	if (predicate(supervisor.state)) {
		return supervisor.state;
	}
	const store = new DisposableStore();
	try {
		return await new Promise<NyalaRuntimeSupervisorState>((resolve, reject) => {
			store.add(supervisor.onDidChangeState(state => {
				if (predicate(state)) {
					resolve(state);
				}
			}));
			store.add(disposableTimeout(() => reject(new Error(`timed out waiting for ${what}; state is ${JSON.stringify(supervisor.state)}`)), timeoutMs));
		});
	} finally {
		store.dispose();
	}
}

export function readyPid(supervisor: NyalaRuntimeSupervisor): number | undefined {
	return supervisor.state.type === 'ready' ? supervisor.state.pid : undefined;
}

/** `fulfilled`, or the `data.kind` of a rejection with a {@link NyalaRuntimeError}. */
export function settledKind(result: PromiseSettledResult<unknown>): string {
	if (result.status === 'fulfilled') {
		return 'fulfilled';
	}
	return result.reason instanceof NyalaRuntimeError ? result.reason.kind : String(result.reason);
}
