/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { timeout } from '../../../../base/common/async.js';
import { FileAccess } from '../../../../base/common/network.js';
import { dirname, join } from '../../../../base/common/path.js';
import { getRandomTestPath } from '../../../../base/test/node/testUtils.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { INyalaRuntimeRestartedParams } from '../../common/nyalaRuntimeProtocol.js';
import { createNyalaRuntimeEnvironment, findNyalaRuntimeExecutable, INyalaRuntimeLaunch, INyalaRuntimeNotification, NYALA_RUNTIME_PATH_ENV, stageNyalaRuntimeExecutable } from '../../node/nyalaRuntimeProcess.js';
import { INyalaRuntimeSupervisorPolicy, NyalaRuntimeSupervisor, NyalaRuntimeWindowSupervisors } from '../../node/nyalaRuntimeSupervisor.js';
import { isRunning, readyPid, settledKind, TestRuntimeLogger, untilState } from './nyalaRuntimeTestUtils.js';

const FAKE_RUNTIME = FileAccess.asFileUri('vs/platform/nyalaRuntime/test/node/fixtures/fakeNyalaRuntime.js').fsPath;

/** Short delays so that restart and timeout paths finish quickly against real child processes. */
const TEST_POLICY: INyalaRuntimeSupervisorPolicy = {
	initialRestartDelayMs: 20,
	maxRestartDelayMs: 40,
	maxRestarts: 2,
	stableAfterMs: 60_000,
	handshakeTimeoutMs: 3_000,
	stopTimeoutMs: 3_000,
	killTimeoutMs: 3_000,
};

function fakeLaunch(...args: string[]): INyalaRuntimeLaunch {
	// The test runner may be Electron; ELECTRON_RUN_AS_NODE makes it run the fixture as Node does.
	return { executable: process.execPath, args: [FAKE_RUNTIME, ...args], env: { ...createNyalaRuntimeEnvironment(process.env), ELECTRON_RUN_AS_NODE: '1' } };
}

suite('Nyala runtime supervisor', function () {

	this.timeout(60_000);

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let logger: TestRuntimeLogger;

	setup(() => {
		logger = store.add(new TestRuntimeLogger());
	});

	function createSupervisor(launch: INyalaRuntimeLaunch | undefined, policy: Partial<INyalaRuntimeSupervisorPolicy> = {}, label = 'test'): NyalaRuntimeSupervisor {
		return store.add(new NyalaRuntimeSupervisor({ label, clientBuild: '0.0.1-test', resolveLaunch: async () => launch, policy: { ...TEST_POLICY, ...policy } }, logger));
	}

	function recordStates(supervisor: NyalaRuntimeSupervisor): string[] {
		const states: string[] = [];
		store.add(supervisor.onDidChangeState(state => states.push(state.type === 'restarting' ? `restarting ${state.delayMs}` : state.type)));
		return states;
	}

	test('completes hello and health, serves requests, and stops by closing stdin', async () => {
		const supervisor = createSupervisor(fakeLaunch('ok'));
		const states = recordStates(supervisor);
		await supervisor.start();
		const ready = supervisor.state;
		const pid = readyPid(supervisor);
		const echo = await supervisor.request('fake.echo', { text: 'hello' });

		await supervisor.stop();

		assert.deepStrictEqual({
			ready: ready.type === 'ready' ? { generation: ready.generation, runtimeBuild: ready.runtimeBuild } : ready,
			echo,
			states,
			running: isRunning(pid),
			killed: logger.lines.filter(line => line.includes('killing it')),
		}, {
			ready: { generation: 1, runtimeBuild: '0.0.0-fake' },
			echo: { text: 'hello' },
			states: ['starting', 'ready', 'stopped'],
			running: false,
			killed: [],
		});
	});

	test('reassembles frames that arrive in pieces and keeps notifications in order', async () => {
		const supervisor = createSupervisor(fakeLaunch('chunked'));
		const notifications: INyalaRuntimeNotification[] = [];
		const restarts: INyalaRuntimeRestartedParams[] = [];
		store.add(supervisor.onDidNotify(notification => notifications.push(notification)));
		store.add(supervisor.onDidRestart(params => restarts.push(params)));
		await supervisor.start();

		const burst = await supervisor.request('fake.burst', {});
		// A runtime.restarted sent by the runtime itself is not forwarded: only the supervisor knows
		// that a process was replaced.
		await supervisor.request('fake.restarted', {});
		await supervisor.stop();

		assert.deepStrictEqual({ burst, notifications, restarts }, {
			burst: { done: true },
			notifications: [{ method: 'fake.tick', params: { n: 1 } }, { method: 'fake.tick', params: { n: 2 } }],
			restarts: [],
		});
	});

	test('copies stderr to the log line by line and never logs stdout payloads', async () => {
		const supervisor = createSupervisor(fakeLaunch('ok'));
		await supervisor.start();
		await supervisor.request('fake.stderr', { text: 'first line\nsecond line\n' });
		await supervisor.request('fake.echo', { text: 'select secret_column from secret_table' });
		await supervisor.stop();

		assert.deepStrictEqual({
			stderr: logger.lines.filter(line => line.includes('stderr:')).map(line => line.replace(/^.*stderr: /, '')),
			payloads: logger.lines.filter(line => line.includes('secret')),
		}, {
			stderr: ['first line', 'second line'],
			payloads: [],
		});
	});

	test('a protocol mismatch (exit code 2) fails without a restart', async () => {
		const supervisor = createSupervisor(fakeLaunch('mismatch'));
		const states = recordStates(supervisor);
		await supervisor.start();
		await untilState(supervisor, state => state.type === 'failed', 'failed');
		await timeout(200); // longer than any restart delay

		assert.deepStrictEqual({ generation: supervisor.generation, states }, { generation: 1, states: ['starting', 'failed'] });
	});

	test('a hello reply of another protocol major fails without a restart', async () => {
		const supervisor = createSupervisor(fakeLaunch('badHello'));
		await supervisor.start();
		const failed = await untilState(supervisor, state => state.type === 'failed', 'failed');
		await timeout(200);

		assert.deepStrictEqual({ generation: supervisor.generation, reason: failed.type === 'failed' && failed.reason.startsWith('the runtime.hello reply is not a protocol 1 result') }, { generation: 1, reason: true });
	});

	test('a process that exits on start is restarted with backoff until the restart limit', async () => {
		const supervisor = createSupervisor(fakeLaunch('exitOnStart', '1'));
		const states = recordStates(supervisor);
		await supervisor.start();
		const failed = await untilState(supervisor, state => state.type === 'failed', 'failed');
		await timeout(200);

		assert.deepStrictEqual({ generation: supervisor.generation, states, reason: failed.type === 'failed' ? failed.reason : undefined }, {
			generation: 3,
			states: ['starting', 'restarting 20', 'starting', 'restarting 40', 'starting', 'failed'],
			reason: 'the runtime exited with code 1; giving up after 2 restarts in a row',
		});
	});

	test('a handshake that gets no reply kills the process and counts as a crash', async () => {
		const supervisor = createSupervisor(fakeLaunch('silent'), { handshakeTimeoutMs: 300, maxRestarts: 1 });
		const states = recordStates(supervisor);
		await supervisor.start();
		await untilState(supervisor, state => state.type === 'failed', 'failed');

		assert.deepStrictEqual({ generation: supervisor.generation, states, timeouts: logger.lines.filter(line => line.includes('no runtime.hello reply within 300 ms')).length }, {
			generation: 2,
			states: ['starting', 'restarting 20', 'starting', 'failed'],
			timeouts: 2,
		});
	});

	test('a frame that breaks the stream kills the process', async () => {
		const supervisor = createSupervisor(fakeLaunch('garbage'), { maxRestarts: 0 });
		await supervisor.start();
		await untilState(supervisor, state => state.type === 'failed', 'failed');

		assert.deepStrictEqual(logger.lines.filter(line => line.includes('stdout is no longer a protocol stream')).map(line => line.replace(/; killing pid \d+$/, '')), [
			'Error test #1: stdout is no longer a protocol stream (Zero-length frame)',
		]);
	});

	test('a crash fails in-flight requests with RUNTIME_LOST, restarts, and replays nothing', async () => {
		const supervisor = createSupervisor(fakeLaunch('ok'));
		const restarts: INyalaRuntimeRestartedParams[] = [];
		store.add(supervisor.onDidRestart(params => restarts.push(params)));
		await supervisor.start();
		const firstPid = readyPid(supervisor);

		const inFlight = await Promise.allSettled([supervisor.request('fake.hang', {}), supervisor.request('fake.exit', { code: 1 })]);
		const whileRestarting = await Promise.allSettled([supervisor.request('fake.echo', {})]);
		await untilState(supervisor, state => state.type === 'ready' && state.generation === 2, 'generation 2');
		// The new process counts the requests it received apart from the handshake.
		const stats = await supervisor.request('fake.stats', {});
		await supervisor.stop();

		assert.deepStrictEqual({
			inFlight: inFlight.map(settledKind),
			whileRestarting: whileRestarting.map(settledKind),
			restarts,
			stats,
			firstPidRunning: isRunning(firstPid),
		}, {
			inFlight: ['RUNTIME_LOST', 'RUNTIME_LOST'],
			whileRestarting: ['RUNTIME_LOST'],
			restarts: [{ reason: 'unexpected-exit', pendingExecutions: 'unknown', previousBuild: '0.0.0-fake' }],
			stats: { requests: 0 },
			firstPidRunning: false,
		});
	});

	test('a runtime that ignores the closed stdin is killed after the stop timeout', async () => {
		const supervisor = createSupervisor(fakeLaunch('ignoreStdinEnd'), { stopTimeoutMs: 300 });
		await supervisor.start();
		const pid = readyPid(supervisor);
		await supervisor.stop();

		assert.deepStrictEqual({
			state: supervisor.state.type,
			running: isRunning(pid),
			killed: logger.lines.filter(line => line.includes('did not exit within 300 ms after stdin was closed; killing it')).length,
		}, { state: 'stopped', running: false, killed: 1 });
	});

	test('a missing executable fails the supervisor and requests fail with RUNTIME_LOST', async () => {
		const missing = createSupervisor(undefined);
		await missing.start();
		const unstartable = createSupervisor({ executable: join(tmpdir(), 'nyala-runtime-does-not-exist.exe'), args: [], env: {} });
		await unstartable.start();
		await untilState(unstartable, state => state.type === 'failed', 'failed');

		assert.deepStrictEqual({
			missing: missing.state,
			unstartable: unstartable.state.type === 'failed' && unstartable.state.reason.startsWith('the runtime could not be started'),
			request: (await Promise.allSettled([missing.request('runtime.health', {})])).map(settledKind),
		}, {
			missing: { type: 'failed', reason: 'no nyala-runtime executable was found' },
			unstartable: true,
			request: ['RUNTIME_LOST'],
		});
	});

	test('a spawn that throws synchronously fails the supervisor on start, restart and after a crash', async () => {
		// Node throws instead of emitting `error` for some spawn failures, e.g. EFTYPE for a file that
		// is not a Windows executable or ENOEXEC on Linux. A NUL in the path throws
		// ERR_INVALID_ARG_VALUE on every platform.
		const unspawnable: INyalaRuntimeLaunch = { executable: join(tmpdir(), 'nyala\0runtime'), args: [], env: {} };

		const supervisor = createSupervisor(unspawnable);
		const states = recordStates(supervisor);
		await supervisor.start();
		const failed = await untilState(supervisor, state => state.type === 'failed', 'failed after start');
		await supervisor.restart('window-reload');
		await untilState(supervisor, state => state.type === 'failed' && supervisor.generation === 2, 'failed after restart');

		// A crash schedules a restart whose spawn throws; the supervisor must not stay in restarting.
		const launches = [fakeLaunch('ok')];
		const crashed = store.add(new NyalaRuntimeSupervisor({ label: 'crash', clientBuild: '0.0.1-test', resolveLaunch: async () => launches.shift() ?? unspawnable, policy: TEST_POLICY }, logger));
		const crashedStates = recordStates(crashed);
		await crashed.start();
		await Promise.allSettled([crashed.request('fake.exit', { code: 1 })]);
		await untilState(crashed, state => state.type === 'failed', 'failed after a crash');

		// A zero-byte file: EFTYPE, thrown synchronously, on Windows; EACCES, reported as an error
		// event, elsewhere (the file is not executable).
		const dir = getRandomTestPath(tmpdir(), 'vsctests', 'nyalaRuntimeEmpty');
		await fs.mkdir(dir, { recursive: true });
		try {
			const empty = join(dir, process.platform === 'win32' ? 'nyala-runtime.exe' : 'nyala-runtime');
			await fs.writeFile(empty, '');
			const emptySupervisor = createSupervisor({ executable: empty, args: [], env: {} });
			await emptySupervisor.start();
			const emptyFailed = await untilState(emptySupervisor, state => state.type === 'failed', 'failed for a zero-byte file');

			assert.deepStrictEqual({
				states,
				reason: failed.type === 'failed' ? failed.reason : undefined,
				crashedStates,
				empty: emptyFailed.type === 'failed' && emptyFailed.reason.startsWith('the runtime could not be started'),
			}, {
				states: ['starting', 'failed', 'starting', 'failed'],
				reason: 'the runtime could not be started (ERR_INVALID_ARG_VALUE)',
				crashedStates: ['starting', 'ready', 'restarting 20', 'starting', 'failed'],
				empty: true,
			});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('a request whose params JSON cannot represent is rejected, not thrown', async () => {
		const supervisor = createSupervisor(fakeLaunch('ok'));
		await supervisor.start();
		let thrown: unknown;
		let request: Promise<object> | undefined;
		try {
			request = supervisor.request('fake.echo', { value: 1n });
		} catch (error) {
			thrown = error;
		}
		const settled = request ? (await Promise.allSettled([request]))[0] : undefined;
		const echo = await supervisor.request('fake.echo', { text: 'still serving' });
		await supervisor.stop();

		assert.deepStrictEqual({
			thrown,
			rejected: settled?.status === 'rejected' && settled.reason instanceof TypeError,
			echo,
		}, { thrown: undefined, rejected: true, echo: { text: 'still serving' } });
	});

	test('one runtime per window: reload replaces it, close and shutdown stop it', async () => {
		const restarts: INyalaRuntimeRestartedParams[] = [];
		const windows = store.add(new NyalaRuntimeWindowSupervisors(windowId => {
			const supervisor = createSupervisor(fakeLaunch('ok'), {}, `window ${windowId}`);
			store.add(supervisor.onDidRestart(params => restarts.push(params)));
			return supervisor;
		}, logger));

		windows.windowWillLoad(1, 'window-load');
		windows.windowWillLoad(2, 'window-load');
		const first = windows.get(1)!;
		const second = windows.get(2)!;
		await untilState(first, state => state.type === 'ready', 'window 1 ready');
		await untilState(second, state => state.type === 'ready', 'window 2 ready');
		const pids = [readyPid(first), readyPid(second)];

		windows.windowWillLoad(1, 'window-reload');
		await untilState(first, state => state.type === 'ready' && state.generation === 2, 'window 1 generation 2');
		const reloadedPid = readyPid(first);

		windows.windowDidClose(2);
		await untilState(second, state => state.type === 'stopped', 'window 2 stopped');
		await windows.shutdown();

		assert.deepStrictEqual({
			distinctPids: new Set(pids).size,
			restarts,
			closedWindow: windows.get(2),
			running: [...pids, reloadedPid].map(isRunning),
			afterShutdown: first.state.type,
		}, {
			distinctPids: 2,
			restarts: [{ reason: 'window-reload', pendingExecutions: 'none', previousBuild: '0.0.0-fake' }],
			closedWindow: undefined,
			running: [false, false, false],
			afterShutdown: 'stopped',
		});
	});
});

suite('Nyala runtime executable', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('development builds use rust/target, the newer build wins, and an override must exist', async () => {
		const appRoot = getRandomTestPath(tmpdir(), 'vsctests', 'nyalaRuntime');
		const name = process.platform === 'win32' ? 'nyala-runtime.exe' : 'nyala-runtime';
		const debug = join(appRoot, 'rust', 'target', 'debug', name);
		const release = join(appRoot, 'rust', 'target', 'release', name);
		try {
			const none = await findNyalaRuntimeExecutable(appRoot, false, {}, process.platform);
			for (const file of [debug, release]) {
				await fs.mkdir(join(file, '..'), { recursive: true });
				await fs.writeFile(file, '');
			}
			await fs.utimes(debug, new Date(2000, 0, 1), new Date(2000, 0, 1));
			const newer = await findNyalaRuntimeExecutable(appRoot, false, {}, process.platform);
			await fs.utimes(release, new Date(1999, 0, 1), new Date(1999, 0, 1));
			const newerDebug = await findNyalaRuntimeExecutable(appRoot, false, {}, process.platform);

			assert.deepStrictEqual({
				none,
				newer,
				newerDebug,
				built: await findNyalaRuntimeExecutable(appRoot, true, {}, process.platform),
				override: await findNyalaRuntimeExecutable(appRoot, false, { [NYALA_RUNTIME_PATH_ENV]: release }, process.platform),
				relativeOverride: await findNyalaRuntimeExecutable(appRoot, false, { [NYALA_RUNTIME_PATH_ENV]: name }, process.platform),
				missingOverride: await findNyalaRuntimeExecutable(appRoot, false, { [NYALA_RUNTIME_PATH_ENV]: join(appRoot, 'missing') }, process.platform),
			}, {
				none: undefined,
				newer: release,
				newerDebug: debug,
				built: undefined,
				override: release,
				relativeOverride: undefined,
				missingOverride: undefined,
			});
		} finally {
			await fs.rm(appRoot, { recursive: true, force: true });
		}
	});

	test('staging reuses an intact copy of the same content and drops copies of other content', async () => {
		const dir = getRandomTestPath(tmpdir(), 'vsctests', 'nyalaRuntimeStaging');
		const name = process.platform === 'win32' ? 'nyala-runtime.exe' : 'nyala-runtime';
		const source = join(dir, 'target', name);
		const stagingDir = join(dir, 'staging');
		const build = async (content: string, year: number) => {
			await fs.writeFile(source, content);
			await fs.utimes(source, new Date(Date.UTC(year, 0, 1)), new Date(Date.UTC(year, 0, 1)));
		};
		const folder = (path: string) => path.substring(stagingDir.length + 1, path.length - name.length - 1);
		const listed = async () => (await fs.readdir(stagingDir)).map(entry => (/^[0-9a-f]+-[0-9a-f]{64}$/.test(entry) ? 'folder named by size and digest' : entry));
		try {
			await fs.mkdir(dirname(source), { recursive: true });
			await build('build 1', 2000);
			const first = await stageNyalaRuntimeExecutable(source, stagingDir);
			const firstContent = await fs.readFile(first, 'utf8');
			// The same content with another modification time is the same build: no second copy.
			await fs.utimes(source, new Date(Date.UTC(2002, 0, 1)), new Date(Date.UTC(2002, 0, 1)));
			const sameAgain = await stageNyalaRuntimeExecutable(source, stagingDir);
			await build('build 2', 2001);
			const second = await stageNyalaRuntimeExecutable(source, stagingDir);

			assert.deepStrictEqual({
				firstContent,
				sameAgain: sameAgain === first,
				differentFolder: folder(second) !== folder(first),
				secondContent: await fs.readFile(second, 'utf8'),
				folders: await listed(),
				files: await fs.readdir(dirname(second)),
			}, {
				firstContent: 'build 1',
				sameAgain: true,
				differentFolder: true,
				secondContent: 'build 2',
				folders: ['folder named by size and digest'],
				files: [name],
			});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('staging never runs content from another source with the same name, size and modification time', async () => {
		const dir = getRandomTestPath(tmpdir(), 'vsctests', 'nyalaRuntimeStagingIdentity');
		const name = process.platform === 'win32' ? 'nyala-runtime.exe' : 'nyala-runtime';
		const stagingDir = join(dir, 'staging');
		const time = new Date(Date.UTC(2000, 0, 1));
		const build = async (content: string) => {
			// Two locations, as with two NYALA_RUNTIME_PATH values: the same name, size and mtime.
			const source = join(dir, content === 'target A' ? 'a' : 'b', name);
			await fs.mkdir(dirname(source), { recursive: true });
			await fs.writeFile(source, content);
			await fs.utimes(source, time, time);
			return source;
		};
		try {
			const first = await stageNyalaRuntimeExecutable(await build('target A'), stagingDir);
			const firstContent = await fs.readFile(first, 'utf8');
			const second = await stageNyalaRuntimeExecutable(await build('target B'), stagingDir);

			assert.deepStrictEqual({
				firstContent,
				secondContent: await fs.readFile(second, 'utf8'),
				distinctCopies: first !== second,
				folders: (await fs.readdir(stagingDir)).length,
			}, {
				firstContent: 'target A',
				secondContent: 'target B',
				distinctCopies: true,
				folders: 1,
			});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('staging replaces a copy of the same source when its content changed but size and mtime did not', async () => {
		const dir = getRandomTestPath(tmpdir(), 'vsctests', 'nyalaRuntimeStagingContent');
		const name = process.platform === 'win32' ? 'nyala-runtime.exe' : 'nyala-runtime';
		const source = join(dir, 'target', name);
		const stagingDir = join(dir, 'staging');
		const time = new Date(Date.UTC(2000, 0, 1));
		try {
			await fs.mkdir(dirname(source), { recursive: true });
			await fs.writeFile(source, 'build A');
			await fs.utimes(source, time, time);
			const first = await stageNyalaRuntimeExecutable(source, stagingDir);
			const firstContent = await fs.readFile(first, 'utf8');
			// Same source, same size and modification time, other bytes: a rebuild that preserved mtime.
			await fs.writeFile(source, 'build B');
			await fs.utimes(source, time, time);
			const again = await stageNyalaRuntimeExecutable(source, stagingDir);
			const firstStillThere = await fs.readdir(stagingDir).then(entries => entries.length);

			assert.deepStrictEqual({
				firstContent,
				againContent: await fs.readFile(again, 'utf8'),
				folders: firstStillThere,
			}, {
				firstContent: 'build A',
				againContent: 'build B',
				folders: 1,
			});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('staging does not reuse a copy that was changed on disk', async () => {
		const dir = getRandomTestPath(tmpdir(), 'vsctests', 'nyalaRuntimeStagingCorrupt');
		const name = process.platform === 'win32' ? 'nyala-runtime.exe' : 'nyala-runtime';
		const source = join(dir, 'target', name);
		const stagingDir = join(dir, 'staging');
		const time = new Date(Date.UTC(2000, 0, 1));
		try {
			await fs.mkdir(join(dir, 'target'), { recursive: true });
			await fs.writeFile(source, 'build 1');
			await fs.utimes(source, time, time);
			const first = await stageNyalaRuntimeExecutable(source, stagingDir);
			// Same size, other content: the copy must not be started.
			await fs.writeFile(first, 'BUILD 1');
			const repaired = await stageNyalaRuntimeExecutable(source, stagingDir);

			assert.deepStrictEqual({
				repairedContent: await fs.readFile(repaired, 'utf8'),
				// The folder is named by the source digest, so the copy is rewritten in place.
				repairedIsFirst: repaired === first,
				folders: (await fs.readdir(stagingDir)).length,
			}, {
				repairedContent: 'build 1',
				repairedIsFirst: true,
				folders: 1,
			});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('staging follows the source execute bits on POSIX and ignores them on Windows', async function () {
		if (process.platform === 'win32') {
			this.skip(); // Windows runs a file by name, so its mode does not decide whether it runs.
		}
		const dir = getRandomTestPath(tmpdir(), 'vsctests', 'nyalaRuntimeStagingSourceMode');
		const source = join(dir, 'target', 'nyala-runtime');
		const stagingDir = join(dir, 'staging');
		const time = new Date(Date.UTC(2000, 0, 1));
		const staged = async () => {
			const path = await stageNyalaRuntimeExecutable(source, stagingDir);
			return { path, folder: dirname(path), executable: ((await fs.stat(path)).mode & 0o111) !== 0 };
		};
		try {
			await fs.mkdir(join(dir, 'target'), { recursive: true });
			await fs.writeFile(source, 'build 1');
			await fs.utimes(source, time, time);
			// Without execute bits: no POSIX execute permission to carry over.
			await fs.chmod(source, 0o644);
			const plain = await staged();
			// The same bytes and modification time, now executable: a new build, with a copy that runs.
			await fs.chmod(source, 0o755);
			const executable = await staged();
			// The same source again: the copy that runs is reused, not written again.
			const executableAgain = await staged();
			// Back to no execute bits: the executable copy must not be reused.
			await fs.chmod(source, 0o644);
			const plainAgain = await staged();

			assert.deepStrictEqual({
				plain: { executable: plain.executable, inExecutableFolder: plain.folder === executable.folder },
				executable: { distinctFolder: executable.folder !== plain.folder, executable: executable.executable },
				executableAgain: { reused: executableAgain.path === executable.path },
				plainAgain: { sameFolderAsPlain: plainAgain.folder === plain.folder, executable: plainAgain.executable },
			}, {
				plain: { executable: false, inExecutableFolder: false },
				executable: { distinctFolder: true, executable: true },
				executableAgain: { reused: true },
				plainAgain: { sameFolderAsPlain: true, executable: false },
			});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('the runtime inherits only an allowlist of environment variables', () => {
		assert.deepStrictEqual(createNyalaRuntimeEnvironment({ TEMP: 't', LANG: 'C', GITHUB_TOKEN: 'secret', PATH: 'p', NODE_OPTIONS: '--inspect' }), { TEMP: 't', LANG: 'C' });
	});
});
