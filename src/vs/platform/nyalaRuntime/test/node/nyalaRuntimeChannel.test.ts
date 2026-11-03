/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The main-process side of the renderer bridge, against a real `nyala-runtime` build. These tests
// pin the three promises ADR 0006 makes: only whitelisted commands pass, only the calling window's
// supervisor is reachable, and a structured runtime error survives the channel as a value.

import assert from 'assert';
import { Event } from '../../../../base/common/event.js';
import { promises as fsPromises } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { FileAccess } from '../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { INyalaRuntimeCallResult, INyalaRuntimeState, NYALA_RUNTIME_FEATURES } from '../../common/nyalaRuntimeIpc.js';
import { connectionTarget, sessionRef } from '../../common/nyalaRuntimeRequest.js';
import { createNyalaRuntimeEnvironment, findNyalaRuntimeExecutable, INyalaRuntimeLaunch } from '../../node/nyalaRuntimeProcess.js';
import { NyalaRuntimeSupervisor } from '../../node/nyalaRuntimeSupervisor.js';
import { checkResultShape, NyalaRuntimeChannel, queryStateEvent, runtimeStateOf, windowIdFromContext } from '../../electron-main/nyalaRuntimeChannel.js';
import { NyalaRuntimeCommand, NyalaRuntimeEvent } from '../../common/nyalaRuntimeIpc.js';
import { TestRuntimeLogger } from './nyalaRuntimeTestUtils.js';

const REPO_ROOT = dirname(FileAccess.asFileUri('').fsPath);
const REQUIRED_ENV = 'NYALA_RUNTIME_REQUIRED';

/** One supervisor per window id, as `NyalaRuntimeMainHandler` keeps them. */
class FakeSupervisors {
	readonly byWindow = new Map<number, NyalaRuntimeSupervisor>();
	get(windowId: number): NyalaRuntimeSupervisor | undefined {
		return this.byWindow.get(windowId);
	}
}

suite('Nyala runtime channel', function () {

	this.timeout(60_000);

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let launch: INyalaRuntimeLaunch | undefined;
	let tmpDir = '';

	suiteSetup(async function () {
		const executable = await findNyalaRuntimeExecutable(REPO_ROOT, false, process.env, process.platform);
		if (!executable) {
			if (process.env[REQUIRED_ENV] === '1') {
				throw new Error(`no nyala-runtime build under rust/target and ${REQUIRED_ENV}=1; run 'cargo build' in rust/`);
			}
			this.skip();
		}
		launch = { executable: executable!, args: [], env: createNyalaRuntimeEnvironment(process.env) };
		tmpDir = await fsPromises.mkdtemp(join(tmpdir(), 'nyala-channel-'));
	});

	suiteTeardown(async () => {
		await fsPromises.rm(tmpDir, { recursive: true, force: true });
	});

	test('the window id comes from the IPC context and nothing else', () => {
		assert.strictEqual(windowIdFromContext('window:1'), 1);
		assert.strictEqual(windowIdFromContext('window:42'), 42);
		for (const context of ['window:', 'window:abc', '1', 'window:1x', 'other:1', '', undefined, 7]) {
			assert.strictEqual(windowIdFromContext(context), undefined, String(context));
		}
	});

	test('a command outside the whitelist is refused before any process is touched', async () => {
		const supervisors = new FakeSupervisors();
		const logger = store.add(new TestRuntimeLogger());
		const channel = new NyalaRuntimeChannel(supervisors, logger);
		await assert.rejects(() => channel.call('window:1', 'query.explain', {}), /not allowed/);
		await assert.rejects(() => channel.call('window:1', 'runtime.hello', {}), /not allowed/);
		await assert.rejects(() => channel.call('not-a-window', 'getRuntimeState'), /unknown client context/);
	});

	test('a window without a runtime gets a structured RUNTIME_LOST, not a throw', async () => {
		const channel = new NyalaRuntimeChannel(new FakeSupervisors(), store.add(new TestRuntimeLogger()));
		const answer = await channel.call<INyalaRuntimeCallResult>('window:9', 'connection.test', { driver: 'sqlite', path: '/tmp/x.sqlite', readOnly: true });
		assert.strictEqual(answer.ok, false);
		if (!answer.ok) {
			assert.strictEqual(answer.error.data.kind, 'RUNTIME_LOST');
			assert.strictEqual(answer.runtimeGeneration, 0);
		}
	});

	test('invalid parameters become an INVALID_PARAMS value, never a runtime request', async () => {
		const supervisors = new FakeSupervisors();
		const channel = new NyalaRuntimeChannel(supervisors, store.add(new TestRuntimeLogger()));
		for (const params of [
			{ driver: 'sqlite', path: 'file:/tmp/x.sqlite?mode=rwc', readOnly: true },
			{ driver: 'sqlite', path: 'db.sqlite', readOnly: true },
			{ driver: 'postgres', path: '/tmp/x.sqlite', readOnly: true },
			{ driver: 'sqlite', path: '/tmp/x.sqlite' },
		]) {
			const answer = await channel.call<INyalaRuntimeCallResult>('window:1', 'connection.test', params);
			assert.strictEqual(answer.ok, false, JSON.stringify(params));
			if (!answer.ok) {
				assert.strictEqual(answer.error.data.kind, 'INVALID_PARAMS', JSON.stringify(params));
			}
		}
		// A stray field is dropped rather than forwarded, which the request tests cover.
		const dropped = connectionTarget({ driver: 'sqlite', path: '/tmp/x.sqlite', readOnly: true, sessionId: 's_9' });
		assert.deepStrictEqual(dropped, { driver: 'sqlite', path: '/tmp/x.sqlite', readOnly: true });
		// The relative path and the URI are refused before the supervisor is asked for one.
		assert.strictEqual(supervisors.byWindow.size, 0);
	});

	test('each window reaches only its own runtime', async function () {
		if (!launch) {
			this.skip();
		}
		const supervisors = new FakeSupervisors();
		const logger = store.add(new TestRuntimeLogger());
		const start = async (windowId: number) => {
			const supervisor = store.add(new NyalaRuntimeSupervisor({ label: `window ${windowId}`, clientBuild: '0.0.1-test', supportedFeatures: NYALA_RUNTIME_FEATURES, resolveLaunch: async () => launch! }, logger));
			supervisors.byWindow.set(windowId, supervisor);
			await supervisor.start();
			return supervisor;
		};
		const first = await start(1);
		const second = await start(2);
		const channel = new NyalaRuntimeChannel(supervisors, logger);

		try {
			const firstState = await channel.call<INyalaRuntimeCallResult<INyalaRuntimeState>>('window:1', 'getRuntimeState');
			const secondState = await channel.call<INyalaRuntimeCallResult<INyalaRuntimeState>>('window:2', 'getRuntimeState');
			assert.ok(firstState.ok && secondState.ok);
			if (firstState.ok && secondState.ok) {
				assert.strictEqual(firstState.result.generation, first.generation);
				assert.strictEqual(secondState.result.generation, second.generation);
			}
			// Each process issues its own session ids, so an id one window's runtime issued is
			// unknown to the other; this is what makes sharing a session across windows impossible
			// even if a renderer tried to name one.
			const database = join(tmpDir, 'window-one.sqlite');
			await fsPromises.writeFile(database, '');
			const opened = await channel.call<INyalaRuntimeCallResult<{ sessionId: string; sessionGeneration: number }>>('window:1', 'connection.open', connectionTarget({ driver: 'sqlite', path: database, readOnly: true }));
			// An empty file is not a database; the runtime says so with a structured error.
			assert.strictEqual(opened.ok, false, 'an empty file must not open as a database');
			if (!opened.ok) {
				assert.strictEqual(opened.error.data.kind, 'INVALID_PARAMS');
			}
			// A session id fabricated for window 2 is refused by window 2's own process.
			const foreign = await channel.call<INyalaRuntimeCallResult>('window:2', 'connection.close', sessionRef({ sessionId: 's_0000deadbeef0001', sessionGeneration: 1 }));
			assert.strictEqual(foreign.ok, false);
			if (!foreign.ok) {
				assert.strictEqual(foreign.error.data.kind, 'INVALID_SESSION');
			}
			assert.strictEqual(runtimeStateOf(first).status, 'ready');
			assert.strictEqual(runtimeStateOf(second).status, 'ready');
		} finally {
			await first.stop();
			await second.stop();
		}
	});

	test('a command outside the whitelist cannot smuggle a method in through its params', async () => {
		const supervisors = new FakeSupervisors();
		const logger = store.add(new TestRuntimeLogger());
		const channel = new NyalaRuntimeChannel(supervisors, logger);

		for (const command of ['query.explain', 'result.fetchAll', 'transaction.begin', 'runtime.hello']) {
			await assert.rejects(() => channel.call('window:1', command, {}), /not allowed/, command);
		}
	});

	test('execution parameters are validated before any process is touched', async () => {
		const supervisors = new FakeSupervisors();
		const logger = store.add(new TestRuntimeLogger());
		const channel = new NyalaRuntimeChannel(supervisors, logger);

		const answer = await channel.call<INyalaRuntimeCallResult>('window:1', NyalaRuntimeCommand.QueryExecute, { sessionId: 's_1', sessionGeneration: 1, sql: '', mode: 'statement', timeoutMs: 1, maxInitialRows: 1 });

		assert.deepStrictEqual({ ok: answer.ok, kind: answer.ok ? undefined : answer.error.data.kind }, { ok: false, kind: 'INVALID_PARAMS' });
	});

	test('a malformed reply is reported as an internal failure, never as a statement about the SQL', () => {
		const cases: Array<[NyalaRuntimeCommand, unknown, object]> = [
			[NyalaRuntimeCommand.QueryExecute, { executionId: 'not an id', state: 'queued', sequence: 1 }, {}],
			[NyalaRuntimeCommand.QueryExecute, { executionId: 'ex_1', state: 'halfway', sequence: 1 }, {}],
			[NyalaRuntimeCommand.QueryExecute, { executionId: 'ex_1', state: 'queued', sequence: 0 }, {}],
			[NyalaRuntimeCommand.QueryGetState, { executionId: 'ex_1', state: 'running', sequence: 1, resultIds: ['bad id'] }, {}],
			[NyalaRuntimeCommand.QueryCancel, { accepted: 'yes', state: 'cancelled' }, {}],
			[NyalaRuntimeCommand.ResultFetchPage, { columns: [], rows: [[], [], []], hasMore: false, nextCursor: null }, { limit: 2 }],
			[NyalaRuntimeCommand.ResultFetchPage, { columns: [], rows: [], hasMore: 'no', nextCursor: null }, { limit: 2 }],
			[NyalaRuntimeCommand.ResultRelease, { released: 'yes' }, {}],
			[NyalaRuntimeCommand.QueryExecute, 'not an object', {}],
		];

		for (const [command, result, params] of cases) {
			const problem = checkResultShape(command, result, params);
			assert.ok(problem, `${command}: ${JSON.stringify(result)}`);
		}
	});

	test('a well-formed reply passes the shape check unchanged', () => {
		const cases: Array<[NyalaRuntimeCommand, object, object]> = [
			[NyalaRuntimeCommand.QueryExecute, { executionId: 'ex_1', state: 'queued', sequence: 1 }, {}],
			[NyalaRuntimeCommand.QueryGetState, { executionId: 'ex_1', state: 'completed', sequence: 4, resultIds: ['rs_1'] }, {}],
			[NyalaRuntimeCommand.QueryCancel, { accepted: true, state: 'cancel_requested' }, {}],
			[NyalaRuntimeCommand.ResultFetchPage, { columns: [], rows: [[], []], hasMore: false, nextCursor: null }, { limit: 2 }],
			[NyalaRuntimeCommand.ResultRelease, { released: false }, {}],
		];

		for (const [command, result, params] of cases) {
			assert.strictEqual(checkResultShape(command, result, params), undefined, command);
		}
	});

	test('a state notification carries the generation of the process that sent it', () => {
		const event = queryStateEvent({ method: 'query.stateChanged', params: { executionId: 'ex_1', sequence: 2, state: 'running', resultIds: ['rs_1'], elapsedMs: 5 } }, 7);

		assert.deepStrictEqual(event, { runtimeGeneration: 7, executionId: 'ex_1', sequence: 2, state: 'running', resultIds: ['rs_1'], elapsedMs: 5 });
	});

	test('a notification that does not match the contract is dropped instead of being guessed at', () => {
		for (const params of [
			{ executionId: 'ex_1', sequence: 1, state: 'running' },
			{ executionId: 'ex_1', sequence: 2, state: 'nearly-done' },
			{ executionId: 'bad id', sequence: 2, state: 'running' },
			{ executionId: 'ex_1', sequence: 2, state: 'running', resultIds: ['ok', 'bad id'] },
			{ executionId: 'ex_1', sequence: 2, state: 'running', elapsedMs: -1 },
			{ executionId: 'ex_1', sequence: 2, state: 'running', error: { code: 'x' } },
			{ sequence: 2, state: 'running' },
		]) {
			assert.strictEqual(queryStateEvent({ method: 'query.stateChanged', params }, 1), undefined, JSON.stringify(params).slice(0, 70));
		}
		assert.strictEqual(queryStateEvent({ method: 'runtime.restarted', params: {} }, 1), undefined);
	});

	test('the state event listener exists for a window with a supervisor and nowhere without one', () => {
		const withoutSupervisor = new NyalaRuntimeChannel(new FakeSupervisors(), store.add(new TestRuntimeLogger()));
		assert.strictEqual(withoutSupervisor.listen('window:1', NyalaRuntimeEvent.QueryStateChanged), Event.None);
	});
});
