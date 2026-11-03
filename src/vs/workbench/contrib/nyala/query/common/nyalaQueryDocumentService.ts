/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// One `NyalaQueryDocument` per query id for the window's lifetime (N-202). Two inputs for the same
// query get the same document, so they share the text model and the binding without either of them
// owning either; two different query ids never share anything.
//
// The service itself does not keep a document alive: it holds the registry entry only. The document
// disposes itself when the last input releases it, and the registry entry is dropped then, so a
// later open of the same query starts with a new, empty model.

import { Disposable, DisposableMap, IDisposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { INyalaQueryContextService } from './nyalaQueryContext.js';
import { NyalaQueryDocument } from './nyalaQueryDocument.js';

export const INyalaQueryDocumentService = createDecorator<INyalaQueryDocumentService>('nyalaQueryDocumentService');

export interface INyalaQueryDocumentService {
	readonly _serviceBrand: undefined;

	/**
	 * The document of a query, created on first use. The caller must `acquire()` it (the editor
	 * input does so in its constructor) and release the returned handle when it stops showing the
	 * query; a document nobody acquired lives until the window closes.
	 */
	get(queryId: string): NyalaQueryDocument;

	/** The document, if this window currently has that query open. */
	peek(queryId: string): NyalaQueryDocument | undefined;
}

export class NyalaQueryDocumentService extends Disposable implements INyalaQueryDocumentService {

	declare readonly _serviceBrand: undefined;

	private readonly documents = new Map<string, NyalaQueryDocument>();
	/**
	 * One disposal listener per live document, removed as soon as that document is disposed. It has
	 * to be removed, not only registered: a `DisposableStore` would otherwise keep a subscription
	 * for every query ever opened in this window, and closing and reopening queries would grow it
	 * without bound.
	 */
	private readonly documentListeners = this._register(new DisposableMap<string, IDisposable>());

	constructor(
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@INyalaQueryContextService private readonly contextService: INyalaQueryContextService,
	) {
		super();
	}

	get(queryId: string): NyalaQueryDocument {
		const existing = this.documents.get(queryId);
		if (existing) {
			return existing;
		}
		const document: NyalaQueryDocument = new NyalaQueryDocument(queryId, this.modelService, this.languageService, this.contextService);
		// The listener drops the registry entry — but only the one that still belongs to this
		// document: a listener of the disposal may already have opened the same query again, in
		// which case that new document's listener and entry must survive.
		const listener = document.onDidDispose(() => {
			if (this.documentListeners.get(queryId) === listener) {
				this.documentListeners.deleteAndDispose(queryId);
			}
			if (this.documents.get(queryId) === document) {
				this.documents.delete(queryId);
			}
		});
		this.documentListeners.set(queryId, listener);
		this.documents.set(queryId, document);
		return document;
	}

	peek(queryId: string): NyalaQueryDocument | undefined {
		return this.documents.get(queryId);
	}

	/**
	 * How many disposal subscriptions the service currently holds. It must equal the number of live
	 * documents: a value that grows with the number of queries ever opened is a listener leak.
	 * Diagnostics for tests, not a UI contract.
	 */
	get documentListenerCount(): number {
		return this.documentListeners.size;
	}

	override dispose(): void {
		for (const document of [...this.documents.values()]) {
			document.dispose();
		}
		this.documents.clear();
		super.dispose();
	}
}
