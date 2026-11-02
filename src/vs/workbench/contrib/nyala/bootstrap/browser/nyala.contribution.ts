/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { URI } from '../../../../../base/common/uri.js';
import { basename } from '../../../../../base/common/path.js';
import { INyalaConnectionService } from '../../connections/common/nyalaConnectionService.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../../common/views.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import { NYALA_CONNECTIONS_VIEW_ID, NyalaConnectionsView } from './nyalaConnectionsView.js';
import './../../connections/browser/nyalaConnectionService.contribution.js';

export const NYALA_HELLO_COMMAND_ID = 'nyala.hello';
export const NYALA_FOCUS_CONNECTIONS_COMMAND_ID = 'nyala.focusConnections';
export const NYALA_ADD_SQLITE_CONNECTION_COMMAND_ID = 'nyala.connection.add';
export const NYALA_CONNECT_COMMAND_ID = 'nyala.connection.connect';
export const NYALA_DISCONNECT_COMMAND_ID = 'nyala.connection.disconnect';
export const NYALA_REFRESH_CONNECTIONS_COMMAND_ID = 'nyala.connection.refresh';

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: NYALA_HELLO_COMMAND_ID,
			title: localize2('nyala.hello', 'Nyala: Hello Workbench'),
			f1: true
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(INotificationService).info(localize('nyala.hello.notification', 'Nyala Studio Workbench is ready.'));
	}
});

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: NYALA_ADD_SQLITE_CONNECTION_COMMAND_ID,
			title: localize2('nyala.connection.add', 'Nyala: Add SQLite Connection'),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const dialogService = accessor.get(IFileDialogService);
		const connectionService = accessor.get(INyalaConnectionService);
		const notificationService = accessor.get(INotificationService);
		const picks = await dialogService.showOpenDialog({
			title: localize('nyala.connection.add.title', 'Open a SQLite Database'),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			openLabel: localize('nyala.connection.add.open', 'Connect'),
		});
		const file = picks?.[0];
		if (!file) {
			return;
		}
		await addProfileForUri(connectionService, notificationService, file);
	}
});

/** The command body, separated so the browser test can drive it without a real file dialog. */
export async function addProfileForUri(connectionService: INyalaConnectionService, notificationService: INotificationService, file: URI): Promise<void> {
	if (file.scheme !== 'file') {
		notificationService.warn(localize('nyala.connection.add.localOnly', 'Nyala can only open local database files.'));
		return;
	}
	const path = file.fsPath;
	const profileId = `p_${path.replace(/[^A-Za-z0-9]/g, '_')}`;
	await connectionService.addProfile({
		profileId,
		displayName: basename(path),
		target: { driver: 'sqlite', path, readOnly: true },
	});
	await connectionService.connect(profileId);
}

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: NYALA_CONNECT_COMMAND_ID,
			title: localize2('nyala.connection.connect', 'Nyala: Connect'),
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor, profileId?: string): Promise<void> {
		if (profileId) {
			await accessor.get(INyalaConnectionService).connect(profileId);
		}
	}
});

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: NYALA_DISCONNECT_COMMAND_ID,
			title: localize2('nyala.connection.disconnect', 'Nyala: Disconnect'),
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor, profileId?: string): Promise<void> {
		if (profileId) {
			await accessor.get(INyalaConnectionService).disconnect(profileId);
		}
	}
});

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: NYALA_REFRESH_CONNECTIONS_COMMAND_ID,
			title: localize2('nyala.connection.refresh', 'Nyala: Refresh Connections'),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(INyalaConnectionService);
		for (const state of service.connections) {
			await service.refresh(state.profile.profileId);
		}
	}
});

const nyalaConnectionsIcon = registerIcon('nyala-connections-view-icon', Codicon.database, localize('nyala.connections.icon', 'Nyala connections view icon.'));
const nyalaConnectionsContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: 'nyala.connections.container',
	title: localize2('nyala.connections.container', 'Nyala Connections'),
	icon: nyalaConnectionsIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, ['nyala.connections.container', { mergeViewWithContainerWhenSingleView: true }]),
	storageId: 'nyala.connections.container',
	order: 5
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: NYALA_CONNECTIONS_VIEW_ID,
	name: NyalaConnectionsView.NAME,
	containerIcon: nyalaConnectionsIcon,
	ctorDescriptor: new SyncDescriptor(NyalaConnectionsView),
	canToggleVisibility: true,
	canMoveView: true,
	openCommandActionDescriptor: {
		id: NYALA_FOCUS_CONNECTIONS_COMMAND_ID,
		title: localize2('nyala.focusConnections', 'Nyala: Focus Connections')
	}
}], nyalaConnectionsContainer);

export class NyalaStatusContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.nyalaStatus';

	private readonly statusBarEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
	) {
		super();
		this.statusBarEntry.value = this.statusbarService.addEntry(this.getStatusBarEntry(), NyalaStatusContribution.ID, StatusbarAlignment.LEFT, -Number.MAX_VALUE);
	}

	private getStatusBarEntry(): IStatusbarEntry {
		return {
			name: localize('nyala.status.name', 'Nyala Studio'),
			text: localize('nyala.status.text', 'Nyala'),
			ariaLabel: localize('nyala.status.ariaLabel', 'Nyala Studio'),
			tooltip: localize('nyala.status.tooltip', 'Run Nyala: Hello Workbench'),
			command: {
				id: NYALA_HELLO_COMMAND_ID,
				title: localize('nyala.status.command', 'Nyala: Hello Workbench')
			}
		};
	}
}

registerWorkbenchContribution2(NyalaStatusContribution.ID, NyalaStatusContribution, WorkbenchPhase.AfterRestored);
