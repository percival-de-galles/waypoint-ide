/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { OPEN_USAGE_COMMAND_ID, USAGE_CUSTOM_VIEW_ID } from '../../../common/sessionCommands.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { UsageCustomView } from './usageView.js';

class UsageContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.usage';

	constructor(@ICustomViewService customViewService: ICustomViewService) {
		super();
		this._register(customViewService.registerCustomView({ id: USAGE_CUSTOM_VIEW_ID, ctor: new SyncDescriptor(UsageCustomView) }));
	}
}

registerWorkbenchContribution2(UsageContribution.ID, UsageContribution, WorkbenchPhase.BlockRestore);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_USAGE_COMMAND_ID,
			title: localize2('openUsage', "Show Agent Usage"),
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(ICustomViewService).showCustomView(USAGE_CUSTOM_VIEW_ID);
	}
});
