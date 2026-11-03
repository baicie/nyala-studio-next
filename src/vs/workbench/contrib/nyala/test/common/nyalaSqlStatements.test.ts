/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// N-203 statement splitting. Each test names one guarantee the execute command relies on: a
// semicolon inside a literal, an identifier, a comment or a trigger body is not a separator, and a
// text the scanner cannot prove it understood is refused rather than split on a guess.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { countStatements, splitSqlStatements, statementAt } from '../../query/common/nyalaSqlStatements.js';

function texts(sql: string): readonly string[] {
	const result = splitSqlStatements(sql);
	assert.strictEqual(result.ok, true, result.ok ? '' : result.reason);
	return result.ok ? result.statements.map(statement => statement.text) : [];
}

suite('Nyala SQL statements', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a plain script splits on top-level semicolons and drops the empty tail', () => {
		assert.deepStrictEqual(texts('SELECT 1;\nSELECT 2;'), ['SELECT 1;', 'SELECT 2;']);
		assert.deepStrictEqual(texts('SELECT 1'), ['SELECT 1']);
		assert.deepStrictEqual(texts(';;SELECT 1;;'), ['SELECT 1;']);
		assert.deepStrictEqual(texts('   '), []);
		assert.deepStrictEqual(texts(''), []);
	});

	test('a semicolon inside a string literal does not split the statement', () => {
		assert.deepStrictEqual(texts(`SELECT 'a;b';\nSELECT 2;`), [`SELECT 'a;b';`, 'SELECT 2;']);
		assert.deepStrictEqual(texts(`SELECT 'it''s; fine'; SELECT 2;`), [`SELECT 'it''s; fine';`, 'SELECT 2;']);
		// SQLite has no backslash escape in a string literal, so a backslash before the closing
		// quote is an ordinary character and the literal ends there.
		assert.deepStrictEqual(texts(`SELECT 'a\\'; SELECT 2;`), [`SELECT 'a\\';`, 'SELECT 2;']);
	});

	test('a semicolon inside a quoted or bracketed identifier does not split the statement', () => {
		assert.deepStrictEqual(texts('SELECT "a;b" FROM t; SELECT 2;'), ['SELECT "a;b" FROM t;', 'SELECT 2;']);
		assert.deepStrictEqual(texts('SELECT `a;b` FROM t; SELECT 2;'), ['SELECT `a;b` FROM t;', 'SELECT 2;']);
		assert.deepStrictEqual(texts('SELECT [a;b] FROM t; SELECT 2;'), ['SELECT [a;b] FROM t;', 'SELECT 2;']);
		assert.deepStrictEqual(texts('SELECT """" FROM t;'), ['SELECT """" FROM t;']);
	});

	test('a semicolon inside a comment does not split the statement', () => {
		assert.deepStrictEqual(texts('SELECT 1 -- a; b\n; SELECT 2;'), ['SELECT 1 -- a; b\n;', 'SELECT 2;']);
		assert.deepStrictEqual(texts('SELECT 1 /* a; b */; SELECT 2;'), ['SELECT 1 /* a; b */;', 'SELECT 2;']);
		assert.deepStrictEqual(texts('/* only a comment */'), []);
		assert.deepStrictEqual(texts('-- only a comment\n'), []);
	});

	test('a trigger body keeps its internal semicolons and ends at the outer one', () => {
		const sql = [
			'CREATE TRIGGER trg AFTER INSERT ON t',
			'BEGIN',
			'  UPDATE t SET n = n + 1;',
			'  INSERT INTO log VALUES (new.id);',
			'END;',
			'SELECT 2;',
		].join('\n');

		const result = splitSqlStatements(sql);

		assert.deepStrictEqual(result.ok && result.statements.map(statement => statement.text.trim().split('\n')[0]), [
			'CREATE TRIGGER trg AFTER INSERT ON t',
			'SELECT 2;',
		]);
		assert.deepStrictEqual(countStatements(sql), 2);
	});

	test('a CASE expression inside a trigger does not close the body early', () => {
		const sql = [
			'CREATE TRIGGER trg AFTER UPDATE ON t',
			'BEGIN',
			'  UPDATE t SET n = CASE WHEN n > 1 THEN 1 ELSE 0 END;',
			'  DELETE FROM log;',
			'END;',
		].join('\n');

		const result = splitSqlStatements(sql);

		assert.deepStrictEqual(result.ok && result.statements.map(statement => statement.text.endsWith(';')), [true]);
		assert.deepStrictEqual(result.ok && result.statements.length, 1);
	});

	test('a CASE expression outside a trigger does not swallow the next statement', () => {
		assert.deepStrictEqual(
			texts('SELECT CASE WHEN a THEN 1 ELSE 0 END; SELECT 2;'),
			['SELECT CASE WHEN a THEN 1 ELSE 0 END;', 'SELECT 2;'],
		);
	});

	test('a trigger body containing a string with BEGIN or END still splits once', () => {
		const sql = "CREATE TRIGGER t1 AFTER INSERT ON t BEGIN INSERT INTO log VALUES ('BEGIN; END'); END; SELECT 1;";
		assert.deepStrictEqual(texts(sql).length, 2);
	});

	test('text the scanner cannot prove it understood is refused, never split on a guess', () => {
		for (const sql of [
			"SELECT 'unterminated;",
			'SELECT "unterminated;',
			'SELECT [unterminated;',
			'SELECT `unterminated;',
			'SELECT 1 /* unterminated;',
			'CREATE TRIGGER t1 AFTER INSERT ON t BEGIN INSERT INTO log VALUES (1);',
			'SELECT CASE WHEN a THEN 1;',
		]) {
			const result = splitSqlStatements(sql);
			assert.deepStrictEqual(result.ok, false, sql);
			assert.ok(!result.ok && result.reason.length > 0, sql);
			assert.strictEqual(countStatements(sql), undefined, sql);
		}
	});

	test('CRLF text splits the same way, and a line comment ends at the CR', () => {
		assert.deepStrictEqual(texts('SELECT 1; -- note\r\nSELECT 2;\r\n'), ['SELECT 1;', '-- note\r\nSELECT 2;']);
	});

	test('statementAt selects the statement under the cursor', () => {
		const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3;';

		const second = statementAt(sql, sql.indexOf('2'));

		assert.deepStrictEqual(second.ok && second.statement?.text, 'SELECT 2;');
	});

	test('a cursor sitting on a semicolon belongs to the statement it ends', () => {
		const sql = 'SELECT 1; SELECT 2;';
		const onFirstSemicolon = sql.indexOf(';');

		const result = statementAt(sql, onFirstSemicolon);

		assert.deepStrictEqual(result.ok && result.statement?.text, 'SELECT 1;');
	});

	test('a cursor between statements takes the previous one, as typing a semicolon implies', () => {
		const sql = 'SELECT 1;\n\nSELECT 2;';

		const result = statementAt(sql, sql.indexOf('S', sql.indexOf('S') + 1) - 1);

		assert.deepStrictEqual(result.ok && result.statement?.text, 'SELECT 1;');
	});

	test('a cursor before the first statement takes that statement', () => {
		const result = statementAt('   \nSELECT 1;', 0);
		assert.deepStrictEqual(result.ok && result.statement?.text, 'SELECT 1;');
	});

	test('an empty or comment-only document has no statement to run', () => {
		assert.deepStrictEqual(statementAt('', 0), { ok: true, statement: undefined });
		assert.deepStrictEqual(statementAt('  -- nothing here\n', 3), { ok: true, statement: undefined });
	});

	test('statementAt refuses exactly where splitting refuses', () => {
		const result = statementAt("SELECT 'unterminated;", 0);
		assert.deepStrictEqual(result.ok, false);
	});

	test('offsets point at the statement text so the caller can highlight it', () => {
		const sql = '  SELECT 1;\n  SELECT 2;';
		const result = splitSqlStatements(sql);

		assert.strictEqual(result.ok, true);
		if (!result.ok) {
			return;
		}
		const [first, second] = result.statements;
		assert.deepStrictEqual({
			first: sql.slice(first.start, first.end),
			second: sql.slice(second.start, second.end),
			firstText: first.text,
			secondText: second.text,
		}, {
			first: 'SELECT 1;',
			second: 'SELECT 2;',
			firstText: 'SELECT 1;',
			secondText: 'SELECT 2;',
		});
	});
});
