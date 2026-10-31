/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseCodexModelSelection, toCodexModelSelectionId } from '../../../node/codex/codexAgent.js';

suite('CodexModelSelection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('round trips provider and model identifiers', () => {
		const id = toCodexModelSelectionId('custom/provider', 'org/model:latest');
		assert.strictEqual(id, '@provider=custom%2Fprovider:org%2Fmodel%3Alatest');
		assert.deepStrictEqual(parseCodexModelSelection({ id }), {
			modelProvider: 'custom/provider',
			modelId: 'org/model:latest',
		});
	});

	test('runs bare and malformed ids on the native OpenAI provider', () => {
		assert.deepStrictEqual([
			parseCodexModelSelection({ id: 'gpt-5' }),
			parseCodexModelSelection({ id: '@provider=openai' }),
		], [
			{ modelProvider: 'openai', modelId: 'gpt-5' },
			{ modelProvider: 'openai', modelId: '@provider=openai' },
		]);
	});

	test('does not collide when display names match', () => {
		assert.notStrictEqual(
			toCodexModelSelectionId('vscode-proxy', 'gpt-5.6-sol'),
			toCodexModelSelectionId('openai', 'gpt-5.6-sol'),
		);
	});
});
