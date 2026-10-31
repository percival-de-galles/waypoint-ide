/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createCodexUsageParser, parseClaudeUsageLine, parseOpenCodeUsageRow, parsePiUsageLine } from '../../../node/usage/agentUsageParsers.js';

suite('agentUsageParsers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const timestamp = '2026-10-30T10:00:00.000Z';
	const time = Date.parse(timestamp);

	test('reads Claude Code assistant usage and ignores everything else', () => {
		const line = (fields: object) => JSON.stringify({ type: 'assistant', timestamp, requestId: 'r1', ...fields });
		const usage = { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, cache_creation: { ephemeral_1h_input_tokens: 3 }, output_tokens: 4 };
		assert.deepStrictEqual([
			parseClaudeUsageLine(line({ message: { id: 'm1', model: 'claude-opus-5-5', usage } })),
			parseClaudeUsageLine(line({ message: { id: 'm2', model: '<synthetic>', usage } })),
			parseClaudeUsageLine(line({ type: 'user', message: { id: 'm3', model: 'claude-opus-5-5', usage } })),
			parseClaudeUsageLine('{"type":"assist'),
		], [
			{ timestamp: time, model: 'claude-opus-5-5', input: 1, cacheRead: 2, cacheWrite: 3, output: 4, longCacheWrite: 3, dedupeKey: 'm1:r1' },
			undefined,
			undefined,
			undefined,
		]);
	});

	test('reads Pi usage, including entries that have no model', () => {
		assert.deepStrictEqual([
			parsePiUsageLine(JSON.stringify({ type: 'message', id: 'a', timestamp, message: { role: 'assistant', provider: 'opencode-go', model: 'glm-5.3', usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } } } })),
			parsePiUsageLine(JSON.stringify({ type: 'compaction', id: 'b', timestamp, usage: { input: 5 } })),
			parsePiUsageLine(JSON.stringify({ type: 'session', id: 'c', timestamp })),
		], [
			{ timestamp: time, model: 'opencode-go/glm-5.3', input: 1, cacheRead: 3, cacheWrite: 4, output: 2, reportedCost: 0.5, dedupeKey: `a:${timestamp}:opencode-go/glm-5.3` },
			{ timestamp: time, model: 'other', input: 5, cacheRead: 0, cacheWrite: 0, output: 0, dedupeKey: `b:${timestamp}:other` },
			undefined,
		]);
	});

	test('carries the Codex model forward and skips repeated token events', () => {
		const parse = createCodexUsageParser();
		const tokens = (total: number) => JSON.stringify({
			type: 'event_msg', timestamp, payload: {
				type: 'token_count', info: {
					total_token_usage: { total_tokens: total },
					last_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 },
				}
			}
		});
		assert.deepStrictEqual([
			parse(JSON.stringify({ type: 'turn_context', timestamp, payload: { model: 'gpt-6' } })),
			parse(tokens(12)),
			parse(tokens(12)),
			parse(tokens(24)),
		], [
			undefined,
			{ timestamp: time, model: 'gpt-6', input: 6, cacheRead: 4, cacheWrite: 0, output: 2 },
			undefined,
			{ timestamp: time, model: 'gpt-6', input: 6, cacheRead: 4, cacheWrite: 0, output: 2 },
		]);
	});

	test('reads OpenCode messages and counts reasoning as output', () => {
		assert.deepStrictEqual([
			parseOpenCodeUsageRow(JSON.stringify({ model: { id: 'glm-5.3', providerID: 'opencode-go' }, cost: 0, tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } }), time),
			parseOpenCodeUsageRow(JSON.stringify({ model: { id: 'glm-5.3' }, finish: 'error' }), time),
		], [
			{ timestamp: time, model: 'opencode-go/glm-5.3', input: 1, cacheRead: 4, cacheWrite: 5, output: 5 },
			undefined,
		]);
	});
});
