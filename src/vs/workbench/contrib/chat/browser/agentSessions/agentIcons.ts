/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FileAccess } from '../../../../../base/common/network.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';

// The codicon font is copied from `@vscode/codicons` on every build, so these logos have their own.
const font = {
	id: 'agent-icons',
	definition: { src: [{ location: FileAccess.asBrowserUri('vs/workbench/contrib/chat/browser/agentSessions/media/agentIcons.ttf'), format: 'truetype' }] },
};

export const openCodeIcon = registerIcon('agent-opencode', { font, fontCharacter: '\\e001' }, localize('agentOpenCodeIcon', "Icon for the OpenCode agent."));
export const cursorIcon = registerIcon('agent-cursor', { font, fontCharacter: '\\e002' }, localize('agentCursorIcon', "Icon for the Cursor agent."));
export const piIcon = registerIcon('agent-pi', { font, fontCharacter: '\\e003' }, localize('agentPiIcon', "Icon for the Pi agent."));

/** The logo of a CLI agent, given its provider id or its `agent-host-<id>` session type. */
export function getCliAgentIcon(agent: string): ThemeIcon | undefined {
	switch (agent.replace(/^agent-host-/, '')) {
		case 'opencode': return openCodeIcon;
		case 'cursor': return cursorIcon;
		case 'pi': return piIcon;
		default: return undefined;
	}
}
