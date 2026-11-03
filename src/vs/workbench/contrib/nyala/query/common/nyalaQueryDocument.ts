/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The resources one query owns: its text model and its query context (N-202). They are shared by
// every editor input that shows the same query — the same tab opened in two groups, or a tab that
// is closed and reopened — so neither may be destroyed by whichever input happens to dispose
// first. This is the small shared owner that makes that possible, in the Code OSS idiom of a
// reference-counted resource rather than a second editor model.
//
// Ownership rules:
//   - one document per query id; `IModelService` and the context service each hold the resource;
//   - an input acquires a reference when it is created and releases it on dispose;
//   - the last release disposes the document, which destroys the model and releases the context;
//   - the document survives a single input closing, so the other input keeps a live model;
//   - disposing twice is a no-op, and using the document after disposal is an error.

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { INyalaQueryContextService, NyalaQueryContext } from './nyalaQueryContext.js';
import { NYALA_QUERY_LANGUAGE_ID, nyalaQueryResource } from './nyalaQueryResource.js';

/**
 * One query's model and context, shared by its inputs. Created and owned by
 * `NyalaQueryDocumentService`; inputs never construct it directly.
 */
export class NyalaQueryDocument extends Disposable {

	private readonly _onDidChangeText = this._register(new Emitter<void>());
	/** Fires on every text change, so each input can update its own dirty state. */
	readonly onDidChangeText: Event<void> = this._onDidChangeText.event;

	private readonly _onDidChangeBinding = this._register(new Emitter<void>());
	readonly onDidChangeBinding: Event<void> = this._onDidChangeBinding.event;

	private readonly _onDidDispose = this._register(new Emitter<void>());
	/** Fires once, when the last input released this document; the service forgets it then. */
	readonly onDidDispose: Event<void> = this._onDidDispose.event;

	readonly resource: URI;
	readonly context: NyalaQueryContext;

	private text: ITextModel | undefined;
	private savedVersionId: number | undefined;
	/** The text as it was when the query was opened or last marked saved; `revert` restores it. */
	private savedText: string | undefined;
	private references = 0;
	private _disposed = false;
	private readonly listeners = this._register(new DisposableStore());

	constructor(
		readonly queryId: string,
		private readonly modelService: IModelService,
		private readonly languageService: ILanguageService,
		private readonly contextService: INyalaQueryContextService,
	) {
		super();
		this.resource = nyalaQueryResource(queryId);
		this.context = contextService.create(queryId);
		this.listeners.add(this.context.onDidChangeBinding(() => this._onDidChangeBinding.fire()));
	}

	get isDisposed(): boolean {
		return this._disposed;
	}

	/** The model, created on first use and reused by every input of this query. */
	getModel(): ITextModel {
		if (this._disposed) {
			throw new Error(`The query ${this.queryId} was closed; its text is gone.`);
		}
		if (!this.text || this.text.isDisposed()) {
			const existing = this.modelService.getModel(this.resource);
			this.text = existing ?? this.modelService.createModel('', this.languageService.createById(NYALA_QUERY_LANGUAGE_ID), this.resource);
			this.savedVersionId ??= this.text.getVersionId();
			this.savedText ??= this.text.getValue();
			this.listeners.add(this.text.onDidChangeContent(() => this._onDidChangeText.fire()));
		}
		return this.text;
	}

	get savedVersion(): number | undefined {
		return this.savedVersionId;
	}

	/** Whether the text differs from the last saved state; also shared by every input. */
	get isDirty(): boolean {
		return !!this.text && !this.text.isDisposed() && this.savedVersionId !== undefined && this.savedVersionId !== this.text.getVersionId();
	}

	/** Records that the current text is the saved one; shared, so both inputs see it. */
	markSaved(): void {
		const model = this.getModel();
		this.savedVersionId = model.getVersionId();
		this.savedText = model.getValue();
		this._onDidChangeText.fire();
	}

	/** Replaces the text and treats it as saved (a restored draft is not a user edit). */
	setText(text: string): void {
		const model = this.getModel();
		model.setValue(text);
		this.savedVersionId = model.getVersionId();
		this.savedText = text;
		this._onDidChangeText.fire();
	}

	/** Restores the text the query had when it was opened or last marked saved. */
	revert(): void {
		const model = this.getModel();
		if (this.savedText !== undefined && model.getValue() !== this.savedText) {
			model.setValue(this.savedText);
		}
		this.savedVersionId = model.getVersionId();
		this._onDidChangeText.fire();
	}

	/** Adds one input's reference. The document is not disposed while any reference remains. */
	acquire(): IDisposable {
		if (this._disposed) {
			throw new Error(`The query ${this.queryId} was closed; it cannot be shown again.`);
		}
		this.references++;
		let released = false;
		return {
			dispose: () => {
				if (released) {
					return;
				}
				released = true;
				this.references--;
				if (this.references <= 0) {
					this.dispose();
				}
			},
		};
	}

	/** How many inputs currently show this query; used by tests and diagnostics. */
	get referenceCount(): number {
		return this.references;
	}

	override dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this.listeners.clear();
		const text = this.text;
		this.text = undefined;
		if (text && !text.isDisposed()) {
			this.modelService.destroyModel(this.resource);
		}
		// Release the context before announcing the disposal: a listener that immediately opens the
		// query again then gets a fresh context instead of the one being torn down.
		this.contextService.release(this.queryId);
		this._onDidDispose.fire();
		super.dispose();
	}
}
