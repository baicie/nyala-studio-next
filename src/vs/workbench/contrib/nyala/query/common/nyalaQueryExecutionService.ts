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
//
// Notifications can overtake the reply's promise continuation: the main process dispatches the
// `query.execute` success and the first `query.stateChanged` frames in the same turn, so the
// continuation that adopts the execution id has not run yet. Those events are buffered per
// execution id and replayed when the id is adopted (bounded, and dropped across generations).

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
	/** Whether this lease has been released; a released lease may not read pages. */
	readonly isDisposed: boolean;
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
 * results against `maxConcurrentExecutions` (4 by default), so three leaves room for a run.
 */
const MAX_RESULTS_PER_WINDOW = 3;
const MAX_RESULTS_PER_EXECUTION = 3;
/** Bounds for notifications that arrive before their execution id was adopted. */
const MAX_EARLY_EXECUTIONS = 16;
const MAX_EARLY_EVENTS = 8;

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
	/** Events for an execution id the service has not adopted yet; bounded, see `bufferEarly`. */
	private readonly early = new Map<string, INyalaQueryStateChangedEvent[]>();
	/** Result ids already refused, so a repeated notification cannot release one twice. */
	private readonly discarded = new Set<string>();
	/** Release calls still in flight; they still occupy runtime quota until they settle. */
	private pendingReleases = 0;
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

	/** Diagnostics for tests: notifications waiting for their execution id. */
	get bufferedNotificationCount(): number {
		let count = 0;
		for (const events of this.early.values()) {
			count += events.length;
		}
		return count;
	}

	/** Diagnostics for tests: how many execution records the window keeps. */
	get executionRecordCount(): number {
		return this.byExecution.size;
	}

	/** Diagnostics for tests: how many result handles the window keeps. */
	get resultHandleCount(): number {
		return this.results.size;
	}

	/** Diagnostics for tests: release calls still in flight (they still occupy runtime quota). */
	get pendingReleaseCount(): number {
		return this.pendingReleases;
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

		// Reclaiming waits for the old handles to be released: their quota is not free until the
		// runtime confirms, so a new run must not be sent on the assumption that it is.
		if (!(await this.reclaimResults())) {
			const error: INyalaRuntimeErrorObject = { code: -32014, message: 'Too many results are open', data: { kind: 'RESOURCE_LIMIT', retryable: true, safeDetail: 'close a result view before running another query' } };
			markNotSent(record, error, Date.now());
			this._onDidChangeExecution.fire(record);
			return { ok: false, message: localize('nyala.query.execute.resultsFull', 'Too many results are open. Close a result view before running another query.') };
		}
		// The wait above is the first one, so the target has to be re-checked: a restart or a rebind
		// during it would otherwise send the request to a session that no longer exists.
		const current = this.contextService.runtimeState;
		if (context.isDisposed || !context.canExecute(current) || current.generation !== snapshot.runtimeGeneration) {
			const error: INyalaRuntimeErrorObject = { code: -32012, message: 'The Nyala runtime is not available', data: { kind: 'RUNTIME_LOST', retryable: true, safeDetail: 'the runtime or the binding changed before the query was sent' } };
			markNotSent(record, error, Date.now());
			this._onDidChangeExecution.fire(record);
			return { ok: false, message: localize('nyala.query.execute.restarted', 'The runtime or the connection changed before the query could start.') };
		}

		let answer;
		try {
			answer = await this.bridge.call<{ executionId: string; state: NyalaExecutionState; sequence: number }>(NyalaRuntimeCommand.QueryExecute, {
				sessionId: snapshot.sessionId,
				sessionGeneration: snapshot.sessionGeneration,
				sql,
				mode,
				timeoutMs: DEFAULT_TIMEOUT_MS,
				maxInitialRows: MAX_INITIAL_ROWS,
			});
		} catch (error) {
			// A rejected IPC promise says nothing about whether the runtime ran the statement.
			markUnknown(record, 'reply-lost', Date.now());
			this._onDidChangeExecution.fire(record);
			this.logService.trace(`Nyala: query ${queryId} execute call rejected: ${error instanceof Error ? error.message : String(error)}`);
			return { ok: false, message: localize('nyala.query.execute.unreachable', 'The runtime could not be reached. The query outcome is unknown.') };
		}

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
			this.early.delete(answer.result.executionId);
			markUnknown(record, 'runtime-restarted', Date.now());
			this._onDidChangeExecution.fire(record);
			return { ok: false, message: localize('nyala.query.execute.restarted', 'The runtime restarted while the query was starting. Its outcome is unknown.') };
		}

		record.executionId = answer.result.executionId;
		this.byExecution.set(record.executionId, record);
		applyStateChange(record, { state: answer.result.state, sequence: answer.result.sequence, runtimeGeneration: answer.runtimeGeneration }, Date.now());
		// Notifications that arrived before this continuation are the run's first states. Replaying
		// them here is what keeps a fast runtime from leaving the record stuck at `queued`.
		this.drainEarly(record);
		this.logService.trace(`Nyala: query ${queryId} execution ${record.executionId} is ${record.state}`);
		this._onDidChangeExecution.fire(record);

		if (record.abandoned) {
			// Nobody is waiting for this tab any more; the cancel must not hold up the reply path.
			void this.cancel(record.executionId).catch(() => undefined);
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
			get isDisposed(): boolean {
				return released;
			},
			dispose: () => {
				if (released) {
					return;
				}
				released = true;
				entry.references = Math.max(0, entry.references - 1);
				if (entry.references === 0) {
					void this.releaseResult(entry, 'last-lease');
				}
			},
		};
		return lease;
	}

	async fetchPage(lease: INyalaResultLease, cursor: string | null, limit = DEFAULT_PAGE_LIMIT): Promise<INyalaResultPage> {
		if (lease.isDisposed) {
			throw new Error(localize('nyala.query.result.released', 'This result is no longer available.'));
		}
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
			let answer;
			try {
				answer = await this.bridge.call<INyalaResultPage>(NyalaRuntimeCommand.ResultFetchPage, {
					resultId: entry.resultId,
					limit: bounded,
					...(cursor === null ? {} : { cursor }),
				});
			} catch (error) {
				throw new Error(localize('nyala.query.result.unreachable', 'The result page could not be read: the runtime is not available.'));
			}
			if (!answer.ok) {
				if (answer.error.data.kind === 'RESULT_EXPIRED' || answer.error.data.kind === 'INVALID_SESSION') {
					this.forgetResult(entry);
				}
				throw new Error(describeError(answer.error));
			}
			// The answer is only usable if the handle survived the round trip: a generation change
			// or a release while the read was in flight makes these rows belong to a dead handle.
			if (lease.isDisposed || this.results.get(entry.resultId) !== entry || entry.released || entry.runtimeGeneration !== this.connectionService.runtimeState.generation) {
				throw new Error(localize('nyala.query.result.released', 'This result is no longer available.'));
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
		let answer;
		try {
			answer = await this.bridge.call<{ accepted: boolean; state: NyalaExecutionState }>(NyalaRuntimeCommand.QueryCancel, { executionId, reason: 'user' });
		} catch (error) {
			markUnknown(record, 'reply-lost', Date.now());
			this._onDidChangeExecution.fire(record);
			return;
		}
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
		// A terminal reply may be the only place the outcome is ever reported. Its missing result
		// ids and error are recovered from `query.getState`; otherwise the results would be lost
		// because a terminal record ignores every later notification.
		if (isTerminalState(record.state) && record.resultIds.length === 0) {
			void this.calibrateMetadata(record).catch(() => undefined);
		}
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
		this.early.clear();
		this.discarded.clear();
		super.dispose();
	}

	/** Releases a finished run's results, e.g. when N-204 closes its view. */
	releaseResults(executionId: string): void {
		for (const entry of [...this.results.values()]) {
			if (entry.executionId === executionId) {
				entry.references = 0;
				void this.releaseResult(entry, 'explicit');
			}
		}
	}

	/**
	 * A closed tab has nobody waiting for its reply. If the run already has an id it is cancelled;
	 * if the reply has not arrived yet the record is marked abandoned, and the reply path cancels the
	 * run as soon as the id exists.
	 *
	 * A finished run is detached from the query at once, its SQL text is dropped, and the results
	 * nobody leased are released. A result still leased by a view stays alive until that lease ends;
	 * the record is then forgotten with it.
	 */
	private onQueryReleased(queryId: string): void {
		const record = this.byQuery.get(queryId);
		if (!record) {
			return;
		}
		record.abandoned = true;
		redactSnapshot(record);
		if (!isTerminalState(record.state)) {
			if (record.executionId) {
				void this.cancel(record.executionId).catch(() => undefined);
			}
			this._onDidChangeExecution.fire(record);
			return;
		}
		this.byQuery.delete(queryId);
		for (const entry of [...this.results.values()]) {
			if (entry.executionId === record.executionId) {
				if (entry.references === 0) {
					void this.releaseResult(entry, 'explicit');
				}
			}
		}
		this.pruneExecution(record);
		this._onDidChangeExecution.fire(record);
	}

	private onQueryState(event: INyalaQueryStateChangedEvent): void {
		const record = this.byExecution.get(event.executionId);
		if (!record) {
			this.bufferEarly(event);
			return;
		}
		this.applyEvent(record, event);
	}

	/**
	 * Keeps a notification whose execution id is not adopted yet. The map is bounded twice: by the
	 * number of executions remembered and by the events per execution. Events from another
	 * generation are dropped here, because they cannot describe a run of this one.
	 */
	private bufferEarly(event: INyalaQueryStateChangedEvent): void {
		if (event.runtimeGeneration !== this.connectionService.runtimeState.generation) {
			return;
		}
		let events = this.early.get(event.executionId);
		if (!events) {
			if (this.early.size >= MAX_EARLY_EXECUTIONS) {
				const oldest = this.early.keys().next().value;
				if (oldest !== undefined) {
					this.early.delete(oldest);
				}
			}
			events = [];
			this.early.set(event.executionId, events);
		}
		if (events.length >= MAX_EARLY_EVENTS) {
			events.shift();
		}
		events.push(event);
	}

	private drainEarly(record: INyalaExecutionRecord): void {
		const executionId = record.executionId;
		if (!executionId) {
			return;
		}
		const events = this.early.get(executionId);
		if (!events) {
			return;
		}
		this.early.delete(executionId);
		for (const event of events) {
			this.applyEvent(record, event);
		}
	}

	private applyEvent(record: INyalaExecutionRecord, event: INyalaQueryStateChangedEvent): void {
		const update = applyStateChange(record, {
			state: event.state,
			sequence: event.sequence,
			runtimeGeneration: event.runtimeGeneration,
			resultIds: event.resultIds,
			error: event.error,
		}, Date.now());
		if (update.kind === 'gap') {
			void this.calibrate(record).catch(() => undefined);
			return;
		}
		if (update.kind !== 'applied') {
			return;
		}
		if (event.resultIds?.length) {
			record.metadataSettled = true;
		}
		this.registerResults(record, event.resultIds ?? []);
		this._onDidChangeExecution.fire(record);
	}

	private async calibrate(record: INyalaExecutionRecord): Promise<void> {
		const executionId = record.executionId;
		if (!executionId || this.calibrating.has(executionId)) {
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
				if (answer.result.resultIds?.length) {
					record.metadataSettled = true;
				}
				this.registerResults(record, answer.result.resultIds ?? []);
				this._onDidChangeExecution.fire(record);
			}
		} finally {
			this.calibrating.delete(executionId);
		}
	}

	/**
	 * Fills in result ids and the error of an already terminal run. A terminal record ignores every
	 * later notification, so a cancel reply that only says `completed` would otherwise leave the
	 * results unreachable forever. This changes metadata only, never state or sequence.
	 */
	private async calibrateMetadata(record: INyalaExecutionRecord): Promise<void> {
		const executionId = record.executionId;
		if (!executionId || record.metadataSettled) {
			return;
		}
		record.metadataSettled = true;
		const answer = await this.bridge.call<{ state: NyalaExecutionState; sequence: number; resultIds?: readonly string[]; error?: INyalaRuntimeErrorObject | null }>(NyalaRuntimeCommand.QueryGetState, { executionId });
		if (!answer.ok) {
			return;
		}
		if (answer.result.error && !record.error) {
			record.error = answer.result.error;
		}
		if (answer.result.resultIds?.length) {
			// This path does not run through `applyStateChange`, so the ids have to be recorded here
			// as well as turned into handles.
			for (const resultId of answer.result.resultIds) {
				if (!record.resultIds.includes(resultId)) {
					record.resultIds.push(resultId);
				}
			}
			this.registerResults(record, answer.result.resultIds);
		}
		this._onDidChangeExecution.fire(record);
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
		// The old process is gone: its result handles died with it, and its unadopted notifications
		// can never match a record of the new generation. Releasing them against the new runtime
		// would address handles it never issued, so this is local-only.
		for (const entry of this.results.values()) {
			entry.released = true;
			entry.references = 0;
		}
		this.results.clear();
		this.early.clear();
		this.discarded.clear();
	}

	private registerResults(record: INyalaExecutionRecord, resultIds: readonly string[]): void {
		for (const resultId of resultIds) {
			if (this.results.has(resultId) || this.discarded.has(resultId)) {
				continue;
			}
			const perExecution = [...this.results.values()].filter(entry => entry.executionId === record.executionId).length;
			if (perExecution >= MAX_RESULTS_PER_EXECUTION || this.results.size + this.pendingReleases >= MAX_RESULTS_PER_WINDOW) {
				record.resultLimitReached = true;
				// A refused handle is not silently forgotten: the runtime still owns it, so it is
				// released explicitly. It is never acquirable because no entry exists for it.
				this.discardResult(record, resultId);
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

	/**
	 * Releases a result the service refused to keep. Sending is fire-and-forget with an explicit
	 * rejection handler, and the id is remembered so a repeated notification does not send again.
	 */
	private discardResult(record: INyalaExecutionRecord, resultId: string): void {
		if (this.discarded.has(resultId)) {
			return;
		}
		this.discarded.add(resultId);
		const generation = record.snapshot.runtimeGeneration;
		if (generation !== this.connectionService.runtimeState.generation) {
			this.logService.trace(`Nyala: refused result ${resultId} dropped locally; its runtime generation is gone`);
			return;
		}
		this.pendingReleases++;
		void this.bridge.call(NyalaRuntimeCommand.ResultRelease, { resultId }).then(answer => {
			if (!answer.ok) {
				this.logService.trace(`Nyala: refused result ${resultId} release ended as ${answer.error.data.kind}`);
			}
		}).catch(error => {
			this.logService.trace(`Nyala: refused result ${resultId} release was not delivered: ${error instanceof Error ? error.message : String(error)}`);
		}).finally(() => {
			this.pendingReleases = Math.max(0, this.pendingReleases - 1);
		});
	}

	/**
	 * Makes room for a new run by releasing the oldest unclaimed results of finished runs, and waits
	 * for those releases to settle: the runtime's quota is not free until it confirms them.
	 */
	private async reclaimResults(): Promise<boolean> {
		if (this.results.size + this.pendingReleases < MAX_RESULTS_PER_WINDOW) {
			return true;
		}
		const candidates = [...this.results.values()]
			.filter(entry => !entry.released && entry.references === 0 && this.isFinished(entry.executionId))
			.sort((a, b) => a.createdAt - b.createdAt);
		if (candidates.length === 0) {
			return false;
		}
		await Promise.allSettled(candidates.map(entry => this.releaseResult(entry, 'evicted')));
		return this.results.size + this.pendingReleases < MAX_RESULTS_PER_WINDOW;
	}

	private isFinished(executionId: string): boolean {
		const record = this.byExecution.get(executionId);
		return !!record && isTerminalState(record.state);
	}

	private releaseResult(entry: IResultEntry, reason: 'last-lease' | 'evicted' | 'explicit'): Promise<void> {
		if (entry.released) {
			return Promise.resolve();
		}
		entry.released = true;
		this.results.delete(entry.resultId);
		this.pruneExecution(this.byExecution.get(entry.executionId));
		if (entry.releaseSent) {
			return Promise.resolve();
		}
		entry.releaseSent = true;
		// A handle from a dead generation addresses nothing the current runtime knows.
		if (entry.runtimeGeneration !== this.connectionService.runtimeState.generation) {
			this.logService.trace(`Nyala: result ${entry.resultId} dropped locally (${reason}); its runtime generation is gone`);
			return Promise.resolve();
		}
		this.pendingReleases++;
		return this.bridge.call(NyalaRuntimeCommand.ResultRelease, { resultId: entry.resultId }).then(answer => {
			if (!answer.ok) {
				this.logService.trace(`Nyala: result ${entry.resultId} release ended as ${answer.error.data.kind} (${reason})`);
			}
		}).catch(error => {
			this.logService.trace(`Nyala: result ${entry.resultId} release was not delivered (${reason}): ${error instanceof Error ? error.message : String(error)}`);
		}).finally(() => {
			this.pendingReleases = Math.max(0, this.pendingReleases - 1);
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
	 * ever started, each holding its SQL text.
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
		redactSnapshot(record);
		this.byExecution.delete(record.executionId);
	}
}

/** Drops the SQL text from a record that nobody can run or reopen any more. */
function redactSnapshot(record: INyalaExecutionRecord): void {
	record.snapshot = { ...record.snapshot, sql: '' };
}

function describeError(error: INyalaRuntimeErrorObject): string {
	return error.data.safeDetail ?? error.message;
}
