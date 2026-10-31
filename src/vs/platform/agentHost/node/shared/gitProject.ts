/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../base/common/network.js';
import { basename } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import type { IAgentSessionProjectInfo } from '../../common/agent.js';
import { tryResolvePrimaryWorktreeRoot, type IAgentHostGitService } from '../../common/agentHostGitService.js';

/** Resolves the git project of a local working directory, preferring the primary checkout of a linked worktree. */
export async function resolveGitProject(workingDirectory: URI | undefined, gitService: IAgentHostGitService): Promise<IAgentSessionProjectInfo | undefined> {
	if (!workingDirectory || workingDirectory.scheme !== Schemas.file) {
		return undefined;
	}

	const repositoryRoot = await gitService.getRepositoryRoot(workingDirectory);
	if (!repositoryRoot) {
		return undefined;
	}

	const uri = await tryResolvePrimaryWorktreeRoot(gitService, repositoryRoot) ?? repositoryRoot;
	return { uri, displayName: basename(uri.fsPath) || uri.toString() };
}
