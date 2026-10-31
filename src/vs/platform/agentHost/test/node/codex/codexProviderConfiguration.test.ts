/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { resolve } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createCodexProviderConfiguration } from '../../../node/codex/codexProviderConfiguration.js';

suite('CodexProviderConfiguration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('opens the default user configuration without CODEX_HOME', () => {
		const registration = createCodexProviderConfiguration(URI.file('/users/test'));
		assert.strictEqual(registration.configurationFile?.resource, URI.file('/users/test/.codex/config.toml').toString());
	});

	test('opens the effective CODEX_HOME configuration', () => {
		const codexHome = URI.file(isWindows ? 'C:\\custom codex' : '/custom codex');
		const registration = createCodexProviderConfiguration(URI.file('/users/test'), codexHome.fsPath);
		assert.strictEqual(registration.configurationFile?.resource, URI.joinPath(codexHome, 'config.toml').toString());
	});

	test('resolves a relative CODEX_HOME against the host working directory', () => {
		const registration = createCodexProviderConfiguration(URI.file('/users/test'), 'custom-codex');
		assert.strictEqual(registration.configurationFile?.resource, URI.file(resolve(process.cwd(), 'custom-codex/config.toml')).toString());
	});

	test('treats an empty CODEX_HOME as the default', () => {
		const registration = createCodexProviderConfiguration(URI.file('/users/test'), '');
		assert.strictEqual(registration.configurationFile?.resource, URI.file('/users/test/.codex/config.toml').toString());
	});
});
