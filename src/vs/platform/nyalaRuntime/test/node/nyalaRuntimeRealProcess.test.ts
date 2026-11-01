/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { FileAccess } from '../../../../base/common/network.js';
import { dirname, join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { INyalaRuntimeRestartedParams, isNyalaRuntimeHealthResult, NyalaRuntimeError } from '../../common/nyalaRuntimeProtocol.js';
import { createNyalaRuntimeEnvironment, findNyalaRuntimeExecutable, INyalaRuntimeLaunch, NyalaRuntimeProcess } from '../../node/nyalaRuntimeProcess.js';
import { NyalaRuntimeSupervisor } from '../../node/nyalaRuntimeSupervisor.js';
import { isRunning, readyPid, TestRuntimeLogger, untilState } from './nyalaRuntimeTestUtils.js';

/** Repository root; the tests run from `out/`. */
const REPO_ROOT = dirname(FileAccess.asFileUri('').fsPath);

/**
 * When set to `1`, a missing `nyala-runtime` build fails the suite instead of skipping it. CI sets
 * it after `cargo build`, so that the suite cannot pass by being skipped.
 */
const REQUIRED_ENV = 'NYALA_RUNTIME_REQUIRED';

async function crateVersion(): Promise<string> {
	const manifest = await fs.readFile(join(REPO_ROOT, 'rust', 'crates', 'nyala-runtime', 'Cargo.toml'), 'utf8');
	const version = /^version\s*=\s*"(?<version>[^"]+)"/m.exec(manifest)?.groups?.version;
	assert.ok(version, 'no version in rust/crates/nyala-runtime/Cargo.toml');
	return version;
}

// Runs the supervisor against the `nyala-runtime` binary that `cargo build` produced
// (`rust/target/{debug,release}`, or `NYALA_RUNTIME_PATH`).
suite('Nyala runtime supervisor with the real runtime', function () {

	this.timeout(60_000);

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let launch: INyalaRuntimeLaunch;
	let version: string;
	let logger: TestRuntimeLogger;

	suiteSetup(async function () {
		const executable = await findNyalaRuntimeExecutable(REPO_ROOT, false, process.env, process.platform);
		if (!executable) {
			if (process.env[REQUIRED_ENV] === '1') {
				throw new Error(`no nyala-runtime build under rust/target and ${REQUIRED_ENV}=1; run 'cargo build' in rust/`);
			}
			this.skip();
		}
		launch = { executable, args: [], env: createNyalaRuntimeEnvironment(process.env) };
		version = await crateVersion();
	});

	setup(() => {
		logger = store.add(new TestRuntimeLogger());
	});

	function createSupervisor(): NyalaRuntimeSupervisor {
		return store.add(new NyalaRuntimeSupervisor({
			label: 'real',
			clientBuild: '0.0.1-test',
			resolveLaunch: async () => launch,
			policy: { initialRestartDelayMs: 20, maxRestartDelayMs: 40, maxRestarts: 2 },
		}, logger));
	}

	test('hello and health succeed, and stop ends the process with exit code 0', async () => {
		const supervisor = createSupervisor();
		await supervisor.start();
		const ready = supervisor.state;
		const pid = readyPid(supervisor);
		const health = await supervisor.request('runtime.health', {});

		await supervisor.stop();

		assert.deepStrictEqual({
			ready: ready.type === 'ready' ? { generation: ready.generation, runtimeBuild: ready.runtimeBuild } : ready,
			health: isNyalaRuntimeHealthResult(health) ? health.status : health,
			state: supervisor.state.type,
			running: isRunning(pid),
			killed: logger.lines.filter(line => line.includes('killing it')),
			stderr: logger.lines.some(line => line.includes(`stderr: nyala-runtime: ${version} serving protocol 1.0`)),
		}, {
			ready: { generation: 1, runtimeBuild: version },
			health: 'ok',
			state: 'stopped',
			running: false,
			killed: [],
			stderr: true,
		});
	});

	test('a killed runtime is restarted as a new generation and announced with runtime.restarted', async () => {
		const supervisor = createSupervisor();
		const restarts: INyalaRuntimeRestartedParams[] = [];
		store.add(supervisor.onDidRestart(params => restarts.push(params)));
		await supervisor.start();
		const firstPid = readyPid(supervisor);

		process.kill(firstPid!, 'SIGKILL');
		const ready = await untilState(supervisor, state => state.type === 'ready' && state.generation === 2, 'generation 2');
		const secondPid = readyPid(supervisor);
		const health = await supervisor.request('runtime.health', {});
		await supervisor.stop();

		assert.deepStrictEqual({
			generation: ready.type === 'ready' ? ready.generation : undefined,
			newProcess: secondPid !== undefined && secondPid !== firstPid,
			health: isNyalaRuntimeHealthResult(health) ? health.status : health,
			restarts,
			running: [isRunning(firstPid), isRunning(secondPid)],
		}, {
			generation: 2,
			newProcess: true,
			health: 'ok',
			restarts: [{ reason: 'unexpected-exit', pendingExecutions: 'none', previousBuild: version }],
			running: [false, false],
		});
	});

	test('a hello with another protocol major is rejected and the runtime exits with code 2', async () => {
		const runtimeProcess = store.add(new NyalaRuntimeProcess(launch, 'real', logger));
		const hello = await runtimeProcess.request('runtime.hello', { protocolMajor: 2, protocolMinor: 0, clientBuild: '0.0.1-test', supportedFeatures: [] }).then(
			() => 'fulfilled',
			error => error instanceof NyalaRuntimeError ? error.kind : String(error),
		);
		const exit = await runtimeProcess.whenExited();

		assert.deepStrictEqual({ hello, code: exit.code, lostRequests: exit.lostRequests }, { hello: 'PROTOCOL_MISMATCH', code: 2, lostRequests: 0 });
	});
});
