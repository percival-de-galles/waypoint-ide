/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider token for the Claude agent host's model selection. The token is the value stamped onto an {@link IAgentModelInfo}'s
 * `provider` field by the catalog and, crucially, the value the chat
 * model picker buckets a model's group under — so the frontend vendor descriptor
 * it registers for a group MUST use the same token. Keeping it here (a
 * `common` module importable from both the node backend that stamps them and the
 * browser contribution that names them) makes that group ↔ vendor link a single,
 * compile-checked source of truth rather than two literals that can drift apart.
 */

/**
 * Provider token for the user's own Anthropic account (API key or Claude
 * subscription). Models stamped with it group under the
 * `anthropic` picker vendor the Claude agent host registers.
 */
export const CLAUDE_PROVIDER_ANTHROPIC = 'anthropic';
