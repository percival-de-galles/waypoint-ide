/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { parse } from '../../../base/common/jsonc.js';
import { join } from '../../../base/common/path.js';
import type { Customization } from '../common/state/sessionState.js';
import { toPiCustomizations, type IPiCommand } from './pi/piCustomizations.js';

/** Where a CLI agent keeps what it can use, in the order it prefers them. */
export interface ICliCustomizationSources {
	readonly skillDirs: readonly string[];
	readonly commandDirs: readonly string[];
	readonly pluginDirs: readonly string[];
	/** Config files listing MCP servers, each under its own key. */
	readonly mcpFiles: readonly { readonly file: string; readonly key: string }[];
}

function readEntries(dir: string): Promise<string[]> {
	return fs.readdir(dir).catch(() => []);
}

/** The `description` of a skill's or command's frontmatter. */
function readDescription(content: string): string | undefined {
	const frontmatter = /^---\r?\n(?<body>[\s\S]*?)\r?\n---/.exec(content)?.groups?.body;
	return frontmatter && /^description:\s*(?<value>.+)$/m.exec(frontmatter)?.groups?.value.trim().replace(/^(?<quote>['"])(?<text>.*)\k<quote>$/, '$<text>');
}

async function readMcpServers(file: string, key: string): Promise<string[]> {
	try {
		const servers = parse<Record<string, unknown>>(await fs.readFile(file, 'utf8'))?.[key];
		return servers && typeof servers === 'object' ? Object.keys(servers) : [];
	} catch {
		return [];
	}
}

/**
 * Reads a CLI agent's skills, commands, plugins and MCP servers from where it keeps them.
 * Earlier folders win when two define the same skill or command.
 */
export async function readCliCustomizations(sources: ICliCustomizationSources): Promise<Customization[]> {
	const commands = new Map<string, IPiCommand>();
	for (const dir of sources.skillDirs) {
		for (const name of await readEntries(dir)) {
			const path = join(dir, name, 'SKILL.md');
			const content = commands.has(`skill:${name}`) ? undefined : await fs.readFile(path, 'utf8').catch(() => undefined);
			if (content !== undefined) {
				commands.set(`skill:${name}`, { name: `skill:${name}`, description: readDescription(content), source: 'skill', sourceInfo: { path } });
			}
		}
	}
	for (const dir of sources.commandDirs) {
		for (const file of await readEntries(dir)) {
			const name = file.replace(/\.md$/, '');
			const path = join(dir, file);
			const content = name === file || commands.has(name) ? undefined : await fs.readFile(path, 'utf8').catch(() => undefined);
			if (content !== undefined) {
				commands.set(name, { name, description: readDescription(content), source: 'prompt', sourceInfo: { path } });
			}
		}
	}
	const plugins = await Promise.all(sources.pluginDirs.map(async dir => (await readEntries(dir)).filter(name => !name.startsWith('.')).map(name => join(dir, name))));
	return toPiCustomizations({
		commands: [...commands.values()],
		mcpFiles: await Promise.all(sources.mcpFiles.map(async ({ file, key }) => ({ file, servers: await readMcpServers(file, key) }))),
		packages: [],
		extensions: plugins.flat(),
	});
}

/** OpenCode's folders: its own, then the Claude and agents folders it also reads, the project's first. */
export function openCodeCustomizationSources(folder: string | undefined): ICliCustomizationSources {
	const home = homedir();
	const config = join(process.env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'opencode');
	const project = folder ? join(folder, '.opencode') : undefined;
	const roots = project ? [project, config] : [config];
	const inProject = (...names: string[]) => folder ? names.map(name => join(folder, name, 'skills')) : [];
	return {
		skillDirs: [...roots.map(root => join(root, 'skills')), ...inProject('.claude', '.agents'), join(home, '.claude', 'skills'), join(home, '.agents', 'skills')],
		commandDirs: roots.map(root => join(root, 'commands')),
		pluginDirs: roots.map(root => join(root, 'plugins')),
		mcpFiles: [...(folder ? [folder] : []), ...roots].flatMap(root => ['opencode.json', 'opencode.jsonc'].map(name => ({ file: join(root, name), key: 'mcp' }))),
	};
}

/** The Cursor CLI's folders, the project's first. */
export function cursorCustomizationSources(folder: string | undefined): ICliCustomizationSources {
	const roots = [...(folder ? [join(folder, '.cursor')] : []), join(homedir(), '.cursor')];
	return {
		skillDirs: roots.map(root => join(root, 'skills')),
		commandDirs: roots.map(root => join(root, 'commands')),
		pluginDirs: [],
		mcpFiles: roots.map(root => ({ file: join(root, 'mcp.json'), key: 'mcpServers' })),
	};
}
