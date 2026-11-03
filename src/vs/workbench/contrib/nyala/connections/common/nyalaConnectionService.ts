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
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { INyalaMetadataDescribeResult, INyalaMetadataListObjectsResult } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeContract.generated.js';
import { INyalaRuntimeCallResult, INyalaRuntimeState, NyalaRuntimeCommand } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeIpc.js';
import { INyalaRuntimeErrorObject } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeProtocol.js';
import { INyalaConnectionTarget, NyalaRequestError } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeRequest.js';

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
	/** Adds a profile and remembers it for the next window, unless it is already known. */
	addProfile(profile: INyalaConnectionProfile): Promise<void>;
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
	private nextProfile = 1;
	private lastRuntimeGeneration = 0;

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

	async addProfile(profile: Omit<INyalaConnectionProfile, 'profileId'> & { readonly profileId?: string }): Promise<void> {
		const profileId = profile.profileId ?? `p_${this.nextProfile++}`;
		if (this.states.has(profileId)) {
			return;
		}
		this.states.set(profileId, { profile: { ...profile, profileId }, status: 'disconnected' });
		this.saveProfiles();
		this._onDidChangeConnections.fire();
	}

	async restoreProfiles(): Promise<void> {
		const stored = parseStoredProfiles(this.storageService?.get(NYALA_PROFILES_STORAGE_KEY, StorageScope.PROFILE, ''));
		for (const profile of stored) {
			if (this.states.has(profile.profileId)) {
				continue;
			}
			this.states.set(profile.profileId, {
				profile: {
					profileId: profile.profileId,
					displayName: profile.displayName,
					target: { driver: 'sqlite', path: profile.path, readOnly: profile.readOnly },
				},
				status: 'disconnected',
			});
			const number = Number(/^p_(\d+)$/.exec(profile.profileId)?.[1]);
			if (Number.isSafeInteger(number) && number >= this.nextProfile) {
				this.nextProfile = number + 1;
			}
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
		await this.withState(profileId, 'connecting', async profile => {
			const tested = await this.bridge.call(NyalaRuntimeCommand.TestConnection, profile.target);
			if (!tested.ok) {
				this.fail(profileId, tested.error);
				return;
			}
			// The generation that answered is the one this session will belong to.
			this.noteRuntimeGeneration(tested.runtimeGeneration);
			const opened = await this.bridge.call<{ sessionId: string; sessionGeneration: number }>(NyalaRuntimeCommand.OpenConnection, profile.target);
			if (!opened.ok) {
				this.fail(profileId, opened.error);
				return;
			}
			this.noteRuntimeGeneration(opened.runtimeGeneration);
			this.update(profileId, {
				status: 'connected',
				handle: {
					profileId,
					sessionId: opened.result.sessionId,
					sessionGeneration: opened.result.sessionGeneration,
					runtimeGeneration: opened.runtimeGeneration,
				},
			});
			await this.loadCatalog(profileId);
		});
	}

	async disconnect(profileId: string): Promise<void> {
		const state = this.states.get(profileId);
		if (!state?.handle) {
			this.catalogs.delete(profileId);
			this.update(profileId, { status: 'disconnected', handle: undefined, error: undefined });
			return;
		}
		const handle = state.handle;
		// Closing is idempotent on the runtime; a session from a dead generation is already gone.
		const closed = await this.bridge.call(NyalaRuntimeCommand.CloseConnection, { sessionId: handle.sessionId, sessionGeneration: handle.sessionGeneration });
		if (!closed.ok && closed.error.data.kind !== 'INVALID_SESSION' && closed.error.data.kind !== 'RUNTIME_LOST') {
			this.logService.warn(`Nyala: closing ${handle.sessionId} failed: ${closed.error.data.kind}`);
		}
		this.catalogs.delete(profileId);
		this.update(profileId, { status: 'disconnected', handle: undefined, error: undefined });
	}

	async refresh(profileId: string): Promise<void> {
		const state = this.states.get(profileId);
		if (state?.status !== 'connected' || !state.handle) {
			return;
		}
		await this.loadCatalog(profileId);
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
		if (this.currentRuntimeState.generation !== handle.runtimeGeneration) {
			throw new NyalaRequestError(localize('nyala.connection.staleGeneration', 'The runtime restarted; this connection must be opened again.'));
		}
	}

	private onRuntimeState(state: INyalaRuntimeState): void {
		this.currentRuntimeState = state;
		if (this.lastRuntimeGeneration !== 0 && state.generation !== this.lastRuntimeGeneration) {
			// The process behind every handle of the previous generation is gone.
			for (const [profileId, connection] of this.states) {
				if (connection.handle) {
					this.catalogs.delete(profileId);
					this.update(profileId, { status: 'lost', handle: undefined, error: { message: localize('nyala.connection.lost', 'The runtime restarted. Reconnect to continue.') } });
				}
			}
		}
		this.lastRuntimeGeneration = state.generation;
		this._onDidChangeRuntime.fire(state);
	}

	private async loadCatalog(profileId: string): Promise<void> {
		const state = this.states.get(profileId);
		if (!state?.handle) {
			return;
		}
		const listed = await this.bridge.call<INyalaMetadataListObjectsResult>(NyalaRuntimeCommand.ListObjects, {
			sessionId: state.handle.sessionId,
			sessionGeneration: state.handle.sessionGeneration,
			limit: 1000,
		});
		if (!listed.ok) {
			this.fail(profileId, listed.error);
			return;
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
		this.catalogs.set(profileId, catalog);
		this._onDidChangeConnections.fire();
	}

	private fail(profileId: string, error: INyalaRuntimeErrorObject): void {
		this.catalogs.delete(profileId);
		this.update(profileId, { status: 'error', handle: undefined, error });
	}

	private async withState(profileId: string, status: NyalaConnectionStatus, body: (profile: INyalaConnectionProfile) => Promise<void>): Promise<void> {
		const state = this.states.get(profileId);
		if (!state) {
			return;
		}
		this.update(profileId, { status, error: undefined });
		try {
			await body(state.profile);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logService.warn(`Nyala: ${profileId} failed: ${message}`);
			this.update(profileId, { status: 'error', handle: undefined, error: { message } });
		}
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
