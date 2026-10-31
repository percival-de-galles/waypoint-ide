/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import type { IMarkdownString } from '../../../../../../base/common/htmlContent.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IAgentHostService } from '../../../../../../platform/agentHost/common/agentService.js';
import type { IAgentSdkSetupInfo } from '../../../../../../platform/agentHost/common/agentSdkSetup.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { AGENT_SDK_SETUP_OPEN_DOCS_COMMAND_ID, AGENT_SDK_SETUP_RELOAD_COMMAND_ID, AGENT_SDK_SETUP_SIGN_IN_COMMAND_ID, AGENT_SDK_SETUP_TERMINAL_SIGN_IN_COMMAND_ID, AgentHostSdkSetupNotificationContribution, agentSdkSetupNotificationId, createAgentSdkSetupNotification, getAgentDisplayNames, getAgentSdkSetupState, getAgentSdkSetupStateToReport, hasAgentSdkSetupForSessionType, type IAgentSdkSetupStateInputs } from '../../../browser/agentSessions/agentHost/agentHostSdkSetupNotification.js';
import { IAgentSdkSetupService, type AgentSdkSetupState } from '../../../../../services/agentHost/browser/agentSdkSetupService.js';
import { ICodexAccountService } from '../../../../../services/agentHost/browser/codexAccountService.js';
import { ChatInputNotificationActionKind, IChatInputNotificationService, type IChatInputNotification, type IChatInputNotificationAction } from '../../../browser/widget/input/chatInputNotificationService.js';
import { SessionType } from '../../../common/chatSessionsService.js';
import { ILanguageModelsService, type ILanguageModelChatMetadata } from '../../../common/languageModels.js';

/** Signed out, flag on, entitlement settled, SDK missing — the case this feature exists for. */
const BLOCKED_USER: IAgentSdkSetupStateInputs = {
	allowSignedOutWhenUsable: true,
	signedIn: false,
	entitlementResolved: true,
	download: 'notDownloaded',
	downloadRequested: false,
	hasModels: false,
};

function commandIds(actions: readonly IChatInputNotificationAction[]): string[] {
	return actions.map(action => action.kind === ChatInputNotificationActionKind.Command ? action.commandId : action.kind);
}

suite('Agent SDK setup banner', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	suite('state', () => {
		const cases: readonly { readonly name: string; readonly inputs: IAgentSdkSetupStateInputs; readonly expected: AgentSdkSetupState | undefined }[] = [
			{ name: 'signed-out user with no SDK is offered the download', inputs: BLOCKED_USER, expected: 'downloadOffered' },
			{ name: 'standing consent waits quietly for the SDK to be used', inputs: { ...BLOCKED_USER, download: 'downloadOnUse' }, expected: undefined },
			{ name: 'a fetch in flight has nothing to ask for, since the host shows its own progress', inputs: { ...BLOCKED_USER, download: 'downloading' }, expected: undefined },
			// The host answers a download request over IPC, so it keeps saying
			// `notDownloaded` for a moment after we ask. Offering the button again in
			// that gap would re-ask a user who has already consented.
			{ name: 'a request the host has not answered yet is not a fresh offer', inputs: { ...BLOCKED_USER, downloadRequested: true }, expected: undefined },
			{ name: 'SDK on disk reporting no models means no account', inputs: { ...BLOCKED_USER, download: 'ready' }, expected: 'noAccount' },
			{ name: 'models are the honest end state, whatever the status says', inputs: { ...BLOCKED_USER, download: 'ready', hasModels: true }, expected: 'resolved' },
			{ name: 'nothing shows until entitlement settles, since "signed out" is not yet a fact', inputs: { ...BLOCKED_USER, download: 'ready', entitlementResolved: false }, expected: undefined },
			{ name: 'the missing-account explanation stays behind its flag', inputs: { ...BLOCKED_USER, download: 'ready', allowSignedOutWhenUsable: false }, expected: undefined },
			{ name: 'a signed-in user is never told they have no account', inputs: { ...BLOCKED_USER, download: 'ready', signedIn: true }, expected: undefined },
			{ name: 'a signed-in user can be offered an unresolved agent-owned account', inputs: { ...BLOCKED_USER, download: 'ready', signedIn: true, agentAccountState: 'needsSignIn' }, expected: 'noAccount' },
			{ name: 'an agent-owned account is not guessed while discovery is unresolved', inputs: { ...BLOCKED_USER, download: 'ready', agentAccountState: 'unresolved' }, expected: undefined },
			{ name: 'an agent-owned account with no models is not called signed out', inputs: { ...BLOCKED_USER, download: 'ready', signedIn: true, agentAccountState: 'available' }, expected: undefined },
			{ name: 'a signed-in user mid-download is still shown nothing', inputs: { ...BLOCKED_USER, signedIn: true, download: 'downloading' }, expected: undefined },

			// The download is offered to everyone: each of these users can work
			// today, and still has an SDK we are about to fetch onto their machine.
			{ name: 'a signed-in user is offered the download too', inputs: { ...BLOCKED_USER, signedIn: true }, expected: 'downloadOffered' },
			{ name: 'having models does not hide the download', inputs: { ...BLOCKED_USER, signedIn: true, hasModels: true }, expected: 'downloadOffered' },
			{ name: 'the download offer does not wait for entitlement', inputs: { ...BLOCKED_USER, entitlementResolved: false }, expected: 'downloadOffered' },
			{ name: 'the download offer is not behind the signed-out flag', inputs: { ...BLOCKED_USER, allowSignedOutWhenUsable: false }, expected: 'downloadOffered' },
		];

		for (const { name, inputs, expected } of cases) {
			test(name, () => {
				assert.strictEqual(getAgentSdkSetupState(inputs), expected);
			});
		}
	});

	suite('presentation', () => {
		const claude: IAgentSdkSetupInfo = { agent: 'claude', download: 'notDownloaded', setupDocsUrl: 'https://example.test/claude' };
		const reloadClaude = `command:${AGENT_SDK_SETUP_RELOAD_COMMAND_ID}?%255B%2522claude%2522%255D`;
		const docsClaude = `command:${AGENT_SDK_SETUP_OPEN_DOCS_COMMAND_ID}?%255B%2522claude%2522%255D`;
		const value = (description: string | IMarkdownString | undefined) => typeof description === 'string' ? description : description?.value;

		test('a missing command-line tool is named, with a way to check again and install instructions', () => {
			const notification = createAgentSdkSetupNotification(claude, 'Claude', 'downloadOffered');

			assert.ok(notification);
			assert.deepStrictEqual({
				id: notification.id,
				sessionTypes: notification.sessionTypes,
				message: notification.message,
				description: value(notification.description),
				actions: commandIds(notification.actions),
				args: notification.actions.map(action => action.kind === ChatInputNotificationActionKind.Command ? action.commandArgs : undefined),
			}, {
				id: agentSdkSetupNotificationId('claude'),
				sessionTypes: [SessionType.AgentHostClaude],
				message: 'Claude is not installed',
				description: `Install the Claude command-line tool, or set its location in \`chat.agentHost.binaryPaths\`, then [check again](${reloadClaude}).`,
				actions: [AGENT_SDK_SETUP_OPEN_DOCS_COMMAND_ID],
				args: [['claude']],
			});
		});

		test('every noun comes from the agent, so a second agent needs no entry here', () => {
			const codex: IAgentSdkSetupInfo = { agent: 'codex', download: 'notDownloaded', signInProviderName: 'ChatGPT' };

			assert.deepStrictEqual({
				sessionTypes: createAgentSdkSetupNotification(codex, 'Codex', 'downloadOffered')?.sessionTypes,
				notInstalled: createAgentSdkSetupNotification(codex, 'Codex', 'downloadOffered')?.message,
				noAccount: createAgentSdkSetupNotification(codex, 'Codex', 'noAccount')?.message,
			}, {
				sessionTypes: [SessionType.AgentHostCodex],
				notInstalled: 'Codex is not installed',
				noAccount: 'Choose how you want to use Codex.',
			});
		});

		test('a missing account offers the routes the agent declared, its terminal login last', () => {
			// Last is the primary button in the widget.
			const codex: IAgentSdkSetupInfo = { agent: 'codex', download: 'ready', signInProviderName: 'ChatGPT', loginCommand: ['codex', 'login'] };
			const buttons = (setup: IAgentSdkSetupInfo, displayName: string) =>
				commandIds(createAgentSdkSetupNotification(setup, displayName, 'noAccount')?.actions ?? []);

			assert.deepStrictEqual({
				docsOnly: buttons({ ...claude, download: 'ready' }, 'Claude'),
				loginOnly: buttons({ ...claude, download: 'ready', loginCommand: ['claude', 'auth', 'login'] }, 'Claude'),
				signInOnly: buttons({ ...codex, loginCommand: undefined }, 'Codex'),
				both: buttons(codex, 'Codex'),
			}, {
				// Docs are a link in the description, never a button.
				docsOnly: [],
				loginOnly: [AGENT_SDK_SETUP_TERMINAL_SIGN_IN_COMMAND_ID],
				signInOnly: [AGENT_SDK_SETUP_SIGN_IN_COMMAND_ID],
				both: [AGENT_SDK_SETUP_SIGN_IN_COMMAND_ID, AGENT_SDK_SETUP_TERMINAL_SIGN_IN_COMMAND_ID],
			});
		});

		test('every button is addressed to the agent, and none offers GitHub', () => {
			const notification = createAgentSdkSetupNotification({ agent: 'codex', download: 'ready', signInProviderName: 'ChatGPT', loginCommand: ['codex', 'login'] }, 'Codex', 'noAccount');

			assert.ok(notification);
			// The agent id, not the command or the provider: each command resolves what it
			// needs from the agent's own declaration rather than trusting the banner.
			assert.deepStrictEqual(notification.actions.map(action => action.kind === ChatInputNotificationActionKind.Command ? action.commandArgs : undefined), [['codex'], ['codex']]);
			assert.deepStrictEqual(notification.actions.map(action => action.label), ['Sign in to ChatGPT', 'Sign In in Terminal']);
		});

		test('the routes named in the copy are the ones the agent declared', () => {
			const noAccount = (setup: Omit<IAgentSdkSetupInfo, 'agent' | 'download'>) =>
				value(createAgentSdkSetupNotification({ agent: 'claude', download: 'ready', ...setup }, 'Claude', 'noAccount')?.description);
			const docs = `For other ways to set up Claude, [learn more](${docsClaude}) on their docs.`;

			assert.deepStrictEqual({
				neither: noAccount({}),
				docs: noAccount({ setupDocsUrl: 'https://example.test/claude' }),
				signIn: noAccount({ signInProviderName: 'ChatGPT' }),
				both: noAccount({ setupDocsUrl: 'https://example.test/claude', signInProviderName: 'ChatGPT' }),
			}, {
				neither: `[Reload the configuration](${reloadClaude}) if you have set up Claude elsewhere.`,
				docs: `[Reload the configuration](${reloadClaude}) if you have set up Claude elsewhere. ${docs}`,
				signIn: `Sign in to ChatGPT to use your ChatGPT subscription, or [reload the configuration](${reloadClaude}) if you have set up Claude elsewhere.`,
				both: `Sign in to ChatGPT to use your ChatGPT subscription, or [reload the configuration](${reloadClaude}) if you have set up Claude elsewhere. ${docs}`,
			});
		});

		test('a name carrying markdown is escaped, so the host cannot forge a third link', () => {
			// Both nouns arrive from the host, and this description is trusted for two
			// commands — an unescaped `[]()` in either would render as a link to one of
			// them instead of as the name.
			const description = createAgentSdkSetupNotification(
				{ agent: 'claude', download: 'ready', setupDocsUrl: 'https://example.test/claude', signInProviderName: 'Chat[G]PT' },
				'Claude [x](command:evil)',
				'noAccount',
			)?.description;
			const name = 'Claude \\[x\\]\\(command:evil\\)';

			assert.strictEqual(value(description),
				`Sign in to Chat\\[G\\]PT to use your Chat\\[G\\]PT subscription, or [reload the configuration](${reloadClaude}) if you have set up ${name} elsewhere. For other ways to set up ${name}, [learn more](${docsClaude}) on their docs.`);
		});

		test('the copy is trusted for its own two commands alone, so its links render and reach nothing else', () => {
			// Untrusted markdown renders a `command:` link as inert text, which would
			// leave both routes with no affordance at all.
			for (const state of ['noAccount', 'downloadOffered'] as const) {
				const description = createAgentSdkSetupNotification({ agent: 'claude', download: 'ready', setupDocsUrl: 'https://example.test/claude' }, 'Claude', state)?.description;
				assert.ok(description !== undefined && typeof description !== 'string');
				assert.deepStrictEqual(description.isTrusted, { enabledCommands: [AGENT_SDK_SETUP_OPEN_DOCS_COMMAND_ID, AGENT_SDK_SETUP_RELOAD_COMMAND_ID] });
			}
		});

		test('the banner cannot be dismissed, since it is the only route to a working agent', () => {
			const notification = createAgentSdkSetupNotification(claude, 'Claude', 'downloadOffered');

			assert.ok(notification);
			assert.strictEqual(notification.dismissible, false);
			assert.strictEqual(notification.autoDismissOnMessage, false);
		});

		test('nothing is rendered once the user is set up, or for an agent the host has not named yet', () => {
			assert.strictEqual(createAgentSdkSetupNotification(claude, 'Claude', undefined), undefined);
			assert.strictEqual(createAgentSdkSetupNotification({ ...claude, download: 'ready' }, 'Claude', 'resolved'), undefined);
			assert.strictEqual(createAgentSdkSetupNotification({ agent: 'some-future-agent', download: 'notDownloaded' }, '', 'downloadOffered'), undefined);
		});
	});

	suite('model availability', () => {
		function createFixture(initialSessionTypes: readonly (string | undefined)[] = []) {
			const instantiationService = store.add(new TestInstantiationService());
			const onDidChangeLanguageModels = store.add(new Emitter<string>());
			const models = new Map<string, ILanguageModelChatMetadata>();
			const notifications: IChatInputNotification[] = [];
			const deletedNotifications: string[] = [];
			const reportedStates: AgentSdkSetupState[] = [];
			const setModels = (sessionTypes: readonly (string | undefined)[]) => {
				models.clear();
				for (const [index, targetChatSessionType] of sessionTypes.entries()) {
					models.set(`model-${index}`, new class extends mock<ILanguageModelChatMetadata>() {
						override readonly targetChatSessionType = targetChatSessionType;
					}());
				}
				onDidChangeLanguageModels.fire('test');
			};

			instantiationService.stub(IChatInputNotificationService, {
				setNotification: notification => notifications.push(notification),
				deleteNotification: id => deletedNotifications.push(id),
			});
			instantiationService.stub(IAgentSdkSetupService, {
				setups: [{ agent: 'claude', download: 'notDownloaded' }],
				onDidChangeSetups: Event.None,
				isDownloadPending: () => false,
				reportSetupState: (_agent, state) => reportedStates.push(state),
			});
			instantiationService.stub(ILanguageModelsService, {
				onDidChangeLanguageModels: onDidChangeLanguageModels.event,
				getLanguageModelIds: () => [...models.keys()],
				lookupLanguageModel: id => models.get(id),
			});
			instantiationService.stub(IConfigurationService, new TestConfigurationService());
			instantiationService.stub(ICodexAccountService, {
				agent: 'codex',
				account: { status: 'unknown' },
				onDidChangeAccount: Event.None,
			});
			instantiationService.stub(IAgentHostService, {
				onAgentHostStart: Event.None,
				rootState: new class extends mock<IAgentHostService['rootState']>() {
					override readonly value = { agents: [{ provider: 'claude', displayName: 'Claude', description: '', models: [] }] };
					override readonly onDidChange = Event.None;
				}(),
			});

			setModels(initialSessionTypes);
			store.add(instantiationService.createInstance(AgentHostSdkSetupNotificationContribution));

			return { notifications, deletedNotifications, reportedStates, setModels };
		}

		test('reports a missing tool once, whether or not models for its agent exist', () => {
			const fixture = createFixture();
			fixture.setModels([SessionType.AgentHostCodex, undefined]);
			fixture.setModels([SessionType.AgentHostClaude]);
			fixture.setModels([]);

			assert.deepStrictEqual({
				messages: fixture.notifications.map(notification => notification.message),
				deletedNotifications: fixture.deletedNotifications,
				reportedStates: fixture.reportedStates,
			}, {
				messages: ['Claude is not installed'],
				deletedNotifications: [],
				reportedStates: ['downloadOffered'],
			});
		});
	});

	suite('display names', () => {
		test('reads each agent name the host published, and skips what it did not', () => {
			assert.deepStrictEqual([...getAgentDisplayNames({
				agents: [
					{ provider: 'claude', displayName: 'Claude', description: '', models: [] },
					{ provider: 'nameless', displayName: '', description: '', models: [] },
				],
			})], [['claude', 'Claude']]);
		});

		test('a host that has not reported, or failed, names nobody', () => {
			assert.deepStrictEqual([...getAgentDisplayNames(undefined)], []);
			assert.deepStrictEqual([...getAgentDisplayNames(new Error('host is down'))], []);
		});
	});

	suite('activation reachability', () => {
		test('an advertised setup is found for its session type and only that one', () => {
			const setups: readonly IAgentSdkSetupInfo[] = [{ agent: 'claude', download: 'ready' }];
			assert.deepStrictEqual({
				claude: hasAgentSdkSetupForSessionType(setups, SessionType.AgentHostClaude),
				codex: hasAgentSdkSetupForSessionType(setups, SessionType.AgentHostCodex),
				copilot: hasAgentSdkSetupForSessionType(setups, SessionType.AgentHostCopilot),
			}, { claude: true, codex: false, copilot: false });
		});

		test('no advertised setup leaves the harness gated', () => {
			assert.strictEqual(hasAgentSdkSetupForSessionType([], SessionType.AgentHostClaude), false);
		});
	});

	suite('funnel', () => {
		const cases: readonly {
			readonly name: string;
			/** The last state *reported* for this agent, not the last one computed. */
			readonly previous: AgentSdkSetupState | undefined;
			readonly state: AgentSdkSetupState | undefined;
			readonly expected: AgentSdkSetupState | undefined;
		}[] = [
				{ name: 'first sight of the offer counts', previous: undefined, state: 'downloadOffered', expected: 'downloadOffered' },
				{ name: 'an SDK that found no account is where users get stuck', previous: 'downloadOffered', state: 'noAccount', expected: 'noAccount' },
				{ name: 'a stuck user who then has models is the conversion', previous: 'noAccount', state: 'resolved', expected: 'resolved' },
				// Counted once per user: re-renders are constant, and a download that
				// failed back to the offer is the same person still being asked.
				{ name: 'a re-render, or a failed download returning to the offer, is not a second offer', previous: 'downloadOffered', state: 'downloadOffered', expected: undefined },
				{ name: 'a conversion is not re-counted on every later render', previous: 'resolved', state: 'resolved', expected: undefined },
				{ name: 'a fetch in flight, or giving up, moves the user nowhere', previous: 'downloadOffered', state: undefined, expected: undefined },
				{ name: 'a user this feature was never for is not a convert', previous: undefined, state: 'resolved', expected: undefined },
			];

		for (const { name, previous, state, expected } of cases) {
			test(name, () => {
				assert.strictEqual(getAgentSdkSetupStateToReport(previous, state), expected);
			});
		}
	});
});
