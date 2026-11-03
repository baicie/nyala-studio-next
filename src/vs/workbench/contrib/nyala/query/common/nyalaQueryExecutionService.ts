/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Owns every execution a query tab starts (N-203). It is the only place that decides what a run
// may target, and the only place that owns its results.
//
// The rules it implements are in ADR 0008:
//
//   - the target is frozen into a snapshot before the first await; the context is never consulted
//     again for that run, so switching tabs or rebinding cannot retarget it;
//   - `canExecute()` is the gate, never `binding !== undefined`;
//   - one non-terminal run per query id, but a finished run keeps its results until they are
//     released, evicted, expired, or the runtime generation goes away;
//   - cancel / getState are addressed by executionId, and a cancel reply carries no sequence, so it
//     never rewrites the authoritative state;
//   - an error answer that provably never left the Main process is a failure; anything else that
//     leaves the outcome unproven is `unknown`.

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import {
	INyalaQueryStateChangedEvent,
	INyalaRuntimeState,
	NyalaRuntimeCommand,
} from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeIpc.js';
import { INyalaResultFetchPageResult, INyalaRuntimeErrorObject } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeContract.generated.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { INyalaConnectionService, INyalaRuntimeBridge } from '../../connections/common/nyalaConnectionService.js';
import { INyalaQueryContextService } from './nyalaQueryContext.js';
import {
	applyCalibration,
	applyCancelReply,
	applyStateChange,
	holdsMutex,
	INyalaExecutionRecord,
	INyalaExecutionSnapshot,
	isTerminalState,
	markNotSent,
	markUnknown,
	NyalaExecutionState,
	NyalaUnknownReason,
} from './nyalaQueryExecution.js';

/** One page as the execution service hands it to N-204. */
export type INyalaResultPage = INyalaResultFetchPageResult;

/**
 * A consumer's claim on one result. `release` is local and idempotent: the underlying
 * `result.release` is sent at most once, when the last lease goes away.
 */
export interface INyalaResultLease extends IDisposable {
	readonly resultId: string;
	readonly executionId: string;
	readonly runtimeGeneration: number;
}

export type NyalaExecutionStartResult =
	| { readonly ok: true; readonly record: INyalaExecutionRecord }
	| { readonly ok: false; readonly message: string };

export const INyalaQueryExecutionService = createDecorator<INyalaQueryExecutionService>('nyalaQueryExecutionService');

export interface INyalaQueryExecutionService {
	readonly _serviceBrand: undefined;
	/** Fires whenever a run's state, results or error changes. */
	readonly onDidChangeExecution: Event<INyalaExecutionRecord>;
	/** Starts one run. Rejects synchronously (as a value) when the tab cannot run. */
	execute(queryId: string, sql: string, mode: 'statement' | 'selection' | 'script'): Promise<NyalaExecutionStartResult>;
	/** The newest run of a query, finished or not. */
	getExecution(queryId: string): INyalaExecutionRecord | undefined;
	getExecutionById(executionId: string): INyalaExecutionRecord | undefined;
	/** Claims one result for a consumer; `undefined` when it is not (or no longer) available. */
	acquireResult(executionId: string, resultId: string): INyalaResultLease | undefined;
	fetchPage(lease: INyalaResultLease, cursor: string | null, limit?: number): Promise<INyalaResultPage>;
	/** Asks a run to stop. The reply is a request outcome, never proof that it stopped. */
	cancel(executionId: string): Promise<void>;
	readonly executions: readonly INyalaExecutionRecord[];
}

/** Default timeout for one execution; the runtime clamps the upper bound at 10 minutes. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Rows the runtime may buffer before the first page is read. */
const MAX_INITIAL_ROWS = 200;
/** Page size N-204 asks for by default; the contract caps it at 1000. */
const DEFAULT_PAGE_LIMIT = 200;
/**
 * Result handles this window keeps open. The runtime counts open executions and unreleased
 * results against `maxConcurrentExecutions` (4 by default), so three leaves room for a new run.
 */
const MAX_RESULTS_PER_WINDOW = 3;
const MAX_RESULTS_PER_EXECUTION = 3;

interface IResultEntry {
	readonly resultId: string;
	readonly executionId: string;
	readonly runtimeGeneration: number;
	readonly createdAt: number;
	references: number;
	released: boolean;
	releaseSent: boolean;
	inFlight: boolean;
}

interface ILease extends INyalaResultLease {
	readonly entry: IResultEntry;
}

export class NyalaQueryExecutionService extends Disposable implements INyalaQueryExecutionService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeExecution = this._register(new Emitter<INyalaExecutionRecord>());
	readonly onDidChangeExecution: Event<INyalaExecutionRecord> = this._onDidChangeExecution.event;

	private readonly byQuery = new Map<string, INyalaExecutionRecord>();
	private readonly byExecution = new Map<string, INyalaExecutionRecord>();
	private readonly results = new Map<string, IResultEntry>();
	private readonly calibrating = new Set<string>();
	private nextRequest = 0;
	private lastSeenGeneration: number;

	constructor(
		@INyalaRuntimeBridge private readonly bridge: INyalaRuntimeBridge,
		@INyalaQueryContextService private readonly contextService: INyalaQueryContextService,
		@INyalaConnectionService private readonly connectionService: INyalaConnectionService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.lastSeenGeneration = this.connectionService.runtimeState.generation;
		this._register(this.bridge.onDidChangeQueryState(event => this.onQueryState(event)));
		this._register(this.connectionService.onDidChangeRuntime(state => this.onRuntimeState(state)));
		this._register(this.contextService.onDidRelease(queryId => this.onQueryReleased(queryId)));
	}

	get executions(): readonly INyalaExecutionRecord[] {
		return [...this.byQuery.values()];
	}

	getExecution(queryId: string): INyalaExecutionRecord | undefined {
		return this.byQuery.get(queryId);
	}

	getExecutionById(executionId: string): INyalaExecutionRecord | undefined {
		return this.byExecution.get(executionId);
	}

	async execute(queryId: string, sql: string, mode: 'statement' | 'selection' | 'script'): Promise<NyalaExecutionStartResult> {
		// Everything up to the first await is the snapshot: the context may change while the runtime
		// opens the run, but this execution must keep the target it saw here.
		const context = this.contextService.get(queryId);
		if (!context) {
			return { ok: false, message: localize('nyala.query.execute.closed', 'This query tab is no longer open.') };
		}
		const runtime = this.contextService.runtimeState;
		if (context.bindingState === 'switching') {
			return { ok: false, message: localize('nyala.query.execute.switching', 'This query is switching connections. Wait for the switch to finish.') };
		}
		if (!context.canExecute(runtime)) {
			return { ok: false, message: localize('nyala.query.execute.unbound', 'This query has no current connection. Choose a connection before running it.') };
		}
		const binding = context.binding;
		if (!binding) {
			// `canExecute` already required it; this only keeps the snapshot construction honest.
			return { ok: false, message: localize('nyala.query.execute.unbound', 'This query has no current connection. Choose a connection before running it.') };
		}

		const active = this.byQuery.get(queryId);
		if (active && holdsMutex(active)) {
			return { ok: false, message: localize('nyala.query.execute.busy', 'This query is already running. Cancel it before starting another.') };
		}

		if (!this.makeRoomForResult()) {
			return { ok: false, message: localize('nyala.query.execute.resultsFull', 'Too many results are open. Close a result view before running another query.') };
		}

		const snapshot: INyalaExecutionSnapshot = {
			queryId,
			profileId: binding.profileId,
			profileName: binding.profileName,
			sessionId: binding.sessionId,
			sessionGeneration: binding.sessionGeneration,
			runtimeGeneration: binding.runtimeGeneration,
			sql,
			mode,
			readOnly: context.readOnly,
			startedAt: Date.now(),
		};
		const record: INyalaExecutionRecord = {
			requestId: `rq_local_${++this.nextRequest}`,
			executionId: undefined,
			snapshot,
			state: 'queued',
			sequence: 0,
			stateEpoch: 0,
			resultIds: [],
			abandoned: false,
		};
		const previous = this.byQuery.get(queryId);
		this.byQuery.set(queryId, record);
		if (previous) {
			this.pruneExecution(previous);
		}
		this.logService.trace(`Nyala: query ${queryId} execution requested (${mode})`);
		this._onDidChangeExecution.fire(record);

		const answer = await this.bridge.call<{ executionId: string; state: NyalaExecutionState; sequence: number }>(NyalaRuntimeCommand.QueryExecute, {
			sessionId: snapshot.sessionId,
			sessionGeneration: snapshot.sessionGeneration,
			sql,
			mode,
			timeoutMs: DEFAULT_TIMEOUT_MS,
			maxInitialRows: MAX_INITIAL_ROWS,
		});

		if (!answer.ok) {
			// `answered` means the runtime itself refused before running anything (its execute reply
			// is sent only after the statement was prepared). Anything else leaves the outcome open.
			if (answer.answered === true || answer.sent === false) {
				markNotSent(record, answer.error, Date.now());
			} else {
				markUnknown(record, 'reply-lost', Date.now());
			}
			this._onDidChangeExecution.fire(record);
			return { ok: false, message: describeError(answer.error) };
		}

		if (answer.runtimeGeneration !== snapshot.runtimeGeneration) {
			// The runtime restarted between the snapshot and the reply. The execution id belongs to
			// a process that is gone; adopting it would let a later event move this record.
			markUnknown(record, 'runtime-restarted', Date.now());
			this._onDidChangeExecution.fire(record);
			return { ok: false, message: localize('nyala.query.execute.restarted', 'The runtime restarted while the query was starting. Its outcome is unknown.') };
		}

		record.executionId = answer.result.executionId;
		this.byExecution.set(record.executionId, record);
		applyStateChange(record, { state: answer.result.state, sequence: answer.result.sequence, runtimeGeneration: answer.runtimeGeneration }, Date.now());
		this.logService.trace(`Nyala: query ${queryId} execution ${record.executionId} is ${record.state}`);
		this._onDidChangeExecution.fire(record);

		if (record.abandoned) {
			// Nobody is waiting for this tab any more; the cancel must not hold up the reply path.
			void this.cancel(record.executionId);
		}

		return { ok: true, record };
	}

	acquireResult(executionId: string, resultId: string): INyalaResultLease | undefined {
		const entry = this.results.get(resultId);
		if (!entry || entry.released || entry.executionId !== executionId) {
			return undefined;
		}
		entry.references++;
		let released = false;
		const lease: ILease = {
			resultId,
			executionId,
			runtimeGeneration: entry.runtimeGeneration,
			entry,
			dispose: () => {
				if (released) {
					return;
				}
				released = true;
				entry.references = Math.max(0, entry.references - 1);
				if (entry.references === 0) {
					this.releaseResult(entry, 'last-lease');
				}
			},
		};
		return lease;
	}

	async fetchPage(lease: INyalaResultLease, cursor: string | null, limit = DEFAULT_PAGE_LIMIT): Promise<INyalaResultPage> {
		const entry = this.results.get(lease.resultId);
		if (!entry || entry.released || entry.executionId !== lease.executionId) {
			throw new Error(localize('nyala.query.result.released', 'This result is no longer available.'));
		}
		if (entry.inFlight) {
			throw new Error(localize('nyala.query.result.busy', 'A page of this result is already being read.'));
		}
		const bounded = Math.max(1, Math.min(1000, Math.floor(limit)));
		entry.inFlight = true;
		try {
			const answer = await this.bridge.call<INyalaResultPage>(NyalaRuntimeCommand.ResultFetchPage, {
				resultId: entry.resultId,
				limit: bounded,
				...(cursor === null ? {} : { cursor }),
			});
			if (!answer.ok) {
				if (answer.error.data.kind === 'RESULT_EXPIRED' || answer.error.data.kind === 'INVALID_SESSION') {
					this.forgetResult(entry);
				}
				throw new Error(describeError(answer.error));
			}
			return answer.result;
		} finally {
			entry.inFlight = false;
		}
	}

	async cancel(executionId: string): Promise<void> {
		const record = this.byExecution.get(executionId);
		if (!record || isTerminalState(record.state)) {
			return;
		}
		const answer = await this.bridge.call<{ accepted: boolean; state: NyalaExecutionState }>(NyalaRuntimeCommand.QueryCancel, { executionId, reason: 'user' });
		if (!answer.ok) {
			if (answer.answered === false) {
				// No usable reply: the run may have finished, or the process may be gone. Saying
				// "cancelled" here would be a guess.
				markUnknown(record, 'reply-lost', Date.now());
			}
			this._onDidChangeExecution.fire(record);
			return;
		}
		// The cancel reply has no sequence: it may settle a terminal outcome, but it may not
		// rewrite the record's state sequence.
		applyCancelReply(record, answer.result.state, answer.result.accepted, Date.now());
		this._onDidChangeExecution.fire(record);
	}

	override dispose(): void {
		for (const record of this.byQuery.values()) {
			if (record.executionId && !isTerminalState(record.state)) {
				// Best effort: the window is closing and the supervisor will stop the process anyway.
				void this.bridge.call(NyalaRuntimeCommand.QueryCancel, { executionId: record.executionId, reason: 'shutdown' }).catch(() => undefined);
			}
		}
		for (const entry of this.results.values()) {
			entry.released = true;
			entry.references = 0;
		}
		this.results.clear();
		super.dispose();
	}

	/** Releases a finished run's results, e.g. when N-204 closes its view. */
	releaseResults(executionId: string): void {
		for (const entry of [...this.results.values()]) {
			if (entry.executionId === executionId) {
				entry.references = 0;
				this.releaseResult(entry, 'explicit');
			}
		}
	}

	/**
	 * A closed tab has nobody waiting for its reply. If the run already has an id it is cancelled;
	 * if the reply has not arrived yet the record is marked abandoned, and the reply path cancels the
	 * run as soon as the id exists. It is never revived for a tab that is gone.
	 */
	private onQueryReleased(queryId: string): void {
		const record = this.byQuery.get(queryId);
		if (!record || isTerminalState(record.state)) {
			return;
		}
		record.abandoned = true;
		if (record.executionId) {
			void this.cancel(record.executionId);
		}
		this._onDidChangeExecution.fire(record);
	}

	private onQueryState(event: INyalaQueryStateChangedEvent): void {
		const record = this.byExecution.get(event.executionId);
		if (!record) {
			// An execution this window never adopted (or already dropped): it cannot move anything.
			return;
		}
		const update = applyStateChange(record, {
			state: event.state,
			sequence: event.sequence,
			runtimeGeneration: event.runtimeGeneration,
			resultIds: event.resultIds,
			error: event.error,
		}, Date.now());
		if (update.kind === 'gap') {
			void this.calibrate(record);
			return;
		}
		if (update.kind !== 'applied') {
			return;
		}
		this.registerResults(record, event.resultIds ?? []);
		this._onDidChangeExecution.fire(record);
	}

	private async calibrate(record: INyalaExecutionRecord): Promise<void> {
		const executionId = record.executionId;
		if (!executionId || record.stateEpoch === undefined || this.calibrating.has(executionId)) {
			return;
		}
		this.calibrating.add(executionId);
		const epochBefore = record.stateEpoch;
		try {
			const answer = await this.bridge.call<{ executionId: string; state: NyalaExecutionState; sequence: number; resultIds?: readonly string[]; error?: INyalaRuntimeErrorObject | null }>(NyalaRuntimeCommand.QueryGetState, { executionId });
			if (!answer.ok) {
				return;
			}
			const update = applyCalibration(record, {
				state: answer.result.state,
				sequence: answer.result.sequence,
				runtimeGeneration: answer.runtimeGeneration,
				resultIds: answer.result.resultIds,
				error: answer.result.error ?? undefined,
			}, epochBefore, Date.now());
			if (update.kind === 'applied') {
				this.registerResults(record, answer.result.resultIds ?? []);
				this._onDidChangeExecution.fire(record);
			}
		} finally {
			this.calibrating.delete(executionId);
		}
	}

	private onRuntimeState(state: INyalaRuntimeState): void {
		const generation = this.lastSeenGeneration;
		this.lastSeenGeneration = state.generation;
		const generationChanged = state.generation !== generation;
		if (!generationChanged && state.status === 'ready') {
			return;
		}
		if (!generationChanged && state.status !== 'failed' && state.status !== 'stopped' && state.status !== 'restarting') {
			// `starting`/`idle` of the same generation is not a restart; a run may still be alive.
			return;
		}
		const reason: NyalaUnknownReason = generationChanged || state.status === 'restarting' ? 'runtime-restarted' : 'runtime-unavailable';
		for (const record of this.byQuery.values()) {
			if (!isTerminalState(record.state)) {
				markUnknown(record, reason, Date.now());
				this._onDidChangeExecution.fire(record);
			}
		}
		// The old process is gone: its result handles died with it. Releasing them against the new
		// runtime would address handles it never issued, so this is local-only.
		for (const entry of this.results.values()) {
			entry.released = true;
			entry.references = 0;
		}
		this.results.clear();
	}

	private registerResults(record: INyalaExecutionRecord, resultIds: readonly string[]): void {
		for (const resultId of resultIds) {
			if (this.results.has(resultId)) {
				continue;
			}
			const perExecution = [...this.results.values()].filter(entry => entry.executionId === record.executionId).length;
			if (perExecution >= MAX_RESULTS_PER_EXECUTION) {
				record.resultLimitReached = true;
				continue;
			}
			if (!this.makeRoomForResult()) {
				record.resultLimitReached = true;
				continue;
			}
			this.results.set(resultId, {
				resultId,
				executionId: record.executionId!,
				runtimeGeneration: record.snapshot.runtimeGeneration,
				createdAt: Date.now(),
				references: 0,
				released: false,
				releaseSent: false,
				inFlight: false,
			});
		}
	}

	/** Evicts the oldest unclaimed result of a finished run; false when nothing can be evicted. */
	private makeRoomForResult(): boolean {
		if (this.results.size < MAX_RESULTS_PER_WINDOW) {
			return true;
		}
		const candidates = [...this.results.values()]
			.filter(entry => !entry.released && entry.references === 0 && this.isFinished(entry.executionId))
			.sort((a, b) => a.createdAt - b.createdAt);
		for (const entry of candidates) {
			this.releaseResult(entry, 'evicted');
			if (this.results.size < MAX_RESULTS_PER_WINDOW) {
				return true;
			}
		}
		return this.results.size < MAX_RESULTS_PER_WINDOW;
	}

	private isFinished(executionId: string): boolean {
		const record = this.byExecution.get(executionId);
		return !!record && isTerminalState(record.state);
	}

	private releaseResult(entry: IResultEntry, reason: 'last-lease' | 'evicted' | 'explicit'): void {
		if (entry.released) {
			return;
		}
		entry.released = true;
		this.results.delete(entry.resultId);
		this.pruneExecution(this.byExecution.get(entry.executionId));
		if (entry.releaseSent) {
			return;
		}
		entry.releaseSent = true;
		// A handle from a dead generation addresses nothing the current runtime knows.
		if (entry.runtimeGeneration !== this.connectionService.runtimeState.generation) {
			this.logService.trace(`Nyala: result ${entry.resultId} dropped locally (${reason}); its runtime generation is gone`);
			return;
		}
		void this.bridge.call(NyalaRuntimeCommand.ResultRelease, { resultId: entry.resultId }).then(answer => {
			if (!answer.ok) {
				this.logService.trace(`Nyala: result ${entry.resultId} release ended as ${answer.error.data.kind} (${reason})`);
			}
		});
	}

	private forgetResult(entry: IResultEntry): void {
		entry.released = true;
		entry.references = 0;
		this.results.delete(entry.resultId);
		this.pruneExecution(this.byExecution.get(entry.executionId));
	}

	/**
	 * Drops an execution record once nothing can reach it any more: it is no longer the query's
	 * newest run and it owns no result. Without this the window would keep one record per run it
	 * ever started.
	 */
	private pruneExecution(record: INyalaExecutionRecord | undefined): void {
		if (!record || !record.executionId) {
			return;
		}
		if (this.byQuery.get(record.snapshot.queryId) === record) {
			return;
		}
		for (const entry of this.results.values()) {
			if (entry.executionId === record.executionId) {
				return;
			}
		}
		this.byExecution.delete(record.executionId);
	}
}

function describeError(error: INyalaRuntimeErrorObject): string {
	return error.data.safeDetail ?? error.message;
}
