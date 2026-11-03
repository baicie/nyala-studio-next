/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The window's owner of query contexts (N-202). It is the only place a tab's execution target is
// created, bound or invalidated. Tabs never read a global "active connection" and never rebind
// themselves: when the session behind a tab goes away, the service unbinds it and the tab offers
// an explicit "change connection" action.
//
// Responsibilities:
//   - keep one `NyalaQueryContext` per query id, for the tab's lifetime;
//   - bind a tab to a profile, connecting it or adopting its existing session;
//   - watch the runtime generation and the connection rows, and unbind every tab whose session no
//     longer exists (runtime restart, disconnect, failed runtime);
//   - never carry a session across a runtime generation.

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INyalaRuntimeState } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeIpc.js';
import { INyalaConnectionService } from '../../connections/common/nyalaConnectionService.js';
import { INyalaQueryBindingResult, INyalaQueryContextService, NyalaQueryContext } from './nyalaQueryContext.js';

export class NyalaQueryContextService extends Disposable implements INyalaQueryContextService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidRelease = this._register(new Emitter<string>());
	readonly onDidRelease: Event<string> = this._onDidRelease.event;

	private readonly contexts = new Map<string, NyalaQueryContext>();
	/**
	 * The latest binding intent per query id. Every `bind` call claims a new number and may only
	 * commit while its number is still the current one; a reply that arrives after a later intent
	 * (or after the tab was closed) is dropped instead of overwriting the newer decision.
	 *
	 * Keyed by query id, not by the context object, and compared together with the context: two
	 * contexts may briefly share an id while an editor input is replaced, and a reply meant for the
	 * old object must never bind the new one.
	 */
	private readonly intents = new Map<string, { readonly context: NyalaQueryContext; readonly intent: number }>();
	private nextIntent = 0;
	/**
	 * The runtime generation this service has already seen. Seeded from the live state: the first
	 * event after a window load may already be a restart, and comparing it against `undefined`
	 * would let a switch survive a generation it never belonged to.
	 */
	private lastSeenGeneration: number;

	constructor(
		@INyalaConnectionService private readonly connectionService: INyalaConnectionService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.lastSeenGeneration = this.connectionService.runtimeState.generation;
		this._register(this.connectionService.onDidChangeConnections(() => this.reconcile()));
		this._register(this.connectionService.onDidChangeRuntime(state => this.onRuntimeState(state)));
	}

	get runtimeState(): INyalaRuntimeState {
		return this.connectionService.runtimeState;
	}

	get(queryId: string): NyalaQueryContext | undefined {
		return this.contexts.get(queryId);
	}

	create(queryId?: string): NyalaQueryContext {
		const id = queryId ?? generateUuid();
		const existing = this.contexts.get(id);
		if (existing) {
			return existing;
		}
		const context = new NyalaQueryContext(id);
		// The service owns the lifetime; the tab releases it when it closes.
		this.contexts.set(id, context);
		return context;
	}

	release(queryId: string): void {
		const context = this.contexts.get(queryId);
		if (!context) {
			return;
		}
		this.contexts.delete(queryId);
		// A reply still in flight must not bind the released object, nor a later one that reuses
		// the same id: dropping the intent makes every outstanding call stale.
		this.intents.delete(queryId);
		context.dispose();
		this._onDidRelease.fire(queryId);
	}

	async bind(context: NyalaQueryContext, profileId: string): Promise<INyalaQueryBindingResult> {
		// Only a context this service owns may be bound through it; a stray object could otherwise
		// hold a handle nobody reconciles.
		if (this.contexts.get(context.queryId) !== context) {
			return { ok: false, message: localize('nyala.query.bind.unknownContext', 'This query tab is no longer open.') };
		}

		const row = this.connectionService.connections.find(state => state.profile.profileId === profileId);
		if (!row) {
			// A profile that does not exist is a bad request, not a reason to disturb a working
			// binding: nothing has been switched away from yet.
			return { ok: false, message: localize('nyala.query.bind.unknownProfile', 'That connection does not exist.') };
		}

		const want = this.claimIntent(context);

		// Picking a *different* profile is a switch, and it starts now, before the new connection is
		// opened: the tab gives up the old target so it cannot execute against the connection the
		// user just moved away from. Picking the profile the tab already has keeps the binding
		// untouched, so a failed refresh cannot cost the user a working connection.
		const previous = context.binding;
		if ((previous && previous.profileId !== profileId) || context.bindingState === 'switching') {
			context.beginSwitch(row.profile.displayName);
		}

		// Every failure from here on ends the switch; only the latest intent may do so, because a
		// newer choice owns whatever state the tab is in now.
		const fail = (message: string): INyalaQueryBindingResult => {
			if (this.isCurrentIntent(context, want)) {
				context.failSwitch('connection-failed');
			}
			return { ok: false, message };
		};

		if (row.status === 'error' || row.status === 'lost') {
			return fail(describeFailure(row));
		}
		if (row.status !== 'connected' || !row.handle) {
			await this.connectionService.connect(profileId);
		}

		// The row may have changed while this call waited: the tab may have been closed, another
		// intent may have superseded this one, or the runtime may have restarted. All three make
		// this reply stale, and a stale reply must not bind anything.
		if (!this.isCurrentIntent(context, want)) {
			return { ok: false, message: supersededMessage() };
		}

		const connected = this.connectionService.connections.find(state => state.profile.profileId === profileId);
		if (!connected || connected.status !== 'connected' || !connected.handle) {
			return fail(describeFailure(connected));
		}

		const handle = connected.handle;
		// The handle is bound as a whole, and only if the runtime that issued it is the one the
		// workbench is talking to now. A generation change while waiting means the session belongs
		// to a process that is gone.
		if (!this.isReadyGeneration(handle.runtimeGeneration)) {
			return fail(localize('nyala.query.bind.staleRuntime', 'The runtime restarted while connecting. Choose a connection again.'));
		}
		if (!this.isCurrentIntent(context, want)) {
			return { ok: false, message: supersededMessage() };
		}

		context.bind({
			profileId: handle.profileId,
			profileName: connected.profile.displayName,
			sessionId: handle.sessionId,
			sessionGeneration: handle.sessionGeneration,
			runtimeGeneration: handle.runtimeGeneration,
		}, {
			readOnly: connected.profile.target.readOnly,
		});

		this.logService.trace(`Nyala: query ${context.queryId} bound to ${profileId}/${handle.sessionId}`);
		return { ok: true, binding: context.binding! };
	}

	/** Claims the next intent for a context, superseding whatever that query was doing. */
	private claimIntent(context: NyalaQueryContext): number {
		const intent = ++this.nextIntent;
		this.intents.set(context.queryId, { context, intent });
		return intent;
	}

	/**
	 * Whether the intent that is committing is still the one the user last expressed, for the same
	 * context object. A released context, a re-created context under the same id, a later bind and
	 * a runtime generation change all answer `false`.
	 */
	private isCurrentIntent(context: NyalaQueryContext, intent: number): boolean {
		if (this.contexts.get(context.queryId) !== context || context.isDisposed) {
			return false;
		}
		const current = this.intents.get(context.queryId);
		return current?.context === context && current.intent === intent;
	}

	/** Whether the handle's runtime generation is the one this window is currently talking to. */
	private isReadyGeneration(generation: number): boolean {
		const state = this.connectionService.runtimeState;
		return state.status === 'ready' && state.generation === generation;
	}

	override dispose(): void {
		// Contexts are created here, so this service is their owner: a tab that never closed must
		// not leave a live emitter (or a session reference) behind when the window goes away.
		for (const context of this.contexts.values()) {
			context.dispose();
		}
		this.contexts.clear();
		this.intents.clear();
		super.dispose();
	}

	/** Unbinds every tab whose binding no longer matches the profile rows. */
	private reconcile(): void {
		for (const context of this.contexts.values()) {
			const binding = context.binding;
			if (!binding) {
				continue;
			}
			const row = this.connectionService.connections.find(state => state.profile.profileId === binding.profileId);
			if (!row) {
				context.unbind('connection-closed');
				continue;
			}
			if (!row.handle || row.status !== 'connected') {
				context.unbind(row.status === 'lost' ? 'runtime-restarted' : 'connection-closed');
				continue;
			}
			if (row.handle.sessionId !== binding.sessionId || row.handle.sessionGeneration !== binding.sessionGeneration || row.handle.runtimeGeneration !== binding.runtimeGeneration) {
				// The profile was reconnected behind this tab's back (a new session). The tab keeps
				// its text but loses its target: silently adopting the new session would make old
				// tabs run against a connection the user did not choose for them.
				context.unbind('connection-closed');
			}
		}
	}

	private onRuntimeState(state: INyalaRuntimeState): void {
		const generation = this.lastSeenGeneration;
		this.lastSeenGeneration = state.generation;
		// A generation change or a dead runtime invalidates whatever a pending bind was about to
		// install: the session it read belongs to the runtime that just went away. The intents are
		// dropped so no reply can commit, and every switch in flight ends here — this is the only
		// place that knows why, and a tab must not wait forever for a reply that will never come.
		if (state.status !== 'ready' || generation !== state.generation) {
			this.intents.clear();
			const switched = state.status === 'failed' || state.status === 'stopped' ? 'runtime-unavailable' : 'runtime-restarted';
			for (const context of this.contexts.values()) {
				if (context.bindingState === 'switching') {
					context.unbind(switched);
				}
			}
		}
		if (state.status === 'ready') {
			this.reconcile();
			return;
		}
		const reason = state.status === 'failed' || state.status === 'stopped' ? 'runtime-unavailable' : 'runtime-restarted';
		for (const context of this.contexts.values()) {
			if (context.isBound) {
				context.unbind(reason);
			}
		}
	}
}

/** Why a bind that was overtaken by a later action did not change anything. */
function supersededMessage(): string {
	return localize('nyala.query.bind.superseded', 'A newer connection choice replaced this one.');
}

/** A short, safe explanation for a row that cannot be bound. */
function describeFailure(row: { readonly error?: { readonly message: string } | { readonly data?: { readonly safeDetail?: string } } } | undefined): string {
	if (!row) {
		return localize('nyala.query.bind.unknownProfile', 'That connection does not exist.');
	}
	const error = row.error as { readonly message?: string; readonly data?: { readonly safeDetail?: string } } | undefined;
	return error?.data?.safeDetail ?? error?.message ?? localize('nyala.query.bind.connectFailed', 'The connection could not be opened.');
}
