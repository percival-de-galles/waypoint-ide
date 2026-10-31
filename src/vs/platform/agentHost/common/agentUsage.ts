/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { RootState } from './state/protocol/state.js';

/**
 * What the agents used, for the Usage view and the chat input's limits button. Rides root
 * transient values, like `agentSdkSetup.ts`: the window asks by setting a request key, and
 * the host answers under the matching value key. History and limits are separate because
 * reading history scans every session log, while limits are one quick question per agent.
 * Only model names and counts cross; no prompt, path or credential does.
 */
export const AGENT_USAGE_KEY = 'vscode.agentUsage.snapshot';
export const AGENT_USAGE_REQUEST_KEY = 'vscode.agentUsage.request';
export const AGENT_USAGE_LIMITS_KEY = 'vscode.agentUsage.limits';
export const AGENT_USAGE_LIMITS_REQUEST_KEY = 'vscode.agentUsage.limitsRequest';

/**
 * Dollars. `reported` is what the agent itself recorded. The others are estimates at public
 * API rates, split by token type, for responses whose agent records no cost.
 */
export interface IAgentUsageCost {
	readonly reported: number;
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
}

/** One model's tokens and cost for one agent on one local day (`YYYY-MM-DD`). */
export interface IAgentUsageDay {
	readonly agent: string;
	readonly day: string;
	readonly model: string;
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
	readonly cost: IAgentUsageCost;
	/** Tokens of responses with neither a reported cost nor a known rate. */
	readonly unpricedTokens: number;
}

export type AgentUsageWindowId = 'session' | 'weekly' | 'weeklyOpus' | 'weeklySonnet' | 'monthly';

/** A plan limit, such as Claude's five-hour session window. */
export interface IAgentUsageWindow {
	readonly id: AgentUsageWindowId;
	readonly usedPercent: number;
	/** Epoch milliseconds. */
	readonly resetsAt?: number;
}

export interface IAgentUsageLimits {
	readonly agent: string;
	/** The plan's own name, when the agent reports one. */
	readonly plan?: string;
	readonly windows: readonly IAgentUsageWindow[];
}

export interface IAgentUsageSnapshot {
	readonly days: readonly IAgentUsageDay[];
	/** Epoch milliseconds. */
	readonly updatedAt: number;
}

export function readAgentUsage(state: RootState | undefined): IAgentUsageSnapshot | undefined {
	const value = state?.config?.values?.[AGENT_USAGE_KEY] as Partial<IAgentUsageSnapshot> | undefined;
	return Array.isArray(value?.days) && typeof value?.updatedAt === 'number' ? { days: value.days, updatedAt: value.updatedAt } : undefined;
}

export function readAgentUsageLimits(state: RootState | undefined): readonly IAgentUsageLimits[] | undefined {
	const value = state?.config?.values?.[AGENT_USAGE_LIMITS_KEY];
	return Array.isArray(value) ? value : undefined;
}
