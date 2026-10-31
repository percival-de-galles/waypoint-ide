/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { safeIntl } from '../../../../base/common/date.js';
import type { IAgentUsageDay } from '../../../../platform/agentHost/common/agentUsage.js';

export interface IUsageTokenTotals {
	readonly total: number;
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
}

export interface IUsageCostTotals {
	readonly total: number;
	/** The part agents recorded themselves. */
	readonly reported: number;
	/** The part estimated at public API rates; the next four fields split it by token type. */
	readonly estimated: number;
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
	/** Tokens left out of the total because no cost is known for them. */
	readonly unpricedTokens: number;
}

/** A share of the range's tokens and cost. */
export interface IUsageAmount {
	readonly tokens: number;
	readonly cost: number;
}

export interface IUsageSummary {
	readonly totals: IUsageTokenTotals;
	readonly cost: IUsageCostTotals;
	/** Agents with tokens in the range, most used first. */
	readonly agents: readonly (IUsageAmount & { readonly agent: string; readonly estimatedCost: number })[];
	/** Every day of the range in order, including days with no tokens. */
	readonly days: readonly (IUsageAmount & { readonly day: string; readonly byAgent: ReadonlyMap<string, IUsageAmount> })[];
	/** Models with tokens in the range, most used first. */
	readonly models: readonly (IUsageAmount & { readonly agent: string; readonly model: string })[];
}

function dayKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function estimatedCostOf(row: IAgentUsageDay): number {
	return row.cost.input + row.cost.cacheRead + row.cost.cacheWrite + row.cost.output;
}

/** Rolls the host's per-day rows up to what the Usage view shows for the last `rangeDays` days. */
export function summarizeUsage(rows: readonly IAgentUsageDay[], rangeDays: number, now: Date): IUsageSummary {
	const days = new Map<string, Map<string, { tokens: number; cost: number }>>();
	for (let offset = rangeDays - 1; offset >= 0; offset--) {
		days.set(dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset)), new Map());
	}
	const agents = new Map<string, { agent: string; tokens: number; cost: number; estimatedCost: number }>();
	const models = new Map<string, { agent: string; model: string; tokens: number; cost: number }>();
	const totals = { total: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	const cost = { total: 0, reported: 0, estimated: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, unpricedTokens: 0 };
	for (const row of rows) {
		const day = days.get(row.day);
		if (!day) {
			continue;
		}
		const tokens = row.input + row.cacheRead + row.cacheWrite + row.output;
		const estimatedCost = estimatedCostOf(row);
		const rowCost = row.cost.reported + estimatedCost;
		totals.total += tokens;
		totals.input += row.input;
		totals.cacheRead += row.cacheRead;
		totals.cacheWrite += row.cacheWrite;
		totals.output += row.output;
		cost.total += rowCost;
		cost.reported += row.cost.reported;
		cost.estimated += estimatedCost;
		cost.input += row.cost.input;
		cost.cacheRead += row.cost.cacheRead;
		cost.cacheWrite += row.cost.cacheWrite;
		cost.output += row.cost.output;
		cost.unpricedTokens += row.unpricedTokens;

		const dayAgent = day.get(row.agent) ?? { tokens: 0, cost: 0 };
		dayAgent.tokens += tokens;
		dayAgent.cost += rowCost;
		day.set(row.agent, dayAgent);

		const agent = agents.get(row.agent) ?? { agent: row.agent, tokens: 0, cost: 0, estimatedCost: 0 };
		agent.tokens += tokens;
		agent.cost += rowCost;
		agent.estimatedCost += estimatedCost;
		agents.set(row.agent, agent);

		const key = `${row.agent}\0${row.model}`;
		const model = models.get(key) ?? { agent: row.agent, model: row.model, tokens: 0, cost: 0 };
		model.tokens += tokens;
		model.cost += rowCost;
		models.set(key, model);
	}
	return {
		totals,
		cost,
		agents: [...agents.values()].sort((a, b) => b.tokens - a.tokens),
		days: [...days].map(([day, byAgent]) => ({
			day,
			byAgent,
			tokens: [...byAgent.values()].reduce((sum, amount) => sum + amount.tokens, 0),
			cost: [...byAgent.values()].reduce((sum, amount) => sum + amount.cost, 0),
		})),
		models: [...models.values()].sort((a, b) => b.tokens - a.tokens),
	};
}

/** `1.31B`, `80.6K`, `3.78M`: three significant digits, like a chart axis. */
export function formatTokens(tokens: number): string {
	for (const [size, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
		if (tokens >= size) {
			return `${Number((tokens / size).toPrecision(3))}${suffix}`;
		}
	}
	return String(tokens);
}

/** `$320.84`, or `<$0.01` for an amount that would otherwise round to nothing. */
export function formatCost(dollars: number): string {
	const format = safeIntl.NumberFormat(undefined, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' }).value;
	return dollars > 0 && dollars < 0.01 ? `<${format.format(0.01)}` : format.format(dollars);
}
