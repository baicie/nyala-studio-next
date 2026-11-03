/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// N-202 acceptance tests for the query context: the object that decides what one query tab may
// execute against. These are the isolation guarantees, not the editor UI: two tabs never share a
// mutable target, a runtime restart or a disconnect voids every binding, and a tab is only ever
// rebound by an explicit call for that tab.

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INyalaRuntimeState } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeIpc.js';
import { INyalaCatalog, INyalaConnectionHandle, INyalaConnectionService, INyalaConnectionState } from '../../connections/common/nyalaConnectionService.js';
import { INyalaQueryBindingResult, NyalaQueryContext } from '../../query/common/nyalaQueryContext.js';
import { NyalaQueryContextService } from '../../query/common/nyalaQueryContextService.js';

/** A connection service the test drives row by row; no runtime, no IPC. */
class FakeConnectionService implements INyalaConnectionService {

	declare readonly _serviceBrand: undefined;

	readonly changes = new Emitter<void>();
	readonly onDidChangeConnections = this.changes.event;
	readonly runtimeChanges = new Emitter<INyalaRuntimeState>();
	readonly onDidChangeRuntime = this.runtimeChanges.event;

	rows: INyalaConnectionState[] = [];
	runtimeState: INyalaRuntimeState = { generation: 1, status: 'ready' };
	readonly calls: string[] = [];
	/** The session id the next `connect` opens, so a reconnect is visibly a new one. */
	private opens = 0;

	get connections(): readonly INyalaConnectionState[] {
		return this.rows;
	}

	async addProfile(): Promise<string> {
		throw new Error('profiles are seeded by the test');
	}

	async restoreProfiles(): Promise<void> { }

	async refreshRuntime(): Promise<INyalaRuntimeState> {
		return this.runtimeState;
	}

	async connect(profileId: string): Promise<void> {
		this.calls.push(`connect:${profileId}`);
		// The session belongs to the runtime that accepted the open, so the generation is captured
		// before any wait: a restart while the open is in flight leaves the row holding a session
		// from the runtime that died, exactly as the real supervisor would.
		const issuedBy = this.runtimeState.generation;
		// A gate lets a test decide when a connect finishes, so two overlapping binds can be
		// completed in the opposite order to the one they were started in.
		const gate = this.gates.get(profileId);
		if (gate) {
			this.gates.delete(profileId);
			await gate.p;
		}
		const row = this.rows.find(state => state.profile.profileId === profileId);
		if (!row) {
			return;
		}
		this.opens++;
		this.setRow({ ...row, status: 'connected', error: undefined, handle: { profileId, sessionId: `s_${this.opens}`, sessionGeneration: 1, runtimeGeneration: issuedBy } });
	}

	/** Holds the next `connect` of a profile until the returned promise completes. */
	readonly gates = new Map<string, DeferredPromise<void>>();
	holdConnect(profileId: string): DeferredPromise<void> {
		const gate = new DeferredPromise<void>();
		this.gates.set(profileId, gate);
		return gate;
	}

	async disconnect(profileId: string): Promise<void> {
		this.calls.push(`disconnect:${profileId}`);
		const row = this.rows.find(state => state.profile.profileId === profileId);
		if (row) {
			this.setRow({ ...row, status: 'disconnected', handle: undefined });
		}
	}

	async refresh(profileId: string): Promise<void> {
		this.calls.push(`refresh:${profileId}`);
	}

	catalog(): INyalaCatalog | undefined {
		return undefined;
	}

	async listObjects(): Promise<never> {
		throw new Error('not used');
	}

	async describe(): Promise<never> {
		throw new Error('not used');
	}

	setRow(row: INyalaConnectionState): void {
		this.rows = this.rows.map(state => state.profile.profileId === row.profile.profileId ? row : state);
		this.changes.fire();
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

function row(profileId: string, status: INyalaConnectionState['status'], handle?: INyalaConnectionHandle, error?: INyalaConnectionState['error']): INyalaConnectionState {
	return {
		profile: { profileId, displayName: `${profileId}.sqlite`, target: { driver: 'sqlite', path: `/tmp/${profileId}.sqlite`, readOnly: true } },
		status,
		handle,
		error,
	};
}

function connected(profileId: string, sessionId: string, generation = 1): INyalaConnectionState {
	return row(profileId, 'connected', { profileId, sessionId, sessionGeneration: 1, runtimeGeneration: generation });
}

suite('Nyala query context', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let connections: FakeConnectionService;
	let service: NyalaQueryContextService;

	function createService(): NyalaQueryContextService {
		return store.add(new NyalaQueryContextService(connections, new NullLogService()));
	}

	async function bind(context: NyalaQueryContext, profileId: string): Promise<INyalaQueryBindingResult> {
		return service.bind(context, profileId);
	}

	setup(() => {
		connections = store.add(new FakeConnectionService());
		service = createService();
	});

	test('two tabs bound to different profiles stay isolated through activation and rebinding', async () => {
		connections.rows = [connected('p_a', 's_a'), connected('p_b', 's_b')];
		const tabA = service.create();
		const tabB = service.create();

		assert.deepStrictEqual([await bind(tabA, 'p_a'), await bind(tabB, 'p_b')].map(result => result.ok), [true, true]);
		assert.notStrictEqual(tabA, tabB);
		assert.deepStrictEqual({
			a: tabA.binding && { profile: tabA.binding.profileId, session: tabA.binding.sessionId },
			b: tabB.binding && { profile: tabB.binding.profileId, session: tabB.binding.sessionId },
		}, {
			a: { profile: 'p_a', session: 's_a' },
			b: { profile: 'p_b', session: 's_b' },
		});

		// Rebinding one tab is an explicit call for that tab; the other keeps its target.
		await bind(tabA, 'p_b');
		assert.deepStrictEqual({ a: tabA.profileId, b: tabB.profileId }, { a: 'p_b', b: 'p_b' });
		assert.strictEqual(tabB.binding?.sessionId, 's_b', 'tab B did not move when tab A was rebound');
	});

	test('two queries on the same profile are independent objects, and closing one does not unbind the other', async () => {
		connections.rows = [connected('p_a', 's_a')];
		const first = service.create();
		const second = service.create();
		await bind(first, 'p_a');
		await bind(second, 'p_a');

		assert.notStrictEqual(first, second);
		assert.strictEqual(first.binding?.sessionId, second.binding?.sessionId, 'both adopt the same single session');

		service.release(first.queryId);
		assert.strictEqual(service.get(first.queryId), undefined);
		assert.strictEqual(second.isBound, true);
		assert.strictEqual(service.get(second.queryId), second);
	});

	test('a runtime generation change voids every binding instead of carrying the session over', async () => {
		connections.rows = [connected('p_a', 's_a', 1)];
		const tab = service.create();
		await bind(tab, 'p_a');
		const reasons: string[] = [];
		store.add(tab.onDidChangeBinding(() => reasons.push(tab.unboundReason)));

		// The supervisor restarts; the new runtime has generation 2 and no sessions of its own.
		connections.setRuntime({ generation: 2, status: 'ready' });
		connections.setRow(row('p_a', 'lost', undefined, { message: 'The runtime restarted. Reconnect to continue.' }));

		assert.deepStrictEqual({
			bound: tab.isBound,
			reason: tab.unboundReason,
			canExecute: tab.canExecute(connections.runtimeState),
			events: reasons.length > 0,
		}, { bound: false, reason: 'runtime-restarted', canExecute: false, events: true });

		// A ready runtime at generation 2 does not make the old session valid again.
		connections.setRow(connected('p_a', 's_a', 2));
		assert.strictEqual(tab.isBound, false, 'the tab stays unbound until the user picks a connection again');
	});

	test('a failed runtime unbinds tabs with a reason a user can act on', async () => {
		connections.rows = [connected('p_a', 's_a')];
		const tab = service.create();
		await bind(tab, 'p_a');

		connections.setRuntime({ generation: 1, status: 'failed', reason: 'exit code 1' });

		assert.deepStrictEqual({ bound: tab.isBound, reason: tab.unboundReason }, { bound: false, reason: 'runtime-unavailable' });
	});

	test('disconnecting the profile unbinds the tabs bound to it, and only those', async () => {
		connections.rows = [connected('p_a', 's_a'), connected('p_b', 's_b')];
		const tabA = service.create();
		const tabB = service.create();
		await bind(tabA, 'p_a');
		await bind(tabB, 'p_b');

		connections.setRow(row('p_a', 'disconnected'));

		assert.deepStrictEqual({ a: tabA.isBound, aReason: tabA.unboundReason, b: tabB.isBound }, { a: false, aReason: 'connection-closed', b: true });
	});

	test('a reconnect behind a tab\'s back does not silently rebind it to the new session', async () => {
		connections.rows = [connected('p_a', 's_old')];
		const tab = service.create();
		await bind(tab, 'p_a');

		// Someone reconnects the profile: a new session id for the same profile.
		connections.setRow(connected('p_a', 's_new'));

		assert.deepStrictEqual({ bound: tab.isBound, reason: tab.unboundReason }, { bound: false, reason: 'connection-closed' });
	});

	test('a tab with no connection never adopts another profile\'s connection', async () => {
		connections.rows = [connected('p_a', 's_a')];
		const bound = service.create();
		await bind(bound, 'p_a');

		const other = service.create();
		// The service only binds the context it was asked about, and only to the profile named.
		assert.strictEqual(other.isBound, false);
		assert.strictEqual(other.profileId, undefined);
		assert.strictEqual(other.canExecute(connections.runtimeState), false);
		assert.strictEqual(bound.profileId, 'p_a');
	});

	test('binding to an unknown profile fails without touching the tab', async () => {
		connections.rows = [connected('p_a', 's_a')];
		const tab = service.create();

		const result = await bind(tab, 'p_missing');

		assert.deepStrictEqual({ ok: result.ok, message: result.ok ? undefined : result.message, bound: tab.isBound }, { ok: false, message: 'That connection does not exist.', bound: false });
	});

	test('binding to a profile that failed reports the runtime\'s safe detail', async () => {
		connections.rows = [row('p_a', 'error', undefined, { code: -32602, message: 'Invalid database', data: { kind: 'INVALID_PARAMS', retryable: false, safeDetail: 'file is not a SQLite database' } })];
		const tab = service.create();

		const result = await bind(tab, 'p_a');

		assert.deepStrictEqual({ ok: result.ok, message: result.ok ? undefined : result.message }, { ok: false, message: 'file is not a SQLite database' });
		assert.deepStrictEqual(connections.calls, [], 'a failed row is not reconnected behind the user\'s back');
	});

	test('binding to a disconnected profile connects it and adopts the session that connect opened', async () => {
		connections.rows = [row('p_a', 'disconnected')];
		const tab = service.create();

		const result = await bind(tab, 'p_a');

		assert.deepStrictEqual(connections.calls, ['connect:p_a']);
		assert.deepStrictEqual({
			ok: result.ok,
			session: tab.binding?.sessionId,
			generation: tab.runtimeGeneration,
			readOnly: tab.readOnly,
			canExecute: tab.canExecute(connections.runtimeState),
		}, { ok: true, session: 's_1', generation: 1, readOnly: true, canExecute: true });
	});

	test('binding to an already connected profile adopts its session instead of opening a second one', async () => {
		connections.rows = [connected('p_a', 's_existing')];
		const tab = service.create();

		await bind(tab, 'p_a');

		assert.deepStrictEqual(connections.calls, []);
		assert.strictEqual(tab.binding?.sessionId, 's_existing');
	});

	test('a released context cannot be bound through the service any more', async () => {
		connections.rows = [connected('p_a', 's_a')];
		const tab = service.create();
		service.release(tab.queryId);

		const result = await bind(tab, 'p_a');

		assert.deepStrictEqual({ ok: result.ok, message: result.ok ? undefined : result.message }, { ok: false, message: 'This query tab is no longer open.' });
	});

	//#region Binding isolation (latest intent wins)

	/** Runs microtasks and timers until the pending binds have settled. */
	async function settle(): Promise<void> {
		await timeout(0);
		await timeout(0);
	}

	test('a later bind wins even when an earlier one finishes last', async () => {
		connections.rows = [row('p_a', 'disconnected'), row('p_b', 'disconnected')];
		const tab = service.create('q_1');
		const slowA = connections.holdConnect('p_a');
		const fastB = connections.holdConnect('p_b');

		const first = bind(tab, 'p_a');
		await settle();
		const second = bind(tab, 'p_b');
		await settle();

		// B, the later intent, completes first; A completes afterwards with a session of its own.
		fastB.complete();
		const bResult = await second;
		slowA.complete();
		const aResult = await first;

		assert.deepStrictEqual({
			first: aResult.ok,
			second: bResult.ok,
			profile: tab.profileId,
			session: tab.binding?.sessionId,
		}, {
			first: false,
			second: true,
			profile: 'p_b',
			// B finished first, so its connect is the one that opened the first new session.
			session: 's_1',
		}, 'the late reply of the superseded bind cannot override the newer choice');
	});

	test('a late bind reply cannot bind a context that was released', async () => {
		connections.rows = [row('p_a', 'disconnected')];
		const tab = service.create('q_1');
		const gate = connections.holdConnect('p_a');
		const pending = bind(tab, 'p_a');
		await settle();

		service.release(tab.queryId);
		gate.complete();
		const result = await pending;

		assert.deepStrictEqual({ ok: result.ok, bound: tab.isBound, disposed: tab.isDisposed }, { ok: false, bound: false, disposed: true });
	});

	test('a late bind reply cannot pollute a new context that reuses the same query id', async () => {
		connections.rows = [row('p_a', 'disconnected')];
		const oldContext = service.create('q_1');
		const gate = connections.holdConnect('p_a');
		const pending = bind(oldContext, 'p_a');
		await settle();

		service.release('q_1');
		const newContext = service.create('q_1');
		gate.complete();
		const result = await pending;

		assert.deepStrictEqual({
			resultOk: result.ok,
			newBound: newContext.isBound,
			newBinding: newContext.binding,
			oldDisposed: oldContext.isDisposed,
		}, { resultOk: false, newBound: false, newBinding: undefined, oldDisposed: true }, 'the new object starts clean; the old reply is dropped');
	});

	test('a runtime restart while binding does not install the stale session', async () => {
		connections.rows = [row('p_a', 'disconnected')];
		const tab = service.create('q_1');
		const gate = connections.holdConnect('p_a');
		const pending = bind(tab, 'p_a');
		await settle();

		// The runtime restarts while the connect is in flight; the row that comes back claims a
		// session from generation 1, which the window no longer talks to.
		connections.runtimeState = { generation: 2, status: 'ready' };
		connections.runtimeChanges.fire(connections.runtimeState);
		gate.complete();
		const result = await pending;

		assert.deepStrictEqual({ ok: result.ok, bound: tab.isBound, reason: tab.unboundReason }, { ok: false, bound: false, reason: 'never-bound' });
	});

	test('a stale session is refused even when the row still reports it as connected', async () => {
		const tab = service.create('q_1');
		// A row from generation 1 was left behind; the runtime is already at generation 2.
		connections.rows = [connected('p_a', 's_old', 1)];
		connections.runtimeState = { generation: 2, status: 'ready' };

		const result = await bind(tab, 'p_a');

		assert.deepStrictEqual({ ok: result.ok, bound: tab.isBound }, { ok: false, bound: false });
	});

	test('rapid repeated choices leave the tab bound to the last one', async () => {
		connections.rows = [connected('p_a', 's_a'), connected('p_b', 's_b')];
		const tab = service.create('q_1');

		const results = await Promise.all([
			bind(tab, 'p_a'),
			bind(tab, 'p_b'),
			bind(tab, 'p_a'),
			bind(tab, 'p_b'),
		]);

		// None of these calls suspends (both rows are already connected), so each one commits before
		// the next is issued: the guarantee is that the tab ends on the last choice and never on a
		// mix. Supersession only has to drop replies that arrive late, which the gated test covers.
		assert.deepStrictEqual({
			profile: tab.profileId,
			session: tab.binding?.sessionId,
			successes: results.filter(result => result.ok).length,
		}, { profile: 'p_b', session: 's_b', successes: 4 }, 'the final state is the last choice');
	});

	test('a bind resolved after the tab closed reports failure instead of a binding', async () => {
		connections.rows = [connected('p_a', 's_a')];
		const tab = service.create('q_1');
		service.release('q_1');

		const result = await bind(tab, 'p_a');

		assert.deepStrictEqual({ ok: result.ok, bound: tab.isBound }, { ok: false, bound: false });
	});

	//#endregion

	test('create() returns the same context for the same query id, so a reopened tab keeps its target', () => {
		const first = service.create('q_1');
		const second = service.create('q_1');
		const third = service.create('q_2');

		assert.strictEqual(first, second);
		assert.notStrictEqual(first, third);
	});
});
