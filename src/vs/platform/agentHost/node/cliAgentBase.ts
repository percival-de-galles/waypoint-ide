/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import type { IAuthorizationProtectedResourceMetadata } from '../../../base/common/oauth.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';
import { AGENT_SDK_SETUP_RELOAD_REQUEST_KEY, agentSdkSetupStatusKey, isAgentSdkSetupRequestFor, type IAgentSdkSetupInfo } from '../common/agentSdkSetup.js';
import type { IAgentConfigurationService } from './agentConfigurationService.js';
import { resolveAgentChatContext, resolveAgentHostInstructions, type AgentChatMigrationResult, type AgentProvider, type AgentSignal, type IActiveClient, type IAgentActionSignal, type IAgentChatContext, type IAgentChatDataChange, type IAgentChatMetadata, type IAgentDescriptor, type IAgentDiscoveredChat } from '../common/agent.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../common/state/protocol/commands.js';
import type { ToolDefinition } from '../common/state/protocol/state.js';
import { ActionType } from '../common/state/sessionActions.js';
import { createErrorResponsePart, ResponsePartKind, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, type ClientPluginCustomization, type Customization } from '../common/state/sessionState.js';

/** One chat of a CLI agent: which protocol turn it is answering and which parts text appends to. */
export interface ICliAgentChat {
	readonly chat: URI;
	readonly session: URI;
	turnId?: string;
	textPartId?: string;
	reasoningPartId?: string;
	readonly startedToolCalls: Set<string>;
}

/** How a CLI agent describes itself. */
export interface ICliAgentDescription {
	readonly id: AgentProvider;
	readonly displayName: string;
	readonly description: string;
}

/**
 * Shared plumbing for agents that drive a user-installed CLI (ACP agents, Pi): the
 * host members these agents have no use for, and the translation of streamed text,
 * tool calls, confirmations and turn ends into Agent Host signals. Each subclass
 * owns its wire protocol.
 */
export abstract class CliAgentBase<TChat extends ICliAgentChat> extends Disposable {

	readonly agentHostCapabilities = { workspaceConversion: false } as const;

	protected readonly _onDidChatProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidChatProgress = this._onDidChatProgress.event;
	protected readonly _onDidChangeChatData = this._register(new Emitter<IAgentChatDataChange>());
	readonly onDidChangeChatData = this._onDidChangeChatData.event;
	readonly onDidMaterializeChat = Event.None;
	readonly onDidSpawnChat = Event.None;
	readonly onDidDiscoverChats = Event.None as Event<readonly IAgentDiscoveredChat[]>;

	protected readonly _chats = new Map<string, TChat>();

	constructor(protected readonly _description: ICliAgentDescription) {
		super();
	}

	/**
	 * Publishes this agent's setup status for the setup banner, now and whenever the banner
	 * asks it to look again (after an install or sign-in in a terminal).
	 */
	protected _publishSetup(configurationService: IAgentConfigurationService, read: () => Promise<Omit<IAgentSdkSetupInfo, 'agent'>>, onReload?: () => void): void {
		const publish = () => read().then(info => configurationService.publishRootTransientValues?.({ [agentSdkSetupStatusKey(this.id)]: info }), () => { });
		let lastRequest: string | undefined;
		this._register(configurationService.onDidRootConfigChange(() => {
			const request = configurationService.getRootConfigValues?.()[AGENT_SDK_SETUP_RELOAD_REQUEST_KEY];
			if (isAgentSdkSetupRequestFor(request, this.id) && request.request !== lastRequest) {
				lastRequest = request.request;
				configurationService.updateRootConfig({ [AGENT_SDK_SETUP_RELOAD_REQUEST_KEY]: undefined });
				void publish();
				onReload?.();
			}
		}));
		void publish();
	}

	/**
	 * Adds the only host instructions a CLI agent should get: how to behave in inline and
	 * terminal chat. The others rely on host tools it does not have (`rename_chat`, artifacts).
	 */
	protected _withSurfaceInstructions(prompt: string, context: URI | IAgentChatContext | undefined): string {
		const instructions = resolveAgentHostInstructions(context)?.filter(instruction => /^<(terminal_chat|editor_inline_chat)>/.test(instruction));
		return instructions?.length ? `${instructions.join('\n\n')}\n\n${prompt}` : prompt;
	}

	get id(): AgentProvider {
		return this._description.id;
	}

	getDescriptor(): IAgentDescriptor {
		// Every chat runs its own native session, so peer chats and side chats need nothing extra.
		return { provider: this.id, displayName: this._description.displayName, description: this._description.description, capabilities: { multipleChats: { sideChat: true } } };
	}

	/** Creates the subclass's record for a chat the host addresses for the first time. */
	protected abstract _createChat(chat: URI, session: URI): TChat;

	protected _chat(chatUri: URI, context: URI | IAgentChatContext | undefined): TChat {
		let chat = this._chats.get(chatUri.toString());
		if (!chat) {
			chat = this._createChat(chatUri, resolveAgentChatContext(context ?? chatUri, chatUri).owner.get());
			this._chats.set(chatUri.toString(), chat);
		}
		return chat;
	}

	/** Starts answering `turnId` in `chat`; text and tool signals follow until the turn ends. */
	protected _beginTurn(chat: TChat, turnId: string): void {
		chat.turnId = turnId;
		chat.textPartId = undefined;
		chat.reasoningPartId = undefined;
	}

	// #region Signals

	protected _fire(chat: TChat, action: IAgentActionSignal['action']): void {
		this._onDidChatProgress.fire({ kind: 'action', resource: chat.chat, action });
	}

	/** Appends streamed text to the turn's current markdown or reasoning part, starting one when needed. */
	protected _appendText(chat: TChat, text: string, reasoning: boolean): void {
		const turnId = chat.turnId;
		if (!turnId || !text) {
			return;
		}
		const partId = reasoning ? chat.reasoningPartId : chat.textPartId;
		if (partId) {
			this._fire(chat, reasoning
				? { type: ActionType.ChatReasoning, turnId, partId, content: text }
				: { type: ActionType.ChatDelta, turnId, partId, content: text });
			return;
		}
		const id = generateUuid();
		if (reasoning) {
			chat.reasoningPartId = id;
		} else {
			chat.textPartId = id;
		}
		this._fire(chat, { type: ActionType.ChatResponsePart, turnId, part: { kind: reasoning ? ResponsePartKind.Reasoning : ResponsePartKind.Markdown, id, content: text } });
	}

	protected _startTool(chat: TChat, toolCallId: string, title: string): void {
		const turnId = chat.turnId;
		if (!turnId || chat.startedToolCalls.has(toolCallId)) {
			return;
		}
		chat.startedToolCalls.add(toolCallId);
		this._fire(chat, { type: ActionType.ChatToolCallStart, turnId, toolCallId, toolName: title, displayName: title });
		this._fire(chat, { type: ActionType.ChatToolCallReady, turnId, toolCallId, invocationMessage: title, confirmed: ToolCallConfirmationReason.NotNeeded });
	}

	protected _completeTool(chat: TChat, toolCallId: string, title: string, success: boolean, output: string): void {
		const turnId = chat.turnId;
		if (!turnId) {
			return;
		}
		this._startTool(chat, toolCallId, title);
		// A tool ends the current text part; the next message chunk starts a new one.
		chat.textPartId = undefined;
		this._fire(chat, {
			type: ActionType.ChatToolCallComplete,
			turnId,
			toolCallId,
			result: {
				success,
				pastTenseMessage: title,
				content: output ? [{ type: ToolResultContentType.Text, text: output }] : [],
				...(success ? {} : { error: { message: output || localize('cliAgent.toolFailed', "The tool failed.") } }),
			},
		});
	}

	/** Asks the user to confirm a tool; the host answers through `respondToPermissionRequest(toolCallId, approved)`. */
	protected _requestConfirmation(chat: TChat, toolCallId: string, title: string, toolInput?: string): void {
		this._startTool(chat, toolCallId, title);
		this._onDidChatProgress.fire({
			kind: 'pending_confirmation',
			chat: chat.chat,
			state: { status: ToolCallStatus.PendingConfirmation, toolCallId, toolName: title, displayName: title, invocationMessage: title, toolInput, confirmationTitle: title },
		});
	}

	protected _endTurn(chat: TChat, turnId: string): void {
		if (chat.turnId === turnId) {
			this._fire(chat, { type: ActionType.ChatTurnComplete, turnId, duration: 0 });
			chat.turnId = undefined;
		}
	}

	protected _failTurn(chat: TChat, turnId: string, errorType: string, message: string): void {
		if (chat.turnId === turnId) {
			this._fire(chat, { type: ActionType.ChatError, turnId, duration: 0, part: createErrorResponsePart({ errorType, message }) });
			chat.turnId = undefined;
		}
	}

	// #endregion

	// #region Host members these agents have no use for

	getProtectedResources(): IAuthorizationProtectedResourceMetadata[] {
		return [];
	}

	async authenticate(): Promise<boolean> {
		return true;
	}

	async setWorkingDirectory(): Promise<void> {
		throw new Error(localize('cliAgent.noWorkingDirectoryChange', "{0} does not support changing the working directory of an existing session.", this._description.displayName));
	}

	getOrCreateActiveClient(_chat: URI, _context: URI | IAgentChatContext, client: { readonly clientId: string; readonly displayName?: string }): IActiveClient {
		let tools: readonly ToolDefinition[] = [];
		let customizations: readonly ClientPluginCustomization[] = [];
		return {
			clientId: client.clientId,
			displayName: client.displayName,
			get tools() { return tools; },
			set tools(value: readonly ToolDefinition[]) { tools = value; },
			get customizations() { return customizations; },
			set customizations(value: readonly ClientPluginCustomization[]) { customizations = value; },
		};
	}

	removeActiveClient(): void { }

	onClientToolCallComplete(): void { }

	respondToUserInputRequest(): void { }

	async resolveChatConfig(): Promise<ResolveSessionConfigResult> {
		return { schema: { type: 'object', properties: {} }, values: {} };
	}

	getInheritedChatConfig(): undefined {
		return undefined;
	}

	async chatConfigCompletions(): Promise<SessionConfigCompletionsResult> {
		return { items: [] };
	}

	async getChatCustomizations(_chat: URI): Promise<readonly Customization[]> {
		return [];
	}

	async listChatsToMigrate(): Promise<AgentChatMigrationResult> {
		return [];
	}

	async getChatMetadata(chatUri: URI): Promise<IAgentChatMetadata | undefined> {
		return this._chats.has(chatUri.toString()) ? { chat: chatUri, startTime: Date.now(), modifiedTime: Date.now() } : undefined;
	}

	// #endregion
}
