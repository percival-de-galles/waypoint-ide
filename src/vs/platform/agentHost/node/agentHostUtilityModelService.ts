/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationError } from '../../../base/common/errors.js';
import type { IAgentHostCredentialSource } from '../common/agentHostCredentials.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { getByokLmSelectionModelId, IByokLmChatRequest, IByokLmModelInfo, resolveByokLmEnablement } from '../common/agentHostByokLm.js';
import { AgentHostByokModelsEnabledConfigKey, AgentHostUtilitySmallModelConfigKey, platformRootSchema } from '../common/agentHostSchema.js';
import type { ModelSelection, URI as ProtocolURI } from '../common/state/sessionState.js';
import { IAgentConfigurationService } from './agentConfigurationService.js';
import { IByokLmBridgeRegistry } from './byokLmBridgeRegistry.js';

/** LM API vendor of Copilot models; an override naming it is not a BYOK model. */
const COPILOT_VENDOR = 'copilot';

/** Default `temperature` for utility chat completions. */
export const UTILITY_DEFAULT_TEMPERATURE = 0.1;

/** Default `top_p` for utility chat completions. */
export const UTILITY_DEFAULT_TOP_P = 1;

/** One chat message in a {@link IUtilityChatCompletionRequest}. */
export interface IUtilityChatMessage {
	readonly role: 'system' | 'user' | 'assistant';
	readonly content: string;
}

/**
 * Inputs for {@link IAgentHostUtilityModelService.chatCompletion}. Callers own
 * prompt construction — typically a `'system'` rules message followed by one or
 * more `'user'` messages. `temperature` defaults to {@link UTILITY_DEFAULT_TEMPERATURE}.
 */
export interface IUtilityChatCompletionRequest {
	readonly messages: readonly IUtilityChatMessage[];
	readonly temperature?: number;
	readonly maxTokens?: number;
}

export interface IUtilityChatCompletionOptions {
	readonly signal?: AbortSignal;
}

/** The session, and optionally the chat, a utility request serves. */
export interface IAgentHostUtilityModelContext {
	readonly session: ProtocolURI;
	readonly credentialSource?: IAgentHostCredentialSource;
	/** Defaults to the session's default chat. */
	readonly chat?: ProtocolURI;
	/**
	 * The model selected for the turn being served, when the caller runs before
	 * the provider has applied it (for example, titling a turn at admission).
	 */
	readonly model?: ModelSelection;
}

export const enum AgentHostUtilityModelUnavailableReason {
	/** No BYOK utility model is configured for the request. */
	NotConfigured = 'notConfigured',
	/**
	 * The BYOK utility model override cannot be reached, for example because the renderer that
	 * serves BYOK models is disconnected.
	 */
	ByokModelUnavailable = 'byokModelUnavailable',
}

/** Thrown when no utility model can serve a request; callers map {@link reason} to user-facing text. */
export class AgentHostUtilityModelUnavailableError extends Error {
	constructor(readonly reason: AgentHostUtilityModelUnavailableReason) {
		super(`No utility model is available: ${reason}`);
		this.name = 'AgentHostUtilityModelUnavailableError';
	}
}

export const IAgentHostUtilityModelService = createDecorator<IAgentHostUtilityModelService>('agentHostUtilityModelService');

/**
 * Runs the host's small utility completions (titles, pull request text, commit
 * messages) on the BYOK model named by the `utilitySmallModel` override. Only
 * an agent host with a renderer BYOK bridge (the local utility-process host)
 * serves utility models; elsewhere, and when nothing resolves, requests fail with {@link AgentHostUtilityModelUnavailableReason.NotConfigured}.
 */
export interface IAgentHostUtilityModelService {
	readonly _serviceBrand: undefined;

	/**
	 * Returns the assistant text for `request`.
	 *
	 * @throws {@link AgentHostUtilityModelUnavailableError} when no utility model is available.
	 */
	chatCompletion(context: IAgentHostUtilityModelContext, request: IUtilityChatCompletionRequest, options?: IUtilityChatCompletionOptions): Promise<string>;
}

interface IUtilityModelRoute {
	readonly vendor: string;
	readonly modelId: string;
}

export class AgentHostUtilityModelService implements IAgentHostUtilityModelService {

	declare readonly _serviceBrand: undefined;

	constructor(
		private readonly _byokUtilityModelsSupported: boolean,
		@IAgentConfigurationService private readonly _configurationService: IAgentConfigurationService,
		@IByokLmBridgeRegistry private readonly _byokBridgeRegistry: IByokLmBridgeRegistry,
		@ILogService private readonly _logService: ILogService,
	) { }

	async chatCompletion(_context: IAgentHostUtilityModelContext, request: IUtilityChatCompletionRequest, options?: IUtilityChatCompletionOptions): Promise<string> {
		const route = this._byokUtilityModelsSupported ? this._resolveOverride(this._byokModels(), this._byokBridgeRegistry.getServingConnection() !== undefined) : undefined;
		if (!route) {
			throw new AgentHostUtilityModelUnavailableError(AgentHostUtilityModelUnavailableReason.NotConfigured);
		}
		return this._byokChatCompletion(route.vendor, route.modelId, request, options?.signal);
	}

	/** The renderer's BYOK models, or `undefined` when BYOK is disabled for the agent host. */
	private _byokModels(): readonly IByokLmModelInfo[] | undefined {
		const { enabled } = resolveByokLmEnablement(this._configurationService.getRootValue(platformRootSchema, AgentHostByokModelsEnabledConfigKey));
		return enabled ? this._byokBridgeRegistry.getModels() : undefined;
	}

	/**
	 * Resolves a `${vendor}/${id}` override to exactly one BYOK model. Like the
	 * extension, an override that is unresolvable while the renderer serves BYOK
	 * models, or ambiguous, falls back to the default behavior, as does a Copilot
	 * override. A BYOK override while no renderer serves BYOK models fails closed.
	 */
	private _resolveOverride(byokModels: readonly IByokLmModelInfo[] | undefined, rendererConnected: boolean): IUtilityModelRoute | undefined {
		const raw = this._configurationService.getRootValue(platformRootSchema, AgentHostUtilitySmallModelConfigKey);
		if (!raw) {
			return undefined;
		}
		const slashIndex = raw.indexOf('/');
		if (slashIndex <= 0 || slashIndex >= raw.length - 1) {
			this._logService.warn(`[AgentHostUtilityModelService] Ignoring malformed utility model override '${raw}' (expected '\${vendor}/\${id}').`);
			return undefined;
		}
		const vendor = raw.substring(0, slashIndex);
		const id = raw.substring(slashIndex + 1);
		if (vendor === COPILOT_VENDOR || !byokModels) {
			return undefined;
		}
		if (!rendererConnected) {
			this._logService.trace(`[AgentHostUtilityModelService] Utility model override '${raw}' is a BYOK model but no renderer serves BYOK models.`);
			throw new AgentHostUtilityModelUnavailableError(AgentHostUtilityModelUnavailableReason.ByokModelUnavailable);
		}
		const matches = byokModels.filter(m => m.vendor === vendor && m.id === id);
		if (matches.length !== 1) {
			this._logService.trace(`[AgentHostUtilityModelService] Utility model override '${raw}' matched ${matches.length} BYOK models; using the default behavior.`);
			return undefined;
		}
		return { vendor, modelId: getByokLmSelectionModelId(matches[0]) };
	}

	private async _byokChatCompletion(vendor: string, modelId: string, request: IUtilityChatCompletionRequest, signal: AbortSignal | undefined): Promise<string> {
		const modelOptions: Record<string, unknown> = {
			temperature: request.temperature ?? UTILITY_DEFAULT_TEMPERATURE,
			top_p: UTILITY_DEFAULT_TOP_P,
			...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
		};
		const connection = this._byokBridgeRegistry.getServingConnection();
		if (!connection) {
			throw new AgentHostUtilityModelUnavailableError(AgentHostUtilityModelUnavailableReason.ByokModelUnavailable);
		}
		const bridgeRequest: IByokLmChatRequest = {
			vendor,
			modelId,
			input: request.messages.map(message => ({
				type: 'message',
				role: message.role,
				content: [{ type: 'text', text: message.content }],
			})),
			modelOptions,
		};
		this._logService.debug(`[AgentHostUtilityModelService] BYOK utility request: ${vendor}/${modelId}`);
		const result = await raceAbort(connection.chat(bridgeRequest), signal);
		if (result.error) {
			throw new Error(`BYOK utility request failed for ${vendor}/${modelId}: ${result.error}`);
		}
		const text = result.output.flatMap(item => item.type === 'message' ? item.content.map(part => part.text) : []).join('');
		if (!text) {
			throw new Error(`BYOK utility request for ${vendor}/${modelId} returned no text content`);
		}
		return text;
	}
}

/** The bridge has no cancellation channel, so stop waiting when `signal` aborts. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) {
		return promise;
	}
	if (signal.aborted) {
		return Promise.reject(new CancellationError());
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new CancellationError());
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
	});
}
