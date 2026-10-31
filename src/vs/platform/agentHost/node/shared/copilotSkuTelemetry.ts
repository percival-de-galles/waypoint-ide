/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentTelemetryContext } from '../../common/agent.js';

/** Maps account context to telemetry property names only at emission time. */
export function toCopilotTelemetryData(context: IAgentTelemetryContext | undefined): { copilotSku: string | undefined; 'common.copilotTrackingId'?: string } | undefined {
	if (!context) {
		return undefined;
	}
	const { copilotSku, copilotTrackingId } = context;
	// __GDPR__COMMON__ "common.copilotTrackingId" : { "endPoint": "GoogleAnalyticsID", "classification": "EndUserPseudonymizedInformation", "purpose": "BusinessInsight", "comment": "The anonymized Copilot analytics tracking ID from the operation's account discovery response." }
	return { copilotSku, ...(copilotTrackingId ? { 'common.copilotTrackingId': copilotTrackingId } : {}) };
}
