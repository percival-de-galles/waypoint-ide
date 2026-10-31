/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The tokens of one model response, read from an agent's own session logs. */
export interface IAgentUsageRecord {
	readonly timestamp: number;
	readonly model: string;
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
	/** The part of {@link cacheWrite} kept for an hour, which costs more than five minutes. */
	readonly longCacheWrite?: number;
	/** The response's cost in dollars, when the agent recorded a real one. */
	readonly reportedCost?: number;
	readonly fast?: boolean;
	/** Set when the same response can appear on several lines or in several files. */
	readonly dedupeKey?: string;
}

interface IRecordLike { readonly [key: string]: unknown }

function asRecord(value: unknown): IRecordLike | undefined {
	return typeof value === 'object' && value !== null ? value as IRecordLike : undefined;
}

function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function reportedCost(value: unknown): { reportedCost?: number } {
	// Agents write zero for "unknown", including on paid subscriptions.
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? { reportedCost: value } : {};
}

function parseJson(line: string): IRecordLike | undefined {
	try {
		return asRecord(JSON.parse(line));
	} catch {
		return undefined; // A session still being written can end in a partial line.
	}
}

function hasTokens(record: IAgentUsageRecord): boolean {
	return record.input + record.cacheRead + record.cacheWrite + record.output > 0;
}

/**
 * One line of `~/.claude/projects/<project>/<session>.jsonl`. Claude Code writes a line per
 * content block, each repeating its message's whole `usage`, so callers keep the first of
 * each {@link IAgentUsageRecord.dedupeKey}.
 */
export function parseClaudeUsageLine(line: string): IAgentUsageRecord | undefined {
	const entry = parseJson(line);
	const message = asRecord(entry?.message);
	const usage = asRecord(message?.usage);
	const timestamp = typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
	const model = message?.model;
	// `<synthetic>` marks local placeholders that never reached the API.
	if (entry?.type !== 'assistant' || !usage || Number.isNaN(timestamp) || typeof model !== 'string' || !model || model === '<synthetic>') {
		return undefined;
	}
	const record = {
		timestamp,
		model,
		input: count(usage.input_tokens),
		cacheRead: count(usage.cache_read_input_tokens),
		cacheWrite: count(usage.cache_creation_input_tokens),
		output: count(usage.output_tokens),
		longCacheWrite: count(asRecord(usage.cache_creation)?.ephemeral_1h_input_tokens),
		...reportedCost(entry.costUSD),
		...(usage.speed === 'fast' ? { fast: true } : {}),
		dedupeKey: typeof message?.id === 'string' || typeof entry.requestId === 'string' ? `${message?.id}:${entry.requestId}` : undefined,
	};
	return hasTokens(record) ? record : undefined;
}

/** One line of `~/.pi/agent/sessions/**.jsonl`. Forks copy entries, so ids alone do not identify one. */
export function parsePiUsageLine(line: string): IAgentUsageRecord | undefined {
	const entry = parseJson(line);
	if (typeof entry?.type !== 'string' || !['message', 'usage', 'compaction', 'branch_summary'].includes(entry.type)) {
		return undefined;
	}
	const source = entry.type === 'message' ? asRecord(entry.message) : entry;
	const usage = asRecord(source?.usage);
	const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
	if (!usage || Number.isNaN(timestamp)) {
		return undefined;
	}
	const modelName = source?.responseModel ?? source?.model;
	const model = typeof source?.provider === 'string' && typeof modelName === 'string' ? `${source.provider}/${modelName}` : 'other';
	const record = {
		timestamp,
		model,
		input: count(usage.input),
		cacheRead: count(usage.cacheRead),
		cacheWrite: count(usage.cacheWrite),
		output: count(usage.output),
		...reportedCost(asRecord(usage.cost)?.total),
		dedupeKey: `${String(entry.id)}:${entry.timestamp}:${model}`,
	};
	return hasTokens(record) ? record : undefined;
}

/**
 * Reads one `~/.codex/sessions/**.jsonl` file. Token events carry no model, so the parser
 * keeps the last `turn_context`'s, and Codex repeats an event when only its rate limits
 * changed, so the parser skips events whose running total did not move.
 *
 * shortcut: a forked session counts the parent history it copied; compare `forked_from_id` if that skews totals.
 */
export function createCodexUsageParser(): (line: string) => IAgentUsageRecord | undefined {
	let model = 'unknown';
	let lastTotal = -1;
	return line => {
		const entry = parseJson(line);
		const payload = asRecord(entry?.payload);
		if (entry?.type === 'turn_context' && typeof payload?.model === 'string') {
			model = payload.model;
			return undefined;
		}
		const info = asRecord(payload?.info);
		const last = asRecord(info?.last_token_usage);
		const timestamp = typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
		if (entry?.type !== 'event_msg' || payload?.type !== 'token_count' || !last || Number.isNaN(timestamp)) {
			return undefined;
		}
		const total = count(asRecord(info?.total_token_usage)?.total_tokens);
		if (total === lastTotal) {
			return undefined;
		}
		lastTotal = total;
		const cached = count(last.cached_input_tokens);
		const record = {
			timestamp,
			model,
			// Codex counts cached tokens as part of its input.
			input: Math.max(0, count(last.input_tokens) - cached),
			cacheRead: cached,
			cacheWrite: count(last.cache_write_input_tokens),
			output: count(last.output_tokens),
		};
		return hasTokens(record) ? record : undefined;
	};
}

/** The `data` of one row of OpenCode's `session_message` (or older `message`) table. */
export function parseOpenCodeUsageRow(data: string, createdAt: number): IAgentUsageRecord | undefined {
	const message = parseJson(data);
	if (message?.role !== undefined && message.role !== 'assistant') {
		return undefined;
	}
	const tokens = asRecord(message?.tokens);
	const cache = asRecord(tokens?.cache);
	const modelReference = asRecord(message?.model);
	const modelId = modelReference?.id ?? modelReference?.modelID ?? message?.modelID;
	const providerId = modelReference?.providerID ?? message?.providerID;
	if (!tokens || typeof modelId !== 'string') {
		return undefined;
	}
	const record = {
		timestamp: createdAt,
		model: typeof providerId === 'string' ? `${providerId}/${modelId}` : modelId,
		input: count(tokens.input),
		cacheRead: count(cache?.read),
		cacheWrite: count(cache?.write),
		output: count(tokens.output) + count(tokens.reasoning),
		...reportedCost(message?.cost),
	};
	return hasTokens(record) ? record : undefined;
}
