/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $ } from '../../../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import type { IAgentUsageLimits } from '../../../../../../../platform/agentHost/common/agentUsage.js';
import { renderAgentLimits } from '../../../../browser/widgetHosts/viewPane/chatAgentLimitsWidget.js';

suite('renderAgentLimits', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const limits: IAgentUsageLimits[] = [
		{ agent: 'claude', windows: [{ id: 'session', usedPercent: 10 }, { id: 'weekly', usedPercent: 40 }] },
		{ agent: 'opencode', windows: [{ id: 'monthly', usedPercent: 5 }] },
	];

	test('headers fold their own card, remember it, and keep showing the tightest limit', () => {
		const disposables = store.add(new DisposableStore());
		const parent = $('div');
		const collapsed = new Set(['opencode']);
		renderAgentLimits(parent, limits, {
			has: agent => collapsed.has(agent),
			toggle: agent => collapsed.delete(agent) || collapsed.add(agent),
		}, disposables);
		const cards = [...parent.querySelectorAll('.usage-limit-card')];
		const snapshot = () => cards.map(card => ({
			collapsed: card.classList.contains('collapsed'),
			expanded: card.querySelector('button')?.getAttribute('aria-expanded'),
			summary: card.querySelector('.usage-limit-summary')?.textContent,
		}));

		const initial = snapshot();
		cards[0].querySelector('button')?.click();
		cards[1].querySelector('button')?.click();

		assert.deepStrictEqual({ initial, toggled: snapshot(), remembered: [...collapsed] }, {
			initial: [
				{ collapsed: false, expanded: 'true', summary: '60% left' },
				{ collapsed: true, expanded: 'false', summary: '95% left' },
			],
			toggled: [
				{ collapsed: true, expanded: 'false', summary: '60% left' },
				{ collapsed: false, expanded: 'true', summary: '95% left' },
			],
			remembered: ['claude'],
		});
	});

	test('the Usage page keeps plain cards', () => {
		const parent = $('div');
		renderAgentLimits(parent, limits);
		assert.deepStrictEqual({ buttons: parent.querySelectorAll('button').length, cards: parent.querySelectorAll('.usage-limit-card').length }, { buttons: 0, cards: 2 });
	});
});
