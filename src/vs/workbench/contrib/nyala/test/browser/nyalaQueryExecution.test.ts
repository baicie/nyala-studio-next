/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// N-203 commands and keybindings. The command tests drive the real action handlers against a real
// pane and a fake bridge, so the SQL that reaches the runtime is exactly what the user selected or
// what sits under the cursor. The keybinding test reads the workbench registry: the rule must be
// scoped to query tabs and outrank Monaco's insert-line action, or Ctrl+Enter would type instead of
// run.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { decodeKeybinding } from '../../../../../base/common/keybindings.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IEditorOptions as ICodeEditorOptions } from '../../../../../editor/common/config/editorOptions.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { KeybindingWeight, KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { INyalaRuntimeCallResult, INyalaRuntimeState, NyalaRuntimeCommand } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeIpc.js';
import { workbenchInstantiationService, ITestInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IVisibleEditorPane } from '../../../../common/editor.js';
import { TestCodeEditor } from '../../../../../editor/test/browser/testCodeEditor.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { INyalaConnectionService, INyalaConnectionState, INyalaRuntimeBridge, INyalaCatalog, INyalaConnectionHandle } from '../../connections/common/nyalaConnectionService.js';
import { INyalaQueryContextService } from '../../query/common/nyalaQueryContext.js';
import { NyalaQueryContextService } from '../../query/common/nyalaQueryContextService.js';
import { NyalaQueryDocumentService } from '../../query/common/nyalaQueryDocumentService.js';
import { INyalaQueryDocumentService } from '../../query/common/nyalaQueryDocumentService.js';
import { NyalaQueryEditorInput } from '../../query/common/nyalaQueryEditorInput.js';
import { NyalaQueryEditorPane } from '../../query/browser/nyalaQueryEditorPane.js';
import { NyalaQueryExecutionService, INyalaQueryExecutionService } from '../../query/common/nyalaQueryExecutionService.js';
import {
	NYALA_EXECUTE_COMMAND_ID,
	NYALA_EXECUTE_SCRIPT_COMMAND_ID,
	NYALA_EXECUTE_SELECTION_COMMAND_ID,
} from '../../query/browser/nyalaQueryExecution.contribution.js';
import '../../query/browser/nyalaQuery.contribution.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';

class TestNyalaQueryEditorPane extends NyalaQueryEditorPane {
	protected override createEditorControl(parent: HTMLElement, configuration: ICodeEditorOptions): void {
		this.editorControl = this._register(this.instantiationService.createInstance(TestCodeEditor, parent, configuration, { contributions: [] }));
	}
}

class FakeBridge implements INyalaRuntimeBridge {
	declare readonly _serviceBrand: undefined;
	readonly requests: Array<{ command: NyalaRuntimeCommand; params: any; answer: DeferredPromise<INyalaRuntimeCallResult<any>> }> = [];
	readonly onDidChangeState = Event.None as Event<INyalaRuntimeState>;
	readonly onDidChangeQueryState = Event.None;

	async getState(): Promise<INyalaRuntimeState> {
		return { generation: 1, status: 'ready' };
	}

	call<T>(command: NyalaRuntimeCommand, params: object): Promise<INyalaRuntimeCallResult<T>> {
		const answer = new DeferredPromise<INyalaRuntimeCallResult<any>>();
		this.requests.push({ command, params, answer });
		return answer.p as Promise<INyalaRuntimeCallResult<T>>;
	}
}

class FakeConnectionService implements INyalaConnectionService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeConnections = Event.None;
	readonly onDidChangeRuntime = Event.None;
	readonly runtimeState: INyalaRuntimeState = { generation: 1, status: 'ready' };
	rows: INyalaConnectionState[] = [];

	get connections(): readonly INyalaConnectionState[] {
		return this.rows;
	}
	async addProfile(): Promise<string> { throw new Error('unused'); }
	async restoreProfiles(): Promise<void> { }
	async refreshRuntime(): Promise<INyalaRuntimeState> { return this.runtimeState; }
	async connect(): Promise<void> { }
	async disconnect(): Promise<void> { }
	async refresh(): Promise<void> { }
	catalog(): INyalaCatalog | undefined { return undefined; }
	async listObjects(): Promise<never> { throw new Error('unused'); }
	async describe(): Promise<never> { throw new Error('unused'); }
}

function connectedRow(profileId: string, sessionId: string): INyalaConnectionState {
	const handle: INyalaConnectionHandle = { profileId, sessionId, sessionGeneration: 1, runtimeGeneration: 1 };
	return { profile: { profileId, displayName: `${profileId}.sqlite`, target: { driver: 'sqlite', path: `/tmp/${profileId}.sqlite`, readOnly: true } }, status: 'connected', handle };
}

suite('Nyala query execution commands', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let bridge: FakeBridge;
	let connections: FakeConnectionService;
	let contextService: NyalaQueryContextService;
	let documentService: NyalaQueryDocumentService;
	let executionService: NyalaQueryExecutionService;
	let instantiationService: ITestInstantiationService;
	let notifications: string[];

	setup(() => {
		bridge = new FakeBridge();
		connections = new FakeConnectionService();
		contextService = store.add(new NyalaQueryContextService(connections, new NullLogService()));
		instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(INyalaConnectionService, connections);
		instantiationService.stub(INyalaQueryContextService, contextService);
		instantiationService.stub(INyalaRuntimeBridge, bridge);
		const modelService = instantiationService.invokeFunction(accessor => accessor.get(IModelService));
		const languageService = instantiationService.invokeFunction(accessor => accessor.get(ILanguageService));
		store.add(languageService.registerLanguage({ id: 'sql' }));
		documentService = store.add(new NyalaQueryDocumentService(modelService, languageService, contextService));
		instantiationService.stub(INyalaQueryDocumentService, documentService);
		instantiationService.stub(IDialogService, new TestDialogService());
		executionService = store.add(new NyalaQueryExecutionService(bridge, contextService, connections, new NullLogService()));
		instantiationService.stub(INyalaQueryExecutionService, executionService);
		notifications = [];
		instantiationService.stub(INotificationService, new class extends mock<INotificationService>() {
			override info(message: unknown): void { notifications.push(String(message)); }
			override warn(message: unknown): void { notifications.push(String(message)); }
		}());
	});

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

	async function openTab(queryId: string, text: string, bind = true): Promise<{ input: NyalaQueryEditorInput; pane: TestNyalaQueryEditorPane }> {
		if (bind) {
			connections.rows = [connectedRow('p_a', 's_a')];
		}
		const input = store.add(instantiationService.createInstance(NyalaQueryEditorInput, queryId));
		if (bind) {
			const result = await contextService.bind(input.getContext(), 'p_a');
			assert.strictEqual(result.ok, true);
		}
		input.getModel().setValue(text);
		const { pane } = createPane();
		await pane.setInput(input, undefined, {}, CancellationToken.None);
		instantiationService.stub(IEditorService, new class extends mock<IEditorService>() {
			override readonly activeEditor = input;
			override get activeEditorPane(): IVisibleEditorPane | undefined { return pane as unknown as IVisibleEditorPane; }
		}());
		return { input, pane };
	}

	/**
	 * Starts a command without waiting for it. The function is deliberately not `async`: an async
	 * function returning a promise would adopt it, and the test would wait for the very request it
	 * still has to answer.
	 */
	function startCommand(commandId: string): Promise<void> {
		const handler = CommandsRegistry.getCommand(commandId)?.handler;
		assert.ok(handler, commandId);
		return instantiationService.invokeFunction(accessor => handler!(accessor)) as unknown as Promise<void>;
	}

	/** Runs a command that is expected to finish without a runtime request. */
	async function runCommand(commandId: string): Promise<void> {
		await startCommand(commandId);
	}

	function executeRequests(): Array<{ sql: string; mode: string }> {
		return bridge.requests.filter(request => request.command === NyalaRuntimeCommand.QueryExecute).map(request => request.params as any);
	}

	function answerExecute(executionId = 'ex_1'): void {
		const request = bridge.requests.filter(entry => entry.command === NyalaRuntimeCommand.QueryExecute).pop();
		assert.ok(request, 'an execute request was registered');
		request!.answer.complete({ ok: true, runtimeGeneration: 1, result: { executionId, state: 'queued', sequence: 1 } });
	}

	test('Ctrl/Cmd+Enter runs the statement under the cursor, not the whole document', async () => {
		const { pane } = await openTab('q_1', 'SELECT 1;\nSELECT 2;');
		pane.getControl()!.setPosition({ lineNumber: 2, column: 1 });

		const running = startCommand(NYALA_EXECUTE_COMMAND_ID);
		answerExecute();
		await running;

		assert.deepStrictEqual(executeRequests(), [{ sessionId: 's_a', sessionGeneration: 1, sql: 'SELECT 2;', mode: 'statement', timeoutMs: 30000, maxInitialRows: 200 }]);
	});

	test('with a selection, Ctrl/Cmd+Enter runs the selection in selection mode', async () => {
		const { pane } = await openTab('q_1', 'SELECT 1;\nSELECT 2;');
		pane.getControl()!.setSelection(new Selection(1, 1, 1, 10));

		const running = startCommand(NYALA_EXECUTE_COMMAND_ID);
		answerExecute();
		await running;

		assert.deepStrictEqual(executeRequests().map(request => ({ sql: request.sql, mode: request.mode })), [{ sql: 'SELECT 1;', mode: 'selection' }]);
	});

	test('a selection with more than one statement is refused with a pointer to Execute Script', async () => {
		const { pane } = await openTab('q_1', 'SELECT 1;\nSELECT 2;');
		pane.getControl()!.setSelection(new Selection(1, 1, 2, 10));

		await runCommand(NYALA_EXECUTE_COMMAND_ID);
		await runCommand(NYALA_EXECUTE_SELECTION_COMMAND_ID);

		assert.deepStrictEqual({ requests: executeRequests().length, messages: notifications.map(message => /Execute Script/.test(message)) }, {
			requests: 0,
			messages: [true, true],
		});
	});

	test('Shift+Ctrl/Cmd+Enter sends the whole document as a script', async () => {
		const { pane } = await openTab('q_1', 'SELECT 1;\nSELECT 2;');
		pane.getControl()!.setPosition({ lineNumber: 1, column: 1 });

		const running = startCommand(NYALA_EXECUTE_SCRIPT_COMMAND_ID);
		answerExecute();
		await running;

		assert.deepStrictEqual(executeRequests().map(request => ({ sql: request.sql, mode: request.mode })), [{ sql: 'SELECT 1;\nSELECT 2;', mode: 'script' }]);
	});

	test('an unbound tab reports a readable error and never reaches the runtime', async () => {
		await openTab('q_unbound', 'SELECT 1;', false);

		await runCommand(NYALA_EXECUTE_COMMAND_ID);

		assert.deepStrictEqual({ requests: executeRequests().length, messages: notifications.length }, { requests: 0, messages: 1 });
	});

	test('a second run of the same query is refused with a readable message', async () => {
		const { pane } = await openTab('q_1', 'SELECT 1;');
		pane.getControl()!.setPosition({ lineNumber: 1, column: 1 });
		const first = startCommand(NYALA_EXECUTE_COMMAND_ID);
		answerExecute();
		await first;

		await runCommand(NYALA_EXECUTE_COMMAND_ID);

		assert.deepStrictEqual({ requests: executeRequests().length, messages: notifications.length }, { requests: 1, messages: 1 });
	});

	test('the execute command is bound to Ctrl/Cmd+Enter only in query tabs and outranks the editor action', () => {
		const rules = KeybindingsRegistry.getDefaultKeybindingsForOS(OperatingSystem.Linux).filter(rule => rule.command === NYALA_EXECUTE_COMMAND_ID);
		const rule = rules.find(entry => entry.keybinding?.equals(decodeKeybinding(KeyMod.CtrlCmd | KeyCode.Enter, OperatingSystem.Linux)!));

		assert.ok(rule, 'the execute command has a default Ctrl+Enter binding');
		assert.strictEqual(rule!.weight1, KeybindingWeight.WorkbenchContrib);
		assert.deepStrictEqual(rule!.when?.serialize(), "editorTextFocus && resourceScheme == 'nyala-query'");
		// Monaco's insert-line action runs at EditorContrib (100); a lower weight here would make
		// Ctrl+Enter insert a line instead of executing.
		assert.ok(rule!.weight1 > KeybindingWeight.EditorContrib);
	});

	test('the script command uses Shift+Ctrl/Cmd+Enter and the selection command has no default key', () => {
		const script = KeybindingsRegistry.getDefaultKeybindingsForOS(OperatingSystem.Linux).find(rule => rule.command === NYALA_EXECUTE_SCRIPT_COMMAND_ID);
		const selection = KeybindingsRegistry.getDefaultKeybindingsForOS(OperatingSystem.Linux).filter(rule => rule.command === NYALA_EXECUTE_SELECTION_COMMAND_ID);

		assert.ok(script?.keybinding?.equals(decodeKeybinding(KeyMod.Shift | KeyMod.CtrlCmd | KeyCode.Enter, OperatingSystem.Linux)!));
		assert.strictEqual(selection.length, 0);
	});
});
