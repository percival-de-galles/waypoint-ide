/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_AGENT_PROVIDER_ID, IAgentModelInfo } from '../../common/agent.js';
import { AGENT_MODEL_GROUP_ID_META_KEY } from '../../common/agentModelSource.js';
import { CLAUDE_PROVIDER_ANTHROPIC } from '../../common/claudeProviders.js';
import { parseClaudeModelSelection, qualifyClaudeModelCatalog, toClaudeModelSelectionId, toClaudeSdkModelId } from '../../node/claude/claudeModelSelection.js';

suite('claudeModelSelection', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('round trips provider and model identifiers, url-encoding separators', () => {
		const id = toClaudeModelSelectionId('custom/provider', 'org/model:latest');
		assert.strictEqual(id, '@provider=custom%2Fprovider:org%2Fmodel%3Alatest');
		assert.deepStrictEqual(parseClaudeModelSelection({ id }), {
			provider: 'custom/provider',
			modelId: 'org/model:latest',
		});
	});

	test('a bare (un-prefixed) id decodes to the Anthropic provider, id passed through', () => {
		assert.deepStrictEqual(parseClaudeModelSelection({ id: 'claude-opus-4-8' }), {
			provider: CLAUDE_PROVIDER_ANTHROPIC,
			modelId: 'claude-opus-4-8',
		});
	});

	test('a malformed prefix (no separator) falls back to the Anthropic provider', () => {
		assert.deepStrictEqual(parseClaudeModelSelection({ id: '@provider=anthropic' }), {
			provider: CLAUDE_PROVIDER_ANTHROPIC,
			modelId: '@provider=anthropic',
		});
	});

	test('qualifies each id and stamps the Anthropic group into _meta, preserving provider and every other field', () => {
		const model = (id: string, name: string, supportsVision = false): IAgentModelInfo =>
			({ provider: CLAUDE_AGENT_PROVIDER_ID, id, name, supportsVision });
		assert.deepStrictEqual(qualifyClaudeModelCatalog([model('claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', true)]), [
			{ provider: CLAUDE_AGENT_PROVIDER_ID, id: '@provider=anthropic:claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', supportsVision: true, _meta: { [AGENT_MODEL_GROUP_ID_META_KEY]: CLAUDE_PROVIDER_ANTHROPIC } },
		]);
	});

	suite('toClaudeSdkModelId', () => {

		test('peels off the provider qualification and normalizes to the bare SDK id; a legacy bare id and undefined pass through', () => {
			// A provider-qualified id must be stripped to its bare model id before
			// SDK-normalization, or the unparseable `@provider=…` string reaches the
			// subprocess verbatim and 400s. A bare/legacy id has no
			// wrapper and just normalizes (dotted→dashed); undefined stays undefined.
			assert.deepStrictEqual(
				[
					toClaudeSdkModelId({ id: toClaudeModelSelectionId(CLAUDE_PROVIDER_ANTHROPIC, 'claude-sonnet-4-5-20250929') }),
					toClaudeSdkModelId({ id: 'claude-opus-4.6' }),
					toClaudeSdkModelId(undefined),
				],
				['claude-sonnet-4-5', 'claude-opus-4-6', undefined],
			);
		});
	});
});
