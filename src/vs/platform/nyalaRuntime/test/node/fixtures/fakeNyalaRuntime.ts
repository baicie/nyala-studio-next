/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A stand-in for `nyala-runtime` in the supervisor tests. It uses the same 4-byte little-endian
// framing, answers `runtime.hello` and `runtime.health` like the v1 runtime, and offers `fake.*`
// methods that make it misbehave on request. The first argument selects a mode:
//
// - `ok`             behaves like the runtime: exits with code 0 when stdin ends
// - `chunked`        like `ok`, but writes every frame in 7-byte pieces with pauses in between
// - `exitOnStart`    exits right away with the code given as the second argument (default 1)
// - `mismatch`       replies PROTOCOL_MISMATCH to `runtime.hello` and exits with code 2
// - `badHello`       replies to `runtime.hello` with protocolMajor 2
// - `silent`         never replies
// - `garbage`        answers the first frame with a zero-length frame
// - `ignoreStdinEnd` keeps running after stdin ends, until it is killed

const mode = process.argv[2] ?? 'ok';
if (mode === 'exitOnStart') {
	process.exit(Number(process.argv[3] ?? '1'));
}

interface IFakeRequest {
	readonly id: string;
	readonly method: string;
	readonly params: { readonly code?: number; readonly text?: string };
}

const JSONRPC = '2.0';
let input = Buffer.alloc(0);
let output = Promise.resolve();
/** Requests other than the handshake that this process received. */
let requests = 0;

function frame(message: object): Buffer {
	const payload = Buffer.from(JSON.stringify(message), 'utf8');
	const header = Buffer.alloc(4);
	header.writeUInt32LE(payload.length, 0);
	return Buffer.concat([header, payload]);
}

function write(bytes: Buffer): Promise<void> {
	return new Promise(resolve => process.stdout.write(bytes, () => resolve()));
}

async function writePieces(bytes: Buffer): Promise<void> {
	for (let offset = 0; offset < bytes.length; offset += 7) {
		await write(bytes.subarray(offset, offset + 7));
		await new Promise(resolve => setTimeout(resolve, 2));
	}
}

/** Writes all messages with one write call (or in pieces in `chunked` mode), in call order. */
function send(...messages: object[]): Promise<void> {
	const bytes = Buffer.concat(messages.map(frame));
	output = output.then(() => mode === 'chunked' ? writePieces(bytes) : write(bytes));
	return output;
}

function handle(request: IFakeRequest): void {
	if (mode === 'silent') {
		return;
	}
	if (mode === 'garbage') {
		process.stdout.write(Buffer.alloc(4));
		return;
	}
	const reply = (result: object) => ({ jsonrpc: JSONRPC, id: request.id, result });
	switch (request.method) {
		case 'runtime.hello':
			if (mode === 'mismatch') {
				send({ jsonrpc: JSONRPC, id: request.id, error: { code: -32011, message: 'Protocol mismatch', data: { kind: 'PROTOCOL_MISMATCH', retryable: false } } }).then(() => {
					process.exitCode = 2;
					process.stdin.destroy();
				});
				return;
			}
			send(reply({
				protocolMajor: mode === 'badHello' ? 2 : 1,
				protocolMinor: 0,
				runtimeBuild: '0.0.0-fake',
				features: [],
				limits: { frameMaxBytes: 8388608, maxInitialRows: 200, maxPageRows: 1000, maxResultTtlSecs: 300, maxConcurrentExecutions: 4 },
			}));
			return;
		case 'runtime.health':
			send(reply({ status: 'ok', uptimeMs: 1, activeSessions: 0, activeExecutions: 0, pendingResults: 0 }));
			return;
	}
	const received = requests++;
	switch (request.method) {
		case 'fake.exit':
			process.exit(request.params.code ?? 1);
		case 'fake.stats':
			send(reply({ requests: received }));
			break;
		case 'fake.echo':
			send(reply(request.params));
			break;
		case 'fake.burst':
			send(
				{ jsonrpc: JSONRPC, method: 'fake.tick', params: { n: 1 } },
				{ jsonrpc: JSONRPC, method: 'fake.tick', params: { n: 2 } },
				reply({ done: true }),
			);
			break;
		case 'fake.stderr':
			process.stderr.write(request.params.text ?? '', () => send(reply({})));
			break;
		case 'fake.restarted':
			send({ jsonrpc: JSONRPC, method: 'runtime.restarted', params: { reason: 'unexpected-exit', pendingExecutions: 'none' } }, reply({}));
			break;
		case 'fake.hang':
			break; // never answered, so the request stays in flight

		default:
			send({ jsonrpc: JSONRPC, id: request.id, error: { code: -32601, message: 'Method not found', data: { kind: 'METHOD_NOT_FOUND', retryable: false } } });
	}
}

process.stdin.on('data', (chunk: Buffer) => {
	input = Buffer.concat([input, chunk]);
	while (input.length >= 4) {
		const length = input.readUInt32LE(0);
		if (input.length < 4 + length) {
			break;
		}
		const payload = input.subarray(4, 4 + length);
		input = input.subarray(4 + length);
		handle(JSON.parse(payload.toString('utf8')));
	}
});

process.stdin.on('end', () => {
	if (mode === 'ignoreStdinEnd') {
		setInterval(() => { }, 1000);
	}
	// Otherwise the event loop drains and the process exits with code 0, as nyala-runtime does.
});

// Keeps the declarations above out of the global scope of the typecheck.
export { };
