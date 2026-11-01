/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { isWeb } from '../../../../../base/common/platform.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import '../../../../../platform/agentHost/browser/agentHostEnablementService.js';
import { IAgentHostEnablementService } from '../../../../../platform/agentHost/common/agentHostEnablementService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IManagedSettingsService, NullManagedSettingsService } from '../../../../../platform/policy/common/copilotManagedSettings.js';
import product from '../../../../../platform/product/common/product.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';

suite('Nyala Agent Host enablement', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** Instantiates the Agent Host enablement the desktop workbench registers, for a product with the given chat agent ids. */
	function enabledFor(extensionId: string, chatExtensionId: string): boolean {
		// The web workbench registers another implementation under the same id; a full suite run loads both.
		const descriptor = getSingletonServiceDescriptors().find(([id, candidate]) => id === IAgentHostEnablementService && candidate.ctor.name === 'BrowserAgentHostEnablementService')?.[1];
		assert.ok(descriptor);
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.set(IConfigurationService, new TestConfigurationService());
		instantiationService.set(IContextKeyService, store.add(new MockContextKeyService()));
		instantiationService.set(IManagedSettingsService, new NullManagedSettingsService());
		instantiationService.set(IProductService, new class extends mock<IProductService>() {
			override readonly defaultChatAgent = { ...product.defaultChatAgent, extensionId, chatExtensionId };
		}());
		const service: IAgentHostEnablementService & IDisposable = store.add(instantiationService.createInstance(descriptor));
		return service.enabled.get();
	}

	test('keeps the Agent Host off when the product disables the default chat agent', () => {
		assert.deepStrictEqual({
			disabledChat: enabledFor('', ''),
			configuredChat: enabledFor('publisher.agent', 'publisher.agent-chat'),
		}, {
			disabledChat: false,
			// The browser test runner is a web context, where this service is off for every product.
			configuredChat: !isWeb,
		});
	});
});
