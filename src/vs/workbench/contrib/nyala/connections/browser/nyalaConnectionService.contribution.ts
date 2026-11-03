/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Registers the renderer implementation of `INyalaConnectionService` (N-201). The service is
// instantiated lazily, on the first view that asks for it, and lives as long as the window.

import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { INyalaConnectionService, NyalaConnectionService } from '../common/nyalaConnectionService.js';
import { INyalaRuntimeBridge } from '../common/nyalaConnectionService.js';
import { NyalaRuntimeBridge } from './nyalaRuntimeBridge.js';

export class BrowserNyalaConnectionService extends NyalaConnectionService {
	constructor(
		@INyalaRuntimeBridge bridge: INyalaRuntimeBridge,
		@ILogService logService: ILogService,
		@IStorageService storageService: IStorageService,
	) {
		super(bridge, logService, storageService);
		// The profiles this window saved earlier come back; their sessions do not.
		void this.restoreProfiles();
	}
}

registerSingleton(INyalaRuntimeBridge, NyalaRuntimeBridge, InstantiationType.Delayed);
registerSingleton(INyalaConnectionService, BrowserNyalaConnectionService, InstantiationType.Delayed);
