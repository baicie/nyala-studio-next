/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The three execution commands of N-203. They resolve the SQL, never the target: the target comes
// from the execution service's snapshot, which asks the pane's context whether it can run.
//
// The commands do not log SQL text, connection paths or parameters; a failure notification names
// the error the runtime returned and nothing else (ADR 0008 section 7).

import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { NyalaQueryEditorInput } from '../common/nyalaQueryEditorInput.js';
import { INyalaQueryExecutionService, NyalaQueryExecutionService } from '../common/nyalaQueryExecutionService.js';
import { countStatements, statementAt } from '../common/nyalaSqlStatements.js';
import { NYALA_QUERY_SCHEME } from '../common/nyalaQueryResource.js';
import { NyalaQueryEditorPane } from './nyalaQueryEditorPane.js';

export const NYALA_EXECUTE_COMMAND_ID = 'nyala.query.execute';
export const NYALA_EXECUTE_SELECTION_COMMAND_ID = 'nyala.query.executeSelection';
export const NYALA_EXECUTE_SCRIPT_COMMAND_ID = 'nyala.query.executeScript';

registerSingleton(INyalaQueryExecutionService, NyalaQueryExecutionService, InstantiationType.Delayed);

/** Only a focused Nyala query tab may run; the workbench keybinding uses the same condition. */
const QUERY_EDITOR_WHEN = ContextKeyExpr.and(
	ContextKeyExpr.equals('resourceScheme', NYALA_QUERY_SCHEME),
	ContextKeyExpr.has('editorTextFocus'),
);

type ExecutionCommand = 'execute' | 'selection' | 'script';

/**
 * Resolves what to run for one command. `undefined` means the command refused, and the notification
 * already explained why; the caller must not send anything.
 */
function resolveSql(pane: NyalaQueryEditorPane, command: ExecutionCommand, notify: (message: string) => void): { sql: string; mode: 'statement' | 'selection' | 'script' } | undefined {
	const selection = pane.getSelectionText();

	if (command === 'script') {
		const sql = pane.getText();
		if (sql.trim().length === 0) {
			notify(localize('nyala.query.execute.emptyScript', 'This query tab has no SQL to run.'));
			return undefined;
		}
		return { sql, mode: 'script' };
	}

	if (command === 'selection' || (command === 'execute' && selection.trim().length > 0)) {
		if (selection.trim().length === 0) {
			notify(localize('nyala.query.execute.emptySelection', 'Select the SQL you want to run first.'));
			return undefined;
		}
		const count = countStatements(selection);
		if (count === undefined) {
			notify(localize('nyala.query.execute.unreliableSelection', 'This selection cannot be split into statements reliably. Select one statement, or use Nyala: Execute Script.'));
			return undefined;
		}
		if (count === 0) {
			notify(localize('nyala.query.execute.noStatementSelection', 'The selection contains no SQL statement.'));
			return undefined;
		}
		if (count > 1) {
			// `selection` mode runs exactly one statement in v1. Running only the first would be a
			// silent partial execution of a write script, which is the failure this guard prevents.
			notify(localize('nyala.query.execute.multiSelection', 'The selection contains more than one statement. Use Nyala: Execute Script to run all of them.'));
			return undefined;
		}
		return { sql: selection, mode: 'selection' };
	}

	const statement = statementAt(pane.getText(), pane.getCursorOffset());
	if (!statement.ok) {
		notify(localize('nyala.query.execute.unreliable', 'This text cannot be split into statements reliably ({0}). Select one statement, or use Nyala: Execute Script.', statement.reason));
		return undefined;
	}
	if (!statement.statement) {
		notify(localize('nyala.query.execute.noStatement', 'There is no SQL statement at the cursor.'));
		return undefined;
	}
	return { sql: statement.statement.text, mode: 'statement' };
}

async function runExecutionCommand(accessor: ServicesAccessor, command: ExecutionCommand): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const notifications = accessor.get(INotificationService);
	const executionService = accessor.get(INyalaQueryExecutionService);

	const input = editorService.activeEditor;
	const pane = editorService.activeEditorPane;
	if (!(input instanceof NyalaQueryEditorInput) || !(pane instanceof NyalaQueryEditorPane)) {
		// The keybinding's `when` only controls availability; the handler checks again, so a command
		// invoked from the palette cannot act on an unrelated editor.
		notifications.info(localize('nyala.query.execute.notActive', 'Open a Nyala query tab first.'));
		return;
	}

	const resolved = resolveSql(pane, command, message => notifications.warn(message));
	if (!resolved) {
		return;
	}

	const result = await executionService.execute(input.queryId, resolved.sql, resolved.mode);
	if (!result.ok) {
		notifications.warn(result.message);
	}
}

class NyalaExecuteAction extends Action2 {

	constructor() {
		super({
			id: NYALA_EXECUTE_COMMAND_ID,
			title: localize2('nyala.query.execute', 'Nyala: Execute'),
			f1: true,
			category: localize2('nyala.category', 'Nyala'),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.Enter,
				weight: KeybindingWeight.WorkbenchContrib,
				when: QUERY_EDITOR_WHEN,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await runExecutionCommand(accessor, 'execute');
	}
}

class NyalaExecuteSelectionAction extends Action2 {

	constructor() {
		super({
			id: NYALA_EXECUTE_SELECTION_COMMAND_ID,
			title: localize2('nyala.query.executeSelection', 'Nyala: Execute Selection'),
			f1: true,
			category: localize2('nyala.category', 'Nyala'),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await runExecutionCommand(accessor, 'selection');
	}
}

class NyalaExecuteScriptAction extends Action2 {

	constructor() {
		super({
			id: NYALA_EXECUTE_SCRIPT_COMMAND_ID,
			title: localize2('nyala.query.executeScript', 'Nyala: Execute Script'),
			f1: true,
			category: localize2('nyala.category', 'Nyala'),
			keybinding: {
				primary: KeyMod.Shift | KeyMod.CtrlCmd | KeyCode.Enter,
				weight: KeybindingWeight.WorkbenchContrib,
				when: QUERY_EDITOR_WHEN,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await runExecutionCommand(accessor, 'script');
	}
}

registerAction2(NyalaExecuteAction);
registerAction2(NyalaExecuteSelectionAction);
registerAction2(NyalaExecuteScriptAction);
