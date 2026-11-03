/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INyalaRuntimeCallResult, INyalaRuntimeState, NyalaRuntimeCommand } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeIpc.js';
import { NyalaRequestError } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeRequest.js';
import { INyalaRuntimeBridge, NyalaConnectionService, parseStoredProfiles } from '../../connections/common/nyalaConnectionService.js';

/** A bridge that answers the commands the Connections service uses and records what it was asked. */
class FakeBridge implements INyalaRuntimeBridge {

	declare readonly _serviceBrand: undefined;

	readonly calls: { command: string; params: unknown }[] = [];
	readonly states = new Emitter<INyalaRuntimeState>();
	readonly onDidChangeState = this.states.event;
	state: INyalaRuntimeState = { generation: 1, status: 'ready' };
	/** Per-command answer; the default succeeds. */
	readonly answers = new Map<string, INyalaRuntimeCallResult>();

	async getState(): Promise<INyalaRuntimeState> {
		return this.state;
	}

	async call<T>(command: NyalaRuntimeCommand, params: object): Promise<INyalaRuntimeCallResult<T>> {
		this.calls.push({ command, params });
		const answer = this.answers.get(command);
		if (answer) {
			return answer as INyalaRuntimeCallResult<T>;
		}
		switch (command) {
			case NyalaRuntimeCommand.TestConnection:
				return { ok: true, runtimeGeneration: this.state.generation, result: { ok: true, elapsedMs: 1 } } as INyalaRuntimeCallResult<T>;
			case NyalaRuntimeCommand.OpenConnection:
				return { ok: true, runtimeGeneration: this.state.generation, result: { sessionId: 's_1', sessionGeneration: 1, capabilities: {} } } as INyalaRuntimeCallResult<T>;
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

	dispose(): void {
		this.states.dispose();
	}
}

suite('Nyala connection service', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let bridge: FakeBridge;
	let service: NyalaConnectionService;

	setup(() => {
		bridge = store.add(new FakeBridge());
		service = store.add(new NyalaConnectionService(bridge, new NullLogService()));
	});

	const profile = { profileId: 'p_1', displayName: 'demo.sqlite', target: { driver: 'sqlite' as const, path: '/tmp/demo.sqlite', readOnly: true } };

	test('connect tests, opens and loads the catalog in that order', async () => {
		await service.addProfile(profile);
		await service.connect('p_1');

		assert.deepStrictEqual(bridge.calls.map(call => call.command), [NyalaRuntimeCommand.TestConnection, NyalaRuntimeCommand.OpenConnection, NyalaRuntimeCommand.ListObjects]);
		const state = service.connections[0];
		assert.strictEqual(state.status, 'connected');
		assert.deepStrictEqual(state.handle, { profileId: 'p_1', sessionId: 's_1', sessionGeneration: 1, runtimeGeneration: 1 });
		assert.deepStrictEqual(service.catalog('p_1'), { tables: ['customers'], views: ['recent_orders'], indexes: ['customers_by_name'] });
	});

	test('a failed test stops the connect before a session is opened', async () => {
		bridge.answers.set(NyalaRuntimeCommand.TestConnection, {
			ok: false,
			runtimeGeneration: 1,
			error: { code: -32602, message: 'Invalid database', data: { kind: 'INVALID_PARAMS', retryable: false, safeDetail: 'file is not a SQLite database' } },
		});
		await service.addProfile(profile);
		await service.connect('p_1');

		assert.deepStrictEqual(bridge.calls.map(call => call.command), [NyalaRuntimeCommand.TestConnection]);
		const state = service.connections[0];
		assert.strictEqual(state.status, 'error');
		assert.strictEqual(state.handle, undefined);
		assert.ok(state.error && 'data' in state.error && state.error.data.kind === 'INVALID_PARAMS');
	});

	test('disconnect closes the session and clears the catalog', async () => {
		await service.addProfile(profile);
		await service.connect('p_1');
		await service.disconnect('p_1');

		assert.strictEqual(bridge.calls.at(-1)?.command, NyalaRuntimeCommand.CloseConnection);
		assert.deepStrictEqual(bridge.calls.at(-1)?.params, { sessionId: 's_1', sessionGeneration: 1 });
		assert.strictEqual(service.connections[0].status, 'disconnected');
		assert.strictEqual(service.catalog('p_1'), undefined);
	});

	test('metadata reads carry the session identity and refuse a stale runtime generation', async () => {
		await service.addProfile(profile);
		await service.connect('p_1');
		const handle = service.connections[0].handle!;

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
		await service.addProfile(profile);
		await service.connect('p_1');

		bridge.state = { generation: 2, status: 'ready' };
		bridge.states.fire(bridge.state);

		assert.strictEqual(service.connections[0].status, 'lost');
		assert.strictEqual(service.connections[0].handle, undefined);
		assert.strictEqual(service.catalog('p_1'), undefined);
	});

	test('a profile becomes a disconnected row and adds no session', async () => {
		await service.addProfile({ profileId: 'p_7', displayName: 'x.sqlite', target: { driver: 'sqlite', path: '/tmp/x.sqlite', readOnly: false } });
		assert.strictEqual(service.connections[0].status, 'disconnected');
		assert.strictEqual(service.connections[0].handle, undefined);
		assert.strictEqual(bridge.calls.length, 0, 'adding a profile talks to no runtime');
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

	test('refresh reloads the catalog of connected profiles only', async () => {
		await service.addProfile(profile);
		await service.refresh('p_1');
		assert.strictEqual(bridge.calls.length, 0, 'a disconnected profile is not queried');
		await service.connect('p_1');
		const before = bridge.calls.length;
		await service.refresh('p_1');
		assert.strictEqual(bridge.calls.length, before + 1);
		assert.strictEqual(bridge.calls[bridge.calls.length - 1].command, NyalaRuntimeCommand.ListObjects);
	});

});
