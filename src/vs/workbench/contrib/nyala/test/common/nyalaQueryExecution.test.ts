/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// N-203 execution state machine. These tests are the contract the service relies on: a state only
// moves forward, a terminal outcome is final, a notification from another runtime generation is
// ignored, and a cancel reply can never pretend to be more authoritative than the notification
// stream. No timers, no runtime, no promises.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { INyalaRuntimeErrorObject } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeContract.generated.js';
import {
	applyCalibration,
	applyCancelReply,
	applyStateChange,
	holdsMutex,
	INyalaExecutionRecord,
	INyalaExecutionSnapshot,
	INyalaStateChange,
	isTerminalState,
	markNotSent,
	markUnknown,
	NyalaExecutionState,
	ownsResults,
} from '../../query/common/nyalaQueryExecution.js';

const NOW = 1_700_000_000_000;

function snapshot(overrides: Partial<INyalaExecutionSnapshot> = {}): INyalaExecutionSnapshot {
	return {
		queryId: 'q_1',
		profileId: 'p_a',
		profileName: 'a.sqlite',
		sessionId: 's_a',
		sessionGeneration: 1,
		runtimeGeneration: 1,
		sql: 'SELECT 1;',
		mode: 'statement',
		readOnly: true,
		startedAt: NOW,
		...overrides,
	};
}

function record(state: NyalaExecutionState = 'queued', sequence = 1): INyalaExecutionRecord {
	return {
		requestId: 'rq_local_1',
		executionId: 'ex_1',
		snapshot: snapshot(),
		state,
		sequence,
		stateEpoch: 0,
		resultIds: [],
		abandoned: false,
	};
}

function change(state: NyalaExecutionState, sequence: number, extra: Partial<INyalaStateChange> = {}): INyalaStateChange {
	return { state, sequence, runtimeGeneration: 1, ...extra };
}

function cancelledError(): INyalaRuntimeErrorObject {
	return { code: -32005, message: 'The query was cancelled', data: { kind: 'QUERY_CANCELLED', retryable: false } };
}

suite('Nyala query execution state', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the terminal states are exactly the four the contract names', () => {
		const states: NyalaExecutionState[] = ['queued', 'running', 'streaming', 'completed', 'failed', 'cancel_requested', 'cancelled', 'unknown'];
		assert.deepStrictEqual(states.filter(isTerminalState), ['completed', 'failed', 'cancelled', 'unknown']);
	});

	test('a notification advances the record and records its results once', () => {
		const entry = record();

		const running = applyStateChange(entry, change('running', 2), NOW);
		const streaming = applyStateChange(entry, change('streaming', 3, { resultIds: ['rs_1', 'rs_2'] }), NOW);
		const completed = applyStateChange(entry, change('completed', 4, { resultIds: ['rs_2', 'rs_3'] }), NOW);

		assert.deepStrictEqual({
			running,
			streaming,
			completed,
			state: entry.state,
			sequence: entry.sequence,
			resultIds: entry.resultIds,
			endedAt: entry.endedAt,
		}, {
			running: { kind: 'applied', becameTerminal: false },
			streaming: { kind: 'applied', becameTerminal: false },
			completed: { kind: 'applied', becameTerminal: true },
			state: 'completed',
			sequence: 4,
			resultIds: ['rs_1', 'rs_2', 'rs_3'],
			endedAt: NOW,
		});
	});

	test('a repeated or older sequence is ignored', () => {
		const entry = record('running', 3);

		assert.deepStrictEqual(applyStateChange(entry, change('streaming', 3), NOW), { kind: 'stale', reason: 'older-or-equal' });
		assert.deepStrictEqual(applyStateChange(entry, change('streaming', 2), NOW), { kind: 'stale', reason: 'older-or-equal' });
		assert.deepStrictEqual({ state: entry.state, sequence: entry.sequence }, { state: 'running', sequence: 3 });
	});

	test('a gap asks for one calibration read and changes nothing by itself', () => {
		const entry = record('running', 3);

		const update = applyStateChange(entry, change('completed', 7), NOW);

		assert.deepStrictEqual({ update, state: entry.state, sequence: entry.sequence }, {
			update: { kind: 'gap', missingFrom: 4 },
			state: 'running',
			sequence: 3,
		});
	});

	test('a calibration answer installs the skipped states in one step', () => {
		const entry = record('running', 3);
		const epochBefore = entry.stateEpoch;

		const update = applyCalibration(entry, change('completed', 7, { resultIds: ['rs_9'] }), epochBefore, NOW);

		assert.deepStrictEqual({
			update,
			state: entry.state,
			sequence: entry.sequence,
			resultIds: entry.resultIds,
		}, {
			update: { kind: 'applied', becameTerminal: true },
			state: 'completed',
			sequence: 7,
			resultIds: ['rs_9'],
		});
	});

	test('a calibration answer that arrives after a newer notification is discarded', () => {
		const entry = record('running', 3);
		const epochBefore = entry.stateEpoch;
		// A notification lands while the calibration read is in flight.
		applyStateChange(entry, change('streaming', 4), NOW);

		const update = applyCalibration(entry, change('completed', 7), epochBefore, NOW);

		assert.deepStrictEqual({ update, state: entry.state, sequence: entry.sequence }, {
			update: { kind: 'stale', reason: 'older-or-equal' },
			state: 'streaming',
			sequence: 4,
		});
	});

	test('a terminal state is frozen: nothing revives it', () => {
		for (const terminal of ['completed', 'failed', 'cancelled', 'unknown'] as const) {
			const entry = record(terminal, 5);

			assert.deepStrictEqual(applyStateChange(entry, change('running', 6), NOW), { kind: 'stale', reason: 'terminal' }, terminal);
			assert.deepStrictEqual(applyStateChange(entry, change('completed', 6), NOW), { kind: 'stale', reason: 'terminal' }, terminal);
			assert.deepStrictEqual(applyCancelReply(entry, 'running', true, NOW), { kind: 'stale', reason: 'terminal' }, terminal);
			assert.deepStrictEqual({ state: entry.state, sequence: entry.sequence }, { state: terminal, sequence: 5 }, terminal);
		}
	});

	test('a notification from another runtime generation is ignored before the sequence is even compared', () => {
		const entry = record('running', 3);

		const update = applyStateChange(entry, { state: 'completed', sequence: 4, runtimeGeneration: 2 }, NOW);

		assert.deepStrictEqual({ update, state: entry.state, sequence: entry.sequence }, {
			update: { kind: 'stale', reason: 'wrong-generation' },
			state: 'running',
			sequence: 3,
		});
	});

	test('a cancel reply marks the intent without touching the sequence', () => {
		const entry = record('running', 3);

		const update = applyCancelReply(entry, 'running', true, NOW);

		assert.deepStrictEqual({ update, state: entry.state, sequence: entry.sequence }, {
			update: { kind: 'applied', becameTerminal: false },
			state: 'cancel_requested',
			sequence: 3,
		});
	});

	test('a cancel reply that reports a terminal outcome ends the run without inventing a sequence', () => {
		const entry = record('running', 3);

		const update = applyCancelReply(entry, 'cancelled', true, NOW);

		assert.deepStrictEqual({
			update,
			state: entry.state,
			sequence: entry.sequence,
			endedAt: entry.endedAt,
		}, {
			update: { kind: 'applied', becameTerminal: true },
			state: 'cancelled',
			sequence: 3,
			endedAt: NOW,
		});
	});

	test('a rejected cancel leaves the run as the runtime described it', () => {
		const entry = record('running', 3);

		const update = applyCancelReply(entry, 'running', false, NOW);

		assert.deepStrictEqual({ update, state: entry.state }, {
			update: { kind: 'stale', reason: 'older-or-equal' },
			state: 'running',
		});
	});

	test('an unknown outcome keeps its reason and is terminal', () => {
		const entry = record('running', 3);

		markUnknown(entry, 'reply-lost', NOW);

		assert.deepStrictEqual({
			state: entry.state,
			reason: entry.unknownReason,
			terminal: isTerminalState(entry.state),
			endedAt: entry.endedAt,
			mutex: holdsMutex(entry),
		}, {
			state: 'unknown',
			reason: 'reply-lost',
			terminal: true,
			endedAt: NOW,
			mutex: false,
		});
	});

	test('a request the runtime refused before running is a plain failure, not unknown', () => {
		const entry = record();
		const error: INyalaRuntimeErrorObject = { code: -32602, message: 'Invalid Nyala request', data: { kind: 'INVALID_PARAMS', retryable: false, safeDetail: 'mode statement and selection run one statement; use mode script' } };

		markNotSent(entry, error, NOW);

		assert.deepStrictEqual({
			state: entry.state,
			notSent: entry.notSent,
			kind: entry.error?.data.kind,
			unknownReason: entry.unknownReason,
		}, {
			state: 'failed',
			notSent: true,
			kind: 'INVALID_PARAMS',
			unknownReason: undefined,
		});
	});

	test('an unknown outcome is never overwritten by a later cancellation or failure', () => {
		const entry = record('running', 3);
		markUnknown(entry, 'runtime-restarted', NOW);

		markNotSent(entry, cancelledError(), NOW + 1);
		applyStateChange(entry, change('failed', 4), NOW + 1);

		assert.deepStrictEqual({ state: entry.state, reason: entry.unknownReason, error: entry.error }, {
			state: 'unknown',
			reason: 'runtime-restarted',
			error: undefined,
		});
	});

	test('a finished run keeps its results and its mutex is free', () => {
		const entry = record('completed', 4);
		entry.resultIds.push('rs_1');

		assert.deepStrictEqual({ mutex: holdsMutex(entry), ownsResults: ownsResults(entry) }, { mutex: false, ownsResults: true });
	});

	test('a run without results owns none', () => {
		const entry = record('completed', 4);
		assert.strictEqual(ownsResults(entry), false);
	});
});
