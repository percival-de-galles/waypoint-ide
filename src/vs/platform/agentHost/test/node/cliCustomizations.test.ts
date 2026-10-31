/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CustomizationType } from '../../common/state/sessionState.js';
import { readCliCustomizations } from '../../node/cliCustomizations.js';

suite('readCliCustomizations', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'cli-customizations-'));
	});

	teardown(() => fs.rm(root, { recursive: true, force: true }));

	async function write(path: string, content: string): Promise<void> {
		await fs.mkdir(join(root, path, '..'), { recursive: true });
		await fs.writeFile(join(root, path), content);
	}

	test('reads skills, commands, plugins and MCP servers, and earlier folders win', async () => {
		await write('project/skills/review/SKILL.md', '---\ndescription: "Project review"\n---\n');
		await write('user/skills/review/SKILL.md', '---\ndescription: User review\n---\n');
		await write('user/skills/deploy/SKILL.md', '---\ndescription: Deploy it\n---\n');
		await write('user/skills/not-a-skill/notes.txt', '');
		await write('user/commands/fix.md', 'Fix it');
		await write('user/commands/ignored.txt', '');
		await write('user/plugins/status.js', '');
		await write('user/plugins/.hidden', '');
		await write('user/opencode.jsonc', '{\n\t// a comment\n\t"mcp": { "rea": {} },\n}');

		const customizations = await readCliCustomizations({
			skillDirs: [join(root, 'project/skills'), join(root, 'user/skills'), join(root, 'missing')],
			commandDirs: [join(root, 'user/commands')],
			pluginDirs: [join(root, 'user/plugins')],
			mcpFiles: [{ file: join(root, 'user/opencode.jsonc'), key: 'mcp' }, { file: join(root, 'user/opencode.json'), key: 'mcp' }],
		});

		assert.deepStrictEqual(customizations.map(item => ({
			type: item.type,
			name: item.name,
			children: item.type === CustomizationType.Directory ? item.children?.map(child => `${child.name}: ${(child as { description?: string }).description}`).sort() : undefined,
		})), [
			{ type: CustomizationType.Directory, name: 'skills', children: ['review: Project review'] },
			{ type: CustomizationType.Directory, name: 'skills', children: ['deploy: Deploy it'] },
			{ type: CustomizationType.Directory, name: 'commands', children: ['fix: undefined'] },
			{ type: CustomizationType.Plugin, name: 'status.js', children: undefined },
			{ type: CustomizationType.McpServer, name: 'rea', children: undefined },
		]);
	});
});
