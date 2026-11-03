/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The renderer end of the Nyala runtime bridge (ADR 0006). It talks to the main process through
// the registered channel and knows nothing about processes, stdio or file paths on the main side.

import { Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { INyalaQueryStateChangedEvent, INyalaRuntimeCallResult, INyalaRuntimeState, NyalaRuntimeCommand, NyalaRuntimeEvent, NYALA_RUNTIME_CHANNEL } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeIpc.js';
import { INyalaRuntimeBridge } from '../common/nyalaConnectionService.js';

export class NyalaRuntimeBridge extends Disposable implements INyalaRuntimeBridge {

	declare readonly _serviceBrand: undefined;

	private readonly channel: IChannel;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		super();
		this.channel = mainProcessService.getChannel(NYALA_RUNTIME_CHANNEL);
	}

	async getState(): Promise<INyalaRuntimeState> {
		// The main process wraps this answer like any other call; the state is its `result`.
		const answer = await this.channel.call<INyalaRuntimeCallResult<INyalaRuntimeState>>(NyalaRuntimeCommand.GetRuntimeState);
		return answer.ok ? answer.result : { generation: answer.runtimeGeneration, status: 'failed', reason: answer.error.message };
	}

	call<T>(command: NyalaRuntimeCommand, params: object): Promise<INyalaRuntimeCallResult<T>> {
		return this.channel.call<INyalaRuntimeCallResult<T>>(command, params);
	}

	get onDidChangeState(): Event<INyalaRuntimeState> {
		return this.channel.listen<INyalaRuntimeState>(NyalaRuntimeEvent.RuntimeStateChanged);
	}

	get onDidChangeQueryState(): Event<INyalaQueryStateChangedEvent> {
		return this.channel.listen<INyalaQueryStateChangedEvent>(NyalaRuntimeEvent.QueryStateChanged);
	}
}
