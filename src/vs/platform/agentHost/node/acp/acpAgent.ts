/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { tmpdir } from 'os';
import { raceTimeout } from '../../../../base/common/async.js';
import { IJsonRpcRequest, IJsonRpcNotification, JsonRpcError } from '../../../../base/common/jsonRpcProtocol.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import { hasKey } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { type IAgent, type IAgentChatContext, type IAgentChats, type IAgentCreateChatOptions, type IAgentCreateChatResult, type IAgentModelInfo } from '../../common/agent.js';
import { AGENT_DEFAULT_MODEL_META_KEY } from '../../common/meta/agentDefaultModelMeta.js';
import { createThinkingLevelSchema, ReasoningEffortConfigKey } from '../../common/reasoningEffort.js';
import type { AgentSelection, MessageAttachment, ModelSelection } from '../../common/state/protocol/state.js';
import type { Customization, Turn } from '../../common/state/sessionState.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';
import { resolvePromptToText } from '../claude/claudePromptResolver.js';
import { readCliCustomizations, type ICliCustomizationSources } from '../cliCustomizations.js';
import { CliAgentBase, type ICliAgentChat, type ICliAgentDescription } from '../cliAgentBase.js';
import { AcpConnection } from './acpConnection.js';

/** How one agent speaking the Agent Client Protocol is launched. */
export interface IAcpAgentDefinition extends ICliAgentDescription {
	/** Resolves the agent's CLI; `undefined` when it is not installed. */
	readonly resolveCommand: () => Promise<string | undefined>;
	readonly args: readonly string[];
	/** Where the setup banner sends the user to install the agent. */
	readonly setupDocsUrl?: string;
	/** Arguments of the agent's own login command, for the setup banner's sign-in. */
	readonly loginArgs?: readonly string[];
	/** The agent's official install command, for the setup banner and the welcome screen. */
	readonly installCommand?: readonly string[];
	/** Where the agent keeps its skills, commands, plugins and MCP servers for a folder. */
	readonly customizationSources?: (folder: string | undefined) => ICliCustomizationSources;
}

// No client capabilities: the agent reads and writes files and runs commands itself.
const acpInitializeParams = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } };

interface IAcpPermissionOption { readonly optionId: string; readonly kind: string }

interface IAcpSelectOption { readonly value: string; readonly name: string }

/** A `session/new` reply: agents offer models as a `configOptions` selector, or the older `models`. */
interface IAcpSessionReply {
	readonly sessionId: string;
	readonly models?: { readonly currentModelId?: string; readonly availableModels?: readonly { readonly modelId: string; readonly name: string }[] };
	readonly configOptions?: readonly { readonly id: string; readonly category?: string; readonly currentValue?: string; readonly options?: readonly (IAcpSelectOption | { readonly options: readonly IAcpSelectOption[] })[] }[];
}

interface IAcpChat extends ICliAgentChat {
	sessionId?: string;
	model?: ModelSelection;
	workingDirectory?: URI;
}

/**
 * An agent driven over the Agent Client Protocol: Cursor (`cursor-agent acp`), OpenCode
 * (`opencode acp`) and any other ACP agent. The agent runs as the user's own CLI with
 * its own settings, MCP servers and sign-in; this class only translates the protocol.
 *
 * shortcut: restored chats show only turns the host persisted (no `session/load` replay), and attachments reach the agent as text, without images; add both when an agent needs them.
 */
export class AcpAgent extends CliAgentBase<IAcpChat> implements IAgent {

	private readonly _defaultModel: IAgentModelInfo;
	private readonly _models;
	readonly models;

	private readonly _chatsBySessionId = new Map<string, IAcpChat>();
	private readonly _pendingPermissions = new Map<string, { readonly options: readonly IAcpPermissionOption[]; readonly resolve: (outcome: unknown) => void }>();
	private readonly _connectionStore = this._register(new DisposableStore());
	private readonly _probes = this._register(new DisposableStore());
	private _connection: Promise<AcpConnection> | undefined;
	/** The `configOptions` entry that selects the model, for agents that offer one. */
	private _modelConfigId: string | undefined;
	/** The `configOptions` entry that sets thinking, which agents only show for a model that supports it. */
	private _thinkingConfigId: string | undefined;
	private readonly _thinkingLevels = new Map<string, { readonly levels: readonly string[]; readonly current?: string }>();

	constructor(
		private readonly _definition: IAcpAgentDefinition,
		@IAgentConfigurationService configurationService: IAgentConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super(_definition);
		this._publishSetup(configurationService, async () => {
			const command = await _definition.resolveCommand();
			return { download: command ? 'ready' : 'notDownloaded', setupDocsUrl: _definition.setupDocsUrl, loginCommand: command && _definition.loginArgs ? [command, ..._definition.loginArgs] : undefined, installCommand: _definition.installCommand };
		}, () => void this._loadModels());
		this._defaultModel = { provider: _definition.id, id: 'default', name: localize('acp.defaultModel', "Default"), supportsVision: false };
		this._models = observableValue<readonly IAgentModelInfo[]>(this, [this._defaultModel]);
		this.models = this._models;
		void this._loadModels();
	}

	/** What the agent has for the chat's folder, as it keeps them on disk. */
	override async getChatCustomizations(chatUri: URI): Promise<readonly Customization[]> {
		const sources = this._definition.customizationSources?.(this._chats.get(chatUri.toString())?.workingDirectory?.fsPath);
		return sources ? readCliCustomizations(sources) : [];
	}

	protected _createChat(chat: URI, session: URI): IAcpChat {
		return { chat, session, startedToolCalls: new Set() };
	}

	// #region Models

	/** ACP reports models only for a session, so a throwaway one lists them before the first chat. */
	private async _loadModels(): Promise<void> {
		const command = await this._definition.resolveCommand();
		if (!command || this._store.isDisposed) {
			return;
		}
		const probe = this._probes.add(new DisposableStore());
		const connection = probe.add(new AcpConnection(command, this._definition.args, {
			handleRequest: request => { throw new JsonRpcError(-32601, `Unsupported method ${request.method}`); },
			handleNotification: () => { },
		}, message => this._logService.trace(`[${this.id}] ${message}`)));
		const listModels = async () => {
			const { agentCapabilities } = await connection.request<{ agentCapabilities?: { sessionCapabilities?: { delete?: unknown } } }>('initialize', acpInitializeParams);
			const reply = await connection.request<IAcpSessionReply>('session/new', { cwd: tmpdir(), mcpServers: [] });
			this._applyModels(reply);
			await this._readThinkingLevels(connection, reply);
			// shortcut: an agent without `session/delete` keeps one empty session per load, in the temp folder; use `session/close` if one needs it.
			if (agentCapabilities?.sessionCapabilities?.delete) {
				await connection.request('session/delete', { sessionId: reply.sessionId });
			}
		};
		try {
			await raceTimeout(listModels(), 30_000);
		} catch (error) {
			// Signed out, or an older agent: the chat falls back to the agent's own default model.
			this._logService.info(`[${this.id}] could not list models: ${this._describeError(error)}`);
		} finally {
			this._probes.delete(probe);
		}
	}

	/** Selects each model in the probe session, because that is the only way an agent reveals its thinking levels. */
	private async _readThinkingLevels(connection: AcpConnection, reply: IAcpSessionReply): Promise<void> {
		if (!this._modelConfigId) {
			return;
		}
		for (const { id } of this._models.get()) {
			const update = await connection.request<Pick<IAcpSessionReply, 'configOptions'>>('session/set_config_option', { sessionId: reply.sessionId, configId: this._modelConfigId, value: id }).catch(() => undefined);
			const thinking = update?.configOptions?.find(option => option.category === 'thought_level');
			if (thinking) {
				this._thinkingConfigId = thinking.id;
				this._thinkingLevels.set(id, { levels: thinking.options?.flatMap(option => hasKey(option, { options: true }) ? [] : [option.value]) ?? [], current: thinking.currentValue });
			}
		}
		this._applyModels(reply);
	}

	private _applyModels(reply: IAcpSessionReply): void {
		const selector = reply.configOptions?.find(option => option.category === 'model');
		this._modelConfigId = selector?.id;
		const options = selector?.options?.flatMap(option => hasKey(option, { options: true }) ? option.options : [option])
			?? reply.models?.availableModels?.map(model => ({ value: model.modelId, name: model.name }));
		const current = selector?.currentValue ?? reply.models?.currentModelId;
		if (options?.length && !this._store.isDisposed) {
			this._models.set(options.map(option => toAcpModel(this.id, option, current, this._thinkingLevels.get(option.value))), undefined);
		}
	}

	private async _selectModel(sessionId: string, model: ModelSelection): Promise<void> {
		if (model.id === this._defaultModel.id) {
			return;
		}
		const connection = await this._ensureConnection();
		await (this._modelConfigId
			? connection.request('session/set_config_option', { sessionId, configId: this._modelConfigId, value: model.id })
			: connection.request('session/set_model', { sessionId, modelId: model.id }));
		const level = model.config?.[ReasoningEffortConfigKey];
		if (typeof level === 'string' && this._thinkingConfigId && this._thinkingLevels.get(model.id)?.levels.includes(level)) {
			await connection.request('session/set_config_option', { sessionId, configId: this._thinkingConfigId, value: level });
		}
	}

	// #endregion

	// #region Connection

	private _ensureConnection(): Promise<AcpConnection> {
		this._connection ??= this._startConnection().catch(error => {
			this._connection = undefined;
			throw error;
		});
		return this._connection;
	}

	private async _startConnection(): Promise<AcpConnection> {
		const command = await this._definition.resolveCommand();
		if (!command) {
			throw new Error(localize('acp.notInstalled', "{0} is not installed. Install it, or set `chat.agentHost.binaryPaths` to the location of its command.", this._definition.displayName));
		}
		this._connectionStore.clear();
		const connection = this._connectionStore.add(new AcpConnection(command, this._definition.args, {
			handleRequest: request => this._handleRequest(request),
			handleNotification: notification => this._handleNotification(notification),
		}, message => this._logService.info(`[${this.id}] ${message}`)));
		this._connectionStore.add(connection.onDidExit(() => {
			this._connection = undefined;
			this._failActiveTurns(localize('acp.exited', "{0} stopped unexpectedly.", this._definition.displayName));
		}));
		await connection.request('initialize', acpInitializeParams);
		return connection;
	}

	private async _ensureSession(chat: IAcpChat, workingDirectory: URI | undefined): Promise<string> {
		if (chat.sessionId) {
			return chat.sessionId;
		}
		const connection = await this._ensureConnection();
		const result = await connection.request<IAcpSessionReply>('session/new', { cwd: workingDirectory?.fsPath ?? tmpdir(), mcpServers: [] });
		chat.sessionId = result.sessionId;
		this._chatsBySessionId.set(result.sessionId, chat);
		this._onDidChangeChatData.fire({ chat: chat.chat, providerData: result.sessionId });
		this._applyModels(result);
		if (chat.model) {
			await this._selectModel(result.sessionId, chat.model);
		}
		return result.sessionId;
	}

	/** Turns an "authentication required" reply into the agent's own sign-in guidance. */
	private _describeError(error: unknown): string {
		// -32000 is the ACP "authentication required" error.
		if (error instanceof JsonRpcError && error.code === -32000) {
			return localize('acp.signInRequired', "{0} is not signed in. Sign in with its own login in a terminal, then try again.", this._definition.displayName);
		}
		return error instanceof Error ? error.message : String(error);
	}

	// #endregion

	// #region Chats

	readonly chats: IAgentChats = {
		createChat: async (chatUri: URI, context: URI | IAgentChatContext, options?: IAgentCreateChatOptions): Promise<IAgentCreateChatResult | void> => {
			const chat = this._chat(chatUri, context);
			chat.model = options?.model;
			const workingDirectory = chat.workingDirectory = options?.workingDirectories?.[0];
			return workingDirectory ? { providerData: await this._ensureSession(chat, workingDirectory) } : undefined;
		},
		disposeChat: async (chatUri: URI): Promise<void> => this._forget(chatUri),
		releaseChat: async (chatUri: URI): Promise<void> => this._forget(chatUri),
		sendMessage: async (chatUri: URI, prompt: string, workingDirectoriesOrDirectory: readonly URI[] | URI | undefined, attachments?: readonly MessageAttachment[], turnId?: string, _senderClientId?: string, _clientType?: unknown, context?: URI | IAgentChatContext): Promise<void> => {
			const chat = this._chat(chatUri, context);
			const workingDirectory = URI.isUri(workingDirectoriesOrDirectory) ? workingDirectoriesOrDirectory : workingDirectoriesOrDirectory?.[0];
			chat.workingDirectory = workingDirectory ?? chat.workingDirectory;
			const activeTurn = turnId ?? generateUuid();
			this._beginTurn(chat, activeTurn);
			try {
				const sessionId = await this._ensureSession(chat, workingDirectory);
				await (await this._ensureConnection()).request('session/prompt', { sessionId, prompt: [{ type: 'text', text: this._withSurfaceInstructions(resolvePromptToText(prompt, attachments), context) }] });
				this._endTurn(chat, activeTurn);
			} catch (error) {
				this._failTurn(chat, activeTurn, 'acp_error', this._describeError(error));
			}
		},
		abort: async (chatUri: URI): Promise<void> => {
			const chat = this._chats.get(chatUri.toString());
			if (chat?.sessionId && this._connection) {
				(await this._connection).notify('session/cancel', { sessionId: chat.sessionId });
			}
			for (const [toolCallId, pending] of this._pendingPermissions) {
				if (chat?.startedToolCalls.has(toolCallId)) {
					this._pendingPermissions.delete(toolCallId);
					pending.resolve({ outcome: { outcome: 'cancelled' } });
				}
			}
		},
		changeModel: async (chatUri: URI, model: ModelSelection): Promise<void> => {
			const chat = this._chats.get(chatUri.toString());
			if (!chat) {
				return;
			}
			chat.model = model;
			if (chat.sessionId) {
				await this._selectModel(chat.sessionId, model);
			}
		},
		changeAgent: async (_chatUri: URI, _agent: AgentSelection | undefined): Promise<void> => { },
		getMessages: async (): Promise<readonly Turn[]> => [],
	};

	async materializeChat(chatUri: URI, context: URI | IAgentChatContext, providerData: string | undefined): Promise<IAgentCreateChatResult | void> {
		const chat = this._chat(chatUri, context);
		if (providerData && !chat.sessionId) {
			// shortcut: the agent's own session id is reused as-is; agents that need `session/load` to resume it start a fresh session on the next send.
			chat.sessionId = providerData;
			this._chatsBySessionId.set(providerData, chat);
		}
	}

	private _forget(chatUri: URI): void {
		const chat = this._chats.get(chatUri.toString());
		if (chat?.sessionId) {
			this._chatsBySessionId.delete(chat.sessionId);
		}
		this._chats.delete(chatUri.toString());
	}

	// #endregion

	// #region Protocol → signals

	private _handleNotification(notification: IJsonRpcNotification): void {
		if (notification.method !== 'session/update') {
			return;
		}
		const params = notification.params as { sessionId: string; update: Record<string, unknown> & { sessionUpdate: string } };
		const chat = this._chatsBySessionId.get(params.sessionId);
		if (!chat?.turnId) {
			return;
		}
		const update = params.update;
		switch (update.sessionUpdate) {
			case 'agent_message_chunk':
			case 'agent_thought_chunk':
				this._appendText(chat, contentText(update.content) ?? '', update.sessionUpdate === 'agent_thought_chunk');
				return;
			case 'tool_call':
			case 'tool_call_update': {
				const toolCallId = String(update.toolCallId);
				const title = typeof update.title === 'string' ? update.title : this._definition.displayName;
				if (update.status === 'completed' || update.status === 'failed') {
					const output = Array.isArray(update.content) ? update.content.map(item => contentText((item as { content?: unknown }).content)).filter(Boolean).join('\n') : '';
					this._completeTool(chat, toolCallId, title, update.status === 'completed', output);
				} else {
					this._startTool(chat, toolCallId, title);
				}
				return;
			}
		}
	}

	private _handleRequest(request: IJsonRpcRequest): Promise<unknown> | unknown {
		if (request.method !== 'session/request_permission') {
			throw new JsonRpcError(-32601, `Unsupported method ${request.method}`);
		}
		const params = request.params as { sessionId: string; toolCall: { toolCallId: string; title?: string; rawInput?: unknown }; options: IAcpPermissionOption[] };
		const chat = this._chatsBySessionId.get(params.sessionId);
		if (!chat?.turnId) {
			return { outcome: { outcome: 'cancelled' } };
		}
		const toolCallId = params.toolCall.toolCallId;
		return new Promise(resolve => {
			this._pendingPermissions.set(toolCallId, { options: params.options, resolve });
			const input = params.toolCall.rawInput === undefined ? undefined : JSON.stringify(params.toolCall.rawInput, undefined, 2);
			this._requestConfirmation(chat, toolCallId, params.toolCall.title ?? this._definition.displayName, input);
		});
	}

	respondToPermissionRequest(toolCallId: string, approved: boolean): void {
		const pending = this._pendingPermissions.get(toolCallId);
		if (!pending) {
			return;
		}
		this._pendingPermissions.delete(toolCallId);
		const kinds = approved ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
		const option = kinds.map(kind => pending.options.find(candidate => candidate.kind === kind)).find(candidate => candidate !== undefined);
		pending.resolve(option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } });
	}

	private _failActiveTurns(message: string): void {
		for (const chat of this._chats.values()) {
			if (chat.turnId) {
				this._failTurn(chat, chat.turnId, 'acp_exited', message);
			}
		}
		for (const pending of this._pendingPermissions.values()) {
			pending.resolve({ outcome: { outcome: 'cancelled' } });
		}
		this._pendingPermissions.clear();
	}

	// #endregion

	async shutdown(): Promise<void> {
		this._connectionStore.clear();
		this._connection = undefined;
	}
}

/** A model offered by an ACP agent. Its `<provider>/<model>` id sets the picker tab, so the name drops the same prefix. */
function toAcpModel(provider: string, option: IAcpSelectOption, current: string | undefined, thinking: { readonly levels: readonly string[]; readonly current?: string } | undefined): IAgentModelInfo {
	const modelProvider = option.value.slice(0, option.value.indexOf('/') + 1);
	const configSchema = thinking && createThinkingLevelSchema(thinking.levels, thinking.current);
	return {
		provider,
		id: option.value,
		name: option.name.startsWith(modelProvider) ? option.name.slice(modelProvider.length) : option.name,
		supportsVision: false,
		...(configSchema ? { configSchema } : {}),
		...(option.value === current ? { _meta: { [AGENT_DEFAULT_MODEL_META_KEY]: true } } : {}),
	};
}

/** Text of an ACP content block (`{ type: 'text', text }`), or `undefined` for other kinds. */
function contentText(content: unknown): string | undefined {
	const block = content as { type?: unknown; text?: unknown } | undefined;
	return block?.type === 'text' && typeof block.text === 'string' ? block.text : undefined;
}
