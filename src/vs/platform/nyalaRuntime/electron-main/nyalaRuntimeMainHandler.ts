/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../base/common/async.js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { localize } from '../../../nls.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogger } from '../../log/common/log.js';
import { ILoggerMainService } from '../../log/electron-main/loggerService.js';
import { IProductService } from '../../product/common/productService.js';
import { LoadReason } from '../../window/electron-main/window.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';
import { INyalaRuntimeSupervisors, NyalaRuntimeChannel } from './nyalaRuntimeChannel.js';
import { NYALA_RUNTIME_FEATURES } from '../common/nyalaRuntimeIpc.js';
import { createNyalaRuntimeEnvironment, findNyalaRuntimeExecutable, INyalaRuntimeLaunch, stageNyalaRuntimeExecutable } from '../node/nyalaRuntimeProcess.js';
import { NyalaRuntimeSupervisor, NyalaRuntimeWindowSupervisors } from '../node/nyalaRuntimeSupervisor.js';

/**
 * Gives every workbench window its own `nyala-runtime` process (`docs/adr/0004-runtime-supervisor.md`).
 *
 * - First load of a window: launch generation 1 and complete `runtime.hello` / `runtime.health`.
 * - Reload, or a load into another workspace: replace the process with a new generation.
 * - Window closed or destroyed: stop the process (stdin closed, killed after a timeout).
 * - Application shutdown: join the shutdown until every process is gone.
 *
 * It is not owned by `CodeApplication`, which disposes itself as soon as `onWillShutdown` fires and
 * would kill the processes before they can exit in order. It disposes itself once its shutdown join
 * has settled.
 */
export class NyalaRuntimeMainHandler extends Disposable implements INyalaRuntimeSupervisors {

	private readonly logger: ILogger;
	private readonly supervisors: NyalaRuntimeWindowSupervisors;
	/** Staging copies the executable and removes copies of older builds; windows take turns. */
	private readonly staging = new Sequencer();

	constructor(
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@IWindowsMainService windowsMainService: IWindowsMainService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@IProductService private readonly productService: IProductService,
		@ILoggerMainService loggerService: ILoggerMainService,
	) {
		super();

		this.logger = this._register(loggerService.createLogger('nyalaRuntime', { name: localize('nyalaRuntimeLog', "Nyala Runtime") }));
		this.supervisors = this._register(new NyalaRuntimeWindowSupervisors(windowId => this.createSupervisor(windowId), this.logger));

		this._register(lifecycleMainService.onWillLoadWindow(e => {
			this.supervisors.windowWillLoad(e.window.id, e.reason === LoadReason.RELOAD ? 'window-reload' : 'window-load');
		}));
		this._register(lifecycleMainService.onBeforeCloseWindow(window => this.supervisors.windowDidClose(window.id)));
		this._register(windowsMainService.onDidDestroyWindow(window => this.supervisors.windowDidClose(window.id)));
		this._register(lifecycleMainService.onWillShutdown(e => {
			e.join('nyalaRuntime', this.supervisors.shutdown().finally(() => this.dispose()));
		}));
	}

	/** The supervisor of `windowId`, for the renderer bridge. */
	get(windowId: number): NyalaRuntimeSupervisor | undefined {
		return this.supervisors.get(windowId);
	}

	/** The channel the renderer talks to (`nyalaRuntimeChannel.ts`). */
	createChannel(): NyalaRuntimeChannel {
		return NyalaRuntimeChannel.withLogger(this, this.logger);
	}

	private createSupervisor(windowId: number): NyalaRuntimeSupervisor {
		return new NyalaRuntimeSupervisor({
			label: `window ${windowId}`,
			clientBuild: this.productService.version,
			// The handshake happens once per process, so this lists everything the renderer bridge
			// may call; a method whose feature was not negotiated is refused by the runtime.
			supportedFeatures: NYALA_RUNTIME_FEATURES,
			resolveLaunch: () => this.resolveLaunch(),
		}, this.logger);
	}

	private async resolveLaunch(): Promise<INyalaRuntimeLaunch | undefined> {
		const found = await findNyalaRuntimeExecutable(this.environmentMainService.appRoot, this.environmentMainService.isBuilt, process.env, process.platform);
		if (!found) {
			return undefined;
		}
		// Run a copy, so that `cargo build` can replace the original while windows are open.
		const executable = await this.staging.queue(async () => {
			try {
				return await stageNyalaRuntimeExecutable(found, join(this.environmentMainService.userDataPath, 'nyala-runtime-staging'));
			} catch (error) {
				this.logger.warn(`could not copy ${found} to the staging folder (${toErrorMessage(error)}); running it in place, which blocks rebuilding it on Windows`);
				return found;
			}
		});
		return { executable, args: [], env: createNyalaRuntimeEnvironment(process.env) };
	}
}
