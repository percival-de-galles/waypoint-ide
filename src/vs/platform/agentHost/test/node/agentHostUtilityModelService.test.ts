/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { mock, upcastPartial } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import type { IByokLmBridgeConnection, IByokLmChatRequest, IByokLmModelInfo } from '../../common/agentHostByokLm.js';
import { AgentHostByokModelsEnabledConfigKey, AgentHostUtilitySmallModelConfigKey } from '../../common/agentHostSchema.js';
import type { IAgentConfigurationService } from '../../node/agentConfigurationService.js';
import { AgentHostUtilityModelService, AgentHostUtilityModelUnavailableError } from '../../node/agentHostUtilityModelService.js';
import type { IByokLmBridgeRegistry } from '../../node/byokLmBridgeRegistry.js';

const SESSION = 'agent:/session';

const BYOK_MODELS: readonly IByokLmModelInfo[] = [
	{ vendor: 'ollama', id: 'llama3', modelIdentifier: 'ollama/llama3' },
	{ vendor: 'azure', id: 'gpt-5', modelIdentifier: 'azure/work/gpt-5' },
];

interface IScenario {
	readonly utilitySmallModel?: string;
	readonly byokModelsEnabled?: boolean;
	/** Whether the host has a renderer BYOK bridge; `false` models a remote agent host. */
	readonly byokUtilityModelsSupported?: boolean;
	/** Whether a renderer serves BYOK models. */
	readonly rendererConnected?: boolean;
}

suite('AgentHostUtilityModelService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	async function run(scenario: IScenario, includeInput = false): Promise<unknown> {
		const rootValues: Record<string, unknown> = {
			[AgentHostUtilitySmallModelConfigKey]: scenario.utilitySmallModel,
			[AgentHostByokModelsEnabledConfigKey]: scenario.byokModelsEnabled,
		};
		const configurationService = new class extends mock<IAgentConfigurationService>() {
			override getRootValue(_schema: never, key: string) {
				return rootValues[key] as never;
			}
		}();
		const rendererConnected = scenario.rendererConnected ?? true;
		const byokRequests: Pick<IByokLmChatRequest, 'vendor' | 'modelId' | 'input' | 'modelOptions'>[] = [];
		const connection: IByokLmBridgeConnection = {
			chat: async request => {
				byokRequests.push({ vendor: request.vendor, modelId: request.modelId, input: request.input, modelOptions: request.modelOptions });
				return { output: [{ type: 'message', content: [{ type: 'text', text: 'byok ' }, { type: 'text', text: 'text' }] }] };
			},
			onDidChangeModels: Event.None,
		};
		const bridgeRegistry = upcastPartial<IByokLmBridgeRegistry>({
			getModels: () => rendererConnected ? BYOK_MODELS : [],
			getServingConnection: () => rendererConnected ? connection : undefined,
			onDidChangeModels: () => Disposable.None,
		});
		const service = new AgentHostUtilityModelService(scenario.byokUtilityModelsSupported ?? true, configurationService, bridgeRegistry, new NullLogService());

		let result: string;
		try {
			result = await service.chatCompletion({ session: SESSION }, { messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'request' }], maxTokens: 32 });
		} catch (err) {
			result = err instanceof AgentHostUtilityModelUnavailableError ? `unavailable: ${err.reason}` : `error: ${err}`;
		}
		return includeInput
			? { result, byokRequests }
			: { result, byokRequests: byokRequests.map(r => `${r.vendor}|${r.modelId}`) };
	}

	test('resolves the BYOK override and reports every other configuration as unavailable', async () => {
		const scenarios: Record<string, IScenario> = {
			noOverride: {},
			byokOverride: { utilitySmallModel: 'ollama/llama3' },
			byokOverrideInGroup: { utilitySmallModel: 'azure/gpt-5' },
			unknownOverride: { utilitySmallModel: 'ollama/missing' },
			copilotOverride: { utilitySmallModel: 'copilot/gpt-4.1' },
			malformedOverride: { utilitySmallModel: 'llama3' },
			overrideWithByokDisabled: { utilitySmallModel: 'ollama/llama3', byokModelsEnabled: false },
			remoteIgnoresOverride: { utilitySmallModel: 'ollama/llama3', byokUtilityModelsSupported: false },
			disconnectedByokOverride: { utilitySmallModel: 'ollama/llama3', rendererConnected: false },
			disconnectedCopilotOverride: { utilitySmallModel: 'copilot/gpt-4.1', rendererConnected: false },
			disconnectedOverrideWithByokDisabled: { utilitySmallModel: 'ollama/llama3', byokModelsEnabled: false, rendererConnected: false },
		};
		const results: Record<string, unknown> = {};
		for (const [name, scenario] of Object.entries(scenarios)) {
			results[name] = await run(scenario);
		}

		const notConfigured = { result: 'unavailable: notConfigured', byokRequests: [] };
		assert.deepStrictEqual(results, {
			noOverride: notConfigured,
			byokOverride: { result: 'byok text', byokRequests: ['ollama|llama3'] },
			byokOverrideInGroup: { result: 'byok text', byokRequests: ['azure|work/gpt-5'] },
			unknownOverride: notConfigured,
			copilotOverride: notConfigured,
			malformedOverride: notConfigured,
			overrideWithByokDisabled: notConfigured,
			remoteIgnoresOverride: notConfigured,
			disconnectedByokOverride: { result: 'unavailable: byokModelUnavailable', byokRequests: [] },
			disconnectedCopilotOverride: notConfigured,
			disconnectedOverrideWithByokDisabled: notConfigured,
		});
	});

	test('forwards the utility messages and inference options to the BYOK bridge', async () => {
		const result = await run({ utilitySmallModel: 'ollama/llama3' }, true);
		assert.deepStrictEqual(result, {
			result: 'byok text',
			byokRequests: [{
				vendor: 'ollama',
				modelId: 'llama3',
				input: [
					{ type: 'message', role: 'system', content: [{ type: 'text', text: 'rules' }] },
					{ type: 'message', role: 'user', content: [{ type: 'text', text: 'request' }] },
				],
				modelOptions: { temperature: 0.1, top_p: 1, max_tokens: 32 },
			}],
		});
	});
});
