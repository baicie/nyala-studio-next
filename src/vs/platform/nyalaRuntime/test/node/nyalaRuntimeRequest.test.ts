/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { connectionTarget, describeParams, listObjectsParams, NyalaRequestError, sessionRef } from '../../common/nyalaRuntimeRequest.js';

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
});
