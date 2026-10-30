/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const packageJson = readJson('package.json');
const productJson = readJson('product.json');
const upstreamBase = readJson('nyala/upstream-base.json');
const nodeVersion = readFileSync('.nvmrc', 'utf8').trim();
const defaultChatAgent = productJson.defaultChatAgent;

assert.equal(packageJson.version, '0.0.1-dev.0', 'package.json version must remain 0.0.1-dev.0');
assert.equal(productJson.nameShort, 'Nyala Studio');
assert.equal(productJson.applicationName, 'nyala-studio');
assert.equal(productJson.dataFolderName, '.nyala-studio');
assert.equal(productJson.urlProtocol, 'nyala');
assert.ok(defaultChatAgent, 'defaultChatAgent must define the disabled product boundary');
assert.equal(defaultChatAgent.extensionId, '', 'disabled Chat must not name an installable extension');
assert.equal(defaultChatAgent.chatExtensionId, '', 'disabled Chat must not name an installable chat extension');
assert.equal(defaultChatAgent.providerExtensionId, '', 'disabled Chat must not name a provider extension');
for (const [provider, config] of Object.entries(defaultChatAgent.provider)) {
	assert.equal(config.id, '', `disabled Chat provider ${provider} must not enable authentication`);
	assert.equal(config.name, '', `disabled Chat provider ${provider} must not expose a sign-in label`);
}
for (const field of [
	'documentationUrl',
	'termsStatementUrl',
	'privacyStatementUrl',
	'entitlementUrl',
	'entitlementSignupLimitedUrl',
	'tokenEntitlementUrl',
	'mcpRegistryDataUrl',
	'mcpConnectorsUrl',
	'managedSettingsUrl'
]) {
	assert.equal(defaultChatAgent[field], '', `disabled Chat field ${field} must be empty`);
}
assert.equal(productJson.extensionApiVersion, upstreamBase.tag, 'extensionApiVersion must equal the Code OSS baseline tag in nyala/upstream-base.json');
assert.match(readFileSync('src/vs/platform/product/common/product.ts', 'utf8'), new RegExp(`extensionApiVersion: '${upstreamBase.tag.replace(/\./g, '\\.')}'`), 'the out-of-sources product fallback must report the same extensionApiVersion');

// Blank defaultChatAgent IDs do not stop a bundled chat extension from loading: every folder under
// extensions/ is scanned as a built-in, so each one that contributes a chat participant, chat
// provider or chat session must be listed in skipBuiltinExtensions.
const skipBuiltinExtensions = new Set((productJson.skipBuiltinExtensions ?? []).map(id => id.toLowerCase()));
const testOnlyExtensions = new Set(['vscode-api-tests']);
const chatContributionPoints = ['chatParticipants', 'languageModelChatProviders', 'chatSessions', 'chatAgents'];
for (const entry of readdirSync('extensions', { withFileTypes: true })) {
	const manifestPath = join('extensions', entry.name, 'package.json');
	if (!entry.isDirectory() || testOnlyExtensions.has(entry.name) || !existsSync(manifestPath)) {
		continue;
	}
	const manifest = readJson(manifestPath);
	const points = chatContributionPoints.filter(point => manifest.contributes?.[point]);
	if (points.length) {
		const id = `${manifest.publisher}.${manifest.name}`;
		assert.ok(skipBuiltinExtensions.has(id.toLowerCase()), `built-in ${id} contributes ${points.join(', ')} and must be listed in product.json skipBuiltinExtensions`);
	}
}
// The extensions/ scan above cannot see extensions that a packaged build resolves from
// product.json builtInExtensions. Apply the same chat restriction to any entry that maps to a
// folder in this repository, and refuse chat-related entries outright.
for (const entry of productJson.builtInExtensions ?? []) {
	const name = String(entry?.name ?? '');
	if (!name) {
		continue;
	}
	const folder = name.includes('.') ? name.slice(name.indexOf('.') + 1) : name;
	const manifestPath = join('extensions', folder, 'package.json');
	const manifest = existsSync(manifestPath) ? readJson(manifestPath) : undefined;
	if (manifest) {
		const id = `${manifest.publisher}.${manifest.name}`;
		const points = chatContributionPoints.filter(point => manifest.contributes?.[point]);
		if (points.length) {
			assert.ok(skipBuiltinExtensions.has(id.toLowerCase()), `builtInExtensions entry ${name} resolves to extensions/${folder}, which contributes ${points.join(', ')} and must be listed in product.json skipBuiltinExtensions`);
		}
	}
	assert.ok(!/copilot|chat/i.test(name) || skipBuiltinExtensions.has(name.toLowerCase()), `builtInExtensions entry ${name} looks like a chat extension and must be listed in product.json skipBuiltinExtensions`);
}
assert.ok(skipBuiltinExtensions.has('github.copilot-chat'), 'product.json skipBuiltinExtensions must list GitHub.copilot-chat');

assert.match(upstreamBase.sha, /^[a-f0-9]{40}$/, 'upstream baseline SHA must be complete');
assert.equal(upstreamBase.packageManager, 'npm');
assert.equal(upstreamBase.node, nodeVersion, 'upstream baseline Node version must match .nvmrc');

console.log('Nyala product baseline is valid.');
