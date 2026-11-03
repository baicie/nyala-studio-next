/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The main-process side of the renderer bridge, against a real `nyala-runtime` build. These tests
// pin the three promises ADR 0006 makes: only whitelisted commands pass, only the calling window's
// supervisor is reachable, and a structured runtime error survives the channel as a value.

import assert from 'assert';
import { promises as fsPromises } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { FileAccess } from '../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { INyalaRuntimeCallResult, INyalaRuntimeState } from '../../common/nyalaRuntimeIpc.js';
import { connectionTarget, sessionRef } from '../../common/nyalaRuntimeRequest.js';
import { createNyalaRuntimeEnvironment, findNyalaRuntimeExecutable, INyalaRuntimeLaunch } from '../../node/nyalaRuntimeProcess.js';
import { NyalaRuntimeSupervisor } from '../../node/nyalaRuntimeSupervisor.js';
import { NyalaRuntimeChannel, runtimeStateOf, windowIdFromContext } from '../../electron-main/nyalaRuntimeChannel.js';
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

suite('Nyala runtime channel', function (this: Mocha.Suite) {

	this.timeout(60_000);

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let launch: INyalaRuntimeLaunch | undefined;
	let tmpDir = '';

	suiteSetup(async function (this: Mocha.Suite) {
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
		await assert.rejects(() => channel.call('window:1', 'query.execute', {}), /not allowed/);
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
			{ driver: 'sqlite', path: '/tmp/x.sqlite', readOnly: true, sessionId: 's_9' },
			{ driver: 'postgres', path: '/tmp/x.sqlite', readOnly: true },
		]) {
			const answer = await channel.call<INyalaRuntimeCallResult>('window:1', 'connection.test', params);
			assert.strictEqual(answer.ok, false, JSON.stringify(params));
			if (!answer.ok) {
				assert.strictEqual(answer.error.data.kind, 'INVALID_PARAMS', JSON.stringify(params));
			}
		}
		// The relative path and the URI are refused before the supervisor is asked for one.
		assert.strictEqual(supervisors.byWindow.size, 0);
	});

	test('each window reaches only its own runtime', async function (this: Mocha.Test) {
		if (!launch) {
			this.skip();
		}
		const supervisors = new FakeSupervisors();
		const logger = store.add(new TestRuntimeLogger());
		const start = async (windowId: number) => {
			const supervisor = store.add(new NyalaRuntimeSupervisor({ label: `window ${windowId}`, clientBuild: '0.0.1-test', resolveLaunch: async () => launch! }, logger));
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
});
