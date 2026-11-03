/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The editor input of one Nyala query tab (N-202). It owns nothing but identity and the text:
//
//   - identity is `queryId`, exposed as the URI `nyala-query://local/<queryId>`;
//   - the text lives in an `IModelService` model under that URI, so a closed and reopened tab can
//     reuse it while another tab gets its own model;
//   - the execution target lives in a `NyalaQueryContext`, never in this input and never in a
//     global "current connection".
//
// The URI carries the query id and nothing else. It is visible in the tab, the window title and
// any serialized layout, so it must not contain a path, a connection string, a user name, a
// password or a token (ADR 0007).

import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { localize } from '../../../../../nls.js';
import { EditorInputCapabilities, IUntypedEditorInput, Verbosity } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { INyalaQueryContextService } from './nyalaQueryContext.js';

/** The scheme of a query tab's URI. `local` marks the window; no path or secret is encoded. */
export const NYALA_QUERY_SCHEME = 'nyala-query';

/** The editor type id; also the pane id and the serializer's input id. */
export const NYALA_QUERY_EDITOR_ID = 'workbench.editor.nyalaQuery';

/** `sql`, matching the built-in syntax the workbench already ships. */
export const NYALA_QUERY_LANGUAGE_ID = 'sql';

/** The URI of a query. Only the query id appears in it. */
export function nyalaQueryResource(queryId: string): URI {
	return URI.from({ scheme: NYALA_QUERY_SCHEME, authority: 'local', path: `/${queryId}` });
}

/** Reads a query id back out of a query URI, or `undefined` for anything else. */
export function queryIdOf(resource: URI | undefined): string | undefined {
	if (!resource || resource.scheme !== NYALA_QUERY_SCHEME || resource.authority !== 'local') {
		return undefined;
	}
	const id = resource.path.replace(/^\//, '');
	return id.length > 0 && !id.includes('/') ? id : undefined;
}

/**
 * One query tab. The text model is created on demand and handed to the pane; the context is
 * fetched from the window's context service so a reopened tab and its first tab share only what
 * the query id says they share.
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

	/**
	 * A query tab is dirty until it is saved to a file; the workbench must not close it silently.
	 * It is not a singleton: the same query may be shown in two groups, sharing the model.
	 */
	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.None;
	}

	private readonly modelDisposables = this._register(new DisposableStore());
	private model: ITextModel | undefined;
	private savedVersionId: number | undefined;

	constructor(
		readonly queryId: string,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@INyalaQueryContextService private readonly contextService: INyalaQueryContextService,
	) {
		super();
		this.resource = nyalaQueryResource(queryId);
	}

	override getName(): string {
		// The query id is a uuid; the user should not have to read it. The number is the tab's
		// ordinal within this window, so two query tabs stay distinguishable.
		return localize('nyala.query.name', 'Query {0}', this.queryId.slice(0, 8));
	}

	override getDescription(verbosity = Verbosity.MEDIUM): string | undefined {
		const binding = this.contextService.get(this.queryId)?.binding;
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
		const model = this.model;
		if (!model) {
			return false;
		}
		return this.savedVersionId !== undefined && this.savedVersionId !== model.getVersionId();
	}

	/** The model of this query, created once and kept across pane re-creation. */
	getModel(): ITextModel {
		if (!this.model || this.model.isDisposed()) {
			const existing = this.modelService.getModel(this.resource);
			this.model = existing ?? this.modelService.createModel('', this.languageService.createById(NYALA_QUERY_LANGUAGE_ID), this.resource);
			this.watchModel(this.model);
		}
		return this.model;
	}

	/** Replaces the whole text, e.g. when a draft is restored into a reopened tab. */
	setText(text: string): void {
		const model = this.getModel();
		model.setValue(text);
		this.savedVersionId = model.getVersionId();
		this._onDidChangeDirty.fire();
	}

	/** Marks the current text as the saved one; the pane calls this after writing a file. */
	markSaved(): void {
		this.savedVersionId = this.getModel().getVersionId();
		this._onDidChangeDirty.fire();
	}

	/** Whether the text differs from the last saved state (always false for a brand new model). */
	get hasUnsavedText(): boolean {
		return this.isDirty();
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		// Two objects for the same query URI are the same tab; `super` compares untyped inputs by
		// canonical resource, and a second input for the same id is the same query by definition.
		if (otherInput === this || super.matches(otherInput)) {
			return true;
		}
		return otherInput instanceof NyalaQueryEditorInput && otherInput.queryId === this.queryId;
	}

	/** Text is kept while the window lives; the model is disposed with the input. */
	override dispose(): void {
		this.modelDisposables.clear();
		this.contextService.release(this.queryId);
		if (this.model && !this.model.isDisposed()) {
			this.modelService.destroyModel(this.resource);
		}
		this.model = undefined;
		super.dispose();
	}

	private watchModel(model: ITextModel): void {
		if (this.savedVersionId === undefined) {
			this.savedVersionId = model.getVersionId();
		}
		this.modelDisposables.clear();
		this.modelDisposables.add(model.onDidChangeContent(() => this._onDidChangeDirty.fire()));
	}
}
