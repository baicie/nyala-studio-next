/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import { promises as fs } from 'fs';
import { DeferredPromise, raceTimeout } from '../../../base/common/async.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { basename, dirname, isAbsolute, join } from '../../../base/common/path.js';
import { IProcessEnvironment } from '../../../base/common/platform.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ILogger } from '../../log/common/log.js';
import { encodeNyalaFrame, NYALA_FRAME_MAX_BYTES, NYALA_PRE_HELLO_FRAME_MAX_BYTES, NyalaFrameDecoder, NyalaFrameError, NyalaRuntimeClientErrors, NyalaRuntimeError, NyalaRuntimeMessage, parseNyalaRuntimeMessage } from '../common/nyalaRuntimeProtocol.js';

//#region Executable and environment

/** Environment variable that points a development build at a specific `nyala-runtime` executable. */
export const NYALA_RUNTIME_PATH_ENV = 'NYALA_RUNTIME_PATH';

/**
 * Finds the `nyala-runtime` executable of a development build: `NYALA_RUNTIME_PATH` when it names
 * an existing file by absolute path, otherwise the newer of `rust/target/{debug,release}` under
 * `appRoot`. Built applications get `undefined`: shipping the runtime with a package is not
 * implemented yet (`docs/adr/0004-runtime-supervisor.md`).
 */
export async function findNyalaRuntimeExecutable(appRoot: string, isBuilt: boolean, env: IProcessEnvironment, platform: NodeJS.Platform): Promise<string | undefined> {
	if (isBuilt) {
		return undefined;
	}
	const override = env[NYALA_RUNTIME_PATH_ENV];
	if (override) {
		// An explicit override that does not resolve is reported as "not found" rather than
		// silently replaced by a build from rust/target.
		return isAbsolute(override) && await fileModifiedTime(override) !== undefined ? override : undefined;
	}
	const name = platform === 'win32' ? 'nyala-runtime.exe' : 'nyala-runtime';
	let newest: { readonly path: string; readonly mtimeMs: number } | undefined;
	for (const profile of ['debug', 'release']) {
		const path = join(appRoot, 'rust', 'target', profile, name);
		const mtimeMs = await fileModifiedTime(path);
		if (mtimeMs !== undefined && (!newest || mtimeMs > newest.mtimeMs)) {
			newest = { path, mtimeMs };
		}
	}
	return newest?.path;
}

async function fileModifiedTime(path: string): Promise<number | undefined> {
	try {
		const stat = await fs.stat(path);
		return stat.isFile() ? stat.mtimeMs : undefined;
	} catch {
		return undefined;
	}
}

async function fileSize(path: string): Promise<number | undefined> {
	try {
		const stat = await fs.stat(path);
		return stat.isFile() ? stat.size : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Copies a development build of the runtime into `stagingDir` and returns the path of the copy.
 * Windows does not let a running executable be removed or replaced, so running
 * `rust/target/.../nyala-runtime.exe` itself would make `cargo build` fail while a window is open.
 * Each build gets its own folder, named after its size and modification time, and is copied once.
 * Folders of other builds are removed when no process runs from them any more: a running copy
 * cannot be deleted on Windows, so its folder goes on a later call. Calls must not overlap.
 */
export async function stageNyalaRuntimeExecutable(source: string, stagingDir: string): Promise<string> {
	const stat = await fs.stat(source);
	const build = `${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}`;
	const target = join(stagingDir, build, basename(source));
	if (await fileSize(target) !== stat.size) {
		await fs.mkdir(dirname(target), { recursive: true });
		// Copy under another name and rename, so that the target is never a half-written file,
		// even after a crash during the copy.
		const partial = `${target}.${generateUuid()}.partial`;
		try {
			await fs.copyFile(source, partial);
			await fs.rename(partial, target);
		} catch (error) {
			await fs.rm(partial, { force: true });
			throw error;
		}
	}
	for (const entry of await fs.readdir(stagingDir)) {
		if (entry !== build) {
			await fs.rm(join(stagingDir, entry), { recursive: true, force: true }).catch(() => undefined);
		}
	}
	return target;
}

/**
 * Variables the runtime inherits. Everything else in the application's environment, such as
 * tokens from the user's shell, stays out of the sidecar.
 */
const INHERITED_ENVIRONMENT = ['SystemRoot', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'RUST_BACKTRACE'];

export function createNyalaRuntimeEnvironment(env: IProcessEnvironment): IProcessEnvironment {
	const result: IProcessEnvironment = {};
	for (const name of INHERITED_ENVIRONMENT) {
		const value = env[name];
		if (value !== undefined) {
			result[name] = value;
		}
	}
	return result;
}

//#endregion

//#region Process

export interface INyalaRuntimeLaunch {
	readonly executable: string;
	readonly args: readonly string[];
	readonly env: IProcessEnvironment;
}

export interface INyalaRuntimeExit {
	readonly code: number | null;
	readonly signal: string | null;
	/** Set when the process could not be spawned at all. */
	readonly spawnError?: string;
	/** Requests that were still waiting for a response. They failed with `RUNTIME_LOST`. */
	readonly lostRequests: number;
}

export interface INyalaRuntimeStopResult {
	/** `undefined` when the process did not exit even after it was killed. */
	readonly exit: INyalaRuntimeExit | undefined;
	/** Whether the process had to be killed because it ignored the closed stdin. */
	readonly killed: boolean;
}

export interface INyalaRuntimeNotification {
	readonly method: string;
	readonly params: object;
}

/** Builds the `RUNTIME_LOST` failure for requests that cannot be answered any more. */
export function nyalaRuntimeLostError(safeDetail: string): NyalaRuntimeError {
	return NyalaRuntimeError.fromKind(NyalaRuntimeClientErrors.runtimeLost, 'The Nyala runtime is not available', safeDetail);
}

/** Longest stderr line copied to the log. */
const MAX_LOG_LINE_LENGTH = 2000;

/**
 * One `nyala-runtime` child process, spawned directly without a shell. stdout carries protocol
 * frames only and is never logged. stderr is copied to the log line by line; the runtime keeps
 * payload content out of it (ADR 0002). Disposing kills the process if it still runs.
 */
export class NyalaRuntimeProcess extends Disposable {

	private readonly _onDidExit = this._register(new Emitter<INyalaRuntimeExit>());
	readonly onDidExit = this._onDidExit.event;

	private readonly _onDidNotify = this._register(new Emitter<INyalaRuntimeNotification>());
	readonly onDidNotify = this._onDidNotify.event;

	/** `undefined` when `spawn` threw; the exit is then reported asynchronously. */
	private readonly child: cp.ChildProcessWithoutNullStreams | undefined;
	private readonly decoder = new NyalaFrameDecoder(NYALA_FRAME_MAX_BYTES);
	private outgoingFrameMaxBytes = NYALA_PRE_HELLO_FRAME_MAX_BYTES;
	private readonly pending = new Map<string, DeferredPromise<object>>();
	private lastRequestId = 0;
	private stderrTail = '';
	private readonly exited = new DeferredPromise<INyalaRuntimeExit>();
	private _exit: INyalaRuntimeExit | undefined;
	private _brokenReason: string | undefined;

	constructor(
		launch: INyalaRuntimeLaunch,
		private readonly label: string,
		private readonly logger: ILogger,
	) {
		super();

		let child: cp.ChildProcessWithoutNullStreams | undefined;
		try {
			child = cp.spawn(launch.executable, launch.args, {
				cwd: dirname(launch.executable),
				env: launch.env,
				stdio: 'pipe',
				windowsHide: true,
			});
		} catch (error) {
			// Node reports only some spawn failures (ENOENT, EACCES, EAGAIN, EMFILE, ENFILE) as an
			// `error` event and throws the others, e.g. EFTYPE for a file that is not a Windows
			// executable or ENOEXEC / ETXTBSY on Linux. Both end the same way: an exit with
			// `spawnError`, reported once the owner had a chance to subscribe to onDidExit.
			const reason = typeof error?.code === 'string' ? error.code : toErrorMessage(error);
			this.logger.error(`${this.label}: could not start the runtime (${reason})`);
			queueMicrotask(() => this.finalize({ code: null, signal: null, spawnError: reason }));
		}
		this.child = child;

		if (child) {
			child.stderr.setEncoding('utf8');

			// The listeners stay attached for the life of the child object: an `error` event without
			// a listener would be thrown in the main process.
			child.stdout.on('data', (chunk: Buffer) => this.onStdout(VSBuffer.wrap(chunk)));
			child.stderr.on('data', (chunk: string) => this.onStderr(chunk));
			child.stdout.on('error', error => this.logger.warn(`${this.label}: stdout error (${error.message})`));
			child.stderr.on('error', error => this.logger.warn(`${this.label}: stderr error (${error.message})`));
			child.stdin.on('error', error => this.logger.trace(`${this.label}: stdin closed (${error.message})`));
			child.on('error', error => this.onError(error));
			child.on('close', (code, signal) => {
				this.flushStderr();
				this.finalize({ code, signal });
			});
		}

		this._register(toDisposable(() => {
			if (!this._exit) {
				this.child?.kill('SIGKILL');
				this.finalize({ code: null, signal: 'SIGKILL' });
			}
		}));
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	get exit(): INyalaRuntimeExit | undefined {
		return this._exit;
	}

	/** Why stdout stopped being a readable protocol stream, if it did. */
	get brokenReason(): string | undefined {
		return this._brokenReason;
	}

	whenExited(): Promise<INyalaRuntimeExit> {
		return this.exited.p;
	}

	/** Applies the `frameMaxBytes` that `runtime.hello` negotiated to both directions. */
	setFrameMaxBytes(frameMaxBytes: number): void {
		this.outgoingFrameMaxBytes = frameMaxBytes;
		this.decoder.maxFrameBytes = frameMaxBytes;
	}

	request(method: string, params: object): Promise<object> {
		if (!this.child || this._exit || this._brokenReason || this._store.isDisposed) {
			return Promise.reject(nyalaRuntimeLostError('the runtime process is gone'));
		}
		const id = `rq_${++this.lastRequestId}`;
		let frame: VSBuffer;
		try {
			frame = encodeNyalaFrame(VSBuffer.fromString(JSON.stringify({ jsonrpc: '2.0', id, method, params })), this.outgoingFrameMaxBytes);
		} catch (error) {
			if (error instanceof NyalaFrameError) {
				return Promise.reject(NyalaRuntimeError.fromKind(NyalaRuntimeClientErrors.resourceLimit, 'The request exceeds the negotiated frame limit', `${error.length} bytes, limit ${error.maxBytes} bytes`));
			}
			// For example params that JSON cannot represent (a cycle, a bigint). Callers get a
			// rejection like for every other failure, never a synchronous throw.
			return Promise.reject(error);
		}
		const response = new DeferredPromise<object>();
		this.pending.set(id, response);
		this.child.stdin.write(frame.buffer);
		return response.p;
	}

	/**
	 * Closes stdin, which ends the runtime's session (exit code 0), and waits up to `timeoutMs`.
	 * A process that is still running then is killed, and given `killTimeoutMs` to go away.
	 * `exit` is `undefined` only if the process outlived the kill.
	 */
	async stop(timeoutMs: number, killTimeoutMs: number): Promise<INyalaRuntimeStopResult> {
		if (!this._exit) {
			this.child?.stdin.end();
		}
		const exit = await raceTimeout(this.exited.p, timeoutMs);
		if (exit) {
			return { exit, killed: false };
		}
		this.logger.warn(`${this.label}: pid ${this.pid} did not exit within ${timeoutMs} ms after stdin was closed; killing it`);
		this.kill();
		const killed = await raceTimeout(this.exited.p, killTimeoutMs);
		if (!killed) {
			this.logger.error(`${this.label}: pid ${this.pid} did not exit within ${killTimeoutMs} ms after it was killed`);
		}
		return { exit: killed, killed: true };
	}

	kill(): void {
		if (!this._exit) {
			this.child?.kill('SIGKILL');
		}
	}

	private onStdout(chunk: VSBuffer): void {
		if (this._brokenReason || this._store.isDisposed) {
			return;
		}
		this.decoder.push(chunk);
		for (let payload = this.readFrame(); payload; payload = this.readFrame()) {
			const message = parseNyalaRuntimeMessage(payload);
			if (!message) {
				// Only the size is logged: payloads can carry SQL, paths or row data.
				this.breakStream(`a ${payload.byteLength}-byte frame is not a v1 response or notification`);
				return;
			}
			this.dispatch(message);
		}
	}

	private readFrame(): VSBuffer | undefined {
		if (this._brokenReason) {
			return undefined;
		}
		try {
			return this.decoder.next();
		} catch (error) {
			this.breakStream(error instanceof NyalaFrameError ? error.message : String(error));
			return undefined;
		}
	}

	private dispatch(message: NyalaRuntimeMessage): void {
		switch (message.type) {
			case 'notification':
				this._onDidNotify.fire({ method: message.method, params: message.params });
				return;
			case 'success':
				this.takePending(message.id)?.complete(message.result);
				return;
			case 'failure':
				if (message.id === null) {
					this.logger.warn(`${this.label}: the runtime reported ${message.error.data.kind} for a frame it could not attribute to a request`);
					return;
				}
				this.takePending(message.id)?.error(new NyalaRuntimeError(message.error));
				return;
		}
	}

	private takePending(id: string): DeferredPromise<object> | undefined {
		const response = this.pending.get(id);
		if (!response) {
			this.logger.warn(`${this.label}: ignoring a response to unknown request ${id}`);
			return undefined;
		}
		this.pending.delete(id);
		return response;
	}

	/** The byte stream cannot be resynchronized after a bad frame, so the process has to go. */
	private breakStream(reason: string): void {
		this._brokenReason = reason;
		this.logger.error(`${this.label}: stdout is no longer a protocol stream (${reason}); killing pid ${this.pid}`);
		this.kill();
	}

	private onStderr(chunk: string): void {
		const lines = (this.stderrTail + chunk).split(/\r?\n/);
		this.stderrTail = lines.pop() ?? '';
		if (this.stderrTail.length > MAX_LOG_LINE_LENGTH) {
			lines.push(this.stderrTail);
			this.stderrTail = '';
		}
		for (const line of lines) {
			this.logStderr(line);
		}
	}

	private flushStderr(): void {
		this.logStderr(this.stderrTail);
		this.stderrTail = '';
	}

	private logStderr(line: string): void {
		if (line) {
			this.logger.info(`${this.label} stderr: ${line.length > MAX_LOG_LINE_LENGTH ? `${line.slice(0, MAX_LOG_LINE_LENGTH)}...` : line}`);
		}
	}

	private onError(error: NodeJS.ErrnoException): void {
		const reason = error.code ?? error.message;
		if (this.child?.pid === undefined) {
			this.logger.error(`${this.label}: could not start the runtime (${reason})`);
			this.finalize({ code: null, signal: null, spawnError: reason });
		} else {
			this.logger.error(`${this.label}: process error (${reason})`);
		}
	}

	private finalize(exit: Omit<INyalaRuntimeExit, 'lostRequests'>): void {
		if (this._exit) {
			return;
		}
		this._exit = { ...exit, lostRequests: this.pending.size };
		const detail = exit.spawnError ? 'the runtime could not be started' : exit.signal ? `the runtime was terminated (${exit.signal})` : `the runtime exited with code ${exit.code}`;
		for (const response of this.pending.values()) {
			response.error(nyalaRuntimeLostError(detail));
		}
		this.pending.clear();
		this.exited.complete(this._exit);
		this._onDidExit.fire(this._exit);
	}
}

//#endregion
