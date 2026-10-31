/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { AgentHostBinaryPathsEnvVar } from '../../common/agentService.js';
import { IAgentSdkDownloader } from '../../node/agentSdkDownloader.js';
import { CodexSdkPackage } from '../../node/codex/codexSdk.js';

/**
 * Makes the Claude and Codex CLIs resolve for the enclosing suite, so its tests do not
 * depend on what is installed on the machine. Tests that need a missing CLI override the
 * agent's own availability check.
 */
export function useInstalledAgentClis(): void {
	let previous: string | undefined;
	suiteSetup(() => {
		previous = process.env[AgentHostBinaryPathsEnvVar];
		process.env[AgentHostBinaryPathsEnvVar] = JSON.stringify({ claude: process.execPath, codex: process.execPath });
	});
	suiteTeardown(() => {
		if (previous === undefined) {
			delete process.env[AgentHostBinaryPathsEnvVar];
		} else {
			process.env[AgentHostBinaryPathsEnvVar] = previous;
		}
	});
}

/**
 * Lets a test's fake SDK downloader decide whether Codex is installed, as it did before
 * Codex ran from the user's PATH, so unit tests never launch a real process.
 */
export function bridgeCodexAvailability<T extends object>(agent: T, instantiationService: IInstantiationService): T {
	const downloader = instantiationService.invokeFunction(accessor => accessor.get(IAgentSdkDownloader));
	const target = agent as unknown as { _isSdkResolvableWithoutDownload(): Promise<boolean>; _resolveCodexBinary(): Promise<string> };
	target._isSdkResolvableWithoutDownload = () => downloader.isSdkResolvableWithoutDownload(CodexSdkPackage);
	target._resolveCodexBinary = async () => {
		await downloader.loadSdkRoot(CodexSdkPackage, CancellationToken.None);
		throw new Error('Codex is not launched in unit tests');
	};
	return agent;
}
