/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Generates the TypeScript and Rust declarations of the Nyala RPC v1 contract from
// `nyala/rpc/v1/`, which is the single source of truth (N-110).
//
//   npm run nyala:generate-rpc          write both files
//   npm run nyala:check-rpc-generated   fail when a generated file is out of date
//
// The check runs in CI without `npm ci`, so this script uses `node:` built-ins only. It refuses
// any schema keyword it does not implement, the same way the contract validators do: a schema
// change cannot silently produce a wrong declaration.

import { readFileSync, writeFileSync } from 'node:fs';

const SCHEMA_PATH = 'nyala/rpc/v1/nyala-rpc.v1.schema.json';
const ERROR_CODES_PATH = 'nyala/rpc/v1/error-codes.json';
const TS_PATH = 'src/vs/platform/nyalaRuntime/common/nyalaRuntimeContract.generated.ts';
const RUST_PATH = 'rust/crates/nyala-runtime/src/contract.rs';

const COPYRIGHT = `/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/`;

const GENERATOR = 'scripts/nyala/generate-rpc-contract.ts';

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

/** Schema keywords this generator understands. Anything else fails the run. */
const KEYWORDS = new Set([
	'$schema', '$id', '$defs', '$ref', 'title', 'description', 'oneOf', 'type', 'const', 'enum',
	'minLength', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems', 'uniqueItems', 'items',
	'minProperties', 'maxProperties', 'required', 'properties', 'additionalProperties',
]);

function assertSupported(node, path) {
	if (Array.isArray(node)) {
		node.forEach((item, index) => assertSupported(item, `${path}[${index}]`));
		return;
	}
	if (node === null || typeof node !== 'object') {
		return;
	}
	for (const [key, value] of Object.entries(node)) {
		if (!KEYWORDS.has(key)) {
			throw new Error(`${path}: schema keyword "${key}" is not implemented by ${GENERATOR}`);
		}
		switch (key) {
			case '$defs':
			case 'properties':
				for (const [name, child] of Object.entries(value)) {
					assertSupported(child, `${path}/${key}/${name}`);
				}
				break;
			case 'oneOf':
				value.forEach((child, index) => assertSupported(child, `${path}/oneOf/${index}`));
				break;
			case 'items':
			case 'additionalProperties':
				if (typeof value === 'object') {
					assertSupported(value, `${path}/${key}`);
				}
				break;
			default:
				break;
		}
	}
}

const pascal = text => text
	.split(/[^A-Za-z0-9]+/)
	.filter(Boolean)
	.map(part => part[0].toUpperCase() + part.slice(1))
	.join('');

const quote = text => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

//#region TypeScript

/**
 * The TypeScript type of one schema node. Object nodes become named interfaces, pushed to
 * `nested` so that each one is emitted once no matter how often it is used.
 *
 * Nested names are built from the path, so they are stable and collision-free:
 * `method.runtime.hello.result.limits` -> `INyalaRuntimeHelloResultLimits`.
 */
function tsType(node, hint, nested) {
	if (node.$ref !== undefined) {
		const name = node.$ref.replace('#/$defs/', '');
		if (name === 'id') {
			return 'NyalaId';
		}
		if (name === 'error') {
			return 'INyalaRuntimeErrorObject';
		}
		if (name === 'failureId') {
			return 'NyalaId | null';
		}
		if (name === 'cell') {
			return 'NyalaCell';
		}
		throw new Error(`unsupported $ref: ${node.$ref}`);
	}

	if (node.oneOf !== undefined) {
		const branches = node.oneOf;
		const nullBranches = branches.filter(branch => branch.type === 'null');
		if (nullBranches.length === 1 && branches.length === 2) {
			const other = branches.find(branch => branch.type !== 'null');
			return `${tsType(other, hint, nested)} | null`;
		}
		if (branches.every(branch => branch.const !== undefined)) {
			return branches.map(branch => quote(branch.const)).join(' | ');
		}
		throw new Error(`unsupported oneOf at ${hint}`);
	}

	if (node.const !== undefined) {
		return quote(node.const);
	}

	if (node.enum !== undefined) {
		return node.enum.map(quote).join(' | ');
	}

	const types = Array.isArray(node.type) ? node.type : [node.type];
	if (types.length > 1) {
		return types.map(type => tsType({ ...node, type }, hint, nested)).join(' | ');
	}

	switch (node.type) {
		case 'null':
			return 'null';
		case 'boolean':
			return 'boolean';
		case 'integer':
		case 'number':
			return 'number';
		case 'string':
			return 'string';
		case 'array': {
			const item = tsType(node.items, `${hint}Item`, nested);
			return /[ |]/.test(item) ? `readonly (${item})[]` : `readonly ${item}[]`;
		}
		case 'object': {
			if (!node.properties) {
				throw new Error(`unsupported object without properties at ${hint}`);
			}
			nested.push(tsInterface(node, hint, nested));
			return hint;
		}
		default:
			throw new Error(`unsupported schema type at ${hint}: ${node.type}`);
	}
}

function tsInterface(node, name, nested) {
	const required = new Set(node.required ?? []);
	const lines = [`export interface ${name} {`];
	for (const [key, property] of Object.entries(node.properties ?? {})) {
		const optional = required.has(key) ? '' : '?';
		lines.push(`\treadonly ${key}${optional}: ${tsType(property, name + pascal(key), nested)};`);
	}
	lines.push('}');
	return lines.join('\n');
}

function tsCellUnion(cell) {
	const lines = ['export type NyalaCell ='];
	cell.oneOf.forEach((branch, index) => {
		const required = new Set(branch.required ?? []);
		const members = Object.entries(branch.properties).map(([key, property]) => {
			const optional = required.has(key) ? '' : '?';
			let type;
			if (property.const !== undefined) {
				type = quote(property.const);
			} else if (property.type === 'boolean') {
				type = 'boolean';
			} else if (property.type === 'number') {
				type = 'number';
			} else if (property.type === 'string') {
				type = 'string';
			} else {
				throw new Error(`unsupported cell member ${key}`);
			}
			return `readonly ${key}${optional}: ${type}`;
		});
		const separator = index === cell.oneOf.length - 1 ? ';' : '';
		lines.push(`\t| { ${members.join('; ')} }${separator}`);
	});
	return lines.join('\n');
}

function tsErrorTable(errorCodes) {
	const entries = errorCodes.codes
		.map(entry => `\t${entry.kind}: { kind: ${quote(entry.kind)}, code: ${entry.code}, retryable: ${entry.retryable} },`)
		.join('\n');
	return `/** One entry of \`nyala/rpc/v1/error-codes.json\`: the stable kind, its code and whether a client may retry it. */
export interface NyalaErrorKindSpec {
	readonly kind: string;
	readonly code: number;
	readonly retryable: boolean;
}

/** The v1 error table, generated from \`error-codes.json\` and keyed by kind. */
export const NYALA_ERROR_KINDS = {
${entries}
} as const satisfies Record<string, NyalaErrorKindSpec>;`;
}

function tsFile(schema, errorCodes) {
	const blocks = [];
	blocks.push(`export const NYALA_RPC_ID_PATTERN = ${quote(schema.$defs.id.pattern)};`);
	blocks.push(`export const NYALA_RPC_REQUEST_METHODS = [\n${requestMethods(schema).map(method => `\t${quote(method)},`).join('\n')}\n] as const;`);
	blocks.push(`export const NYALA_RPC_NOTIFICATION_METHODS = [\n${notificationMethods(schema).map(method => `\t${quote(method)},`).join('\n')}\n] as const;`);
	blocks.push('/** An id as `$defs/id` defines it: a short lowercase prefix, an underscore, and up to 64 alphanumerics. */\nexport type NyalaId = string;');
	blocks.push(tsCellUnion(schema.$defs.cell));

	const nested = [];
	blocks.push(tsInterface(schema.$defs.error, 'INyalaRuntimeErrorObject', nested));
	blocks.push(...nested.splice(0));

	for (const method of requestMethods(schema)) {
		for (const role of ['params', 'result']) {
			const node = schema.$defs[`method.${method}.${role}`];
			const name = methodTypeName(method, role);
			const inner = [];
			blocks.push(tsInterface(node, name, inner));
			blocks.push(...inner);
		}
	}
	for (const method of notificationMethods(schema)) {
		const name = methodTypeName(method, 'params');
		const inner = [];
		blocks.push(tsInterface(schema.$defs[`method.${method}.params`], name, inner));
		blocks.push(...inner);
	}

	const paramsMap = requestMethods(schema)
		.map(method => `\treadonly ${quote(method)}: ${methodTypeName(method, 'params')};`)
		.join('\n');
	const resultsMap = requestMethods(schema)
		.map(method => `\treadonly ${quote(method)}: ${methodTypeName(method, 'result')};`)
		.join('\n');
	blocks.push(`/** Every request method of the v1 catalog, keyed by its name. */\nexport interface INyalaRuntimeRequestParams {\n${paramsMap}\n}`);
	blocks.push(`/** Every request method of the v1 catalog, keyed by its name. */\nexport interface INyalaRuntimeRequestResults {\n${resultsMap}\n}`);
	blocks.push('export type NyalaRequestMethod = keyof INyalaRuntimeRequestParams;');
	blocks.push(tsErrorTable(errorCodes));

	return `${COPYRIGHT}

// DO NOT EDIT -- auto-generated by ${GENERATOR} from ${SCHEMA_PATH}.
// Run 'npm run nyala:generate-rpc' after changing the contract; 'npm run nyala:check-rpc-generated'
// fails when this file no longer matches it.

${blocks.join('\n\n')}
`;
}

const methodTypeName = (method, role) => `INyala${method.split('.').map(pascal).join('')}${pascal(role)}`;

//#endregion

//#region Rust

/**
 * Rust declarations of the parts of the contract the runtime uses as data. The error table is
 * emitted as one `const` per kind so that `error.rs` can name them in a `match`: a kind added to
 * `error-codes.json` without regenerating this file becomes a compile error instead of a silent
 * default.
 */
function rustFile(schema, errorCodes) {
	// Rustfmt puts a declaration on one line while it fits in 100 columns and expands it
	// otherwise; these helpers emit exactly the expanded form, so regenerating never breaks
	// `cargo fmt --check`.
	const declaration = (name, items) => {
		const head = `pub const ${name}: [&str; ${items.length}] = `;
		const single = `${head}[${items.join(', ')}];`;
		if (single.length <= 100) {
			return single;
		}
		return `${head}[\n${items.map(item => `\t${item},`).join('\n')}\n];`;
	};
	const requests = declaration('REQUEST_METHODS', requestMethods(schema).map(method => `"${method}"`));
	const notifications = declaration('NOTIFICATION_METHODS', notificationMethods(schema).map(method => `"${method}"`));
	// Rustfmt always expands a struct literal with this many fields; each one is emitted expanded.
	const kinds = errorCodes.codes
		.map(entry => `pub const ${entry.kind}: ErrorKindSpec = ErrorKindSpec {\n\tkind: "${entry.kind}",\n\tcode: ${entry.code},\n\tretryable: ${entry.retryable},\n};`)
		.join('\n\n');

	return `${COPYRIGHT}

//! Generated from \`nyala/rpc/v1/\` by \`${GENERATOR}\`.
//!
//! Do not edit: change the contract and run \`npm run nyala:generate-rpc\`.
//! \`npm run nyala:check-rpc-generated\` fails when this file no longer matches it.

/// One entry of \`nyala/rpc/v1/error-codes.json\`: the stable \`kind\`, its JSON-RPC \`code\` and
/// whether a client may retry it automatically.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ErrorKindSpec {
	pub kind: &'static str,
	pub code: i64,
	pub retryable: bool,
}

/// Request methods of the v1 catalog (\`nyala/rpc/README.md\` section 4), in contract order.
${requests}

/// Notification methods of the v1 catalog. v1 defines none in the client-to-runtime direction.
${notifications}

/// The \`id\` pattern of \`$defs/id\`.
pub const ID_PATTERN: &str = "${schema.$defs.id.pattern}";

/// Entries of \`error-codes.json\`; \`error.rs\` names them in its \`match\`.
pub const ERROR_KIND_COUNT: usize = ${errorCodes.codes.length};

${kinds}
`;
}

//#endregion

function requestMethods(schema) {
	return schema.$defs.request.oneOf.map(branch => branch.properties.method.const);
}

function notificationMethods(schema) {
	return schema.$defs.notification.oneOf.map(branch => branch.properties.method.const);
}

//#region Main

const check = process.argv.includes('--check');
const schema = readJson(SCHEMA_PATH);
const errorCodes = readJson(ERROR_CODES_PATH);

assertSupported(schema, SCHEMA_PATH);
for (const [name, entry] of Object.entries(errorCodes)) {
	if (!['schemaVersion', 'note', 'reservedRange', 'codes'].includes(name)) {
		throw new Error(`${ERROR_CODES_PATH}: unexpected property "${name}"`);
	}
	void entry;
}

const outputs = [
	[TS_PATH, tsFile(schema, errorCodes)],
	[RUST_PATH, rustFile(schema, errorCodes)],
];

let stale = 0;
for (const [path, content] of outputs) {
	let current = '';
	try {
		current = readFileSync(path, 'utf8');
	} catch {
		current = '';
	}
	// A Windows checkout may hold CRLF; the committed file is LF.
	if (current.replace(/\r\n/g, '\n') === content) {
		continue;
	}
	if (check) {
		console.error(`${path} is out of date; run 'npm run nyala:generate-rpc'`);
		stale++;
	} else {
		writeFileSync(path, content, 'utf8');
		console.log(`wrote ${path}`);
	}
}

if (stale > 0) {
	process.exit(1);
}

if (check) {
	console.log(`nyala rpc generated declarations: OK (${outputs.length} files up to date)`);
}

//#endregion
