/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../instantiation/common/instantiation.js';

/**
 * Branch-name prefix for worktree-isolated agent sessions, e.g.
 * `agents/add-feature`. Shared by every agent-host provider via {@link WorktreeIsolation}.
 */
export const AGENT_BRANCH_PREFIX = 'agents/';
const AGENT_BRANCH_SESSION_ID_SUFFIX_LENGTH = 8;
const MAX_BRANCH_NAME_HINT_LENGTH = 48;
const MAX_BRANCH_NAME_CANDIDATES = 100;

export interface IAgentBranchNameGeneratorRequest {
	readonly sessionId: string;
	readonly message?: string;
	/**
	 * Optional prefix prepended before the built-in {@link AGENT_BRANCH_PREFIX}
	 * when constructing the branch name (e.g. the user's `git.branchPrefix`
	 * setting). An empty or omitted value preserves the historical
	 * `agents/<hint>` naming.
	 */
	readonly branchPrefix?: string;
	/**
	 * Optional predicate used to check whether a candidate branch name collides
	 * with an existing branch or its corresponding worktree path.
	 */
	readonly branchNameCollides?: (branchName: string) => Promise<boolean>;
}

export const IAgentBranchNameGenerator = createDecorator<IAgentBranchNameGenerator>('agentBranchNameGenerator');

export interface IAgentBranchNameGenerator {
	readonly _serviceBrand: undefined;
	generateBranchName(request: IAgentBranchNameGeneratorRequest): Promise<string>;
}

export class AgentBranchNameGenerator implements IAgentBranchNameGenerator {
	declare readonly _serviceBrand: undefined;

	async generateBranchName(request: IAgentBranchNameGeneratorRequest): Promise<string> {
		return this._buildBranchName(request, getAgentBranchNameHintFromMessage(request.message ?? ''));
	}

	private async _buildBranchName(request: IAgentBranchNameGeneratorRequest, branchNameHint: string | undefined): Promise<string> {
		// Prepend the caller-supplied prefix (e.g. `git.branchPrefix`) ahead of
		// the built-in `agents/` prefix. An empty/omitted value keeps the
		// historical `agents/<hint>` shape.
		const prefix = `${request.branchPrefix ?? ''}${AGENT_BRANCH_PREFIX}`;

		const branchName = `${prefix}${branchNameHint ?? request.sessionId}`;
		const collisionBase = branchNameHint
			? `${branchName}-${request.sessionId.substring(0, AGENT_BRANCH_SESSION_ID_SUFFIX_LENGTH)}`
			: branchName;
		for (let candidateIndex = 0; candidateIndex < MAX_BRANCH_NAME_CANDIDATES; candidateIndex++) {
			const candidate = candidateIndex === 0
				? branchName
				: branchNameHint && candidateIndex === 1
					? collisionBase
					: `${collisionBase}-${branchNameHint ? candidateIndex : candidateIndex + 1}`;
			if (!request.branchNameCollides || !await request.branchNameCollides(candidate)) {
				return candidate;
			}
		}

		throw new Error(`Unable to find an available branch name after checking ${MAX_BRANCH_NAME_CANDIDATES} candidates`);
	}
}

/**
 * Derive a slug-style branch-name hint from the user's first message. Used as
 * a local fallback when the utility branch name generation is unavailable.
 */
export function getAgentBranchNameHintFromMessage(message: string): string | undefined {
	const words = message
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.split('-')
		.filter(word => word.length > 0)
		.slice(0, 8);
	const hint = words.join('-').slice(0, MAX_BRANCH_NAME_HINT_LENGTH).replace(/-+$/g, '');
	return hint.length > 0 ? hint : undefined;
}
