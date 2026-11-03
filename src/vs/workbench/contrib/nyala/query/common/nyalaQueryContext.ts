/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The execution target of one query tab (N-202). A `NyalaQueryContext` belongs to exactly one
// query and records which connection that query was bound to, at the moment it was bound. It is
// never derived from "the active connection": two tabs, two contexts, and activating a tab only
// changes which context is in front of the user.
//
// The identity split is deliberate (ADR 0007):
//
//   queryId     EditorInput identity. Stable while the tab exists; the text model is keyed by it.
//   profileId   The connection the user picked. Not an identity of the query.
//   sessionId + sessionGeneration + runtimeGeneration
//               The runtime identity that was valid when the query was bound. Once the runtime
//               restarts, these values name a session that no longer exists, and the context is
//               unbound rather than silently pointed at a new one.

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { INyalaRuntimeState } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeIpc.js';

/**
 * The session one query tab is allowed to talk to. Captured when the user binds the tab; never
 * refreshed in place. A later session, even for the same profile, is a different binding.
 */
export interface INyalaQueryBinding {
	readonly profileId: string;
	/** The profile label at bind time, so the tab can explain itself without another lookup. */
	readonly profileName: string;
	readonly sessionId: string;
	readonly sessionGeneration: number;
	readonly runtimeGeneration: number;
}

/** Why a tab stopped being bound. Shown to the user; the tab never rebinds on its own. */
export type NyalaQueryUnboundReason = 'never-bound' | 'connection-closed' | 'runtime-restarted' | 'runtime-unavailable';

export interface INyalaQueryBindingOptions {
	/** The profile's own read-only flag; a tab cannot widen what the connection allows. */
	readonly readOnly: boolean;
	/** Set by drivers that have a database concept. SQLite has none, so it stays undefined. */
	readonly defaultDatabase?: string;
	/** Set by drivers that have a schema concept. SQLite has none, so it stays undefined. */
	readonly defaultSchema?: string;
}

/**
 * One query's execution target. Mutable only through `bind`/`unbind`, and only by the service that
 * owns the tab lifecycle.
 */
export class NyalaQueryContext extends Disposable {

	private readonly _onDidChangeBinding = this._register(new Emitter<void>());
	/** Fires whenever the binding, or the reason it is absent, changes. */
	readonly onDidChangeBinding: Event<void> = this._onDidChangeBinding.event;

	private _binding: INyalaQueryBinding | undefined;
	private _reason: NyalaQueryUnboundReason = 'never-bound';
	private _readOnly = true;
	private _defaultDatabase: string | undefined;
	private _defaultSchema: string | undefined;

	constructor(readonly queryId: string) {
		super();
	}

	get binding(): INyalaQueryBinding | undefined {
		return this._binding;
	}

	get profileId(): string | undefined {
		return this._binding?.profileId;
	}

	get sessionId(): string | undefined {
		return this._binding?.sessionId;
	}

	get sessionGeneration(): number | undefined {
		return this._binding?.sessionGeneration;
	}

	get runtimeGeneration(): number | undefined {
		return this._binding?.runtimeGeneration;
	}

	/** Whether the connection the tab was bound to is read-only. Safe default until bound. */
	get readOnly(): boolean {
		return this._readOnly;
	}

	get defaultDatabase(): string | undefined {
		return this._defaultDatabase;
	}

	get defaultSchema(): string | undefined {
		return this._defaultSchema;
	}

	get isBound(): boolean {
		return this._binding !== undefined;
	}

	/** The reason the tab has no binding; `never-bound` until it once had one. */
	get unboundReason(): NyalaQueryUnboundReason {
		return this._reason;
	}

	bind(binding: INyalaQueryBinding, options: INyalaQueryBindingOptions): void {
		this._binding = binding;
		this._reason = 'never-bound';
		this._readOnly = options.readOnly;
		this._defaultDatabase = options.defaultDatabase;
		this._defaultSchema = options.defaultSchema;
		this._onDidChangeBinding.fire();
	}

	unbind(reason: Exclude<NyalaQueryUnboundReason, 'never-bound'>): void {
		if (!this._binding && this._reason === reason) {
			return;
		}
		this._binding = undefined;
		this._reason = reason;
		this._readOnly = true;
		this._defaultDatabase = undefined;
		this._defaultSchema = undefined;
		this._onDidChangeBinding.fire();
	}

	/**
	 * Whether this binding still names something the runtime can answer for. A tab whose session
	 * belongs to an older runtime generation is not usable, even if nobody has told it yet.
	 */
	isBindingCurrent(runtime: INyalaRuntimeState): boolean {
		return this._binding !== undefined
			&& runtime.status === 'ready'
			&& runtime.generation === this._binding.runtimeGeneration;
	}

	/**
	 * SQL can always be written; only a current binding may execute. This is the single predicate
	 * the UI and the future execute command share, so an unbound tab cannot fall back to another
	 * connection by accident.
	 */
	canExecute(runtime: INyalaRuntimeState): boolean {
		return this.isBindingCurrent(runtime);
	}
}

export interface INyalaQueryBindingFailure {
	readonly ok: false;
	readonly message: string;
}

export interface INyalaQueryBindingSuccess {
	readonly ok: true;
	readonly binding: INyalaQueryBinding;
}

export type INyalaQueryBindingResult = INyalaQueryBindingSuccess | INyalaQueryBindingFailure;

export const INyalaQueryContextService = createDecorator<INyalaQueryContextService>('nyalaQueryContextService');

export interface INyalaQueryContextService {
	readonly _serviceBrand: undefined;

	/** The context of an existing query, if the tab is still alive. */
	get(queryId: string): NyalaQueryContext | undefined;

	/**
	 * Creates (or returns) the context for a query. A tab passes the id it will use; only a tab
	 * created without one gets a generated id.
	 */
	create(queryId?: string): NyalaQueryContext;

	/** Drops a closed tab's context. Idempotent. */
	release(queryId: string): void;

	/**
	 * Binds one tab to one profile. Connects the profile first when it has no session, adopts the
	 * session when it already has one, and never touches another tab's context.
	 */
	bind(context: NyalaQueryContext, profileId: string): Promise<INyalaQueryBindingResult>;

	/** The live runtime state, so a tab can decide whether it may execute. */
	readonly runtimeState: INyalaRuntimeState;
}
