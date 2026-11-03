/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { cancelParams, connectionTarget, describeParams, executeParams, executionRef, fetchPageParams, listObjectsParams, MAX_SQL_BYTES, NyalaRequestError, resultRef, sessionRef } from '../../common/nyalaRuntimeRequest.js';

suite('Nyala runtime bridge parameters', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('connection targets accept absolute local paths only', () => {
		for (const path of ['/home/user/data.sqlite', 'C:\\data\\db.sqlite', 'C:/data/db.sqlite', '\\\\server\\share\\db.sqlite']) {
			const target = connectionTarget({ driver: 'sqlite', path, readOnly: true });
			assert.deepStrictEqual(target, { driver: 'sqlite', path, readOnly: true }, path);
		}
		for (const path of ['db.sqlite', './db.sqlite', '../db.sqlite', 'file:/tmp/db.sqlite', 'file:C:/db.sqlite?mode=rwc', ':memory:', '']) {
			assert.throws(() => connectionTarget({ driver: 'sqlite', path, readOnly: true }), NyalaRequestError, path);
		}
	});

	test('a connection target forwards only the fields the v1 methods declare', () => {
		const target = connectionTarget({ driver: 'sqlite', path: '/tmp/db.sqlite', readOnly: false, profileId: 'p_1', sessionId: 's_1' });
		assert.deepStrictEqual(target, { driver: 'sqlite', path: '/tmp/db.sqlite', readOnly: false });
	});

	test('session references require a contract id and a positive generation', () => {
		assert.deepStrictEqual(sessionRef({ sessionId: 's_abc123', sessionGeneration: 2 }), { sessionId: 's_abc123', sessionGeneration: 2 });
		assert.throws(() => sessionRef({ sessionId: '', sessionGeneration: 1 }), NyalaRequestError);
		assert.throws(() => sessionRef({ sessionId: 's 1', sessionGeneration: 1 }), NyalaRequestError);
		assert.throws(() => sessionRef({ sessionId: 's_1', sessionGeneration: 0 }), NyalaRequestError);
		assert.throws(() => sessionRef({ sessionId: 's_1', sessionGeneration: 1.5 }), NyalaRequestError);
		assert.throws(() => sessionRef({ sessionId: 's_1', sessionGeneration: '1' }), NyalaRequestError);
	});

	test('listObjects bounds its limit, kinds and cursor', () => {
		assert.deepStrictEqual(
			listObjectsParams({ sessionId: 's_1', sessionGeneration: 1, kinds: ['table', 'view'], limit: 50, cursor: 'c_main_x' }),
			{ sessionId: 's_1', sessionGeneration: 1, kinds: ['table', 'view'], limit: 50, cursor: 'c_main_x' },
		);
		for (const params of [
			{ sessionId: 's_1', sessionGeneration: 1, limit: 0 },
			{ sessionId: 's_1', sessionGeneration: 1, limit: 1001 },
			{ sessionId: 's_1', sessionGeneration: 1, limit: '10' },
			{ sessionId: 's_1', sessionGeneration: 1, limit: 10, kinds: [] },
			{ sessionId: 's_1', sessionGeneration: 1, limit: 10, kinds: ['schema'] },
			{ sessionId: 's_1', sessionGeneration: 1, limit: 10, cursor: 5 },
			{ sessionId: 's_1', sessionGeneration: 1, limit: 10, schema: '' },
		]) {
			assert.throws(() => listObjectsParams(params), NyalaRequestError, JSON.stringify(params));
		}
	});

	test('describe requires an object name', () => {
		assert.deepStrictEqual(
			describeParams({ sessionId: 's_1', sessionGeneration: 1, object: { schema: 'main', name: 'customers' } }),
			{ sessionId: 's_1', sessionGeneration: 1, object: { schema: 'main', name: 'customers' } },
		);
		for (const object of [{}, { name: '' }, { name: 5 }, 'customers', null]) {
			assert.throws(() => describeParams({ sessionId: 's_1', sessionGeneration: 1, object }), NyalaRequestError, JSON.stringify(object));
		}
	});

	test('execute requires a session, non-empty SQL, a declared mode and bounded limits', () => {
		assert.deepStrictEqual(
			executeParams({ sessionId: 's_1', sessionGeneration: 1, sql: 'SELECT 1;', mode: 'statement', timeoutMs: 5000, maxInitialRows: 200 }),
			{ sessionId: 's_1', sessionGeneration: 1, sql: 'SELECT 1;', mode: 'statement', timeoutMs: 5000, maxInitialRows: 200 },
		);
		for (const mode of ['statement', 'selection', 'script'] as const) {
			assert.strictEqual(executeParams({ sessionId: 's_1', sessionGeneration: 1, sql: 'SELECT 1;', mode, timeoutMs: 1, maxInitialRows: 1 }).mode, mode);
		}
	});

	test('execute refuses anything the v1 schema would refuse, and never invents a default', () => {
		const base = { sessionId: 's_1', sessionGeneration: 1, sql: 'SELECT 1;', mode: 'statement', timeoutMs: 5000, maxInitialRows: 200 };
		for (const params of [
			{ ...base, sessionId: '' },
			{ ...base, sessionGeneration: 0 },
			{ ...base, sql: '' },
			{ ...base, sql: '   ' },
			{ ...base, sql: 'x'.repeat(MAX_SQL_BYTES + 1) },
			{ ...base, mode: 'single' },
			{ ...base, timeoutMs: 0 },
			{ ...base, timeoutMs: 600_001 },
			{ ...base, timeoutMs: 1.5 },
			{ ...base, maxInitialRows: 0 },
			{ ...base, maxInitialRows: 10_001 },
			{ sessionId: 's_1', sessionGeneration: 1, sql: 'SELECT 1;', mode: 'statement', timeoutMs: 5000 },
			{ sessionId: 's_1', sql: 'SELECT 1;', mode: 'statement', timeoutMs: 5000, maxInitialRows: 200 },
		]) {
			assert.throws(() => executeParams(params), NyalaRequestError, JSON.stringify(params).slice(0, 80));
		}
	});

	test('execute forwards only the declared fields and drops anything else the renderer sent', () => {
		const request = executeParams({ sessionId: 's_1', sessionGeneration: 2, sql: 'SELECT 1;', mode: 'script', timeoutMs: 1000, maxInitialRows: 10, runtimeGeneration: 9, readOnly: false, queryId: 'q_1' });
		assert.deepStrictEqual(request, { sessionId: 's_1', sessionGeneration: 2, sql: 'SELECT 1;', mode: 'script', timeoutMs: 1000, maxInitialRows: 10 });
	});

	test('cancel, getState, release and fetchPage each take one bounded identity', () => {
		assert.deepStrictEqual(cancelParams({ executionId: 'ex_1' }), { executionId: 'ex_1' });
		assert.deepStrictEqual(cancelParams({ executionId: 'ex_1', reason: 'user' }), { executionId: 'ex_1', reason: 'user' });
		assert.throws(() => cancelParams({ executionId: 'ex_1', reason: 'because' }), NyalaRequestError);
		assert.throws(() => cancelParams({ executionId: '' }), NyalaRequestError);

		assert.deepStrictEqual(executionRef({ executionId: 'ex_1' }), { executionId: 'ex_1' });
		assert.throws(() => executionRef({ executionId: 'ex 1' }), NyalaRequestError);

		assert.deepStrictEqual(resultRef({ resultId: 'rs_1' }), { resultId: 'rs_1' });
		assert.throws(() => resultRef({ resultId: '' }), NyalaRequestError);

		assert.deepStrictEqual(fetchPageParams({ resultId: 'rs_1', limit: 200, cursor: 'c_1' }), { resultId: 'rs_1', limit: 200, cursor: 'c_1' });
		assert.deepStrictEqual(fetchPageParams({ resultId: 'rs_1', limit: 1, cursor: null }), { resultId: 'rs_1', limit: 1, cursor: null });
		for (const params of [
			{ resultId: 'rs_1', limit: 0 },
			{ resultId: 'rs_1', limit: 1001 },
			{ resultId: 'rs_1', limit: 10, cursor: 'x'.repeat(513) },
			{ resultId: 'rs_1', limit: 10, cursor: 5 },
		]) {
			assert.throws(() => fetchPageParams(params), NyalaRequestError, JSON.stringify(params).slice(0, 60));
		}
	});
});
