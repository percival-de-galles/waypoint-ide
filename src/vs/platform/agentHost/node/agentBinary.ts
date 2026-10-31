/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { homedir } from 'os';
import { findExecutable } from '../../../base/node/processes.js';
import { AgentHostBinaryPathsEnvVar } from '../common/agentService.js';

function installCommand(posix: string, windows: string): readonly string[] {
	return process.platform === 'win32'
		? ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', windows]
		: ['sh', '-c', posix];
}

/** Each agent's official installer, run in a terminal from the setup banner and the welcome screen. */
export const agentInstallCommands = {
	claude: installCommand('curl -fsSL https://claude.ai/install.sh | bash', 'irm https://claude.ai/install.ps1 | iex'),
	codex: installCommand('npm install -g @openai/codex', 'npm install -g @openai/codex'),
	opencode: installCommand('curl -fsSL https://opencode.ai/install | bash', 'npm install -g opencode-ai'),
	cursor: installCommand('curl -fsS https://cursor.com/install | bash', `irm 'https://cursor.com/install?win32=true' | iex`),
	pi: installCommand('curl -fsSL https://pi.dev/install.sh | sh', 'irm https://pi.dev/install.ps1 | iex'),
};

/**
 * The CLI an agent drives: the path configured for `agent` in `chat.agentHost.binaryPaths`,
 * otherwise `command` found on `PATH`. `undefined` when it is not installed.
 *
 * shortcut: a Windows npm install resolves to a `.cmd` launcher that some SDKs cannot spawn; point the setting at the real executable until launchers are unwrapped.
 */
export async function resolveAgentBinary(agent: string, command: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	return findExecutable(agentCommand(agent, command, env), undefined, undefined, env);
}

/** The configured command for `agent`, or `command` itself, without resolving it on `PATH`. */
export function agentCommand(agent: string, command: string, env: NodeJS.ProcessEnv = process.env): string {
	let configured: unknown;
	try {
		configured = (JSON.parse(env[AgentHostBinaryPathsEnvVar] ?? '{}') as Record<string, unknown>)[agent];
	} catch {
		// A malformed forwarded value falls back to the default command.
	}
	return typeof configured === 'string' && configured.trim() ? configured.trim().replace(/^~(?=$|[\\/])/, homedir()) : command;
}
