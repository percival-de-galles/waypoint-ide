/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AnyZodRawShape, ForkSessionOptions, ForkSessionResult, GetSessionMessagesOptions, GetSubagentMessagesOptions, InferShape, ListSessionsOptions, ListSubagentsOptions, McpSdkServerConfigWithInstance, Options, Query, SDKSessionInfo, SDKUserMessage, SdkMcpToolDefinition, SessionMessage, SessionMutationOptions, WarmQuery, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'url';
import { join } from '../../../../base/common/path.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import { IAgentSdkPackage } from '../agentSdkDownloader.js';
import { AgentHostClaudeSdkRootEnvVar } from '../../common/agentService.js';
import { resolveAgentBinary } from '../agentBinary.js';

/**
 * `@anthropic-ai/claude-agent-sdk` distribution descriptor. Lives in this
 * file because it encodes Claude-specific knowledge — the env-var name
 * and the fact that Claude ships separate `linux-{x64,arm64}-musl` SKUs
 * alongside the default glibc ones. The downloader consumes this through
 * `IAgentSdkPackage` and never names Claude directly.
 */
export const ClaudeSdkPackage: IAgentSdkPackage = {
	id: 'claude',
	displayName: 'Claude',
	devOverrideEnvVar: AgentHostClaudeSdkRootEnvVar,
	hasSeparateMuslLinuxPackage: true,
};

/**
 * SDK escape hatch for its "precompact skip" optimization. Above a ~5 MB
 * transcript the SDK reads back only the bytes AFTER the last compact
 * boundary, which silently truncates the history `getSessionMessages`
 * returns — the slice can begin mid-turn, or contain no user prompt at all.
 * Replay then reconstructs a partial (or empty) conversation, so we opt out
 * and pay the full read. Read by the SDK from `process.env` on every call.
 */
const ClaudeDisablePrecompactSkipEnvVar = 'CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP';

export const IClaudeAgentSdkService = createDecorator<IClaudeAgentSdkService>('claudeAgentSdkService');

/**
 * Lazily loads `@anthropic-ai/claude-agent-sdk`, coalesces concurrent catalogue scans,
 * and detaches returned session metadata from transcript buffers.
 */
export interface IClaudeAgentSdkService {
	readonly _serviceBrand: undefined;

	listSessions(): Promise<readonly SDKSessionInfo[]>;
	getSessionInfo(sessionId: string): Promise<SDKSessionInfo | undefined>;
	startup(params: { options: Options; initializeTimeoutMs?: number }): Promise<WarmQuery>;
	/**
	 * 1:1 with the SDK's top-level `query` export. Returns a `Query` whose
	 * subprocess starts lazily; callers drive control requests on it (e.g.
	 * `supportedModels()` for model enumeration) and `close()` it when done.
	 * Async only because the SDK module itself is loaded lazily.
	 */
	query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Promise<Query>;
	getSessionMessages(sessionId: string, options?: GetSessionMessagesOptions): Promise<readonly SessionMessage[]>;
	listSubagents(sessionId: string, options?: ListSubagentsOptions): Promise<readonly string[]>;
	getSubagentMessages(sessionId: string, agentId: string, options?: GetSubagentMessagesOptions): Promise<readonly SessionMessage[]>;

	/**
	 * True iff the SDK can be loaded WITHOUT a network download. Eager /
	 * background callers (e.g. `listSessions` at startup) gate on this.
	 */
	canLoadWithoutDownload(): Promise<boolean>;
	/**
	 * Makes the SDK available without loading the module. Reserved for
	 * user-initiated activation; background callers gate on
	 * {@link canLoadWithoutDownload} instead.
	 */
	ensureAvailable(): Promise<void>;

	forkSession(sessionId: string, options?: ForkSessionOptions): Promise<ForkSessionResult>;
	deleteSession(sessionId: string, options?: SessionMutationOptions): Promise<void>;
	createSdkMcpServer(options: {
		name: string;
		version?: string;
		// SDK signature: `tools?: Array<SdkMcpToolDefinition<any>>`. The `any`
		// here is required to match the SDK's own erased generic and to allow
		// callers to pass an array of tools whose schemas differ from each other.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		tools?: Array<SdkMcpToolDefinition<any>>;
	}): Promise<McpSdkServerConfigWithInstance>;

	tool<Schema extends AnyZodRawShape>(
		name: string,
		description: string,
		inputSchema: Schema,
		handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
		options?: Parameters<typeof tool>[4],
	): Promise<SdkMcpToolDefinition<Schema>>;
}

/**
 * Narrowed structural slice of `@anthropic-ai/claude-agent-sdk` covering
 * exactly the bindings the agent host pulls from the SDK. Production
 * `import()` returns the full module which is structurally assignable to
 * this interface. Tests usually stub {@link IClaudeAgentSdkService} via
 * the DI container, but a few existing suites subclass
 * {@link ClaudeAgentSdkService} and override {@link ClaudeAgentSdkService._loadSdk}
 * to fault or stub these bindings without having to name every export of
 * the SDK module — `_loadSdk` is `protected` for that reason.
 */
export interface IClaudeSdkBindings {
	listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]>;
	getSessionInfo(sessionId: string): Promise<SDKSessionInfo | undefined>;
	startup(params: { options: Options; initializeTimeoutMs?: number }): Promise<WarmQuery>;
	query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query;
	getSessionMessages(sessionId: string, options?: GetSessionMessagesOptions): Promise<SessionMessage[]>;
	listSubagents(sessionId: string, options?: ListSubagentsOptions): Promise<string[]>;
	getSubagentMessages(sessionId: string, agentId: string, options?: GetSubagentMessagesOptions): Promise<SessionMessage[]>;
	forkSession(sessionId: string, options?: ForkSessionOptions): Promise<ForkSessionResult>;
	deleteSession(sessionId: string, options?: SessionMutationOptions): Promise<void>;
	createSdkMcpServer(options: {
		name: string;
		version?: string;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		tools?: Array<SdkMcpToolDefinition<any>>;
	}): McpSdkServerConfigWithInstance;
	tool<Schema extends AnyZodRawShape>(
		name: string,
		description: string,
		inputSchema: Schema,
		handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
		options?: Parameters<typeof tool>[4],
	): SdkMcpToolDefinition<Schema>;
}

export class ClaudeAgentSdkService implements IClaudeAgentSdkService {
	declare readonly _serviceBrand: undefined;

	/**
	 * Cached resolved bindings. We deliberately cache the *resolved* value,
	 * not the in-flight promise — if a transient `import()` failure recovers
	 * (e.g. user fixes a broken `node_modules`), the next call retries.
	 */
	private _sdkModule: IClaudeSdkBindings | undefined;
	private _listSessionsPromise: Promise<readonly SDKSessionInfo[]> | undefined;

	/**
	 * Latched once we've logged a load failure, so a corrupt postinstall
	 * doesn't flood `error` events on every `listSessions()` call.
	 */
	private _firstLoadFailureLogged = false;

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		// Set before any SDK call so full transcripts are always read back.
		// An explicit value from the environment wins so the optimization can
		// still be re-enabled from outside.
		if (process.env[ClaudeDisablePrecompactSkipEnvVar] === undefined) {
			process.env[ClaudeDisablePrecompactSkipEnvVar] = '1';
		}
	}

	async listSessions(): Promise<readonly SDKSessionInfo[]> {
		if (this._listSessionsPromise) {
			return this._listSessionsPromise;
		}
		this._listSessionsPromise = (async () => {
			const sdk = await this._getSdk();
			// SDK metadata can contain sliced strings that keep entire transcript read buffers alive.
			return structuredClone(await sdk.listSessions(undefined));
		})();
		try {
			return await this._listSessionsPromise;
		} finally {
			this._listSessionsPromise = undefined;
		}
	}

	async canLoadWithoutDownload(): Promise<boolean> {
		// The SDK ships in the product's own `node_modules`; nothing is downloaded.
		return true;
	}

	async ensureAvailable(): Promise<void> { }

	async getSessionInfo(sessionId: string): Promise<SDKSessionInfo | undefined> {
		const sdk = await this._getSdk();
		return structuredClone(await sdk.getSessionInfo(sessionId));
	}

	async startup(params: { options: Options; initializeTimeoutMs?: number }): Promise<WarmQuery> {
		const sdk = await this._getSdk();
		return sdk.startup({ ...params, options: { ...params.options, pathToClaudeCodeExecutable: await resolveClaudeExecutable() } });
	}

	async query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Promise<Query> {
		const sdk = await this._getSdk();
		return sdk.query({ ...params, options: { ...params.options, pathToClaudeCodeExecutable: await resolveClaudeExecutable() } });
	}

	async getSessionMessages(sessionId: string, options?: GetSessionMessagesOptions): Promise<readonly SessionMessage[]> {
		const sdk = await this._getSdk();
		return sdk.getSessionMessages(sessionId, options);
	}

	async listSubagents(sessionId: string, options?: ListSubagentsOptions): Promise<readonly string[]> {
		const sdk = await this._getSdk();
		return sdk.listSubagents(sessionId, options);
	}

	async getSubagentMessages(sessionId: string, agentId: string, options?: GetSubagentMessagesOptions): Promise<readonly SessionMessage[]> {
		const sdk = await this._getSdk();
		return sdk.getSubagentMessages(sessionId, agentId, options);
	}

	async forkSession(sessionId: string, options?: ForkSessionOptions): Promise<ForkSessionResult> {
		const sdk = await this._getSdk();
		return sdk.forkSession(sessionId, options);
	}

	async deleteSession(sessionId: string, options?: SessionMutationOptions): Promise<void> {
		const sdk = await this._getSdk();
		return sdk.deleteSession(sessionId, options);
	}

	async createSdkMcpServer(options: {
		name: string;
		version?: string;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		tools?: Array<SdkMcpToolDefinition<any>>;
	}): Promise<McpSdkServerConfigWithInstance> {
		const sdk = await this._getSdk();
		return sdk.createSdkMcpServer(options);
	}

	async tool<Schema extends AnyZodRawShape>(
		name: string,
		description: string,
		inputSchema: Schema,
		handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
		options?: Parameters<typeof tool>[4],
	): Promise<SdkMcpToolDefinition<Schema>> {
		const sdk = await this._getSdk();
		return sdk.tool(name, description, inputSchema, handler, options);
	}

	private async _getSdk(): Promise<IClaudeSdkBindings> {
		if (this._sdkModule) {
			return this._sdkModule;
		}
		try {
			this._sdkModule = await this._loadSdk();
			return this._sdkModule;
		} catch (err) {
			if (!this._firstLoadFailureLogged) {
				this._firstLoadFailureLogged = true;
				this._logService.error('[Claude] Failed to load @anthropic-ai/claude-agent-sdk', err);
			}
			throw err;
		}
	}

	protected async _loadSdk(): Promise<IClaudeSdkBindings> {
		// Env-var override (`--claude-sdk-root`) points at an out-of-tree SDK
		// build without touching `node_modules`.
		const override = process.env[AgentHostClaudeSdkRootEnvVar];
		if (override) {
			const entry = join(override, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');
			return import(pathToFileURL(entry).href);
		}
		// A production dependency in dev and built products alike. Only its JS
		// ships; its per-platform Claude binaries are stripped by
		// `build/.moduleignore` since sessions run the user's own `claude`.
		return import('@anthropic-ai/claude-agent-sdk');
	}
}

// #region Compile-time SDK drift detection
//
// Enforce that every method on IClaudeSdkBindings names a real export of
// `@anthropic-ai/claude-agent-sdk` and is assignable from that export's
// type. If the SDK renames or changes the signature of any of these
// exports, the `_assertBindingsMatchSdk` assignment below stops type-
// checking and the build fails — flagging that the shim needs updating.

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

type AssertBindingsMatchSdk = {
	[K in keyof IClaudeSdkBindings]: K extends keyof SdkModule
	? SdkModule[K] extends IClaudeSdkBindings[K]
	? true
	: ['SDK export signature drifted from IClaudeSdkBindings', K, SdkModule[K], IClaudeSdkBindings[K]]
	: ['Not an export of @anthropic-ai/claude-agent-sdk', K];
};

// Forces the mapped type above to be eagerly checked: if any entry is not
// `true`, this assignment fails to compile. Module-local so the runtime
// surface stays clean — the only purpose is the type-level assertion.
const _assertBindingsMatchSdk: { [K in keyof IClaudeSdkBindings]: true } = null as unknown as AssertBindingsMatchSdk;
void _assertBindingsMatchSdk;

// #endregion

/** The user's installed Claude Code CLI, which every session runs on its own settings and sign-in. */
async function resolveClaudeExecutable(): Promise<string> {
	const executable = await resolveAgentBinary('claude', 'claude');
	if (!executable) {
		throw new Error(localize('claude.cliNotFound', "Claude Code is not installed. Install it, or set `chat.agentHost.binaryPaths` to the location of the `claude` command."));
	}
	return executable;
}
