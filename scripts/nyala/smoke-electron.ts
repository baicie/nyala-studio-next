/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Native Electron smoke for the Nyala P0 bootstrap. Launches the dev build through
// scripts/code.bat (scripts/code.sh elsewhere) with an isolated user data, extensions
// and logs folder, drives the window over a local CDP port and checks the P0 entry
// points, including repeated Reload Window. Requires `npm install`, `npm run compile`
// and a downloaded Electron (`npm run electron`).
//
// Usage: node --experimental-strip-types scripts/nyala/smoke-electron.ts [--evidence <dir>] [--reloads <n>] [--port <n>]

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

const root = resolve(import.meta.dirname, '..', '..');
const argv = process.argv.slice(2);
const option = (name: string, fallback: string) => {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const evidenceDir = resolve(option('evidence', join(tmpdir(), `nyala-electron-smoke-${Date.now()}`)));
const reloads = Number(option('reloads', '2'));
const port = Number(option('port', '9333'));
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

const READY_MESSAGE = 'Nyala Studio Workbench is ready.';
const PLACEHOLDER = 'Nyala connections will appear here.';
const HELLO = 'Nyala: Hello Workbench';
const MARKDOWN_HEADING = 'Nyala native smoke';
const WEBVIEW_IMAGE = ['resources', 'win32', 'code_150x150.png'];
const STATUS_ITEM = '.part.statusbar [id="workbench.contrib.nyalaStatus"]';
const ACTIVITY_ITEM = '.part.activitybar .action-item a.action-label[aria-label^="Nyala Connections"]';
const QUICK_INPUT = '.quick-input-widget .quick-input-box input';
const QUICK_INPUT_ROW = '.quick-input-widget .quick-input-list .monaco-list-row';
const ROW_LABEL = `${QUICK_INPUT_ROW} .quick-input-list-row > .monaco-icon-label .label-name`;
const FOCUSED_LABEL = `${QUICK_INPUT_ROW}.focused .quick-input-list-row > .monaco-icon-label .label-name`;
const TOAST_MESSAGE = '.notifications-toasts .notification-list-item-message';

interface IStepResult {
	readonly name: string;
	readonly result: 'PASS' | 'FAIL';
	readonly detail: string;
}

const results: IStepResult[] = [];
let page: Page | undefined;

function check(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, timeout = 30_000): Promise<T> {
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

async function step(name: string, fn: (page: Page) => Promise<string>): Promise<void> {
	check(page, 'workbench page is not connected');
	try {
		const detail = await fn(page);
		results.push({ name, result: 'PASS', detail });
		console.log(`PASS  ${name}: ${detail}`);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		results.push({ name, result: 'FAIL', detail });
		console.log(`FAIL  ${name}: ${detail}`);
		await page.keyboard.press('Escape').catch(() => undefined);
	}
	const file = `${String(results.length).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
	await page.screenshot({ path: join(evidenceDir, 'screenshots', file) }).catch(() => undefined);
}

function texts(page: Page, selector: string): Promise<string[]> {
	return page.locator(selector).allTextContents();
}

async function openQuickInput(page: Page, value: string): Promise<void> {
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
	await input.fill(value);
}

/** Focuses the quick input row whose label is exactly `label` and accepts it. */
async function pick(page: Page, label: string): Promise<void> {
	await until(`quick input entry '${label}'`, async () => {
		if ((await texts(page, FOCUSED_LABEL))[0] === label) {
			return true;
		}
		if ((await texts(page, ROW_LABEL)).includes(label)) {
			await page.keyboard.press('ArrowDown');
		}
		return false;
	});
	await page.keyboard.press('Enter');
}

async function runCommand(page: Page, label: string): Promise<void> {
	await openQuickInput(page, `>${label}`);
	await pick(page, label);
}

async function paletteMatches(page: Page, label: string): Promise<number> {
	await openQuickInput(page, `>${label}`);
	const count = await until(`palette entries for '${label}'`, async () => (await texts(page, ROW_LABEL)).filter(text => text === label).length);
	await page.keyboard.press('Escape');
	return count;
}

async function showHello(page: Page): Promise<number> {
	await runCommand(page, 'Notifications: Clear All Notifications');
	await until('notifications to clear', async () => (await texts(page, TOAST_MESSAGE)).length === 0, 10_000);
	await runCommand(page, HELLO);
	return until(`'${READY_MESSAGE}' toast`, async () => (await texts(page, TOAST_MESSAGE)).filter(text => text.includes(READY_MESSAGE)).length);
}

function findLogs(name: string, dir = join(evidenceDir, 'logs')): string[] {
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? findLogs(name, path) : entry.name === name ? [path] : [];
	});
}

function logLines(name: string, pattern: RegExp): string[] {
	return findLogs(name).flatMap(file => readFileSync(file, 'utf8').split(/\r?\n/)).filter(line => pattern.test(line));
}

async function isPortOpen(): Promise<boolean> {
	try {
		await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) });
		return true;
	} catch {
		return false;
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
	if (process.platform === 'win32') {
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
	if (process.platform === 'win32') {
		spawnSync('taskkill', ['/PID', String(launcher.pid), '/T', '/F'], { stdio: 'ignore' });
	} else {
		process.kill(-launcher.pid, 'SIGTERM');
	}
}

async function connect(): Promise<{ browser: Browser; page: Page }> {
	await until(`CDP endpoint on port ${port}`, isPortOpen, 180_000);
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	const page = await until('workbench page', async () => browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('/workbench')), 60_000);
	return { browser, page };
}

async function whenRestored(page: Page): Promise<void> {
	await page.locator('.monaco-workbench .part.statusbar').first().waitFor({ state: 'visible', timeout: 120_000 });
	await page.locator(STATUS_ITEM).first().waitFor({ state: 'visible', timeout: 60_000 });
}

/** Reloads through the Command Palette and waits until a new document has restored. */
async function reloadWindow(page: Page): Promise<void> {
	await page.evaluate(() => { (globalThis as Record<string, unknown>).nyalaSmokeReloadMarker = true; });
	await runCommand(page, 'Developer: Reload Window');
	await until('the window to reload', async () => !(await page.evaluate(() => (globalThis as Record<string, unknown>).nyalaSmokeReloadMarker)), 60_000);
	await whenRestored(page);
}

async function connectionsView(page: Page): Promise<string> {
	await runCommand(page, 'View: Show Nyala Connections');
	const placeholders = await until('the Connections placeholder', async () => {
		const found = await texts(page, '.nyala-connections-placeholder');
		return found.length ? found : undefined;
	});
	check(placeholders.length === 1 && placeholders[0] === PLACEHOLDER, `placeholders: ${JSON.stringify(placeholders)}`);
	const activityItems = await page.locator(ACTIVITY_ITEM).count();
	check(activityItems === 1, `activity bar entries: ${activityItems}`);
	return `placeholder '${PLACEHOLDER}', 1 activity bar entry`;
}

async function singleRegistration(page: Page): Promise<string> {
	const statusItems = await texts(page, STATUS_ITEM);
	check(statusItems.length === 1 && statusItems[0].trim() === 'Nyala', `status entries: ${JSON.stringify(statusItems)}`);
	const activityItems = await page.locator(ACTIVITY_ITEM).count();
	check(activityItems === 1, `activity bar entries: ${activityItems}`);
	const palette = await paletteMatches(page, HELLO);
	check(palette === 1, `palette entries: ${palette}`);
	return '1 status entry, 1 activity bar entry, 1 palette entry';
}

async function main(): Promise<void> {
	mkdirSync(join(evidenceDir, 'screenshots'), { recursive: true });
	check(!(await isPortOpen()), `port ${port} is already serving CDP; refusing to drive another application`);

	const launcher = launch();
	let browser: Browser | undefined;
	try {
		({ browser, page } = await connect());
		await whenRestored(page);

		await step('window title', async page => {
			const title = await page.title();
			check(title.includes('Nyala Studio'), `document.title is '${title}'`);
			return `'${title}'`;
		});
		await step('status bar entry', async page => {
			const item = await texts(page, STATUS_ITEM);
			check(item.length === 1 && item[0].trim() === 'Nyala', `status entries: ${JSON.stringify(item)}`);
			const ariaLabel = await page.locator(`${STATUS_ITEM} a`).first().getAttribute('aria-label');
			return `1 entry, text 'Nyala', aria-label '${ariaLabel}'`;
		});
		await step('Nyala: Hello Workbench (run twice)', async page => {
			const palette = await paletteMatches(page, HELLO);
			check(palette === 1, `palette entries: ${palette}`);
			const first = await showHello(page);
			const second = await showHello(page);
			return `palette entry 1; toast '${READY_MESSAGE}' after run 1 (${first}) and run 2 (${second})`;
		});
		await step('Nyala Connections view', connectionsView);
		await step('empty workspace text editing', async page => {
			const folders = await page.locator('.explorer-folders-view .monaco-list-row').count();
			await runCommand(page, 'File: New Untitled Text File');
			await runCommand(page, 'Change Language Mode');
			// The language list is virtualized, so filter it before picking.
			await page.locator(QUICK_INPUT).waitFor({ state: 'visible', timeout: 10_000 });
			await page.locator(QUICK_INPUT).fill('Markdown');
			await pick(page, 'Markdown');
			await page.locator('.part.editor .monaco-editor.focused').first().waitFor({ state: 'visible', timeout: 10_000 });
			await page.keyboard.type(`# ${MARKDOWN_HEADING}`);
			await page.keyboard.press('Enter');
			await page.keyboard.press('Enter');
			await page.keyboard.type('Edited in the native Electron window.');
			const content = await until('typed text in the editor', async () => {
				const lines = (await page.locator('.part.editor .monaco-editor.focused .view-lines').first().innerText()).replace(/\u00a0/g, ' ');
				return lines.includes(MARKDOWN_HEADING) && lines.includes('Edited in the native Electron window.') ? lines : undefined;
			});
			return `no folder open (${folders} explorer rows); untitled Markdown editor holds ${content.split('\n').filter(Boolean).length} typed lines`;
		});
		await step('Split Editor', async page => {
			await runCommand(page, 'View: Split Editor');
			const groups = await until('two editor groups', async () => (await page.locator('.part.editor .editor-group-container').count()) === 2 ? 2 : undefined);
			return `${groups} editor groups`;
		});
		await step('minimal Webview (image preview)', async page => {
			// The built-in image preview is a custom editor webview that needs no language server.
			await openQuickInput(page, join(root, ...WEBVIEW_IMAGE));
			await pick(page, WEBVIEW_IMAGE[WEBVIEW_IMAGE.length - 1]);
			await page.locator('iframe.webview.ready').first().waitFor({ state: 'attached', timeout: 60_000 });
			const size = await until('the image rendered in a webview frame', async () => {
				for (const frame of page.frames()) {
					const loaded = await frame.evaluate(() => {
						const image = document.querySelector('img');
						return document.body?.classList.contains('ready') && image ? `${image.naturalWidth}x${image.naturalHeight}` : undefined;
					}).catch(() => undefined);
					if (loaded) {
						return loaded;
					}
				}
				return undefined;
			}, 60_000);
			return `iframe.webview.ready attached; ${WEBVIEW_IMAGE.join('/')} rendered at ${size}`;
		});
		await step('Extension Host activation', async () => {
			const started = await until('local extension host start', async () => logLines('renderer.log', /Started local extension host with pid/)[0], 30_000);
			const markdown = await until('markdown extension activation attempt', async () => logLines('exthost.log', /_doActivateExtension vscode\.markdown-language-features/)[0], 30_000);
			const activations = logLines('exthost.log', /_doActivateExtension /).length;
			return `${started.replace(/^.*\] /, '')}; ${markdown.replace(/^.*_doActivateExtension /, '')}; ${activations} activations logged`;
		});
		await step('built-in extensions activate without errors', async () => {
			const failures = [...new Set(logLines('exthost.log', /Activating extension \S+ failed due to an error/).map(line => line.replace(/^.*Activating extension (\S+) failed.*$/, '$1')))];
			const reasons = [...new Set(logLines('exthost.log', /\[error\] Error: /).map(line => line.replace(/^.*\[error\] /, '')))];
			check(failures.length === 0, `failed: ${failures.join(', ')}; ${reasons.join('; ')}`);
			return '0 failed activations';
		});

		for (let i = 1; i <= reloads; i++) {
			await step(`Reload Window ${i}`, async page => {
				await reloadWindow(page);
				const registrations = await singleRegistration(page);
				const toasts = await showHello(page);
				const view = await connectionsView(page);
				return `reloaded; ${registrations}; Hello toast ${toasts}; ${view}`;
			});
		}

		await step('renderer log has no Nyala errors', async () => {
			const errors = logLines('renderer.log', /\[error\].*nyala|nyala.*\[error\]|Unable to create workbench contribution 'workbench\.contrib\.nyala|multiple contributions with same id 'workbench\.contrib\.nyala/i);
			check(errors.length === 0, errors.slice(0, 5).join('\n'));
			return `${findLogs('renderer.log').length} renderer.log file(s) scanned, 0 Nyala errors`;
		});
	} finally {
		await browser?.close().catch(() => undefined);
		stop(launcher);
	}
}

const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
const npmVersion = spawnSync('npm', ['--version'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' }).stdout.trim();
const electronVersionFile = join(root, '.build', 'electron', 'version');
const environment = {
	commit: head,
	platform: `${process.platform} ${release()} ${process.arch}`,
	node: process.version,
	npm: npmVersion,
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

const failed = !!failure || results.length === 0 || results.some(result => result.result === 'FAIL');
writeFileSync(join(evidenceDir, 'result.json'), JSON.stringify({ ...environment, result: failed ? 'FAIL' : 'PASS', launchError: failure ? String(failure) : undefined, steps: results }, undefined, '\t'));
console.log(`${failed ? 'FAIL' : 'PASS'}  ${results.filter(result => result.result === 'PASS').length}/${results.length} steps; evidence in ${evidenceDir}`);
process.exitCode = failed ? 1 : 0;
