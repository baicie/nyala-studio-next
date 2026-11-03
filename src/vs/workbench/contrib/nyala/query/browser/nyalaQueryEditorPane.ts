/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The pane of a Nyala query tab (N-202). It is a plain Monaco text editor over the query input's
// model, plus a small status line that says which connection this tab is bound to. It owns no
// connection state: the target comes from the input's `NyalaQueryContext`, and when that context
// loses its binding the status line says so and offers the explicit "change connection" action.
// The pane never picks a connection itself and never reads a global "active connection".
//
// There is no file behind a query tab in N-202: `save`/`saveAs` fail deliberately and the layout
// stores only the query id, so nothing here writes SQL to disk. Draft persistence is N-206.

import './media/nyalaQueryEditor.css';
import { Dimension } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICodeEditorViewState } from '../../../../../editor/common/editorCommon.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { ITextResourceConfigurationService } from '../../../../../editor/common/services/textResourceConfiguration.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IEditorGroupsService, IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITextEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { AbstractTextCodeEditor } from '../../../../browser/parts/editor/textCodeEditor.js';
import { NyalaQueryEditorInput } from '../common/nyalaQueryEditorInput.js';
import { INyalaQueryBinding, INyalaQueryContextService, NyalaQueryContext } from '../common/nyalaQueryContext.js';

export class NyalaQueryEditorPane extends AbstractTextCodeEditor<ICodeEditorViewState> {

	static readonly ID = NyalaQueryEditorInput.ID;

	private statusContainer: HTMLElement | undefined;
	private statusLabel: HTMLElement | undefined;
	private statusDetail: HTMLElement | undefined;
	private contextListener: { dispose(): void } | undefined;
	private currentContext: NyalaQueryContext | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@ITextResourceConfigurationService textResourceConfigurationService: ITextResourceConfigurationService,
		@IThemeService themeService: IThemeService,
		@IEditorService editorService: IEditorService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@IFileService fileService: IFileService,
		@INyalaQueryContextService private readonly contextService: INyalaQueryContextService,
	) {
		super(NyalaQueryEditorPane.ID, group, telemetryService, instantiationService, storageService, textResourceConfigurationService, themeService, editorService, editorGroupService, fileService);
	}

	override get input(): NyalaQueryEditorInput | undefined {
		return this._input as NyalaQueryEditorInput | undefined;
	}

	protected override createEditor(parent: HTMLElement): void {
		super.createEditor(parent);

		this.statusContainer = document.createElement('div');
		this.statusContainer.className = 'nyala-query-status';
		this.statusLabel = document.createElement('span');
		this.statusLabel.className = 'nyala-query-status-label';
		this.statusDetail = document.createElement('span');
		this.statusDetail.className = 'nyala-query-status-detail';
		this.statusContainer.appendChild(this.statusLabel);
		this.statusContainer.appendChild(this.statusDetail);
		parent.appendChild(this.statusContainer);
	}

	override async setInput(input: EditorInput, options: ITextEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		// The previous input's listener belongs to its own query; it must not survive the switch.
		this.stopWatching();
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested || !(input instanceof NyalaQueryEditorInput)) {
			return;
		}
		const control = this.editorControl;
		if (!control) {
			return;
		}
		const model = input.getModel();
		if (control.getModel() !== model) {
			control.setModel(model);
		}
		const viewState = (options?.viewState as ICodeEditorViewState | undefined) ?? this.loadEditorViewState(input, context);
		if (viewState) {
			control.restoreViewState(viewState);
		}
		this.watchContext(input);
	}

	override setOptions(options: ITextEditorOptions | undefined): void {
		super.setOptions(options);
	}

	override clearInput(): void {
		this.stopWatching();
		super.clearInput();
		this.editorControl?.setModel(null);
	}

	override dispose(): void {
		this.stopWatching();
		super.dispose();
	}

	override focus(): void {
		super.focus();
		this.editorControl?.focus();
	}

	override layout(dimension: Dimension): void {
		const statusHeight = this.statusContainer?.offsetHeight ?? 0;
		this.editorControl?.layout({ width: dimension.width, height: Math.max(0, dimension.height - statusHeight) });
	}

	/** The tab's text. Later query execution reads the model through this, not a second copy. */
	getText(): string {
		return this.editorControl?.getModel()?.getValue() ?? '';
	}

	/** The current selection, or an empty string when nothing is selected. */
	getSelectionText(): string {
		const control = this.editorControl;
		const model = control?.getModel();
		const selection = control?.getSelection();
		if (!control || !model || !selection || selection.isEmpty()) {
			return '';
		}
		return model.getValueInRange(selection);
	}

	/** The cursor offset in the model, used to find the statement under it. */
	getCursorOffset(): number {
		const control = this.editorControl;
		const model = control?.getModel();
		const position = control?.getPosition();
		return model && position ? model.getOffsetAt(position) : 0;
	}

	/**
	 * The session this tab may execute against, or `undefined` when it has none. The runtime state
	 * is consulted on every call, so a stale tab cannot execute after a restart even if its
	 * binding has not been reconciled yet.
	 */
	getExecutionBinding(): INyalaQueryBinding | undefined {
		const context = this.currentContext;
		if (!context || !context.canExecute(this.contextService.runtimeState)) {
			return undefined;
		}
		return context.binding;
	}

	/** The tab's context, for a future execute command; `undefined` before the first `setInput`. */
	getContext(): NyalaQueryContext | undefined {
		return this.currentContext;
	}

	private watchContext(input: NyalaQueryEditorInput): void {
		this.stopWatching();
		// The context belongs to the input's shared document; the pane only observes it and must
		// not create, release or rebind it.
		const context = input.getContext();
		this.currentContext = context;
		this.contextListener = context.onDidChangeBinding(() => this.updateStatus());
		this.updateStatus();
	}

	private stopWatching(): void {
		this.contextListener?.dispose();
		this.contextListener = undefined;
		this.currentContext = undefined;
	}

	private updateStatus(): void {
		if (!this.statusLabel || !this.statusDetail || !this.statusContainer) {
			return;
		}
		const context = this.currentContext;
		if (context?.bindingState === 'switching') {
			// The old target is already gone, so the tab must not claim it is still bound.
			this.statusLabel.textContent = localize('nyala.query.status.switching', 'Connecting…');
			this.statusLabel.classList.add('nyala-query-status-unbound');
			this.statusDetail.textContent = context.switchingTo
				? localize('nyala.query.status.switchingTo', 'Switching to {0}', context.switchingTo)
				: '';
			this.statusContainer.setAttribute('data-state', 'switching');
			return;
		}
		if (!context?.binding) {
			this.statusLabel.textContent = localize('nyala.query.status.unbound', 'No connection');
			this.statusLabel.classList.add('nyala-query-status-unbound');
			this.statusDetail.textContent = unboundHint(context);
			this.statusContainer.setAttribute('data-state', 'unbound');
			return;
		}
		this.statusLabel.classList.remove('nyala-query-status-unbound');
		this.statusLabel.textContent = context.binding.profileName;
		const parts: string[] = [];
		if (context.readOnly) {
			parts.push(localize('nyala.query.status.readOnly', 'read-only'));
		}
		if (context.defaultDatabase) {
			parts.push(context.defaultDatabase);
		}
		if (context.defaultSchema) {
			parts.push(context.defaultSchema);
		}
		this.statusDetail.textContent = parts.join(' · ');
		this.statusContainer.setAttribute('data-state', 'bound');
	}

	//#region View state

	protected override tracksEditorViewState(input: EditorInput): boolean {
		return input instanceof NyalaQueryEditorInput;
	}

	protected override toEditorViewStateResource(input: EditorInput): URI | undefined {
		return input.resource;
	}

	//#endregion
}

/** Why this tab has no connection, in the user's words. */
function unboundHint(context: NyalaQueryContext | undefined): string {
	switch (context?.unboundReason) {
		case 'runtime-restarted':
			return localize('nyala.query.status.restarted', 'The runtime restarted. Choose a connection to run this query.');
		case 'runtime-unavailable':
			return localize('nyala.query.status.unavailable', 'The runtime is not available. Choose a connection when it is back.');
		case 'connection-closed':
			return localize('nyala.query.status.closed', 'The connection was closed. Choose a connection to run this query.');
		case 'connection-failed':
			return localize('nyala.query.status.failed', 'The connection could not be opened. Choose a connection to run this query.');
		default:
			return localize('nyala.query.status.unboundHint', 'This query can be edited, but not run until you choose a connection.');
	}
}
