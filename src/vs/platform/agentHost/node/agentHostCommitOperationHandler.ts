/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../../base/common/resources.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { captureCredentialSource, type IAgentHostCredentialSource } from '../common/agentHostCredentials.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { IAgentHostAuthenticationService } from './agentHostAuthenticationService.js';
import { IAgentHostGitHubEndpointService } from './agentHostGitHubEndpointService.js';
import { parseChangesetUri } from '../common/changesetUri.js';
import { AGENT_HOST_COMMIT_CHANGESET_OPERATION_ID, type IChangesetOperationHandler } from '../common/agentHostChangesetOperationService.js';
import type { InvokeChangesetOperationParams, InvokeChangesetOperationResult } from '../common/state/protocol/channels-changeset/commands.js';
import { AHP_SESSION_NOT_FOUND, JsonRpcErrorCodes, ProtocolError } from '../common/state/sessionProtocol.js';
import { type ISessionFileDiff, type SessionState } from '../common/state/sessionState.js';
import { ILogService } from '../../log/common/log.js';
import { IAgentHostGitService } from '../common/agentHostGitService.js';
import { AgentHostUtilityModelUnavailableError, IAgentHostUtilityModelService, type IUtilityChatMessage } from './agentHostUtilityModelService.js';
import { AgentHostStateManager, IAgentHostStateManager } from './agentHostStateManager.js';
import { resolveChangesetOwnerScope } from './agentHostBranchChangesetScope.js';

const MAX_CHANGE_SUMMARY_PROMPT_CHARS = 20_000;

export class AgentHostCommitOperationHandler implements IChangesetOperationHandler {

	public static readonly OPERATION_COMMIT = AGENT_HOST_COMMIT_CHANGESET_OPERATION_ID;

	constructor(
		private readonly _getSessionState: (sessionKey: string) => SessionState | undefined,
		private readonly _onCommitted: (sessionKey: string, source?: IAgentHostCredentialSource) => Promise<void>,
		@IAgentHostAuthenticationService private readonly _authenticationService: IAgentHostAuthenticationService,
		@IAgentHostGitHubEndpointService private readonly _gitHubEndpointService: IAgentHostGitHubEndpointService,
		@IAgentHostGitService private readonly _gitService: IAgentHostGitService,
		@IAgentHostUtilityModelService private readonly _utilityModelService: IAgentHostUtilityModelService,
		@ILogService private readonly _logService: ILogService,
		@IAgentHostStateManager private readonly _stateManager: AgentHostStateManager,
	) { }

	async invoke(params: InvokeChangesetOperationParams, token: CancellationToken, source?: IAgentHostCredentialSource): Promise<InvokeChangesetOperationResult> {
		source = this.captureCredentialSource(params, source);
		const abortController = new AbortController();
		if (token.isCancellationRequested) {
			abortController.abort();
		}
		const cancellationListener = token.onCancellationRequested(() => abortController.abort());
		try {
			return await this._invoke(params, token, abortController.signal, source);
		} finally {
			cancellationListener.dispose();
		}
	}

	captureCredentialSource(params: InvokeChangesetOperationParams, source?: IAgentHostCredentialSource): IAgentHostCredentialSource | undefined {
		const parsed = parseChangesetUri(params.channel);
		const scope = parsed ? resolveChangesetOwnerScope(this._stateManager, parsed.ownerUri) : undefined;
		source ??= scope ? this._authenticationService.getSessionCredentialSource(scope.sourceUri) : undefined;
		const rawSource = source;
		return rawSource ? captureCredentialSource({
			principal: rawSource.principal,
			getCredential: request => rawSource.getCredential({ ...request, session: scope?.sessionUri }),
		}, [this._gitHubEndpointService.getRepoResource(), { ...this._gitHubEndpointService.getCopilotResource(), required: false }]) : undefined;
	}

	private async _invoke(params: InvokeChangesetOperationParams, token: CancellationToken, signal: AbortSignal, source?: IAgentHostCredentialSource): Promise<InvokeChangesetOperationResult> {
		const parsed = parseChangesetUri(params.channel);
		if (!parsed) {
			throw new ProtocolError(JsonRpcErrorCodes.InvalidParams, `Not an uncommitted changeset URI: ${params.channel}`);
		}
		this._throwIfCancelled(token);

		const scope = resolveChangesetOwnerScope(this._stateManager, parsed.ownerUri);
		const sessionUri = scope.sessionUri;
		const sessionState = this._getSessionState(scope.sourceUri);
		if (!sessionState) {
			throw new ProtocolError(AHP_SESSION_NOT_FOUND, `Session not found: ${sessionUri}`);
		}

		const workingDirectoryStr = scope.workingDirectories[0];
		if (!workingDirectoryStr) {
			throw new ProtocolError(JsonRpcErrorCodes.InternalError, `Changeset owner has no working directory: ${parsed.ownerUri}`);
		}
		const workingDirectory = URI.parse(workingDirectoryStr);

		if (!await this._gitService.getRepositoryRoot(workingDirectory)) {
			throw new ProtocolError(JsonRpcErrorCodes.InternalError, localize('agentHost.changeset.commit.notGitRepository', "Changeset owner's working directory is not a Git repository: {0}", sessionUri));
		}
		const branchName = (await this._gitService.getCurrentBranchName?.(workingDirectory))
			?? await this._gitService.getCurrentBranch(workingDirectory);

		const hasUncommitted = await this._gitService.hasUncommittedChanges(workingDirectory);
		if (!hasUncommitted) {
			return { message: { markdown: localize('agentHost.changeset.commit.noChanges', "No uncommitted changes to commit.") } };
		}
		this._throwIfCancelled(token);

		const diffs = await this._gitService.computeSessionFileDiffs(workingDirectory, { sessionUri: scope.sourceUri });
		if (!diffs || diffs.length === 0) {
			throw new ProtocolError(JsonRpcErrorCodes.InternalError, localize('agentHost.changeset.commit.diffFailed', "Could not compute uncommitted changes to generate a commit message."));
		}
		this._throwIfCancelled(token);

		let message: string;
		try {
			message = this._cleanCommitMessage(await this._utilityModelService.chatCompletion({ session: sessionUri, credentialSource: source }, {
				messages: this._buildCommitMessagePrompt(workingDirectory, branchName, diffs),
			}, { signal }));
		} catch (err) {
			this._throwIfCancelled(token);
			if (err instanceof AgentHostUtilityModelUnavailableError) {
				throw new ProtocolError(JsonRpcErrorCodes.InternalError, localize('agentHost.changeset.commit.utilityModelUnavailable', "No utility model is available to generate a commit message. Configure {0} and try again.", 'chat.utilitySmallModel'));
			}
			throw err;
		}
		if (!message) {
			throw new ProtocolError(JsonRpcErrorCodes.InternalError, localize('agentHost.changeset.commit.emptyMessage', "Generated commit message was empty."));
		}
		this._throwIfCancelled(token);

		this._logService.info(`[AgentHostCommitOperationHandler] Committing uncommitted changes for ${parsed.ownerUri}`);
		try {
			await this._gitService.commitAll(workingDirectory, message);
		} catch (err) {
			this._throwIfCancelled(token);
			throw new ProtocolError(JsonRpcErrorCodes.InternalError, `Failed to commit changes: ${err instanceof Error ? err.message : String(err)}`);
		}

		try {
			await this._onCommitted(parsed.ownerUri, source);
		} catch (err) {
			this._logService.warn(`[AgentHostCommitOperationHandler] Post-commit refresh failed for ${parsed.ownerUri}: ${err instanceof Error ? err.message : String(err)}`);
		}

		return { message: { markdown: localize('agentHost.changeset.commit.committed', "Committed changes with message: `{0}`", message.split('\n')[0]) } };
	}

	private _buildCommitMessagePrompt(workingDirectory: URI, branchName: string | undefined, diffs: readonly ISessionFileDiff[]): IUtilityChatMessage[] {
		const changeSummary = this._summarizeDiffsForPrompt(diffs);
		return [
			{
				role: 'system',
				content: [
					'You generate concise Git commit messages.',
					'Return only the commit message text, with no markdown or code fences.',
					'Use imperative mood. Keep the subject line under 72 characters.',
					'Add a body only when it helps explain multiple related changes.',
				].join(' '),
			},
			{
				role: 'user',
				content: [
					`Repository: ${basename(workingDirectory)}`,
					`Branch: ${branchName ?? 'unknown'}`,
					'Changed files:',
					changeSummary,
				].join('\n'),
			},
		];
	}

	private _summarizeDiffsForPrompt(diffs: readonly ISessionFileDiff[]): string {
		const lines: string[] = [];
		for (const diff of diffs) {
			const before = diff.before?.uri;
			const after = diff.after?.uri;
			const path = after ?? before ?? '(unknown)';
			let kind = 'Edit';
			if (!before && after) {
				kind = 'Create';
			} else if (before && !after) {
				kind = 'Delete';
			} else if (before && after && before !== after) {
				kind = 'Rename';
			}
			lines.push(`- ${kind}: ${this._displayUri(path)} (+${diff.diff?.added ?? 0} -${diff.diff?.removed ?? 0})`);
			if (lines.join('\n').length > MAX_CHANGE_SUMMARY_PROMPT_CHARS) {
				lines.push('[file list truncated]');
				break;
			}
		}
		return lines.join('\n');
	}

	private _displayUri(uri: string): string {
		try {
			const parsed = URI.parse(uri);
			return parsed.scheme === 'file' ? parsed.fsPath : parsed.path || uri;
		} catch {
			return uri;
		}
	}

	private _cleanCommitMessage(raw: string): string {
		let text = raw.trim().replace(/\r\n/g, '\n');
		const fenced = /^```(?:text|gitcommit)?\s*([\s\S]*?)\s*```$/i.exec(text);
		if (fenced) {
			text = fenced[1].trim();
		}
		return text;
	}

	private _throwIfCancelled(token: CancellationToken): void {
		if (token.isCancellationRequested) {
			throw new ProtocolError(JsonRpcErrorCodes.InternalError, localize('agentHost.changeset.commit.cancelled', "Commit operation was cancelled."));
		}
	}
}
