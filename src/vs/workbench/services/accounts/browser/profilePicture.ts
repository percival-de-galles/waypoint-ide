/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getErrorMessage } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, IObservable, observableFromEvent } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IDefaultAccountService } from '../../../../platform/defaultAccount/common/defaultAccount.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

const STORAGE_KEY = 'accounts.profilePicture';
const PICTURE_SIZE = 160;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

export const SET_PROFILE_PICTURE_COMMAND_ID = 'workbench.action.setProfilePicture';
export const REMOVE_PROFILE_PICTURE_COMMAND_ID = 'workbench.action.removeProfilePicture';
export const SIGN_IN_WITH_GITHUB_COMMAND_ID = 'workbench.action.signInWithGitHub';
export const HasProfilePictureContext = new RawContextKey<boolean>('hasProfilePicture', false);

export const IProfilePictureService = createDecorator<IProfilePictureService>('profilePictureService');

/**
 * The picture the user chose for themselves, shown on the account button of the editor
 * and Agents windows. It belongs to this installation, not to any account.
 */
export interface IProfilePictureService {
	readonly _serviceBrand: undefined;

	/** The picture as a `data:` URL. */
	readonly picture: IObservable<string | undefined>;

	/** Asks for an image file and makes it the picture. */
	choose(): Promise<void>;

	remove(): void;
}

class ProfilePictureService extends Disposable implements IProfilePictureService {

	declare readonly _serviceBrand: undefined;

	readonly picture: IObservable<string | undefined>;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@IFileService private readonly _fileService: IFileService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		// Application scope: the other window sees a change through this same event.
		this.picture = observableFromEvent(this, _storageService.onDidChangeValue(StorageScope.APPLICATION, STORAGE_KEY, this._store), () => _storageService.get(STORAGE_KEY, StorageScope.APPLICATION));
		const hasPicture = HasProfilePictureContext.bindTo(contextKeyService);
		this._register(autorun(reader => hasPicture.set(!!this.picture.read(reader))));
	}

	async choose(): Promise<void> {
		const [file] = await this._fileDialogService.showOpenDialog({
			title: localize('profilePicture.choose', "Choose a Profile Picture"),
			openLabel: localize('profilePicture.use', "Use Picture"),
			canSelectFiles: true,
			canSelectMany: false,
			filters: [{ name: localize('profilePicture.images', "Images"), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
		}) ?? [];
		if (!file) {
			return;
		}
		try {
			const content = await this._fileService.readFile(file, { limits: { size: MAX_FILE_SIZE } });
			const picture = await squareThumbnail(new Blob([Uint8Array.from(content.value.buffer)]));
			this._storageService.store(STORAGE_KEY, picture, StorageScope.APPLICATION, StorageTarget.MACHINE);
		} catch (error) {
			this._notificationService.error(localize('profilePicture.failed', "Could not use that picture: {0}", getErrorMessage(error)));
		}
	}

	remove(): void {
		this._storageService.remove(STORAGE_KEY, StorageScope.APPLICATION);
	}
}

/** The image cropped to its centre square and scaled down, so storage holds a small PNG. */
async function squareThumbnail(image: Blob): Promise<string> {
	const bitmap = await createImageBitmap(image);
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = PICTURE_SIZE;
	const side = Math.min(bitmap.width, bitmap.height);
	canvas.getContext('2d')?.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, PICTURE_SIZE, PICTURE_SIZE);
	bitmap.close();
	return canvas.toDataURL('image/png');
}

registerSingleton(IProfilePictureService, ProfilePictureService, InstantiationType.Delayed);

// Optional: the account button then shows the GitHub avatar, unless a picture was chosen here.
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SIGN_IN_WITH_GITHUB_COMMAND_ID,
			title: localize2('signInWithGitHub', "Sign In with GitHub..."),
			f1: true,
			menu: { id: MenuId.AccountsContext, group: '0_profile', order: 0, when: ContextKeyExpr.notEquals('defaultAccountStatus', 'available') },
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IDefaultAccountService).signIn();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SET_PROFILE_PICTURE_COMMAND_ID,
			title: localize2('setProfilePicture', "Set Profile Picture..."),
			f1: true,
			menu: { id: MenuId.AccountsContext, group: '0_profile', order: 1 },
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IProfilePictureService).choose();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: REMOVE_PROFILE_PICTURE_COMMAND_ID,
			title: localize2('removeProfilePicture', "Remove Profile Picture"),
			f1: true,
			precondition: HasProfilePictureContext,
			menu: { id: MenuId.AccountsContext, group: '0_profile', order: 2, when: ContextKeyExpr.has(HasProfilePictureContext.key) },
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(IProfilePictureService).remove();
	}
});
