/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, dirname } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { makeMcpServerCustomization } from '../../../agentPlugins/common/pluginParsers.js';
import { CustomizationLoadStatus, CustomizationType, customizationId, type ChildCustomization, type Customization, type PromptCustomization, type SkillCustomization } from '../../common/state/sessionState.js';

/** One entry of Pi's RPC `get_commands`: a skill, a prompt template or an extension command. */
export interface IPiCommand {
	readonly name: string;
	readonly description?: string;
	readonly source: string;
	readonly sourceInfo?: { readonly path?: string; readonly origin?: string; readonly baseDir?: string };
}

/** What Pi has loaded for one folder, from Pi itself and its own config files. */
export interface IPiCatalog {
	readonly commands: readonly IPiCommand[];
	/** Each `mcp.json` Pi reads, with its servers. */
	readonly mcpFiles: readonly { readonly file: string; readonly servers: readonly string[] }[];
	/** Packages from each `settings.json` Pi reads (`pi install`). */
	readonly packages: readonly { readonly settingsFile: string; readonly source: string }[];
	/** Extensions that are not part of a package: files or folders. */
	readonly extensions: readonly string[];
}

/**
 * Turns Pi's skills, prompt templates, packages, extensions and MCP servers into the
 * host's customizations: skills and prompts grouped by folder, each package and
 * extension as a plugin (Pi calls them extensions) holding its skills and prompts, and
 * each MCP server as its own entry.
 */
export function toPiCustomizations(catalog: IPiCatalog): Customization[] {
	const folders = new Map<string, { contents: CustomizationType.Skill | CustomizationType.Prompt; children: ChildCustomization[] }>();
	const packageChildren: { baseDir: string; child: ChildCustomization }[] = [];
	for (const command of catalog.commands) {
		const path = command.sourceInfo?.path;
		if (!path || (command.source !== 'skill' && command.source !== 'prompt')) {
			continue;
		}
		const uri = URI.file(path).toString();
		const child: SkillCustomization | PromptCustomization = command.source === 'skill'
			? { type: CustomizationType.Skill, id: customizationId(uri), uri, name: command.name.replace(/^skill:/, ''), description: command.description }
			: { type: CustomizationType.Prompt, id: customizationId(uri), uri, name: command.name, description: command.description };
		if (command.sourceInfo?.origin === 'package' && command.sourceInfo.baseDir) {
			packageChildren.push({ baseDir: command.sourceInfo.baseDir, child });
			continue;
		}
		// A skill is `<folder>/<name>/SKILL.md` (or `<folder>/<name>.md`); a prompt is `<folder>/<name>.md`.
		const folder = command.source === 'skill' && basename(path) === 'SKILL.md' ? dirname(dirname(path)) : dirname(path);
		const key = `${command.source}:${folder}`;
		let entry = folders.get(key);
		if (!entry) {
			entry = { contents: command.source === 'skill' ? CustomizationType.Skill : CustomizationType.Prompt, children: [] };
			folders.set(key, entry);
		}
		entry.children.push(child);
	}

	const result: Customization[] = [];
	for (const [key, { contents, children }] of folders) {
		const uri = URI.file(key.slice(key.indexOf(':') + 1)).toString();
		result.push({ type: CustomizationType.Directory, id: customizationId(uri), uri, name: uri.slice(uri.lastIndexOf('/') + 1), enabled: true, contents, writable: true, load: { kind: CustomizationLoadStatus.Loaded }, children });
	}
	for (const { settingsFile, source } of catalog.packages) {
		const identity = packageIdentity(source);
		const uri = URI.file(settingsFile).toString();
		result.push({
			type: CustomizationType.Plugin,
			id: customizationId(`${uri}#${source}`),
			uri,
			name: source,
			load: { kind: CustomizationLoadStatus.Loaded },
			children: packageChildren.filter(({ baseDir }) => baseDir.replace(/\\/g, '/').includes(identity)).map(({ child }) => child),
		});
	}
	for (const extension of catalog.extensions) {
		const uri = URI.file(extension).toString();
		result.push({ type: CustomizationType.Plugin, id: customizationId(uri), uri, name: basename(extension), load: { kind: CustomizationLoadStatus.Loaded }, children: [] });
	}
	for (const { file, servers } of catalog.mcpFiles) {
		for (const name of servers) {
			result.push(makeMcpServerCustomization(URI.file(file), name));
		}
	}
	return result;
}

/** The part of a package source that appears in its install folder: the npm name, or the repository or folder name. */
function packageIdentity(source: string): string {
	if (source.startsWith('npm:')) {
		return source.slice(4).replace(/(.)@[^/]*$/, '$1');
	}
	return basename(source.replace(/\\/g, '/').replace(/@[^/@]*$/, '').replace(/\.git$/, '').replace(/\/+$/, ''));
}
