/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { promises as fs, watch } from 'fs';
import { homedir, tmpdir } from 'os';
import { DeferredPromise, raceTimeout, RunOnceScheduler, Sequencer } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { type IAgent, type IAgentChatContext, type IAgentChats, type IAgentCreateChatOptions, type IAgentCreateChatResult, type IAgentModelInfo } from '../../common/agent.js';
import { AGENT_DEFAULT_MODEL_META_KEY } from '../../common/meta/agentDefaultModelMeta.js';
import type { AgentSelection, MessageAttachment, ModelSelection } from '../../common/state/protocol/state.js';
import { createThinkingLevelSchema, ReasoningEffortConfigKey } from '../../common/reasoningEffort.js';
import { ActionType } from '../../common/state/sessionActions.js';
import type { Customization, Turn } from '../../common/state/sessionState.js';
import { agentProcessEnv } from '../acp/acpConnection.js';
import { agentInstallCommands } from '../agentBinary.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';
import { resolvePromptToText } from '../claude/claudePromptResolver.js';
import { CliAgentBase, type ICliAgentChat, type ICliAgentDescription } from '../cliAgentBase.js';
import { toPiCustomizations, type IPiCommand } from './piCustomizations.js';

type PiRecord = Record<string, unknown> & { readonly type?: unknown };

/** How to start one Pi process in RPC mode. */
export interface IPiLaunch {
	readonly command: string;
	readonly args: readonly string[];
	/** Added to the user's environment. */
	readonly env?: Readonly<Record<string, string>>;
}

/** A Pi agent: how to find and start the user's `pi`. */
export interface IPiAgentDefinition extends ICliAgentDescription {
	/** `undefined` when this Pi is not installed. */
	readonly resolveLaunch: () => Promise<IPiLaunch | undefined>;
	/** Replaces Pi's own "No API key found … use /login" error. */
	readonly noApiKeyMessage?: string;
}

/** One `pi --mode rpc` process: strict JSONL commands in, responses and events out. */
class PiProcess extends Disposable {

	private readonly _child: ChildProcessWithoutNullStreams;
	private readonly _pending = new Map<string, DeferredPromise<unknown>>();
	private _exited = false;

	private readonly _onDidEvent = this._register(new Emitter<PiRecord>());
	readonly onDidEvent = this._onDidEvent.event;
	private readonly _onDidExit = this._register(new Emitter<void>());
	readonly onDidExit = this._onDidExit.event;

	constructor(launch: IPiLaunch, cwd: string, log: (message: string) => void) {
		super();
		this._child = spawn(launch.command, launch.args, { cwd, env: { ...agentProcessEnv(process.env), ...launch.env }, stdio: 'pipe' });
		let buffer = '';
		this._child.stdout.setEncoding('utf8');
		this._child.stdout.on('data', (chunk: string) => {
			buffer += chunk;
			let newline: number;
			// Split on LF only: Pi's records may contain Unicode line separators inside strings.
			while ((newline = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) {
					this._receive(line, log);
				}
			}
		});
		this._child.stderr.setEncoding('utf8');
		this._child.stderr.on('data', (chunk: string) => log(`stderr: ${chunk.trimEnd()}`));
		this._child.stdin.on('error', error => log(`stdin: ${error.message}`));
		this._child.on('error', error => {
			log(`failed to run ${launch.command}: ${error.message}`);
			this._exit();
		});
		this._child.on('exit', () => this._exit());
	}

	/** Ties a listener's lifetime to this process, so a restart does not pile them up. */
	own(listener: IDisposable): void {
		this._register(listener);
	}

	request(command: Record<string, unknown>): Promise<unknown> {
		const id = generateUuid();
		const deferred = new DeferredPromise<unknown>();
		this._pending.set(id, deferred);
		this.send({ ...command, id });
		return deferred.p;
	}

	send(record: Record<string, unknown>): void {
		if (!this._exited) {
			this._child.stdin.write(JSON.stringify(record) + '\n');
		}
	}

	private _receive(line: string, log: (message: string) => void): void {
		let record: PiRecord;
		try {
			record = JSON.parse(line);
		} catch {
			log(`ignored a line that is not JSON: ${line.slice(0, 200)}`);
			return;
		}
		const pending = record.type === 'response' && typeof record.id === 'string' ? this._pending.get(record.id) : undefined;
		if (pending) {
			this._pending.delete(record.id as string);
			if (record.success === true) {
				pending.complete(record.data);
			} else {
				pending.error(new Error(typeof record.error === 'string' ? record.error : JSON.stringify(record.error ?? 'Pi request failed')));
			}
			return;
		}
		this._onDidEvent.fire(record);
	}

	private _exit(): void {
		if (this._exited) {
			return;
		}
		this._exited = true;
		for (const pending of this._pending.values()) {
			pending.error(new Error('Pi exited'));
		}
		this._pending.clear();
		this._onDidExit.fire();
	}

	override dispose(): void {
		this._exit();
		this._child.kill();
		super.dispose();
	}
}

interface IPiChat extends ICliAgentChat {
	process?: PiProcess;
	model?: ModelSelection;
	workingDirectory?: URI;
	/** Pi's session file, so a new process (after a restart, or to load new keys) resumes the conversation. */
	sessionFile?: string;
}

/** Pi's configuration folder, resolved as Pi resolves it. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
}

/** The files and folders whose changes change Pi's models or customizations. */
const piConfigEntries = ['auth.json', 'models.json', 'settings.json', 'mcp.json', 'extensions', 'skills', 'prompts'];

/**
 * Creates Pi's `auth.json` readable only by the user, as Pi itself does, so keys that
 * Waypoint's Manage Models writes into it never land in a world-readable file.
 */
async function ensurePrivateAuthFile(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	const file = join(dir, 'auth.json');
	await fs.writeFile(file, '{}', { flag: 'wx', mode: 0o600 }).catch(error => {
		if (error.code !== 'EEXIST') {
			throw error;
		}
	});
	// Only when needed: a chmod is a change the configuration watcher would see.
	if (process.platform !== 'win32' && ((await fs.stat(file)).mode & 0o077) !== 0) {
		await fs.chmod(file, 0o600);
	}
}

/**
 * Pi's `get_available_models` reply as host models, named `<provider>/<model>` as Pi's
 * `--model` takes them. `state` is Pi's `get_state` reply: its model is the user's default.
 */
function toModels(provider: string, data: unknown, state: unknown): IAgentModelInfo[] {
	const models = (data as { models?: { provider?: unknown; id?: unknown; name?: unknown; contextWindow?: unknown; reasoning?: unknown; thinkingLevelMap?: IPiThinkingLevelMap | null }[] } | undefined)?.models;
	const { model: defaultModel, thinkingLevel } = (state ?? {}) as { model?: { provider?: unknown; id?: unknown }; thinkingLevel?: string };
	return Array.isArray(models) ? models.filter(model => typeof model.provider === 'string' && typeof model.id === 'string').map(model => {
		const configSchema = model.reasoning ? createThinkingLevelSchema(piThinkingLevels(model.thinkingLevelMap), thinkingLevel) : undefined;
		return {
		provider,
		id: `${model.provider}/${model.id}`,
		name: typeof model.name === 'string' ? model.name : `${model.provider}/${model.id}`,
		supportsVision: false,
		...(typeof model.contextWindow === 'number' ? { maxContextWindow: model.contextWindow } : {}),
		...(configSchema ? { configSchema } : {}),
		...(model.provider === defaultModel?.provider && model.id === defaultModel?.id ? { _meta: { [AGENT_DEFAULT_MODEL_META_KEY]: true } } : {}),
		};
	}) : [];
}

/** What a model maps Pi's thinking levels to; `null` marks a level it does not support. */
type IPiThinkingLevelMap = Readonly<Record<string, string | null | undefined>>;

/** The levels Pi offers for a model: its standard ones unless ruled out, and the top ones only when named. */
function piThinkingLevels(map: IPiThinkingLevelMap | null | undefined): string[] {
	return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter(level => map?.[level] !== null && (map?.[level] !== undefined || !['xhigh', 'max'].includes(level)));
}

function tokens(value: unknown): number {
	return typeof value === 'number' ? value : 0;
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
	try {
		return JSON.parse(await fs.readFile(file, 'utf8'));
	} catch {
		return undefined;
	}
}

/**
 * Pi (`pi --mode rpc`), one process per chat in the chat's working folder. Pi loads its
 * own settings, extensions, skills, MCP servers and provider sign-in; Waypoint adds no
 * tools. Pi asks for approval only through extensions; an extension's `confirm` dialog
 * becomes a host confirmation.
 *
 * shortcut: dialogs other than `confirm` are cancelled; add them when an extension needs one.
 */
export class PiAgent extends CliAgentBase<IPiChat> implements IAgent {

	private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models = this._models;
	private readonly _onDidCustomizationsChange = this._register(new Emitter<void>());
	readonly onDidCustomizationsChange = this._onDidCustomizationsChange.event;
	/** Confirmation tool call id → the Pi dialog it answers. */
	private readonly _pendingDialogs = new Map<string, { readonly process: PiProcess; readonly id: string; readonly chat: IPiChat; readonly title: string }>();
	private readonly _lookAgainSequencer = new Sequencer();
	private readonly _probes = this._register(new DisposableStore());
	private readonly _watcher = this._register(new MutableDisposable());
	private readonly _configChanged = this._register(new RunOnceScheduler(() => void this._lookAgainIfConfigChanged(), 1000));
	/** Pi's configuration as last read, so writes that change nothing (Pi's own, at startup) are ignored. */
	private _configSignature: string | undefined;
	/** Skills, prompts and extension commands Pi loaded per folder, until its configuration changes. */
	private readonly _commands = new Map<string, Promise<readonly IPiCommand[]>>();

	constructor(
		private readonly _definition: IPiAgentDefinition,
		@IAgentConfigurationService _configurationService: IAgentConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super(_definition);
		this._publishSetup(_configurationService, async () => {
			const launch = await _definition.resolveLaunch();
			if (launch) {
				await ensurePrivateAuthFile(piAgentDir()).catch(error => this._logService.warn(`[${this.id}] could not prepare Pi's configuration folder: ${error}`));
			}
			return {
				download: launch ? 'ready' : 'notDownloaded',
				setupDocsUrl: 'https://pi.dev',
				// Pi's sign-in is its own `/login`, inside Pi.
				loginCommand: launch ? [launch.command] : undefined,
				// Pi's own installer, so that `pi update` and `pi install` work.
				installCommand: agentInstallCommands.pi,
			};
		}, () => void this._lookAgain());
		void this._lookAgain();
	}

	protected _createChat(chat: URI, session: URI): IPiChat {
		return { chat, session, startedToolCalls: new Set() };
	}

	// #region Setup, models and configuration

	/**
	 * Reads Pi's models and customizations again. Runs at startup, when the setup banner
	 * asks (after Pi was installed or signed in in a terminal), and when Pi's configuration changes.
	 */
	private _lookAgain(): Promise<void> {
		return this._lookAgainSequencer.queue(async () => {
			const launch = await this._definition.resolveLaunch();
			const dir = piAgentDir();
			this._watch(dir);
			this._configSignature = await this._readConfigSignature(dir);
			this._commands.clear();
			// Pi reads keys and models only when it starts, so idle chats restart; the next message resumes their session.
			for (const chat of this._chats.values()) {
				if (chat.process && !chat.turnId) {
					const piProcess = chat.process;
					chat.process = undefined;
					piProcess.dispose();
				}
			}
			const [models, state] = launch ? await this._probe(launch, homedir(), 'get_available_models', 'get_state').catch(() => []) : [];
			this._models.set(toModels(this.id, models, state), undefined);
			this._onDidCustomizationsChange.fire();
		}).catch(error => this._logService.error(`[${this.id}] could not read Pi's configuration: ${error}`));
	}

	private async _lookAgainIfConfigChanged(): Promise<void> {
		if (await this._readConfigSignature(piAgentDir()) !== this._configSignature) {
			await this._lookAgain();
		}
	}

	private async _readConfigSignature(dir: string): Promise<string> {
		const parts = await Promise.all(piConfigEntries.map(entry => fs.readFile(join(dir, entry), 'utf8').catch(() => fs.readdir(join(dir, entry)).then(names => names.join('\n'), () => ''))));
		return parts.join('\0');
	}

	private _watch(dir: string): void {
		if (this._watcher.value) {
			return;
		}
		try {
			const watcher = watch(dir, (_event, file) => {
				if (file && piConfigEntries.includes(String(file))) {
					this._configChanged.schedule();
				}
			});
			watcher.on('error', () => this._watcher.clear());
			this._watcher.value = toDisposable(() => watcher.close());
		} catch {
			// Pi has not created its folder yet; the next look tries again.
		}
	}

	/** Asks a short-lived Pi some questions. */
	private async _probe(launch: IPiLaunch, cwd: string, ...types: string[]): Promise<unknown[]> {
		if (this._store.isDisposed) {
			return [];
		}
		const piProcess = this._probes.add(new PiProcess(launch, cwd, message => this._logService.trace(`[${this.id}] probe: ${message}`)));
		try {
			return await raceTimeout(Promise.all(types.map(type => piProcess.request({ type }))), 30_000) ?? [];
		} finally {
			this._probes.delete(piProcess);
		}
	}

	/** Pi's skills, prompt templates, packages, extensions and MCP servers for the chat's folder, as Pi reports and configures them. */
	override async getChatCustomizations(chatUri: URI): Promise<readonly Customization[]> {
		const launch = await this._definition.resolveLaunch();
		if (!launch) {
			return [];
		}
		const chat = this._chats.get(chatUri.toString());
		const folder = chat?.workingDirectory?.fsPath;
		let commands = this._commands.get(folder ?? '');
		if (!commands) {
			commands = (chat?.process ? chat.process.request({ type: 'get_commands' }) : this._probe(launch, folder ?? homedir(), 'get_commands').then(([data]) => data))
				.then(data => (data as { commands?: IPiCommand[] } | undefined)?.commands ?? [], () => []);
			this._commands.set(folder ?? '', commands);
		}
		// The user's configuration, then the project's (`.pi`), as Pi reads them.
		const configDirs = [piAgentDir(), ...(folder ? [join(folder, '.pi')] : [])];
		const perDir = await Promise.all(configDirs.map(async dir => {
			const settingsFile = join(dir, 'settings.json');
			const packages = (await readJson(settingsFile))?.packages;
			const mcpServers = (await readJson(join(dir, 'mcp.json')))?.mcpServers;
			return {
				mcpFile: { file: join(dir, 'mcp.json'), servers: mcpServers && typeof mcpServers === 'object' ? Object.keys(mcpServers) : [] },
				packages: (Array.isArray(packages) ? packages : [])
					.map(entry => typeof entry === 'string' ? entry : (entry as { source?: unknown } | undefined)?.source)
					.filter((source): source is string => typeof source === 'string')
					.map(source => ({ settingsFile, source })),
				extensions: await fs.readdir(join(dir, 'extensions')).then(names => names.map(name => join(dir, 'extensions', name)), () => []),
			};
		}));
		return toPiCustomizations({
			commands: await commands,
			mcpFiles: perDir.map(entry => entry.mcpFile),
			packages: perDir.flatMap(entry => entry.packages),
			extensions: perDir.flatMap(entry => entry.extensions),
		});
	}

	// #endregion

	private async _ensureProcess(chat: IPiChat, workingDirectory: URI | undefined): Promise<PiProcess> {
		if (chat.process) {
			return chat.process;
		}
		const launch = await this._definition.resolveLaunch();
		if (!launch) {
			throw new Error(localize('pi.notInstalled', "{0} is not installed. Install it, or set `chat.agentHost.binaryPaths` to the location of the `pi` command.", this._definition.displayName));
		}
		const piProcess = new PiProcess(launch, (workingDirectory ?? chat.workingDirectory)?.fsPath ?? tmpdir(), message => this._logService.info(`[${this.id}] ${message}`));
		chat.process = piProcess;
		piProcess.own(piProcess.onDidEvent(record => this._handleEvent(chat, piProcess, record)));
		piProcess.own(piProcess.onDidExit(() => {
			if (chat.process !== piProcess) {
				return;
			}
			chat.process = undefined;
			if (chat.turnId) {
				this._failTurn(chat, chat.turnId, 'pi_exited', localize('pi.exited', "Pi stopped unexpectedly."));
			}
		}));
		if (chat.sessionFile) {
			await piProcess.request({ type: 'switch_session', sessionPath: chat.sessionFile }).catch(error => this._logService.warn(`[${this.id}] could not resume ${chat.sessionFile}: ${error}`));
		}
		const state = await piProcess.request({ type: 'get_state' }).catch(() => undefined) as { sessionFile?: unknown } | undefined;
		if (typeof state?.sessionFile === 'string' && state.sessionFile !== chat.sessionFile) {
			chat.sessionFile = state.sessionFile;
			this._onDidChangeChatData.fire({ chat: chat.chat, providerData: state.sessionFile });
		}
		void piProcess.request({ type: 'get_available_models' }).then(data => this._models.set(toModels(this.id, data, state), undefined), () => { });
		if (chat.model) {
			await this._setModel(piProcess, chat.model);
		}
		return piProcess;
	}

	private async _setModel(piProcess: PiProcess, model: ModelSelection): Promise<void> {
		const separator = model.id.indexOf('/');
		if (separator > 0) {
			await piProcess.request({ type: 'set_model', provider: model.id.slice(0, separator), modelId: model.id.slice(separator + 1) });
		}
		const level = model.config?.[ReasoningEffortConfigKey];
		if (level) {
			await piProcess.request({ type: 'set_thinking_level', level });
		}
	}

	readonly chats: IAgentChats = {
		createChat: async (chatUri: URI, context: URI | IAgentChatContext, options?: IAgentCreateChatOptions): Promise<IAgentCreateChatResult | void> => {
			const chat = this._chat(chatUri, context);
			chat.workingDirectory = options?.workingDirectories?.[0] ?? chat.workingDirectory;
			chat.model = options?.model ?? chat.model;
		},
		disposeChat: async (chatUri: URI): Promise<void> => this._forget(chatUri),
		releaseChat: async (chatUri: URI): Promise<void> => this._forget(chatUri),
		sendMessage: async (chatUri: URI, prompt: string, workingDirectoriesOrDirectory: readonly URI[] | URI | undefined, attachments?: readonly MessageAttachment[], turnId?: string, _senderClientId?: string, _clientType?: unknown, context?: URI | IAgentChatContext): Promise<void> => {
			const chat = this._chat(chatUri, context);
			const workingDirectory = URI.isUri(workingDirectoriesOrDirectory) ? workingDirectoriesOrDirectory : workingDirectoriesOrDirectory?.[0];
			chat.workingDirectory = workingDirectory ?? chat.workingDirectory;
			const activeTurn = turnId ?? generateUuid();
			this._beginTurn(chat, activeTurn);
			try {
				const piProcess = await this._ensureProcess(chat, workingDirectory);
				const result = await piProcess.request({ type: 'prompt', message: this._withSurfaceInstructions(resolvePromptToText(prompt, attachments), context) }) as { disposition?: unknown } | undefined;
				// `handled` means no run started (for example a slash command Pi answered itself), so no `agent_settled` follows.
				if (result?.disposition === 'handled') {
					this._endTurn(chat, activeTurn);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this._failTurn(chat, activeTurn, 'pi_error', this._definition.noApiKeyMessage && message.startsWith('No API key found') ? this._definition.noApiKeyMessage : message);
			}
		},
		abort: async (chatUri: URI): Promise<void> => {
			const chat = this._chats.get(chatUri.toString());
			chat?.process?.send({ type: 'abort' });
			for (const [toolCallId, dialog] of this._pendingDialogs) {
				if (dialog.process === chat?.process) {
					this._pendingDialogs.delete(toolCallId);
					dialog.process.send({ type: 'extension_ui_response', id: dialog.id, cancelled: true });
				}
			}
		},
		changeModel: async (chatUri: URI, model: ModelSelection): Promise<void> => {
			const chat = this._chats.get(chatUri.toString());
			if (!chat) {
				return;
			}
			chat.model = model;
			if (chat.process) {
				await this._setModel(chat.process, model);
			}
		},
		changeAgent: async (_chatUri: URI, _agent: AgentSelection | undefined): Promise<void> => { },
		getMessages: async (): Promise<readonly Turn[]> => [],
	};

	async materializeChat(chatUri: URI, context: URI | IAgentChatContext, providerData: string | undefined): Promise<IAgentCreateChatResult | void> {
		const chat = this._chat(chatUri, context);
		chat.sessionFile ??= providerData;
	}

	private _forget(chatUri: URI): void {
		this._chats.get(chatUri.toString())?.process?.dispose();
		this._chats.delete(chatUri.toString());
	}

	private _handleEvent(chat: IPiChat, piProcess: PiProcess, record: PiRecord): void {
		switch (record.type) {
			case 'message_update': {
				const event = record.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
				if (typeof event?.delta === 'string' && (event.type === 'text_delta' || event.type === 'thinking_delta')) {
					this._appendText(chat, event.delta, event.type === 'thinking_delta');
				}
				return;
			}
			case 'message_end': {
				const message = record.message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown; usage?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown } } | undefined;
				if (message?.role === 'assistant' && message.usage && chat.turnId) {
					const { input, output, cacheRead, cacheWrite } = message.usage;
					this._fire(chat, {
						type: ActionType.ChatUsage,
						turnId: chat.turnId,
						usage: { inputTokens: tokens(input) + tokens(cacheRead) + tokens(cacheWrite), outputTokens: tokens(output), cacheReadTokens: tokens(cacheRead) },
					});
				}
				if (message?.role === 'assistant' && message.stopReason === 'error' && chat.turnId) {
					this._failTurn(chat, chat.turnId, 'pi_model_error', typeof message.errorMessage === 'string' ? message.errorMessage : localize('pi.modelError', "Pi reported a model error."));
				}
				return;
			}
			case 'tool_execution_start':
				this._startTool(chat, String(record.toolCallId), String(record.toolName ?? 'tool'));
				return;
			case 'tool_execution_end':
				this._completeTool(chat, String(record.toolCallId), String(record.toolName ?? 'tool'), record.isError !== true, resultText(record.result));
				return;
			case 'agent_settled':
				if (chat.turnId) {
					this._endTurn(chat, chat.turnId);
				}
				return;
			case 'extension_ui_request': {
				const id = String(record.id);
				if (record.method !== 'confirm' || !chat.turnId) {
					piProcess.send({ type: 'extension_ui_response', id, cancelled: true });
					return;
				}
				const toolCallId = `pi-dialog-${id}`;
				const title = String(record.title ?? 'Pi');
				this._pendingDialogs.set(toolCallId, { process: piProcess, id, chat, title });
				this._requestConfirmation(chat, toolCallId, title, typeof record.message === 'string' ? record.message : undefined);
				return;
			}
		}
	}

	respondToPermissionRequest(toolCallId: string, approved: boolean): void {
		const dialog = this._pendingDialogs.get(toolCallId);
		if (dialog) {
			this._pendingDialogs.delete(toolCallId);
			this._completeTool(dialog.chat, toolCallId, dialog.title, approved, '');
			dialog.process.send({ type: 'extension_ui_response', id: dialog.id, confirmed: approved });
		}
	}

	async shutdown(): Promise<void> {
		for (const chat of this._chats.values()) {
			chat.process?.dispose();
		}
	}

	override dispose(): void {
		void this.shutdown();
		super.dispose();
	}
}

/** Text of a Pi tool result: its text content blocks, or the value itself when it is a string. */
function resultText(result: unknown): string {
	if (typeof result === 'string') {
		return result;
	}
	const content = (result as { content?: unknown } | undefined)?.content;
	return Array.isArray(content) ? content.map(block => (block as { text?: unknown }).text).filter((text): text is string => typeof text === 'string').join('\n') : '';
}
