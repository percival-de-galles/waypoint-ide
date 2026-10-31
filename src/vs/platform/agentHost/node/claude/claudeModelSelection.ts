/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentModelInfo } from '../../common/agent.js';
import { createAgentModelGroupMeta } from '../../common/agentModelSource.js';
import { CLAUDE_PROVIDER_ANTHROPIC } from '../../common/claudeProviders.js';
import type { ModelSelection } from '../../common/state/protocol/state.js';
import { toSdkModelId } from './claudeModelId.js';

/**
 * Prefix that marks a {@link ModelSelection.id} as carrying an explicit
 * provider. Mirrors Codex's `@provider=` convention so the two harnesses read
 * the same way. Kept module-private: callers encode/decode through the
 * functions below rather than string-matching the id themselves.
 */
const CLAUDE_MODEL_SELECTION_PREFIX = '@provider=';

/**
 * Encodes a provider + model id into a single opaque {@link ModelSelection.id}
 * string of the form `@provider=<provider>:<modelId>`. Both halves are
 * url-encoded so provider/model names containing `:` or `/` round-trip cleanly.
 */
export function toClaudeModelSelectionId(provider: string, modelId: string): string {
	return `${CLAUDE_MODEL_SELECTION_PREFIX}${encodeURIComponent(provider)}:${encodeURIComponent(modelId)}`;
}

/**
 * Splits a {@link ModelSelection} back into its provider and model id. A bare
 * id (no prefix), a prefixed id with no `:` separator, or an id whose halves
 * fail to url-decode all fall back to {@link CLAUDE_PROVIDER_ANTHROPIC} with the
 * original id as the model, so a malformed or legacy value never throws.
 */
export function parseClaudeModelSelection(selection: ModelSelection): { readonly provider: string; readonly modelId: string } {
	const { id } = selection;
	if (!id.startsWith(CLAUDE_MODEL_SELECTION_PREFIX)) {
		return { provider: CLAUDE_PROVIDER_ANTHROPIC, modelId: id };
	}
	const separator = id.indexOf(':', CLAUDE_MODEL_SELECTION_PREFIX.length);
	if (separator < CLAUDE_MODEL_SELECTION_PREFIX.length) {
		// No `:` after the prefix — not a well-formed provider-qualified id.
		return { provider: CLAUDE_PROVIDER_ANTHROPIC, modelId: id };
	}
	try {
		return {
			provider: decodeURIComponent(id.slice(CLAUDE_MODEL_SELECTION_PREFIX.length, separator)),
			modelId: decodeURIComponent(id.slice(separator + 1)),
		};
	} catch {
		return { provider: CLAUDE_PROVIDER_ANTHROPIC, modelId: id };
	}
}

/**
 * Resolves the SDK-canonical model id for a selection, peeling off any provider
 * qualification first. Under the per-session provider feature a selection id is
 * provider-qualified (`@provider=anthropic:claude-sonnet-4-5`); neither the
 * Claude Agent SDK understands that wrapper, so it must be stripped
 * back to the bare model id before {@link toSdkModelId} normalizes the version
 * separators — otherwise the SDK receives `@provider=…` verbatim (it is
 * unparseable, so {@link toSdkModelId} passes it through untouched) and the
 * model 400s. A bare / legacy id has no wrapper and round-trips unchanged. `undefined` passes
 * through so callers can convert an optional selection in one step.
 */
export function toClaudeSdkModelId(model: ModelSelection): string;
export function toClaudeSdkModelId(model: ModelSelection | undefined): string | undefined;
export function toClaudeSdkModelId(model: ModelSelection | undefined): string | undefined {
	if (!model) {
		return undefined;
	}
	return toSdkModelId(parseClaudeModelSelection(model).modelId);
}

/**
 * Qualifies the native catalog for the picker: each model's id is rewritten to a
 * provider-qualified {@link toClaudeModelSelectionId} and its picker-group vendor
 * token ({@link CLAUDE_PROVIDER_ANTHROPIC}) is stamped into `_meta` (via
 * {@link createAgentModelGroupMeta}) so the picker buckets it under that group.
 * Each model's {@link IAgentModelInfo.provider} is left untouched (the `claude`
 * owner): that field doubles as the owning agent provider for session routing.
 */
export function qualifyClaudeModelCatalog(native: readonly IAgentModelInfo[]): IAgentModelInfo[] {
	return withQualifiedProvider(native, CLAUDE_PROVIDER_ANTHROPIC);
}

/**
 * Re-id each model with its provider-qualified selection id and stamp the
 * group vendor token into `_meta`, leaving {@link IAgentModelInfo.provider}
 * (the routing owner) and every other field intact.
 */
function withQualifiedProvider(models: readonly IAgentModelInfo[], provider: string): IAgentModelInfo[] {
	return models.map(model => ({
		...model,
		id: toClaudeModelSelectionId(provider, model.id),
		_meta: { ...model._meta, ...createAgentModelGroupMeta(provider) },
	}));
}
