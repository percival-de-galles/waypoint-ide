/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { IAgentHostChatContribution, IAgentHostChatContributionContext, IOutgoingTurn, ISendContribution } from '../../../common/agentHostChatContributionsService.js';
import { ChatOriginKind } from '../../../common/state/protocol/state.js';
import { buildDefaultChatUri } from '../../../common/state/sessionState.js';
import { IAgentHostProviderService } from '../../agentHostProviderService.js';
import { IAgentHostStateManager, AgentHostStateManager } from '../../agentHostStateManager.js';
import { buildBoundedSideChatSourceContext } from '../sideChat/sideChatContext.js';

/**
 * Hands a session's conversation to a chat that runs on a different agent: the first
 * message of that chat carries the session's main conversation (bounded, as a side chat
 * carries its source), so the new agent continues the work instead of starting cold.
 * Each agent keeps its own native session; the workspace and its changes are shared.
 *
 * shortcut: the handed-off context stays in the receiving agent's own history; strip it on restore (as side chats do) if it proves noisy.
 */
export class AgentHandoffContribution extends Disposable implements IAgentHostChatContribution {

	static readonly id = 'agentHandoff';
	readonly order = 510;

	constructor(
		protected readonly _context: IAgentHostChatContributionContext,
		@IAgentHostStateManager private readonly _stateManager: AgentHostStateManager,
		@IAgentHostProviderService private readonly _providerService: IAgentHostProviderService,
	) {
		super();
	}

	onOutgoingTurn(turn: IOutgoingTurn): ISendContribution | undefined {
		const mainChat = buildDefaultChatUri(turn.session);
		if (turn.chat === mainChat
			|| this._stateManager.getChatOrigin(turn.chat)?.kind === ChatOriginKind.SideChat
			|| (this._stateManager.getChatState(turn.chat)?.turns.length ?? 0) > 0) {
			return undefined;
		}
		const agent = this._providerService.getProviderForChat(turn.session, turn.chat);
		const mainAgent = this._providerService.getProviderForSession(turn.session);
		if (!agent || !mainAgent || agent === mainAgent) {
			return undefined;
		}
		const turns = this._stateManager.getChatState(mainChat)?.turns ?? [];
		const context = turns.length ? buildBoundedSideChatSourceContext(turns, turns[turns.length - 1].id) : undefined;
		return context ? { text: injectHandoffContext(turn.message.text, mainAgent.getDescriptor().displayName, context) } : undefined;
	}
}

export function injectHandoffContext(prompt: string, previousAgent: string, conversation: string): string {
	return [
		`You are taking over a task that ${previousAgent} has been working on in this workspace. The conversation so far is below; the workspace already contains its changes.`,
		'',
		'<previous-conversation>',
		conversation,
		'</previous-conversation>',
		'',
		prompt,
	].join('\n');
}
