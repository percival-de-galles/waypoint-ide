/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentModelInfo } from '../agent.js';
import type { SessionModelInfo } from '../state/protocol/state.js';

/** `_meta` key marking the model the agent itself is configured to use by default. */
export const AGENT_DEFAULT_MODEL_META_KEY = 'agentDefaultModel';

/** Whether the agent marked this model as its configured default. */
export function isAgentDefaultModel(model: IAgentModelInfo | SessionModelInfo): boolean {
	return model._meta?.[AGENT_DEFAULT_MODEL_META_KEY] === true;
}
