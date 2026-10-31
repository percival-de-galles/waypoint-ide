/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { structuralEquals } from '../../../../base/common/equals.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableFromEventOpts } from '../../../../base/common/observable.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { AGENT_USAGE_LIMITS_REQUEST_KEY, readAgentUsageLimits, type IAgentUsageLimits, type IAgentUsageWindow } from '../../../../platform/agentHost/common/agentUsage.js';
import { IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { ActionType } from '../../../../platform/agentHost/common/state/sessionActions.js';
import { ROOT_STATE_URI } from '../../../../platform/agentHost/common/state/sessionState.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ICodexAccountService } from './codexAccountService.js';

/** Each refresh starts Claude Code once, so routine refreshes wait at least this long. */
const MIN_REFRESH_INTERVAL_MS = 60_000;

export const IAgentUsageLimitsService = createDecorator<IAgentUsageLimitsService>('agentUsageLimitsService');

/** How much of each agent's plan is left, as the agents report it. */
export interface IAgentUsageLimitsService {
	readonly _serviceBrand: undefined;

	readonly limits: IObservable<readonly IAgentUsageLimits[]>;

	/** Asks the agents again. `force` is for a person looking at the numbers right now. */
	refresh(force?: boolean): void;
}

export class AgentUsageLimitsService extends Disposable implements IAgentUsageLimitsService {

	declare readonly _serviceBrand: undefined;

	readonly limits: IObservable<readonly IAgentUsageLimits[]>;
	private _lastRefresh = 0;

	constructor(
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@ICodexAccountService private readonly _codexAccountService: ICodexAccountService,
	) {
		super();
		this.limits = observableFromEventOpts<readonly IAgentUsageLimits[]>(
			{ owner: this, equalsFn: structuralEquals },
			Event.any<unknown>(_agentHostService.rootState.onDidChange, _codexAccountService.onDidChangeAccount),
			() => this._read(),
		);
	}

	refresh(force?: boolean): void {
		if (force || Date.now() - this._lastRefresh >= MIN_REFRESH_INTERVAL_MS) {
			this._lastRefresh = Date.now();
			this._agentHostService.dispatch(ROOT_STATE_URI, { type: ActionType.RootConfigChanged, config: { [AGENT_USAGE_LIMITS_REQUEST_KEY]: generateUuid() } });
		}
	}

	private _read(): readonly IAgentUsageLimits[] {
		const state = this._agentHostService.rootState.value;
		const fromHost = (state instanceof Error ? undefined : readAgentUsageLimits(state)) ?? [];
		const account = this._codexAccountService.account;
		const windows = (account.rateLimits ?? []).map((limit): IAgentUsageWindow => ({
			id: limit.windowDurationMins === 300 ? 'session' : 'weekly',
			usedPercent: limit.usedPercent,
			resetsAt: limit.resetsAt ? limit.resetsAt * 1000 : undefined,
		}));
		return windows.length ? [...fromHost, { agent: this._codexAccountService.agent, plan: account.planType, windows }] : fromHost;
	}
}

registerSingleton(IAgentUsageLimitsService, AgentUsageLimitsService, InstantiationType.Delayed);
