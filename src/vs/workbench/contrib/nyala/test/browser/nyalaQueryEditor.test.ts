/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// N-202 acceptance tests for the query editor itself: the EditorInput's identity and URI, the
// text model per query, the pane's status line, and the guarantees a tab must keep while it is
// open, closed and reopened. Everything here runs against real workbench services except the
// runtime, which a fake connection service stands in for.

import assert from 'assert';
import { Dimension } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INyalaRuntimeState } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeIpc.js';
import { ITestInstantiationService, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { NyalaQueryEditorSerializer } from '../../query/browser/nyalaQuery.contribution.js';
import { NyalaQueryEditorPane } from '../../query/browser/nyalaQueryEditorPane.js';
import { INyalaQueryContextService } from '../../query/common/nyalaQueryContext.js';
import { NyalaQueryContextService } from '../../query/common/nyalaQueryContextService.js';
import { NyalaQueryEditorInput } from '../../query/common/nyalaQueryEditorInput.js';
import { INyalaQueryDocumentService, NyalaQueryDocumentService } from '../../query/common/nyalaQueryDocumentService.js';
import { NYALA_QUERY_SCHEME, nyalaQueryResource, queryIdOf } from '../../query/common/nyalaQueryResource.js';
import { INyalaCatalog, INyalaConnectionHandle, INyalaConnectionService, INyalaConnectionState } from '../../connections/common/nyalaConnectionService.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { EditorInputCapabilities, EditorResourceAccessor } from '../../../../common/editor.js';
import { ConfirmResult, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { MenuId, MenuRegistry, isIMenuItem } from '../../../../../platform/actions/common/actions.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IEditorFactoryRegistry, EditorExtensions } from '../../../../common/editor.js';
import { IEditorPaneRegistry } from '../../../../browser/editor.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { Event } from '../../../../../base/common/event.js';
import { NYALA_CHANGE_CONNECTION_COMMAND_ID, NYALA_NEW_QUERY_COMMAND_ID } from '../../query/browser/nyalaQuery.contribution.js';
import '../../query/browser/nyalaQuery.contribution.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { TestCodeEditor } from '../../../../../editor/test/browser/testCodeEditor.js';
import { IEditorOptions as ICodeEditorOptions } from '../../../../../editor/common/config/editorOptions.js';

/**
 * The pane with the test editor control. `workbenchInstantiationService` has no
 * `IUserInteractionService`, which a real `CodeEditorWidget` needs for its focus tracker; every
 * workbench editor suite substitutes `TestCodeEditor` for exactly this reason.
 */
class TestNyalaQueryEditorPane extends NyalaQueryEditorPane {
	protected override createEditorControl(parent: HTMLElement, configuration: ICodeEditorOptions): void {
		this.editorControl = this._register(this.instantiationService.createInstance(TestCodeEditor, parent, configuration, { contributions: [] }));
	}
}

/** A connection service whose rows the test controls. */
class FakeConnectionService implements INyalaConnectionService {

	declare readonly _serviceBrand: undefined;

	readonly changes = new Emitter<void>();
	readonly onDidChangeConnections = this.changes.event;
	readonly runtimeChanges = new Emitter<INyalaRuntimeState>();
	readonly onDidChangeRuntime = this.runtimeChanges.event;

	rows: INyalaConnectionState[] = [];
	runtimeState: INyalaRuntimeState = { generation: 1, status: 'ready' };
	readonly calls: string[] = [];
	private opens = 0;

	get connections(): readonly INyalaConnectionState[] {
		return this.rows;
	}

	async addProfile(): Promise<string> {
		throw new Error('profiles are seeded by the test');
	}

	async restoreProfiles(): Promise<void> { }

	async refreshRuntime(): Promise<INyalaRuntimeState> {
		return this.runtimeState;
	}

	async connect(profileId: string): Promise<void> {
		this.calls.push(`connect:${profileId}`);
		const row = this.rows.find(state => state.profile.profileId === profileId);
		if (row) {
			this.opens++;
			this.setRow({ ...row, status: 'connected', handle: { profileId, sessionId: `s_${this.opens}`, sessionGeneration: 1, runtimeGeneration: this.runtimeState.generation } });
		}
	}

	async disconnect(profileId: string): Promise<void> {
		this.calls.push(`disconnect:${profileId}`);
		const row = this.rows.find(state => state.profile.profileId === profileId);
		if (row) {
			this.setRow({ ...row, status: 'disconnected', handle: undefined });
		}
	}

	async refresh(): Promise<void> { }

	catalog(): INyalaCatalog | undefined {
		return undefined;
	}

	async listObjects(): Promise<never> {
		throw new Error('not used');
	}

	async describe(): Promise<never> {
		throw new Error('not used');
	}

	setRow(row: INyalaConnectionState): void {
		this.rows = this.rows.map(state => state.profile.profileId === row.profile.profileId ? row : state);
		this.changes.fire();
	}

	setRuntime(state: INyalaRuntimeState): void {
		this.runtimeState = state;
		this.runtimeChanges.fire(state);
	}

	dispose(): void {
		this.changes.dispose();
		this.runtimeChanges.dispose();
	}
}

function connectedRow(profileId: string, sessionId: string, path = `/tmp/${profileId}.sqlite`): INyalaConnectionState {
	const handle: INyalaConnectionHandle = { profileId, sessionId, sessionGeneration: 1, runtimeGeneration: 1 };
	return { profile: { profileId, displayName: `${profileId}.sqlite`, target: { driver: 'sqlite', path, readOnly: true } }, status: 'connected', handle };
}

suite('Nyala query editor', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let connections: FakeConnectionService;
	let contextService: NyalaQueryContextService;
	let documentService: NyalaQueryDocumentService;
	let instantiationService: ITestInstantiationService;

	setup(() => {
		connections = store.add(new FakeConnectionService());
		contextService = store.add(new NyalaQueryContextService(connections, new NullLogService()));
		instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(INyalaConnectionService, connections);
		instantiationService.stub(INyalaQueryContextService, contextService);
		const modelService = instantiationService.invokeFunction(accessor => accessor.get(IModelService));
		// The built-in `sql` language comes from an extension, which this suite does not load;
		// registering the id keeps the model's language the one the editor asks for.
		const languageService = instantiationService.invokeFunction(accessor => accessor.get(ILanguageService));
		store.add(languageService.registerLanguage({ id: 'sql' }));
		documentService = store.add(new NyalaQueryDocumentService(modelService, languageService, contextService));
		instantiationService.stub(INyalaQueryDocumentService, documentService);
	});

	function getModelService(): IModelService {
		return instantiationService.invokeFunction(accessor => accessor.get(IModelService));
	}

	function createInput(queryId = 'q_1'): NyalaQueryEditorInput {
		return store.add(instantiationService.createInstance(NyalaQueryEditorInput, queryId));
	}

	function createPane(): { pane: TestNyalaQueryEditorPane; container: HTMLElement } {
		const group = new class extends mock<IEditorGroup>() {
			override windowId = mainWindow.vscodeWindowId;
			override isPinned() { return false; }
			override isSticky() { return false; }
			override ariaLabel = 'Editor group';
		}();
		const pane = store.add(instantiationService.createInstance(TestNyalaQueryEditorPane, group));
		const container = document.createElement('div');
		mainWindow.document.body.appendChild(container);
		store.add(toDisposable(() => container.remove()));
		pane.create(container);
		pane.layout(new Dimension(800, 600));
		return { pane, container };
	}

	//#region Identity and URI

	test('the query URI carries the query id and no path, user, password or token', () => {
		connections.rows = [connectedRow('p_secret', 's_1', '/home/alice/secret/db.sqlite')];
		const input = createInput('q_9f3c');
		const context = contextService.create(input.queryId);

		assert.deepStrictEqual({
			uri: input.resource.toString(),
			scheme: input.resource.scheme,
			authority: input.resource.authority,
			path: input.resource.path,
			query: input.resource.query,
			fragment: input.resource.fragment,
			queryId: queryIdOf(input.resource),
			resourceIsInputs: input.resource === (input as unknown as { resource: unknown }).resource,
			contextIsSeparate: context.queryId === input.queryId,
		}, {
			uri: 'nyala-query://local/q_9f3c',
			scheme: NYALA_QUERY_SCHEME,
			authority: 'local',
			path: '/q_9f3c',
			query: '',
			fragment: '',
			queryId: 'q_9f3c',
			resourceIsInputs: true,
			contextIsSeparate: true,
		});
		assert.ok(!input.resource.toString().includes('alice'));
		assert.ok(!input.resource.toString().includes('sqlite'));
	});

	test('a resource with another scheme or no id is not a query', () => {
		assert.deepStrictEqual({
			otherScheme: queryIdOf(nyalaQueryResource('q_1').with({ scheme: 'file' })),
			otherAuthority: queryIdOf(nyalaQueryResource('q_1').with({ authority: 'remote' })),
			empty: queryIdOf(nyalaQueryResource('')),
			nested: queryIdOf(nyalaQueryResource('a/b')),
			none: queryIdOf(undefined),
		}, { otherScheme: undefined, otherAuthority: undefined, empty: undefined, nested: undefined, none: undefined });
	});

	test('two inputs for the same query id are the same tab; different ids are different tabs', () => {
		const a = createInput('q_1');
		const aAgain = createInput('q_1');
		const b = createInput('q_2');

		assert.deepStrictEqual({
			sameIdMatches: a.matches(aAgain),
			differentIdMatches: a.matches(b),
			untypedMatches: a.matches({ resource: nyalaQueryResource('q_1') }),
			untypedOther: a.matches({ resource: nyalaQueryResource('q_2') }),
		}, { sameIdMatches: true, differentIdMatches: false, untypedMatches: true, untypedOther: false });
	});

	//#endregion

	//#region Text models

	test('each query gets its own model, and the same query reuses its model', () => {
		const a = createInput('q_1');
		const b = createInput('q_2');
		const modelService = instantiationService.invokeFunction(accessor => accessor.get(IModelService));

		const modelA = a.getModel();
		modelA.setValue('SELECT 1;');

		assert.deepStrictEqual({
			distinct: modelA !== b.getModel(),
			uris: [modelA.uri.toString(), b.getModel().uri.toString()],
			reused: a.getModel() === modelA,
			fromService: modelService.getModel(a.resource) === modelA,
			language: modelA.getLanguageId(),
			text: modelA.getValue(),
		}, {
			distinct: true,
			uris: ['nyala-query://local/q_1', 'nyala-query://local/q_2'],
			reused: true,
			fromService: true,
			language: 'sql',
			text: 'SELECT 1;',
		});
	});

	test('closing the last tab of a query disposes its model, so reopening it starts empty', () => {
		const input = createInput('q_1');
		const model = input.getModel();
		model.setValue('SELECT * FROM customers;');
		input.dispose();

		const reopened = createInput('q_1');

		// The last holder destroyed the model, so the reopened tab starts clean; what must never
		// happen is inheriting another query's text.
		assert.notStrictEqual(reopened.getModel(), model);
		assert.strictEqual(model.isDisposed(), true);
		assert.strictEqual(reopened.getModel().getValue(), '');
		assert.strictEqual(reopened.getModel().uri.toString(), nyalaQueryResource('q_1').toString());
	});

	test('a tab is dirty only after its text diverges from the last saved state', () => {
		const input = createInput('q_1');
		const model = input.getModel();
		const dirtyStates: boolean[] = [input.isDirty()];

		model.setValue('SELECT 1;');
		dirtyStates.push(input.isDirty());
		input.markSaved();
		dirtyStates.push(input.isDirty());
		model.setValue('SELECT 2;');
		dirtyStates.push(input.isDirty());

		assert.deepStrictEqual(dirtyStates, [false, true, false, true]);
	});

	//#endregion

	//#region Model and context ownership

	test('two inputs for the same query share one model and one context', () => {
		const first = createInput('q_shared');
		const second = createInput('q_shared');
		const firstDirty: boolean[] = [];
		const secondDirty: boolean[] = [];
		const listeners = store.add(new DisposableStore());
		listeners.add(first.onDidChangeDirty(() => firstDirty.push(first.isDirty())));
		listeners.add(second.onDidChangeDirty(() => secondDirty.push(second.isDirty())));

		const model = first.getModel();
		model.setValue('SELECT 1;');

		assert.deepStrictEqual({
			sameDocument: first.document === second.document,
			sameModel: first.getModel() === second.getModel(),
			sameContext: first.getContext() === second.getContext(),
			sharedText: second.getModel().getValue(),
			bothDirty: [first.isDirty(), second.isDirty()],
			firstDirty,
			secondDirty,
			references: second.document.referenceCount,
		}, {
			sameDocument: true,
			sameModel: true,
			sameContext: true,
			sharedText: 'SELECT 1;',
			bothDirty: [true, true],
			firstDirty: [true],
			secondDirty: [true],
			references: 2,
		});
	});

	test('a label change in one input reaches the workbench for every input of the query', async () => {
		connections.rows = [connectedRow('p_a', 's_a')];
		const first = createInput('q_label');
		const second = createInput('q_label');
		const firstLabels: string[] = [];
		const secondLabels: string[] = [];
		const listeners = store.add(new DisposableStore());
		listeners.add(first.onDidChangeLabel(() => firstLabels.push(String(first.getDescription()))));
		listeners.add(second.onDidChangeLabel(() => secondLabels.push(String(second.getDescription()))));

		await contextService.bind(first.getContext(), 'p_a');

		assert.deepStrictEqual({
			firstLabels,
			secondLabels,
			firstDescriptions: [first.getDescription(), second.getDescription()],
		}, {
			firstLabels: ['p_a.sqlite'],
			secondLabels: ['p_a.sqlite'],
			firstDescriptions: ['p_a.sqlite', 'p_a.sqlite'],
		}, 'both inputs of one query repaint when its shared binding changes');

		firstLabels.length = 0;
		secondLabels.length = 0;
		connections.setRow({ ...connectedRow('p_a', 's_a'), status: 'disconnected', handle: undefined });

		assert.deepStrictEqual({
			firstLabels,
			secondLabels,
			descriptions: [first.getDescription(), second.getDescription()],
		}, {
			firstLabels: ['no connection'],
			secondLabels: ['no connection'],
			descriptions: ['no connection', 'no connection'],
		}, 'a disconnect repaints both tabs, not only the active one');
	});

	test('a switch leaves every input of the query without an execution target until it settles', async () => {
		connections.rows = [connectedRow('p_a', 's_a'), { ...connectedRow('p_b', 's_b'), status: 'disconnected', handle: undefined }];
		const first = createInput('q_switch');
		const second = createInput('q_switch');
		await contextService.bind(first.getContext(), 'p_a');
		const paneA = createPane().pane;
		const paneB = createPane().pane;
		await paneA.setInput(first, undefined, {}, CancellationToken.None);
		await paneB.setInput(second, undefined, {}, CancellationToken.None);

		const start = connections.connect.bind(connections);
		const gate = new DeferredPromise<void>();
		connections.connect = async (profileId: string) => {
			await gate.p;
			return start(profileId);
		};
		const switching = contextService.bind(second.getContext(), 'p_b');
		// The switch already handled everything up to its first real wait; a microtask flush is
		// enough to observe the pending state deterministically.
		await Promise.resolve();
		await Promise.resolve();

		const during = {
			state: first.getContext().bindingState,
			descriptions: [first.getDescription(), second.getDescription()],
			bindings: [paneA.getExecutionBinding(), paneB.getExecutionBinding()],
		};

		gate.complete();
		await switching;

		assert.deepStrictEqual({
			during,
			after: { profile: first.getContext().profileId, bindingA: paneA.getExecutionBinding()?.profileId, bindingB: paneB.getExecutionBinding()?.profileId },
		}, {
			during: { state: 'switching', descriptions: ['connecting to p_b.sqlite…', 'connecting to p_b.sqlite…'], bindings: [undefined, undefined] },
			after: { profile: 'p_b', bindingA: 'p_b', bindingB: 'p_b' },
		});
	});

	test('closing one of two tabs keeps the other tab\'s model and context alive', () => {
		const first = createInput('q_shared');
		const second = createInput('q_shared');
		first.getModel().setValue('SELECT 1;');
		const model = second.getModel();
		const context = second.getContext();

		first.dispose();

		const afterFirstClose = {
			modelAlive: !model.isDisposed(),
			modelStillRegistered: getModelService().getModel(model.uri) === model,
			text: second.getModel().getValue(),
			contextAlive: !context.isDisposed,
			contextStillRegistered: contextService.get('q_shared') === context,
			documentRegistered: documentService.peek('q_shared') === second.document,
			references: second.document.referenceCount,
		};

		second.getModel().setValue('SELECT 2;');

		assert.deepStrictEqual({
			afterFirstClose,
			editedAfterClose: second.getModel().getValue(),
			dirty: second.isDirty(),
		}, {
			afterFirstClose: {
				modelAlive: true,
				modelStillRegistered: true,
				text: 'SELECT 1;',
				contextAlive: true,
				contextStillRegistered: true,
				documentRegistered: true,
				references: 1,
			},
			editedAfterClose: 'SELECT 2;',
			dirty: true,
		});
	});

	test('two query ids never share a model or a context', () => {
		const a = createInput('q_a');
		const b = createInput('q_b');
		const modelA = a.getModel();
		const modelB = b.getModel();
		const contextA = a.getContext();
		const contextB = b.getContext();
		modelA.setValue('SELECT 1;');

		a.dispose();

		assert.deepStrictEqual({
			distinctModels: modelA !== modelB,
			distinctContexts: contextA !== contextB,
			distinctDocuments: a.document !== b.document,
			aModelGone: modelA.isDisposed(),
			bTextUntouched: b.getModel().getValue(),
			bModelAlive: !modelB.isDisposed(),
			bContextAlive: !contextB.isDisposed,
		}, {
			distinctModels: true,
			distinctContexts: true,
			distinctDocuments: true,
			aModelGone: true,
			bTextUntouched: '',
			bModelAlive: true,
			bContextAlive: true,
		});
	});

	test('closing and reopening many queries does not accumulate registry entries or listeners', () => {
		const rounds = 10;
		for (let index = 0; index < rounds; index++) {
			const input = createInput(`q_cycle_${index}`);
			input.getModel().setValue(`SELECT ${index};`);
			input.dispose();
		}

		// Two live documents at the end: the listener count must follow the live documents, not the
		// number of queries ever opened (rounds * 1 + the two below would mean a leak).
		const live = [createInput('q_live_a'), createInput('q_live_b')];

		assert.deepStrictEqual({
			listeners: documentService.documentListenerCount,
			liveDocuments: [documentService.peek('q_live_a') !== undefined, documentService.peek('q_live_b') !== undefined],
			closedGone: documentService.peek('q_cycle_3'),
			liveCount: live.length,
		}, {
			listeners: 2,
			liveDocuments: [true, true],
			closedGone: undefined,
			liveCount: 2,
		});

		for (const input of live) {
			input.dispose();
		}
		assert.strictEqual(documentService.documentListenerCount, 0, 'the last release removes the listener too');
	});

	test('a disposed document removes only its own listener, not a re-created one for the same id', () => {
		const first = createInput('q_reopen');
		const document = first.document;
		first.dispose();
		// Reopening the same id creates a new document and a new listener while the old one is gone.
		const second = createInput('q_reopen');

		assert.deepStrictEqual({
			newDocument: second.document !== document,
			listeners: documentService.documentListenerCount,
			registryIsNew: documentService.peek('q_reopen') === second.document,
		}, { newDocument: true, listeners: 1, registryIsNew: true });

		second.dispose();
		assert.strictEqual(documentService.documentListenerCount, 0);
		assert.strictEqual(documentService.peek('q_reopen'), undefined);
	});

	test('the last holder releases the document, and releasing twice is a no-op', () => {
		const first = createInput('q_last');
		const second = createInput('q_last');
		const document = first.document;
		const model = first.getModel();
		const context = first.getContext();
		model.setValue('SELECT 1;');

		first.dispose();
		const afterOneClose = {
			documentDisposed: document.isDisposed,
			references: document.referenceCount,
			modelAlive: !model.isDisposed(),
		};

		second.dispose();
		// Neither a repeated input dispose nor a repeated release may touch the other holder.
		first.dispose();
		second.dispose();

		assert.deepStrictEqual({
			afterOneClose,
			documentDisposed: document.isDisposed,
			references: document.referenceCount,
			modelDisposed: model.isDisposed(),
			modelGone: getModelService().getModel(model.uri),
			contextGone: contextService.get('q_last'),
			contextDisposed: context.isDisposed,
			registryEmpty: documentService.peek('q_last'),
		}, {
			afterOneClose: { documentDisposed: false, references: 1, modelAlive: true },
			documentDisposed: true,
			references: 0,
			modelDisposed: true,
			modelGone: null,
			contextGone: undefined,
			contextDisposed: true,
			registryEmpty: undefined,
		});

		// A closed document refuses to hand out its model instead of resurrecting it.
		assert.throws(() => document.getModel(), /was closed/);
	});

	//#endregion

	//#region Pane

	test('the pane edits the tab\'s model and its status line follows the tab\'s own context', async () => {
		connections.rows = [connectedRow('p_a', 's_a'), connectedRow('p_b', 's_b')];
		const tabA = createInput('q_a');
		const tabB = createInput('q_b');
		const { pane, container } = createPane();

		await pane.setInput(tabA, undefined, {}, CancellationToken.None);
		const statusA = container.querySelector('.nyala-query-status-label')?.textContent;
		await contextService.bind(contextService.create('q_a'), 'p_a');
		const boundA = container.querySelector('.nyala-query-status-label')?.textContent;

		await pane.setInput(tabB, undefined, {}, CancellationToken.None);
		const statusB = container.querySelector('.nyala-query-status-label')?.textContent;
		await contextService.bind(contextService.create('q_b'), 'p_b');
		const boundB = container.querySelector('.nyala-query-status-label')?.textContent;

		assert.deepStrictEqual({
			editing: pane.getText() === tabB.getModel().getValue(),
			statusA,
			boundA,
			statusB,
			boundB,
			bindingOfA: pane.getContext()?.queryId,
		}, {
			editing: true,
			statusA: 'No connection',
			boundA: 'p_a.sqlite',
			statusB: 'No connection',
			boundB: 'p_b.sqlite',
			bindingOfA: 'q_b',
		});
	});

	test('the pane never executes an unbound tab, and follows a binding that is lost', async () => {
		connections.rows = [connectedRow('p_a', 's_a')];
		const input = createInput('q_1');
		const { pane, container } = createPane();
		await pane.setInput(input, undefined, {}, CancellationToken.None);
		const context = contextService.create('q_1');

		const before = pane.getExecutionBinding();
		await contextService.bind(context, 'p_a');
		const bound = pane.getExecutionBinding();
		connections.setRow({ ...connectedRow('p_a', 's_a'), status: 'lost', handle: undefined });
		const afterLoss = pane.getExecutionBinding();

		assert.deepStrictEqual({
			before: before,
			boundProfile: bound?.profileId,
			afterLoss: afterLoss,
			status: container.querySelector('.nyala-query-status-label')?.textContent,
		}, { before: undefined, boundProfile: 'p_a', afterLoss: undefined, status: 'No connection' });
	});

	test('a runtime restart makes an otherwise bound pane unable to execute', async () => {
		connections.rows = [connectedRow('p_a', 's_a')];
		const input = createInput('q_1');
		const { pane } = createPane();
		await pane.setInput(input, undefined, {}, CancellationToken.None);
		await contextService.bind(contextService.create('q_1'), 'p_a');
		const before = pane.getExecutionBinding();

		// The runtime state changes before the connection rows do; the pane must already refuse.
		connections.setRuntime({ generation: 2, status: 'ready' });
		const after = pane.getExecutionBinding();

		assert.deepStrictEqual({ before: before?.sessionId, after }, { before: 's_a', after: undefined });
	});

	test('switching the pane to another tab drops the previous tab\'s context listener', async () => {
		connections.rows = [connectedRow('p_a', 's_a'), connectedRow('p_b', 's_b')];
		const tabA = createInput('q_a');
		const tabB = createInput('q_b');
		const contextA = contextService.create('q_a');
		const contextB = contextService.create('q_b');
		const { pane, container } = createPane();

		await pane.setInput(tabA, undefined, {}, CancellationToken.None);
		await contextService.bind(contextA, 'p_a');
		await pane.setInput(tabB, undefined, {}, CancellationToken.None);
		await contextService.bind(contextB, 'p_b');
		// Tab A's binding changes while tab B is shown: the pane must keep showing tab B.
		await contextService.bind(contextA, 'p_b');

		assert.deepStrictEqual({
			context: pane.getContext(),
			binding: pane.getExecutionBinding()?.profileId,
			label: container.querySelector('.nyala-query-status-label')?.textContent,
		}, { context: contextB, binding: 'p_b', label: 'p_b.sqlite' });
	});

	test('two panes on two inputs of one query edit the same text and follow the same binding', async () => {
		connections.rows = [connectedRow('p_a', 's_a')];
		const first = createInput('q_pair');
		const second = createInput('q_pair');
		const paneA = createPane();
		const paneB = createPane();
		await paneA.pane.setInput(first, undefined, {}, CancellationToken.None);
		await paneB.pane.setInput(second, undefined, {}, CancellationToken.None);

		await contextService.bind(first.getContext(), 'p_a');
		const label = (container: HTMLElement) => container.querySelector('.nyala-query-status-label')?.textContent;

		first.getModel().setValue('SELECT * FROM customers;');

		const beforeClose = {
			textA: paneA.pane.getText(),
			textB: paneB.pane.getText(),
			sameContext: paneA.pane.getContext() === paneB.pane.getContext(),
			sameBinding: paneA.pane.getExecutionBinding() === paneB.pane.getExecutionBinding(),
			sessionA: paneA.pane.getExecutionBinding()?.sessionId,
			labelA: label(paneA.container),
			labelB: label(paneB.container),
		};

		// Close one of the two tabs: the other pane keeps editing the same, still-live model.
		paneA.pane.clearInput();
		first.dispose();
		second.getModel().setValue('SELECT 2;');

		assert.deepStrictEqual({
			beforeClose,
			afterClose: {
				textB: paneB.pane.getText(),
				modelAlive: !second.getModel().isDisposed(),
				labelB: label(paneB.container),
			},
		}, {
			beforeClose: {
				textA: 'SELECT * FROM customers;',
				textB: 'SELECT * FROM customers;',
				sameContext: true,
				sameBinding: true,
				sessionA: 's_a',
				labelA: 'p_a.sqlite',
				labelB: 'p_a.sqlite',
			},
			afterClose: {
				textB: 'SELECT 2;',
				modelAlive: true,
				labelB: 'p_a.sqlite',
			},
		});
	});

	//#endregion

	//#region Registration and commands

	test('the pane, resolver and serializer are registered for the query scheme exactly once', () => {
		const panes = Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane);
		const factories = Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory);
		// The workbench calls this once at startup; serializers are instantiated then, not on
		// registration, so a test that asserts the serializer must do the same.
		factories.start({ get: id => instantiationService.invokeFunction(accessor => accessor.get(id)) });

		assert.deepStrictEqual({
			paneId: panes.getEditorPane(createInput('q_registered'))?.typeId,
			paneByQueryInput: panes.getEditorPane(createInput('q_other'))?.typeId,
			serializerFor: !!factories.getEditorSerializer(createInput('q_serialized')),
			newQueryCommand: !!CommandsRegistry.getCommand(NYALA_NEW_QUERY_COMMAND_ID),
			changeConnectionCommand: !!CommandsRegistry.getCommand(NYALA_CHANGE_CONNECTION_COMMAND_ID),
			titleMenu: MenuRegistry.getMenuItems(MenuId.EditorTitle).filter(item => isIMenuItem(item) && item.command.id === NYALA_CHANGE_CONNECTION_COMMAND_ID).length,
		}, {
			paneId: NyalaQueryEditorPane.ID,
			paneByQueryInput: NyalaQueryEditorPane.ID,
			serializerFor: true,
			newQueryCommand: true,
			changeConnectionCommand: true,
			titleMenu: 1,
		});
	});

	test('Nyala: New Query opens a query tab through the editor service', async () => {
		const opened: string[] = [];
		instantiationService.stub(IEditorService, new class extends mock<IEditorService>() {
			override readonly onDidActiveEditorChange = Event.None;
			override async openEditor(...args: unknown[]): Promise<undefined> {
				opened.push(EditorResourceAccessor.getOriginalUri(args[0] as EditorInput)?.toString() ?? '');
				return undefined;
			}
		}());
		const handler = CommandsRegistry.getCommand(NYALA_NEW_QUERY_COMMAND_ID)!.handler;

		await instantiationService.invokeFunction(accessor => handler(accessor));

		assert.strictEqual(opened.length, 1);
		assert.ok(/^nyala-query:\/\/local\/[0-9a-f-]{36}$/i.test(opened[0]), `a fresh query URI: ${opened[0]}`);
		assert.strictEqual(queryIdOf(URI.parse(opened[0])), opened[0].split('/').pop());
	});

	test('Change Query Connection refuses when the active tab is not a Nyala query', async () => {
		const messages: string[] = [];
		instantiationService.stub(IEditorService, new class extends mock<IEditorService>() {
			override readonly onDidActiveEditorChange = Event.None;
			override readonly activeEditor = undefined;
		}());
		instantiationService.stub(INotificationService, new class extends mock<INotificationService>() {
			override info(message: { toString(): string }) { messages.push(message.toString()); return { close: () => { }, onDidClose: Event.None, onDidChangeVisibility: Event.None, progress: undefined, updateMessage: () => { }, updateSeverity: () => { }, updateActions: () => { } }; }
		}());
		const handler = CommandsRegistry.getCommand(NYALA_CHANGE_CONNECTION_COMMAND_ID)!.handler;

		await instantiationService.invokeFunction(accessor => handler(accessor));

		assert.deepStrictEqual(messages, ['Open a Nyala query tab first.']);
	});

	//#endregion

	//#region Persistence and disposal

	test('the serializer stores the query id only, never the text, a session, path or credential', () => {
		connections.rows = [connectedRow('p_a', 's_a', '/home/alice/private.sqlite')];
		const input = createInput('q_1');
		input.getModel().setValue("SELECT * FROM customers WHERE token = 'sk-live-secret';");
		contextService.create('q_1');
		const serializer = new NyalaQueryEditorSerializer();

		const serialized = serializer.serialize(input) ?? '';

		assert.deepStrictEqual(JSON.parse(serialized), { queryId: 'q_1' });
		assert.ok(!serialized.includes('alice'));
		assert.ok(!serialized.includes('s_a'));
		assert.ok(!serialized.includes('private.sqlite'));
		// N-202 does not put the SQL body into the window layout: a layout file must not become a
		// silent store for statements that may contain sensitive literals.
		assert.ok(!serialized.includes('sk-live-secret'));
		assert.ok(!serialized.includes('SELECT'));
	});

	test('deserializing restores the tab identity with no text and no binding', () => {
		connections.rows = [connectedRow('p_a', 's_a')];
		const serializer = new NyalaQueryEditorSerializer();

		const restored = serializer.deserialize(instantiationService, JSON.stringify({ queryId: 'q_1', text: 'SELECT 1;' })) as NyalaQueryEditorInput | undefined;
		store.add(restored!);

		assert.deepStrictEqual({
			text: restored?.getModel().getValue(),
			queryId: restored?.queryId,
			dirty: restored?.isDirty(),
			bound: contextService.get('q_1')?.isBound ?? false,
			execution: contextService.get('q_1')?.canExecute(connections.runtimeState) ?? false,
		}, { text: '', queryId: 'q_1', dirty: false, bound: false, execution: false });
	});

	test('saving a query tab reports that it has no file instead of pretending to succeed', async () => {
		const input = createInput('q_1');
		input.getModel().setValue('SELECT 1;');

		await assert.rejects(input.save(1), /not saved to a file/);
		await assert.rejects(input.saveAs(1), /not saved to a file/);
		assert.strictEqual(input.isDirty(), true);
	});

	test('revert restores the text the tab was opened with and clears the dirty state', async () => {
		const input = createInput('q_1');
		input.setText('SELECT 1;');
		input.getModel().setValue('SELECT 2;');

		const dirtyBefore = input.isDirty();
		await input.revert(1);

		assert.deepStrictEqual({
			dirtyBefore,
			text: input.getModel().getValue(),
			dirtyAfter: input.isDirty(),
		}, { dirtyBefore: true, text: 'SELECT 1;', dirtyAfter: false });
	});

	test('closing a dirty query tab asks before discarding text and never offers a save', async () => {
		const input = createInput('q_1');
		const dialogService = instantiationService.invokeFunction(accessor => accessor.get(IDialogService)) as TestDialogService;
		const closeHandler = input.closeHandler!;

		const cleanPrompt = closeHandler.showConfirm();
		input.getModel().setValue('SELECT 1;');
		const dirtyPrompt = closeHandler.showConfirm();

		dialogService.setConfirmResult({ confirmed: false, checkboxChecked: false });
		const cancelled = await closeHandler.confirm([{ editor: input, groupId: 1 }]);
		dialogService.setConfirmResult({ confirmed: true, checkboxChecked: false });
		const accepted = await closeHandler.confirm([{ editor: input, groupId: 1 }]);

		assert.deepStrictEqual({
			cleanPrompt,
			dirtyPrompt,
			cancelled,
			accepted,
			capabilities: input.capabilities,
		}, {
			cleanPrompt: false,
			dirtyPrompt: true,
			cancelled: ConfirmResult.CANCEL,
			accepted: ConfirmResult.DONT_SAVE,
			capabilities: EditorInputCapabilities.Scratchpad,
		});
	});

	test('a corrupt serialized tab is refused instead of restoring something unexpected', () => {
		const serializer = new NyalaQueryEditorSerializer();

		assert.deepStrictEqual({
			notJson: serializer.deserialize(instantiationService, '{oops'),
			noId: serializer.deserialize(instantiationService, JSON.stringify({ text: 'SELECT 1;' })),
			badId: serializer.deserialize(instantiationService, JSON.stringify({ queryId: '../../etc/passwd' })),
		}, { notJson: undefined, noId: undefined, badId: undefined });
	});

	test('closing a tab releases its context and its model', () => {
		const input = createInput('q_1');
		const modelService = instantiationService.invokeFunction(accessor => accessor.get(IModelService));
		const model = input.getModel();
		contextService.create('q_1');
		const context = contextService.get('q_1');

		input.dispose();
		let contextDisposed = false;
		context!.onDidChangeBinding(() => { contextDisposed = true; });

		assert.deepStrictEqual({
			contextGone: contextService.get('q_1'),
			modelGone: modelService.getModel(model.uri),
			modelDisposed: model.isDisposed(),
			contextListenerAliveAfterDispose: contextDisposed,
		}, { contextGone: undefined, modelGone: null, modelDisposed: true, contextListenerAliveAfterDispose: false });
	});

	//#endregion
});
