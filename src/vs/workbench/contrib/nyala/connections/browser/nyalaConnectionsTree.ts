/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The tree model of the Connections view (N-201). Rows are derived from the service's connection
// states on every request, so a refresh is a tree update: a profile, its Tables / Views / Indexes
// groups, and the columns of one table or view, which are loaded through the typed bridge only
// when the user expands the object. Nothing here reads a database.

import { IAsyncDataSource, ITreeRenderer, ITreeNode } from '../../../../../base/browser/ui/tree/tree.js';
import { IIdentityProvider, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { IconLabel } from '../../../../../base/browser/ui/iconLabel/iconLabel.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { INyalaConnectionHandle, INyalaConnectionService, INyalaConnectionState } from '../common/nyalaConnectionService.js';

export const enum NyalaConnectionNodeKind {
	Profile,
	Status,
	Group,
	Object,
	Column,
}

export type NyalaConnectionGroup = 'tables' | 'views' | 'indexes';

export interface INyalaConnectionNode {
	readonly kind: NyalaConnectionNodeKind;
	/** Row identity, stable across refreshes of the same profile. */
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly profileId?: string;
	readonly group?: NyalaConnectionGroup;
	readonly objectName?: string;
	readonly icon?: ThemeIcon;
}

const GROUPS: readonly { readonly group: NyalaConnectionGroup; readonly label: () => string; readonly icon: ThemeIcon }[] = [
	{ group: 'tables', label: () => localize('nyala.connections.tables', 'Tables'), icon: Codicon.table },
	{ group: 'views', label: () => localize('nyala.connections.views', 'Views'), icon: Codicon.eye },
	{ group: 'indexes', label: () => localize('nyala.connections.indexes', 'Indexes'), icon: Codicon.listSelection },
];

/** The one row a profile has while it is not connected: what happened and what to do next. */
function statusRow(state: INyalaConnectionState): INyalaConnectionNode {
	const id = `${state.profile.profileId}:status`;
	const detail = state.error ? ('data' in state.error ? state.error.data.safeDetail ?? state.error.message : state.error.message) : '';
	switch (state.status) {
		case 'testing':
			return { kind: NyalaConnectionNodeKind.Status, id, label: localize('nyala.connections.testing', 'Testing connection...'), description: state.profile.target.path, profileId: state.profile.profileId, icon: Codicon.loading };
		case 'connecting':
			return { kind: NyalaConnectionNodeKind.Status, id, label: localize('nyala.connections.connecting', 'Connecting...'), description: state.profile.target.path, profileId: state.profile.profileId, icon: Codicon.loading };
		case 'lost':
			return { kind: NyalaConnectionNodeKind.Status, id, label: localize('nyala.connections.lost', 'Connection lost'), description: detail || localize('nyala.connections.lost.hint', 'The runtime restarted; connect again.'), profileId: state.profile.profileId, icon: Codicon.warning };
		case 'error':
			return { kind: NyalaConnectionNodeKind.Status, id, label: localize('nyala.connections.failed', 'Connection failed'), description: detail, profileId: state.profile.profileId, icon: Codicon.error };
		default:
			return { kind: NyalaConnectionNodeKind.Status, id, label: localize('nyala.connections.disconnected', 'Not connected'), description: state.profile.target.path, profileId: state.profile.profileId, icon: Codicon.plug };
	}
}

/** Column rows of one object, from `metadata.describe`. */
export function columnRows(profileId: string, objectRowId: string, columns: readonly { readonly ordinal: number; readonly name: string; readonly nativeType: string; readonly nullable: boolean; readonly primaryKey?: boolean }[]): INyalaConnectionNode[] {
	return columns.map(column => ({
		kind: NyalaConnectionNodeKind.Column,
		id: `${objectRowId}:${column.ordinal}`,
		label: column.name,
		description: column.primaryKey
			? localize('nyala.connections.primaryKey', '{0}, primary key', column.nativeType)
			: column.nullable ? column.nativeType : localize('nyala.connections.notNull', '{0}, not null', column.nativeType),
		profileId,
		icon: column.primaryKey ? Codicon.key : Codicon.symbolField,
	}));
}

/** The handle a profile currently holds, if it is still connected. */
export function handleOf(service: INyalaConnectionService, profileId: string | undefined): INyalaConnectionHandle | undefined {
	return profileId === undefined ? undefined : service.connections.find(state => state.profile.profileId === profileId)?.handle;
}

/**
 * The tree's rows. Expanding a table asks the service for its columns, which validates the
 * session identity against the current runtime generation before anything is sent
 * (`nyalaConnectionService.ts`). A load failure becomes a visible row instead of a broken twistie.
 */
export class NyalaConnectionsDataSource implements IAsyncDataSource<INyalaConnectionService, INyalaConnectionNode> {

	/** Columns already loaded, by object row id. */
	private readonly columns = new Map<string, readonly INyalaConnectionNode[]>();
	private readonly failures = new Map<string, string>();
	private onChange: () => void = () => { };

	/** Called once after an asynchronous load settled, so the view can re-render. */
	setOnDidChange(onChange: () => void): void {
		this.onChange = onChange;
	}

	invalidate(): void {
		this.columns.clear();
		this.failures.clear();
	}

	hasChildren(element: INyalaConnectionService | INyalaConnectionNode): boolean {
		if (!isNode(element)) {
			return true;
		}
		switch (element.kind) {
			case NyalaConnectionNodeKind.Profile:
			case NyalaConnectionNodeKind.Group:
				return true;
			case NyalaConnectionNodeKind.Object:
				return element.group !== 'indexes';
			default:
				return false;
		}
	}

	async getChildren(element: INyalaConnectionService | INyalaConnectionNode): Promise<INyalaConnectionNode[]> {
		if (!isNode(element)) {
			return element.connections.map(state => ({
				kind: NyalaConnectionNodeKind.Profile,
				id: state.profile.profileId,
				label: state.profile.displayName || state.profile.target.path.split(/[\\/]/).pop() || state.profile.target.path,
				description: state.profile.target.path,
				profileId: state.profile.profileId,
				icon: Codicon.database,
			}));
		}
		switch (element.kind) {
			case NyalaConnectionNodeKind.Profile: {
				const state = this.stateOf(element);
				if (!state || state.status !== 'connected' || !state.handle) {
					return [statusRow(state ?? detachedState(element))];
				}
				return GROUPS.map(({ group, label, icon }) => ({
					kind: NyalaConnectionNodeKind.Group,
					id: `${element.id}:${group}`,
					label: label(),
					profileId: element.profileId,
					group,
					icon,
				}));
			}
			case NyalaConnectionNodeKind.Group: {
				const names = this.service?.catalog(element.profileId ?? '')?.[element.group ?? 'tables'] ?? [];
				return names.map(name => ({
					kind: NyalaConnectionNodeKind.Object,
					id: `${element.id}:${name}`,
					label: name,
					profileId: element.profileId,
					group: element.group,
					objectName: name,
					icon: element.group === 'indexes' ? Codicon.listSelection : Codicon.symbolField,
				}));
			}
			case NyalaConnectionNodeKind.Object:
				return this.columnsOf(element);
			default:
				return [];
		}
	}

	private async columnsOf(element: INyalaConnectionNode): Promise<INyalaConnectionNode[]> {
		const loaded = this.columns.get(element.id);
		if (loaded) {
			return [...loaded];
		}
		const failure = this.failures.get(element.id);
		if (failure) {
			return [this.errorRow(element, failure)];
		}
		if (!this.service) {
			return [];
		}
		const handle = handleOf(this.service, element.profileId);
		if (!handle || !element.objectName) {
			return [];
		}
		try {
			const described = await this.service.describe(handle, { name: element.objectName });
			const rows = columnRows(element.profileId ?? '', element.id, described.columns);
			this.columns.set(element.id, rows);
			this.onChange();
			return [...rows];
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.failures.set(element.id, detail);
			this.onChange();
			return [this.errorRow(element, detail)];
		}
	}

	private errorRow(element: INyalaConnectionNode, detail: string): INyalaConnectionNode {
		return { kind: NyalaConnectionNodeKind.Status, id: `${element.id}:error`, label: localize('nyala.connections.columnsFailed', 'Could not load columns'), description: detail, profileId: element.profileId, icon: Codicon.error };
	}

	/** The service is the tree's input; every row resolves its profile through it. */
	private service!: INyalaConnectionService;

	/** Binds the live service before the tree asks for its first row. */
	attach(service: INyalaConnectionService): void {
		this.service = service;
	}

	private stateOf(element: INyalaConnectionNode): INyalaConnectionState | undefined {
		return this.service?.connections.find(state => state.profile.profileId === element.profileId);
	}
}

/** A profile the service no longer lists still renders as detached rather than vanishing. */
function detachedState(element: INyalaConnectionNode): INyalaConnectionState {
	return {
		profile: { profileId: element.profileId ?? '', displayName: element.label, target: { driver: 'sqlite', path: element.description ?? '', readOnly: true } },
		status: 'disconnected',
	};
}

function isNode(value: INyalaConnectionService | INyalaConnectionNode): value is INyalaConnectionNode {
	return typeof (value as INyalaConnectionNode).kind === 'number';
}

export class NyalaConnectionDelegate implements IListVirtualDelegate<INyalaConnectionNode> {
	getHeight(): number {
		return 22;
	}
	getTemplateId(): string {
		return NyalaConnectionRenderer.TEMPLATE_ID;
	}
}

interface INyalaConnectionTemplate {
	readonly label: IconLabel;
}

export class NyalaConnectionRenderer implements ITreeRenderer<INyalaConnectionNode, void, INyalaConnectionTemplate> {

	static readonly TEMPLATE_ID = 'nyala.connection.renderer';

	readonly templateId = NyalaConnectionRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): INyalaConnectionTemplate {
		return { label: new IconLabel(container, { supportHighlights: true, supportIcons: true }) };
	}

	renderElement(node: ITreeNode<INyalaConnectionNode, void>, _index: number, template: INyalaConnectionTemplate): void {
		template.label.setLabel(node.element.label, node.element.description, { iconPath: node.element.icon, supportIcons: true });
	}

	disposeTemplate(template: INyalaConnectionTemplate): void {
		template.label.dispose();
	}
}

export class NyalaConnectionIdentityProvider implements IIdentityProvider<INyalaConnectionNode> {
	getId(element: INyalaConnectionNode): string {
		return element.id;
	}
}
