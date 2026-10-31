/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk';

/**
 * Whether the SDK's own account report describes a Claude setup that can serve
 * requests on the user's own credentials — the single rule behind both the
 * advertised requirement and the native model catalog. Only the SDK can answer
 * honestly: a `claude login` credential lives in the macOS keychain, invisible
 * to `process.env` and `~/.claude/settings.json` alike.
 *
 * The two branches must NOT be collapsed. `apiProvider` reports `'firstParty'`
 * even for an empty home directory, so it is a presence signal for nobody — it
 * is consulted only to spot a *third-party* backend (Bedrock, Vertex, a
 * gateway), whose credential fields the SDK documents as absent because auth is
 * external. Requiring a credential field there would lock every one of them out.
 *
 * Says *configured*, not *working*: verifying would cost a billable request per
 * check, and the failure being fixed here is genuinely set-up users locked out.
 */
export function isClaudeAccountSetUp(account: AccountInfo | undefined): boolean {
	if (!account) {
		return false;
	}
	if (account.apiProvider !== undefined && account.apiProvider !== 'firstParty') {
		return true;
	}
	// `tokenSource` spells "no credential" as `'none'` rather than absence;
	// `apiKeySource` has only ever been observed absent in that case. A `claude
	// login` subscription reports neither, only its `subscriptionType`.
	return (account.tokenSource !== undefined && account.tokenSource !== 'none')
		|| account.apiKeySource !== undefined
		|| account.subscriptionType !== undefined;
}
