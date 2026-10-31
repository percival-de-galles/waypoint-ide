/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Database } from '@vscode/sqlite3';
import { createReadStream, promises as fs } from 'fs';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { raceTimeout, Sequencer } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { ILogService } from '../../../log/common/log.js';
import { AGENT_USAGE_KEY, AGENT_USAGE_LIMITS_KEY, AGENT_USAGE_LIMITS_REQUEST_KEY, AGENT_USAGE_REQUEST_KEY, type AgentUsageWindowId, type IAgentUsageCost, type IAgentUsageDay, type IAgentUsageLimits, type IAgentUsageSnapshot, type IAgentUsageWindow } from '../../common/agentUsage.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';
import { IClaudeAgentSdkService } from '../claude/claudeAgentSdkService.js';
import { buildModelEnumerationOptions, createIdlePrompt } from '../claude/claudeSdkOptions.js';
import { piAgentDir } from '../pi/piAgent.js';
import { createCodexUsageParser, parseClaudeUsageLine, parseOpenCodeUsageRow, parsePiUsageLine, type IAgentUsageRecord } from './agentUsageParsers.js';
import { priceUsage } from './agentUsagePricing.js';

const HISTORY_DAYS = 90;
const LIMITS_TIMEOUT_MS = 15_000;
const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

const claudeWindows: Readonly<Record<string, AgentUsageWindowId>> = {
	five_hour: 'session',
	seven_day: 'weekly',
	seven_day_opus: 'weeklyOpus',
	seven_day_sonnet: 'weeklySonnet',
};

type IMutableUsageDay = { -readonly [K in keyof IAgentUsageDay]: IAgentUsageDay[K] } & { cost: { -readonly [K in keyof IAgentUsageCost]: IAgentUsageCost[K] } };

/** Local calendar day of an epoch time, the day the Usage view charts it under. */
function localDay(timestamp: number): string {
	const date = new Date(timestamp);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function openCodeDataDir(): string {
	return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode');
}

/** Every `.jsonl` file under `dir` written since `since`. A missing folder has none. */
async function recentLogFiles(dir: string, since: number): Promise<string[]> {
	const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
	const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl')).map(entry => join(entry.parentPath, entry.name));
	const stats = await Promise.all(files.map(file => fs.stat(file).catch(() => undefined)));
	return files.filter((_file, index) => (stats[index]?.mtimeMs ?? 0) >= since);
}

async function* readLines(file: string): AsyncIterable<string> {
	const stream = createReadStream(file, { encoding: 'utf8' });
	try {
		yield* createInterface({ input: stream, crlfDelay: Infinity });
	} finally {
		stream.destroy();
	}
}

/** Opens `file` read-only, runs `read`, and closes it. */
async function withReadOnlyDatabase<T>(file: string, read: (database: Database) => Promise<T>): Promise<T> {
	const sqlite3 = (await import('@vscode/sqlite3')).default;
	const database = await new Promise<Database>((resolve, reject) => {
		const opened: Database = new sqlite3.Database(file, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(opened));
	});
	try {
		return await read(database);
	} finally {
		database.close();
	}
}

function queryAll<T>(database: Database, sql: string, params: unknown[] = []): Promise<T[]> {
	return new Promise((resolve, reject) => database.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows as T[])));
}

/**
 * Answers the Usage view. Token history comes from each agent's own session logs on this
 * machine. Plan limits come from each agent's own reporting: Claude Code's usage request,
 * so its sign-in is never touched here, and OpenCode's usage endpoint with the key the user
 * gave OpenCode. Codex's limits reach the window through its account service instead.
 */
export class AgentUsageCollector extends Disposable {

	private readonly _sequencer = new Sequencer();
	private readonly _limitsSequencer = new Sequencer();
	private _lastRequest: string | undefined;
	private _lastLimitsRequest: string | undefined;

	constructor(
		@IAgentConfigurationService private readonly _configurationService: IAgentConfigurationService,
		@IClaudeAgentSdkService private readonly _claudeSdkService: IClaudeAgentSdkService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(_configurationService.onDidRootConfigChange(() => {
			const values = _configurationService.getRootConfigValues?.();
			const request = values?.[AGENT_USAGE_REQUEST_KEY];
			if (typeof request === 'string' && request !== this._lastRequest) {
				this._lastRequest = request;
				_configurationService.updateRootConfig({ [AGENT_USAGE_REQUEST_KEY]: undefined });
				void this._sequencer.queue(() => this._collectHistory());
			}
			const limitsRequest = values?.[AGENT_USAGE_LIMITS_REQUEST_KEY];
			if (typeof limitsRequest === 'string' && limitsRequest !== this._lastLimitsRequest) {
				this._lastLimitsRequest = limitsRequest;
				_configurationService.updateRootConfig({ [AGENT_USAGE_LIMITS_REQUEST_KEY]: undefined });
				void this._limitsSequencer.queue(() => this._collectLimits());
			}
		}));
	}

	private async _collectHistory(): Promise<void> {
		const started = Date.now();
		const days = await this._readHistory(started - HISTORY_DAYS * 24 * 60 * 60 * 1000);
		const snapshot: IAgentUsageSnapshot = { days, updatedAt: Date.now() };
		this._logService.info(`[Usage] Read ${days.length} day rows in ${Date.now() - started}ms`);
		if (!this._store.isDisposed) {
			this._configurationService.publishRootTransientValues?.({ [AGENT_USAGE_KEY]: snapshot });
		}
	}

	private async _collectLimits(): Promise<void> {
		const limits = await this._readLimits();
		if (!this._store.isDisposed) {
			this._configurationService.publishRootTransientValues?.({ [AGENT_USAGE_LIMITS_KEY]: limits });
		}
	}

	// #region Token history

	private async _readHistory(since: number): Promise<IAgentUsageDay[]> {
		const days = new Map<string, IMutableUsageDay>();
		const addAll = async (agent: string, read: () => Promise<readonly IAgentUsageRecord[]>) => {
			const seen = new Set<string>();
			const records = await read().catch(error => {
				this._logService.warn(`[Usage] Could not read ${agent} history: ${error}`);
				return [];
			});
			for (const record of records) {
				if (record.timestamp < since || (record.dedupeKey && seen.has(record.dedupeKey))) {
					continue;
				}
				if (record.dedupeKey) {
					seen.add(record.dedupeKey);
				}
				const day = localDay(record.timestamp);
				const key = `${agent}\0${day}\0${record.model}`;
				const row = days.get(key) ?? { agent, day, model: record.model, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: { reported: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, unpricedTokens: 0 };
				row.input += record.input;
				row.cacheRead += record.cacheRead;
				row.cacheWrite += record.cacheWrite;
				row.output += record.output;
				const cost = priceUsage(record);
				if (cost) {
					row.cost.reported += cost.reported;
					row.cost.input += cost.input;
					row.cost.cacheRead += cost.cacheRead;
					row.cost.cacheWrite += cost.cacheWrite;
					row.cost.output += cost.output;
				} else {
					row.unpricedTokens += record.input + record.cacheRead + record.cacheWrite + record.output;
				}
				days.set(key, row);
			}
		};
		const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
		const codexDir = process.env.CODEX_HOME || join(homedir(), '.codex');
		await Promise.all([
			addAll('claude', () => this._readLogs(join(claudeDir, 'projects'), since, () => parseClaudeUsageLine)),
			addAll('codex', () => this._readLogs(join(codexDir, 'sessions'), since, createCodexUsageParser)),
			addAll('pi', () => this._readLogs(process.env.PI_CODING_AGENT_SESSION_DIR || join(piAgentDir(), 'sessions'), since, () => parsePiUsageLine)),
			addAll('opencode', () => this._readOpenCode(since)),
		]);
		return [...days.values()];
	}

	private async _readLogs(dir: string, since: number, createParser: () => (line: string) => IAgentUsageRecord | undefined): Promise<IAgentUsageRecord[]> {
		const records: IAgentUsageRecord[] = [];
		for (const file of await recentLogFiles(dir, since)) {
			const parse = createParser();
			for await (const line of readLines(file)) {
				// Most lines are prompts and tool output; only these can hold tokens.
				if (line.includes('"usage"') || line.includes('token_count') || line.includes('turn_context')) {
					const record = parse(line);
					if (record) {
						records.push(record);
					}
				}
			}
		}
		return records;
	}

	private async _readOpenCode(since: number): Promise<IAgentUsageRecord[]> {
		const file = join(openCodeDataDir(), 'opencode.db');
		if (!await fs.stat(file).catch(() => undefined)) {
			return [];
		}
		return withReadOnlyDatabase(file, async database => {
			const tables = new Set((await queryAll<{ name: string }>(database, `SELECT name FROM sqlite_master WHERE type = 'table'`)).map(row => row.name));
			const query = tables.has('session_message')
				? `SELECT data, time_created AS created FROM session_message WHERE type = 'assistant' AND time_created >= ?`
				: tables.has('message') ? `SELECT data, time_created AS created FROM message WHERE time_created >= ?` : undefined;
			const rows = query ? await queryAll<{ data: string; created: number }>(database, query, [since]) : [];
			return rows.map(row => parseOpenCodeUsageRow(row.data, row.created)).filter(record => record !== undefined);
		});
	}

	// #endregion

	// #region Plan limits

	private async _readLimits(): Promise<IAgentUsageLimits[]> {
		const limits = await Promise.all([
			raceTimeout(this._readClaudeLimits(), LIMITS_TIMEOUT_MS),
			raceTimeout(this._readOpenCodeGoLimits(), LIMITS_TIMEOUT_MS),
		]);
		return limits.filter(limit => limit !== undefined);
	}

	private _lastClaudeLimits: IAgentUsageLimits | undefined;

	private async _readClaudeLimits(): Promise<IAgentUsageLimits | undefined> {
		// The enumeration options turn off nonessential traffic, which includes the plan usage this reads.
		const options = { ...buildModelEnumerationOptions(), settings: undefined };
		try {
			const query = await this._claudeSdkService.query({ prompt: createIdlePrompt(), options });
			try {
				const usage = await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
				const windows: IAgentUsageWindow[] = [];
				for (const [key, id] of Object.entries(claudeWindows)) {
					const window = usage.rate_limits?.[key as keyof typeof usage.rate_limits] as { utilization?: number | null; resets_at?: string | null } | null | undefined;
					if (typeof window?.utilization === 'number') {
						windows.push({ id, usedPercent: window.utilization, resetsAt: window.resets_at ? Date.parse(window.resets_at) : undefined });
					}
				}
				if (!windows.length) {
					this._logService.info(`[Usage] Claude reported no limits (available: ${usage.rate_limits_available}, windows: ${Object.keys(usage.rate_limits ?? {})})`);
					// A plan that is available but empty is a blip, so its card stays with the last reading.
					return usage.rate_limits_available ? this._lastClaudeLimits : undefined;
				}
				return this._lastClaudeLimits = { agent: 'claude', plan: usage.subscription_type ?? undefined, windows };
			} finally {
				query.close();
			}
		} catch (error) {
			// Not installed or signed out: there is nothing to show.
			this._logService.info(`[Usage] No Claude limits: ${error}`);
			return undefined;
		} finally {
			options.abortController?.abort();
		}
	}

	private async _readOpenCodeGoLimits(): Promise<IAgentUsageLimits | undefined> {
		const key = await this._findOpenCodeGoKey();
		if (!key) {
			return undefined;
		}
		try {
			const response = await fetch(OPENCODE_GO_USAGE_URL, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(LIMITS_TIMEOUT_MS) });
			const usage = response.ok ? ((await response.json()) as { usage?: Record<string, { percent?: unknown; resetsAt?: unknown } | undefined> }).usage : undefined;
			const windows: IAgentUsageWindow[] = [];
			for (const [name, id] of [['rolling', 'session'], ['weekly', 'weekly'], ['monthly', 'monthly']] as const) {
				const window = usage?.[name];
				if (typeof window?.percent === 'number') {
					windows.push({ id, usedPercent: window.percent, resetsAt: typeof window.resetsAt === 'string' ? Date.parse(window.resetsAt) : undefined });
				}
			}
			return windows.length ? { agent: 'opencode', plan: 'OpenCode Go', windows } : undefined;
		} catch (error) {
			// Only the error's name: its message can quote the authenticated request.
			this._logService.info(`[Usage] No OpenCode Go limits: ${error instanceof Error ? error.name : 'unknown error'}`);
			return undefined;
		}
	}

	/** The user's OpenCode Go key, from OpenCode's own store or Pi's, where they may have added it instead. */
	private async _findOpenCodeGoKey(): Promise<string | undefined> {
		const fromDatabase = await withReadOnlyDatabase(join(openCodeDataDir(), 'opencode.db'), async database => {
			const rows = await queryAll<{ value: string }>(database, `SELECT value FROM credential WHERE integration_id = 'opencode-go' ORDER BY active DESC, time_created DESC`);
			return rows.length ? (JSON.parse(rows[0].value) as { key?: unknown }).key : undefined;
		}).catch(() => undefined);
		const readAuthFile = async (file: string) => (JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, { key?: unknown } | undefined>)['opencode-go']?.key;
		const key = fromDatabase
			?? await readAuthFile(join(openCodeDataDir(), 'auth.json')).catch(() => undefined)
			?? await readAuthFile(join(piAgentDir(), 'auth.json')).catch(() => undefined);
		return typeof key === 'string' && key ? key : undefined;
	}

	// #endregion
}
