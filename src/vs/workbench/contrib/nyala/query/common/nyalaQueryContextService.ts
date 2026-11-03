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

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INyalaRuntimeState } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeIpc.js';
import { INyalaConnectionService } from '../../connections/common/nyalaConnectionService.js';
import { INyalaQueryBindingResult, INyalaQueryContextService, NyalaQueryContext } from './nyalaQueryContext.js';

export class NyalaQueryContextService extends Disposable implements INyalaQueryContextService {

	declare readonly _serviceBrand: undefined;

	private readonly contexts = new Map<string, NyalaQueryContext>();

	constructor(
		@INyalaConnectionService private readonly connectionService: INyalaConnectionService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

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
		context.dispose();
	}

	async bind(context: NyalaQueryContext, profileId: string): Promise<INyalaQueryBindingResult> {
		// Only a context this service owns may be bound through it; a stray object could otherwise
		// hold a handle nobody reconciles.
		if (this.contexts.get(context.queryId) !== context) {
			return { ok: false, message: localize('nyala.query.bind.unknownContext', 'This query tab is no longer open.') };
		}

		const row = this.connectionService.connections.find(state => state.profile.profileId === profileId);
		if (!row) {
			return { ok: false, message: localize('nyala.query.bind.unknownProfile', 'That connection does not exist.') };
		}

		if (row.status !== 'connected' || !row.handle) {
			if (row.status === 'error' || row.status === 'lost') {
				return { ok: false, message: describeFailure(row) };
			}
			await this.connectionService.connect(profileId);
		}

		const connected = this.connectionService.connections.find(state => state.profile.profileId === profileId);
		if (!connected || connected.status !== 'connected' || !connected.handle) {
			return { ok: false, message: describeFailure(connected) };
		}

		const handle = connected.handle;
		// The profile row may have been reconnected while this tab waited; the handle read after
		// the await is the one that matters, and it is bound as a whole (never mixed with an older
		// session id from before the await).
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

	override dispose(): void {
		// Contexts are created here, so this service is their owner: a tab that never closed must
		// not leave a live emitter (or a session reference) behind when the window goes away.
		for (const context of this.contexts.values()) {
			context.dispose();
		}
		this.contexts.clear();
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

/** A short, safe explanation for a row that cannot be bound. */
function describeFailure(row: { readonly error?: { readonly message: string } | { readonly data?: { readonly safeDetail?: string } } } | undefined): string {
	if (!row) {
		return localize('nyala.query.bind.unknownProfile', 'That connection does not exist.');
	}
	const error = row.error as { readonly message?: string; readonly data?: { readonly safeDetail?: string } } | undefined;
	return error?.data?.safeDetail ?? error?.message ?? localize('nyala.query.bind.connectFailed', 'The connection could not be opened.');
}
