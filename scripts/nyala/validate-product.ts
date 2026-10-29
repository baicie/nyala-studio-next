/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
assert.match(upstreamBase.sha, /^[a-f0-9]{40}$/, 'upstream baseline SHA must be complete');
assert.equal(upstreamBase.packageManager, 'npm');
assert.equal(upstreamBase.node, nodeVersion, 'upstream baseline Node version must match .nvmrc');

console.log('Nyala product baseline is valid.');
