/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { FileAccess } from '../../../../base/common/network.js';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NYALA_ERROR_KINDS, NYALA_RPC_ID_PATTERN, NYALA_RPC_NOTIFICATION_METHODS, NYALA_RPC_REQUEST_METHODS } from '../../common/nyalaRuntimeContract.generated.js';
import { isNyalaRequestId } from '../../common/nyalaRuntimeProtocol.js';

/** `nyala/rpc/v1/` in the repository; the tests run from `out/`. */
const CONTRACT_DIR = join(FileAccess.asFileUri('').fsPath, '..', 'nyala', 'rpc', 'v1');

interface IBranch {
	readonly properties?: { readonly method?: { readonly const?: string } };
}

interface ISchema {
	readonly $defs: Record<string, { readonly oneOf?: readonly IBranch[]; readonly pattern?: string }>;
}

/** The generated module against the contract files it was generated from (N-110). */
suite('Nyala runtime generated contract', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	async function schema(): Promise<ISchema> {
		return JSON.parse(await fs.readFile(join(CONTRACT_DIR, 'nyala-rpc.v1.schema.json'), 'utf8')) as ISchema;
	}

	function methodsOf(def: { readonly oneOf?: readonly IBranch[] }): string[] {
		return (def.oneOf ?? []).map(branch => {
			const method = branch.properties?.method?.const;
			assert.ok(method, 'every branch names its method');
			return method;
		});
	}

	test('the generated method lists match the contract unions', async () => {
		const defs = (await schema()).$defs;
		assert.deepStrictEqual({
			requests: [...NYALA_RPC_REQUEST_METHODS],
			notifications: [...NYALA_RPC_NOTIFICATION_METHODS],
		}, {
			requests: methodsOf(defs.request),
			notifications: methodsOf(defs.notification),
		});
	});

	test('the generated error table is the contract error table', async () => {
		const table = JSON.parse(await fs.readFile(join(CONTRACT_DIR, 'error-codes.json'), 'utf8')) as { codes: { kind: string; code: number; retryable: boolean }[] };
		assert.deepStrictEqual(Object.values(NYALA_ERROR_KINDS), table.codes.map(({ kind, code, retryable }) => ({ kind, code, retryable })));
	});

	test('the generated id pattern is the contract pattern and is the one in use', async () => {
		const pattern = (await schema()).$defs.id.pattern;
		assert.strictEqual(NYALA_RPC_ID_PATTERN, pattern);
		// `isNyalaRequestId` compiles the generated constant, so these two answers prove the
		// pattern that reaches the parser is the contract's.
		assert.deepStrictEqual({
			valid: [isNyalaRequestId('rq_1'), isNyalaRequestId('abcd_' + 'a'.repeat(64))],
			invalid: [isNyalaRequestId('RQ_1'), isNyalaRequestId('abcde_1'), isNyalaRequestId('rq_')],
		}, {
			valid: [true, true],
			invalid: [false, false, false],
		});
	});
});
