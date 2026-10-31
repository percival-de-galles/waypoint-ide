/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { RootState } from './state/protocol/state.js';

/**
 * Private side-channel describing whether each agent's SDK is on disk yet, and
 * what the user can do about it. Rides `publishRootTransientValues` rather than
 * AHP proper, alongside `vscode.codexAccount`: the protocol files here are
 * generated and version-pinned, so promoting this is a cross-repo change.
 *
 * One key per agent rather than one key holding a map — transient values are a
 * shallow patch, so a shared key would let agents erase each other's entry.
 */
const AGENT_SDK_SETUP_STATUS_KEY_PREFIX = 'vscode.agentSdkSetup.status.';

export const AGENT_SDK_SETUP_DOWNLOAD_REQUEST_KEY = 'vscode.agentSdkSetup.downloadRequest';

/**
 * Ask an agent to look again at a setup the user completed outside the app
 * (`claude login`, an exported key) — the only completion signal there is.
 */
export const AGENT_SDK_SETUP_RELOAD_REQUEST_KEY = 'vscode.agentSdkSetup.reloadRequest';

export function agentSdkSetupStatusKey(agent: string): string {
	return `${AGENT_SDK_SETUP_STATUS_KEY_PREFIX}${agent}`;
}

/**
 * Whether the agent's SDK can be loaded without a network fetch.
 *
 * `downloadOnUse` means the SDK is absent, but this host remembers consent and
 * will fetch it only when an agent turn needs it.
 *
 * Deliberately the *only* thing on the wire: account state is derivable from the
 * model list, which already flows over AHP — `ready` plus zero models means "no
 * account" — and publishing it too would be two sources for one truth.
 */
export type AgentSdkDownloadStatus = 'notDownloaded' | 'downloadOnUse' | 'downloading' | 'ready';

/**
 * What an agent declares about its own setup. Capabilities, never UI: no
 * user-facing strings ride this channel, because localization belongs in the
 * workbench.
 */
export interface IAgentSdkSetupInfo {
	/** Agent/provider id, e.g. `'claude'`. */
	readonly agent: string;
	readonly download: AgentSdkDownloadStatus;
	/**
	 * Where the user goes to finish setup, for the agents whose setup happens
	 * outside the app (`claude login`, an exported API key).
	 */
	readonly setupDocsUrl?: string;
	/**
	 * Display name of the provider this agent can sign in to in-app, e.g.
	 * `'ChatGPT'`; absent means it has no such flow. A proper noun the workbench
	 * cannot invent, so it crosses the wire like `displayName` does and is
	 * interpolated into a localized template rather than shown raw.
	 */
	readonly signInProviderName?: string;
	/**
	 * The command line that signs in to this agent from a terminal, e.g.
	 * `['claude', 'auth', 'login']`. The agent owns its credentials; the workbench
	 * only runs this command so the user completes the agent's own login.
	 */
	readonly loginCommand?: readonly string[];
	/**
	 * The agent's own installer, run in a terminal when the agent is not installed,
	 * e.g. `['sh', '-c', 'curl -fsSL https://pi.dev/install.sh | sh']`.
	 */
	readonly installCommand?: readonly string[];
}

/** A request the workbench addresses to one agent, made unique so a repeat press is not swallowed. */
export interface IAgentSdkSetupRequest {
	readonly agent: string;
	readonly request: string;
}

export function isAgentSdkSetupRequestFor(value: unknown, agent: string): value is IAgentSdkSetupRequest {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const request: Partial<IAgentSdkSetupRequest> = value;
	return request.agent === agent && typeof request.request === 'string' && request.request.length > 0;
}

function readOne(value: unknown, agent: string): IAgentSdkSetupInfo | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const info: Partial<IAgentSdkSetupInfo> = value;
	if (info.download !== 'notDownloaded' && info.download !== 'downloadOnUse' && info.download !== 'downloading' && info.download !== 'ready') {
		return undefined;
	}
	const loginCommand = readCommandLine(info.loginCommand);
	const installCommand = readCommandLine(info.installCommand);
	return {
		agent,
		download: info.download,
		setupDocsUrl: typeof info.setupDocsUrl === 'string' ? info.setupDocsUrl : undefined,
		signInProviderName: typeof info.signInProviderName === 'string' && info.signInProviderName.length > 0 ? info.signInProviderName : undefined,
		...(loginCommand ? { loginCommand } : {}),
		...(installCommand ? { installCommand } : {}),
	};
}

function readCommandLine(value: unknown): readonly string[] | undefined {
	return Array.isArray(value) && value.length > 0 && value.every(part => typeof part === 'string') ? value : undefined;
}

/**
 * Every agent that has published a setup status, in root-state key order. Agents
 * that have not published are absent rather than guessed at — there is no honest
 * default for "we were never told".
 */
export function readAgentSdkSetupInfos(state: RootState | undefined): readonly IAgentSdkSetupInfo[] {
	// The one sanctioned hop into the namespaced setup slots; every field read out
	// of them is validated in `readOne`.
	const meta = state?._meta;
	const values = state?.config?.values;
	const infos: IAgentSdkSetupInfo[] = [];
	const seen = new Set<string>();
	for (const bag of [values, meta]) {
		for (const key of Object.keys(bag ?? {})) {
			if (!key.startsWith(AGENT_SDK_SETUP_STATUS_KEY_PREFIX)) {
				continue;
			}
			const agent = key.slice(AGENT_SDK_SETUP_STATUS_KEY_PREFIX.length);
			if (!agent || seen.has(agent)) {
				continue;
			}
			const info = readOne(bag?.[key], agent);
			if (info) {
				seen.add(agent);
				infos.push(info);
			}
		}
	}
	return infos;
}
