/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import product from '../../../../../platform/product/common/product.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { ChatEntitlementContextKeys, ChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';

suite('Nyala disabled Chat', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps chat hidden when the product disables the default chat agent', () => {
		const productService = new class extends mock<IProductService>() {
			override readonly defaultChatAgent = { ...product.defaultChatAgent, extensionId: '', chatExtensionId: '' };
		}();
		const contextKeyService = store.add(new MockContextKeyService());
		const service = store.add(new ChatEntitlementService(
			store.add(new TestInstantiationService()),
			productService,
			new class extends mock<IWorkbenchEnvironmentService>() { },
			contextKeyService,
			new TestConfigurationService(),
			NullTelemetryService,
			new NullLogService(),
			store.add(new TestStorageService()),
		));
		const hiddenAfterStartup = contextKeyService.getContextKeyValue(ChatEntitlementContextKeys.Setup.hidden.key);

		// The account policy gate forces Chat hidden while it settles and then clears that state.
		service.setForceHidden(true);
		service.setForceHidden(false);

		assert.deepStrictEqual({
			context: service.context,
			hiddenAfterStartup,
			hiddenAfterGateCleared: contextKeyService.getContextKeyValue(ChatEntitlementContextKeys.Setup.hidden.key),
		}, {
			context: undefined,
			hiddenAfterStartup: true,
			hiddenAfterGateCleared: true,
		});
	});
});
