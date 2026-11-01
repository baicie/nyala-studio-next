/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Native Electron smoke for the Nyala runtime supervisor (N-103, docs/adr/0004-runtime-supervisor.md).
// Launches the dev build through scripts/code.bat (scripts/code.sh elsewhere) with an isolated user
// data, extensions and logs folder and checks, from the main process log and the process table:
//
// 1. the window gets a nyala-runtime child of the Electron main process that completed the handshake,
//    running from a staged copy in the user data folder;
// 2. the binaries under rust/target can be opened for writing (as `cargo build` does) while it runs;
// 3. a runtime killed from outside is restarted as a new generation;
// 4. Reload Window replaces the runtime with a new generation and the old process exits by itself;
// 5. after the application quits, no nyala-runtime process it started is left.
//
// Requires `npm install`, `npm run compile`, a downloaded Electron (`npm run electron`) and
// `cargo build` in rust/.
//
// Usage: node --experimental-strip-types scripts/nyala/smoke-runtime.ts [--evidence <dir>] [--port <n>]

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

const root = resolve(import.meta.dirname, '..', '..');
const argv = process.argv.slice(2);
const option = (name: string, fallback: string) => {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const evidenceDir = resolve(option('evidence', join(tmpdir(), `nyala-runtime-smoke-${Date.now()}`)));
const port = Number(option('port', '9334'));
const isWindows = process.platform === 'win32';
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const RUNTIME_NAME = isWindows ? 'nyala-runtime.exe' : 'nyala-runtime';
const RUNTIME_LOG = 'nyalaRuntime.log';
const QUICK_INPUT = '.quick-input-widget .quick-input-box input';
const QUICK_INPUT_ROW = '.quick-input-widget .quick-input-list .monaco-list-row';
const ROW_LABEL = `${QUICK_INPUT_ROW} .quick-input-list-row > .monaco-icon-label .label-name`;
const FOCUSED_LABEL = `${QUICK_INPUT_ROW}.focused .quick-input-list-row > .monaco-icon-label .label-name`;
// Written by NyalaRuntimeSupervisor once runtime.hello and runtime.health succeeded.
const READY_LINE = /window (?<window>\d+) #(?<generation>\d+): ready \(pid (?<pid>\d+), build (?<build>[^,]+), protocol (?<protocol>[\d.]+)\)/;

interface IStepResult {
	readonly name: string;
	readonly result: 'PASS' | 'FAIL';
	readonly detail: string;
}

interface IReady {
	readonly generation: number;
	readonly pid: number;
	readonly build: string;
	readonly protocol: string;
}

interface IProcessEntry {
	readonly pid: number;
	readonly parentPid: number;
	readonly name: string;
	readonly path: string;
}

const results: IStepResult[] = [];

function check(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, timeout = 30_000): Promise<T> {
	const deadline = Date.now() + timeout;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await fn();
			if (value) {
				return value;
			}
		} catch (error) {
			lastError = error;
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error(`timed out waiting for ${what}${lastError ? ` (${lastError})` : ''}`);
}

async function step(name: string, fn: () => Promise<string>): Promise<boolean> {
	try {
		const detail = await fn();
		results.push({ name, result: 'PASS', detail });
		console.log(`PASS  ${name}: ${detail}`);
		return true;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		results.push({ name, result: 'FAIL', detail });
		console.log(`FAIL  ${name}: ${detail}`);
		return false;
	}
}

function findFiles(name: string, dir = join(evidenceDir, 'logs')): string[] {
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? findFiles(name, path) : entry.name === name ? [path] : [];
	});
}

function runtimeLog(): string[] {
	return findFiles(RUNTIME_LOG).flatMap(file => readFileSync(file, 'utf8').split(/\r?\n/));
}

function readyLines(): IReady[] {
	return runtimeLog().flatMap(line => {
		const groups = READY_LINE.exec(line)?.groups;
		return groups ? [{ generation: Number(groups.generation), pid: Number(groups.pid), build: groups.build, protocol: groups.protocol }] : [];
	});
}

function waitForGeneration(generation: number): Promise<IReady> {
	return until(`generation ${generation} in ${RUNTIME_LOG}`, () => readyLines().find(ready => ready.generation === generation), 60_000);
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** All processes named like the runtime, with parent and executable path. */
function runtimeProcesses(): IProcessEntry[] {
	if (isWindows) {
		const script = `@(Get-CimInstance Win32_Process -Filter "Name='${RUNTIME_NAME}'" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; name = $_.Name; path = $_.ExecutablePath } }) | ConvertTo-Json -Compress`;
		const output = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).stdout.trim();
		if (!output) {
			return [];
		}
		// Windows PowerShell 5.1 unwraps a one-element array, so a single process arrives as an object.
		const parsed: IProcessEntry | IProcessEntry[] = JSON.parse(output);
		return Array.isArray(parsed) ? parsed : [parsed];
	}
	const output = spawnSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8' }).stdout;
	return output.split('\n').map(line => line.trim().split(/\s+/)).filter(columns => columns[2] === RUNTIME_NAME)
		.map(columns => ({ pid: Number(columns[0]), parentPid: Number(columns[1]), name: columns[2], path: columns[3] }));
}

function processName(pid: number): string {
	if (isWindows) {
		return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").Name`], { encoding: 'utf8' }).stdout.trim();
	}
	return spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
}

function killFromOutside(pid: number): void {
	if (isWindows) {
		spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
	} else {
		process.kill(pid, 'SIGKILL');
	}
}

function launch(): ChildProcess {
	const electronArgs = [
		`--user-data-dir=${join(evidenceDir, 'user-data')}`,
		`--extensions-dir=${join(evidenceDir, 'extensions')}`,
		`--logsPath=${join(evidenceDir, 'logs')}`,
		`--remote-debugging-port=${port}`,
		'--disable-gpu',
		'--skip-welcome',
		'--skip-release-notes',
		'--disable-telemetry',
		'--disable-updates',
		'--disable-experiments',
		'--disable-workspace-trust',
	];
	const output = openSync(join(evidenceDir, 'launcher.log'), 'w');
	if (isWindows) {
		check(electronArgs.every(arg => !/[\s"]/.test(arg)), `cmd.exe arguments must not contain spaces or quotes: ${evidenceDir}`);
		const command = [join('scripts', 'code.bat'), ...electronArgs].join(' ');
		return spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd: root, stdio: ['ignore', output, output], windowsVerbatimArguments: true });
	}
	return spawn(join(root, 'scripts', 'code.sh'), electronArgs, { cwd: root, stdio: ['ignore', output, output], detached: true });
}

function stop(launcher: ChildProcess): void {
	if (launcher.pid === undefined || launcher.exitCode !== null) {
		return;
	}
	if (isWindows) {
		spawnSync('taskkill', ['/PID', String(launcher.pid), '/T', '/F'], { stdio: 'ignore' });
	} else {
		process.kill(-launcher.pid, 'SIGTERM');
	}
}

async function isPortOpen(): Promise<boolean> {
	try {
		await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) });
		return true;
	} catch {
		return false;
	}
}

async function connect(): Promise<{ browser: Browser; page: Page }> {
	await until(`CDP endpoint on port ${port}`, isPortOpen, 180_000);
	// A cold first start can keep the main process busy for well over Playwright's 30 s default.
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 180_000 });
	const page = await until('workbench page', async () => browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('/workbench')), 60_000);
	await page.locator('.monaco-workbench .part.statusbar').first().waitFor({ state: 'visible', timeout: 120_000 });
	return { browser, page };
}

async function runCommand(page: Page, label: string): Promise<void> {
	const input = page.locator(QUICK_INPUT);
	for (let attempt = 0; ; attempt++) {
		await page.keyboard.press(`${modifier}+Shift+P`);
		try {
			await input.waitFor({ state: 'visible', timeout: 5_000 });
			break;
		} catch (error) {
			await page.keyboard.press('Escape');
			if (attempt === 4) {
				throw error;
			}
		}
	}
	await input.fill(`>${label}`);
	await until(`quick input entry '${label}'`, async () => {
		if ((await page.locator(FOCUSED_LABEL).allTextContents())[0] === label) {
			return true;
		}
		if ((await page.locator(ROW_LABEL).allTextContents()).includes(label)) {
			await page.keyboard.press('ArrowDown');
		}
		return false;
	});
	await page.keyboard.press('Enter');
}

function waitForExit(launcher: ChildProcess, timeout: number): Promise<boolean> {
	if (launcher.exitCode !== null) {
		return Promise.resolve(true);
	}
	return new Promise(resolve => {
		const timer = setTimeout(() => resolve(false), timeout);
		launcher.once('exit', () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

async function main(): Promise<void> {
	mkdirSync(evidenceDir, { recursive: true });
	check(!(await isPortOpen()), `port ${port} is already serving CDP; refusing to drive another application`);
	const binaries = ['debug', 'release'].map(profile => join(root, 'rust', 'target', profile, RUNTIME_NAME)).filter(existsSync);
	check(binaries.length > 0, `no ${RUNTIME_NAME} under rust/target; run 'cargo build' in rust/`);
	// NyalaRuntimeMainHandler runs a copy staged here (see stageNyalaRuntimeExecutable).
	const stagingDir = join(evidenceDir, 'user-data', 'nyala-runtime-staging');
	const isOwnBinary = (path: string | undefined) => !!path && path.toLowerCase().startsWith(stagingDir.toLowerCase());
	const before = new Set(runtimeProcesses().map(entry => entry.pid));
	const seen: number[] = [];

	const launcher = launch();
	let browser: Browser | undefined;
	try {
		let page: Page;
		({ browser, page } = await connect());

		const first = await waitForGeneration(1);
		seen.push(first.pid);
		await step('runtime started and handshake completed', async () => {
			const entry = runtimeProcesses().find(entry => entry.pid === first.pid);
			check(entry, `pid ${first.pid} from ${RUNTIME_LOG} is not running`);
			const parent = processName(entry.parentPid);
			check(/nyala studio|electron/i.test(parent), `parent of pid ${first.pid} is '${parent}' (pid ${entry.parentPid}), not the Electron main process`);
			check(first.protocol === '1.0', `protocol ${first.protocol}`);
			check(isOwnBinary(entry.path), `pid ${first.pid} runs ${entry.path}, not a copy under ${stagingDir}`);
			return `generation 1, pid ${first.pid} (${entry.path}), parent '${parent}' pid ${entry.parentPid}, build ${first.build}, protocol ${first.protocol}`;
		});

		await step('rust/target binaries stay writable while the runtime runs', async () => {
			check(isRunning(first.pid), `pid ${first.pid} is not running`);
			for (const binary of binaries) {
				// Windows refuses this (EBUSY) for the image of a running process. Nothing is written.
				closeSync(openSync(binary, 'r+'));
			}
			return `opened ${binaries.join(', ')} for writing while pid ${first.pid} ran`;
		});

		await step('killed runtime is restarted as a new generation', async () => {
			killFromOutside(first.pid);
			const second = await waitForGeneration(2);
			seen.push(second.pid);
			check(second.pid !== first.pid, `generation 2 reused pid ${first.pid}`);
			await until(`pid ${first.pid} to go away`, () => !isRunning(first.pid), 10_000);
			check(isRunning(second.pid), `generation 2 pid ${second.pid} is not running`);
			const restart = runtimeLog().find(line => /restart 1 of \d+ in \d+ ms/.test(line));
			check(restart, `no restart line in ${RUNTIME_LOG}`);
			return `pid ${first.pid} killed; generation 2 pid ${second.pid}; log: '${restart.replace(/^.*\] /, '')}'`;
		});

		await step('Reload Window replaces the runtime', async () => {
			const previous = readyLines().find(ready => ready.generation === 2);
			check(previous, 'generation 2 is missing');
			await runCommand(page, 'Developer: Reload Window');
			const third = await waitForGeneration(3);
			seen.push(third.pid);
			await until(`pid ${previous.pid} to go away`, () => !isRunning(previous.pid), 10_000);
			const killed = runtimeLog().filter(line => line.includes('killing it'));
			check(killed.length === 0, `the old runtime had to be killed: ${killed.join('; ')}`);
			({ browser, page } = await reconnect(browser));
			return `generation 3 pid ${third.pid}; generation 2 pid ${previous.pid} exited after stdin was closed, no kill`;
		});

		await step('quitting leaves no runtime process', async () => {
			await runCommand(page, 'Close Window');
			const exited = await waitForExit(launcher, 60_000);
			check(exited, 'the application did not exit within 60 s');
			const leftovers = await until('runtime processes to exit', () => {
				const ours = runtimeProcesses().filter(entry => seen.includes(entry.pid) || (!before.has(entry.pid) && isOwnBinary(entry.path)));
				return ours.length === 0 ? [] as IProcessEntry[] : false;
			}, 15_000).catch(() => runtimeProcesses().filter(entry => seen.includes(entry.pid)));
			check(leftovers.length === 0, `left behind: ${JSON.stringify(leftovers)}`);
			const listing = isWindows ? spawnSync('tasklist', ['/FI', `IMAGENAME eq ${RUNTIME_NAME}`], { encoding: 'utf8' }).stdout.trim() : '';
			writeFileSync(join(evidenceDir, 'tasklist-after-exit.txt'), listing);
			const others = runtimeProcesses().filter(entry => !seen.includes(entry.pid));
			return `application exited; pids ${seen.join(', ')} gone; ${others.length} unrelated ${RUNTIME_NAME} process(es) running (${others.map(entry => `${entry.pid} ${entry.path}`).join('; ') || 'none'})`;
		});
	} finally {
		await browser?.close().catch(() => undefined);
		stop(launcher);
	}
}

/** Reload replaces the page target, so the CDP connection is re-established. */
async function reconnect(browser: Browser | undefined): Promise<{ browser: Browser; page: Page }> {
	await browser?.close().catch(() => undefined);
	return connect();
}

const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
const electronVersionFile = join(root, '.build', 'electron', 'version');
const environment = {
	commit: head,
	platform: `${process.platform} ${release()} ${process.arch}`,
	node: process.version,
	electron: existsSync(electronVersionFile) ? readFileSync(electronVersionFile, 'utf8').trim() : 'missing',
	evidence: evidenceDir,
};
console.log(JSON.stringify(environment, undefined, '\t'));

let failure: unknown;
try {
	await main();
} catch (error) {
	failure = error;
	console.log(`FAIL  launch: ${error instanceof Error ? error.message : error}`);
}

const failed = !!failure || results.length < 4 || results.some(result => result.result === 'FAIL');
writeFileSync(join(evidenceDir, 'result.json'), JSON.stringify({ ...environment, result: failed ? 'FAIL' : 'PASS', launchError: failure ? String(failure) : undefined, steps: results }, undefined, '\t'));
console.log(`${failed ? 'FAIL' : 'PASS'}  ${results.filter(result => result.result === 'PASS').length}/${results.length} steps; evidence in ${evidenceDir}`);
process.exitCode = failed ? 1 : 0;
