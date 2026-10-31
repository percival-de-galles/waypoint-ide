/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../base/common/async.js';
import { ChatProvidersConfigKey } from '../../common/agentHostChatProviders.js';
import { hasKey } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { platformSessionSchema } from '../../common/agentHostSchema.js';
import { AgentHostSandboxKey } from '../../common/sandboxConfigSchema.js';
import { readSessionSandboxPolicy } from '../../common/meta/agentSandboxPolicyMeta.js';
import { readChatSandboxState, readChatSandboxStates, readSessionSandboxState, withChatSandboxState, withSessionSandboxState } from '../../common/meta/agentSandboxStateMeta.js';
import { omitTransientSessionConfigValues, SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { buildChatUri, buildDefaultChatUri, buildSubagentSessionUri, ChatOriginKind, MessageKind, SessionStatus, ToolCallStatus } from '../../common/state/sessionState.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { AgentConfigurationService } from '../../node/agentConfigurationService.js';
import { AgentHostStateManager, creationTimeChatStorageResource } from '../../node/agentHostStateManager.js';
import { getSessionSandboxConfig, getSessionSandboxOverrides } from '../../node/sessionSandbox.js';
import { getEffectiveChatConfig } from '../../common/sessionConfigProperties.js';
import { SessionPermissionManager } from '../../node/sessionPermissions.js';
import { createSessionDataService } from '../common/sessionTestHelpers.js';
import { createTestChatOwnershipService } from './chatOwnershipTestUtils.js';

suite('Session sandbox configuration', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setupSession() {
		const manager = store.add(new AgentHostStateManager(new NullLogService()));
		const configuration = store.add(new AgentConfigurationService(manager, new NullLogService()));
		const create = (id: string, values: Record<string, unknown> = {}) => {
			const session = `copilot:/${id}`;
			manager.createSession({
				resource: session, provider: 'copilot', title: id, status: SessionStatus.Idle,
				createdAt: '2026-01-01T00:00:00Z', modifiedAt: '2026-01-01T00:00:00Z',
				defaultChat: buildDefaultChatUri(session),
			});
			manager.setSessionConfig(session, { schema: platformSessionSchema.toProtocol(), values });
			return session;
		};
		const registerChat = (session: string, id: string) => {
			if (!manager.getSessionState(session)) {
				manager.createSession({
					resource: session, provider: 'copilot', title: id, status: SessionStatus.Idle,
					createdAt: '2026-01-01T00:00:00Z', modifiedAt: '2026-01-01T00:00:00Z',
					defaultChat: buildDefaultChatUri(session),
				});
			}
			const chat = buildChatUri(session, id);
			manager.addChat(session, chat, creationTimeChatStorageResource(session, chat, buildDefaultChatUri(session)));
			return chat;
		};
		return { manager, configuration, create, registerChat };
	}

	test('advertises an optional mutable selection without materializing a default', () => {
		assert.deepStrictEqual({
			values: platformSessionSchema.validateOrDefault({}, {}),
			property: platformSessionSchema.toProtocol().properties.sandboxEnabled.enum,
			mutable: platformSessionSchema.toProtocol().properties.sandboxEnabled.sessionMutable,
		}, { values: {}, property: ['default', 'on', 'off'], mutable: true });
	});

	test('resolution preserves confirmed bypass metadata without mutating applied state', () => {
		const { configuration, create } = setupSession();
		const owner = create('resume');
		const target = { session: owner, chat: buildDefaultChatUri(owner) };
		configuration.setSessionSandboxPolicy(owner, { enabled: true, allowBypass: true });
		configuration.setChatSandboxEnabled(target, false);
		configuration.updateSessionConfig(owner, { sandboxEnabled: 'off' });

		assert.deepStrictEqual({
			enabled: getSessionSandboxConfig(configuration, target).enabled,
			applied: configuration.getChatSandboxEnabled(target),
			selection: configuration.getChatConfigValues(target)?.sandboxEnabled,
		}, { enabled: 'off', applied: false, selection: 'off' });
	});

	test('new managed policy retains confirmed off metadata only when bypass is allowed', () => {
		const results = [];
		for (const allowBypass of [undefined, false, true]) {
			const { configuration, create } = setupSession();
			const owner = create(`confirmed-off-${allowBypass}`, { sandboxEnabled: 'off' });
			const target = { session: owner, chat: buildDefaultChatUri(owner) };
			configuration.setChatSandboxEnabled(target, false);
			configuration.setSessionSandboxPolicy(owner, { enabled: true, ...(allowBypass !== undefined ? { allowBypass } : {}) });
			results.push({
				enabled: getSessionSandboxConfig(configuration, target).enabled,
				applied: configuration.getChatSandboxEnabled(target),
				selection: configuration.getChatConfigValues(target)?.sandboxEnabled,
			});
		}
		assert.deepStrictEqual(results, [
			{ enabled: 'on', applied: undefined, selection: 'on' },
			{ enabled: 'on', applied: undefined, selection: 'on' },
			{ enabled: 'off', applied: false, selection: 'off' },
		]);
	});

	test('publishes session-scoped policy changes in serializable subscription state', () => {
		const { manager, configuration, create } = setupSession();
		const owner = create('managed');
		const other = create('unmanaged');
		manager.setSessionMeta(owner, { 'test.other': 'preserved' });
		const policies: ReturnType<typeof readSessionSandboxPolicy>[] = [];
		store.add(manager.onDidEmitEnvelope(envelope => {
			if (envelope.action.type === ActionType.SessionMetaChanged) {
				policies.push(readSessionSandboxPolicy(JSON.parse(JSON.stringify({ _meta: envelope.action._meta }))));
			}
		}));
		configuration.setSessionSandboxPolicy(owner, { enabled: true });
		const reconnectSnapshot = JSON.parse(JSON.stringify(manager.getSessionState(owner)));
		configuration.setSessionSandboxPolicy(owner, { enabled: true, allowBypass: true });
		configuration.setSessionSandboxPolicy(owner, { enabled: false });
		assert.deepStrictEqual({
			policies,
			reconnected: readSessionSandboxPolicy(reconnectSnapshot),
			metadata: reconnectSnapshot._meta,
			removed: readSessionSandboxPolicy(manager.getSessionState(owner)),
			unrelated: readSessionSandboxPolicy(manager.getSessionState(other)),
			preserved: manager.getSessionState(owner)?._meta?.['test.other'],
		}, {
			policies: [{ enabled: true }, { enabled: true, allowBypass: true }, { enabled: false }],
			reconnected: { enabled: true },
			metadata: { 'test.other': 'preserved', 'vscode.resolvedSandboxPolicy': { enabled: true } },
			removed: { enabled: false },
			unrelated: undefined,
			preserved: 'preserved',
		});
	});

	test('ignores missing or non-object sandbox policy metadata', () => {
		const values = [undefined, null, [], true, 'policy', 0];
		assert.deepStrictEqual(values.map(value => readSessionSandboxPolicy({ _meta: { 'vscode.resolvedSandboxPolicy': value } })), values.map(() => undefined));
	});

	test('broadcasts background conflicts per chat, preserving confirmed state and selections', () => {
		const { manager, configuration, create } = setupSession();
		for (const enabled of [true, false, undefined]) {
			const owner = create(`conflict-${enabled}`, { sandboxEnabled: 'off' });
			const target = { session: owner, chat: buildDefaultChatUri(owner) };
			const sibling = { session: owner, chat: buildChatUri(owner, 'sibling') };
			manager.addChat(owner, sibling.chat, creationTimeChatStorageResource(owner, sibling.chat, target.chat));
			configuration.setChatSandboxEnabled(sibling, true);
			if (enabled !== undefined) {
				configuration.setChatSandboxEnabled(target, enabled);
			}
			const updates: ActionType[] = [];
			store.add(manager.onDidEmitEnvelope(envelope => updates.push(envelope.action.type)));

			configuration.reportChatSandboxConflict(target, 'Managed sandbox conflict');
			const failed = readChatSandboxState(manager.getSessionState(owner), target.chat);
			configuration.reportChatSandboxConflict(target, 'Managed sandbox conflict');

			assert.deepStrictEqual({
				enabled: failed?.enabled,
				message: failed?.error?.message,
				hasId: failed?.error !== undefined && hasKey(failed.error, { id: true }) && failed.error.id.length > 0,
				rejectedSelection: failed?.rejectedSelection,
				selection: configuration.getChatConfigValues(target)?.sandboxEnabled,
				sibling: readChatSandboxState(manager.getSessionState(owner), sibling.chat),
				updates,
				sessionState: readSessionSandboxState(manager.getSessionState(owner)),
			}, {
				enabled,
				message: 'Managed sandbox conflict',
				hasId: true,
				rejectedSelection: undefined,
				selection: 'off',
				sibling: { enabled: true },
				updates: [ActionType.SessionMetaChanged],
				sessionState: failed,
			});
		}
	});

	test('validates host sandbox conflicts without inventing confirmed enablement', () => {
		const parse = (state: Record<string, unknown>) => readSessionSandboxState({ _meta: { 'vscode.sandboxState': state } });
		const error = { id: 'conflict-1', message: 'Managed sandbox conflict' };
		assert.deepStrictEqual([
			parse({ error }),
			parse({ enabled: false, error }),
			parse({}),
			parse({ enabled: 'off', error }),
			parse({ error: { ...error, id: '' } }),
			parse({ error: { ...error, id: 1 } }),
			parse({ error: { ...error, message: 1 } }),
			parse({ error: { ...error, clientId: 'client', clientSeq: 1 } }),
			parse({ error: { clientId: 'client', clientSeq: 1, message: 'Rejected' } }),
		], [
			{ enabled: undefined, error },
			{ enabled: false, error },
			undefined, undefined, undefined, undefined, undefined, undefined, undefined,
		]);
	});

	test('transfers a sandbox conflict with unknown enablement without authorizing rollback', () => {
		const { manager, configuration, create } = setupSession();
		const source = create('source-conflict');
		const target = create('target-conflict', { sandboxEnabled: 'off' });
		const sourceChat = { session: source, chat: buildDefaultChatUri(source) };
		const targetChat = { session: target, chat: buildDefaultChatUri(target) };
		configuration.reportChatSandboxConflict(sourceChat, 'Managed sandbox conflict');
		const state = readChatSandboxState(manager.getSessionState(source), sourceChat.chat)!;
		configuration.setChatSandboxEnabled(targetChat, state.enabled, state.error);
		configuration.rejectChatSandboxChange(targetChat, configuration.getChatConfigValues(targetChat), { clientId: 'client', clientSeq: 1 }, 'Rejected');

		assert.deepStrictEqual({
			state: readChatSandboxState(manager.getSessionState(target), targetChat.chat),
			selection: configuration.getChatConfigValues(targetChat)?.sandboxEnabled,
		}, { state, selection: 'off' });
	});

	test('publishes the error to its client before restoring the last successful sandbox value', () => {
		const { manager, configuration, create } = setupSession();
		const owner = create('rollback', { sandboxEnabled: 'on', mode: 'plan' });
		configuration.setChatSandboxEnabled({ session: owner, chat: buildDefaultChatUri(owner) }, true);
		configuration.updateSessionConfig(owner, { sandboxEnabled: 'off' });
		const attempted = configuration.getSessionConfigValues(owner);
		configuration.updateSessionConfig(owner, { mode: 'interactive' });
		const updates: { type: ActionType; value: unknown; error: string | undefined }[] = [];
		store.add(manager.onDidEmitEnvelope(envelope => {
			updates.push({
				type: envelope.action.type,
				value: configuration.getSessionConfigValues(owner)?.sandboxEnabled,
				error: readSessionSandboxState(manager.getSessionState(owner))?.error?.message,
			});
		}));
		configuration.rejectChatSandboxChange({ session: owner, chat: buildDefaultChatUri(owner) }, attempted, { clientId: 'client', clientSeq: 1 }, 'SDK rejected update');
		assert.deepStrictEqual({
			updates,
			values: configuration.getSessionConfigValues(owner),
			state: readSessionSandboxState(manager.getSessionState(owner)),
		}, {
			updates: [
				{ type: ActionType.SessionMetaChanged, value: 'off', error: 'SDK rejected update' },
				{ type: ActionType.SessionConfigChanged, value: 'on', error: 'SDK rejected update' },
			],
			values: { sandboxEnabled: 'on', mode: 'interactive' },
			state: { enabled: true, rejectedSelection: true, error: { clientId: 'client', clientSeq: 1, message: 'SDK rejected update' } },
		});
	});

	test('preserves a rejected sandbox selection through rollback sync and clears it on an independent config event', () => {
		const { manager, configuration, create } = setupSession();
		const owner = create('rollback-sync', { sandboxEnabled: 'on' });
		const origin = { clientId: 'picker', clientSeq: 1 };
		configuration.setChatSandboxEnabled({ session: owner, chat: buildDefaultChatUri(owner) }, true);
		const changes: Array<{ value: unknown; origin: typeof origin | undefined; rejectedSelection: boolean; error: boolean }> = [];
		let rollbackSynchronized = false;
		store.add(configuration.onDidSessionConfigChange(event => {
			if (!Object.hasOwn(event.config, SessionConfigKey.SandboxEnabled)) {
				return;
			}
			const sandboxState = readSessionSandboxState(manager.getSessionState(owner));
			changes.push({
				value: configuration.getSessionConfigValues(owner)?.[SessionConfigKey.SandboxEnabled],
				origin: event.origin,
				rejectedSelection: sandboxState?.rejectedSelection === true,
				error: sandboxState?.error !== undefined,
			});
			if (!event.origin && !rollbackSynchronized) {
				rollbackSynchronized = true;
				configuration.setChatSandboxEnabled({ session: owner, chat: buildDefaultChatUri(owner) }, true);
			}
		}));

		manager.dispatchClientAction(owner, {
			type: ActionType.SessionConfigChanged,
			config: { [SessionConfigKey.SandboxEnabled]: 'off' },
		}, origin);
		const attempted = configuration.getSessionConfigValues(owner);
		configuration.rejectChatSandboxChange({ session: owner, chat: buildDefaultChatUri(owner) }, attempted, origin, 'SDK rejected update');
		const afterRollbackSync = readSessionSandboxState(manager.getSessionState(owner));
		configuration.updateSessionConfig(owner, { [SessionConfigKey.SandboxEnabled]: 'on' });

		assert.deepStrictEqual({
			changes,
			afterRollbackSync,
			afterIndependentChange: readSessionSandboxState(manager.getSessionState(owner)),
		}, {
			changes: [
				{ value: 'off', origin, rejectedSelection: false, error: false },
				{ value: 'on', origin: undefined, rejectedSelection: true, error: true },
				{ value: 'on', origin: undefined, rejectedSelection: false, error: false },
			],
			afterRollbackSync: { enabled: true, rejectedSelection: true },
			afterIndependentChange: { enabled: true },
		});
	});

	test('does not roll back a newer request, including another request for the same value', () => {
		const { manager, configuration, create } = setupSession();
		const owner = create('latest', { sandboxEnabled: 'on' });
		configuration.setChatSandboxEnabled({ session: owner, chat: buildDefaultChatUri(owner) }, true);
		configuration.updateSessionConfig(owner, { sandboxEnabled: 'off' });
		const first = configuration.getSessionConfigValues(owner);
		configuration.updateSessionConfig(owner, { sandboxEnabled: 'on' });
		configuration.updateSessionConfig(owner, { sandboxEnabled: 'off' });
		configuration.rejectChatSandboxChange({ session: owner, chat: buildDefaultChatUri(owner) }, first, { clientId: 'client', clientSeq: 1 }, 'Old failure');
		assert.deepStrictEqual({
			value: configuration.getSessionConfigValues(owner)?.sandboxEnabled,
			state: readSessionSandboxState(manager.getSessionState(owner)),
		}, { value: 'off', state: { enabled: true } });
	});

	test('validates sandbox results and preserves other metadata across serialization', () => {
		const state = { enabled: false, rejectedSelection: true, error: { clientId: 'client', clientSeq: 2, message: 'error' } };
		const meta = withSessionSandboxState({ other: true }, state);
		assert.deepStrictEqual({
			state: readSessionSandboxState(JSON.parse(JSON.stringify({ _meta: meta }))),
			other: meta.other,
			invalid: [null, [], { enabled: 'false' }, { enabled: true, error: {} }, { enabled: true, rejectedSelection: 'yes' }].map(value => readSessionSandboxState({ _meta: { 'vscode.sandboxState': value } })),
		}, { state, other: true, invalid: [undefined, undefined, undefined, undefined, undefined] });
	});

	test('returns only session toggle overrides', () => {
		const { configuration, create } = setupSession();
		const follower = create('follower');
		const enabled = create('enabled', { sandboxEnabled: 'on' });
		const disabled = create('disabled', { sandboxEnabled: 'off' });
		const managed = create('managed');
		configuration.updateRootConfig({ sandbox: { enabled: 'on', allowNetwork: true } });
		configuration.setSessionSandboxPolicy(managed, { enabled: true, allowBypass: false });
		assert.deepStrictEqual([follower, enabled, disabled, managed].map(session => getSessionSandboxOverrides(configuration, { session: session, chat: buildDefaultChatUri(session) })), [
			{},
			{ enabled: 'on' },
			{ enabled: 'off' },
			{ enabled: 'on', allowUnsandboxedCommands: false },
		]);
	});

	test('forwarded sandbox defaults remain overridable without a runtime managed requirement', () => {
		const { manager, configuration, create } = setupSession();
		const owner = create('legacy-default', { sandboxEnabled: 'off' });
		const followingDefault = create('following-default');
		configuration.updateRootConfig({ sandbox: { enabled: 'on', allowUnsandboxedCommands: true } });
		configuration.setSessionSandboxPolicy(owner, { enabled: false });
		configuration.updateSessionConfig(owner, { sandboxEnabled: 'off' });
		assert.deepStrictEqual({
			effective: getSessionSandboxConfig(configuration, { session: owner, chat: buildDefaultChatUri(owner) })?.enabled,
			followingDefault: getSessionSandboxConfig(configuration, { session: followingDefault, chat: buildDefaultChatUri(followingDefault) })?.enabled,
			selection: configuration.getSessionConfigValues(owner)?.sandboxEnabled,
			policy: readSessionSandboxPolicy(manager.getSessionState(owner)),
		}, {
			effective: 'off',
			followingDefault: 'on',
			selection: 'off',
			policy: { enabled: false },
		});
	});

	test('changing forwarded defaults does not change the runtime sandbox policy', () => {
		const { manager, configuration, create } = setupSession();
		const owner = create('legacy-live', { sandboxEnabled: 'off' });
		configuration.setChatSandboxEnabled({ session: owner, chat: buildDefaultChatUri(owner) }, false);
		const runtimePolicy = { enabled: false, allowBypass: false, allowOutbound: false };
		configuration.setSessionSandboxPolicy(owner, runtimePolicy);
		for (const enabled of ['on', 'off']) {
			configuration.updateRootConfig({ sandbox: { enabled, allowUnsandboxedCommands: true } });
			assert.deepStrictEqual({
				published: readSessionSandboxPolicy(manager.getSessionState(owner)),
				resolved: configuration.getSessionSandboxPolicy(owner),
				applied: configuration.getSessionSandboxEnabled(owner),
			}, { published: runtimePolicy, resolved: runtimePolicy, applied: false });
		}
	});

	test('forwarded sandbox defaults do not publish managed policy metadata', () => {
		const { manager, configuration, create } = setupSession();
		const owner = create('legacy-only');
		const unsupported = create('unsupported');
		manager.setSessionConfig(unsupported, { schema: { type: 'object', properties: {} }, values: {} });
		for (const enabled of ['on', 'off']) {
			configuration.updateRootConfig({ sandbox: { enabled } });
			assert.deepStrictEqual([owner, unsupported].map(session => readSessionSandboxPolicy(manager.getSessionState(session))), [undefined, undefined]);
		}
	});

	test('runtime policy owns approved bypass without widening local bypass settings', () => {
		for (const runtimeAllows of [undefined, false, true]) {
			for (const localAllows of [false, true]) {
				const { manager, configuration, create } = setupSession();
				const owner = create(`managed-bypass-${runtimeAllows}-${localAllows}`);
				configuration.updateRootConfig({ sandbox: { enabled: 'on', allowUnsandboxedCommands: localAllows } });
				configuration.setSessionSandboxPolicy(owner, { enabled: true, ...(runtimeAllows !== undefined ? { allowBypass: runtimeAllows } : {}) });
				configuration.updateSessionConfig(owner, { sandboxEnabled: 'off' });
				const directSelection = configuration.getSessionConfigValues(owner)?.sandboxEnabled;
				// Applied false represents an opt-out already accepted by the SDK, not a user selection.
				configuration.setChatSandboxEnabled({ session: owner, chat: buildDefaultChatUri(owner) }, false);
				configuration.updateSessionConfig(owner, { sandboxEnabled: 'off' });
				assert.deepStrictEqual({
					directSelection,
					approvedSelection: configuration.getSessionConfigValues(owner)?.sandboxEnabled,
					allowUnsandboxedCommands: getSessionSandboxConfig(configuration, { session: owner, chat: buildDefaultChatUri(owner) }).allowUnsandboxedCommands,
					policy: readSessionSandboxPolicy(manager.getSessionState(owner)),
				}, {
					directSelection: 'on',
					approvedSelection: runtimeAllows === true ? 'off' : 'on',
					allowUnsandboxedCommands: runtimeAllows === true && localAllows,
					policy: { enabled: true, ...(runtimeAllows !== undefined ? { allowBypass: runtimeAllows } : {}) },
				});
			}
		}
	});

	test('preserves a user bypass request without weakening the floor before runtime confirmation', () => {
		const { manager, configuration, create } = setupSession();
		const owner = create('managed-toggle', { sandboxEnabled: 'on' });
		configuration.setSessionSandboxPolicy(owner, { enabled: true, allowBypass: true });
		configuration.setChatSandboxEnabled({ session: owner, chat: buildDefaultChatUri(owner) }, true);
		const origin = { clientId: 'client', clientSeq: 1 };
		manager.dispatchClientAction(owner, { type: ActionType.SessionConfigChanged, config: { sandboxEnabled: 'off' } }, origin);
		const pending = {
			selection: configuration.getSessionConfigValues(owner)?.sandboxEnabled,
			effective: getSessionSandboxOverrides(configuration, { session: owner, chat: buildDefaultChatUri(owner) }).enabled,
		};
		configuration.setChatSandboxEnabled({ session: owner, chat: buildDefaultChatUri(owner) }, false);
		assert.deepStrictEqual({
			pending,
			selection: configuration.getSessionConfigValues(owner)?.sandboxEnabled,
			effective: getSessionSandboxOverrides(configuration, { session: owner, chat: buildDefaultChatUri(owner) }).enabled,
		}, { pending: { selection: 'off', effective: 'on' }, selection: 'off', effective: 'off' });
	});

	test('rolls back a rejected managed bypass request and publishes its error', () => {
		const { manager, configuration, create } = setupSession();
		const owner = create('managed-toggle-rejected', { sandboxEnabled: 'on' });
		configuration.setSessionSandboxPolicy(owner, { enabled: true, allowBypass: true });
		configuration.setChatSandboxEnabled({ session: owner, chat: buildDefaultChatUri(owner) }, true);
		const origin = { clientId: 'client', clientSeq: 1 };
		manager.dispatchClientAction(owner, { type: ActionType.SessionConfigChanged, config: { sandboxEnabled: 'off' } }, origin);
		configuration.rejectChatSandboxChange({ session: owner, chat: buildDefaultChatUri(owner) }, configuration.getSessionConfigValues(owner), origin, 'Bypass rejected');
		assert.deepStrictEqual({
			selection: configuration.getSessionConfigValues(owner)?.sandboxEnabled,
			state: readSessionSandboxState(manager.getSessionState(owner)),
		}, { selection: 'on', state: { enabled: true, rejectedSelection: true, error: { ...origin, message: 'Bypass rejected' } } });
	});

	test('pending managed selection survives unrelated changes but not bypass revocation', () => {
		const { manager, configuration, create } = setupSession();
		const owner = create('pending-toggle', { sandboxEnabled: 'on' });
		configuration.setSessionSandboxPolicy(owner, { enabled: true, allowBypass: true });
		configuration.setChatSandboxEnabled({ session: owner, chat: buildDefaultChatUri(owner) }, true);
		manager.dispatchClientAction(owner, { type: ActionType.SessionConfigChanged, config: { sandboxEnabled: 'off' } }, { clientId: 'client', clientSeq: 1 });
		configuration.updateRootConfig({ sandbox: { enabled: 'on', allowNetwork: false } });
		configuration.updateSessionConfig(owner, { [SessionConfigKey.AutoApprove]: 'default' });
		const pending = {
			selection: configuration.getSessionConfigValues(owner)?.sandboxEnabled,
			effective: getSessionSandboxOverrides(configuration, { session: owner, chat: buildDefaultChatUri(owner) }).enabled,
		};
		configuration.setSessionSandboxPolicy(owner, { enabled: true, allowBypass: false });
		assert.deepStrictEqual({ pending, revoked: configuration.getSessionConfigValues(owner)?.sandboxEnabled }, {
			pending: { selection: 'off', effective: 'on' },
			revoked: 'on',
		});
	});

	test('forwarded defaults preserve the unresolved-runtime-policy retry path', () => {
		const { manager, configuration, create } = setupSession();
		const owner = create('managed-fail-closed');
		const runtimePolicy = { enabled: true, allowBypass: false, failClosed: true };
		configuration.setSessionSandboxPolicy(owner, runtimePolicy);
		configuration.updateRootConfig({ sandbox: { enabled: 'on', allowUnsandboxedCommands: true } });
		configuration.updateSessionConfig(owner, { sandboxEnabled: 'off' });
		assert.deepStrictEqual({
			policy: readSessionSandboxPolicy(manager.getSessionState(owner)),
			selection: configuration.getSessionConfigValues(owner)?.sandboxEnabled,
		}, { policy: runtimePolicy, selection: 'off' });
		configuration.updateRootConfig({ sandbox: { enabled: 'off' } });
		assert.deepStrictEqual(configuration.getSessionSandboxPolicy(owner), runtimePolicy);
	});


	test('global updates affect followers, not explicit session overrides', () => {
		const { configuration, create } = setupSession();
		const follower = create('follower');
		const enabled = create('on', { sandboxEnabled: 'on' });
		const disabled = create('off', { sandboxEnabled: 'off' });
		const read = () => [follower, enabled, disabled].map(session => getSessionSandboxConfig(configuration, { session: session, chat: buildDefaultChatUri(session) })?.enabled);
		configuration.updateRootConfig({ sandbox: { enabled: 'off' } });
		const before = read();
		configuration.updateRootConfig({ sandbox: { enabled: 'on' } });
		assert.deepStrictEqual({ before, after: read() }, { before: ['off', 'on', 'off'], after: ['on', 'on', 'off'] });
	});

	test('peer chats and their subagents use the session\'s selection', () => {
		const { manager, configuration, create, registerChat } = setupSession();
		const owner = create('owner', { sandboxEnabled: 'off' });
		const other = create('other');
		configuration.updateRootConfig({ sandbox: { enabled: 'on' } });
		const peer = registerChat(owner, 'peer');
		const subagent = buildChatUri(owner, 'subagent');
		manager.addChat(owner, subagent, creationTimeChatStorageResource(owner, subagent, buildDefaultChatUri(owner)), { origin: { kind: ChatOriginKind.Tool, chat: peer, toolCallId: 'spawn' } });
		assert.deepStrictEqual([
			{ session: owner, chat: buildDefaultChatUri(owner) },
			{ session: owner, chat: peer },
			{ session: owner, chat: subagent },
			{ session: other, chat: buildDefaultChatUri(other) },
		].map(target => getSessionSandboxConfig(configuration, target)?.enabled), ['off', 'off', 'off', 'on']);
	});

	suite('per chat', () => {
		function setupChats(values: Record<string, unknown>) {
			const fixture = setupSession();
			const owner = fixture.create('per-chat');
			const protocol = platformSessionSchema.toProtocol();
			fixture.manager.setSessionConfig(owner, {
				schema: { ...protocol, properties: { ...protocol.properties, sandboxEnabled: { ...protocol.properties.sandboxEnabled, chatMutable: true } } },
				values,
			});
			const peer = fixture.registerChat(owner, 'peer');
			const defaultChat = buildDefaultChatUri(owner);
			return { ...fixture, owner, peer, defaultTarget: { session: owner, chat: defaultChat }, peerTarget: { session: owner, chat: peer } };
		}

		test('a chat\'s own selection and applied state apply to that chat only; the session-level state describes the default chat', () => {
			const { manager, configuration, owner, peer, defaultTarget, peerTarget } = setupChats({ sandboxEnabled: 'on' });
			configuration.updateChatConfig(peerTarget, { sandboxEnabled: 'off' });
			configuration.setChatSandboxEnabled(peerTarget, false);
			configuration.setChatSandboxEnabled(defaultTarget, true);
			const state = manager.getSessionState(owner);
			assert.deepStrictEqual({
				enabled: [defaultTarget, peerTarget].map(target => getSessionSandboxConfig(configuration, target).enabled),
				applied: [defaultTarget, peerTarget].map(target => configuration.getChatSandboxEnabled(target)),
				session: readSessionSandboxState(state),
				peerState: readChatSandboxState(state, peer),
				sessionApplied: configuration.getSessionSandboxEnabled(owner),
			}, {
				enabled: ['on', 'off'],
				applied: [true, false],
				session: { enabled: true },
				peerState: { enabled: false },
				sessionApplied: true,
			});
		});

		test('with chats with their own agents on, the session\'s "Disable sandboxing" replaces the default chat\'s own selection, not a peer\'s, and the default chat follows a managed floor', async () => {
			const { manager, configuration, owner, peer, defaultTarget, peerTarget } = setupChats({ sandboxEnabled: 'on' });
			configuration.updateRootConfig({ [ChatProvidersConfigKey.Enabled]: true });
			await timeout(0);
			manager.dispatchClientAction(defaultTarget.chat, { type: ActionType.ChatConfigChanged, config: { sandboxEnabled: 'on' } }, { clientId: 'client', clientSeq: 1 });
			manager.dispatchClientAction(peer, { type: ActionType.ChatConfigChanged, config: { sandboxEnabled: 'on' } }, { clientId: 'client', clientSeq: 2 });
			manager.dispatchClientAction(owner, { type: ActionType.SessionConfigChanged, config: { sandboxEnabled: 'off' } }, { clientId: 'client', clientSeq: 3 });
			const read = () => ({
				enabled: [defaultTarget, peerTarget].map(target => getSessionSandboxConfig(configuration, target).enabled),
				published: manager.getChatConfig(defaultTarget.chat)?.values.sandboxEnabled,
				defaultOwn: configuration.getChatPersistedConfigValues(defaultTarget.chat)?.sandboxEnabled,
				peerOwn: configuration.getChatOwnConfigValues(peerTarget).sandboxEnabled,
			});
			const disabled = read();
			// A managed floor without bypass rolls the session's off back; the default chat follows it.
			configuration.setSessionSandboxPolicy(owner, { enabled: true });
			assert.deepStrictEqual({ disabled, floored: read(), session: configuration.getSessionConfigValues(owner)?.sandboxEnabled }, {
				disabled: { enabled: ['off', 'on'], published: 'off', defaultOwn: undefined, peerOwn: 'on' },
				floored: { enabled: ['on', 'on'], published: 'on', defaultOwn: undefined, peerOwn: 'on' },
				session: 'on',
			});
		});

		test('a client\'s own off for a chat survives policy republishing while the policy allows bypass, and not its revocation', () => {
			const { manager, configuration, owner, peer, peerTarget } = setupChats({ sandboxEnabled: 'on' });
			configuration.setSessionSandboxPolicy(owner, { enabled: true, allowBypass: true });
			manager.dispatchClientAction(peer, { type: ActionType.ChatConfigChanged, config: { sandboxEnabled: 'off' } }, { clientId: 'client', clientSeq: 1 });
			configuration.updateRootConfig({ sandbox: { enabled: 'on', allowNetwork: false } });
			const kept = configuration.getChatOwnConfigValues(peerTarget).sandboxEnabled;
			configuration.setSessionSandboxPolicy(owner, { enabled: true, allowBypass: false });
			assert.deepStrictEqual({ kept, revoked: configuration.getChatOwnConfigValues(peerTarget).sandboxEnabled }, { kept: 'off', revoked: 'on' });
		});

		test('a chat\'s rejected selection is reported through its rollback and cleared by its next selection', () => {
			const { manager, configuration, peer, peerTarget, owner } = setupChats({ sandboxEnabled: 'on' });
			configuration.setChatSandboxEnabled(peerTarget, true);
			const origin = { clientId: 'client', clientSeq: 1 };
			manager.dispatchClientAction(peer, { type: ActionType.ChatConfigChanged, config: { sandboxEnabled: 'off' } }, origin);
			configuration.rejectChatSandboxChange(peerTarget, configuration.getChatConfigValues(peerTarget), origin, 'Bypass rejected');
			const rejected = { selection: configuration.getChatOwnConfigValues(peerTarget).sandboxEnabled, state: readChatSandboxState(manager.getSessionState(owner), peer) };
			configuration.setChatSandboxEnabled(peerTarget, true);
			const afterSync = readChatSandboxState(manager.getSessionState(owner), peer);
			manager.dispatchClientAction(peer, { type: ActionType.ChatConfigChanged, config: { sandboxEnabled: 'on' } }, { clientId: 'client', clientSeq: 2 });
			assert.deepStrictEqual({ rejected, afterSync, afterSelection: readChatSandboxState(manager.getSessionState(owner), peer) }, {
				rejected: { selection: 'on', state: { enabled: true, rejectedSelection: true, error: { ...origin, message: 'Bypass rejected' } } },
				// A later applied state keeps the rejection reported; only a new selection clears it.
				afterSync: { enabled: true, rejectedSelection: true },
				afterSelection: { enabled: true },
			});
		});

		test('a chat without its own selection is shown the session\'s, not the default chat\'s own, and the host applies that one', () => {
			const { manager, configuration, owner, peer, defaultTarget, peerTarget } = setupChats({ sandboxEnabled: 'on' });
			configuration.updateChatConfig(defaultTarget, { sandboxEnabled: 'off' });
			// What a client's picker shows: the session's config with the chat's published own values over it.
			const shown = (chat: string) => getEffectiveChatConfig(manager.getSessionState(owner)!.config!, manager.getChatConfig(chat)).values.sandboxEnabled;
			assert.deepStrictEqual({
				shown: [defaultTarget.chat, peer].map(shown),
				applied: [defaultTarget, peerTarget].map(target => getSessionSandboxConfig(configuration, target).enabled),
			}, {
				shown: ['off', 'on'],
				applied: ['off', 'on'],
			});
		});

		test('the session\'s applied selection is its own value while the default chat sets its own', () => {
			const { configuration, owner, defaultTarget } = setupChats({ sandboxEnabled: 'off' });
			configuration.updateChatConfig(defaultTarget, { sandboxEnabled: 'on' });
			configuration.setChatSandboxEnabled(defaultTarget, true);
			assert.strictEqual(configuration.getSessionSandboxEnabled(owner), false);
		});

		test('a policy floor turns a chat\'s own off back on', () => {
			const { manager, configuration, owner, peer, peerTarget } = setupChats({});
			configuration.updateChatConfig(peerTarget, { sandboxEnabled: 'off' });
			configuration.setSessionSandboxPolicy(owner, { enabled: true, allowBypass: false });
			assert.deepStrictEqual({ own: manager.getChatConfig(peer)?.values, enabled: getSessionSandboxConfig(configuration, peerTarget).enabled }, { own: { sandboxEnabled: 'on' }, enabled: 'on' });
		});

		test('a rejected change rolls back where the selection was set, unless a newer one superseded it', () => {
			const { configuration, owner, peerTarget, defaultTarget } = setupChats({ sandboxEnabled: 'on' });
			configuration.setChatSandboxEnabled(peerTarget, true);
			configuration.setChatSandboxEnabled(defaultTarget, true);
			configuration.updateChatConfig(peerTarget, { sandboxEnabled: 'off' });
			const peerAttempt = configuration.getChatConfigValues(peerTarget);
			configuration.updateSessionConfig(owner, { sandboxEnabled: 'off' });
			const inheritedAttempt = configuration.getChatConfigValues(defaultTarget);
			// The peer sets its own selection, so the session change does not supersede its attempt.
			configuration.rejectChatSandboxChange(peerTarget, peerAttempt, { clientId: 'client', clientSeq: 1 }, 'peer failed');
			configuration.rejectChatSandboxChange(defaultTarget, inheritedAttempt, { clientId: 'client', clientSeq: 2 }, 'default failed');
			const afterRollback = configuration.getSessionConfigValues(owner)?.sandboxEnabled;
			configuration.updateSessionConfig(owner, { sandboxEnabled: 'off' });
			const staleAttempt = configuration.getChatConfigValues(defaultTarget);
			configuration.updateSessionConfig(owner, { sandboxEnabled: 'on' });
			configuration.updateSessionConfig(owner, { sandboxEnabled: 'off' });
			configuration.rejectChatSandboxChange(defaultTarget, staleAttempt, { clientId: 'client', clientSeq: 3 }, 'stale');
			assert.deepStrictEqual({
				peer: configuration.getChatOwnConfigValues(peerTarget),
				afterRollback,
				session: configuration.getSessionConfigValues(owner)?.sandboxEnabled,
			}, { peer: { sandboxEnabled: 'on' }, afterRollback: 'on', session: 'off' });
		});

		test('per-chat state metadata is validated and kept alongside the session-level state', () => {
			const chats = { good: { enabled: false }, bad: { enabled: 'no' }, error: { enabled: true, error: { clientId: 'c' } } };
			const meta = withSessionSandboxState({ 'vscode.sandboxState': { chats } }, { enabled: true });
			const withChat = withChatSandboxState(meta, 'added', { enabled: true });
			assert.deepStrictEqual({
				session: readSessionSandboxState({ _meta: withChat }),
				read: ['good', 'bad', 'error', 'added', 'missing', 'toString'].map(chat => readChatSandboxState({ _meta: withChat }, chat)),
				notAMap: readChatSandboxState({ _meta: { 'vscode.sandboxState': { enabled: true, chats: [] } } }, 'good'),
				all: [...readChatSandboxStates({ _meta: withChat })],
				allNotAMap: [...readChatSandboxStates({ _meta: { 'vscode.sandboxState': { enabled: true, chats: [] } } })],
				cleared: withSessionSandboxState(withChat, undefined)['vscode.sandboxState'],
			}, {
				session: { enabled: true },
				read: [{ enabled: false }, undefined, undefined, { enabled: true }, undefined, undefined],
				notAMap: undefined,
				all: [['good', { enabled: false }], ['added', { enabled: true }]],
				allNotAMap: [],
				cleared: undefined,
			});
		});
	});

	test('sandbox policy lookup resolves peer chats and nested subagents to the owner', () => {
		const { configuration, create, registerChat } = setupSession();
		const owner = create('owner');
		const other = create('other');
		const child = buildSubagentSessionUri(owner, 'child');
		const nested = buildSubagentSessionUri(child, 'nested');
		const policy = { enabled: true, allowBypass: false };
		configuration.setSessionSandboxPolicy(owner, policy);
		assert.deepStrictEqual([
			owner,
			registerChat(owner, 'peer'),
			child,
			nested,
			registerChat(nested, 'peer'),
			other,
		].map(session => configuration.getSessionSandboxPolicy(session)), [policy, policy, policy, policy, policy, undefined]);
	});

	test('restored selections retain their values unless they conflict with current managed policy', () => {
		const first = setupSession();
		const second = setupSession();
		const restored = ['on', 'off', 'default', undefined].map(selection => {
			const owner = first.create(`persisted-${selection}`, selection ? { sandboxEnabled: selection } : {});
			const serialized = JSON.stringify(omitTransientSessionConfigValues(first.configuration.getSessionConfigValues(owner)!));
			return second.create(`persisted-${selection}`, JSON.parse(serialized));
		});
		const fresh = second.create('fresh');
		const read = () => [...restored, fresh].map(session => getSessionSandboxConfig(second.configuration, { session: session, chat: buildDefaultChatUri(session) })?.enabled);
		const selections = restored.map(session => second.configuration.getSessionConfigValues(session)?.sandboxEnabled);
		second.configuration.updateRootConfig({ sandbox: { enabled: 'on' } });
		const defaultOn = read();
		second.configuration.updateRootConfig({ sandbox: { enabled: 'off' } });
		const defaultOff = read();
		for (const session of restored) {
			second.configuration.setSessionSandboxPolicy(session, { enabled: true, allowBypass: false });
		}
		assert.deepStrictEqual({ selections, defaultOn, defaultOff, managed: read() }, {
			selections: ['on', 'off', 'default', undefined],
			defaultOn: ['on', 'off', 'on', 'on', 'on'],
			defaultOff: ['on', 'off', 'off', 'off', 'off'],
			managed: ['on', 'on', 'on', 'on', 'off'],
		});
	});

	test('managed floor permanently discards off and rejects subsequent attempts', () => {
		const { configuration, create } = setupSession();
		const owner = create('managed', { sandboxEnabled: 'off' });
		configuration.updateRootConfig({ sandbox: { enabled: 'on' } });
		configuration.setSessionSandboxPolicy(owner, { enabled: true, allowBypass: false });
		configuration.updateSessionConfig(owner, { sandboxEnabled: 'off' });
		const governed = getSessionSandboxConfig(configuration, { session: owner, chat: buildDefaultChatUri(owner) });
		configuration.setSessionSandboxPolicy(owner, { enabled: false, allowBypass: false });
		assert.deepStrictEqual({
			governed: governed?.enabled,
			bypass: governed?.allowUnsandboxedCommands,
			stored: configuration.getSessionConfigValues(owner)?.sandboxEnabled,
			removed: getSessionSandboxConfig(configuration, { session: owner, chat: buildDefaultChatUri(owner) })?.enabled,
		}, { governed: 'on', bypass: false, stored: 'on', removed: 'on' });
	});

	test('normalizes Windows filesystem settings on the host without mutating stored configuration', () => {
		const { configuration, create } = setupSession();
		const owner = create('windows', { sandboxEnabled: 'on' });
		const fileSystem = {
			denyRead: ['C:/src3/', 'C:\\already\\native', '//server/share/private'],
			denyWrite: ['C:/read\\only'],
			allowRead: ['./relative/path', 'C:/directory with spaces/'],
			allowWrite: ['C:/work/../output'],
		};
		const sandbox = { [AgentHostSandboxKey.WindowsFileSystem]: fileSystem };
		configuration.updateRootConfig({ sandbox });
		const stored = JSON.stringify(configuration.getRootConfigValues());
		const first = getSessionSandboxConfig(configuration, { session: owner, chat: buildDefaultChatUri(owner) }, 'win32');
		const storedAfterRead = JSON.stringify(configuration.getRootConfigValues());
		configuration.updateRootConfig({ sandbox: first });
		const second = getSessionSandboxConfig(configuration, { session: owner, chat: buildDefaultChatUri(owner) }, 'win32');
		assert.deepStrictEqual({
			fileSystem: first[AgentHostSandboxKey.WindowsFileSystem],
			idempotent: second,
			storedAfterRead,
		}, {
			fileSystem: {
				denyRead: ['C:\\src3\\', 'C:\\already\\native', '\\\\server\\share\\private'],
				denyWrite: ['C:\\read\\only'],
				allowRead: ['.\\relative\\path', 'C:\\directory with spaces\\'],
				allowWrite: ['C:\\work\\..\\output'],
			},
			idempotent: first,
			storedAfterRead: stored,
		});
	});


	test('allow-session on a peer sandbox escape leaves configuration to the provider', () => {
		const { manager, configuration, create } = setupSession();
		const owner = create('approval');
		const other = create('other');
		const root = configuration.getRootConfigValues();
		const peer = buildChatUri(owner, 'peer');
		manager.addChat(owner, peer, creationTimeChatStorageResource(owner, peer, buildDefaultChatUri(owner)));
		const permissions = store.add(new SessionPermissionManager(manager, {}, configuration, new NullLogService(), createSessionDataService(), createTestChatOwnershipService(manager)));
		manager.dispatchServerAction(peer, {
			type: ActionType.ChatTurnStarted, turnId: 'turn', startedAt: '2026-01-01T00:00:00Z',
			message: { text: 'run', origin: { kind: MessageKind.User } },
		});
		manager.dispatchServerAction(peer, { type: ActionType.ChatToolCallStart, turnId: 'turn', toolCallId: 'tool', toolName: 'bash', displayName: 'Bash' });
		const ready = permissions.createToolReadyAction({
			kind: 'pending_confirmation', chat: URI.parse(peer), requestSandboxBypass: true,
			state: { status: ToolCallStatus.PendingConfirmation, toolCallId: 'tool', toolName: 'bash', displayName: 'Bash', invocationMessage: 'run', confirmationTitle: 'Outside sandbox?' },
		}, owner, 'turn');
		manager.dispatchServerAction(peer, ready);
		const pending = manager.getChatState(peer);
		permissions.handleToolCallConfirmed(peer, 'tool', 'skip');
		const cancelled = {
			config: { ...configuration.getSessionConfigValues(owner) },
			toolUnchanged: manager.getChatState(peer) === pending,
		};
		permissions.handleToolCallConfirmed(peer, 'tool', 'allow-once');
		const once = { ...configuration.getSessionConfigValues(owner) };
		permissions.handleToolCallConfirmed(peer, 'tool', 'allow-session');
		assert.deepStrictEqual({
			cancelled, once, owner: configuration.getSessionConfigValues(owner),
			other: configuration.getSessionConfigValues(other), root: configuration.getRootConfigValues(),
		}, { cancelled: { config: {}, toolUnchanged: true }, once: {}, owner: {}, other: {}, root });
	});

	test('managed enablement rejects direct Off but permits confirmed opt-out and re-enablement', () => {
		const { configuration, create } = setupSession();
		const owner = create('bypass', { sandboxEnabled: 'off' });
		configuration.setSessionSandboxPolicy(owner, { enabled: true, allowBypass: true });
		const beforeApproval = { selection: configuration.getSessionConfigValues(owner)?.sandboxEnabled, enabled: getSessionSandboxOverrides(configuration, { session: owner, chat: buildDefaultChatUri(owner) }).enabled };
		configuration.setChatSandboxEnabled({ session: owner, chat: buildDefaultChatUri(owner) }, false);
		configuration.updateSessionConfig(owner, { sandboxEnabled: 'off' });
		const afterApproval = getSessionSandboxOverrides(configuration, { session: owner, chat: buildDefaultChatUri(owner) }).enabled;
		configuration.updateSessionConfig(owner, { sandboxEnabled: 'on' });
		const reenabled = getSessionSandboxOverrides(configuration, { session: owner, chat: buildDefaultChatUri(owner) }).enabled;
		configuration.setChatSandboxEnabled({ session: owner, chat: buildDefaultChatUri(owner) }, true);
		configuration.updateSessionConfig(owner, { sandboxEnabled: 'off' });
		assert.deepStrictEqual({ beforeApproval, afterApproval, reenabled, afterDirectDisable: configuration.getSessionConfigValues(owner)?.sandboxEnabled }, {
			beforeApproval: { selection: 'on', enabled: 'on' }, afterApproval: 'off', reenabled: 'on', afterDirectDisable: 'on',
		});
	});

	test('sandbox bypass prompts label one-time approval Allow, regardless of session policy', () => {
		const { manager, configuration, create } = setupSession();
		const owner = create('bypass-options');
		const permissions = store.add(new SessionPermissionManager(manager, {}, configuration, new NullLogService(), createSessionDataService(), createTestChatOwnershipService(manager)));
		const options = [];
		for (const allowBypass of [undefined, false, true]) {
			configuration.setSessionSandboxPolicy(owner, { enabled: true, allowBypass });
			for (const requestSandboxPermissive of [false, true]) {
				options.push(permissions.createToolReadyAction({
					kind: 'pending_confirmation', chat: URI.parse(buildChatUri(owner, 'peer')), requestSandboxBypass: true, requestSandboxPermissive,
					state: { status: ToolCallStatus.PendingConfirmation, toolCallId: 'tool', toolName: 'bash', displayName: 'Bash', invocationMessage: 'run', confirmationTitle: 'Outside sandbox?' },
				}, owner, 'turn').options?.map(option => ({ id: option.id, label: option.label })));
			}
		}
		assert.deepStrictEqual(options, Array.from({ length: 6 }, () => [{ id: 'allow-once', label: 'Allow' }, { id: 'skip', label: 'Skip' }]));
	});

	test('managed sandbox confirmations keep only the one-time and deny actions', () => {
		const { manager, configuration, create } = setupSession();
		const owner = create('managed-approval');
		const permissions = store.add(new SessionPermissionManager(manager, {}, configuration, new NullLogService(), createSessionDataService(), createTestChatOwnershipService(manager)));
		const ready = permissions.createToolReadyAction({
			kind: 'pending_confirmation', chat: URI.parse(buildChatUri(owner, 'peer')), requestSandboxBypass: true, managedApprovalRequired: true,
			state: { status: ToolCallStatus.PendingConfirmation, toolCallId: 'tool', toolName: 'bash', displayName: 'Bash', invocationMessage: 'run', confirmationTitle: 'Outside sandbox?' },
		}, owner, 'turn');
		assert.deepStrictEqual(ready.options?.map(option => ({ id: option.id, label: option.label })), [
			{ id: 'allow-once', label: 'Allow' }, { id: 'skip', label: 'Skip' },
		]);
	});

	test('ordinary and managed tool confirmations retain the Allow Once label', () => {
		const { manager, configuration, create } = setupSession();
		const owner = create('ordinary-options');
		const permissions = store.add(new SessionPermissionManager(manager, {}, configuration, new NullLogService(), createSessionDataService(), createTestChatOwnershipService(manager)));
		const labels = [false, true].map(managedApprovalRequired => permissions.createToolReadyAction({
			kind: 'pending_confirmation', chat: URI.parse(buildChatUri(owner, 'peer')), managedApprovalRequired,
			state: { status: ToolCallStatus.PendingConfirmation, toolCallId: 'tool', toolName: 'bash', displayName: 'Bash', invocationMessage: 'run', confirmationTitle: 'Run command?' },
		}, owner, 'turn').options?.map(option => option.label));
		assert.deepStrictEqual(labels, [['Allow in this Session', 'Allow Once', 'Skip'], ['Allow Once', 'Skip']]);
	});
});
