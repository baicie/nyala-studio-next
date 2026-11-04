/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// N-203 execution service. Every test drives the real service with a fake bridge, so the ordering
// rules are checked as code rather than as timing: requests stay pending until the test answers
// them, notifications are pushed explicitly, and nothing depends on a timeout.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import {
	INyalaQueryStateChangedEvent,
	INyalaRuntimeCallResult,
	INyalaRuntimeState,
	NyalaRuntimeCommand,
} from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeIpc.js';
import { INyalaRuntimeErrorObject } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeContract.generated.js';
import { INyalaCatalog, INyalaConnectionHandle, INyalaConnectionService, INyalaConnectionState } from '../../connections/common/nyalaConnectionService.js';
import { INyalaRuntimeBridge } from '../../connections/common/nyalaConnectionService.js';
import { NyalaQueryContextService } from '../../query/common/nyalaQueryContextService.js';
import { NyalaQueryExecutionService } from '../../query/common/nyalaQueryExecutionService.js';

interface IRequest {
	readonly command: NyalaRuntimeCommand;
	readonly params: any;
	readonly answer: DeferredPromise<INyalaRuntimeCallResult<any>>;
	/** Set by tests that answer the same request from a loop, so they do not complete it twice. */
	answered?: boolean;
}

class FakeBridge implements INyalaRuntimeBridge {

	declare readonly _serviceBrand: undefined;

	readonly requests: IRequest[] = [];
	/** When set, every result.release call rejects instead of answering. */
	rejectResultRelease = false;
	/** When set, the next call of that command waits for it before answering. */
	private readonly gates = new Map<string, DeferredPromise<void>>();
	readonly stateChanges = new Emitter<INyalaRuntimeState>();
	readonly onDidChangeState = this.stateChanges.event;
	readonly queryChanges = new Emitter<INyalaQueryStateChangedEvent>();
	readonly onDidChangeQueryState = this.queryChanges.event;

	async getState(): Promise<INyalaRuntimeState> {
		return { generation: 1, status: 'ready' };
	}

	call<T>(command: NyalaRuntimeCommand, params: object): Promise<INyalaRuntimeCallResult<T>> {
		if (command === NyalaRuntimeCommand.ResultRelease && this.rejectResultRelease) {
			return Promise.reject(new Error('ipc closed'));
		}
		const gate = this.gates.get(command);
		if (gate) {
			this.gates.delete(command);
			return gate.p.then(() => this.enqueue(command, params)) as Promise<INyalaRuntimeCallResult<T>>;
		}
		return this.enqueue(command, params) as Promise<INyalaRuntimeCallResult<T>>;
	}

	private enqueue(command: NyalaRuntimeCommand, params: object): Promise<INyalaRuntimeCallResult<any>> {
		const answer = new DeferredPromise<INyalaRuntimeCallResult<any>>();
		this.requests.push({ command, params, answer });
		return answer.p;
	}

	hold(command: NyalaRuntimeCommand): DeferredPromise<void> {
		const gate = new DeferredPromise<void>();
		this.gates.set(command, gate);
		return gate;
	}

	/** Requests of a command that were issued but not answered yet, oldest first. */
	pending(command: NyalaRuntimeCommand): IRequest[] {
		return this.requests.filter(request => request.command === command);
	}

	async flush(): Promise<void> {
		for (let index = 0; index < 4; index++) {
			await Promise.resolve();
		}
	}

	dispose(): void {
		this.stateChanges.dispose();
		this.queryChanges.dispose();
	}
}

class FakeConnectionService implements INyalaConnectionService {

	declare readonly _serviceBrand: undefined;

	readonly changes = new Emitter<void>();
	readonly onDidChangeConnections = this.changes.event;
	readonly runtimeChanges = new Emitter<INyalaRuntimeState>();
	readonly onDidChangeRuntime = this.runtimeChanges.event;

	rows: INyalaConnectionState[] = [];
	runtimeState: INyalaRuntimeState = { generation: 1, status: 'ready' };

	get connections(): readonly INyalaConnectionState[] {
		return this.rows;
	}

	async addProfile(): Promise<string> {
		throw new Error('seeded by the test');
	}

	async restoreProfiles(): Promise<void> { }

	async refreshRuntime(): Promise<INyalaRuntimeState> {
		return this.runtimeState;
	}

	async connect(): Promise<void> { }

	async disconnect(): Promise<void> { }

	async refresh(): Promise<void> { }

	catalog(): INyalaCatalog | undefined {
		return undefined;
	}

	async listObjects(): Promise<never> {
		throw new Error('unused');
	}

	async describe(): Promise<never> {
		throw new Error('unused');
	}

	setRuntime(state: INyalaRuntimeState): void {
		this.runtimeState = state;
		this.runtimeChanges.fire(state);
	}

	dispose(): void {
		this.changes.dispose();
		this.runtimeChanges.dispose();
	}
}

function connected(profileId: string, sessionId: string): INyalaConnectionState {
	const handle: INyalaConnectionHandle = { profileId, sessionId, sessionGeneration: 1, runtimeGeneration: 1 };
	return { profile: { profileId, displayName: `${profileId}.sqlite`, target: { driver: 'sqlite', path: `/tmp/${profileId}.sqlite`, readOnly: true } }, status: 'connected', handle };
}

function stateEvent(executionId: string, state: INyalaQueryStateChangedEvent['state'], sequence: number, extra: Partial<INyalaQueryStateChangedEvent> = {}): INyalaQueryStateChangedEvent {
	return { runtimeGeneration: 1, executionId, state, sequence, ...extra };
}

function failure(kind: string, extra: Partial<{ sent: boolean; answered: boolean; safeDetail: string }> = {}): INyalaRuntimeCallResult<any> {
	const error: INyalaRuntimeErrorObject = { code: -32000, message: kind, data: { kind, retryable: false, safeDetail: extra.safeDetail } };
	return { ok: false, runtimeGeneration: 1, error, ...extra } as INyalaRuntimeCallResult<any>;
}

suite('Nyala query execution service', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let bridge: FakeBridge;
	let connections: FakeConnectionService;
	let contextService: NyalaQueryContextService;
	let service: NyalaQueryExecutionService;

	setup(() => {
		bridge = store.add(new FakeBridge());
		connections = store.add(new FakeConnectionService());
		contextService = store.add(new NyalaQueryContextService(connections, new NullLogService()));
		service = store.add(new NyalaQueryExecutionService(bridge, contextService, connections, new NullLogService()));
	});

	async function boundTab(queryId: string, profileId = 'p_a', sessionId = 's_a'): Promise<string> {
		connections.rows = [connected(profileId, sessionId), ...connections.rows];
		const context = contextService.create(queryId);
		const result = await contextService.bind(context, profileId);
		assert.strictEqual(result.ok, true);
		return queryId;
	}

	async function start(queryId: string, sql = 'SELECT 1;', mode: 'statement' | 'selection' | 'script' = 'statement'): Promise<{ promise: Promise<any>; request: IRequest }> {
		const promise = service.execute(queryId, sql, mode);
		await bridge.flush();
		const pending = bridge.pending(NyalaRuntimeCommand.QueryExecute);
		return { promise, request: pending[pending.length - 1] };
	}

	test('a run snapshots the bound session and sends exactly one execute request', async () => {
		await boundTab('q_1');

		const { promise, request } = await start('q_1', 'SELECT 42;', 'statement');
		request.answer.complete({ ok: true, runtimeGeneration: 1, result: { executionId: 'ex_1', state: 'queued', sequence: 1 } });
		const started = await promise;

		assert.deepStrictEqual({
			ok: started.ok,
			params: request.params,
			session: service.getExecution('q_1')?.snapshot.sessionId,
			requests: bridge.pending(NyalaRuntimeCommand.QueryExecute).length,
		}, {
			ok: true,
			params: { sessionId: 's_a', sessionGeneration: 1, sql: 'SELECT 42;', mode: 'statement', timeoutMs: 30000, maxInitialRows: 200 },
			session: 's_a',
			requests: 1,
		});
	});

	test('an unbound tab, a switching tab and a tab without a context never reach the runtime', async () => {
		await boundTab('q_1');
		const unbound = contextService.create('q_2');
		contextService.create('q_3').beginSwitch('b.sqlite');
		connections.rows = [];

		const results = await Promise.all([
			service.execute('q_2', 'SELECT 1;', 'statement'),
			service.execute('q_3', 'SELECT 1;', 'statement'),
			service.execute('q_missing', 'SELECT 1;', 'statement'),
		]);

		assert.deepStrictEqual({
			results: results.map(result => result.ok),
			requests: bridge.pending(NyalaRuntimeCommand.QueryExecute).length,
			unboundStillUnbound: unbound.isBound,
		}, { results: [false, false, false], requests: 0, unboundStillUnbound: false });
	});

	test('a stale runtime generation blocks execution even though a binding still exists', async () => {
		await boundTab('q_1');
		// The runtime moved to a new generation, but the connection event has not reconciled the
		// context yet. A `binding !== undefined` check would run against a session that is gone.
		connections.runtimeState = { generation: 2, status: 'ready' };

		const result = await service.execute('q_1', 'SELECT 1;', 'statement');

		assert.deepStrictEqual({ ok: result.ok, requests: bridge.pending(NyalaRuntimeCommand.QueryExecute).length }, { ok: false, requests: 0 });
	});

	test('two tabs run against their own sessions, and a rebind after the start does not retarget a run', async () => {
		await boundTab('q_1', 'p_a', 's_a');
		await boundTab('q_2', 'p_b', 's_b');
		connections.rows = [...connections.rows, connected('p_c', 's_c')];

		const first = await start('q_1');
		const second = await start('q_2');
		// The user rebinds q_1 while its execute request is still in flight.
		await contextService.bind(contextService.create('q_1'), 'p_c');
		first.request.answer.complete({ ok: true, runtimeGeneration: 1, result: { executionId: 'ex_1', state: 'queued', sequence: 1 } });
		second.request.answer.complete({ ok: true, runtimeGeneration: 1, result: { executionId: 'ex_2', state: 'queued', sequence: 1 } });
		await Promise.all([first.promise, second.promise]);

		assert.deepStrictEqual({
			firstSession: first.request.params.sessionId,
			secondSession: second.request.params.sessionId,
			snapshot: service.getExecution('q_1')?.snapshot.sessionId,
			contextNow: contextService.get('q_1')?.sessionId,
		}, {
			firstSession: 's_a',
			secondSession: 's_b',
			snapshot: 's_a',
			contextNow: 's_c',
		}, 'the run keeps the target it started with');
	});

	test('a second run of the same query is refused while the first has not finished', async () => {
		await boundTab('q_1');
		const first = await start('q_1');
		first.request.answer.complete({ ok: true, runtimeGeneration: 1, result: { executionId: 'ex_1', state: 'running', sequence: 1 } });

		const second = await service.execute('q_1', 'SELECT 2;', 'statement');

		assert.deepStrictEqual({ ok: second.ok, requests: bridge.pending(NyalaRuntimeCommand.QueryExecute).length }, { ok: false, requests: 1 });
	});

	test('a reply from another runtime generation is not adopted: the run is unknown', async () => {
		await boundTab('q_1');
		const { promise, request } = await start('q_1');
		request.answer.complete({ ok: true, runtimeGeneration: 2, result: { executionId: 'ex_9', state: 'queued', sequence: 1 } });

		const started = await promise;

		assert.deepStrictEqual({
			ok: started.ok,
			state: service.getExecution('q_1')?.state,
			unknownReason: service.getExecution('q_1')?.unknownReason,
			adopted: service.getExecutionById('ex_9') === undefined,
		}, {
			ok: false,
			state: 'unknown',
			unknownReason: 'runtime-restarted',
			adopted: true,
		});
	});

	test('a request the Main process refused is a plain failure, not unknown', async () => {
		await boundTab('q_1');
		const { promise, request } = await start('q_1');
		request.answer.complete(failure('INVALID_PARAMS', { sent: false, answered: false, safeDetail: 'mode statement and selection run one statement; use mode script' }));

		const started = await promise;
		const record = service.getExecution('q_1')!;

		assert.deepStrictEqual({
			ok: started.ok,
			state: record.state,
			notSent: record.notSent,
			unknownReason: record.unknownReason,
			message: started.ok ? undefined : started.message,
		}, {
			ok: false,
			state: 'failed',
			notSent: true,
			unknownReason: undefined,
			message: 'mode statement and selection run one statement; use mode script',
		});
	});

	test('a request that left the bridge without a usable answer is unknown, never "did not run"', async () => {
		await boundTab('q_1');
		const { promise, request } = await start('q_1');
		request.answer.complete(failure('RUNTIME_LOST', { sent: true, answered: false }));

		await promise;
		const record = service.getExecution('q_1')!;

		assert.deepStrictEqual({ state: record.state, notSent: record.notSent, unknownReason: record.unknownReason }, {
			state: 'unknown',
			notSent: undefined,
			unknownReason: 'reply-lost',
		});
	});

	test('a runtime that answered with an error before preparing the statement is a definitive failure', async () => {
		await boundTab('q_1');
		const { promise, request } = await start('q_1');
		request.answer.complete(failure('SQL_SYNTAX', { sent: true, answered: true, safeDetail: 'near "SELEC": syntax error' }));

		await promise;
		const record = service.getExecution('q_1')!;

		assert.deepStrictEqual({ state: record.state, notSent: record.notSent, kind: record.error?.data.kind }, {
			state: 'failed',
			notSent: true,
			kind: 'SQL_SYNTAX',
		});
	});

	async function running(queryId = 'q_1', executionId = 'ex_1'): Promise<IRequest> {
		await boundTab(queryId);
		const { promise, request } = await start(queryId);
		request.answer.complete({ ok: true, runtimeGeneration: 1, result: { executionId, state: 'queued', sequence: 1 } });
		await promise;
		bridge.queryChanges.fire(stateEvent(executionId, 'running', 2));
		await bridge.flush();
		return request;
	}

	test('notifications advance the run; duplicates and older sequences are ignored', async () => {
		await running();

		bridge.queryChanges.fire(stateEvent('ex_1', 'streaming', 3, { resultIds: ['rs_1'] }));
		bridge.queryChanges.fire(stateEvent('ex_1', 'streaming', 3, { resultIds: ['rs_1'] }));
		bridge.queryChanges.fire(stateEvent('ex_1', 'running', 2));
		bridge.queryChanges.fire(stateEvent('ex_1', 'completed', 4, { resultIds: ['rs_2'] }));

		assert.deepStrictEqual({
			state: service.getExecution('q_1')?.state,
			sequence: service.getExecution('q_1')?.sequence,
			results: service.getExecution('q_1')?.resultIds,
		}, { state: 'completed', sequence: 4, results: ['rs_1', 'rs_2'] });
	});

	test('a sequence gap triggers exactly one calibration and accepts its newer state', async () => {
		await running();

		bridge.queryChanges.fire(stateEvent('ex_1', 'streaming', 6, { resultIds: ['rs_1'] }));
		await bridge.flush();
		const calibrations = bridge.pending(NyalaRuntimeCommand.QueryGetState);
		// A second notification during the read must not start a second one.
		bridge.queryChanges.fire(stateEvent('ex_1', 'streaming', 7));
		await bridge.flush();

		calibrations[0].answer.complete({ ok: true, runtimeGeneration: 1, result: { executionId: 'ex_1', state: 'completed', sequence: 6, resultIds: ['rs_1'] } });
		await bridge.flush();

		assert.deepStrictEqual({
			calibrations: calibrations.length,
			state: service.getExecution('q_1')?.state,
			sequence: service.getExecution('q_1')?.sequence,
		}, { calibrations: 1, state: 'completed', sequence: 6 });
	});

	test('a terminal run ignores every later notification', async () => {
		await running();
		bridge.queryChanges.fire(stateEvent('ex_1', 'completed', 3));
		bridge.queryChanges.fire(stateEvent('ex_1', 'running', 4));
		bridge.queryChanges.fire(stateEvent('ex_1', 'failed', 5));

		assert.deepStrictEqual({ state: service.getExecution('q_1')?.state, sequence: service.getExecution('q_1')?.sequence }, { state: 'completed', sequence: 3 });
	});

	test('a notification from a dead generation cannot move the run', async () => {
		await running();

		bridge.queryChanges.fire({ ...stateEvent('ex_1', 'completed', 3), runtimeGeneration: 2 });

		assert.deepStrictEqual({ state: service.getExecution('q_1')?.state, sequence: service.getExecution('q_1')?.sequence }, { state: 'running', sequence: 2 });
	});

	test('cancel marks the request, not the outcome, and never invents a sequence', async () => {
		await running();

		const cancelling = service.cancel('ex_1');
		await bridge.flush();
		const cancelRequest = bridge.pending(NyalaRuntimeCommand.QueryCancel)[0];
		cancelRequest.answer.complete({ ok: true, runtimeGeneration: 1, result: { accepted: true, state: 'running' } });
		await cancelling;

		assert.deepStrictEqual({ state: service.getExecution('q_1')?.state, sequence: service.getExecution('q_1')?.sequence }, { state: 'cancel_requested', sequence: 2 });

		bridge.queryChanges.fire(stateEvent('ex_1', 'cancelled', 3));
		assert.strictEqual(service.getExecution('q_1')?.state, 'cancelled');
	});

	test('a cancel reply that reports a terminal outcome settles the run', async () => {
		await running();

		const cancelling = service.cancel('ex_1');
		await bridge.flush();
		bridge.pending(NyalaRuntimeCommand.QueryCancel)[0].answer.complete({ ok: true, runtimeGeneration: 1, result: { accepted: false, state: 'completed' } });
		await cancelling;

		assert.deepStrictEqual({ state: service.getExecution('q_1')?.state, sequence: service.getExecution('q_1')?.sequence }, { state: 'completed', sequence: 2 });
	});

	test('a cancel that cannot be delivered leaves the outcome unknown, not cancelled', async () => {
		await running();

		const cancelling = service.cancel('ex_1');
		await bridge.flush();
		bridge.pending(NyalaRuntimeCommand.QueryCancel)[0].answer.complete(failure('RUNTIME_LOST', { sent: true, answered: false }));
		await cancelling;

		assert.deepStrictEqual({ state: service.getExecution('q_1')?.state, reason: service.getExecution('q_1')?.unknownReason }, {
			state: 'unknown',
			reason: 'reply-lost',
		});
	});

	test('an UNKNOWN_COMMIT_STATUS failure is preserved verbatim and has no retry path', async () => {
		await boundTab('q_1');
		const { promise, request } = await start('q_1');
		const error: INyalaRuntimeErrorObject = {
			code: -32013,
			message: 'The commit status could not be verified',
			data: { kind: 'UNKNOWN_COMMIT_STATUS', retryable: false, executionRollback: 'unknown' },
		};
		request.answer.complete({ ok: false, runtimeGeneration: 1, error, sent: true, answered: true });
		await promise;

		assert.deepStrictEqual({
			state: service.getExecution('q_1')?.state,
			kind: service.getExecution('q_1')?.error?.data.kind,
			rollback: service.getExecution('q_1')?.error?.data.executionRollback,
		}, { state: 'failed', kind: 'UNKNOWN_COMMIT_STATUS', rollback: 'unknown' });
	});

	test('completed results stay readable: the run has ended, the lease has not', async () => {
		await running();
		bridge.queryChanges.fire(stateEvent('ex_1', 'completed', 3, { resultIds: ['rs_1'] }));
		await bridge.flush();

		const lease = service.acquireResult('ex_1', 'rs_1');
		assert.ok(lease);

		const fetch = service.fetchPage(lease!, null, 50);
		await bridge.flush();
		bridge.pending(NyalaRuntimeCommand.ResultFetchPage)[0].answer.complete({ ok: true, runtimeGeneration: 1, result: { columns: [], rows: [], hasMore: false, nextCursor: null } });
		const page = await fetch;

		assert.deepStrictEqual({ page, withoutLease: service.acquireResult('ex_1', 'rs_9') }, { page: { columns: [], rows: [], hasMore: false, nextCursor: null }, withoutLease: undefined });

		lease!.dispose();
		await bridge.flush();
		assert.strictEqual(bridge.pending(NyalaRuntimeCommand.ResultRelease).length, 1, 'the last lease sends exactly one release');

		lease!.dispose();
		await bridge.flush();
		assert.strictEqual(bridge.pending(NyalaRuntimeCommand.ResultRelease).length, 1, 'releasing twice does not send twice');
	});

	test('a result stays alive while any consumer still holds a lease', async () => {
		await running();
		bridge.queryChanges.fire(stateEvent('ex_1', 'completed', 3, { resultIds: ['rs_1'] }));
		await bridge.flush();

		const first = service.acquireResult('ex_1', 'rs_1')!;
		const second = service.acquireResult('ex_1', 'rs_1')!;
		first.dispose();
		await bridge.flush();
		const releasesAfterFirst = bridge.pending(NyalaRuntimeCommand.ResultRelease).length;
		second.dispose();
		await bridge.flush();

		assert.deepStrictEqual({ releasesAfterFirst, releasesAfterSecond: bridge.pending(NyalaRuntimeCommand.ResultRelease).length }, {
			releasesAfterFirst: 0,
			releasesAfterSecond: 1,
		});
	});

	test('a result id from another execution is refused before any RPC', async () => {
		await running('q_1', 'ex_1');
		await boundTab('q_2');
		const second = await start('q_2');
		second.request.answer.complete({ ok: true, runtimeGeneration: 1, result: { executionId: 'ex_2', state: 'completed', sequence: 2, resultIds: ['rs_2'] } });
		await second.promise;
		bridge.queryChanges.fire(stateEvent('ex_2', 'completed', 3, { resultIds: ['rs_2'] }));
		await bridge.flush();

		assert.deepStrictEqual({
			crossExecution: service.acquireResult('ex_1', 'rs_2'),
			unknownResult: service.acquireResult('ex_2', 'rs_unknown'),
		}, { crossExecution: undefined, unknownResult: undefined });
	});

	test('a runtime generation change voids open runs and drops their results without releasing them', async () => {
		await running();
		bridge.queryChanges.fire(stateEvent('ex_1', 'completed', 3, { resultIds: ['rs_1'] }));
		await bridge.flush();
		const lease = service.acquireResult('ex_1', 'rs_1')!;

		connections.setRuntime({ generation: 2, status: 'ready' });
		await bridge.flush();
		lease.dispose();
		await bridge.flush();

		assert.deepStrictEqual({
			executionState: service.getExecution('q_1')?.state,
			acquireAfterRestart: service.acquireResult('ex_1', 'rs_1'),
			releases: bridge.pending(NyalaRuntimeCommand.ResultRelease).length,
		}, {
			// A run that had already finished keeps its honest outcome; only open runs become
			// unknown. What changed is that its results are gone and nothing was sent to the new
			// process.
			executionState: 'completed',
			acquireAfterRestart: undefined,
			releases: 0,
		}, 'old-generation handles are forgotten locally, never sent to the new process');
	});

	test('a closed tab cancels a running execution and abandons one that has not replied yet', async () => {
		await boundTab('q_1');
		const pending = await start('q_1');

		contextService.release('q_1');
		await bridge.flush();

		pending.request.answer.complete({ ok: true, runtimeGeneration: 1, result: { executionId: 'ex_1', state: 'queued', sequence: 1 } });
		await pending.promise;
		await bridge.flush();

		assert.deepStrictEqual({
			abandoned: service.getExecution('q_1')?.abandoned,
			cancels: bridge.pending(NyalaRuntimeCommand.QueryCancel).map(request => request.params),
		}, {
			abandoned: true,
			cancels: [{ executionId: 'ex_1', reason: 'user' }],
		});
	});

	test('a closed tab cancels an execution it already knows', async () => {
		await running();

		contextService.release('q_1');
		await bridge.flush();

		assert.deepStrictEqual(bridge.pending(NyalaRuntimeCommand.QueryCancel).map(request => request.params), [{ executionId: 'ex_1', reason: 'user' }]);
	});

	test('finished runs that own no results are forgotten, so the window does not keep one record per run', async () => {
		await boundTab('q_1');
		for (let index = 0; index < 3; index++) {
			const { promise, request } = await start('q_1');
			request.answer.complete({ ok: true, runtimeGeneration: 1, result: { executionId: `ex_${index + 1}`, state: 'queued', sequence: 1 } });
			await promise;
			bridge.queryChanges.fire(stateEvent(`ex_${index + 1}`, 'completed', 2));
			await bridge.flush();
		}

		assert.deepStrictEqual({
			records: service.executions.length,
			oldest: service.getExecutionById('ex_1'),
			newest: service.getExecutionById('ex_3')?.state,
		}, {
			records: 1,
			oldest: undefined,
			newest: 'completed',
		});
	});

	test('the result budget refuses more handles than the runtime can hold', async () => {
		await running('q_1', 'ex_1');
		bridge.queryChanges.fire(stateEvent('ex_1', 'completed', 3, { resultIds: ['rs_1', 'rs_2', 'rs_3', 'rs_4'] }));
		await bridge.flush();

		assert.deepStrictEqual({
			accepted: ['rs_1', 'rs_2', 'rs_3'].filter(resultId => service.acquireResult('ex_1', resultId) !== undefined),
			refused: service.acquireResult('ex_1', 'rs_4'),
			flag: service.getExecution('q_1')?.resultLimitReached ?? false,
		}, {
			accepted: ['rs_1', 'rs_2', 'rs_3'],
			refused: undefined,
			flag: true,
		});
	});

	//#region Notifications that arrive before the execute continuation

	test('notifications that arrive before the execute continuation are replayed, not lost', async () => {
		await boundTab('q_1');
		const { promise, request } = await start('q_1');

		// The main process dispatches the success reply and the following notifications in one
		// turn; the service's await continuation has not run yet when these fire.
		request.answer.complete({ ok: true, runtimeGeneration: 1, result: { executionId: 'ex_1', state: 'queued', sequence: 1 } });
		bridge.queryChanges.fire(stateEvent('ex_1', 'running', 2));
		bridge.queryChanges.fire(stateEvent('ex_1', 'completed', 3, { resultIds: ['rs_1'], error: { code: -32013, message: 'commit unknown', data: { kind: 'UNKNOWN_COMMIT_STATUS', retryable: false, executionRollback: 'unknown' } } }));
		await promise;

		assert.deepStrictEqual({
			state: service.getExecution('q_1')?.state,
			sequence: service.getExecution('q_1')?.sequence,
			results: service.getExecution('q_1')?.resultIds,
			kind: service.getExecution('q_1')?.error?.data.kind,
			buffered: service.bufferedNotificationCount,
		}, {
			state: 'completed',
			sequence: 3,
			results: ['rs_1'],
			kind: 'UNKNOWN_COMMIT_STATUS',
			buffered: 0,
		});
	});

	test('an early notification for another generation is dropped instead of being replayed', async () => {
		await boundTab('q_1');
		const { promise, request } = await start('q_1');

		bridge.queryChanges.fire({ ...stateEvent('ex_1', 'completed', 3), runtimeGeneration: 2 });
		request.answer.complete({ ok: true, runtimeGeneration: 1, result: { executionId: 'ex_1', state: 'queued', sequence: 1 } });
		await promise;

		assert.deepStrictEqual({ state: service.getExecution('q_1')?.state, sequence: service.getExecution('q_1')?.sequence }, { state: 'queued', sequence: 1 });
	});

	test('the early buffer is bounded and cleared with the generation', async () => {
		for (let execution = 0; execution < 40; execution++) {
			for (let sequence = 2; sequence < 12; sequence++) {
				bridge.queryChanges.fire(stateEvent(`ex_unknown_${execution}`, 'running', sequence));
			}
		}
		const buffered = service.bufferedNotificationCount;

		connections.setRuntime({ generation: 2, status: 'ready' });
		await bridge.flush();

		assert.deepStrictEqual({ bounded: buffered <= 16 * 8, cleared: service.bufferedNotificationCount }, { bounded: true, cleared: 0 });
	});

	test('a duplicated early notification is applied once', async () => {
		await boundTab('q_1');
		const { promise, request } = await start('q_1');

		bridge.queryChanges.fire(stateEvent('ex_1', 'streaming', 2, { resultIds: ['rs_1'] }));
		bridge.queryChanges.fire(stateEvent('ex_1', 'streaming', 2, { resultIds: ['rs_1'] }));
		request.answer.complete({ ok: true, runtimeGeneration: 1, result: { executionId: 'ex_1', state: 'queued', sequence: 1 } });
		await promise;

		assert.deepStrictEqual({ state: service.getExecution('q_1')?.state, sequence: service.getExecution('q_1')?.sequence, results: service.getExecution('q_1')?.resultIds }, {
			state: 'streaming',
			sequence: 2,
			results: ['rs_1'],
		});
	});

	//#endregion

	//#region Result ownership

	test('the fourth result of one execution is released instead of silently dropped', async () => {
		await boundTab('q_1');
		await running('q_1', 'ex_1');
		bridge.queryChanges.fire(stateEvent('ex_1', 'completed', 3, { resultIds: ['rs_1', 'rs_2', 'rs_3', 'rs_4'] }));
		await bridge.flush();

		assert.deepStrictEqual({
			kept: ['rs_1', 'rs_2', 'rs_3'].filter(resultId => service.acquireResult('ex_1', resultId) !== undefined),
			refused: service.acquireResult('ex_1', 'rs_4'),
			released: bridge.pending(NyalaRuntimeCommand.ResultRelease).map(request => request.params),
		}, {
			kept: ['rs_1', 'rs_2', 'rs_3'],
			refused: undefined,
			released: [{ resultId: 'rs_4' }],
		});
	});

	test('closing a finished query detaches it, drops the SQL text, and frees unleased results', async () => {
		await boundTab('q_1');
		await running('q_1', 'ex_1');
		const sqlBefore = service.getExecution('q_1')?.snapshot.sql;
		bridge.queryChanges.fire(stateEvent('ex_1', 'completed', 3, { resultIds: ['rs_1', 'rs_2'] }));
		await bridge.flush();

		contextService.release('q_1');
		await bridge.flush();

		assert.deepStrictEqual({
			sqlBefore,
			detached: service.getExecution('q_1'),
			recordStillThere: service.getExecutionById('ex_1') !== undefined,
			results: service.resultHandleCount,
			releases: bridge.pending(NyalaRuntimeCommand.ResultRelease).map(request => request.params),
		}, {
			sqlBefore: 'SELECT 1;',
			detached: undefined,
			recordStillThere: false,
			results: 0,
			releases: [{ resultId: 'rs_1' }, { resultId: 'rs_2' }],
		});
	});

	test('a leased result survives the query closing until the last lease is released', async () => {
		await boundTab('q_1');
		await running('q_1', 'ex_1');
		bridge.queryChanges.fire(stateEvent('ex_1', 'completed', 3, { resultIds: ['rs_1'] }));
		await bridge.flush();
		const lease = service.acquireResult('ex_1', 'rs_1')!;

		contextService.release('q_1');
		await bridge.flush();
		const afterClose = { results: service.resultHandleCount, sql: service.getExecutionById('ex_1')?.snapshot.sql, releases: bridge.pending(NyalaRuntimeCommand.ResultRelease).length };

		lease.dispose();
		await bridge.flush();

		assert.deepStrictEqual({
			afterClose,
			afterLease: { results: service.resultHandleCount, record: service.getExecutionById('ex_1'), releases: bridge.pending(NyalaRuntimeCommand.ResultRelease).map(request => request.params) },
		}, {
			afterClose: { results: 1, sql: '', releases: 0 },
			afterLease: { results: 0, record: undefined, releases: [{ resultId: 'rs_1' }] },
		});
	});

	test('running and closing many queries does not grow records or handles with history', async () => {
		for (let index = 0; index < 8; index++) {
			const queryId = `q_cycle_${index}`;
			await boundTab(queryId, 'p_a', `s_${index}`);
			const { promise, request } = await start(queryId);
			request.answer.complete({ ok: true, runtimeGeneration: 1, result: { executionId: `ex_cycle_${index}`, state: 'queued', sequence: 1 } });
			await promise;
			bridge.queryChanges.fire(stateEvent(`ex_cycle_${index}`, 'completed', 2, { resultIds: [`rs_cycle_${index}`] }));
			await bridge.flush();
			contextService.release(queryId);
			await bridge.flush();
			// Releases occupy quota until the runtime answers them; answer every cycle so the next
			// run is judged against a recovered budget, not against pending calls.
			for (const release of bridge.pending(NyalaRuntimeCommand.ResultRelease)) {
				if (!release.answered) {
					release.answered = true;
					release.answer.complete({ ok: true, runtimeGeneration: 1, result: { released: true } });
				}
			}
			await bridge.flush();
		}

		assert.deepStrictEqual({
			queries: service.executions.length,
			records: service.executionRecordCount,
			results: service.resultHandleCount,
			releases: bridge.pending(NyalaRuntimeCommand.ResultRelease).length,
		}, {
			queries: 0,
			records: 0,
			results: 0,
			releases: 8,
		});
	});

	test('a release whose promise rejects is handled and still frees the local handle', async () => {
		await boundTab('q_1');
		await running('q_1', 'ex_1');
		bridge.queryChanges.fire(stateEvent('ex_1', 'completed', 3, { resultIds: ['rs_1'] }));
		await bridge.flush();
		const lease = service.acquireResult('ex_1', 'rs_1')!;
		bridge.rejectResultRelease = true;

		lease.dispose();
		await bridge.flush();
		await bridge.flush();

		assert.deepStrictEqual({ results: service.resultHandleCount, pending: service.pendingReleaseCount }, { results: 0, pending: 0 });
	});

	test('a new run waits for an evicted result to be released before assuming quota', async () => {
		await boundTab('q_1');
		await running('q_1', 'ex_1');
		bridge.queryChanges.fire(stateEvent('ex_1', 'completed', 3, { resultIds: ['rs_1', 'rs_2', 'rs_3'] }));
		await bridge.flush();
		const releaseGate = bridge.hold(NyalaRuntimeCommand.ResultRelease);

		const second = service.execute('q_1', 'SELECT 2;', 'statement');
		await bridge.flush();
		const sentBeforeRelease = bridge.pending(NyalaRuntimeCommand.QueryExecute).length;

		releaseGate.complete();
		await bridge.flush();
		assert.strictEqual(bridge.pending(NyalaRuntimeCommand.ResultRelease).length, 3, 'every evicted handle has a release call');
		// Eviction releases several handles; every one must be answered before quota is recovered.
		for (const release of bridge.pending(NyalaRuntimeCommand.ResultRelease)) {
			release.answer.complete({ ok: true, runtimeGeneration: 1, result: { released: true } });
		}
		// The release chain (then/catch/finally, allSettled, the execute continuation) is several
		// microtask turns deep; flush it deterministically rather than sleeping.
		await bridge.flush();
		await bridge.flush();
		const third = bridge.pending(NyalaRuntimeCommand.QueryExecute);
		assert.strictEqual(third.length, 2, 'the run is sent only after every release settled');
		third[third.length - 1]?.answer.complete({ ok: true, runtimeGeneration: 1, result: { executionId: 'ex_2', state: 'queued', sequence: 1 } });
		const result = await second;

		assert.deepStrictEqual({ sentBeforeRelease, ok: result.ok, pendingReleases: service.pendingReleaseCount }, {
			sentBeforeRelease: 1,
			ok: true,
			pendingReleases: 0,
		});
	});

	//#endregion

	//#region IPC failures and convergence

	test('a rejected execute promise leaves the run unknown, never queued', async () => {
		await boundTab('q_1');
		const { promise, request } = await start('q_1');
		request.answer.error(new Error('ipc closed'));

		const result = await promise;

		assert.deepStrictEqual({ ok: result.ok, state: service.getExecution('q_1')?.state, reason: service.getExecution('q_1')?.unknownReason }, {
			ok: false,
			state: 'unknown',
			reason: 'reply-lost',
		});
	});

	test('a rejected cancel promise leaves the run unknown instead of hanging', async () => {
		await running();
		const cancelling = service.cancel('ex_1');
		await bridge.flush();
		bridge.pending(NyalaRuntimeCommand.QueryCancel)[0].answer.error(new Error('ipc closed'));
		await cancelling;

		assert.deepStrictEqual({ state: service.getExecution('q_1')?.state, reason: service.getExecution('q_1')?.unknownReason }, { state: 'unknown', reason: 'reply-lost' });
	});

	test('a cancel reply that only says completed recovers its result ids through getState', async () => {
		await running();
		const cancelling = service.cancel('ex_1');
		await bridge.flush();
		bridge.pending(NyalaRuntimeCommand.QueryCancel)[0].answer.complete({ ok: true, runtimeGeneration: 1, result: { accepted: false, state: 'completed' } });
		await cancelling;
		await bridge.flush();
		const calibration = bridge.pending(NyalaRuntimeCommand.QueryGetState);
		assert.strictEqual(calibration.length, 1, 'a terminal cancel reply without result ids asks for the metadata once');
		calibration[0].answer.complete({ ok: true, runtimeGeneration: 1, result: { executionId: 'ex_1', state: 'completed', sequence: 3, resultIds: ['rs_1'] } });
		await bridge.flush();

		assert.deepStrictEqual({ state: service.getExecution('q_1')?.state, results: service.getExecution('q_1')?.resultIds, acquirable: service.acquireResult('ex_1', 'rs_1') !== undefined }, {
			state: 'completed',
			results: ['rs_1'],
			acquirable: true,
		});
	});

	test('a late fetchPage answer is discarded when the generation changed while it was in flight', async () => {
		await boundTab('q_1');
		await running();
		bridge.queryChanges.fire(stateEvent('ex_1', 'completed', 3, { resultIds: ['rs_1'] }));
		await bridge.flush();
		const lease = service.acquireResult('ex_1', 'rs_1')!;
		const fetching = service.fetchPage(lease, null, 10);
		await bridge.flush();

		connections.setRuntime({ generation: 2, status: 'ready' });
		await bridge.flush();
		bridge.pending(NyalaRuntimeCommand.ResultFetchPage)[0].answer.complete({ ok: true, runtimeGeneration: 1, result: { columns: [], rows: [[{ type: 'null' }]], hasMore: false, nextCursor: null } });

		await assert.rejects(() => fetching, /no longer available/);
	});

	test('a released lease cannot read a page', async () => {
		await boundTab('q_1');
		await running();
		bridge.queryChanges.fire(stateEvent('ex_1', 'completed', 3, { resultIds: ['rs_1'] }));
		await bridge.flush();
		const lease = service.acquireResult('ex_1', 'rs_1')!;
		lease.dispose();
		await bridge.flush();

		await assert.rejects(() => service.fetchPage(lease, null, 10), /no longer available/);
	});

	//#endregion
});
