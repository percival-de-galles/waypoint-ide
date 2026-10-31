/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $ } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IAgentSdkSetupInfo } from '../../../../../platform/agentHost/common/agentSdkSetup.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IExtensionGalleryService, IExtensionManagementService } from '../../../../../platform/extensionManagement/common/extensionManagement.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IAgentSdkSetupService } from '../../../../services/agentHost/browser/agentSdkSetupService.js';
import { ColorThemeData } from '../../../../services/themes/common/colorThemeData.js';
import { IWorkbenchThemeService } from '../../../../services/themes/common/workbenchThemeService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IChatSessionsService, type ResolvedChatSessionsExtensionPoint } from '../../../chat/common/chatSessionsService.js';
import { ILanguageModelsService } from '../../../chat/common/languageModels.js';
import { OnboardingVariationA } from '../../browser/onboardingVariationA.js';

suite('OnboardingVariationA', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const install = ['sh', '-c', 'install'];

	function createOnboarding(setups: readonly IAgentSdkSetupInfo[], readiness: Record<string, number>, run: (id: string, agent: unknown) => Promise<void> = async () => { }) {
		const container = mainWindow.document.body.appendChild($('div'));
		store.add(toDisposable(() => container.remove()));
		const onDidChangeSetups = store.add(new Emitter<readonly IAgentSdkSetupInfo[]>());
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(ILayoutService, { activeContainer: container });
		instantiationService.stub(IWorkbenchThemeService, { getColorTheme: () => ColorThemeData.createLoadedEmptyTheme('test', '') });
		instantiationService.stub(IExtensionGalleryService, {});
		instantiationService.stub(IExtensionManagementService, {});
		instantiationService.stub(IAgentSdkSetupService, { setups, onDidChangeSetups: onDidChangeSetups.event });
		instantiationService.stub(IChatSessionsService, {
			onDidChangeAvailability: Event.None,
			getChatSessionContribution: (type: string) => upcastPartial<ResolvedChatSessionsExtensionPoint>({ readiness: () => readiness[type.replace('agent-host-', '')] ?? 0 }),
		});
		instantiationService.stub(ILanguageModelsService, { onDidChangeLanguageModels: Event.None });
		instantiationService.stub(ICommandService, {
			executeCommand: async (id: string, ...args: unknown[]) => {
				await run(id, args[0]);
				return undefined;
			},
		});
		const onboarding = store.add(instantiationService.createInstance(OnboardingVariationA));
		onboarding.show();
		return container;
	}

	function rows(container: HTMLElement) {
		return [...container.querySelectorAll<HTMLElement>('.onboarding-a-agent')].map(row => {
			const button = row.querySelector<HTMLButtonElement>('button');
			return {
				name: row.querySelector('.onboarding-a-agent-name')?.textContent,
				status: row.querySelector('.onboarding-a-agent-status')?.textContent,
				install: button?.style.display === 'none' ? 'hidden' : button?.disabled ? 'disabled' : 'shown',
			};
		});
	}

	test('offers each agent without asking to sign in, and installs only what is missing', () => {
		const container = createOnboarding([
			{ agent: 'claude', download: 'ready', installCommand: install },
			{ agent: 'opencode', download: 'ready', installCommand: install },
			{ agent: 'cursor', download: 'notDownloaded', installCommand: install },
			{ agent: 'pi', download: 'notDownloaded' },
		], { claude: 2, opencode: 1 });

		assert.deepStrictEqual(rows(container), [
			{ name: 'Claude Code', status: 'Ready to use', install: 'hidden' },
			{ name: 'Codex', status: 'Checking...', install: 'hidden' },
			{ name: 'OpenCode', status: 'Installed. Sign in when you first use it.', install: 'hidden' },
			{ name: 'Cursor', status: 'Not installed', install: 'shown' },
			{ name: 'Pi', status: 'Not installed', install: 'hidden' },
		]);
	});

	test('installs an agent in a terminal and shows that until the terminal closes', async () => {
		const installed = new DeferredPromise<void>();
		const commands: unknown[] = [];
		const container = createOnboarding([{ agent: 'cursor', download: 'notDownloaded', installCommand: install }], {}, (id, agent) => {
			commands.push([id, agent]);
			return installed.p;
		});
		const cursor = () => rows(container)[3];

		container.querySelector<HTMLElement>('[aria-label="Install Cursor"]')?.click();
		const running = cursor();
		await installed.complete();
		await timeout(0);

		assert.deepStrictEqual({ commands, running, finished: cursor() }, {
			commands: [['workbench.action.chat.agentHost.installAgentInTerminal', 'cursor']],
			running: { name: 'Cursor', status: 'Installing in the terminal...', install: 'disabled' },
			finished: { name: 'Cursor', status: 'Not installed', install: 'shown' },
		});
	});
});
