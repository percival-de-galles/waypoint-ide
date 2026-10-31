/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { findExecutable } from '../../../base/node/processes.js';
import { localize } from '../../../nls.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { AgentHostCodexEnabledConfigKey, platformRootSchema } from '../common/agentHostSchema.js';
import { AgentHostClaudeAgentEnabledEnvVar, AgentHostCodexAgentEnabledEnvVar, isAgentEnabled } from '../common/agentService.js';
import { IAgentConfigurationService } from './agentConfigurationService.js';
import { IAgentHostProviderService } from './agentHostProviderService.js';
import { AcpAgent, type IAcpAgentDefinition } from './acp/acpAgent.js';
import { agentInstallCommands, resolveAgentBinary } from './agentBinary.js';
import { ClaudeAgent } from './claude/claudeAgent.js';
import { cursorCustomizationSources, openCodeCustomizationSources } from './cliCustomizations.js';
import { CodexAgent } from './codex/codexAgent.js';
import { PiAgent, piAgentDir } from './pi/piAgent.js';
import { AgentUsageCollector } from './usage/agentUsageCollector.js';

/**
 * Registers the agents this host offers. Each agent drives the CLI the user installed, so
 * registration does not depend on any downloaded SDK: a missing CLI surfaces as the agent's
 * own readiness state instead of a missing provider.
 */
export function registerAgents(
	instantiationService: IInstantiationService,
	providerService: IAgentHostProviderService,
	configurationService: IAgentConfigurationService,
	disposables: DisposableStore,
	log: (message: string) => void = () => { },
): void {
	if (isAgentEnabled(process.env[AgentHostClaudeAgentEnabledEnvVar], true)) {
		providerService.registerProvider(instantiationService.createInstance(ClaudeAgent));
		log('ClaudeAgent registered');
	}

	// Codex registration is one-way (register-on-enable): the env-var toggle or the
	// renderer-forwarded `codexAgentEnabled` root config enables it. Disabling requires an
	// agent host restart.
	let codexRegistered = false;
	const registerCodexIfEnabled = () => {
		if (codexRegistered) {
			return;
		}
		const enabledByEnv = isAgentEnabled(process.env[AgentHostCodexAgentEnabledEnvVar], true);
		const enabledByRootConfig = configurationService.getRootValue(platformRootSchema, AgentHostCodexEnabledConfigKey) === true;
		if (enabledByEnv || enabledByRootConfig) {
			codexRegistered = true;
			providerService.registerProvider(instantiationService.createInstance(CodexAgent));
			log('CodexAgent registered');
		}
	};
	registerCodexIfEnabled();
	disposables.add(configurationService.onDidRootConfigChange(registerCodexIfEnabled));

	for (const definition of acpAgents) {
		providerService.registerProvider(instantiationService.createInstance(AcpAgent, definition));
		log(`${definition.id} registered`);
	}
	providerService.registerProvider(instantiationService.createInstance(PiAgent, {
		id: 'pi',
		displayName: 'Pi',
		description: 'Pi coding agent, run by your Pi CLI',
		resolveLaunch: async () => {
			// Pi's installer links `pi` into a folder on PATH, or into its own `bin` when none is free; this process's PATH predates an install.
			const command = await resolveAgentBinary('pi', 'pi') ?? await findExecutable(join(piAgentDir(), 'bin', 'pi'));
			return command ? { command, args: ['--mode', 'rpc'] } : undefined;
		},
		noApiKeyMessage: localize('pi.noApiKey', "Pi has no model provider yet. Add one in Chat: Manage Language Models (Pi), or run `/login` in Pi (Sign In in Terminal), then send your message again."),
	}));
	log('pi registered');
	disposables.add(instantiationService.createInstance(AgentUsageCollector));
}

/** Agents driven over the Agent Client Protocol by their own CLI's `acp` command. */
const acpAgents: readonly IAcpAgentDefinition[] = [
	{
		id: 'opencode',
		displayName: 'OpenCode',
		description: 'OpenCode agent, run by the OpenCode CLI',
		resolveCommand: () => resolveAgentBinary('opencode', 'opencode'),
		args: ['acp'],
		setupDocsUrl: 'https://opencode.ai/docs',
		loginArgs: ['auth', 'login'],
		installCommand: agentInstallCommands.opencode,
		customizationSources: openCodeCustomizationSources,
	},
	{
		id: 'cursor',
		displayName: 'Cursor',
		description: 'Cursor agent, run by the Cursor CLI',
		// The Cursor CLI installs `cursor-agent` and the more generic `agent`; prefer the unambiguous name.
		resolveCommand: async () => await resolveAgentBinary('cursor', 'cursor-agent') ?? resolveAgentBinary('cursor', 'agent'),
		args: ['acp'],
		setupDocsUrl: 'https://cursor.com/cli',
		loginArgs: ['login'],
		installCommand: agentInstallCommands.cursor,
		customizationSources: cursorCustomizationSources,
	},
];
