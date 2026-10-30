/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
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

export const NYALA_HELLO_COMMAND_ID = 'nyala.hello';
export const NYALA_FOCUS_CONNECTIONS_COMMAND_ID = 'nyala.focusConnections';

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
