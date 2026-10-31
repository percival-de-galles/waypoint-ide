/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AGENT_USAGE_LIMITS_KEY, AGENT_USAGE_LIMITS_REQUEST_KEY } from '../../../../../platform/agentHost/common/agentUsage.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import type { RootState } from '../../../../../platform/agentHost/common/state/protocol/state.js';
import { AgentUsageLimitsService } from '../../browser/agentUsageLimitsService.js';
import { ICodexAccountService } from '../../browser/codexAccountService.js';

suite('AgentUsageLimitsService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const claude = { agent: 'claude', windows: [{ id: 'session', usedPercent: 20 }] };

	function create() {
		const requests: unknown[] = [];
		const service = store.add(new AgentUsageLimitsService(
			upcastPartial<IAgentHostService>({
				rootState: upcastPartial<IAgentHostService['rootState']>({ value: upcastPartial<RootState>({ config: { schema: { type: 'object', properties: {} }, values: { [AGENT_USAGE_LIMITS_KEY]: [claude] } } }), onDidChange: Event.None }),
				dispatch: (_resource, action) => { requests.push(action); },
			}),
			upcastPartial<ICodexAccountService>({
				agent: 'codex',
				onDidChangeAccount: Event.None,
				account: { status: 'signedIn', planType: 'plus', rateLimits: [{ usedPercent: 10, windowDurationMins: 300, resetsAt: 2 }] },
			}),
		));
		return { service, requests };
	}

	test('combines the host limits with Codex account limits', () => {
		assert.deepStrictEqual(create().service.limits.get(), [
			claude,
			{ agent: 'codex', plan: 'plus', windows: [{ id: 'session', usedPercent: 10, resetsAt: 2000 }] },
		]);
	});

	test('routine refreshes wait, and a forced one does not', () => {
		const { service, requests } = create();
		service.refresh();
		service.refresh();
		service.refresh(true);
		assert.deepStrictEqual(requests.map(request => Object.keys((request as { config: object }).config)), [[AGENT_USAGE_LIMITS_REQUEST_KEY], [AGENT_USAGE_LIMITS_REQUEST_KEY]]);
	});
});
