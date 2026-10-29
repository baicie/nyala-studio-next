/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FRAME_PREFIX_BYTES = 4;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const SCHEMA_PATH = 'nyala/rpc/v1/nyala-rpc.v1.schema.json';
const ERROR_CODES_PATH = 'nyala/rpc/v1/error-codes.json';
const CONFORMANCE_PATH = 'nyala/rpc/v1/conformance.ndjson';
const CONTRACT_README_PATH = 'nyala/rpc/README.md';

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const readLines = path => readFileSync(path, 'utf8').split('\n').filter(line => line.trim().length > 0);

//#region 分帧

/** 4 字节 little-endian 长度前缀 + UTF-8 JSON，与 Rust 侧实现必须逐字节一致。 */
function encodeFrame(text) {
	const payload = Buffer.from(text, 'utf8');
	assert.ok(payload.length > 0, 'empty payload cannot be framed');
	assert.ok(payload.length <= MAX_FRAME_BYTES, `payload exceeds frameMaxBytes: ${payload.length}`);
	const prefix = Buffer.alloc(FRAME_PREFIX_BYTES);
	prefix.writeUInt32LE(payload.length, 0);
	return Buffer.concat([prefix, payload]);
}

/** 增量解码器：允许任意切分的 chunk，处理半包/粘包。 */
class FrameDecoder {

	constructor(maxBytes = MAX_FRAME_BYTES) {
		this.buffer = Buffer.alloc(0);
		this.maxBytes = maxBytes;
	}

	push(chunk) {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		const frames = [];
		while (this.buffer.length >= FRAME_PREFIX_BYTES) {
			const length = this.buffer.readUInt32LE(0);
			assert.notEqual(length, 0, 'zero-length frame must be rejected with INVALID_REQUEST');
			assert.ok(length <= this.maxBytes, `frame of ${length} bytes exceeds frameMaxBytes ${this.maxBytes} and must be rejected with RESOURCE_LIMIT`);
			if (this.buffer.length < FRAME_PREFIX_BYTES + length) {
				break;
			}
			frames.push(this.buffer.subarray(FRAME_PREFIX_BYTES, FRAME_PREFIX_BYTES + length).toString('utf8'));
			this.buffer = this.buffer.subarray(FRAME_PREFIX_BYTES + length);
		}
		return frames;
	}

	get pendingBytes() {
		return this.buffer.length;
	}
}

//#endregion

//#region JSON Schema 子集求值器（只实现本合同用到的关键字）

const typeOf = value => {
	if (value === null) {
		return 'null';
	}
	if (Array.isArray(value)) {
		return 'array';
	}
	return typeof value;
};

const matchesType = (value, type) => {
	switch (type) {
		case 'null': return value === null;
		case 'array': return Array.isArray(value);
		case 'object': return typeOf(value) === 'object';
		case 'integer': return Number.isInteger(value);
		case 'number': return typeof value === 'number' && Number.isFinite(value);
		case 'string': return typeof value === 'string';
		case 'boolean': return typeof value === 'boolean';
		default: throw new Error(`unsupported schema type: ${type}`);
	}
};

const resolveRef = (ref, root) => {
	assert.ok(ref.startsWith('#/'), `only local refs are supported: ${ref}`);
	return ref.slice(2).split('/').reduce((node, key) => {
		assert.ok(node && Object.hasOwn(node, key), `unresolvable $ref: ${ref}`);
		return node[key];
	}, root);
};

function validate(value, schema, path, root, errors) {
	if (schema.$ref) {
		validate(value, resolveRef(schema.$ref, root), path, root, errors);
		return;
	}

	if (schema.oneOf) {
		const matches = schema.oneOf.filter(branch => {
			const branchErrors = [];
			validate(value, branch, path, root, branchErrors);
			return branchErrors.length === 0;
		});
		if (matches.length !== 1) {
			errors.push(`${path}: expected exactly one oneOf branch to match, matched ${matches.length}`);
		}
	}

	if (schema.type !== undefined) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		if (!types.some(type => matchesType(value, type))) {
			errors.push(`${path}: expected type ${types.join('|')}, got ${typeOf(value)}`);
			return;
		}
	}

	if (schema.const !== undefined && value !== schema.const) {
		errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
	}

	if (schema.enum !== undefined && !schema.enum.includes(value)) {
		errors.push(`${path}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
	}

	if (typeof value === 'string') {
		if (schema.minLength !== undefined && value.length < schema.minLength) {
			errors.push(`${path}: string shorter than ${schema.minLength}`);
		}
		if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
			errors.push(`${path}: string does not match pattern ${schema.pattern}`);
		}
	}

	if (typeof value === 'number') {
		if (schema.minimum !== undefined && value < schema.minimum) {
			errors.push(`${path}: number below minimum ${schema.minimum}`);
		}
		if (schema.maximum !== undefined && value > schema.maximum) {
			errors.push(`${path}: number above maximum ${schema.maximum}`);
		}
	}

	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) {
			errors.push(`${path}: fewer than ${schema.minItems} items`);
		}
		if (schema.maxItems !== undefined && value.length > schema.maxItems) {
			errors.push(`${path}: more than ${schema.maxItems} items`);
		}
		if (schema.uniqueItems) {
			const seen = new Set(value.map(item => JSON.stringify(item)));
			if (seen.size !== value.length) {
				errors.push(`${path}: items are not unique`);
			}
		}
		if (schema.items) {
			value.forEach((item, index) => validate(item, schema.items, `${path}[${index}]`, root, errors));
		}
	}

	if (typeOf(value) === 'object') {
		const keys = Object.keys(value);
		if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
			errors.push(`${path}: fewer than ${schema.minProperties} properties`);
		}
		if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
			errors.push(`${path}: more than ${schema.maxProperties} properties`);
		}
		for (const required of schema.required ?? []) {
			if (!Object.hasOwn(value, required)) {
				errors.push(`${path}: missing required property "${required}"`);
			}
		}
		for (const key of keys) {
			const declared = schema.properties?.[key];
			if (declared) {
				validate(value[key], declared, `${path}.${key}`, root, errors);
			} else if (schema.additionalProperties === false) {
				errors.push(`${path}: unexpected property "${key}"`);
			} else if (schema.additionalProperties) {
				validate(value[key], schema.additionalProperties, `${path}.${key}`, root, errors);
			}
		}
	}
}

let rootSchema = null;

const collectErrors = (value, schema, path = '$') => {
	const errors = [];
	validate(value, schema, path, rootSchema ?? schema, errors);
	return errors;
};

//#endregion

//#region 断言辅助

const failures = [];
const check = (condition, message) => {
	if (!condition) {
		failures.push(message);
	}
};

//#endregion

// ---- 1. 分帧回归 ----
const sampleTexts = readLines(CONFORMANCE_PATH);
const encoded = sampleTexts.map(encodeFrame);

const byteWiseDecoder = new FrameDecoder();
const byteWiseFrames = [];
for (const frame of encoded) {
	for (const byte of frame) {
		byteWiseFrames.push(...byteWiseDecoder.push(Buffer.from([byte])));
	}
}
check(byteWiseFrames.length === sampleTexts.length, `frame decoder must recover ${sampleTexts.length} frames byte-by-byte, got ${byteWiseFrames.length}`);
check(byteWiseFrames.every((text, index) => text === sampleTexts[index]), 'frame decoder must preserve payload order and content');
check(byteWiseDecoder.pendingBytes === 0, 'frame decoder must not retain bytes after complete frames');

const gluedDecoder = new FrameDecoder();
const gluedFrames = gluedDecoder.push(Buffer.concat(encoded));
check(gluedFrames.length === sampleTexts.length, 'frame decoder must split glued frames');

checkThrows(() => new FrameDecoder().push(Buffer.alloc(FRAME_PREFIX_BYTES)), 'zero-length frame', 'zero-length frame must throw');
checkThrows(() => {
	const prefix = Buffer.alloc(FRAME_PREFIX_BYTES);
	prefix.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
	new FrameDecoder().push(prefix);
}, 'oversize frame', 'frame above frameMaxBytes must throw');

const halfFrame = encoded[0].subarray(0, encoded[0].length - 4);
check(new FrameDecoder().push(halfFrame).length === 0, 'partial frame must not be emitted before the payload is complete');

function checkThrows(fn, label, message) {
	let threw = false;
	try {
		fn();
	} catch {
		threw = true;
	}
	check(threw, `${label}: ${message}`);
}

// ---- 2. Schema 校验 ----
const schema = readJson(SCHEMA_PATH);
rootSchema = schema;
const messages = sampleTexts.map((text, index) => {
	const value = JSON.parse(text);
	const errors = collectErrors(value, schema);
	check(errors.length === 0, `${CONFORMANCE_PATH}:${index + 1} schema violation -> ${errors.join('; ')}`);
	return { index: index + 1, value };
});

// ---- 2b. 负向对照：确保 schema 校验不是空转 ----
const helloRequest = messages[0].value;
const { params: _helloParams, ...helloWithoutParams } = helloRequest;
const executeRequest = messages[10].value;
const brokenSamples = [
	['missing params', helloWithoutParams],
	['unexpected property', { ...helloRequest, nyalaDebug: true }],
	['invalid enum', { ...executeRequest, params: { ...executeRequest.params, mode: 'batch' } }]
];
for (const [label, broken] of brokenSamples) {
	check(collectErrors(broken, schema).length > 0, `negative control must fail schema validation: ${label}`);
}

// ---- 3. 请求/响应配对与方法级 result 校验 ----
const isRequest = message => Object.hasOwn(message, 'method') && Object.hasOwn(message, 'id');
const isNotification = message => Object.hasOwn(message, 'method') && !Object.hasOwn(message, 'id');
const isSuccess = message => Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error');
const isFailure = message => Object.hasOwn(message, 'error');

const requests = new Map();
const responses = new Map();
const methodResultRefs = new Set(Object.keys(schema.$defs).filter(key => key.startsWith('method.') && key.endsWith('.result')).map(key => key.slice('method.'.length, -'.result'.length)));
const schemaMethods = new Set(Object.keys(schema.$defs).filter(key => key.startsWith('method.') && key.endsWith('.params')).map(key => key.slice('method.'.length, -'.params'.length)));

let requestCount = 0;
let notificationCount = 0;
let errorCount = 0;

for (const { index, value } of messages) {
	if (isRequest(value)) {
		requestCount++;
		check(!requests.has(value.id), `${CONFORMANCE_PATH}:${index} duplicate request id ${value.id}`);
		check(methodResultRefs.has(value.method), `${CONFORMANCE_PATH}:${index} method ${value.method} has no result schema`);
		requests.set(value.id, { method: value.method, index });
		continue;
	}

	if (isNotification(value)) {
		notificationCount++;
		continue;
	}

	const responseId = value.id;
	const request = requests.get(responseId);
	check(!!request, `${CONFORMANCE_PATH}:${index} response ${responseId} has no preceding request`);
	check(!responses.has(responseId), `${CONFORMANCE_PATH}:${index} duplicate response for ${responseId}`);
	responses.set(responseId, index);

	if (request && isSuccess(value)) {
		const resultSchema = schema.$defs[`method.${request.method}.result`];
		const errors = collectErrors(value.result, resultSchema, `${responseId}.result`);
		check(errors.length === 0, `${CONFORMANCE_PATH}:${index} result does not match ${request.method} schema -> ${errors.join('; ')}`);
	}
	if (isFailure(value)) {
		errorCount++;
	}
}

check(responses.size === requests.size, `every request must have exactly one response: ${requests.size} requests, ${responses.size} responses`);

// ---- 4. 通知 sequence 单调 ----
const lastSequence = new Map();
for (const { index, value } of messages) {
	if (isNotification(value) && value.method === 'query.stateChanged') {
		const { executionId, sequence } = value.params;
		const previous = lastSequence.get(executionId);
		check(previous === undefined || sequence > previous, `${CONFORMANCE_PATH}:${index} sequence for ${executionId} must strictly increase (${previous} -> ${sequence})`);
		lastSequence.set(executionId, sequence);
	}
}

// ---- 5. 错误码表 ----
const errorCodes = readJson(ERROR_CODES_PATH);
const registryByKind = new Map(errorCodes.codes.map(entry => [entry.kind, entry]));
check(registryByKind.size === errorCodes.codes.length, 'error kinds must be unique');
check(new Set(errorCodes.codes.map(entry => entry.code)).size === errorCodes.codes.length, 'error codes must be unique');
for (const entry of errorCodes.codes) {
	const [min, max] = entry.layer === 'transport' ? errorCodes.reservedRange.jsonRpc : errorCodes.reservedRange.nyalaDomain;
	check(entry.code >= min && entry.code <= max, `error code ${entry.kind} (${entry.code}) is outside its declared range`);
}

for (const { index, value } of messages) {
	if (!isFailure(value)) {
		continue;
	}
	const { code, data } = value.error;
	const entry = registryByKind.get(data.kind);
	check(!!entry, `${CONFORMANCE_PATH}:${index} error kind ${data.kind} is not registered`);
	if (entry) {
		check(entry.code === code, `${CONFORMANCE_PATH}:${index} error kind ${data.kind} must use code ${entry.code}, got ${code}`);
		check(entry.retryable === data.retryable, `${CONFORMANCE_PATH}:${index} error kind ${data.kind} retryable flag must match registry (${entry.retryable})`);
	}
}

// ---- 6. 合同文档与 schema 不漂移 ----
const readme = readFileSync(CONTRACT_README_PATH, 'utf8');
const documentedMethods = new Set([...readme.matchAll(/`((?:runtime|connection|metadata|query|result|transaction)\.[a-zA-Z]+)`/g)].map(match => match[1]));
const implementedMethods = schemaMethods;
for (const method of implementedMethods) {
	check(documentedMethods.has(method), `${CONTRACT_README_PATH} must document ${method}`);
}
for (const method of documentedMethods) {
	if (method.startsWith('transaction.')) {
		continue; // v1 明确未实现事务方法，只在设计文档中出现
	}
	check(implementedMethods.has(method), `${CONTRACT_README_PATH} documents ${method} but the schema does not define it`);
}

// ---- 报告 ----
if (failures.length > 0) {
	console.error(`nyala rpc contract validation FAILED (${failures.length}):`);
	for (const failure of failures) {
		console.error(`  - ${failure}`);
	}
	process.exit(1);
}

console.log('nyala rpc contract v1.0: OK');
console.log(`  frames: ${sampleTexts.length} (byte-wise + glued decoding, half/zero/oversize rejection)`);
console.log(`  envelope schema: ${Object.keys(schema.$defs).length} definitions, ${requestCount} requests / ${notificationCount} notifications / ${errorCount} error responses`);
console.log(`  methods: ${implementedMethods.size} implemented, ${documentedMethods.size} documented`);
console.log(`  error kinds: ${registryByKind.size} registered`);
