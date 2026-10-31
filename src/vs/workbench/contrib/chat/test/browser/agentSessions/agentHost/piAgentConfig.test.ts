/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { McpServerType } from '../../../../../../../platform/mcp/common/mcpPlatformTypes.js';
import { parsePiEnv, replaceOwned, toPiMcpServer } from '../../../../browser/agentSessions/agentHost/piAgentConfig.js';

suite('PiAgentConfig', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('replaces what Waypoint wrote and keeps entries others added', () => {
		const auth = { anthropic: { type: 'oauth' }, groq: { type: 'api_key', key: 'old' }, mistral: { type: 'api_key', key: 'gone' } };
		const next = replaceOwned(auth, ['groq', 'mistral'], new Map([['groq', { type: 'api_key', key: 'new' }]]));
		assert.deepStrictEqual(next, { anthropic: { type: 'oauth' }, groq: { type: 'api_key', key: 'new' } });
	});

	test('translates MCP servers to Pi and skips what only the editor can run', () => {
		const stdio = toPiMcpServer({ type: McpServerType.LOCAL, command: 'npx', args: ['-y', 'srv', '${userHome}/data'], env: { TOKEN: '${env:MY_TOKEN}', N: 3, DROP: null } }, '/home/u');
		const http = toPiMcpServer({ type: McpServerType.REMOTE, url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } }, '/home/u');
		const sse = toPiMcpServer({ type: McpServerType.REMOTE, transport: 'sse', url: 'https://example.com/sse' }, '/home/u');
		const input = toPiMcpServer({ type: McpServerType.LOCAL, command: 'srv', env: { KEY: '${input:key}' } }, '/home/u');
		assert.deepStrictEqual({ stdio, http, sse, input }, {
			stdio: { command: 'npx', args: ['-y', 'srv', '/home/u/data'], env: { TOKEN: '${MY_TOKEN}', N: '3' } },
			http: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
			sse: undefined,
			input: undefined,
		});
	});

	test('parses provider settings for a Pi credential', () => {
		assert.deepStrictEqual(
			[parsePiEnv('CLOUDFLARE_ACCOUNT_ID=abc, CLOUDFLARE_GATEWAY_ID = gw'), parsePiEnv('not a pair, 1BAD=x'), parsePiEnv(undefined)],
			[{ CLOUDFLARE_ACCOUNT_ID: 'abc', CLOUDFLARE_GATEWAY_ID: 'gw' }, undefined, undefined],
		);
	});
});
