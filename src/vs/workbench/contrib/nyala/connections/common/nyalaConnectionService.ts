/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Workbench-facing connection service (N-201). It is the only place the renderer learns about
// sessions, and it owns their identity: a `NyalaConnection` is a user connection (a persisted
// profile plus the session the runtime opened for it), never a mutable global "current
// connection". A tab that later runs queries holds its own `INyalaConnectionHandle`, and every
// call carries the session id, its generation and the runtime generation they belong to.
//
// Nothing here touches a database directly: each call goes through the typed main-process bridge
// (`nyalaRuntimeIpc.ts`), which validates it against the v1 contract and forwards it to the
// window's own runtime process (ADR 0004 section 3, ADR 0006).

import { Emitter, Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { INyalaMetadataDescribeResult, INyalaMetadataListObjectsResult, NYALA_ERROR_KINDS } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeContract.generated.js';
import { INyalaRuntimeCallResult, INyalaRuntimeState, NyalaRuntimeCommand } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeIpc.js';
import { INyalaRuntimeErrorObject } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeProtocol.js';
import { asRuntimeError, INyalaConnectionTarget, NyalaRequestError } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeRequest.js';

/** A connection the user added: a persisted target and the session opened for it. */
export interface INyalaConnectionProfile {
	/** Stable within the workbench; the runtime knows no profile ids. */
	readonly profileId: string;
	readonly displayName: string;
	readonly target: INyalaConnectionTarget;
}

/**
 * The identity a query tab will hold (ADR 0006). Every value is captured when the session opens:
 * once the runtime restarts, `runtimeGeneration` no longer matches and the session is void.
 */
export interface INyalaConnectionHandle {
	readonly profileId: string;
	readonly sessionId: string;
	readonly sessionGeneration: number;
	readonly runtimeGeneration: number;
}

export type NyalaConnectionStatus = 'disconnected' | 'testing' | 'connecting' | 'connected' | 'error' | 'lost';

export interface INyalaConnectionState {
	readonly profile: INyalaConnectionProfile;
	readonly status: NyalaConnectionStatus;
	/** Present when `status` is `error` or `lost`. */
	readonly error?: INyalaRuntimeErrorObject | { readonly message: string };
	readonly handle?: INyalaConnectionHandle;
}

export const INyalaRuntimeBridge = createDecorator<INyalaRuntimeBridge>('nyalaRuntimeBridge');
// A service identifier needs the brand; the injected value is the decorator above.
export interface INyalaRuntimeBridge {
	readonly _serviceBrand: undefined;
	getState(): Promise<INyalaRuntimeState>;
	call<T>(command: NyalaRuntimeCommand, params: object): Promise<INyalaRuntimeCallResult<T>>;
	readonly onDidChangeState: Event<INyalaRuntimeState>;
}

export const INyalaConnectionService = createDecorator<INyalaConnectionService>('nyalaConnectionService');
export interface INyalaConnectionService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeConnections: Event<void>;
	readonly onDidChangeRuntime: Event<INyalaRuntimeState>;
	readonly connections: readonly INyalaConnectionState[];
	readonly runtimeState: INyalaRuntimeState;
	/**
	 * Adds a profile and remembers it for the next window, unless a profile for the same path is
	 * already known. Returns the identity of the new or existing profile.
	 */
	addProfile(profile: Omit<INyalaConnectionProfile, 'profileId'>): Promise<string>;
	/** Loads the profiles saved by earlier windows; sessions are not restored. */
	restoreProfiles(): Promise<void>;
	/** Asks the main process where this window's runtime is; resolves the live state. */
	refreshRuntime(): Promise<INyalaRuntimeState>;
	connect(profileId: string): Promise<void>;
	disconnect(profileId: string): Promise<void>;
	refresh(profileId: string): Promise<void>;
	/** The Tables / Views / Indexes names a connected profile last loaded. */
	catalog(profileId: string): INyalaCatalog | undefined;
	listObjects(handle: INyalaConnectionHandle, kinds: readonly ('table' | 'view' | 'index')[]): Promise<INyalaMetadataListObjectsResult>;
	describe(handle: INyalaConnectionHandle, object: { readonly schema?: string; readonly name: string }): Promise<INyalaMetadataDescribeResult>;
}

/** The stable part of the tree a profile expands into. */
export interface INyalaCatalog {
	readonly tables: string[];
	readonly views: string[];
	readonly indexes: string[];
}

/**
 * The service behind the Connections view. One instance per workbench window; the main process
 * gives this window's calls its own runtime process, so two windows never see one another's
 * sessions.
 */
export class NyalaConnectionService extends Disposable implements INyalaConnectionService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeConnections = this._register(new Emitter<void>());
	readonly onDidChangeConnections = this._onDidChangeConnections.event;

	private readonly _onDidChangeRuntime = this._register(new Emitter<INyalaRuntimeState>());
	readonly onDidChangeRuntime = this._onDidChangeRuntime.event;

	private readonly states = new Map<string, INyalaConnectionState>();
	private readonly catalogs = new Map<string, INyalaCatalog>();
	private lastRuntimeGeneration = 0;
	/**
	 * One counter per profile, bumped whenever a new connect, disconnect, refresh or runtime state
	 * supersedes whatever that profile was doing. A response may only commit while its attempt is
	 * still the current one; an older connect closes the session it opened instead of installing it.
	 */
	private readonly attempts = new Map<string, number>();
	/**
	 * Sessions the runtime opened for a profile that the row no longer shows: a superseded connect
	 * whose reply arrived late, a reconnect that replaced a handle, a refresh that decided the
	 * session was unusable. Closing is best effort, so a session the runtime refused to close stays
	 * here — it is still open, and only a later close attempt may forget it. Pruning happens on
	 * every runtime generation change, because a new runtime knows none of them.
	 */
	private readonly stranded = new Map<string, INyalaConnectionHandle>();

	constructor(
		private readonly bridge: INyalaRuntimeBridge,
		private readonly logService: ILogService,
		private readonly storageService?: IStorageService,
	) {
		super();
		this._register(this.bridge.onDidChangeState(state => this.onRuntimeState(state)));
	}

	get connections(): readonly INyalaConnectionState[] {
		return [...this.states.values()];
	}

	get runtimeState(): INyalaRuntimeState {
		return this.currentRuntimeState;
	}

	private currentRuntimeState: INyalaRuntimeState = { generation: 0, status: 'idle' };

	/**
	 * Reads the runtime state the main process holds for this window. The first read only records
	 * the generation: whatever sessions existed before this renderer did not survive a reload.
	 */
	async refreshRuntime(): Promise<INyalaRuntimeState> {
		const state = await this.bridge.getState();
		this.onRuntimeState(state);
		return state;
	}

	/** Catalog entries of a connected profile, for the tree. */
	catalog(profileId: string): INyalaCatalog | undefined {
		return this.catalogs.get(profileId);
	}

	/** Registers a connection whose metadata the view may ask for. */

	async addProfile(profile: Omit<INyalaConnectionProfile, 'profileId'>): Promise<string> {
		// A path identifies the database the user chose; it is not an identity. Deduplicating on it
		// keeps "add the same file twice" idempotent, while the id below stays independent of the
		// path's characters and can never collide with another path's id. Paths arrive from the
		// file dialog (`URI.fsPath`), so they are already normalized; deduplication compares them
		// exactly and leaves platform rules to the file service.
		const existing = this.profileForPath(profile.target.path);
		if (existing) {
			return existing.profile.profileId;
		}
		const profileId = `p_${generateUuid()}`;
		this.states.set(profileId, { profile: { ...profile, profileId }, status: 'disconnected' });
		this.saveProfiles();
		this._onDidChangeConnections.fire();
		return profileId;
	}

	async restoreProfiles(): Promise<void> {
		const stored = parseStoredProfiles(this.storageService?.get(NYALA_PROFILES_STORAGE_KEY, StorageScope.PROFILE, ''));
		const usedIds = new Set<string>();
		const usedPaths = new Set<string>();
		let migrated = false;
		for (const profile of stored) {
			const pathKey = profile.path;
			if (usedPaths.has(pathKey)) {
				migrated = true;
				continue;
			}
			// Profiles saved by the path-derived scheme may share an id with another path after a
			// lossy replacement (`a-b` and `a/b`), and they are re-keyed to a fresh stable id. New
			// ids (`p_<uuid>`) are kept, so the same profile keeps its identity across windows.
			const legacy = !PROFILE_ID_PATTERN.test(profile.profileId);
			let profileId = profile.profileId;
			if (legacy || usedIds.has(profileId)) {
				profileId = `p_${generateUuid()}`;
				migrated = true;
			}
			usedIds.add(profileId);
			usedPaths.add(pathKey);
			if (this.states.has(profileId)) {
				// A second restore must not replace a live row (and forget the session it holds).
				continue;
			}
			this.states.set(profileId, {
				profile: {
					profileId,
					displayName: profile.displayName,
					target: { driver: 'sqlite', path: profile.path, readOnly: profile.readOnly },
				},
				status: 'disconnected',
			});
		}
		if (migrated) {
			this.saveProfiles();
		}
		this._onDidChangeConnections.fire();
	}

	/** Writes the profiles, never a session; called after an addition and after a removal. */
	private saveProfiles(): void {
		if (!this.storageService) {
			return;
		}
		const stored: INyalaStoredProfile[] = [...this.states.values()].map(state => ({
			profileId: state.profile.profileId,
			displayName: state.profile.displayName,
			path: state.profile.target.path,
			readOnly: state.profile.target.readOnly,
		}));
		this.storageService.store(NYALA_PROFILES_STORAGE_KEY, JSON.stringify(stored), StorageScope.PROFILE, StorageTarget.USER);
	}

	async connect(profileId: string): Promise<void> {
		const state = this.states.get(profileId);
		if (!state) {
			return;
		}
		const attempt = this.beginAttempt(profileId);
		let opened: INyalaConnectionHandle | undefined;
		await this.withState(profileId, attempt, 'connecting', async profile => {
			try {
				// Reconnecting a profile is an explicit new session, and a profile never has two.
				// Every session this workbench still knows about — the row's own and any earlier
				// one that failed to close — must be confirmed gone first. If one survives, the
				// profile keeps that closeable handle and no new session is opened.
				const remaining = await this.retireSessions(profileId);
				if (!this.isCurrent(profileId, attempt)) {
					return;
				}
				if (remaining.length > 0) {
					this.catalogs.delete(profileId);
					this.update(profileId, {
						status: 'error',
						handle: remaining[0],
						error: { message: localize('nyala.connection.closeFailed', 'The previous session could not be closed. Disconnect again before reconnecting.') },
					});
					return;
				}
				if (this.states.get(profileId)?.handle) {
					this.catalogs.delete(profileId);
					this.update(profileId, { status: 'connecting', handle: undefined, error: undefined });
				}
				const tested = await this.bridge.call(NyalaRuntimeCommand.TestConnection, profile.target);
				if (!this.isCurrent(profileId, attempt)) {
					return;
				}
				if (!tested.ok) {
					this.fail(profileId, attempt, tested.error);
					return;
				}
				// The generation that answered is the one this session will belong to.
				this.noteRuntimeGeneration(tested.runtimeGeneration);
				if (!this.acceptGeneration(tested.runtimeGeneration)) {
					this.fail(profileId, attempt, runtimeLostWhileConnecting());
					return;
				}
				const reply = await this.bridge.call<{ sessionId: string; sessionGeneration: number }>(NyalaRuntimeCommand.OpenConnection, profile.target);
				if (!this.isCurrent(profileId, attempt)) {
					if (reply.ok) {
						// Superseded while the runtime was opening. The session is real, so it is
						// either closed here or remembered as stranded — never dropped on the floor.
						await this.closeSession({ profileId, sessionId: reply.result.sessionId, sessionGeneration: reply.result.sessionGeneration, runtimeGeneration: reply.runtimeGeneration });
					}
					return;
				}
				if (!reply.ok) {
					this.fail(profileId, attempt, reply.error);
					return;
				}
				this.noteRuntimeGeneration(reply.runtimeGeneration);
				const handle: INyalaConnectionHandle = {
					profileId,
					sessionId: reply.result.sessionId,
					sessionGeneration: reply.result.sessionGeneration,
					runtimeGeneration: reply.runtimeGeneration,
				};
				opened = handle;
				if (!this.acceptGeneration(handle.runtimeGeneration)) {
					opened = undefined;
					await this.closeSession(handle);
					this.fail(profileId, attempt, runtimeLostWhileConnecting());
					return;
				}
				const catalog = await this.readCatalog(handle);
				if (!this.isCurrent(profileId, attempt)) {
					opened = undefined;
					await this.closeSession(handle);
					return;
				}
				if (!catalog.ok) {
					// The open succeeded but the catalog did not. The Connections view cannot show
					// this profile, so the session is given back to the runtime — or, if the runtime
					// will not take it, kept as a closeable handle instead of being forgotten.
					const closed = await this.closeSession(handle);
					opened = undefined;
					if (!this.isCurrent(profileId, attempt)) {
						return;
					}
					if (closed) {
						this.fail(profileId, attempt, catalog.error);
					} else {
						// The runtime would not close it. Keep the handle so Disconnect can retry, but
						// never present the profile as connected or as having a usable catalog.
						this.catalogs.delete(profileId);
						this.update(profileId, { status: 'error', handle, error: catalog.error });
					}
					return;
				}
				this.catalogs.set(profileId, catalog.catalog);
				this.update(profileId, { status: 'connected', handle, error: undefined });
				opened = undefined;
			} catch (error) {
				// A rejection the bridge raised (IPC failure, a bug) is not an RPC answer. The session
				// this attempt opened must not outlive it, and a session that could not be closed is
				// remembered rather than abandoned: the profile's row is left describing it.
				if (opened) {
					const closed = await this.closeSession(opened);
					if (!closed) {
						this.update(profileId, {
							status: 'error',
							handle: opened,
							error: { message: localize('nyala.connection.closeFailed', 'The previous session could not be closed. Disconnect again before reconnecting.') },
						});
					}
					opened = undefined;
				}
				throw error;
			}
		});
	}

	async disconnect(profileId: string): Promise<void> {
		const attempt = this.beginAttempt(profileId);
		const state = this.states.get(profileId);
		if (!state) {
			return;
		}
		// Disconnect is the user's retry path: it closes the row's session *and* anything left
		// stranded for this profile, so a failed close earlier does not require a new window.
		const remaining = await this.retireSessions(profileId);
		if (!this.isCurrent(profileId, attempt)) {
			return;
		}
		if (remaining.length > 0) {
			this.update(profileId, {
				status: 'error',
				handle: remaining[0],
				error: { message: localize('nyala.connection.closeFailed', 'The previous session could not be closed. Disconnect again before reconnecting.') },
			});
			return;
		}
		this.catalogs.delete(profileId);
		this.update(profileId, { status: 'disconnected', handle: undefined, error: undefined });
	}

	async refresh(profileId: string): Promise<void> {
		const state = this.states.get(profileId);
		if (state?.status !== 'connected' || !state.handle) {
			return;
		}
		const attempt = this.beginAttempt(profileId);
		const handle = state.handle;
		const catalog = await this.readCatalog(handle);
		if (!this.isCurrent(profileId, attempt) || !this.sameHandle(profileId, handle)) {
			return;
		}
		if (catalog.ok) {
			this.catalogs.set(profileId, catalog.catalog);
			this._onDidChangeConnections.fire();
			return;
		}

		// A metadata read failing says nothing about the session: a protocol error, a timeout or an
		// IPC hiccup leaves the session open and usable for everything else. Only an error that
		// says the session itself is gone may retire it; discarding the handle otherwise would
		// lose the only reference to a live runtime session.
		if (isSessionGone(catalog.error)) {
			this.catalogs.delete(profileId);
			const closed = await this.closeSession(handle);
			if (!this.isCurrent(profileId, attempt)) {
				return;
			}
			this.update(profileId, closed
				? { status: 'error', handle: undefined, error: catalog.error }
				// The runtime would not close a session it also says is invalid. Keep the handle so
				// Disconnect can retry; the row must not claim to be connected without a catalog.
				: { status: 'error', handle, error: catalog.error });
			return;
		}

		this.catalogs.delete(profileId);
		this.update(profileId, { status: 'error', handle, error: catalog.error });
	}

	async listObjects(handle: INyalaConnectionHandle, kinds: readonly ('table' | 'view' | 'index')[]): Promise<INyalaMetadataListObjectsResult> {
		this.assertCurrent(handle);
		const result = await this.bridge.call<INyalaMetadataListObjectsResult>(NyalaRuntimeCommand.ListObjects, {
			sessionId: handle.sessionId,
			sessionGeneration: handle.sessionGeneration,
			kinds,
			limit: 1000,
		});
		if (!result.ok) {
			throw result.error;
		}
		return result.result;
	}

	async describe(handle: INyalaConnectionHandle, object: { readonly schema?: string; readonly name: string }): Promise<INyalaMetadataDescribeResult> {
		this.assertCurrent(handle);
		const result = await this.bridge.call<INyalaMetadataDescribeResult>(NyalaRuntimeCommand.DescribeObject, {
			sessionId: handle.sessionId,
			sessionGeneration: handle.sessionGeneration,
			object,
		});
		if (!result.ok) {
			throw result.error;
		}
		return result.result;
	}

	/**
	 * Records the generation a call answered from. A session is only valid while the generation it
	 * was opened on is still the current one, so this runs before the handle is stored.
	 */
	private noteRuntimeGeneration(generation: number): void {
		// A zero generation means the caller has not read the runtime state yet; the call it is
		// about to make is the first evidence, so it becomes the baseline rather than a restart.
		if (this.currentRuntimeState.generation === 0) {
			this.currentRuntimeState = { generation, status: 'ready' };
			if (this.lastRuntimeGeneration === 0) {
				this.lastRuntimeGeneration = generation;
			}
		}
	}

	/** Refuses a handle from an earlier runtime generation before a request is sent at all. */
	private assertCurrent(handle: INyalaConnectionHandle): void {
		if (this.currentRuntimeState.status !== 'ready' || this.currentRuntimeState.generation !== handle.runtimeGeneration) {
			throw new NyalaRequestError(localize('nyala.connection.staleGeneration', 'The runtime restarted; this connection must be opened again.'));
		}
	}

	private onRuntimeState(state: INyalaRuntimeState): void {
		const previousGeneration = this.lastRuntimeGeneration;
		this.currentRuntimeState = state;
		const unavailable = state.status === 'failed' || state.status === 'stopped';
		const replaced = previousGeneration !== 0 && state.generation !== previousGeneration;
		if (unavailable || replaced) {
			// The process behind every handle is gone, or cannot currently answer. Nothing in
			// flight may commit after this point; a late connect closes the session it opened.
			// Sessions remembered from the previous generation are unreachable for good, so their
			// names are dropped rather than offered to Disconnect as if they could still be closed.
			if (replaced) {
				this.stranded.clear();
			}
			for (const [profileId, connection] of this.states) {
				this.beginAttempt(profileId);
				if (connection.handle || connection.status === 'connected' || connection.status === 'connecting' || connection.status === 'testing') {
					this.catalogs.delete(profileId);
					this.update(profileId, {
						status: 'lost',
						handle: undefined,
						error: { message: unavailable ? localize('nyala.connection.unavailable', 'The runtime is not available. Reconnect to continue.') : localize('nyala.connection.lost', 'The runtime restarted. Reconnect to continue.') },
					});
				}
			}
		}
		this.lastRuntimeGeneration = state.generation;
		this._onDidChangeRuntime.fire(state);
	}

	private async readCatalog(handle: INyalaConnectionHandle): Promise<{ ok: true; catalog: INyalaCatalog } | { ok: false; error: INyalaRuntimeErrorObject }> {
		const listed = await this.bridge.call<INyalaMetadataListObjectsResult>(NyalaRuntimeCommand.ListObjects, {
			sessionId: handle.sessionId,
			sessionGeneration: handle.sessionGeneration,
			limit: 1000,
		});
		if (!listed.ok) {
			return { ok: false, error: listed.error };
		}
		const catalog: { tables: string[]; views: string[]; indexes: string[] } = { tables: [], views: [], indexes: [] };
		for (const object of listed.result.objects) {
			if (object.kind === 'table') {
				catalog.tables.push(object.name);
			} else if (object.kind === 'view') {
				catalog.views.push(object.name);
			} else {
				catalog.indexes.push(object.name);
			}
		}
		return { ok: true, catalog };
	}

	private profileForPath(path: string): INyalaConnectionState | undefined {
		return [...this.states.values()].find(state => state.profile.target.path === path);
	}

	private fail(profileId: string, attempt: number, error: INyalaRuntimeErrorObject): void {
		if (!this.isCurrent(profileId, attempt)) {
			return;
		}
		this.catalogs.delete(profileId);
		this.update(profileId, { status: 'error', handle: undefined, error });
	}

	private async withState(profileId: string, attempt: number, status: NyalaConnectionStatus, body: (profile: INyalaConnectionProfile) => Promise<void>): Promise<void> {
		const state = this.states.get(profileId);
		if (!state || !this.isCurrent(profileId, attempt)) {
			return;
		}
		this.update(profileId, { status, error: undefined });
		try {
			await body(state.profile);
		} catch (error) {
			if (!this.isCurrent(profileId, attempt)) {
				return;
			}
			const detail = errorMessage(error);
			this.logService.warn(`Nyala: ${profileId} failed: ${detail}`);
			const structured = asRuntimeError(error);
			this.update(profileId, { status: 'error', handle: undefined, error: structured ?? { message: detail } });
		}
	}

	/**
	 * Closes a session and says whether the runtime confirmed it is gone. `INVALID_SESSION` and
	 * `RUNTIME_LOST` also mean gone: the runtime that knew it no longer exists.
	 *
	 * A session that could not be closed is still open. It is remembered in `stranded` so the
	 * workbench never reaches the point of having opened a session it cannot name again; a later
	 * close attempt (a retry, a reconnect, a new runtime generation) may retire it.
	 */
	private async closeSession(handle: INyalaConnectionHandle): Promise<boolean> {
		if (this.isGoneGeneration(handle)) {
			// The runtime that issued this session is not running any more, so nothing is open.
			this.stranded.delete(handle.sessionId);
			return true;
		}
		try {
			const closed = await this.bridge.call(NyalaRuntimeCommand.CloseConnection, { sessionId: handle.sessionId, sessionGeneration: handle.sessionGeneration });
			if (closed.ok) {
				this.stranded.delete(handle.sessionId);
				return true;
			}
			if (closed.error.data.kind === 'INVALID_SESSION' || closed.error.data.kind === 'RUNTIME_LOST') {
				this.stranded.delete(handle.sessionId);
				return true;
			}
			this.stranded.set(handle.sessionId, handle);
			this.logService.warn(`Nyala: closing ${handle.sessionId} failed: ${closed.error.data.kind}`);
			return false;
		} catch (error) {
			this.stranded.set(handle.sessionId, handle);
			this.logService.warn(`Nyala: closing ${handle.sessionId} failed: ${errorMessage(error)}`);
			return false;
		}
	}

	/** A session from an older runtime generation cannot be open in this one. */
	private isGoneGeneration(handle: INyalaConnectionHandle): boolean {
		return this.currentRuntimeState.generation !== handle.runtimeGeneration;
	}

	/**
	 * The sessions still open for a profile: the row's own handle plus anything that failed to
	 * close earlier. A profile must not open a second session while any of these is unaccounted for.
	 */
	private openSessionsOf(profileId: string): INyalaConnectionHandle[] {
		const sessions: INyalaConnectionHandle[] = [];
		const row = this.states.get(profileId)?.handle;
		if (row && !this.isGoneGeneration(row)) {
			sessions.push(row);
		}
		for (const handle of this.stranded.values()) {
			if (handle.profileId === profileId && !this.isGoneGeneration(handle) && !sessions.some(session => session.sessionId === handle.sessionId)) {
				sessions.push(handle);
			}
		}
		return sessions;
	}

	/**
	 * Tries to retire every session the workbench knows about for a profile. Returns the ones the
	 * runtime would not close, which stay in `stranded`.
	 */
	private async retireSessions(profileId: string): Promise<INyalaConnectionHandle[]> {
		const remaining: INyalaConnectionHandle[] = [];
		for (const handle of this.openSessionsOf(profileId)) {
			if (!await this.closeSession(handle)) {
				remaining.push(handle);
			}
		}
		return remaining;
	}

	private beginAttempt(profileId: string): number {
		const attempt = (this.attempts.get(profileId) ?? 0) + 1;
		this.attempts.set(profileId, attempt);
		return attempt;
	}

	private isCurrent(profileId: string, attempt: number): boolean {
		return this.attempts.get(profileId) === attempt;
	}

	private sameHandle(profileId: string, handle: INyalaConnectionHandle): boolean {
		const current = this.states.get(profileId)?.handle;
		return !!current && current.sessionId === handle.sessionId && current.sessionGeneration === handle.sessionGeneration && current.runtimeGeneration === handle.runtimeGeneration;
	}

	/** A generation may only be used while the renderer still knows it as the ready one. */
	private acceptGeneration(generation: number): boolean {
		return this.currentRuntimeState.status === 'ready' && this.currentRuntimeState.generation === generation;
	}

	private update(profileId: string, patch: Partial<INyalaConnectionState>): void {
		const current = this.states.get(profileId);
		if (!current) {
			return;
		}
		this.states.set(profileId, { ...current, ...patch });
		this._onDidChangeConnections.fire();
	}
}

//#region Profiles on disk

/**
 * Profiles are plain user data, kept next to the window's other workbench state (`IStorageService`)
 * and never mixed with a session: a session lives in the runtime process and dies with it
 * (`docs/nyala-kickoff/docs/14-storage.md`). No credential is ever stored: SQLite needs none.
 */
export const NYALA_PROFILES_STORAGE_KEY = 'nyala.connections.profiles';

/** The ids this scheme writes. Persisted ids outside it are from the old path-derived scheme. */
export const PROFILE_ID_PATTERN = /^p_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface INyalaStoredProfile {
	readonly profileId: string;
	readonly displayName: string;
	readonly path: string;
	readonly readOnly: boolean;
}

/** Parses whatever the storage service returned; malformed entries are dropped, not trusted. */
export function parseStoredProfiles(raw: string | undefined): INyalaStoredProfile[] {
	if (!raw) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	const profiles: INyalaStoredProfile[] = [];
	for (const entry of parsed) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const { profileId, displayName, path, readOnly } = entry as Record<string, unknown>;
		if (typeof profileId === 'string' && typeof displayName === 'string' && typeof path === 'string' && typeof readOnly === 'boolean') {
			profiles.push({ profileId, displayName, path, readOnly });
		}
	}
	return profiles;
}

/** The `RUNTIME_LOST` a connect reports when the generation that answered stopped being current. */
function runtimeLostWhileConnecting(): INyalaRuntimeErrorObject {
	return {
		code: NYALA_ERROR_KINDS.RUNTIME_LOST.code,
		message: 'The runtime restarted while connecting.',
		data: { kind: NYALA_ERROR_KINDS.RUNTIME_LOST.kind, retryable: NYALA_ERROR_KINDS.RUNTIME_LOST.retryable },
	};
}

/**
 * Whether an error says the session itself no longer exists. Everything else — a protocol
 * mismatch, a timeout, a cancelled request, an IPC failure — leaves the session open.
 */
function isSessionGone(error: INyalaRuntimeErrorObject): boolean {
	return error.data.kind === 'INVALID_SESSION' || error.data.kind === 'RUNTIME_LOST';
}

/** A message safe to show and log when a rejection may be a structured error, an Error or a value. */
function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	const structured = asRuntimeError(error);
	if (structured) {
		return structured.data.safeDetail ?? structured.message;
	}
	if (typeof error === 'object' && error !== null && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
		return (error as { message: string }).message;
	}
	return typeof error === 'string' ? error : localize('nyala.connection.unknownError', 'The connection request failed.');
}
