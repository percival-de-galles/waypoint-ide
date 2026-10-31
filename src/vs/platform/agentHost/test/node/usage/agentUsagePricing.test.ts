/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IAgentUsageRecord } from '../../../node/usage/agentUsageParsers.js';
import { priceUsage } from '../../../node/usage/agentUsagePricing.js';

suite('agentUsagePricing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const million = { timestamp: 0, input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 };

	function price(record: Partial<IAgentUsageRecord>) {
		return priceUsage({ ...million, model: 'claude-opus-5-5', ...record });
	}

	test('prices 5-minute and 1-hour cache writes at their own rates', () => {
		assert.deepStrictEqual([price({}), price({ longCacheWrite: 1_000_000 })], [
			{ reported: 0, input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
			{ reported: 0, input: 4, cacheRead: 0.2, cacheWrite: 8, output: 20 },
		]);
	});

	test('finds rates through provider prefixes and date suffixes, and doubles fast mode', () => {
		assert.deepStrictEqual([
			price({ model: 'anthropic/claude-sonnet-5-5' })?.cacheRead,
			price({ model: 'claude-haiku-4-5-20251001' })?.output,
			price({ fast: true })?.output,
		], [0.1, 5, 40]);
	});

	test('switches Haiku 5.5 to its long prompt rates over 100,000 tokens', () => {
		const small = { input: 1000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 };
		assert.deepStrictEqual([
			price({ ...small, model: 'claude-haiku-5-5' })?.output,
			price({ ...small, input: 100_001, model: 'claude-haiku-5-5' })?.output,
		], [0.5, 2.5]);
	});

	test('keeps a reported cost as is, and leaves unknown models unpriced', () => {
		assert.deepStrictEqual([
			price({ reportedCost: 1.5, model: 'opencode-go/glm-5.3' }),
			price({ model: 'opencode-go/glm-5.3' }),
			price({ model: 'opus' }),
		], [
			{ reported: 1.5, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
			undefined,
			undefined,
		]);
	});
});
