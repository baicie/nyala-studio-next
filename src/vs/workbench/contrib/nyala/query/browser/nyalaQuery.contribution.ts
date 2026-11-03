/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Registration of the N-202 query editor: the pane, the serializer that restores a query tab
// after a window reload, the resolver that opens `nyala-query:` URIs in it, the context service
// and the two commands a user needs to reach the tab. Everything here uses the workbench's own
// registries; there is no second tab system and no replacement for `IEditorService`.
//
// A restored tab comes back with its query id only — no text and no session. A reload always
// lands on an empty, unbound tab: the binding is an explicit user action (`Nyala: Change Query
// Connection`), and the SQL body is never written to the layout (ADR 0007, section 6).

import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../services/editor/common/editorResolverService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Action2, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { localize, localize2 } from '../../../../../nls.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { INyalaConnectionService } from '../../connections/common/nyalaConnectionService.js';
import { INyalaQueryContextService } from '../common/nyalaQueryContext.js';
import { NyalaQueryContextService } from '../common/nyalaQueryContextService.js';
import { INyalaQueryDocumentService, NyalaQueryDocumentService } from '../common/nyalaQueryDocumentService.js';
import { NyalaQueryEditorInput } from '../common/nyalaQueryEditorInput.js';
import { NYALA_QUERY_SCHEME, nyalaQueryResource, queryIdOf } from '../common/nyalaQueryResource.js';
import { NyalaQueryEditorPane } from './nyalaQueryEditorPane.js';

export const NYALA_NEW_QUERY_COMMAND_ID = 'nyala.query.new';
export const NYALA_CHANGE_CONNECTION_COMMAND_ID = 'nyala.query.changeConnection';

registerSingleton(INyalaQueryContextService, NyalaQueryContextService, InstantiationType.Delayed);
registerSingleton(INyalaQueryDocumentService, NyalaQueryDocumentService, InstantiationType.Delayed);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		NyalaQueryEditorPane,
		NyalaQueryEditorPane.ID,
		localize('nyala.query.editorLabel', "SQL Query")
	),
	[new SyncDescriptor(NyalaQueryEditorInput)]
);

/**
 * Restores a query tab after a reload. The serialized form holds the query id only: sessions,
 * paths and credentials cannot enter it by construction, and N-202 deliberately does not write the
 * SQL body into the layout either. Query text that may carry sensitive literals is persisted only
 * by N-206's own, opt-in store. A restored tab therefore comes back empty and unbound.
 */
export class NyalaQueryEditorSerializer implements IEditorSerializer {

	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof NyalaQueryEditorInput;
	}

	serialize(editorInput: EditorInput): string | undefined {
		if (!(editorInput instanceof NyalaQueryEditorInput)) {
			return undefined;
		}
		return JSON.stringify({ queryId: editorInput.queryId });
	}

	deserialize(instantiationService: IInstantiationService, serializedEditor: string): EditorInput | undefined {
		try {
			const data = JSON.parse(serializedEditor) as { queryId?: unknown };
			const queryId = typeof data.queryId === 'string' ? data.queryId : undefined;
			if (!queryId || !/^[A-Za-z0-9_-]+$/.test(queryId)) {
				return undefined;
			}
			return instantiationService.createInstance(NyalaQueryEditorInput, queryId);
		} catch {
			return undefined;
		}
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	NyalaQueryEditorInput.ID,
	NyalaQueryEditorSerializer
);

class NyalaQueryEditorResolverContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.nyalaQueryEditorResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		editorResolverService.registerEditor(
			`${NYALA_QUERY_SCHEME}://local/**`,
			{
				id: NyalaQueryEditorInput.ID,
				label: localize('nyala.query.editorLabel', "SQL Query"),
				priority: RegisteredEditorPriority.exclusive,
			},
			{
				singlePerResource: false,
				canSupportResource: resource => resource.scheme === NYALA_QUERY_SCHEME,
			},
			{
				createEditorInput: ({ resource, options }) => {
					const queryId = queryIdOf(resource);
					if (!queryId) {
						throw new Error('A Nyala query URI must carry a query id.');
					}
					return {
						editor: this.instantiationService.createInstance(NyalaQueryEditorInput, queryId),
						options,
					};
				},
			}
		);
	}
}

/** Opens a new, empty query tab. Takes no connection: binding is an explicit user action. */
registerAction2(class extends Action2 {

	constructor() {
		super({
			id: NYALA_NEW_QUERY_COMMAND_ID,
			title: localize2('nyala.query.new', 'Nyala: New Query'),
			f1: true,
			category: localize2('nyala.category', 'Nyala'),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorService).openEditor({ resource: nyalaQueryResource(generateUuid()) });
	}
});

/**
 * Binds the active query tab to a connection the user picks. This is the only way a tab acquires
 * an execution target, and it acts on the active tab alone.
 */
registerAction2(class extends Action2 {

	constructor() {
		super({
			id: NYALA_CHANGE_CONNECTION_COMMAND_ID,
			title: localize2('nyala.query.changeConnection', 'Nyala: Change Query Connection'),
			f1: true,
			category: localize2('nyala.category', 'Nyala'),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const connectionService = accessor.get(INyalaConnectionService);
		const contextService = accessor.get(INyalaQueryContextService);
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);
		const logService = accessor.get(ILogService);

		const input = editorService.activeEditor;
		if (!(input instanceof NyalaQueryEditorInput)) {
			notifications.info(localize('nyala.query.notActive', 'Open a Nyala query tab first.'));
			return;
		}

		const profiles = connectionService.connections;
		if (profiles.length === 0) {
			notifications.info(localize('nyala.query.noProfiles', 'Add a SQLite connection first.'));
			return;
		}

		type ProfilePick = IQuickPickItem & { readonly profileId: string };
		const picks: ProfilePick[] = profiles.map(state => ({
			label: state.profile.displayName,
			description: state.profile.target.path,
			profileId: state.profile.profileId,
		}));
		const picked = await quickInput.pick(picks, {
			title: localize('nyala.query.pick.title', 'Connect this query to'),
			placeHolder: localize('nyala.query.pick.placeholder', 'Choose a connection for the active query tab'),
		});
		if (!picked) {
			return;
		}

		const context = input.getContext();
		const result = await contextService.bind(context, picked.profileId);
		if (!result.ok) {
			logService.warn(`Nyala: binding ${input.queryId} failed: ${result.message}`);
			notifications.warn(result.message);
		}
	}
});

// Reachable from the palette and from the tab's title menu; the menu entry appears only while a
// Nyala query tab is active, so it cannot act on some other editor by accident.
MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: {
		id: NYALA_CHANGE_CONNECTION_COMMAND_ID,
		title: localize2('nyala.query.changeConnection.short', 'Change Connection'),
	},
	when: ContextKeyExpr.equals('resourceScheme', NYALA_QUERY_SCHEME),
	group: 'navigation',
	order: 10,
});

registerWorkbenchContribution2(NyalaQueryEditorResolverContribution.ID, NyalaQueryEditorResolverContribution, WorkbenchPhase.BlockStartup);
