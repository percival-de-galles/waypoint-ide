/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IAgentUsageDay } from '../../../../../platform/agentHost/common/agentUsage.js';
import { formatCost, formatTokens, summarizeUsage } from '../../common/usageSummary.js';

suite('usageSummary', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function row(agent: string, day: string, model: string, input: number): IAgentUsageDay {
		return { agent, day, model, input, cacheRead: 1, cacheWrite: 0, output: 0, cost: { reported: 0, input: 0.5, cacheRead: 0, cacheWrite: 0, output: 0 }, unpricedTokens: 0 };
	}

	test('rolls rows up to the range, keeps empty days and orders by use', () => {
		const summary = summarizeUsage([
			row('pi', '2026-10-30', 'glm', 4),
			row('claude', '2026-10-28', 'opus', 9),
			row('claude', '2026-10-30', 'opus', 9),
			row('claude', '2026-10-01', 'old', 100),
			{ ...row('pi', '2026-10-29', 'glm', 0), cost: { reported: 2, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, unpricedTokens: 7 },
		], 3, new Date(2026, 9, 30, 12));

		assert.deepStrictEqual({
			totals: summary.totals,
			cost: summary.cost,
			agents: summary.agents,
			days: summary.days.map(day => [day.day, day.tokens, day.cost]),
			models: summary.models.map(model => [model.model, model.tokens, model.cost]),
		}, {
			totals: { total: 26, input: 22, cacheRead: 4, cacheWrite: 0, output: 0 },
			cost: { total: 3.5, reported: 2, estimated: 1.5, input: 1.5, cacheRead: 0, cacheWrite: 0, output: 0, unpricedTokens: 7 },
			agents: [{ agent: 'claude', tokens: 20, cost: 1, estimatedCost: 1 }, { agent: 'pi', tokens: 6, cost: 2.5, estimatedCost: 0.5 }],
			days: [['2026-10-28', 10, 0.5], ['2026-10-29', 1, 2], ['2026-10-30', 15, 1]],
			models: [['opus', 20, 1], ['glm', 6, 2.5]],
		});
	});

	test('formats tokens like the chart axis', () => {
		assert.deepStrictEqual([999, 80_600, 3_780_000, 1_310_000_000].map(formatTokens), ['999', '80.6K', '3.78M', '1.31B']);
	});

	test('keeps tiny costs visible', () => {
		assert.deepStrictEqual([0, 0.001].map(dollars => formatCost(dollars).startsWith('<')), [false, true]);
	});
});
