/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout, raceTimeout } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { ILogger } from '../../log/common/log.js';
import { INyalaRuntimeHelloParams, INyalaRuntimeHelloResult, INyalaRuntimeRestartedParams, isNyalaRuntimeHealthResult, isNyalaRuntimeHelloResult, NYALA_PROTOCOL_MAJOR, NYALA_PROTOCOL_MINOR, NyalaRuntimeClientErrors, NyalaRuntimeError } from '../common/nyalaRuntimeProtocol.js';
import { INyalaRuntimeExit, INyalaRuntimeLaunch, INyalaRuntimeNotification, NyalaRuntimeProcess, nyalaRuntimeLostError } from './nyalaRuntimeProcess.js';

/** Restart and timeout parameters. The defaults are explained in `docs/adr/0004-runtime-supervisor.md`. */
export interface INyalaRuntimeSupervisorPolicy {
	/** Delay before the first restart; it doubles for each further restart in a row. */
	readonly initialRestartDelayMs: number;
	readonly maxRestartDelayMs: number;
	/** Restarts in a row after which the supervisor gives up. */
	readonly maxRestarts: number;
	/** A generation that stays ready this long resets the restart count. */
	readonly stableAfterMs: number;
	/** Time allowed for the `runtime.hello` reply, and again for the `runtime.health` reply. */
	readonly handshakeTimeoutMs: number;
	/** Time the runtime gets to exit after its stdin is closed. */
	readonly stopTimeoutMs: number;
	/** Time a killed runtime gets to go away. */
	readonly killTimeoutMs: number;
}

export const DEFAULT_NYALA_RUNTIME_SUPERVISOR_POLICY: INyalaRuntimeSupervisorPolicy = {
	initialRestartDelayMs: 500,
	maxRestartDelayMs: 10_000,
	maxRestarts: 5,
	stableAfterMs: 60_000,
	handshakeTimeoutMs: 10_000,
	stopTimeoutMs: 3_000,
	killTimeoutMs: 2_000,
};

export interface INyalaRuntimeSupervisorOptions {
	/** Prefix for log lines, e.g. `window 1`. */
	readonly label: string;
	/** `clientBuild` sent in `runtime.hello`. */
	readonly clientBuild: string;
	/**
	 * `supportedFeatures` sent in `runtime.hello`. The handshake happens once per process, so this
	 * lists every capability the client side can use. Empty until a driver client exists (N-104+).
	 */
	readonly supportedFeatures?: readonly string[];
	/** Resolved again for every generation; `undefined` when no executable is available. */
	readonly resolveLaunch: () => Promise<INyalaRuntimeLaunch | undefined>;
	readonly policy?: Partial<INyalaRuntimeSupervisorPolicy>;
}

export type NyalaRuntimeSupervisorState =
	| { readonly type: 'idle' }
	| { readonly type: 'starting'; readonly generation: number; readonly pid: number | undefined }
	| { readonly type: 'ready'; readonly generation: number; readonly pid: number | undefined; readonly runtimeBuild: string }
	/** Waiting `delayMs` before the next generation is launched. */
	| { readonly type: 'restarting'; readonly delayMs: number; readonly reason: string }
	/** No further automatic restart. {@link NyalaRuntimeSupervisor.restart} can still try again. */
	| { readonly type: 'failed'; readonly reason: string }
	| { readonly type: 'stopped' };

function describeExit(exit: INyalaRuntimeExit): string {
	if (exit.spawnError !== undefined) {
		return `could not be started (${exit.spawnError})`;
	}
	return exit.signal ? `was terminated (${exit.signal})` : `exited with code ${exit.code}`;
}

/**
 * Keeps one `nyala-runtime` process available: launches it, completes `runtime.hello` and
 * `runtime.health`, restarts it with exponential backoff when it exits unexpectedly, and stops it
 * on request. Each launched process is a new generation. Requests that were in flight when a
 * process went away fail with `RUNTIME_LOST` and are never replayed (`nyala/rpc/README.md` section 4, section 7).
 */
export class NyalaRuntimeSupervisor extends Disposable {

	private readonly _onDidChangeState = this._register(new Emitter<NyalaRuntimeSupervisorState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly _onDidRestart = this._register(new Emitter<INyalaRuntimeRestartedParams>());
	/**
	 * `runtime.restarted` for the clients of this supervisor: a new generation became ready after an
	 * earlier one had been ready. Every handle of the earlier generation is void.
	 */
	readonly onDidRestart = this._onDidRestart.event;

	private readonly _onDidNotify = this._register(new Emitter<INyalaRuntimeNotification>());
	/** Notifications sent by the current process. */
	readonly onDidNotify = this._onDidNotify.event;

	private readonly policy: INyalaRuntimeSupervisorPolicy;
	private readonly connection = this._register(new MutableDisposable<DisposableStore>());
	private readonly restartTimer = this._register(new MutableDisposable());
	private readonly stableTimer = this._register(new MutableDisposable());

	private process: NyalaRuntimeProcess | undefined;
	/** The process a stop or restart is shutting down; its exit is expected, not a crash. */
	private stoppingProcess: NyalaRuntimeProcess | undefined;
	/** Set when the current process must not be restarted, e.g. because its hello reply was not v1. */
	private fatalReason: string | undefined;
	private _state: NyalaRuntimeSupervisorState = { type: 'idle' };
	private _generation = 0;
	/** Incremented by start, restart, stop and dispose; a stale asynchronous step stops when it changes. */
	private epoch = 0;
	private restarts = 0;
	private stopped = false;
	private stopPromise: Promise<void> | undefined;
	/** Build of the last generation that became ready. Handles of that generation may exist. */
	private readyBuild: string | undefined;
	private restartReason: string | undefined;
	/** Whether a ready generation went away with requests in flight since the last `runtime.restarted`. */
	private requestsLost = false;

	constructor(
		private readonly options: INyalaRuntimeSupervisorOptions,
		private readonly logger: ILogger,
	) {
		super();
		this.policy = { ...DEFAULT_NYALA_RUNTIME_SUPERVISOR_POLICY, ...options.policy };
	}

	get state(): NyalaRuntimeSupervisorState {
		return this._state;
	}

	/** Generation of the most recently launched process; 0 before the first launch. */
	get generation(): number {
		return this._generation;
	}

	/** Launches the first generation. Resolves once it is ready or the attempt has ended. */
	async start(): Promise<void> {
		if (this.stopped || this._state.type !== 'idle') {
			return;
		}
		await this.launch(++this.epoch);
	}

	/**
	 * Replaces the current process with a new generation, for example because the window that owns
	 * the runtime reloaded and nothing holds the handles of the old generation any more. Also leaves
	 * the failed state. The restart limit does not apply to it.
	 */
	async restart(reason: string): Promise<void> {
		if (this.stopped) {
			return;
		}
		const epoch = ++this.epoch;
		this.restartTimer.clear();
		this.stableTimer.clear();
		await this.stopProcess();
		if (epoch !== this.epoch) {
			return;
		}
		this.restartReason = reason;
		this.restarts = 0;
		await this.launch(epoch);
	}

	/** Shuts the process down in order (stdin first, kill on timeout) and prevents any restart. */
	stop(): Promise<void> {
		if (!this.stopPromise) {
			this.stopPromise = this.doStop();
		}
		return this.stopPromise;
	}

	/**
	 * Sends a request to the current generation. Fails with `RUNTIME_LOST` when no generation is
	 * ready, or when the process goes away before it replies.
	 */
	request(method: string, params: object): Promise<object> {
		if (this._state.type !== 'ready' || !this.process) {
			return Promise.reject(nyalaRuntimeLostError(`the runtime is ${this._state.type}`));
		}
		return this.process.request(method, params);
	}

	override dispose(): void {
		// Disposing kills a process that still runs; owners call stop() first for an orderly exit.
		this.stopped = true;
		this.epoch++;
		super.dispose();
	}

	private async doStop(): Promise<void> {
		this.stopped = true;
		this.epoch++;
		this.restartTimer.clear();
		this.stableTimer.clear();
		await this.stopProcess();
		this.setState({ type: 'stopped' });
	}

	private async stopProcess(): Promise<void> {
		const process = this.process;
		if (!process) {
			return;
		}
		const wasReady = this._state.type === 'ready';
		this.stoppingProcess = process;
		const { exit } = await process.stop(this.policy.stopTimeoutMs, this.policy.killTimeoutMs);
		if (wasReady && exit && exit.lostRequests > 0) {
			this.requestsLost = true;
		}
		if (this.stoppingProcess === process) {
			this.stoppingProcess = undefined;
		}
		if (this.process === process) {
			this.process = undefined;
			this.connection.clear();
		}
	}

	private async launch(epoch: number): Promise<void> {
		const launch = await this.options.resolveLaunch();
		if (epoch !== this.epoch) {
			return;
		}
		if (!launch) {
			this.fail('no nyala-runtime executable was found', 'warning');
			return;
		}

		const generation = ++this._generation;
		const store = new DisposableStore();
		const process = store.add(new NyalaRuntimeProcess(launch, `${this.options.label} #${generation}`, this.logger));
		store.add(process.onDidExit(exit => this.onProcessExit(process, exit)));
		store.add(process.onDidNotify(notification => {
			if (notification.method === 'runtime.restarted') {
				// Only the supervisor can tell that a process was replaced; clients get onDidRestart.
				this.logger.warn(`${this.options.label} #${generation}: ignoring a runtime.restarted notification sent by the runtime`);
				return;
			}
			this._onDidNotify.fire(notification);
		}));
		this.connection.value = store;
		this.process = process;
		this.fatalReason = undefined;
		this.setState({ type: 'starting', generation, pid: process.pid });

		const hello = await this.handshake(process);
		if (!hello || epoch !== this.epoch || this.process !== process || process.exit) {
			return; // the exit handler, or the step that changed the epoch, decides what happens next
		}

		this.restartTimer.clear();
		const previousBuild = this.readyBuild;
		this.readyBuild = hello.runtimeBuild;
		const restarted: INyalaRuntimeRestartedParams | undefined = previousBuild === undefined ? undefined : {
			reason: this.restartReason ?? 'unexpected-exit',
			pendingExecutions: this.requestsLost ? 'unknown' : 'none',
			previousBuild,
		};
		this.restartReason = undefined;
		this.requestsLost = false;
		this.logger.info(`${this.options.label} #${generation}: ready (pid ${process.pid}, build ${hello.runtimeBuild}, protocol ${hello.protocolMajor}.${hello.protocolMinor})`);
		this.setState({ type: 'ready', generation, pid: process.pid, runtimeBuild: hello.runtimeBuild });
		this.stableTimer.value = disposableTimeout(() => {
			this.restarts = 0;
		}, this.policy.stableAfterMs);
		if (restarted) {
			this._onDidRestart.fire(restarted);
		}
	}

	/** Runs `runtime.hello` and `runtime.health`. Returns the hello result once both succeeded. */
	private async handshake(process: NyalaRuntimeProcess): Promise<INyalaRuntimeHelloResult | undefined> {
		const params: INyalaRuntimeHelloParams = {
			protocolMajor: NYALA_PROTOCOL_MAJOR,
			protocolMinor: NYALA_PROTOCOL_MINOR,
			clientBuild: this.options.clientBuild,
			supportedFeatures: this.options.supportedFeatures ?? [],
		};
		try {
			const hello = await this.handshakeCall(process, 'runtime.hello', params);
			if (!hello) {
				return undefined;
			}
			if (!isNyalaRuntimeHelloResult(hello) || hello.protocolMajor !== NYALA_PROTOCOL_MAJOR) {
				this.abandon(process, 'the runtime.hello reply is not a protocol 1 result');
				return undefined;
			}
			process.setFrameMaxBytes(hello.limits.frameMaxBytes);

			const health = await this.handshakeCall(process, 'runtime.health', {});
			if (!health) {
				return undefined;
			}
			if (!isNyalaRuntimeHealthResult(health)) {
				this.abandon(process, 'the runtime.health reply is not a protocol 1 result');
				return undefined;
			}
			if (health.status !== 'ok') {
				this.logger.warn(`${this.options.label}: runtime.health reported '${health.status}'`);
			}
			return hello;
		} catch (error) {
			// RUNTIME_LOST: the process went away and the exit handler decides about a restart. Any
			// other error kind (PROTOCOL_MISMATCH, INVALID_PARAMS, ...) would repeat with the same build.
			if (error instanceof NyalaRuntimeError && error.kind !== NyalaRuntimeClientErrors.runtimeLost.kind) {
				this.abandon(process, `the runtime rejected the handshake with ${error.kind}`);
			}
			return undefined;
		}
	}

	/** Sends one handshake request. A reply that does not arrive in time kills the process, which then counts as a crash. */
	private async handshakeCall(process: NyalaRuntimeProcess, method: string, params: object): Promise<object | undefined> {
		const result = await raceTimeout(process.request(method, params), this.policy.handshakeTimeoutMs);
		if (!result && !process.exit) {
			this.logger.warn(`${this.options.label}: no ${method} reply within ${this.policy.handshakeTimeoutMs} ms; killing pid ${process.pid}`);
			process.kill();
		}
		return result;
	}

	/** Ends the current process without a restart. */
	private abandon(process: NyalaRuntimeProcess, reason: string): void {
		if (this.process !== process) {
			return;
		}
		this.fatalReason = reason;
		if (process.exit) {
			// The exit handler ran first; it may have scheduled a restart, or failed already.
			if (this._state.type !== 'failed') {
				this.fail(reason);
			}
		} else {
			process.kill();
		}
	}

	private onProcessExit(process: NyalaRuntimeProcess, exit: INyalaRuntimeExit): void {
		if (process !== this.process || process === this.stoppingProcess || this.stopped) {
			return;
		}
		this.stableTimer.clear();
		if (this._state.type === 'ready' && exit.lostRequests > 0) {
			this.requestsLost = true;
		}
		const what = `the runtime ${describeExit(exit)}`;
		if (this.fatalReason) {
			this.fail(`${this.fatalReason}; ${what}`);
			return;
		}
		if (exit.spawnError !== undefined) {
			this.fail(what);
			return;
		}
		if (exit.code === 2) {
			// Exit code 2 is PROTOCOL_MISMATCH (README section 3): the same build would be rejected again.
			this.fail(`${what} (protocol mismatch); not restarting the same build`);
			return;
		}
		if (this.restarts >= this.policy.maxRestarts) {
			this.fail(`${what}; giving up after ${this.restarts} restarts in a row`);
			return;
		}

		const delayMs = Math.min(this.policy.initialRestartDelayMs * 2 ** this.restarts, this.policy.maxRestartDelayMs);
		this.restarts++;
		this.restartReason = process.brokenReason ? 'stream-error' : 'unexpected-exit';
		this.logger.warn(`${this.options.label}: ${what}${exit.lostRequests ? `, ${exit.lostRequests} request(s) failed with RUNTIME_LOST` : ''}; restart ${this.restarts} of ${this.policy.maxRestarts} in ${delayMs} ms`);
		this.setState({ type: 'restarting', delayMs, reason: what });
		const epoch = this.epoch;
		this.restartTimer.value = disposableTimeout(() => {
			this.launch(epoch).catch(error => this.logger.error(`${this.options.label}: restart failed`, error));
		}, delayMs);
	}

	private fail(reason: string, severity: 'warning' | 'error' = 'error'): void {
		this.restartTimer.clear();
		this.stableTimer.clear();
		if (severity === 'warning') {
			this.logger.warn(`${this.options.label}: ${reason}`);
		} else {
			this.logger.error(`${this.options.label}: ${reason}`);
		}
		this.setState({ type: 'failed', reason });
	}

	private setState(state: NyalaRuntimeSupervisorState): void {
		this._state = state;
		this._onDidChangeState.fire(state);
	}
}

/**
 * One supervisor per window. Sessions of the v1 runtime carry no window or client ownership
 * (`docs/nyala-kickoff/docs/14-storage.md`), so windows never share a process
 * (`docs/adr/0004-runtime-supervisor.md`).
 */
export class NyalaRuntimeWindowSupervisors extends Disposable {

	private readonly supervisors = this._register(new DisposableMap<number, NyalaRuntimeSupervisor>());
	/** Supervisors of closed windows whose process is still shutting down. */
	private readonly closing = this._register(new DisposableStore());
	private readonly pendingStops = new Set<Promise<void>>();
	private shuttingDown = false;

	constructor(
		private readonly createSupervisor: (windowId: number) => NyalaRuntimeSupervisor,
		private readonly logger: ILogger,
	) {
		super();
	}

	get(windowId: number): NyalaRuntimeSupervisor | undefined {
		return this.supervisors.get(windowId);
	}

	/**
	 * A window starts loading. Its first load starts its runtime. A later load (reload, or another
	 * workspace) replaces the runtime with a new generation, because the renderer that held the
	 * handles of the old one is gone.
	 */
	windowWillLoad(windowId: number, restartReason: string): void {
		if (this.shuttingDown || this._store.isDisposed) {
			return;
		}
		const existing = this.supervisors.get(windowId);
		if (existing) {
			this.track(windowId, existing.restart(restartReason));
			return;
		}
		const supervisor = this.createSupervisor(windowId);
		this.supervisors.set(windowId, supervisor);
		this.track(windowId, supervisor.start());
	}

	/** A window closed: stop its runtime in order and drop the supervisor. */
	windowDidClose(windowId: number): void {
		const supervisor = this.supervisors.deleteAndLeak(windowId);
		if (!supervisor) {
			return;
		}
		this.closing.add(supervisor);
		const stopped: Promise<void> = supervisor.stop()
			.catch(error => this.logger.error(`window ${windowId}: stopping the runtime failed`, error))
			.finally(() => {
				this.pendingStops.delete(stopped);
				this.closing.delete(supervisor);
			});
		this.pendingStops.add(stopped);
	}

	/** Stops every runtime, including those of windows that are still closing. */
	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		for (const windowId of [...this.supervisors.keys()]) {
			this.windowDidClose(windowId);
		}
		await Promise.allSettled([...this.pendingStops]);
	}

	private track(windowId: number, operation: Promise<void>): void {
		operation.catch(error => this.logger.error(`window ${windowId}: runtime operation failed`, error));
	}
}
