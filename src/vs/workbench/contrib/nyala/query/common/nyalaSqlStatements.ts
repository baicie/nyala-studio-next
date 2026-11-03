/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Splits a SQLite script into statements for the query editor (N-203). The runtime has its own
// parser, but the workbench has to know *which* statement the cursor is in before it can send one,
// and it must never guess: a wrong split either runs half a trigger or refuses to run anything.
//
// The scanner is deliberately conservative. It understands the lexical layer SQLite accepts --
// single-quoted strings with '' escapes, double-quoted and bracketed and backtick identifiers,
// `--` and block comments -- and the one structural rule that matters for splitting: the body of a
// `CREATE TRIGGER ... BEGIN ... END` may contain semicolons that do not end the statement.
//
// Anything it cannot prove it ended (an unterminated string, comment or trigger body) is reported
// as a failure instead of a list of statements, so the caller can refuse rather than execute a
// fragment of the user's SQL.

export interface INyalaSqlStatement {
	/** Offset of the first character of the statement, including leading whitespace and comments. */
	readonly start: number;
	/** Offset just past the last non-whitespace character. */
	readonly end: number;
	/** The statement text with surrounding whitespace trimmed; comments inside it are kept. */
	readonly text: string;
}

export type NyalaSqlSplitResult =
	| { readonly ok: true; readonly statements: readonly INyalaSqlStatement[] }
	| { readonly ok: false; readonly reason: string };

/**
 * Splits `sql` on top-level semicolons. Empty fragments (whitespace, comments, consecutive `;`)
 * are dropped: they are not statements, and the runtime refuses a text with no statement anyway.
 */
export function splitSqlStatements(sql: string): NyalaSqlSplitResult {
	const statements: INyalaSqlStatement[] = [];
	const length = sql.length;
	let start = 0;
	let index = 0;
	/** Nesting of `BEGIN ... END` bodies opened by `CREATE TRIGGER`; 0 means top level. */
	let triggerDepth = 0;
	/** Nesting of `CASE ... END`, which uses the same word but does not open a statement body. */
	let caseDepth = 0;
	let triggerSeen = false;

	const push = (from: number, to: number): void => {
		const raw = sql.slice(from, to);
		const trimmed = raw.trim();
		// A fragment with nothing but a terminator (or only comments) is not a statement: the
		// runtime refuses a text with no statement, and a lone `;` is what `;;` leaves behind.
		if (trimmed.length === 0 || trimmed === ';' || isOnlyComments(trimmed.replace(/;$/, ''))) {
			return;
		}
		const leading = raw.length - raw.trimStart().length;
		const trailing = raw.length - raw.trimEnd().length;
		statements.push({ start: from + leading, end: to - trailing, text: trimmed });
	};

	while (index < length) {
		const char = sql[index];

		// Quoted regions: skip the whole literal/identifier so its semicolons are not separators.
		if (char === '\'') {
			const end = skipQuoted(sql, index, '\'');
			if (end === -1) {
				return { ok: false, reason: 'an unterminated string literal was found' };
			}
			index = end;
			continue;
		}
		if (char === '"') {
			const end = skipQuoted(sql, index, '"');
			if (end === -1) {
				return { ok: false, reason: 'an unterminated quoted identifier was found' };
			}
			index = end;
			continue;
		}
		if (char === '`') {
			const end = skipQuoted(sql, index, '`');
			if (end === -1) {
				return { ok: false, reason: 'an unterminated quoted identifier was found' };
			}
			index = end;
			continue;
		}
		if (char === '[') {
			const close = sql.indexOf(']', index + 1);
			if (close === -1) {
				return { ok: false, reason: 'an unterminated bracketed identifier was found' };
			}
			index = close + 1;
			continue;
		}

		// Comments: `--` to end of line, `/* ... */` possibly spanning lines. SQLite does not nest
		// block comments, so the first `*/` closes it.
		if (char === '-' && sql[index + 1] === '-') {
			const newline = sql.indexOf('\n', index + 2);
			index = newline === -1 ? length : newline + 1;
			continue;
		}
		if (char === '/' && sql[index + 1] === '*') {
			const close = sql.indexOf('*/', index + 2);
			if (close === -1) {
				return { ok: false, reason: 'an unterminated block comment was found' };
			}
			index = close + 2;
			continue;
		}

		// Words that change the nesting: CREATE TRIGGER opens a body at its BEGIN, CASE opens a
		// block that also ends in END, and END closes whichever is innermost.
		if (isWordStart(char)) {
			const wordEnd = readWord(sql, index);
			const word = sql.slice(index, wordEnd).toUpperCase();
			if (word === 'TRIGGER') {
				triggerSeen = true;
			} else if (word === 'BEGIN' && triggerSeen && triggerDepth === 0 && caseDepth === 0) {
				triggerDepth = 1;
			} else if (word === 'CASE') {
				caseDepth++;
			} else if (word === 'END') {
				if (caseDepth > 0) {
					caseDepth--;
				} else if (triggerDepth > 0) {
					triggerDepth--;
					// The trigger's own trailing `;` still follows; it is a top-level separator.
				}
			}
			index = wordEnd;
			continue;
		}

		if (char === ';' && triggerDepth === 0 && caseDepth === 0) {
			// The terminator stays with the statement it ends: what the user selected is what runs.
			push(start, index + 1);
			index++;
			start = index;
			triggerSeen = false;
			continue;
		}

		index++;
	}

	if (triggerDepth > 0 || caseDepth > 0) {
		return { ok: false, reason: 'a trigger or CASE block is not closed' };
	}

	push(start, length);
	return { ok: true, statements };
}

/**
 * The statement the cursor is in, or the one just before it when the cursor sits between
 * statements. `undefined` means there is nothing reliable to run there.
 */
export function statementAt(sql: string, offset: number): { readonly ok: true; readonly statement: INyalaSqlStatement | undefined } | { readonly ok: false; readonly reason: string } {
	const split = splitSqlStatements(sql);
	if (!split.ok) {
		return split;
	}
	const statements = split.statements;
	if (statements.length === 0) {
		return { ok: true, statement: undefined };
	}
	const clamped = Math.max(0, Math.min(offset, sql.length));
	// A cursor inside a statement (or right on its terminating semicolon) selects that statement.
	for (const statement of statements) {
		if (clamped >= statement.start && clamped <= statement.end) {
			return { ok: true, statement };
		}
	}
	// A cursor in the gap before a statement is usually at the end of the previous one; taking the
	// previous statement matches what a user expects after typing a semicolon and pressing the key.
	let previous: INyalaSqlStatement | undefined;
	for (const statement of statements) {
		if (statement.end < clamped) {
			previous = statement;
			continue;
		}
		return { ok: true, statement: previous ?? statement };
	}
	return { ok: true, statement: previous };
}

/** How many statements a text holds; `undefined` when it cannot be split reliably. */
export function countStatements(sql: string): number | undefined {
	const split = splitSqlStatements(sql);
	return split.ok ? split.statements.length : undefined;
}

/**
 * Advances past a quoted region that starts at `open`, where `quote` both opens and closes it and
 * a doubled `quote` stands for itself. Returns the offset past the closing character, or -1 when
 * the region never closes.
 */
function skipQuoted(sql: string, open: number, quote: string): number {
	let index = open + 1;
	while (index < sql.length) {
		if (sql[index] === quote) {
			if (sql[index + 1] === quote) {
				index += 2;
				continue;
			}
			return index + 1;
		}
		index++;
	}
	return -1;
}

function isWordStart(char: string | undefined): boolean {
	return !!char && /[A-Za-z_]/.test(char);
}

function readWord(sql: string, start: number): number {
	let index = start;
	while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index])) {
		index++;
	}
	return index;
}

/** Whether a fragment holds only comments, which is not something the runtime can execute. */
function isOnlyComments(text: string): boolean {
	let index = 0;
	while (index < text.length) {
		const char = text[index];
		if (/\s/.test(char)) {
			index++;
			continue;
		}
		if (char === '-' && text[index + 1] === '-') {
			const newline = text.indexOf('\n', index + 2);
			index = newline === -1 ? text.length : newline + 1;
			continue;
		}
		if (char === '/' && text[index + 1] === '*') {
			const close = text.indexOf('*/', index + 2);
			if (close === -1) {
				return true;
			}
			index = close + 2;
			continue;
		}
		return false;
	}
	return true;
}
