/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { constObservable } from '../../../../base/common/observable.js';
import type { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { buildUncommittedChangesetUri } from '../../common/changesetUri.js';
import { buildChatUri, buildDefaultChatUri, SessionStatus, withSessionGitState, type ISessionFileDiff } from '../../common/state/sessionState.js';
import type { IAgentHostGitService, IBranch, IDefaultBranch } from '../../common/agentHostGitService.js';
import { AgentHostCommitOperationHandler } from '../../node/agentHostCommitOperationHandler.js';
import { createTestGitHubEndpointService } from './testGitHubEndpointService.js';
import { AgentHostStateManager, creationTimeChatStorageResource } from '../../node/agentHostStateManager.js';
import { AgentHostUtilityModelUnavailableError, AgentHostUtilityModelUnavailableReason, type IAgentHostUtilityModelContext, type IAgentHostUtilityModelService, type IUtilityChatCompletionOptions, type IUtilityChatCompletionRequest } from '../../node/agentHostUtilityModelService.js';
import { ChangesSummary } from '../../common/state/protocol/state.js';
import type { IAgentHostChangesetService, StaticChangesetKind } from '../../common/agentHostChangesetService.js';
import { AgentHostAuthenticationService, type IAgentHostAuthenticationService } from '../../node/agentHostAuthenticationService.js';

class TestGitService implements IAgentHostGitService {
	declare readonly _serviceBrand: undefined;

	readonly calls: string[] = [];
	readonly workingDirectories: string[] = [];
	uncommitted = true;
	currentBranchName: string | undefined = 'feature/test';
	currentBranch: string | undefined = 'feature/test';
	diffs: readonly ISessionFileDiff[] | undefined = [{
		after: { uri: 'file:///repo/file.ts', content: { uri: 'file:///repo/file.ts' } },
		diff: { added: 1, removed: 0 },
	}];

	async getCurrentBranch(): Promise<string | undefined> { return this.currentBranch; }
	async getHEAD(): Promise<IBranch | undefined> { return undefined; }
	async getCurrentBranchName(): Promise<string | undefined> { return this.currentBranchName; }
	async getDefaultBranch(): Promise<IDefaultBranch | undefined> { return { name: 'main', startPoint: 'main' }; }
	async getDefaultBranch2(): Promise<IBranch | undefined> { return undefined; }
	async getBranch(): Promise<IBranch | undefined> { return undefined; }
	async getRefs(): Promise<IBranch[]> { return []; }
	async getBranches(): Promise<IBranch[]> { return []; }
	hasGitRoot() { return constObservable(undefined); }
	async getRepositoryRoot(): Promise<URI | undefined> { return URI.file('/repo'); }
	async getWorktreeRoots(): Promise<URI[]> { return []; }
	async getWorktrees() { return []; }
	async addWorktree(): Promise<void> { }
	async copyWorktreeIncludeFiles(): Promise<void> { }
	async symlinkWorktreeFolders(): Promise<readonly string[]> { return []; }
	async addExistingWorktree(): Promise<void> { }
	async isWorktreeRegistered(): Promise<boolean> { return true; }
	async removeWorktree(): Promise<void> { }
	async branchExists(): Promise<boolean> { return false; }
	async createBranch(): Promise<void> { }
	async checkout(): Promise<void> { }
	async hasUncommittedChanges(workingDirectory: URI): Promise<boolean> {
		this.calls.push('hasUncommittedChanges');
		this.workingDirectories.push(workingDirectory.toString());
		return this.uncommitted;
	}
	async createStash(): Promise<void> { }
	async commitAll(workingDirectory: URI, message: string): Promise<void> {
		this.calls.push(`commitAll:${message}`);
		this.workingDirectories.push(workingDirectory.toString());
		this.uncommitted = false;
	}
	async mergeBranch(): Promise<string> { return ''; }
	async restore(): Promise<void> { }
	async hasUpstream(): Promise<boolean> { return false; }
	async fetch(): Promise<void> { }
	async pull(): Promise<void> { }
	async push(): Promise<void> { }
	async getSessionGitState(): Promise<undefined> { return undefined; }
	async computeSessionFileDiffs(workingDirectory: URI): Promise<readonly ISessionFileDiff[] | undefined> {
		this.calls.push('computeSessionFileDiffs');
		this.workingDirectories.push(workingDirectory.toString());
		return this.diffs;
	}
	async showBlob(): Promise<undefined> { return undefined; }
	async captureWorkingTreeAsTree(): Promise<undefined> { return undefined; }
	async commitTree(): Promise<undefined> { return undefined; }
	async updateRef(): Promise<void> { }
	async deleteRefs(): Promise<void> { }
	async revParse(): Promise<string | undefined> { return undefined; }
	async resolveBranchBaselineCommit(): Promise<string | undefined> { return undefined; }
	async overlayPathIntoTree(): Promise<string | undefined> { return undefined; }
	async diffTreePaths(): Promise<string[] | undefined> { return undefined; }
	async computeFileDiffsBetweenRefs(): Promise<readonly ISessionFileDiff[] | undefined> { return undefined; }
	async getFetchRemoteUrls(): Promise<undefined> { return undefined; }
	async getFetchRemotes(): Promise<undefined> { return undefined; }
	async getUntrackedPaths(): Promise<[]> { return []; }
	async getBranchDiffSafetyInfo(): Promise<undefined> { return undefined; }
	async getDiffPatchBetweenRefs(): Promise<undefined> { return undefined; }
}

class TestUtilityModelService implements IAgentHostUtilityModelService {
	declare readonly _serviceBrand: undefined;

	readonly calls: { context: IAgentHostUtilityModelContext; request: IUtilityChatCompletionRequest; options?: IUtilityChatCompletionOptions }[] = [];
	response = '```text\nUpdate session changes\n```';
	error: Error | undefined;

	async chatCompletion(context: IAgentHostUtilityModelContext, request: IUtilityChatCompletionRequest, options?: IUtilityChatCompletionOptions): Promise<string> {
		this.calls.push({ context, request, options });
		if (this.error) {
			throw this.error;
		}
		return this.response;
	}
}

class TestChangesetService implements IAgentHostChangesetService {
	declare readonly _serviceBrand: undefined;

	readonly calls: string[] = [];
	registerStaticChangesets(): void { }
	restoreStaticChangeset(_session: string, _kind: StaticChangesetKind, _diffs: readonly ISessionFileDiff[]): void { }
	persistChangesSummary(_sessionUri: string, _summary: ChangesSummary): void { }
	isStaticChangesetComputeActive(): boolean { return false; }
	getListMetadataKeys(_sessionUri: string): Record<string, true> | undefined { return undefined; }
	computeListEntryChanges(_sessionUri: string, _metadata: Record<string, string | undefined>): ChangesSummary | undefined { return undefined; }
	refreshChangesetCatalog(session: string): void { this.calls.push(`refreshChangesets:${session}`); }
	refreshBranchChangeset(session: string): void { this.calls.push(`refreshBranch:${session}`); }
	refreshSessionChangeset(session: string): void { this.calls.push(`refreshSession:${session}`); }
	refreshWorkingSetChangeset(): void { }
	onWorkingDirectoryAvailable(_session: string): void { }
	recomputeSubscribedChangesets(_session: string): void { }
	async computeUncommittedChangeset(session: string): Promise<string> { this.calls.push(`computeUncommitted:${session}`); return `${session}/changeset/uncommitted`; }
	async computeTurnChangeset(_session: string, _turnId: string): Promise<string> { return ''; }
	async computeCompareTurnsChangeset(_session: string, _originalTurnId: string, _modifiedTurnId: string): Promise<string> { return ''; }
	onToolCallEditsApplied(_session: string, _turnId: string): void { }
	onTurnComplete(_session: string, _turnId: string | undefined): void { }
	onSessionTruncated(_session: string): void { }
	openTrackedTurnDatabase(): undefined { return undefined; }
	openTrackedSessionDatabases() { return { sources: [], otherChatDatabases: [], workingDirectories: undefined, folderScope: undefined, dispose: () => { } }; }
	onFileEditsDiscarded(): void { }
	onFileEditsAccepted(): void { }
	ensureChatChangesSummary(): void { }
	refreshChatChangesSummary(): void { }
}

function createAuthenticationService(disposables: Pick<DisposableStore, 'add'>, token: string | undefined): IAgentHostAuthenticationService {
	return disposables.add(new class extends AgentHostAuthenticationService {
		override getAuthToken(request: Parameters<IAgentHostAuthenticationService['getAuthToken']>[0], source?: Parameters<IAgentHostAuthenticationService['getAuthToken']>[1]) {
			return source ? source.getCredential(request)?.token : token;
		}
	}(new NullLogService()));
}

function setup(disposables: Pick<DisposableStore, 'add'>, gitService: TestGitService, utilityModelService: TestUtilityModelService, changesets: TestChangesetService, options?: { readonly onCommittedError?: Error }): { handler: AgentHostCommitOperationHandler; session: URI; stateManager: AgentHostStateManager; committedSessions: string[] } {
	const stateManager = disposables.add(new AgentHostStateManager(new NullLogService()));
	const session = URI.parse('agent:/session');
	const committedSessions: string[] = [];
	stateManager.createSession({
		resource: session.toString(),
		provider: 'copilot',
		title: 'Session',
		status: SessionStatus.Idle,
		createdAt: new Date(1).toISOString(),
		modifiedAt: new Date(1).toISOString(),
		workingDirectories: [URI.file('/repo').toString()],
		defaultChat: buildDefaultChatUri(session.toString()),
	});
	stateManager.setSessionMeta(session.toString(), withSessionGitState(undefined, {
		branchName: 'feature/test',
		uncommittedChanges: 1,
	}));
	return {
		handler: new AgentHostCommitOperationHandler(sessionKey => stateManager.getSessionState(sessionKey), async sessionKey => {
			committedSessions.push(sessionKey);
			changesets.calls.push(`onCommitted:${sessionKey}`);
			if (options?.onCommittedError) {
				throw options.onCommittedError;
			}
		}, createAuthenticationService(disposables, 'gh-repo-token'), createTestGitHubEndpointService(), gitService, utilityModelService, new NullLogService(), stateManager),
		session,
		stateManager,
		committedSessions,
	};
}

suite('AgentHostCommitOperationHandler', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();


	test('generates a commit message, commits all changes, and invokes post-commit refresh', async () => {
		const gitService = new TestGitService();
		const utilityModelService = new TestUtilityModelService();
		const changesets = new TestChangesetService();
		const { handler, session, committedSessions } = setup(disposables, gitService, utilityModelService, changesets);

		const result = await handler.invoke({ channel: buildUncommittedChangesetUri(buildDefaultChatUri(session.toString())), operationId: AgentHostCommitOperationHandler.OPERATION_COMMIT }, CancellationToken.None);

		assert.deepStrictEqual({
			message: result.message,
			gitCalls: gitService.calls,
			completion: utilityModelService.calls.map(call => ({ session: call.context.session, fileIncluded: call.request.messages.some(message => message.content.includes('file.ts')) })),
			changesetCalls: changesets.calls,
			committedSessions,
		}, {
			message: { markdown: 'Committed changes with message: `Update session changes`' },
			gitCalls: ['hasUncommittedChanges', 'computeSessionFileDiffs', 'commitAll:Update session changes'],
			completion: [{ session: session.toString(), fileIncluded: true }],
			changesetCalls: [`onCommitted:${buildDefaultChatUri(session.toString())}`],
			committedSessions: [buildDefaultChatUri(session.toString())],
		});
	});

	test('runs and refreshes a peer-chat operation in the peer working directory', async () => {
		const gitService = new TestGitService();
		const changesets = new TestChangesetService();
		const { handler, session, stateManager, committedSessions } = setup(disposables, gitService, new TestUtilityModelService(), changesets);
		const peer = buildChatUri(session.toString(), 'peer');
		stateManager.addChat(session.toString(), peer, creationTimeChatStorageResource(session.toString(), peer, buildDefaultChatUri(session.toString())), { workingDirectories: [URI.file('/peer-repo').toString()] });

		await handler.invoke({ channel: buildUncommittedChangesetUri(peer), operationId: AgentHostCommitOperationHandler.OPERATION_COMMIT }, CancellationToken.None);

		assert.deepStrictEqual({
			workingDirectories: gitService.workingDirectories,
			committedSessions,
		}, {
			workingDirectories: ['file:///peer-repo', 'file:///peer-repo', 'file:///peer-repo'],
			committedSessions: [peer],
		});
	});

	test('commits changes from a detached HEAD', async () => {
		const gitService = new TestGitService();
		gitService.currentBranchName = undefined;
		gitService.currentBranch = 'abc1234';
		const utilityModelService = new TestUtilityModelService();
		const changesets = new TestChangesetService();
		const { handler, session } = setup(disposables, gitService, utilityModelService, changesets);

		const result = await handler.invoke({ channel: buildUncommittedChangesetUri(session.toString()), operationId: AgentHostCommitOperationHandler.OPERATION_COMMIT }, CancellationToken.None);

		assert.deepStrictEqual({
			message: result.message,
			prompt: utilityModelService.calls[0]?.request.messages[1]?.content,
			gitCalls: gitService.calls,
		}, {
			message: { markdown: 'Committed changes with message: `Update session changes`' },
			prompt: `Repository: repo\nBranch: abc1234\nChanged files:\n- Create: ${URI.file('/repo/file.ts').fsPath} (+1 -0)`,
			gitCalls: ['hasUncommittedChanges', 'computeSessionFileDiffs', 'commitAll:Update session changes'],
		});
	});

	test('returns no-op success without generating a message or committing when the working tree is clean', async () => {
		const gitService = new TestGitService();
		gitService.uncommitted = false;
		const utilityModelService = new TestUtilityModelService();
		const changesets = new TestChangesetService();
		const { handler, session } = setup(disposables, gitService, utilityModelService, changesets);

		const result = await handler.invoke({ channel: buildUncommittedChangesetUri(session.toString()), operationId: AgentHostCommitOperationHandler.OPERATION_COMMIT }, CancellationToken.None);

		assert.deepStrictEqual({ message: result.message, gitCalls: gitService.calls, completionCalls: utilityModelService.calls.length, changesetCalls: changesets.calls }, {
			message: { markdown: 'No uncommitted changes to commit.' },
			gitCalls: ['hasUncommittedChanges'],
			completionCalls: 0,
			changesetCalls: [],
		});
	});

	test('returns success when post-commit refresh fails', async () => {
		const gitService = new TestGitService();
		const utilityModelService = new TestUtilityModelService();
		const changesets = new TestChangesetService();
		const { handler, session, committedSessions } = setup(disposables, gitService, utilityModelService, changesets, { onCommittedError: new Error('refresh failed') });

		const result = await handler.invoke({ channel: buildUncommittedChangesetUri(session.toString()), operationId: AgentHostCommitOperationHandler.OPERATION_COMMIT }, CancellationToken.None);

		assert.deepStrictEqual({
			message: result.message,
			gitCalls: gitService.calls,
			changesetCalls: changesets.calls,
			committedSessions,
		}, {
			message: { markdown: 'Committed changes with message: `Update session changes`' },
			gitCalls: ['hasUncommittedChanges', 'computeSessionFileDiffs', 'commitAll:Update session changes'],
			changesetCalls: ['onCommitted:agent:/session'],
			committedSessions: ['agent:/session'],
		});
	});

	test('honors cancellation before mutating the repository', async () => {
		const gitService = new TestGitService();
		const utilityModelService = new TestUtilityModelService();
		const changesets = new TestChangesetService();
		const { handler, session } = setup(disposables, gitService, utilityModelService, changesets);
		const cts = disposables.add(new CancellationTokenSource());
		cts.cancel();

		await assert.rejects(
			() => handler.invoke({ channel: buildUncommittedChangesetUri(session.toString()), operationId: AgentHostCommitOperationHandler.OPERATION_COMMIT }, cts.token),
			/Commit operation was cancelled/,
		);

		assert.deepStrictEqual({ gitCalls: gitService.calls, completionCalls: utilityModelService.calls.length, changesetCalls: changesets.calls }, {
			gitCalls: [],
			completionCalls: 0,
			changesetCalls: [],
		});
	});

	test('reports an unavailable utility model without committing', async () => {
		const gitService = new TestGitService();
		const utilityModelService = new TestUtilityModelService();
		utilityModelService.error = new AgentHostUtilityModelUnavailableError(AgentHostUtilityModelUnavailableReason.NotConfigured);
		const changesets = new TestChangesetService();
		const { handler, session, committedSessions } = setup(disposables, gitService, utilityModelService, changesets);

		await assert.rejects(
			() => handler.invoke({ channel: buildUncommittedChangesetUri(session.toString()), operationId: AgentHostCommitOperationHandler.OPERATION_COMMIT }, CancellationToken.None),
			/No utility model is available to generate a commit message/,
		);

		assert.deepStrictEqual({
			gitCalls: gitService.calls,
			completionCalls: utilityModelService.calls.length,
			changesetCalls: changesets.calls,
			committedSessions,
		}, {
			gitCalls: ['hasUncommittedChanges', 'computeSessionFileDiffs'],
			completionCalls: 1,
			changesetCalls: [],
			committedSessions: [],
		});
	});

});
