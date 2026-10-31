/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentUsageCost } from '../../common/agentUsage.js';
import type { IAgentUsageRecord } from './agentUsageParsers.js';

/** Dollars per million tokens. */
interface IModelRates {
	readonly input: number;
	readonly cacheWrite5m: number;
	readonly cacheWrite1h: number;
	readonly cacheRead: number;
	readonly output: number;
}

function rates(input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number): IModelRates {
	return { input, cacheWrite5m, cacheWrite1h, cacheRead, output };
}

const fable = rates(10, 12.5, 20, 1, 50);
const opus = rates(5, 6.25, 10, 0.5, 25);
const sonnet4 = rates(3, 3.75, 6, 0.3, 15);

/**
 * Anthropic's published API rates (platform.claude.com/docs/en/about-claude/pricing).
 *
 * shortcut: other models are not priced here, because their agents report their own cost or no public rate was verified; add Codex's models from OpenAI's price list once a Codex user can check the result.
 */
const claudeRates: ReadonlyMap<string, IModelRates> = new Map([
	['claude-fable-5-1', rates(10, 12.5, 20, 0.25, 50)],
	['claude-fable-5', fable],
	['claude-opus-5-5', rates(4, 5, 8, 0.2, 20)],
	['claude-opus-5', opus],
	['claude-opus-4-8', opus],
	['claude-opus-4-7', opus],
	['claude-opus-4-6', opus],
	['claude-opus-4-5', opus],
	['claude-sonnet-5-5', rates(2, 2.5, 4, 0.1, 10)],
	['claude-sonnet-5', rates(2, 2.5, 4, 0.2, 10)],
	['claude-sonnet-4-6', sonnet4],
	['claude-sonnet-4-5', sonnet4],
	['claude-haiku-5-5', rates(0.1, 0.125, 0.2, 0.01, 0.5)],
	['claude-haiku-4-5', rates(1, 1.25, 2, 0.1, 5)],
]);

const haiku55LongPromptRates = rates(0.5, 0.625, 1, 0.05, 2.5);
const HAIKU_55_LONG_PROMPT_TOKENS = 100_000;
/** Fast mode doubles every rate on the models that offer it. */
const FAST_MODE_MULTIPLIER = 2;

function findRates(record: IAgentUsageRecord): IModelRates | undefined {
	// Agents may prefix a provider (`anthropic/claude-opus-5-5`), and older ids end in a date.
	const model = record.model.slice(record.model.lastIndexOf('/') + 1).replace(/-\d{8}$/, '');
	const prompt = record.input + record.cacheRead + record.cacheWrite;
	return model === 'claude-haiku-5-5' && prompt > HAIKU_55_LONG_PROMPT_TOKENS ? haiku55LongPromptRates : claudeRates.get(model);
}

/**
 * What one response cost: the agent's own figure when it reports one, otherwise an estimate
 * at public API rates. `undefined` when neither is known.
 */
export function priceUsage(record: IAgentUsageRecord): IAgentUsageCost | undefined {
	if (record.reportedCost) {
		return { reported: record.reportedCost, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	}
	const modelRates = findRates(record);
	if (!modelRates) {
		return undefined;
	}
	const multiplier = record.fast ? FAST_MODE_MULTIPLIER : 1;
	const dollars = (tokens: number, rate: number) => tokens * rate * multiplier / 1_000_000;
	const longCacheWrite = record.longCacheWrite ?? 0;
	return {
		reported: 0,
		input: dollars(record.input, modelRates.input),
		cacheRead: dollars(record.cacheRead, modelRates.cacheRead),
		cacheWrite: dollars(record.cacheWrite - longCacheWrite, modelRates.cacheWrite5m) + dollars(longCacheWrite, modelRates.cacheWrite1h),
		output: dollars(record.output, modelRates.output),
	};
}
