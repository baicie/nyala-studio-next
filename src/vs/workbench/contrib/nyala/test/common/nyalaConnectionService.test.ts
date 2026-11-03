/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { INyalaRuntimeCallResult, INyalaRuntimeState, NyalaRuntimeCommand } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeIpc.js';
import { NyalaRequestError } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeRequest.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { INyalaConnectionService, INyalaRuntimeBridge, NyalaConnectionService, NYALA_PROFILES_STORAGE_KEY, PROFILE_ID_PATTERN, parseStoredProfiles } from '../../connections/common/nyalaConnectionService.js';

/**
 * A bridge that answers the commands the Connections service uses and records what it was asked.
 * A command may be held (`defer`) so a test can interleave two attempts against one service; the
 * held reply is delivered only when the test decides, which is how an overlapping connect, a
 * restart during a connect and a disconnect during a connect are staged deterministically.
 */
class FakeBridge implements INyalaRuntimeBridge {

	declare readonly _serviceBrand: undefined;

	readonly calls: { command: string; params: unknown }[] = [];
	readonly states = new Emitter<INyalaRuntimeState>();
	readonly onDidChangeState = this.states.event;
	state: INyalaRuntimeState = { generation: 1, status: 'ready' };
	/** Per-command answer; the default succeeds. */
	readonly answers = new Map<string, INyalaRuntimeCallResult>();
	/** Per-command gate: while set, `call` waits for it. */
	private readonly gates = new Map<string, DeferredPromise<void>>();
	/** Session ids handed out, so two opens are distinguishable. */
	private opens = 0;

	async getState(): Promise<INyalaRuntimeState> {
		return this.state;
	}

	/** Holds every later call of `command` until `release`. */
	hold(command: NyalaRuntimeCommand): DeferredPromise<void> {
		const gate = new DeferredPromise<void>();
		this.gates.set(command, gate);
		return gate;
	}

	async call<T>(command: NyalaRuntimeCommand, params: object): Promise<INyalaRuntimeCallResult<T>> {
		this.calls.push({ command, params });
		const gate = this.gates.get(command);
		if (gate) {
			this.gates.delete(command);
			await gate.p;
		}
		const answer = this.answers.get(command);
		if (answer) {
			return answer as INyalaRuntimeCallResult<T>;
		}
		switch (command) {
			case NyalaRuntimeCommand.TestConnection:
				return { ok: true, runtimeGeneration: this.state.generation, result: { ok: true, elapsedMs: 1 } } as INyalaRuntimeCallResult<T>;
			case NyalaRuntimeCommand.OpenConnection:
				this.opens++;
				return { ok: true, runtimeGeneration: this.state.generation, result: { sessionId: `s_${this.opens}`, sessionGeneration: 1, capabilities: {} } } as INyalaRuntimeCallResult<T>;
			case NyalaRuntimeCommand.CloseConnection:
				return { ok: true, runtimeGeneration: this.state.generation, result: { closed: true } } as INyalaRuntimeCallResult<T>;
			case NyalaRuntimeCommand.ListObjects:
				return {
					ok: true,
					runtimeGeneration: this.state.generation,
					result: { objects: [{ name: 'customers', kind: 'table', schema: 'main' }, { name: 'recent_orders', kind: 'view', schema: 'main' }, { name: 'customers_by_name', kind: 'index', schema: 'main' }], hasMore: false, nextCursor: null },
				} as INyalaRuntimeCallResult<T>;
			case NyalaRuntimeCommand.DescribeObject:
				return { ok: true, runtimeGeneration: this.state.generation, result: { columns: [{ ordinal: 0, name: 'id', nativeType: 'INTEGER', nullable: false, primaryKey: true }] } } as INyalaRuntimeCallResult<T>;
			default:
				throw new Error(`unexpected command ${command}`);
		}
	}

	/** The commands sent since `from`. */
	commands(from = 0): string[] {
		return this.calls.slice(from).map(call => call.command);
	}

	dispose(): void {
		this.states.dispose();
	}
}

const PROFILE = { displayName: 'demo.sqlite', target: { driver: 'sqlite' as const, path: '/tmp/demo.sqlite', readOnly: true } };

/** The profile a stored entry would have, as `restoreProfiles` rebuilds it. */
function storedProfile(profileId: string, path: string, displayName = 'demo.sqlite') {
	return { profileId, displayName, path, readOnly: true };
}

suite('Nyala connection service', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let bridge: FakeBridge;
	let storage: TestStorageService;
	let service: NyalaConnectionService;

	/** The service under test, with a storage the test may seed before construction. */
	function createService(): NyalaConnectionService {
		return store.add(new NyalaConnectionService(bridge, new NullLogService(), storage));
	}

	/** Adds a profile and returns the id the service assigned, which is its identity. */
	async function addProfile(target = PROFILE, instance: INyalaConnectionService = service): Promise<string> {
		return instance.addProfile(target);
	}

	setup(() => {
		bridge = store.add(new FakeBridge());
		storage = store.add(new TestStorageService());
		service = createService();
	});

	/**
	 * The tree reads `connections[0]` in tests where one profile exists; with more than one, this
	 * resolves the row by id instead of by order.
	 */
	function stateOf(profileId: string): INyalaConnectionService['connections'][number] {
		const state = service.connections.find(candidate => candidate.profile.profileId === profileId);
		assert.ok(state, `no connection for ${profileId}`);
		return state;
	}

	//#region Connect / disconnect

	test('connect tests, opens and loads the catalog in that order', async () => {
		const profileId = await addProfile();
		await service.connect(profileId);

		assert.deepStrictEqual(bridge.commands(), [NyalaRuntimeCommand.TestConnection, NyalaRuntimeCommand.OpenConnection, NyalaRuntimeCommand.ListObjects]);
		const state = stateOf(profileId);
		assert.strictEqual(state.status, 'connected');
		assert.deepStrictEqual(state.handle, { profileId, sessionId: 's_1', sessionGeneration: 1, runtimeGeneration: 1 });
		assert.deepStrictEqual(service.catalog(profileId), { tables: ['customers'], views: ['recent_orders'], indexes: ['customers_by_name'] });
	});

	test('a failed test stops the connect before a session is opened', async () => {
		bridge.answers.set(NyalaRuntimeCommand.TestConnection, {
			ok: false,
			runtimeGeneration: 1,
			error: { code: -32602, message: 'Invalid database', data: { kind: 'INVALID_PARAMS', retryable: false, safeDetail: 'file is not a SQLite database' } },
		});
		const profileId = await addProfile();
		await service.connect(profileId);

		assert.deepStrictEqual(bridge.commands(), [NyalaRuntimeCommand.TestConnection]);
		const state = stateOf(profileId);
		assert.strictEqual(state.status, 'error');
		assert.strictEqual(state.handle, undefined);
		assert.ok(state.error && 'data' in state.error && state.error.data.kind === 'INVALID_PARAMS');
	});

	test('disconnect closes the session and clears the catalog', async () => {
		const profileId = await addProfile();
		await service.connect(profileId);
		await service.disconnect(profileId);

		assert.strictEqual(bridge.calls.at(-1)?.command, NyalaRuntimeCommand.CloseConnection);
		assert.deepStrictEqual(bridge.calls.at(-1)?.params, { sessionId: 's_1', sessionGeneration: 1 });
		assert.strictEqual(stateOf(profileId).status, 'disconnected');
		assert.strictEqual(service.catalog(profileId), undefined);
	});

	test('metadata reads carry the session identity and refuse a stale runtime generation', async () => {
		const profileId = await addProfile();
		await service.connect(profileId);
		const handle = stateOf(profileId).handle!;

		const listed = await service.listObjects(handle, ['table']);
		assert.strictEqual(listed.objects.length, 3);
		assert.deepStrictEqual(bridge.calls.at(-1)?.params, { sessionId: 's_1', sessionGeneration: 1, kinds: ['table'], limit: 1000 });

		const described = await service.describe(handle, { name: 'customers' });
		assert.strictEqual(described.columns[0].name, 'id');

		// A restart is a new generation; the old handle must not reach the new process.
		bridge.state = { generation: 2, status: 'ready' };
		bridge.states.fire(bridge.state);
		await assert.rejects(() => service.listObjects(handle, ['table']), NyalaRequestError);
	});

	test('a runtime restart marks connections lost and forgets their catalog', async () => {
		const profileId = await addProfile();
		await service.connect(profileId);

		bridge.state = { generation: 2, status: 'ready' };
		bridge.states.fire(bridge.state);

		assert.strictEqual(stateOf(profileId).status, 'lost');
		assert.strictEqual(stateOf(profileId).handle, undefined);
		assert.strictEqual(service.catalog(profileId), undefined);
	});

	test('a failed runtime takes connected and in-flight rows away from the tree', async () => {
		const connected = await addProfile();
		await service.connect(connected);
		const connecting = await addProfile({ displayName: 'other.sqlite', target: { driver: 'sqlite', path: '/tmp/other.sqlite', readOnly: true } });
		const testHeld = bridge.hold(NyalaRuntimeCommand.TestConnection);
		const pending = service.connect(connecting);

		bridge.state = { generation: 1, status: 'failed', reason: 'crashed' };
		bridge.states.fire(bridge.state);
		testHeld.complete();
		await pending;

		assert.deepStrictEqual(
			{ connected: stateOf(connected).status, connecting: stateOf(connecting).status },
			{ connected: 'lost', connecting: 'lost' },
			'a runtime that cannot answer offers no usable session',
		);
	});

	test('an unreadable catalog closes the session it opened instead of leaking it', async () => {
		bridge.answers.set(NyalaRuntimeCommand.ListObjects, {
			ok: false,
			runtimeGeneration: 1,
			error: { code: -32011, message: 'mismatch', data: { kind: 'PROTOCOL_MISMATCH', retryable: false } },
		});
		const profileId = await addProfile();
		await service.connect(profileId);

		assert.deepStrictEqual(bridge.commands(), [NyalaRuntimeCommand.TestConnection, NyalaRuntimeCommand.OpenConnection, NyalaRuntimeCommand.ListObjects, NyalaRuntimeCommand.CloseConnection]);
		const state = stateOf(profileId);
		assert.strictEqual(state.status, 'error');
		assert.strictEqual(state.handle, undefined, 'a session nobody can use is not left open');
		assert.strictEqual(service.catalog(profileId), undefined);
	});

	test('a catalog the runtime will not close keeps a handle Disconnect can retry', async () => {
		bridge.answers.set(NyalaRuntimeCommand.ListObjects, {
			ok: false,
			runtimeGeneration: 1,
			error: { code: -32603, message: 'internal', data: { kind: 'INTERNAL', retryable: false } },
		});
		bridge.answers.set(NyalaRuntimeCommand.CloseConnection, {
			ok: false,
			runtimeGeneration: 1,
			error: { code: -32603, message: 'internal', data: { kind: 'INTERNAL', retryable: false } },
		});
		const profileId = await addProfile();
		await service.connect(profileId);

		const state = stateOf(profileId);
		assert.strictEqual(state.status, 'error');
		assert.deepStrictEqual(state.handle, { profileId, sessionId: 's_1', sessionGeneration: 1, runtimeGeneration: 1 });

		// Disconnect still releases it once the runtime cooperates.
		bridge.answers.delete(NyalaRuntimeCommand.CloseConnection);
		await service.disconnect(profileId);
		assert.strictEqual(stateOf(profileId).status, 'disconnected');
		assert.strictEqual(stateOf(profileId).handle, undefined);
	});

	//#endregion

	//#region Overlapping attempts

	/** Lets the pending attempt reach its held call before the test stages the next event. */
	async function settle(): Promise<void> {
		await timeout(0);
		await timeout(0);
	}

	test('two overlapping connects leave exactly one session, and the other is closed', async () => {
		const profileId = await addProfile();
		const openHeld = bridge.hold(NyalaRuntimeCommand.OpenConnection);
		const first = service.connect(profileId);
		await settle();
		// The second connect starts while the first is waiting for its open reply.
		const second = service.connect(profileId);
		await settle();
		openHeld.complete();
		await Promise.all([first, second]);

		// Both attempts opened a session; the one the superseded attempt opened is closed rather
		// than left unreferenced on a runtime nobody tracks. The reply order is the bridge's, so the
		// assertion is about counts and identity, not about which id came first.
		const state = stateOf(profileId);
		assert.strictEqual(state.status, 'connected');
		const closes = bridge.calls.filter(call => call.command === NyalaRuntimeCommand.CloseConnection);
		assert.deepStrictEqual(closes.map(call => (call.params as { sessionId: string }).sessionId), [state.handle!.sessionId === 's_1' ? 's_2' : 's_1'], 'only the session the row does not own was closed');
		assert.strictEqual(bridge.calls.filter(call => call.command === NyalaRuntimeCommand.OpenConnection).length, 2, 'both attempts opened a session');
	});

	test('a runtime restart during connect resolves to a lost row, not a session', async () => {
		const profileId = await addProfile();
		const openHeld = bridge.hold(NyalaRuntimeCommand.OpenConnection);
		const pending = service.connect(profileId);
		await settle();

		// The restart lands while the open is in flight. The reply that comes back belongs to a
		// process the renderer no longer knows, so its session must be closed.
		bridge.state = { generation: 2, status: 'ready' };
		bridge.states.fire(bridge.state);
		openHeld.complete();
		await pending;

		const state = stateOf(profileId);
		assert.strictEqual(state.status, 'lost');
		assert.strictEqual(state.handle, undefined);
		const closes = bridge.calls.filter(call => call.command === NyalaRuntimeCommand.CloseConnection);
		assert.deepStrictEqual(closes.map(call => (call.params as { sessionId: string }).sessionId), ['s_1'], 'the late session was released');
	});

	test('a disconnect during connect wins and the late session is closed', async () => {
		const profileId = await addProfile();
		const openHeld = bridge.hold(NyalaRuntimeCommand.OpenConnection);
		const connecting = service.connect(profileId);
		await settle();
		const disconnecting = service.disconnect(profileId);
		openHeld.complete();
		await Promise.all([connecting, disconnecting]);

		assert.strictEqual(stateOf(profileId).status, 'disconnected');
		assert.strictEqual(stateOf(profileId).handle, undefined);
		assert.ok(
			bridge.calls.some(call => call.command === NyalaRuntimeCommand.CloseConnection && (call.params as { sessionId?: string }).sessionId === 's_1'),
			'the session the superseded connect opened is closed',
		);
	});

	test('reconnecting closes the old session before opening the next one', async () => {
		const profileId = await addProfile();
		await service.connect(profileId);
		const before = bridge.calls.length;
		await service.connect(profileId);

		assert.deepStrictEqual(bridge.commands(before), [NyalaRuntimeCommand.CloseConnection, NyalaRuntimeCommand.TestConnection, NyalaRuntimeCommand.OpenConnection, NyalaRuntimeCommand.ListObjects]);
		assert.strictEqual(stateOf(profileId).handle?.sessionId, 's_2');
	});

	test('a reconnect that cannot close the old session keeps it instead of opening a second one', async () => {
		const profileId = await addProfile();
		await service.connect(profileId);
		bridge.answers.set(NyalaRuntimeCommand.CloseConnection, {
			ok: false,
			runtimeGeneration: 1,
			error: { code: -32603, message: 'internal', data: { kind: 'INTERNAL', retryable: false } },
		});
		const before = bridge.calls.length;
		await service.connect(profileId);

		assert.deepStrictEqual(bridge.commands(before), [NyalaRuntimeCommand.CloseConnection], 'no second session is opened');
		const state = stateOf(profileId);
		assert.strictEqual(state.status, 'error');
		assert.deepStrictEqual(state.handle, { profileId, sessionId: 's_1', sessionGeneration: 1, runtimeGeneration: 1 });
		assert.ok(state.error && 'message' in state.error && state.error.message.includes('could not be closed'));
	});

	test('a bridge that throws after opening releases the session it opened', async () => {
		const profileId = await addProfile();
		const original = bridge.call.bind(bridge);
		bridge.call = async <T>(command: NyalaRuntimeCommand, params: object): Promise<INyalaRuntimeCallResult<T>> => {
			if (command === NyalaRuntimeCommand.ListObjects) {
				throw new Error('the IPC channel closed');
			}
			return original<T>(command, params);
		};

		await service.connect(profileId);

		const state = stateOf(profileId);
		assert.strictEqual(state.status, 'error');
		assert.strictEqual(state.handle, undefined);
		assert.ok(state.error && 'message' in state.error && state.error.message === 'the IPC channel closed');
		assert.ok(
			bridge.calls.some(call => call.command === NyalaRuntimeCommand.CloseConnection),
			'the session is not left on the runtime',
		);
	});

	test('a structured rejection produces a readable message, not [object Object]', async () => {
		const profileId = await addProfile();
		const structured = { code: -32010, message: 'session gone', data: { kind: 'INVALID_SESSION', retryable: false, safeDetail: 'the session no longer exists' } };
		const original = bridge.call.bind(bridge);
		bridge.call = async <T>(command: NyalaRuntimeCommand, params: object): Promise<INyalaRuntimeCallResult<T>> => {
			if (command === NyalaRuntimeCommand.TestConnection) {
				throw structured;
			}
			return original<T>(command, params);
		};

		await service.connect(profileId);

		const state = stateOf(profileId);
		assert.strictEqual(state.status, 'error');
		assert.deepStrictEqual(state.error, structured, 'the structured error survives for the UI to branch on');
	});

	//#endregion

	//#region Profile identity

	test('a profile gets a stable id that does not depend on its path', async () => {
		const profileId = await addProfile();
		assert.match(profileId, PROFILE_ID_PATTERN);
		assert.ok(!profileId.includes('tmp'), 'the id carries no path text');
		assert.ok(!profileId.includes('demo'), 'the id carries no file name');
	});

	test('two paths that a lossy scheme would merge keep distinct ids', async () => {
		// The old scheme replaced every non-alphanumeric character with `_`, so these two paths
		// produced the same id and the second profile silently replaced the first.
		const first = await addProfile({ displayName: 'a-b', target: { driver: 'sqlite', path: '/data/a-b.sqlite', readOnly: true } });
		const second = await addProfile({ displayName: 'a/b', target: { driver: 'sqlite', path: '/data/a/b.sqlite', readOnly: true } });

		assert.notStrictEqual(first, second);
		assert.strictEqual(service.connections.length, 2);
		assert.deepStrictEqual(service.connections.map(state => state.profile.target.path), ['/data/a-b.sqlite', '/data/a/b.sqlite']);
	});

	test('adding the same path twice returns the existing identity and adds no row', async () => {
		const first = await addProfile();
		const second = await addProfile();

		assert.strictEqual(second, first);
		assert.strictEqual(service.connections.length, 1);
	});

	test('the same file name in two directories is two profiles', async () => {
		const first = await addProfile({ displayName: 'demo.sqlite', target: { driver: 'sqlite', path: '/one/demo.sqlite', readOnly: true } });
		const second = await addProfile({ displayName: 'demo.sqlite', target: { driver: 'sqlite', path: '/two/demo.sqlite', readOnly: true } });

		assert.notStrictEqual(first, second);
		assert.deepStrictEqual(service.connections.map(state => state.profile.displayName), ['demo.sqlite', 'demo.sqlite']);
	});

	test('two profiles stay independent through connect and disconnect', async () => {
		const first = await addProfile({ displayName: 'one', target: { driver: 'sqlite', path: '/one.sqlite', readOnly: true } });
		const second = await addProfile({ displayName: 'two', target: { driver: 'sqlite', path: '/two.sqlite', readOnly: true } });
		await service.connect(first);
		await service.connect(second);
		await service.disconnect(first);

		assert.strictEqual(stateOf(first).status, 'disconnected');
		assert.strictEqual(stateOf(second).status, 'connected');
		assert.notStrictEqual(stateOf(second).handle?.sessionId, undefined);
	});

	test('profiles survive a restart of the service with their identity, and sessions do not', async () => {
		const profileId = await addProfile();
		await service.connect(profileId);

		// A reload builds a new service over the same storage; the row comes back disconnected.
		service.dispose();
		service = createService();
		await service.restoreProfiles();

		const restored = service.connections.find(state => state.profile.profileId === profileId);
		assert.ok(restored, 'the id is stable across windows');
		assert.strictEqual(restored.status, 'disconnected');
		assert.strictEqual(restored.handle, undefined);
		assert.strictEqual(restored.profile.target.path, PROFILE.target.path);
	});

	test('a second restore does not replace a live row or forget its session', async () => {
		storage.store(NYALA_PROFILES_STORAGE_KEY, JSON.stringify([storedProfile('p_00000000-0000-4000-8000-000000000001', '/tmp/demo.sqlite')]), StorageScope.PROFILE, StorageTarget.USER);
		await service.restoreProfiles();
		const profileId = service.connections[0].profile.profileId;
		await service.connect(profileId);

		await service.restoreProfiles();

		assert.strictEqual(service.connections.length, 1);
		assert.strictEqual(stateOf(profileId).status, 'connected');
		assert.ok(stateOf(profileId).handle);
	});

	test('legacy path-derived ids are re-keyed once and the new id is written back', async () => {
		const legacy = [
			{ profileId: 'p__data_a_b_sqlite', displayName: 'a-b', path: '/data/a-b.sqlite', readOnly: true },
			{ profileId: 'p__data_a_b_sqlite', displayName: 'a/b', path: '/data/a/b.sqlite', readOnly: true },
		];
		storage.store(NYALA_PROFILES_STORAGE_KEY, JSON.stringify(legacy), StorageScope.PROFILE, StorageTarget.USER);

		await service.restoreProfiles();

		const ids = service.connections.map(state => state.profile.profileId);
		assert.strictEqual(new Set(ids).size, 2, 'a colliding legacy id cannot merge two paths');
		for (const id of ids) {
			assert.match(id, PROFILE_ID_PATTERN);
		}
		const written = parseStoredProfiles(storage.get(NYALA_PROFILES_STORAGE_KEY, StorageScope.PROFILE, ''));
		assert.deepStrictEqual(written.map(entry => entry.profileId), ids, 'the migration is persisted');
	});

	test('an already migrated store is not rewritten on every restore', async () => {
		const profileId = await addProfile();
		const before = storage.get(NYALA_PROFILES_STORAGE_KEY, StorageScope.PROFILE, '');
		service.dispose();

		service = createService();
		await service.restoreProfiles();

		assert.strictEqual(service.connections[0].profile.profileId, profileId);
		assert.strictEqual(storage.get(NYALA_PROFILES_STORAGE_KEY, StorageScope.PROFILE, ''), before, 'a stable store is left alone');
	});

	test('a profile becomes a disconnected row and adds no session', async () => {
		const before = bridge.calls.length;
		const profileId = await addProfile({ displayName: 'x.sqlite', target: { driver: 'sqlite', path: '/tmp/x.sqlite', readOnly: false } });
		assert.strictEqual(stateOf(profileId).status, 'disconnected');
		assert.strictEqual(stateOf(profileId).handle, undefined);
		assert.strictEqual(bridge.calls.length, before, 'adding a profile talks to no runtime');
	});

	test('stored profiles are parsed defensively', () => {
		assert.deepStrictEqual(parseStoredProfiles(undefined), []);
		assert.deepStrictEqual(parseStoredProfiles('not json'), []);
		assert.deepStrictEqual(parseStoredProfiles('{"a":1}'), []);
		assert.deepStrictEqual(
			parseStoredProfiles(JSON.stringify([{ profileId: 'p_1', displayName: 'a', path: '/a', readOnly: true }, { profileId: 1 }])),
			[{ profileId: 'p_1', displayName: 'a', path: '/a', readOnly: true }],
		);
	});

	//#endregion

	//#region Refresh

	test('refresh reloads the catalog of connected profiles only', async () => {
		const profileId = await addProfile();
		const before = bridge.calls.length;
		await service.refresh(profileId);
		assert.strictEqual(bridge.calls.length, before, 'a disconnected profile is not queried');
		await service.connect(profileId);
		const connected = bridge.calls.length;
		await service.refresh(profileId);
		assert.strictEqual(bridge.calls.length, connected + 1);
		assert.strictEqual(bridge.calls[bridge.calls.length - 1].command, NyalaRuntimeCommand.ListObjects);
	});

	test('a refresh that overlaps a disconnect cannot restore the old catalog', async () => {
		const profileId = await addProfile();
		await service.connect(profileId);
		const listHeld = bridge.hold(NyalaRuntimeCommand.ListObjects);
		const refreshing = service.refresh(profileId);
		await service.disconnect(profileId);
		listHeld.complete();
		await refreshing;

		assert.strictEqual(stateOf(profileId).status, 'disconnected');
		assert.strictEqual(service.catalog(profileId), undefined, 'a superseded refresh commits nothing');
	});

	test('a refresh failure is shown on the row and leaves the handle alone', async () => {
		const profileId = await addProfile();
		await service.connect(profileId);
		bridge.answers.set(NyalaRuntimeCommand.ListObjects, {
			ok: false,
			runtimeGeneration: 1,
			error: { code: -32011, message: 'mismatch', data: { kind: 'PROTOCOL_MISMATCH', retryable: false } },
		});
		await service.refresh(profileId);

		const state = stateOf(profileId);
		assert.strictEqual(state.status, 'error');
		assert.strictEqual(service.catalog(profileId), undefined);
		assert.ok(!state.handle, 'a failed refresh does not claim the session is usable');
	});

	//#endregion

	//#region Dispose

	test('disposing the service stops committing replies to a dead row set', async () => {
		const profileId = await addProfile();
		const listHeld = bridge.hold(NyalaRuntimeCommand.ListObjects);
		const connecting = service.connect(profileId);
		service.dispose();
		listHeld.complete();
		await connecting;
		// Nothing observes a disposed service any more; a settle here is enough, and the deferred
		// reply must not throw into an unhandled rejection.
		await timeout(0);
	});

	//#endregion
});
