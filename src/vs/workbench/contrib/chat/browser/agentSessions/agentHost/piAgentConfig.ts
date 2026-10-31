/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { Event } from '../../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { ExtensionIdentifier } from '../../../../../../platform/extensions/common/extensions.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IMcpServerConfiguration, McpServerType } from '../../../../../../platform/mcp/common/mcpPlatformTypes.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../../../common/contributions.js';
import { IAgentSdkSetupService } from '../../../../../services/agentHost/browser/agentSdkSetupService.js';
import { IWorkbenchMcpManagementService, LocalMcpServerScope } from '../../../../../services/mcp/common/mcpWorkbenchManagementService.js';
import { IPathService } from '../../../../../services/path/common/pathService.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatProvider, ILanguageModelConfigurationSchema, ILanguageModelsService, IUserFriendlyLanguageModel } from '../../../common/languageModels.js';

export const PiVendor = 'pi-agent';
export const PiCustomVendor = 'pi-agent-custom';

/** Pi's API-key providers. The ids are Pi's own (`auth.json` keys). */
const piKeyProviders = [
	'anthropic', 'openai', 'google', 'xai', 'openrouter', 'groq', 'mistral', 'deepseek', 'cerebras', 'fireworks', 'together',
	'huggingface', 'nvidia', 'baseten', 'meta', 'minimax', 'minimax-cn', 'moonshotai', 'moonshotai-cn', 'kimi-coding', 'zai',
	'zai-coding-cn', 'opencode', 'opencode-go', 'vercel-ai-gateway', 'radius', 'typesafe', 'ant-ling', 'qwen-token-plan',
	'qwen-token-plan-cn', 'qwen-token-plan-individual', 'xiaomi', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-sgp',
	'azure', 'google-vertex', 'cloudflare-ai-gateway', 'cloudflare-workers-ai',
];

const piApis = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];

type JsonObject = Record<string, unknown>;

/** Replaces the entries Waypoint wrote last time (`owned`) with `entries`, keeping everyone else's. */
export function replaceOwned(target: JsonObject | undefined, owned: readonly string[], entries: ReadonlyMap<string, unknown>): JsonObject {
	const next = { ...target };
	for (const name of owned) {
		delete next[name];
	}
	for (const [name, value] of entries) {
		next[name] = value;
	}
	return next;
}

/** Pi names a provider or MCP server with letters, digits, `_` and `-` only. */
export function toPiName(name: string): string {
	return name.replace(/[^A-Za-z0-9_-]+/g, '-');
}

/**
 * Turns a server from Waypoint's MCP configuration into a Pi `mcp.json` entry. Returns
 * `undefined` for what Pi can't run: SSE servers, and servers that use `${input:…}` or
 * workspace variables, which only the editor can fill in.
 */
export function toPiMcpServer(config: IMcpServerConfiguration, userHome: string): JsonObject | undefined {
	const server: JsonObject = config.type === McpServerType.LOCAL
		? { command: config.command, args: config.args, env: config.env && Object.fromEntries(Object.entries(config.env).filter(([, value]) => value !== null).map(([key, value]) => [key, String(value)])), cwd: config.cwd }
		: config.transport === 'sse' ? {} : { url: config.url, headers: config.headers };
	if (!server.command && !server.url) {
		return undefined;
	}
	const json = JSON.stringify(server).replace(/\$\{env:([^}]+)\}/g, '${$1}').replace(/\$\{userHome\}/g, userHome.replace(/\\/g, '\\\\'));
	return /\$\{(input:|command:|config:|workspace|file|relativeFile|cwd)/.test(json) ? undefined : JSON.parse(json);
}

/** Parses `KEY=value, KEY=value` into the `env` object of a Pi credential. */
export function parsePiEnv(value: unknown): Record<string, string> | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const entries = value.split(/[,\n]/).map(part => part.trim()).filter(part => part.includes('=')).map(part => [part.slice(0, part.indexOf('=')).trim(), part.slice(part.indexOf('=') + 1).trim()] as const).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
	return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * Lets Waypoint's own UI configure the user's Pi, in Pi's own files (`~/.pi/agent`):
 * - Manage Models gets two vendors, one for Pi's built-in providers and one for any
 *   OpenAI, Anthropic or Google compatible endpoint. Keys go to Pi's `auth.json` and
 *   endpoints to its `models.json`; they are not chat models of the editor itself.
 * - User-level MCP servers (MCP: Add Server, the MCP Servers view) are added to its `mcp.json`.
 * Only entries Waypoint wrote are ever replaced or removed, and nothing is written until
 * Pi is installed: the agent host then creates `auth.json` readable only by the user.
 *
 * shortcut: assumes Pi's default folder; a `PI_CODING_AGENT_DIR` set for Pi is not followed here.
 */
export class PiAgentConfigContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.chat.piAgentConfig';

	private readonly _keys = new Map<string, unknown>();
	private readonly _customAuth = new Map<string, unknown>();
	private readonly _custom = new Map<string, unknown>();
	/** Vendors resolved at least once; until then their entries are unknown, not empty. */
	private readonly _resolved = new Set<string>();
	private readonly _syncModels = this._register(new RunOnceScheduler(() => this._sync(async () => {
		// Both vendors write auth.json, so it waits for both.
		if (this._resolved.size === 2) {
			await this._update('auth.json', new Map([...this._keys, ...this._customAuth]));
			await this._update('models.json', this._custom, 'providers');
		}
	}), 500));
	private readonly _syncMcp = this._register(new RunOnceScheduler(() => this._sync(async () => {
		const home = this._pathService.userHome({ preferLocal: true }).fsPath;
		const servers = new Map<string, unknown>();
		for (const server of await this._mcpManagementService.getInstalled()) {
			const entry = server.scope === LocalMcpServerScope.User ? toPiMcpServer(server.config, home) : undefined;
			if (entry) {
				servers.set(toPiName(server.name), entry);
			}
		}
		await this._update('mcp.json', servers, 'mcpServers');
	}), 500));

	constructor(
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@IWorkbenchMcpManagementService private readonly _mcpManagementService: IWorkbenchMcpManagementService,
		@IAgentSdkSetupService agentSdkSetupService: IAgentSdkSetupService,
		@IFileService private readonly _fileService: IFileService,
		@IPathService private readonly _pathService: IPathService,
		@IStorageService private readonly _storageService: IStorageService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		const descriptors: IUserFriendlyLanguageModel[] = [{
			vendor: PiVendor,
			displayName: localize('piAgent.vendor', "Pi"),
			managementCommand: undefined,
			when: undefined,
			configuration: {
				type: 'object',
				properties: {
					provider: { type: 'string', title: localize('piAgent.provider', "Provider"), enum: piKeyProviders },
					apiKey: { type: 'string', secret: true, minLength: 1, title: localize('piAgent.apiKey', "API Key") },
					env: {
						type: 'string',
						title: localize('piAgent.env', "Provider Settings (optional)"),
						description: localize('piAgent.envDescription', "KEY=value pairs, comma separated. Azure needs AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME; Cloudflare needs CLOUDFLARE_ACCOUNT_ID (and CLOUDFLARE_GATEWAY_ID for AI Gateway); Vertex AI can take GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION."),
					},
				},
				required: ['provider', 'apiKey'],
			} satisfies ILanguageModelConfigurationSchema as unknown as undefined, // the extension-point type can't express a `$ref` schema
		}, {
			vendor: PiCustomVendor,
			displayName: localize('piAgent.customVendor', "Pi (Custom Endpoint)"),
			managementCommand: undefined,
			when: undefined,
			configuration: {
				type: 'object',
				properties: {
					baseUrl: { type: 'string', minLength: 1, title: localize('piAgent.baseUrl', "Base URL"), description: localize('piAgent.baseUrlDescription', "For example http://localhost:11434/v1") },
					api: { type: 'string', enum: piApis, default: 'openai-completions', title: localize('piAgent.api', "API") },
					apiKey: { type: 'string', secret: true, title: localize('piAgent.customApiKey', "API Key (optional)") },
					// A string because Manage Models can only prompt for simple values.
					models: { type: 'string', minLength: 1, title: localize('piAgent.models', "Model IDs"), description: localize('piAgent.modelsDescription', "Comma separated, for example qwen3-coder, llama3.3") },
				},
				required: ['baseUrl', 'api', 'models'],
			} satisfies ILanguageModelConfigurationSchema as unknown as undefined,
		}];
		languageModelsService.deltaLanguageModelChatProviderDescriptors(descriptors, []);
		this._register(toDisposable(() => languageModelsService.deltaLanguageModelChatProviderDescriptors([], descriptors)));
		this._register(languageModelsService.registerLanguageModelProvider(PiVendor, this._provider(PiVendor, [this._keys], (group, { provider, apiKey, env }) => {
			if (typeof provider !== 'string' || typeof apiKey !== 'string') {
				return [];
			}
			const providerEnv = parsePiEnv(env);
			this._keys.set(provider, { type: 'api_key', key: apiKey, ...(providerEnv ? { env: providerEnv } : {}) });
			return [provider];
		})));
		this._register(languageModelsService.registerLanguageModelProvider(PiCustomVendor, this._provider(PiCustomVendor, [this._custom, this._customAuth], (group, { baseUrl, api, apiKey, models }) => {
			if (typeof baseUrl !== 'string' || typeof api !== 'string' || typeof models !== 'string') {
				return [];
			}
			const modelIds = models.split(',').map(id => id.trim()).filter(Boolean);
			// The group name is the Pi provider id, as in `--model my-server/qwen3`.
			const provider = toPiName(group);
			this._custom.set(provider, { baseUrl, api, models: modelIds.map(id => ({ id })) });
			// Pi lists an endpoint's models only when it has a key; local servers take any.
			this._customAuth.set(provider, { type: 'api_key', key: typeof apiKey === 'string' && apiKey ? apiKey : 'none' });
			return modelIds;
		})));

		this._register(Event.any<unknown>(
			this._mcpManagementService.onDidInstallMcpServers,
			this._mcpManagementService.onDidUpdateMcpServers,
			this._mcpManagementService.onDidUninstallMcpServer,
			this._mcpManagementService.onDidChangeProfile,
		)(() => this._syncMcp.schedule()));
		// Writes wait for Pi to be installed; this is when that changes.
		this._register(agentSdkSetupService.onDidChangeSetups(() => {
			this._syncModels.schedule();
			this._syncMcp.schedule();
		}));
		this._syncMcp.schedule();
	}

	/**
	 * Manage Models resolves a vendor with one call without a group and then one per group,
	 * so the call without a group starts a new list and the write waits until all have run.
	 */
	private _provider(vendor: string, entries: readonly Map<string, unknown>[], addGroup: (group: string, configuration: Record<string, unknown>) => string[]): ILanguageModelChatProvider {
		return {
			onDidChange: Event.None,
			provideLanguageModelChatInfo: async options => {
				this._syncModels.schedule();
				if (!options.group) {
					entries.forEach(map => map.clear());
					this._resolved.add(vendor);
					return [];
				}
				return addGroup(options.group, options.configuration ?? {}).map((id): ILanguageModelChatMetadataAndIdentifier => ({
					identifier: `${vendor}/${options.group}/${id}`,
					metadata: {
						extension: new ExtensionIdentifier('vscode.chat'),
						id,
						name: id,
						vendor,
						version: '1',
						family: id,
						detail: localize('piAgent.detail', "Pi"),
						tooltip: localize('piAgent.tooltip', "Pick this provider's models in Pi's model picker."),
						maxInputTokens: 0,
						maxOutputTokens: 0,
						isDefaultForLocation: {},
						// Only Pi can use these models.
						isUserSelectable: false,
					},
				}));
			},
			sendChatRequest: async () => { throw new Error(localize('piAgent.chatUnsupported', "Use Pi to chat with this model.")); },
			provideTokenCount: async () => 0,
		};
	}

	private async _sync(write: () => Promise<void>): Promise<void> {
		try {
			await write();
		} catch (error) {
			this._logService.error('[Pi] Could not update Pi\'s configuration', error);
		}
	}

	/** Writes `entries` into one of Pi's files, at the top level or under `property`. */
	private async _update(fileName: string, entries: ReadonlyMap<string, unknown>, property?: string): Promise<void> {
		const dir = joinPath(this._pathService.userHome({ preferLocal: true }), '.pi', 'agent');
		// No auth.json means Pi is not installed (the agent host creates it, private, once Pi is); write nothing until then.
		if (!await this._fileService.exists(joinPath(dir, 'auth.json'))) {
			return;
		}
		const file = joinPath(dir, fileName);
		const ownedKey = `piAgent.owned.${fileName}`;
		const owned: string[] = JSON.parse(this._storageService.get(ownedKey, StorageScope.APPLICATION, '[]'));
		if (!entries.size && !owned.length) {
			return;
		}
		const json = await this._readJson(file);
		const next = property ? { ...json, [property]: replaceOwned(json[property] as JsonObject | undefined, owned, entries) } : replaceOwned(json, owned, entries);
		if (JSON.stringify(next) !== JSON.stringify(json)) {
			// Writing in place keeps auth.json's private mode.
			await this._fileService.writeFile(file, VSBuffer.fromString(JSON.stringify(next, undefined, '\t')));
		}
		this._storageService.store(ownedKey, JSON.stringify([...entries.keys()]), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private async _readJson(file: URI): Promise<JsonObject> {
		try {
			return JSON.parse((await this._fileService.readFile(file)).value.toString() || '{}');
		} catch (error) {
			if (error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				return {};
			}
			// Never overwrite a file that could not be read or parsed; the user may be editing it.
			throw error;
		}
	}
}
