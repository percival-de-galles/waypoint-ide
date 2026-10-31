/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { IWorkbenchContribution } from '../../../../../common/contributions.js';
import { nullExtensionDescription } from '../../../../../services/extensions/common/extensions.js';
import { ChatAgentLocation, ChatModeKind } from '../../../common/constants.js';
import { IChatAgentService } from '../../../common/participants/chatAgents.js';

/**
 * Chat counts as enabled only while a default participant exists, and upstream only the
 * Copilot extension provides one. Agents run as session types, so this participant keeps
 * chat enabled and answers only a chat that reached no agent.
 */
export class AgentHostDefaultChatAgentContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.chat.agentHostDefaultChatAgent';

	constructor(@IChatAgentService chatAgentService: IChatAgentService) {
		super();
		const id = 'waypoint.default';
		this._register(chatAgentService.registerAgent(id, {
			id,
			name: 'Waypoint',
			isDefault: true,
			isCore: true,
			modes: [ChatModeKind.Ask, ChatModeKind.Edit, ChatModeKind.Agent],
			slashCommands: [],
			disambiguation: [],
			locations: [ChatAgentLocation.Chat, ChatAgentLocation.Terminal, ChatAgentLocation.Notebook, ChatAgentLocation.EditorInline],
			metadata: {},
			extensionId: nullExtensionDescription.identifier,
			extensionVersion: undefined,
			extensionDisplayName: nullExtensionDescription.name,
			extensionPublisherId: nullExtensionDescription.publisher,
		}));
		this._register(chatAgentService.registerAgentImplementation(id, {
			invoke: async (_request, progress) => {
				progress([{ kind: 'markdownContent', content: new MarkdownString(localize('agentHostDefaultChatAgent.pickAgent', "Waypoint chats run on an agent. Choose one with the agent picker below the chat input.")) }]);
				return {};
			},
		}));
	}
}
