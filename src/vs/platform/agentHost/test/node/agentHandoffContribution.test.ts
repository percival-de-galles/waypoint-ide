/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import type { IAgent } from '../../common/agent.js';
import type { IAgentHostChatContributionContext, IOutgoingTurn } from '../../common/agentHostChatContributionsService.js';
import { buildChatUri, buildDefaultChatUri, ResponsePartKind, type Turn } from '../../common/state/sessionState.js';
import { AgentHandoffContribution } from '../../node/chatContributions/agentHandoff/agentHandoffContribution.js';
import type { IAgentHostProviderService } from '../../node/agentHostProviderService.js';
import type { AgentHostStateManager } from '../../node/agentHostStateManager.js';

suite('AgentHandoffContribution', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const session = 'agent-session://claude/s1';
	const mainChat = buildDefaultChatUri(session);
	const peerChat = buildChatUri(session, 'peer');
	const claude = { getDescriptor: () => ({ displayName: 'Claude' }) } as IAgent;
	const codex = { getDescriptor: () => ({ displayName: 'Codex' }) } as IAgent;
	const mainTurns = [{ id: 't1', message: { text: 'Add a login page' }, responseParts: [{ kind: ResponsePartKind.Markdown, id: 'p1', content: 'Added src/login.ts' }] }] as unknown as Turn[];

	function contribution(peerAgent: IAgent, peerTurns: readonly Turn[] = []): AgentHandoffContribution {
		const stateManager = {
			getChatOrigin: () => undefined,
			getChatState: (chat: string) => ({ turns: chat === mainChat ? mainTurns : peerTurns }),
		} as unknown as AgentHostStateManager;
		const providers = {
			getProviderForSession: () => claude,
			getProviderForChat: (_session: string, chat: string) => chat === peerChat ? peerAgent : claude,
		} as unknown as IAgentHostProviderService;
		return store.add(new AgentHandoffContribution({} as IAgentHostChatContributionContext, stateManager, providers));
	}

	const send = (chat: string) => ({ session, chat, turnId: 'new', message: { text: 'Now add tests' } }) as unknown as IOutgoingTurn;

	test('the first message of a chat on another agent carries the main conversation', () => {
		const text = contribution(codex).onOutgoingTurn(send(peerChat))?.text ?? '';

		assert.deepStrictEqual({
			namesPreviousAgent: text.startsWith('You are taking over a task that Claude has been working on'),
			carriesRequest: text.includes('Add a login page'),
			carriesResponse: text.includes('Added src/login.ts'),
			endsWithPrompt: text.endsWith('Now add tests'),
		}, { namesPreviousAgent: true, carriesRequest: true, carriesResponse: true, endsWithPrompt: true });
	});

	test('nothing is added for the main chat, the same agent, or a later message', () => {
		assert.deepStrictEqual({
			mainChat: contribution(codex).onOutgoingTurn(send(mainChat)),
			sameAgent: contribution(claude).onOutgoingTurn(send(peerChat)),
			laterMessage: contribution(codex, mainTurns).onOutgoingTurn(send(peerChat)),
		}, { mainChat: undefined, sameAgent: undefined, laterMessage: undefined });
	});
});
