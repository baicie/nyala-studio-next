/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The editor input of one Nyala query tab (N-202). It owns nothing but identity:
//
//   - identity is `queryId`, exposed as the URI `nyala-query://local/<queryId>`;
//   - the text model and the query context belong to the query's `NyalaQueryDocument`, which this
//     input holds a reference to; two inputs for the same query therefore share both, and closing
//     one of them never destroys what the other is still using;
//   - the execution target lives in that context, never in this input and never in a global
//     "current connection".
//
// The URI carries the query id and nothing else. It is visible in the tab, the window title and
// any serialized layout, so it must not contain a path, a connection string, a user name, a
// password or a token (ADR 0007).

import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { localize } from '../../../../../nls.js';
import { ConfirmResult, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { EditorInputCapabilities, GroupIdentifier, IRevertOptions, ISaveOptions, IUntypedEditorInput, Verbosity } from '../../../../common/editor.js';
import { EditorInput, IEditorCloseHandler } from '../../../../common/editor/editorInput.js';
import { NyalaQueryContext } from './nyalaQueryContext.js';
import { NyalaQueryDocument } from './nyalaQueryDocument.js';
import { INyalaQueryDocumentService } from './nyalaQueryDocumentService.js';
import { NYALA_QUERY_EDITOR_ID } from './nyalaQueryResource.js';

/**
 * One query tab. The text and the context come from the window's document service, so a second tab
 * for the same query shares them and a different query shares nothing.
 */
export class NyalaQueryEditorInput extends EditorInput {

	static readonly ID = NYALA_QUERY_EDITOR_ID;

	override get typeId(): string {
		return NyalaQueryEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return NyalaQueryEditorInput.ID;
	}

	override readonly resource: URI;

	/** The query's shared model and context. Never disposed by this input directly. */
	readonly document: NyalaQueryDocument;

	/**
	 * A query tab is dirty until its text is saved; the workbench must not close it silently.
	 * It is not a singleton: the same query may be shown in two groups, sharing the document.
	 * `Scratchpad` says what is true in N-202: no file backs the tab, so it is kept out of
	 * "Save All" and out of the dirty-editor LRU cleanup until N-206 adds persistence.
	 */
	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Scratchpad;
	}

	/**
	 * Closing a dirty query tab must not offer "Save": there is no file to save to. The dialog
	 * says what will be lost and offers only Close/Cancel.
	 */
	override readonly closeHandler: IEditorCloseHandler = {
		showConfirm: () => this.isDirty(),
		confirm: async editors => {
			const message = editors.length === 1
				? localize('nyala.query.close.one', 'Close "{0}" without saving?', editors[0].editor.getName())
				: localize('nyala.query.close.many', 'Close {0} query tabs without saving?', editors.length);
			const { confirmed } = await this.dialogService.confirm({
				type: 'warning',
				message,
				detail: localize('nyala.query.close.detail', 'A query tab is not saved to a file yet. Its text exists only in this window and will be lost.'),
				primaryButton: localize('nyala.query.close.confirm', 'Close'),
			});
			return confirmed ? ConfirmResult.DONT_SAVE : ConfirmResult.CANCEL;
		},
	};

	private readonly documentListeners = this._register(new DisposableStore());
	private readonly reference: IDisposable;

	constructor(
		readonly queryId: string,
		@INyalaQueryDocumentService documentService: INyalaQueryDocumentService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super();
		this.document = documentService.get(queryId);
		this.resource = this.document.resource;
		this.reference = this.document.acquire();
		// Dirty state is a property of the shared text, so every input of the query hears about it.
		this.documentListeners.add(this.document.onDidChangeText(() => this._onDidChangeDirty.fire()));
	}

	override getName(): string {
		// The query id is a uuid; the user should not have to read it. The prefix keeps two query
		// tabs distinguishable while the full id stays the identity.
		return localize('nyala.query.name', 'Query {0}', this.queryId.slice(0, 8));
	}

	override getDescription(verbosity = Verbosity.MEDIUM): string | undefined {
		const binding = this.document.context.binding;
		if (!binding) {
			return verbosity === Verbosity.SHORT ? undefined : localize('nyala.query.unbound', 'no connection');
		}
		return binding.profileName;
	}

	override getTitle(verbosity: Verbosity = Verbosity.MEDIUM): string {
		const description = this.getDescription(verbosity);
		return description ? `${this.getName()} • ${description}` : this.getName();
	}

	override isDirty(): boolean {
		return !this.document.isDisposed && this.document.isDirty;
	}

	/** The model of this query, shared with every other input for it. */
	getModel(): ITextModel {
		return this.document.getModel();
	}

	/** The execution target of this query, shared with every other input for it. */
	getContext(): NyalaQueryContext {
		return this.document.context;
	}

	/** Replaces the whole text, e.g. when a draft is restored into a reopened tab. */
	setText(text: string): void {
		this.document.setText(text);
	}

	/** Marks the current text as the saved one; both inputs of the query become clean. */
	markSaved(): void {
		this.document.markSaved();
	}

	/** Whether the text differs from the last saved state (always false for a brand new model). */
	get hasUnsavedText(): boolean {
		return this.isDirty();
	}

	/**
	 * N-202 has no file behind a query tab. `EditorInput.save()` would return `this`, which makes
	 * Ctrl+S look like it saved something; failing visibly is the honest behavior until N-206 adds
	 * a real Save As / draft flow.
	 */
	override async save(group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | undefined> {
		throw notSavedToFile();
	}

	override async saveAs(group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | undefined> {
		throw notSavedToFile();
	}

	/** Restores the text the tab had when it was opened (or last marked saved). */
	override async revert(group: GroupIdentifier, options?: IRevertOptions): Promise<void> {
		this.document.revert();
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		// Two objects for the same query URI are the same tab; `super` compares untyped inputs by
		// canonical resource, and a second input for the same id is the same query by definition.
		if (otherInput === this || super.matches(otherInput)) {
			return true;
		}
		return otherInput instanceof NyalaQueryEditorInput && otherInput.queryId === this.queryId;
	}

	/**
	 * Gives up this tab's reference. The shared model and context are destroyed only when the last
	 * input for the query lets go, so closing one of two tabs leaves the other fully usable.
	 */
	override dispose(): void {
		this.documentListeners.clear();
		this.reference.dispose();
		super.dispose();
	}
}

/** The one refusal behind both save entry points; the message is what the notification shows. */
function notSavedToFile(): Error {
	return new Error(localize('nyala.query.save.noFile', 'This query tab is not saved to a file yet. Its text exists only in this window; copy the SQL if you need to keep it.'));
}
