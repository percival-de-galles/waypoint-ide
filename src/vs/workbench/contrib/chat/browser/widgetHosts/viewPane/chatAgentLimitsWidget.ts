/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatAgentLimitsWidget.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../../base/browser/keyboardEvent.js';
import { HoverPosition } from '../../../../../../base/browser/ui/hover/hoverWidget.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../../base/common/date.js';
import { KeyCode } from '../../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun, IObservable } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import type { AgentUsageWindowId, IAgentUsageLimits } from '../../../../../../platform/agentHost/common/agentUsage.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { IAgentUsageLimitsService } from '../../../../../services/agentHost/browser/agentUsageLimitsService.js';
import { isAgentHostTarget } from '../../../common/chatSessionsService.js';
import { cliAgents } from '../../../common/constants.js';
import { getChatSessionType } from '../../../common/model/chatUri.js';
import { getAgentSessionProviderIcon } from '../../agentSessions/agentSessions.js';

const COLLAPSED_AGENTS_KEY = 'chat.agentLimits.collapsedAgents';

function windowLabel(id: AgentUsageWindowId): string {
	switch (id) {
		case 'session': return localize('agentLimits.window.session', "Session");
		case 'weekly': return localize('agentLimits.window.weekly', "Weekly");
		case 'weeklyOpus': return localize('agentLimits.window.weeklyOpus', "Weekly (Opus)");
		case 'weeklySonnet': return localize('agentLimits.window.weeklySonnet', "Weekly (Sonnet)");
		case 'monthly': return localize('agentLimits.window.monthly', "Monthly");
	}
}

function percentLeft(usedPercent: number): number {
	return Math.max(0, Math.round(100 - usedPercent));
}

/** Which cards are collapsed, for a host that lets people fold them. */
export interface IAgentLimitsCollapseState {
	has(agent: string): boolean;
	toggle(agent: string): void;
}

/**
 * One card per agent, showing how much of each plan limit is left and when it resets.
 * With `collapseState` each header folds its card down to the tightest limit.
 */
export function renderAgentLimits(parent: HTMLElement, limits: readonly IAgentUsageLimits[], collapseState?: IAgentLimitsCollapseState, disposables?: DisposableStore): void {
	for (const { agent, plan, windows } of limits) {
		const card = append(parent, $(`.usage-limit-card.usage-agent-${agent}`));
		const header = append(card, collapseState ? $('button.usage-limit-header.collapsible', { type: 'button' }) : $('.usage-limit-header'));
		header.appendChild(renderIcon(getAgentSessionProviderIcon(`agent-host-${agent}`)));
		append(header, $('span.usage-limit-name')).textContent = cliAgents.find(candidate => candidate.id === agent)?.name ?? agent;
		if (plan) {
			append(header, $('span.usage-limit-plan')).textContent = plan;
		}
		if (collapseState) {
			const left = Math.min(...windows.map(window => percentLeft(window.usedPercent)));
			append(header, $('span.usage-limit-summary')).textContent = localize('agentLimits.percentLeft', "{0}% left", left);
			header.appendChild(renderIcon(Codicon.chevronDown));
			const update = () => {
				card.classList.toggle('collapsed', collapseState.has(agent));
				header.setAttribute('aria-expanded', String(!collapseState.has(agent)));
			};
			update();
			disposables?.add(addDisposableListener(header, EventType.CLICK, () => {
				collapseState.toggle(agent);
				update();
			}));
		}
		for (const { id, usedPercent, resetsAt } of windows) {
			const row = append(card, $('.usage-limit-window'));
			const left = percentLeft(usedPercent);
			const label = append(row, $('.usage-limit-label'));
			append(label, $('span')).textContent = windowLabel(id);
			append(label, $('span.usage-limit-left')).textContent = localize('agentLimits.percentLeft', "{0}% left", left);
			const bar = append(row, $('.usage-limit-bar', { role: 'img', 'aria-label': localize('agentLimits.barAria', "{0}: {1}% left", windowLabel(id), left) }));
			append(bar, $('.usage-limit-fill')).style.width = `${left}%`;
			if (resetsAt) {
				append(row, $('.usage-limit-reset')).textContent = localize('agentLimits.resets', "Resets {0}", fromNow(resetsAt, true, true));
			}
		}
	}
}

/**
 * Sits beside the context usage ring in every agent's chat and shows how much plan is left, by
 * the tightest limit of the chat's agent when it has one. Clicking it opens every agent's limits,
 * and the cards people fold there stay folded.
 */
export class ChatAgentLimitsWidget extends Disposable {

	readonly domNode = $('.chat-agent-limits-widget', { role: 'button', tabindex: '0' });

	private readonly _label = $('span');
	private readonly _popup = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		private readonly _sessionResource: IObservable<URI | undefined>,
		@IAgentUsageLimitsService private readonly _limitsService: IAgentUsageLimitsService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this.domNode.appendChild(renderIcon(Codicon.dashboard));
		this.domNode.appendChild(this._label);
		this._register(this._hoverService.setupDelayedHover(this.domNode, { content: localize('agentLimits.tooltip', "Plan Usage Limits") }));
		this._register(addDisposableListener(this.domNode, EventType.CLICK, e => {
			e.stopPropagation();
			this._showPopup();
		}));
		this._register(addDisposableListener(this.domNode, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Space) || event.equals(KeyCode.Enter)) {
				e.preventDefault();
				this._showPopup();
			}
		}));
		this._limitsService.refresh();
		this._register(autorun(reader => {
			const agent = this._agentOf(this._sessionResource.read(reader));
			const limits = this._limitsService.limits.read(reader);
			if (!limits.length) {
				this._label.textContent = '';
				this.domNode.setAttribute('aria-label', localize('agentLimits.tooltip', "Plan Usage Limits"));
			} else {
				// An agent with no plan of its own, such as Pi, shows the tightest limit of the others.
				const shown = limits.filter(limit => limit.agent === agent);
				const left = Math.min(...(shown.length ? shown : limits).flatMap(limit => limit.windows).map(window => percentLeft(window.usedPercent)));
				this._label.textContent = `${left}%`;
				this.domNode.setAttribute('aria-label', localize('agentLimits.aria', "Plan usage limits, {0}% left", left));
			}
		}));
	}

	/** Picks up what the last request used. */
	refresh(): void {
		this._limitsService.refresh();
	}

	/** The agent id of a chat run by one of the local agents. */
	private _agentOf(resource: URI | undefined): string | undefined {
		const sessionType = resource && getChatSessionType(resource);
		return sessionType && isAgentHostTarget(sessionType) ? sessionType.replace(/^agent-host-/, '') : undefined;
	}

	private _showPopup(): void {
		const store = new DisposableStore();
		this._popup.value = store;
		const content = $('.chat-agent-limits-popup');
		this._limitsService.refresh(true);
		const collapsed = new Set(this._storageService.getObject<string[]>(COLLAPSED_AGENTS_KEY, StorageScope.PROFILE, []));
		const collapseState: IAgentLimitsCollapseState = {
			has: agent => collapsed.has(agent),
			toggle: agent => {
				if (!collapsed.delete(agent)) {
					collapsed.add(agent);
				}
				this._storageService.store(COLLAPSED_AGENTS_KEY, [...collapsed], StorageScope.PROFILE, StorageTarget.USER);
			},
		};
		const cards = store.add(new MutableDisposable<DisposableStore>());
		store.add(autorun(reader => {
			const current = this._agentOf(this._sessionResource.read(reader));
			const limits = [...this._limitsService.limits.read(reader)].sort((a, b) => Number(b.agent === current) - Number(a.agent === current));
			clearNode(content);
			append(content, $('.chat-agent-limits-popup-title')).textContent = localize('agentLimits.title', "Usage Limits");
			if (limits.length) {
				renderAgentLimits(content, limits, collapseState, cards.value = new DisposableStore());
			} else {
				append(content, $('.chat-agent-limits-popup-empty')).textContent = localize('agentLimits.none', "No plan limits to show. Claude, Codex and OpenCode Go report theirs here once you are signed in.");
			}
		}));
		const hover = this._hoverService.showInstantHover({
			content,
			target: this.domNode,
			position: { hoverPosition: HoverPosition.ABOVE },
			persistence: { hideOnHover: false, sticky: true },
			appearance: { showPointer: true, compact: true, skipFadeInAnimation: true },
			trapFocus: true,
		}, true);
		if (hover) {
			store.add(hover);
		}
	}
}
