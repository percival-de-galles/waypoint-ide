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
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { AgentSession, resolveAgentChatContext, type AgentSignal } from '../../../common/agent.js';
import { AGENT_DEFAULT_MODEL_META_KEY } from '../../../common/meta/agentDefaultModelMeta.js';
import { MessageAttachmentKind, type MessageAttachment } from '../../../common/state/protocol/state.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import { buildDefaultChatUri, CustomizationType } from '../../../common/state/sessionState.js';
import { IAgentConfigurationService } from '../../../node/agentConfigurationService.js';
import { PiAgent } from '../../../node/pi/piAgent.js';
import { agentSdkSetupStatusKey } from '../../../common/agentSdkSetup.js';

/**
 * A minimal `pi --mode rpc`: answers model listing, streams one text delta, runs one tool
 * that an approval extension gates with a `confirm` dialog, then settles.
 */
const FAKE_PI = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = record => process.stdout.write(JSON.stringify(record) + '\\n');
let thinkingLevel;
rl.on('line', line => {
	const command = JSON.parse(line);
	if (command.type === 'get_available_models') {
		send({ type: 'response', id: command.id, command: command.type, success: true, data: { models: [{ reasoning: true, thinkingLevelMap: { minimal: null, max: 'max' }, contextWindow: 200000, provider: 'anthropic', id: 'claude-x', name: 'Claude X' }] } });
	} else if (command.type === 'set_thinking_level') {
		thinkingLevel = command.level;
		send({ type: 'response', id: command.id, command: command.type, success: true });
	} else if (command.type === 'prompt') {
		send({ type: 'response', id: command.id, command: 'prompt', success: true, data: { disposition: 'started' } });
		send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Echo: ' + (thinkingLevel ? '[' + thinkingLevel + '] ' : '') + command.message } });
		send({ type: 'message_end', message: { role: 'assistant', usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 } } });
		send({ type: 'extension_ui_request', id: 'dialog-1', method: 'confirm', title: 'Run bash?', message: 'npm test' });
	} else if (command.type === 'extension_ui_response') {
		send({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: {} });
		send({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', isError: !command.confirmed, result: { content: [{ type: 'text', text: command.confirmed ? 'passed' : 'blocked' }] } });
		send({ type: 'agent_settled' });
	} else if (command.type === 'get_state') {
		send({ type: 'response', id: command.id, command: command.type, success: true, data: { sessionFile: '/sessions/s1.jsonl', model: { provider: 'anthropic', id: 'claude-x' } } });
	} else if (command.type === 'get_commands') {
		send({ type: 'response', id: command.id, command: command.type, success: true, data: { commands: [{ name: 'skill:hello', description: 'Says hello', source: 'skill', sourceInfo: { path: '/skills/hello/SKILL.md', origin: 'top-level' } }] } });
	} else {
		send({ type: 'response', id: command.id, command: command.type, success: true });
	}
});
`;

suite('PiAgent', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let fixtureDir: string;
	let launcher: string;
	let previousAgentDir: string | undefined;

	suiteSetup(async () => {
		fixtureDir = await fs.mkdtemp(join(tmpdir(), 'pi-agent-test-'));
		const script = join(fixtureDir, 'fakePi.cjs');
		await fs.writeFile(script, FAKE_PI);
		// The agent runs `<command> --mode rpc`; a shell launcher turns that into `node fakePi.cjs`.
		launcher = join(fixtureDir, 'pi');
		await fs.writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`, { mode: 0o755 });
		// The agent reads and prepares Pi's configuration folder; keep it out of the user's home.
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(fixtureDir, 'agent');
	});

	suiteTeardown(() => {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		return fs.rm(fixtureDir, { recursive: true, force: true });
	});

	function createAgent(disposables: DisposableStore, published: Record<string, unknown>[] = []): PiAgent {
		const configurationService = upcastPartial<IAgentConfigurationService>({
			onDidRootConfigChange: Event.None,
			publishRootTransientValues: patch => published.push(patch),
			getRootConfigValues: () => ({}),
		});
		return disposables.add(new PiAgent({ id: 'pi', displayName: 'Pi', description: '', resolveLaunch: async () => ({ command: launcher, args: [] }) }, configurationService, new NullLogService()));
	}

	function summarize(signal: AgentSignal): unknown {
		if (signal.kind === 'pending_confirmation') {
			return { confirm: signal.state.displayName };
		}
		if (signal.kind !== 'action') {
			return signal.kind;
		}
		const action = signal.action;
		switch (action.type) {
			case ActionType.ChatResponsePart: return { part: (action.part as { content?: string }).content };
			case ActionType.ChatToolCallStart: return { toolStart: action.toolName };
			case ActionType.ChatToolCallComplete: return { toolComplete: action.toolCallId, success: action.result.success };
			case ActionType.ChatTurnComplete: return 'turnComplete';
			default: return action.type;
		}
	}

	test('streams a turn, gates a tool through an extension confirm dialog, and publishes Pi\'s models', async function () {
		if (process.platform === 'win32') {
			this.skip(); // the fixture launcher is a POSIX shell script
		}
		const disposables = store.add(new DisposableStore());
		const agent = createAgent(disposables);
		const session = AgentSession.uri('pi', 's1');
		const chat = URI.parse(buildDefaultChatUri(session));
		const signals: unknown[] = [];
		const sessionFiles: (string | undefined)[] = [];
		disposables.add(agent.onDidChangeChatData(change => sessionFiles.push(change.providerData)));
		const settled = new Promise<void>(resolve => disposables.add(agent.onDidChatProgress(signal => {
			signals.push(summarize(signal));
			if (signal.kind === 'pending_confirmation') {
				agent.respondToPermissionRequest(signal.state.toolCallId, true);
			}
			if (signal.kind === 'action' && signal.action.type === ActionType.ChatTurnComplete) {
				resolve();
			}
		})));

		await agent.chats.sendMessage(chat, 'hi', URI.file(fixtureDir), undefined, 'turn-1', undefined, undefined, session);
		await settled;

		assert.deepStrictEqual({ signals, models: agent.models.get().map(model => model.id), sessionFiles }, {
			signals: [
				{ part: 'Echo: hi' },
				ActionType.ChatUsage,
				{ toolStart: 'Run bash?' },
				ActionType.ChatToolCallReady,
				{ confirm: 'Run bash?' },
				{ toolComplete: 'pi-dialog-dialog-1', success: true },
				{ toolStart: 'bash' },
				ActionType.ChatToolCallReady,
				{ toolComplete: 't1', success: true },
				'turnComplete',
			],
			models: ['anthropic/claude-x'],
			// Remembered with the chat, so a new Pi process resumes it.
			sessionFiles: ['/sessions/s1.jsonl'],
		});
	});

	test('publishes its setup, prepares a private auth.json, and lists Pi\'s skills', async function () {
		if (process.platform === 'win32') {
			this.skip(); // the fixture launcher is a POSIX shell script
		}
		const disposables = store.add(new DisposableStore());
		const published: Record<string, unknown>[] = [];
		const agent = createAgent(disposables, published);
		await new Promise<void>(resolve => disposables.add(agent.onDidCustomizationsChange(() => resolve())));
		const setup = published.map(patch => patch[agentSdkSetupStatusKey('pi')]).find(Boolean) as { download: string; loginCommand: string[] };
		const authMode = (await fs.stat(join(fixtureDir, 'agent', 'auth.json'))).mode & 0o777;

		const session = AgentSession.uri('pi', 's2');
		const chat = URI.parse(buildDefaultChatUri(session));
		await agent.chats.createChat(chat, session, { workingDirectories: [URI.file(fixtureDir)] });
		const customizations = await agent.getChatCustomizations(chat);

		assert.deepStrictEqual({
			download: setup.download,
			loginCommand: setup.loginCommand,
			authMode: authMode.toString(8),
			models: agent.models.get().map(model => ({ id: model.id, meta: model._meta })),
			skills: customizations.filter(c => c.type === CustomizationType.Directory).map(c => ({ name: c.name, children: c.children?.map(child => child.name) })),
		}, {
			download: 'ready',
			loginCommand: [launcher],
			authMode: '600',
			models: [{ id: 'anthropic/claude-x', meta: { [AGENT_DEFAULT_MODEL_META_KEY]: true } }],
			skills: [{ name: 'skills', children: ['hello'] }],
		});
	});

	test('sends only the surface instructions, not ones for host tools Pi does not have', async function () {
		if (process.platform === 'win32') {
			this.skip(); // the fixture launcher is a POSIX shell script
		}
		const disposables = store.add(new DisposableStore());
		const agent = createAgent(disposables);
		const session = AgentSession.uri('pi', 's3');
		const chat = URI.parse(buildDefaultChatUri(session));
		const first = new Promise<string>(resolve => disposables.add(agent.onDidChatProgress(signal => {
			const part = summarize(signal) as { part?: string };
			if (part.part) {
				resolve(part.part);
			}
		})));
		await agent.chats.sendMessage(chat, 'hi', URI.file(fixtureDir), undefined, 'turn-1', undefined, undefined, { ...resolveAgentChatContext(session, chat), hostInstructions: ['Call `rename_chat`.', '<editor_inline_chat>Edit it.</editor_inline_chat>'] });
		assert.strictEqual(await first, 'Echo: <editor_inline_chat>Edit it.</editor_inline_chat>\n\nhi');
	});

	test('reports what each response used and each model\'s context window', async function () {
		if (process.platform === 'win32') {
			this.skip(); // the fixture launcher is a POSIX shell script
		}
		const disposables = store.add(new DisposableStore());
		const agent = createAgent(disposables);
		const session = AgentSession.uri('pi', 's5');
		const usage = new Promise<unknown>(resolve => disposables.add(agent.onDidChatProgress(signal => {
			if (signal.kind === 'action' && signal.action.type === ActionType.ChatUsage) {
				resolve(signal.action.usage);
			}
		})));
		await agent.chats.sendMessage(URI.parse(buildDefaultChatUri(session)), 'hi', URI.file(fixtureDir), undefined, 'turn-1', undefined, undefined, session);
		assert.deepStrictEqual({ usage: await usage, contextWindow: agent.models.get()[0]?.maxContextWindow }, {
			usage: { inputTokens: 130, outputTokens: 5, cacheReadTokens: 100 },
			contextWindow: 200000,
		});
	});

	test('offers a model\'s thinking levels and applies the one picked', async function () {
		if (process.platform === 'win32') {
			this.skip(); // the fixture launcher is a POSIX shell script
		}
		const disposables = store.add(new DisposableStore());
		const agent = createAgent(disposables);
		const session = AgentSession.uri('pi', 's6');
		const chat = URI.parse(buildDefaultChatUri(session));
		const first = new Promise<string>(resolve => disposables.add(agent.onDidChatProgress(signal => {
			const part = summarize(signal) as { part?: string };
			if (part.part) {
				resolve(part.part);
			}
		})));
		await agent.chats.createChat(chat, session, { model: { id: 'anthropic/claude-x', config: { thinkingLevel: 'max' } } });
		await agent.chats.sendMessage(chat, 'hi', URI.file(fixtureDir), undefined, 'turn-1', undefined, undefined, session);

		assert.deepStrictEqual({
			reply: await first,
			levels: agent.models.get()[0]?.configSchema?.properties.thinkingLevel.enum,
		}, {
			reply: 'Echo: [max] hi',
			levels: ['off', 'low', 'medium', 'high', 'max'],
		});
	});

	test('sends attachments as text in the message', async function () {
		if (process.platform === 'win32') {
			this.skip(); // the fixture launcher is a POSIX shell script
		}
		const disposables = store.add(new DisposableStore());
		const agent = createAgent(disposables);
		const session = AgentSession.uri('pi', 's4');
		const first = new Promise<string>(resolve => disposables.add(agent.onDidChatProgress(signal => {
			const part = summarize(signal) as { part?: string };
			if (part.part) {
				resolve(part.part);
			}
		})));
		const attachments: MessageAttachment[] = [{ type: MessageAttachmentKind.Simple, label: 'Page', modelRepresentation: 'The page text' }];
		await agent.chats.sendMessage(URI.parse(buildDefaultChatUri(session)), 'hi', URI.file(fixtureDir), attachments, 'turn-1', undefined, undefined, session);
		assert.strictEqual(await first, 'Echo: hi\n\nThe page text');
	});
});
