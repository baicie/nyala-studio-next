/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The immutable record of one execution and the rules that advance it (N-203). This module has no
// I/O on purpose: every ordering rule the service depends on -- sequence monotonicity, terminal
// states, generation filtering -- is decided here and tested without a runtime, so the service can
// stay a thin owner of timers, promises and leases.
//
// Two identities are kept apart on purpose:
//
//   executionId   the runtime's handle for one run; every query.* call is addressed by it;
//   resultId      the runtime's handle for one result set; owned by a lease, not by the execution.
//
// An execution reaching `completed` stops the "one run at a time" mutex for its query. It does not
// destroy the result: the user still has to read it. ADR 0008 section 3.

import { INyalaRuntimeErrorObject } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeContract.generated.js';

/** Where a run can be, as the v1 state machine defines it. */
export type NyalaExecutionState =
	| 'queued'
	| 'running'
	| 'streaming'
	| 'completed'
	| 'failed'
	| 'cancel_requested'
	| 'cancelled'
	| 'unknown';

const TERMINAL_STATES: ReadonlySet<NyalaExecutionState> = new Set(['completed', 'failed', 'cancelled', 'unknown']);

/** Whether nothing more will happen to this run. `unknown` is terminal: nothing can be proven. */
export function isTerminalState(state: NyalaExecutionState): boolean {
	return TERMINAL_STATES.has(state);
}

/** The immutable target of one run, frozen before the first await. */
export interface INyalaExecutionSnapshot {
	readonly queryId: string;
	readonly profileId: string;
	readonly profileName: string;
	readonly sessionId: string;
	readonly sessionGeneration: number;
	readonly runtimeGeneration: number;
	readonly sql: string;
	readonly mode: 'statement' | 'selection' | 'script';
	readonly readOnly: boolean;
	readonly startedAt: number;
}

/** Why the client itself concluded a run has an unknown outcome, as opposed to the runtime saying so. */
export type NyalaUnknownReason =
	/** The request was sent and its reply never arrived: the runtime may have run it. */
	| 'reply-lost'
	/** The runtime generation changed while the request was in flight. */
	| 'runtime-restarted'
	/** The runtime went away (failed or stopped) while the request was in flight. */
	| 'runtime-unavailable';

/**
 * One run. `sequence` is the last applied state sequence; `stateEpoch` increments on every applied
 * transition and lets a calibration read tell whether a newer answer already landed.
 */
export interface INyalaExecutionRecord {
	readonly requestId: string;
	executionId: string | undefined;
	readonly snapshot: INyalaExecutionSnapshot;
	state: NyalaExecutionState;
	sequence: number;
	stateEpoch: number;
	/** Results the runtime reported for this run, in the order it reported them. */
	readonly resultIds: string[];
	error?: INyalaRuntimeErrorObject;
	unknownReason?: NyalaUnknownReason;
	/** Set once the tab that asked for the run is gone and nobody is waiting for the reply. */
	abandoned: boolean;
	/** Set when the runtime refused the request before running anything: "it did not run" is true. */
	notSent?: boolean;
	/** Set when the runtime reported more results than one execution may keep. */
	resultLimitReached?: boolean;
	endedAt?: number;
}

/** The outcome of one state notification, so the caller knows what to do next. */
export type NyalaStateUpdate =
	/** Applied: `sequence` was newer than what the record already had. */
	| { readonly kind: 'applied'; readonly becameTerminal: boolean }
	/** Older or repeated sequence; the record is unchanged. */
	| { readonly kind: 'stale'; readonly reason: 'older-or-equal' | 'terminal' | 'wrong-generation' }
	/** A gap: the caller should read the authoritative state once. */
	| { readonly kind: 'gap'; readonly missingFrom: number };

export interface INyalaStateChange {
	readonly state: NyalaExecutionState;
	readonly sequence: number;
	/** Omitted by `query.cancel`, which answers with a state but no sequence (ADR 0008 section 5). */
	readonly runtimeGeneration?: number;
	readonly resultIds?: readonly string[];
	readonly error?: INyalaRuntimeErrorObject;
	readonly elapsedMs?: number;
}

/**
 * Applies a state change to a record. The rules, in order:
 *
 *   - a notification from another runtime generation is ignored (it cannot describe this run);
 *   - a terminal record never changes again, whatever arrives;
 *   - a sequence that is not newer is ignored;
 *   - a gap leaves the record alone and asks the caller for a calibration read;
 *   - otherwise the change is applied, and a terminal state ends the record.
 */
export function applyStateChange(record: INyalaExecutionRecord, change: INyalaStateChange, now: number): NyalaStateUpdate {
	if (change.runtimeGeneration !== undefined && change.runtimeGeneration !== record.snapshot.runtimeGeneration) {
		return { kind: 'stale', reason: 'wrong-generation' };
	}
	if (isTerminalState(record.state) && record.state === change.state) {
		return { kind: 'stale', reason: 'terminal' };
	}
	if (isTerminalState(record.state)) {
		// A terminal state has already been decided; a later notification cannot revive the run.
		return { kind: 'stale', reason: 'terminal' };
	}
	if (change.sequence <= record.sequence) {
		return { kind: 'stale', reason: 'older-or-equal' };
	}
	if (change.sequence > record.sequence + 1) {
		return { kind: 'gap', missingFrom: record.sequence + 1 };
	}
	commit(record, change, now);
	return { kind: 'applied', becameTerminal: isTerminalState(record.state) };
}

/**
 * Applies an authoritative `query.getState` answer. The caller passes the epoch it saw before
 * asking; if the record has moved since, the answer is discarded, because a newer notification
 * already knows more than the read did.
 */
export function applyCalibration(record: INyalaExecutionRecord, change: INyalaStateChange, epochBeforeRead: number, now: number): NyalaStateUpdate {
	if (record.stateEpoch !== epochBeforeRead) {
		return { kind: 'stale', reason: 'older-or-equal' };
	}
	// This answer is the response to the gap, so a jump is exactly what it is supposed to carry;
	// only a sequence that is not newer than the record can be discarded.
	if (change.runtimeGeneration !== undefined && change.runtimeGeneration !== record.snapshot.runtimeGeneration) {
		return { kind: 'stale', reason: 'wrong-generation' };
	}
	if (isTerminalState(record.state)) {
		return { kind: 'stale', reason: 'terminal' };
	}
	if (change.sequence <= record.sequence) {
		return { kind: 'stale', reason: 'older-or-equal' };
	}
	commit(record, change, now);
	return { kind: 'applied', becameTerminal: isTerminalState(record.state) };
}

/**
 * Applies the state of a `query.cancel` reply. It carries no sequence, so it may never rewrite the
 * sequence or pretend to be authoritative: it only settles a terminal outcome the client did not
 * see yet, and otherwise records the user's intent.
 */
export function applyCancelReply(record: INyalaExecutionRecord, state: NyalaExecutionState, accepted: boolean, now: number): NyalaStateUpdate {
	if (isTerminalState(record.state)) {
		return { kind: 'stale', reason: 'terminal' };
	}
	if (isTerminalState(state)) {
		// The runtime says the run has already ended; adopt that outcome without touching the
		// sequence, which only the notification stream owns.
		record.state = state;
		record.stateEpoch++;
		record.endedAt = now;
		return { kind: 'applied', becameTerminal: true };
	}
	if (accepted && record.state !== 'cancel_requested') {
		// A request, not an outcome: the runtime may still complete the statement.
		record.state = 'cancel_requested';
		record.stateEpoch++;
		return { kind: 'applied', becameTerminal: false };
	}
	return { kind: 'stale', reason: 'older-or-equal' };
}

/**
 * Marks a run whose outcome cannot be proven. Used when the reply was lost or the runtime left
 * mid-flight, never for a request the runtime refused before running anything.
 */
export function markUnknown(record: INyalaExecutionRecord, reason: NyalaUnknownReason, now: number): void {
	if (isTerminalState(record.state)) {
		return;
	}
	record.state = 'unknown';
	record.unknownReason = reason;
	record.stateEpoch++;
	record.endedAt = now;
}

/** Marks a run that provably never reached the runtime. */
export function markNotSent(record: INyalaExecutionRecord, error: INyalaRuntimeErrorObject, now: number): void {
	if (isTerminalState(record.state)) {
		return;
	}
	record.state = 'failed';
	record.error = error;
	record.notSent = true;
	record.stateEpoch++;
	record.endedAt = now;
}

/** Whether the record keeps its query's "one run at a time" mutex. */
export function holdsMutex(record: INyalaExecutionRecord): boolean {
	return !isTerminalState(record.state);
}

/**
 * Whether the record still owns results that nobody released. A finished run may own results; a
 * failed one usually does not, but the runtime is the only authority on what it produced.
 */
export function ownsResults(record: INyalaExecutionRecord): boolean {
	return record.resultIds.length > 0;
}

function commit(record: INyalaExecutionRecord, change: INyalaStateChange, now: number): void {
	record.state = change.state;
	record.sequence = change.sequence;
	record.stateEpoch++;
	if (change.error) {
		record.error = change.error;
	}
	if (change.resultIds) {
		for (const resultId of change.resultIds) {
			if (!record.resultIds.includes(resultId)) {
				record.resultIds.push(resultId);
			}
		}
	}
	if (isTerminalState(change.state)) {
		record.endedAt = now;
	}
}
