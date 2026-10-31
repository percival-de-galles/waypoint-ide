/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/usageView.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { constObservable, IObservable, runOnChange } from '../../../../base/common/observable.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AGENT_USAGE_REQUEST_KEY, readAgentUsage, type IAgentUsageSnapshot } from '../../../../platform/agentHost/common/agentUsage.js';
import { IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { ActionType } from '../../../../platform/agentHost/common/state/sessionActions.js';
import { ROOT_STATE_URI } from '../../../../platform/agentHost/common/state/sessionState.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { getAgentSessionProviderIcon } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessions.js';
import { cliAgents } from '../../../../workbench/contrib/chat/common/constants.js';
import { renderAgentLimits } from '../../../../workbench/contrib/chat/browser/widgetHosts/viewPane/chatAgentLimitsWidget.js';
import { IAgentUsageLimitsService } from '../../../../workbench/services/agentHost/browser/agentUsageLimitsService.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { formatCost, formatTokens, summarizeUsage, type IUsageAmount, type IUsageSummary } from '../common/usageSummary.js';

const RANGES = [7, 30, 90] as const;
const MAX_MODELS = 12;

type UsageTab = 'tokens' | 'cost' | 'limits';
type UsageValue = (amount: IUsageAmount) => number;
type UsageFormat = (value: number) => string;

const tokensOf: UsageValue = amount => amount.tokens;
const costOf: UsageValue = amount => amount.cost;

function agentName(agent: string): string {
	return cliAgents.find(candidate => candidate.id === agent)?.name ?? agent;
}

function agentIcon(agent: string) {
	return getAgentSessionProviderIcon(`agent-host-${agent}`);
}

/**
 * Tokens each agent processed and how much of its plan is left, for the agents in use on
 * this machine. The host reads both; see `AgentUsageCollector`.
 */
export class UsageCustomView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('usage.title', "Usage"));
	override readonly description: IObservable<string | undefined> = constObservable(localize('usage.description', "Tokens read from each agent's own logs on this computer, and limits reported by each agent."));

	private readonly _renderStore = this._register(new DisposableStore());
	private _content: HTMLElement | undefined;
	private _tab: UsageTab = 'tokens';
	private _rangeDays: number = 30;
	private _refreshing = false;
	private _snapshot: IAgentUsageSnapshot | undefined;

	constructor(
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IAgentUsageLimitsService private readonly _limitsService: IAgentUsageLimitsService,
		@IHoverService private readonly _hoverService: IHoverService,
	) {
		super();
	}

	render(container: HTMLElement): void {
		this._content = append(container, $('.usage-view'));
		this._snapshot = this._readSnapshot();
		this._register(this._agentHostService.rootState.onDidChange(() => {
			const snapshot = this._readSnapshot();
			if (snapshot?.updatedAt !== this._snapshot?.updatedAt) {
				this._snapshot = snapshot;
				this._refreshing = false;
				this._update();
			}
		}));
		this._register(runOnChange(this._limitsService.limits, () => this._update()));
		this._refresh();
	}

	layout(_width: number, _height: number): void { }

	private _readSnapshot(): IAgentUsageSnapshot | undefined {
		const state = this._agentHostService.rootState.value;
		return state instanceof Error ? undefined : readAgentUsage(state);
	}

	private _refresh(): void {
		this._refreshing = true;
		this._agentHostService.dispatch(ROOT_STATE_URI, { type: ActionType.RootConfigChanged, config: { [AGENT_USAGE_REQUEST_KEY]: generateUuid() } });
		this._limitsService.refresh(true);
		this._update();
	}

	private _update(): void {
		if (!this._content) {
			return;
		}
		this._renderStore.clear();
		clearNode(this._content);
		this._renderToolbar(this._content);
		if (this._tab === 'limits') {
			this._renderLimits(this._content);
		} else if (!this._snapshot) {
			append(this._content, $('.usage-empty')).textContent = localize('usage.reading', "Reading your agents' usage...");
		} else {
			const summary = summarizeUsage(this._snapshot.days, this._rangeDays, new Date());
			if (this._tab === 'tokens') {
				this._renderTokens(this._content, summary);
			} else {
				this._renderCost(this._content, summary);
			}
		}
	}

	// #region Toolbar

	private _renderToolbar(parent: HTMLElement): void {
		const toolbar = append(parent, $('.usage-toolbar'));
		const tabs = append(toolbar, $('.usage-segments', { role: 'tablist' }));
		this._segment(tabs, localize('usage.tokens', "Tokens"), this._tab === 'tokens', () => this._tab = 'tokens', 'tab');
		this._segment(tabs, localize('usage.cost', "Cost"), this._tab === 'cost', () => this._tab = 'cost', 'tab');
		this._segment(tabs, localize('usage.limits', "Limits"), this._tab === 'limits', () => this._tab = 'limits', 'tab');
		if (this._tab !== 'limits') {
			const ranges = append(toolbar, $('.usage-segments', { role: 'group', 'aria-label': localize('usage.range', "Time range") }));
			for (const days of RANGES) {
				this._segment(ranges, localize('usage.days', "{0} Days", days), this._rangeDays === days, () => this._rangeDays = days);
			}
		}
		const refresh = append(toolbar, $<HTMLButtonElement>('button.usage-refresh', { type: 'button', 'aria-label': localize('usage.refresh', "Refresh") }));
		refresh.appendChild(renderIcon(this._refreshing ? { ...Codicon.sync, id: `${Codicon.sync.id}~spin` } : Codicon.refresh));
		refresh.disabled = this._refreshing;
		this._renderStore.add(this._hoverService.setupDelayedHover(refresh, { content: localize('usage.refresh', "Refresh") }));
		this._renderStore.add(addDisposableListener(refresh, EventType.CLICK, () => this._refresh()));
	}

	private _segment(parent: HTMLElement, label: string, selected: boolean, select: () => void, role?: string): void {
		const button = append(parent, $<HTMLButtonElement>('button.usage-segment', { type: 'button' }));
		button.textContent = label;
		button.classList.toggle('selected', selected);
		if (role) {
			button.setAttribute('role', role);
			button.setAttribute('aria-selected', String(selected));
		} else {
			button.setAttribute('aria-pressed', String(selected));
		}
		this._renderStore.add(addDisposableListener(button, EventType.CLICK, () => {
			select();
			this._update();
		}));
	}

	// #endregion

	// #region Tokens and cost

	private _renderTokens(parent: HTMLElement, summary: IUsageSummary): void {
		if (!summary.totals.total) {
			append(parent, $('.usage-empty')).textContent = localize('usage.noTokens', "No agent activity in this time range.");
			return;
		}
		this._renderOverview(parent, summary, tokensOf, formatTokens, localize('usage.processedTokens', "Processed Tokens"), localize('usage.dailyTokens', "Daily Processed Tokens"));
		this._renderTotals(parent, localize('usage.totals', "Totals"), [
			[localize('usage.uncachedInput', "Uncached Input"), formatTokens(summary.totals.input)],
			[localize('usage.cachedInput', "Cached Input"), formatTokens(summary.totals.cacheRead)],
			[localize('usage.cacheWrite', "Cache Write"), formatTokens(summary.totals.cacheWrite)],
			[localize('usage.output', "Output"), formatTokens(summary.totals.output)],
		]);
		this._renderModels(parent, summary, tokensOf, formatTokens);
	}

	private _renderCost(parent: HTMLElement, summary: IUsageSummary): void {
		const { cost } = summary;
		if (!cost.total) {
			append(parent, $('.usage-empty')).textContent = cost.unpricedTokens
				? localize('usage.noKnownCost', "No cost is known for the models used in this time range.")
				: localize('usage.noTokens', "No agent activity in this time range.");
			return;
		}
		this._renderOverview(parent, summary, costOf, formatCost, cost.estimated ? localize('usage.estimatedCost', "Estimated Cost") : localize('usage.reportedCost', "Reported Cost"), localize('usage.dailyCost', "Daily Cost"));
		const note = append(parent, $('p.usage-note'));
		note.textContent = cost.estimated
			? localize('usage.costNote', "What this usage would cost at public API rates. It is not your bill: a subscription charges a flat fee instead.")
			: localize('usage.reportedCostNote', "As recorded by each agent.");
		if (cost.unpricedTokens) {
			append(parent, $('p.usage-note')).textContent = localize('usage.unpriced', "{0} tokens are not included because their models have no known price.", formatTokens(cost.unpricedTokens));
		}
		this._renderTotals(parent, localize('usage.costByType', "Cost by Type"), [
			[localize('usage.uncachedInput', "Uncached Input"), formatCost(cost.input)],
			[localize('usage.cachedInput', "Cached Input"), formatCost(cost.cacheRead)],
			[localize('usage.cacheWrite', "Cache Write"), formatCost(cost.cacheWrite)],
			[localize('usage.output', "Output"), formatCost(cost.output)],
			...cost.reported ? [[localize('usage.reportedByAgents', "Reported by Agents"), formatCost(cost.reported)] as const] : [],
		]);
		this._renderModels(parent, summary, costOf, formatCost);
	}

	private _renderOverview(parent: HTMLElement, summary: IUsageSummary, valueOf: UsageValue, format: UsageFormat, label: string, chartTitle: string): void {
		const total = summary.agents.reduce((sum, agent) => sum + valueOf(agent), 0);
		const overview = append(parent, $('.usage-overview'));
		const hero = append(overview, $('.usage-hero'));
		append(hero, $('.usage-hero-value')).textContent = format(total);
		append(hero, $('.usage-hero-label')).textContent = label;
		const agents = append(hero, $('.usage-agents'));
		for (const entry of [...summary.agents].filter(agent => valueOf(agent) > 0).sort((a, b) => valueOf(b) - valueOf(a))) {
			const row = append(agents, $(`.usage-agent.usage-agent-${entry.agent}`));
			append(row, $('span.usage-agent-dot'));
			row.appendChild(renderIcon(agentIcon(entry.agent)));
			const name = append(row, $('span.usage-agent-name'));
			name.textContent = agentName(entry.agent);
			if (valueOf === costOf) {
				append(name, $('span.usage-agent-source')).textContent = entry.estimatedCost ? localize('usage.estimate', "Estimate") : localize('usage.reported', "Reported");
			}
			append(row, $('span.usage-agent-tokens')).textContent = format(valueOf(entry));
			append(row, $('span.usage-agent-share')).textContent = `${Math.round(valueOf(entry) / total * 100)}%`;
		}
		this._renderChart(append(overview, $('.usage-chart-section')), summary, valueOf, format, chartTitle);
	}

	private _renderTotals(parent: HTMLElement, heading: string, rows: readonly (readonly [label: string, value: string])[]): void {
		append(parent, $('h3.usage-heading')).textContent = heading;
		const totals = append(parent, $('.usage-totals'));
		for (const [label, value] of rows) {
			const total = append(totals, $('.usage-total'));
			append(total, $('.usage-total-label')).textContent = label;
			append(total, $('.usage-total-value')).textContent = value;
		}
	}

	private _renderModels(parent: HTMLElement, summary: IUsageSummary, valueOf: UsageValue, format: UsageFormat): void {
		append(parent, $('h3.usage-heading')).textContent = localize('usage.breakdown', "Breakdown by Model");
		const models = append(parent, $('.usage-models', { role: 'list' }));
		const ranked = summary.models.filter(model => valueOf(model) > 0).sort((a, b) => valueOf(b) - valueOf(a));
		const largest = ranked[0] ? valueOf(ranked[0]) : 1;
		const total = ranked.reduce((sum, model) => sum + valueOf(model), 0);
		for (const entry of ranked.slice(0, MAX_MODELS)) {
			const row = append(models, $(`.usage-model.usage-agent-${entry.agent}`, { role: 'listitem' }));
			row.appendChild(renderIcon(agentIcon(entry.agent)));
			const name = append(row, $('.usage-model-name'));
			append(name, $('span')).textContent = entry.model === 'other' ? localize('usage.otherModel', "Tools and summaries") : entry.model;
			append(name, $('.usage-model-bar')).style.width = `${valueOf(entry) / largest * 100}%`;
			append(row, $('span.usage-model-share')).textContent = `${Math.round(valueOf(entry) / total * 100)}%`;
			append(row, $('span.usage-model-tokens')).textContent = format(valueOf(entry));
		}
	}

	private _renderChart(parent: HTMLElement, summary: IUsageSummary, valueOf: UsageValue, format: UsageFormat, title: string): void {
		append(parent, $('h3.usage-heading')).textContent = title;
		const largest = Math.max(...summary.days.map(valueOf));
		const chart = append(parent, $('.usage-chart', { role: 'img', 'aria-label': localize('usage.chartAria', "{0}. Largest day: {1}.", title, format(largest)) }));
		for (const day of summary.days) {
			const column = append(chart, $('.usage-chart-column'));
			const stack = append(column, $('.usage-chart-stack'));
			stack.style.height = `${largest ? valueOf(day) / largest * 100 : 0}%`;
			for (const { agent } of summary.agents) {
				const amount = day.byAgent.get(agent);
				if (amount && valueOf(amount)) {
					append(stack, $(`.usage-chart-segment.usage-agent-${agent}`)).style.flexGrow = String(valueOf(amount));
				}
			}
			const breakdown = [...day.byAgent].filter(([, amount]) => valueOf(amount)).map(([agent, amount]) => `${agentName(agent)}: ${format(valueOf(amount))}`).join('\n');
			this._renderStore.add(this._hoverService.setupDelayedHover(column, { content: `${day.day}\n${breakdown || localize('usage.noActivity', "No activity")}` }));
		}
		const axis = append(parent, $('.usage-chart-axis'));
		append(axis, $('span')).textContent = summary.days[0]?.day.slice(5) ?? '';
		append(axis, $('span')).textContent = summary.days.at(-1)?.day.slice(5) ?? '';
	}

	// #endregion

	// #region Limits

	private _renderLimits(parent: HTMLElement): void {
		const limits = this._limitsService.limits.get();
		if (limits.length) {
			renderAgentLimits(parent, limits);
		} else {
			append(parent, $('.usage-empty')).textContent = localize('usage.noLimits', "No plan limits to show. Claude, Codex and OpenCode Go report theirs here once you are signed in.");
		}
	}

	// #endregion
}
