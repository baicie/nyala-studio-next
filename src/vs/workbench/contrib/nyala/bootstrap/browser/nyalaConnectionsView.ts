/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, $ } from '../../../../../base/browser/dom.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../../browser/parts/views/viewsViewlet.js';
import { WorkbenchAsyncDataTree } from '../../../../../platform/list/browser/listService.js';
import { INyalaConnectionService } from '../../connections/common/nyalaConnectionService.js';
import { INyalaConnectionNode, NyalaConnectionDelegate, NyalaConnectionIdentityProvider, NyalaConnectionNodeKind, NyalaConnectionRenderer, NyalaConnectionsDataSource } from '../../connections/browser/nyalaConnectionsTree.js';

export const NYALA_CONNECTIONS_VIEW_ID = 'nyala.connections';

export class NyalaConnectionsView extends ViewPane {
	static readonly ID = NYALA_CONNECTIONS_VIEW_ID;
	static readonly NAME = localize2('nyala.connections.name', 'Connections');

	private tree: WorkbenchAsyncDataTree<INyalaConnectionService, INyalaConnectionNode> | undefined;
	private readonly dataSource = new NyalaConnectionsDataSource();

	constructor(
		options: IViewletViewOptions,
		@IThemeService themeService: IThemeService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IHoverService hoverService: IHoverService,
		@INyalaConnectionService private readonly connectionService: INyalaConnectionService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const empty = append(container, $('p.nyala-connections-empty'));
		empty.textContent = localize('nyala.connections.empty', 'No connections yet. Run "Nyala: Add SQLite Connection" to open an existing database file.');

		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchAsyncDataTree<INyalaConnectionService, INyalaConnectionNode>,
			'nyalaConnections',
			container,
			new NyalaConnectionDelegate(),
			[new NyalaConnectionRenderer()],
			this.dataSource,
			{
				indent: 8,
				horizontalScrolling: false,
				multipleSelectionSupport: false,
				accessibilityProvider: {
					getAriaLabel: element => element.kind === NyalaConnectionNodeKind.Profile ? localize('nyala.connections.aria.profile', 'Connection {0}', element.label) : element.label,
					getWidgetAriaLabel: () => localize('nyala.connections.aria.widget', 'Nyala connections'),
				},
				identityProvider: new NyalaConnectionIdentityProvider(),
				openOnSingleClick: true,
			},
		));
		void this.tree.setInput(this.connectionService);
		this.dataSource.attach(this.connectionService);
		this.dataSource.setOnDidChange(() => this.tree?.rerender());
		this._register(this.connectionService.onDidChangeConnections(() => {
			this.dataSource.invalidate();
			void this.refreshTree();
			this.updateEmptyState(empty);
		}));
		this._register(this.connectionService.onDidChangeRuntime(() => {
			this.dataSource.invalidate();
			void this.refreshTree();
		}));
		this._register(this.tree.onDidOpen(event => {
			void this.onDidOpen(event.element);
		}));

		// The first paint asks the main process where its runtime is, so a failed or restarted
		// runtime is visible without the user touching anything.
		void this.connectionService.refreshRuntime();
		this.updateEmptyState(empty);
	}

	/**
	 * A profile row connects when it has no session, and disconnects when it has one; expanding a
	 * profile or table is left to the tree, which uses the same commands through the service.
	 */
	private async onDidOpen(element: INyalaConnectionNode | undefined): Promise<void> {
		if (!element || element.kind !== NyalaConnectionNodeKind.Profile || !element.profileId) {
			return;
		}
		const state = this.connectionService.connections.find(candidate => candidate.profile.profileId === element.profileId);
		if (!state) {
			return;
		}
		if (state.status === 'connected') {
			await this.connectionService.disconnect(element.profileId);
		} else if (state.status !== 'connecting' && state.status !== 'testing') {
			await this.connectionService.connect(element.profileId);
		}
	}

	/** Re-reads the rows; the input object keeps its identity, so this is a model refresh. */
	private async refreshTree(): Promise<void> {
		await this.tree?.updateChildren();
	}

	private updateEmptyState(empty: HTMLElement): void {
		empty.style.display = this.connectionService.connections.length === 0 ? '' : 'none';
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.tree?.layout(height, width);
	}

	override dispose(): void {
		this.tree = undefined;
		super.dispose();
	}
}
