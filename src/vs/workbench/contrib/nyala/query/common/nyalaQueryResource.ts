/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The identity of a Nyala query tab (N-202), kept in its own module so the document, the input,
// the pane, the serializer and the tests all share one definition and no import cycle.

import { URI } from '../../../../../base/common/uri.js';

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
