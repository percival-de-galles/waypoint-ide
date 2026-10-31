/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../base/common/event.js';
import { waitForState } from '../../../../../base/common/observable.js';
import { hasKey } from '../../../../../base/common/types.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { AgentSession, type AgentSignal } from '../../../common/agent.js';
import { isAgentDefaultModel } from '../../../common/meta/agentDefaultModelMeta.js';
import { MessageAttachmentKind, type MessageAttachment } from '../../../common/state/protocol/state.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import { buildDefaultChatUri } from '../../../common/state/sessionState.js';
import { AcpAgent } from '../../../node/acp/acpAgent.js';
import { IAgentConfigurationService } from '../../../node/agentConfigurationService.js';

/** A minimal ACP agent: streams two text chunks, asks permission for one tool, then ends the turn. */
const FAKE_ACP_AGENT = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const update = u => send({ method: 'session/update', params: { sessionId: 'native-1', update: u } });
const models = process.argv[2] === 'config-options'
	? { configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'acme/two', options: [{ value: 'acme/one', name: 'acme/One' }, { value: 'acme/two', name: 'acme/Two' }] }] }
	: { models: { currentModelId: 'm1', availableModels: [{ modelId: 'm1', name: 'Model One' }] } };
let prompt;
let selected;
let effort;
rl.on('line', line => {
	const message = JSON.parse(line);
	if (message.method === 'initialize') {
		send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { delete: {} } } } });
	} else if (message.method === 'session/new') {
		send({ id: message.id, result: { sessionId: 'native-1', ...models } });
	} else if (message.method === 'session/delete') {
		send({ id: message.id, result: {} });
	} else if (message.method === 'session/set_config_option') {
		if (message.params.configId === 'effort') {
			effort = message.params.value;
		} else {
			selected = message.params.value;
		}
		const thinking = message.params.value === 'acme/one' ? [{ id: 'effort', category: 'thought_level', currentValue: 'default', options: [{ value: 'high', name: 'High' }, { value: 'default', name: 'Default' }] }] : [];
		send({ id: message.id, result: { configOptions: thinking } });
	} else if (message.method === 'session/prompt') {
		prompt = message.id;
		update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: [selected, effort].filter(Boolean).join(' ') || 'Hello ' } });
		update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: message.params.prompt[0].text } });
		send({ id: 'perm-1', method: 'session/request_permission', params: { sessionId: 'native-1', toolCall: { toolCallId: 'tool-1', title: 'Run tests' }, options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }, { optionId: 'no', kind: 'reject_once', name: 'Reject' }] } });
	} else if (message.id === 'perm-1') {
		const allowed = message.result.outcome.optionId === 'yes';
		update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: allowed ? 'completed' : 'failed', title: 'Ran tests', content: [{ type: 'content', content: { type: 'text', text: allowed ? 'ok' : 'denied' } }] });
		send({ id: prompt, result: { stopReason: 'end_turn' } });
	}
});
`;

suite('AcpAgent', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let fixtureDir: string;
	let fixture: string;

	suiteSetup(async () => {
		fixtureDir = await fs.mkdtemp(join(tmpdir(), 'acp-agent-test-'));
		fixture = join(fixtureDir, 'fakeAcpAgent.cjs');
		await fs.writeFile(fixture, FAKE_ACP_AGENT);
	});

	suiteTeardown(() => fs.rm(fixtureDir, { recursive: true, force: true }));

	function createAgent(disposables: DisposableStore, installed = true, ...fixtureArgs: string[]): AcpAgent {
		return disposables.add(new AcpAgent({
			id: 'fake',
			displayName: 'Fake',
			description: 'Fake ACP agent',
			resolveCommand: async () => installed ? process.execPath : undefined,
			args: [fixture, ...fixtureArgs],
		}, upcastPartial<IAgentConfigurationService>({ onDidRootConfigChange: Event.None }), new NullLogService()));
	}

	function summarize(signal: AgentSignal): unknown {
		if (signal.kind === 'pending_confirmation') {
			return { confirm: signal.state.toolCallId };
		}
		if (signal.kind !== 'action') {
			return signal.kind;
		}
		const action = signal.action;
		switch (action.type) {
			case ActionType.ChatResponsePart: return { part: hasKey(action.part, { content: true }) ? action.part.content : undefined };
			case ActionType.ChatDelta: return { delta: action.content };
			case ActionType.ChatToolCallStart: return { toolStart: action.toolCallId };
			case ActionType.ChatToolCallReady: return { toolReady: action.toolCallId };
			case ActionType.ChatToolCallComplete: return { toolComplete: action.toolCallId, success: action.result.success };
			case ActionType.ChatTurnComplete: return 'turnComplete';
			case ActionType.ChatError: return { error: action.part.error.message };
			default: return action.type;
		}
	}

	test('streams a turn, routes a permission request to the host, and remembers the native session', async () => {
		const disposables = store.add(new DisposableStore());
		const agent = createAgent(disposables);
		const session = AgentSession.uri('fake', 's1');
		const chat = URI.parse(buildDefaultChatUri(session));
		const signals: unknown[] = [];
		const providerData: string[] = [];
		disposables.add(agent.onDidChangeChatData(change => providerData.push(change.providerData)));
		disposables.add(agent.onDidChatProgress(signal => {
			signals.push(summarize(signal));
			if (signal.kind === 'pending_confirmation') {
				agent.respondToPermissionRequest(signal.state.toolCallId, true);
			}
		}));

		await agent.chats.sendMessage(chat, 'hi', URI.file(fixtureDir), undefined, 'turn-1', undefined, undefined, session);

		assert.deepStrictEqual({
			signals,
			providerData,
			models: agent.models.get().map(model => model.id),
		}, {
			signals: [
				{ part: 'Hello ' },
				{ delta: 'hi' },
				{ toolStart: 'tool-1' },
				{ toolReady: 'tool-1' },
				{ confirm: 'tool-1' },
				{ toolComplete: 'tool-1', success: true },
				'turnComplete',
			],
			providerData: ['native-1'],
			models: ['m1'],
		});
	});

	test('a denied permission fails the tool and the turn still completes', async () => {
		const disposables = store.add(new DisposableStore());
		const agent = createAgent(disposables);
		const session = AgentSession.uri('fake', 's2');
		const chat = URI.parse(buildDefaultChatUri(session));
		const signals: unknown[] = [];
		disposables.add(agent.onDidChatProgress(signal => {
			signals.push(summarize(signal));
			if (signal.kind === 'pending_confirmation') {
				agent.respondToPermissionRequest(signal.state.toolCallId, false);
			}
		}));

		await agent.chats.sendMessage(chat, 'hi', URI.file(fixtureDir), undefined, 'turn-1', undefined, undefined, session);

		assert.deepStrictEqual(signals.slice(-2), [{ toolComplete: 'tool-1', success: false }, 'turnComplete']);
	});

	test('lists models before the first chat and selects one through its config option', async () => {
		const disposables = store.add(new DisposableStore());
		const agent = createAgent(disposables, true, 'config-options');
		const models = await waitForState(agent.models, models => models.length > 1);
		const session = AgentSession.uri('fake', 's4');
		const chat = URI.parse(buildDefaultChatUri(session));
		const signals: unknown[] = [];
		disposables.add(agent.onDidChatProgress(signal => {
			signals.push(summarize(signal));
			if (signal.kind === 'pending_confirmation') {
				agent.respondToPermissionRequest(signal.state.toolCallId, true);
			}
		}));

		await agent.chats.createChat(chat, session, { workingDirectories: [URI.file(fixtureDir)] });
		await agent.chats.changeModel(chat, { id: 'acme/one' }, session);
		await agent.chats.sendMessage(chat, 'hi', URI.file(fixtureDir), undefined, 'turn-1', undefined, undefined, session);

		assert.deepStrictEqual({
			models: models.map(model => ({ id: model.id, name: model.name, isDefault: isAgentDefaultModel(model) })),
			firstChunk: signals[0],
		}, {
			models: [{ id: 'acme/one', name: 'One', isDefault: false }, { id: 'acme/two', name: 'Two', isDefault: true }],
			firstChunk: { part: 'acme/one' },
		});
	});

	test('sends attachments as text in the prompt', async () => {
		const disposables = store.add(new DisposableStore());
		const agent = createAgent(disposables);
		const session = AgentSession.uri('fake', 's5');
		const signals: unknown[] = [];
		disposables.add(agent.onDidChatProgress(signal => {
			signals.push(summarize(signal));
			if (signal.kind === 'pending_confirmation') {
				agent.respondToPermissionRequest(signal.state.toolCallId, true);
			}
		}));

		const attachments: MessageAttachment[] = [{ type: MessageAttachmentKind.Simple, label: 'Page', modelRepresentation: 'The page text' }];
		await agent.chats.sendMessage(URI.parse(buildDefaultChatUri(session)), 'hi', URI.file(fixtureDir), attachments, 'turn-1', undefined, undefined, session);

		assert.deepStrictEqual(signals[1], { delta: 'hi\n\nThe page text' });
	});

	test('offers a model\'s thinking levels and applies the one picked', async () => {
		const disposables = store.add(new DisposableStore());
		const agent = createAgent(disposables, true, 'config-options');
		const models = await waitForState(agent.models, models => models.some(model => model.configSchema));
		const session = AgentSession.uri('fake', 's6');
		const chat = URI.parse(buildDefaultChatUri(session));
		const parts: unknown[] = [];
		disposables.add(agent.onDidChatProgress(signal => {
			parts.push(summarize(signal));
			if (signal.kind === 'pending_confirmation') {
				agent.respondToPermissionRequest(signal.state.toolCallId, true);
			}
		}));

		await agent.chats.createChat(chat, session, { workingDirectories: [URI.file(fixtureDir)] });
		await agent.chats.changeModel(chat, { id: 'acme/one', config: { thinkingLevel: 'high' } }, session);
		await agent.chats.sendMessage(chat, 'hi', URI.file(fixtureDir), undefined, 'turn-1', undefined, undefined, session);

		assert.deepStrictEqual({
			levels: models.map(model => { const level = model.configSchema?.properties.thinkingLevel; return level && { levels: level.enum, default: level.default }; }),
			firstChunk: parts[0],
		}, {
			levels: [{ levels: ['high', 'default'], default: 'default' }, undefined],
			firstChunk: { part: 'acme/one high' },
		});
	});

	test('a missing CLI fails the turn with install guidance', async () => {
		const disposables = store.add(new DisposableStore());
		const agent = createAgent(disposables, false);
		const session = AgentSession.uri('fake', 's3');
		const signals: unknown[] = [];
		disposables.add(agent.onDidChatProgress(signal => signals.push(summarize(signal))));

		await agent.chats.sendMessage(URI.parse(buildDefaultChatUri(session)), 'hi', URI.file(fixtureDir), undefined, 'turn-1', undefined, undefined, session);

		assert.deepStrictEqual(signals, [{ error: 'Fake is not installed. Install it, or set `chat.agentHost.binaryPaths` to the location of its command.' }]);
	});
});
