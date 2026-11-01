/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { FileAccess } from '../../../../base/common/network.js';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { encodeNyalaFrame, isNyalaRuntimeHealthResult, isNyalaRuntimeHelloResult, NyalaFrameDecoder, NyalaFrameError, NyalaRuntimeClientErrors, parseNyalaRuntimeMessage } from '../../common/nyalaRuntimeProtocol.js';

/** `nyala/rpc/v1/` in the repository; the tests run from `out/`. */
const CONTRACT_DIR = join(FileAccess.asFileUri('').fsPath, '..', 'nyala', 'rpc', 'v1');

function frame(json: string): VSBuffer {
	return encodeNyalaFrame(VSBuffer.fromString(json), 1024);
}

function drain(decoder: NyalaFrameDecoder): string[] {
	const payloads: string[] = [];
	for (let payload = decoder.next(); payload; payload = decoder.next()) {
		payloads.push(payload.toString());
	}
	return payloads;
}

function frameError(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		if (error instanceof NyalaFrameError) {
			return `${error.reason} ${error.length}/${error.maxBytes}`;
		}
		throw error;
	}
	return 'no error';
}

suite('Nyala runtime protocol', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('framing', () => {

		test('half frames wait for the rest, byte by byte', () => {
			const bytes = frame('{"a":1}');
			const decoder = new NyalaFrameDecoder(1024);
			const payloads: string[] = [];
			for (let i = 0; i < bytes.byteLength; i++) {
				decoder.push(bytes.slice(i, i + 1));
				payloads.push(...drain(decoder));
			}
			assert.deepStrictEqual({ payloads, pending: decoder.pendingBytes }, { payloads: ['{"a":1}'], pending: 0 });
		});

		test('several frames in one chunk, and a frame split across chunks', () => {
			const bytes = VSBuffer.concat([frame('{"a":1}'), frame('{"b":2}'), frame('{"c":3}')]);
			const decoder = new NyalaFrameDecoder(1024);
			decoder.push(bytes.slice(0, bytes.byteLength - 3));
			const first = drain(decoder);
			decoder.push(bytes.slice(bytes.byteLength - 3));
			assert.deepStrictEqual({ first, second: drain(decoder) }, { first: ['{"a":1}', '{"b":2}'], second: ['{"c":3}'] });
		});

		test('zero-length and oversize frames are rejected as soon as the prefix is complete', () => {
			const zero = new NyalaFrameDecoder(1024);
			zero.push(VSBuffer.wrap(new Uint8Array([0, 0, 0, 0])));

			const oversize = new NyalaFrameDecoder(1024);
			oversize.push(VSBuffer.wrap(new Uint8Array([1, 4, 0, 0]))); // 1025, without a payload

			// 0xFFFFFFFF must be read as an unsigned length, not as -1.
			const maximal = new NyalaFrameDecoder(1024);
			maximal.push(VSBuffer.wrap(new Uint8Array([0xff, 0xff, 0xff, 0xff])));

			assert.deepStrictEqual([frameError(() => zero.next()), frameError(() => oversize.next()), frameError(() => maximal.next())], [
				'zeroLength 0/1024',
				'oversize 1025/1024',
				'oversize 4294967295/1024',
			]);
		});

		test('the encoder refuses frames the peer would reject', () => {
			assert.deepStrictEqual([
				frameError(() => encodeNyalaFrame(VSBuffer.alloc(0), 1024)),
				frameError(() => encodeNyalaFrame(VSBuffer.alloc(1025), 1024)),
				frameError(() => encodeNyalaFrame(VSBuffer.alloc(1024), 1024)),
			], ['zeroLength 0/1024', 'oversize 1025/1024', 'no error']);
		});
	});

	suite('messages', () => {

		function parse(json: string): string {
			const message = parseNyalaRuntimeMessage(VSBuffer.fromString(json));
			return message ? `${message.type} ${message.type === 'notification' ? message.method : message.id}` : 'invalid';
		}

		test('responses and notifications are accepted, everything else is not', () => {
			assert.deepStrictEqual([
				parse('{"jsonrpc":"2.0","id":"rq_1","result":{}}'),
				parse('{"jsonrpc":"2.0","id":"rq_1","error":{"code":-32601,"message":"m","data":{"kind":"METHOD_NOT_FOUND","retryable":false}}}'),
				parse('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"m","data":{"kind":"PARSE_ERROR","retryable":false}}}'),
				parse('{"jsonrpc":"2.0","method":"query.stateChanged","params":{}}'),
				parse('{"jsonrpc":"2.0","id":"rq_1","method":"runtime.hello","params":{}}'),
				parse('{"jsonrpc":"2.0","id":"rq_1","result":{},"error":{"code":1,"message":"m","data":{"kind":"X","retryable":false}}}'),
				parse('{"jsonrpc":"2.0","id":"rq_1","error":{"code":-32601,"message":"m"}}'),
				parse('{"jsonrpc":"2.0","id":1,"result":{}}'),
				parse('{"jsonrpc":"1.0","id":"rq_1","result":{}}'),
				parse('[]'),
				parse('{"jsonrpc":'),
			], [
				'success rq_1',
				'failure rq_1',
				'failure null',
				'notification query.stateChanged',
				'invalid',
				'invalid',
				'invalid',
				'invalid',
				'invalid',
				'invalid',
				'invalid',
			]);
		});

		test('every runtime-sent example of the v1 conformance file is accepted', async () => {
			const lines = (await fs.readFile(join(CONTRACT_DIR, 'conformance.ndjson'), 'utf8')).split(/\r?\n/).filter(line => line.trim());
			const methods = new Map<string, string>();
			const rejected: string[] = [];
			const results: string[] = [];
			for (const line of lines) {
				const raw = JSON.parse(line) as { id?: string; method?: string };
				if (raw.id !== undefined && raw.method !== undefined) {
					methods.set(raw.id, raw.method); // a request, which the runtime never sends
					continue;
				}
				const message = parseNyalaRuntimeMessage(VSBuffer.fromString(line));
				if (!message) {
					rejected.push(line);
				} else if (message.type === 'success') {
					const method = methods.get(message.id);
					if (method === 'runtime.hello') {
						results.push(`hello ${isNyalaRuntimeHelloResult(message.result)}`);
					} else if (method === 'runtime.health') {
						results.push(`health ${isNyalaRuntimeHealthResult(message.result)}`);
					}
				}
			}
			assert.deepStrictEqual({ rejected, results }, { rejected: [], results: ['hello true', 'health true'] });
		});

		test('client-raised error kinds match the v1 error table', async () => {
			const table = JSON.parse(await fs.readFile(join(CONTRACT_DIR, 'error-codes.json'), 'utf8')) as { codes: { kind: string; code: number; retryable: boolean }[] };
			const expected = Object.values(NyalaRuntimeClientErrors).map(error => {
				const entry = table.codes.find(candidate => candidate.kind === error.kind);
				return entry && { kind: entry.kind, code: entry.code, retryable: entry.retryable };
			});
			assert.deepStrictEqual(Object.values(NyalaRuntimeClientErrors).map(error => ({ ...error })), expected);
		});
	});
});
