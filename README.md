# Waypoint

Waypoint is a code editor built for working with coding agents. It runs the agents you already use (Claude Code, Codex, OpenCode, Pi and Cursor) inside the editor, through their own command-line tools, with their own sign-in, settings, skills and MCP servers. The first-run screen lists each agent with an **Install** button for any you don't have yet. No GitHub account or Copilot subscription is needed.

Waypoint is a fork of [Visual Studio Code](https://github.com/microsoft/vscode) ("Code - OSS"), and keeps everything VS Code does as an editor. See [FORK.md](FORK.md) for what was changed, which upstream version it is based on, and how upstream updates are merged.

> **Status:** early. The agent integration works and is covered by tests, but Waypoint has not been released or widely used yet, and no packaged build has been made. The app icons are still the upstream ones.

## Agents

| Agent | Runs | Sign in with |
|---|---|---|
| Claude Code | your `claude` CLI, through Anthropic's Claude Agent SDK | `claude auth login`, an API key, Amazon Bedrock, Google Vertex AI or Microsoft Foundry |
| Codex | your `codex` CLI (`codex app-server`) | `codex login` (ChatGPT) or an OpenAI API key |
| OpenCode | your `opencode` CLI (`opencode acp`) | `opencode auth login`, or any provider in your `opencode.json` |
| Pi | your `pi` CLI (`pi --mode rpc`) | `/login` in Pi, or an API key in **Chat: Manage Language Models** |
| Cursor | your Cursor CLI (`cursor-agent acp`) | `cursor-agent login` |

Every agent works in the chat sidebar, the Agents window, inline chat in the editor, and terminal chat. In the Agents window, a session can hold chats on different agents: a chat started on another agent receives the conversation so far, so you can hand work from one agent to another.

Waypoint has no login screens of its own. If an agent isn't signed in, the chat shows a **Sign In in Terminal** button that runs that agent's own login command; if it isn't installed, the chat says so and links to its install instructions. For Pi it also offers **Install in Terminal**, which runs Pi's official installer.

Each agent loads its own configuration from its usual place (`~/.claude`, `~/.codex`, `opencode.json` and so on). Waypoint does not add its own MCP servers, tools or plugins to them. The Customizations view shows what the selected agent has: Claude's and Codex's own lists, Pi's skills, prompts and extensions, and the skills, commands, plugins and MCP servers OpenCode and Cursor keep in their config folders.

New chats in the editor start on Pi, and you can switch agents from the chat input.

### In a chat

- **Models and thinking:** the model picker lists each agent's own models. Where a model supports it, the picker also sets its thinking level, using the levels that agent offers for that model.
- **Chat list:** the sidebar lists the chats run in the folders this window has open, with forks, side chats and subagent chats as branches under their main chat. Chats that never received a message stay out of the list. The Agents window lists every folder.
- **Attachments:** files, selections and shared browser pages reach every agent. Claude and Codex read a shared page with browser tools and can act on it. Pi, OpenCode and Cursor get its text in the message, so they can read it but not click in it. Images are not sent to those three yet.

### Pi

Waypoint doesn't ship a copy of Pi. Pi is installed the normal way, into `~/.pi/agent`, so it updates itself with `pi update`, and packages from `pi install` work the same in the terminal and in Waypoint. You don't need to update Waypoint when Pi updates, and Waypoint adds no tools to Pi.

Pi's chats show a context ring like Claude's, and Pi's models use the thinking levels Pi reports. You can also configure Pi from Waypoint. Everything is stored in Pi's own files, and anything you set up with Pi itself is left alone:

- **Models:** in **Chat: Manage Language Models**, add **Pi** (pick one of Pi's API-key providers and paste a key) or **Pi (Custom Endpoint)** (a base URL, API type and comma-separated model IDs, for Ollama, LM Studio, vLLM or any compatible server; the group name becomes the provider id). Azure, Vertex AI and Cloudflare take their extra settings in the optional **Provider Settings** field. Keys go to `auth.json` and endpoints to `models.json`. Open chats pick up the change on their next message.
- **MCP servers:** the user-level servers you add with **MCP: Add Server** or the MCP Servers view are copied to Pi's `mcp.json`. Servers that need `${input:…}` prompts or workspace variables, and SSE servers, are skipped.
- **Customizations:** the Customizations view shows what Pi has loaded: its skills, prompt templates, packages and extensions (under Plugins), and its MCP servers, including those in a project's `.pi` folder.

### Settings

| Setting | What it does |
|---|---|
| `chat.agentHost.binaryPaths` | Where each agent's CLI is, for example `{ "claude": "/opt/homebrew/bin/claude" }`. Agents without an entry are found on your `PATH`. |
| `chat.inlineChat.agentHost.agent` | The agent inline chat uses. The default, `auto`, uses the first of Claude, Codex, OpenCode, Cursor and Pi that is ready: installed with models if any is, otherwise just installed. |
| `chat.terminal.agentHost.agent` | The agent terminal chat uses, also `auto` by default. |
| `chat.agentHost.claudeAgent.enabled`, `chat.agentHost.codexAgent.enabled` | Turn Claude or Codex off. |
| `chat.agentSessions.showExternal` | Which chats started outside Waypoint appear in the list, such as Claude Code sessions from a terminal. The default shows those from the last 30 days. |

> Anthropic does not allow third-party products to offer claude.ai login unless approved. Waypoint never offers it: you sign in to Claude Code yourself, in a terminal. If you distribute Waypoint, check Anthropic's current terms, or document API keys and cloud providers as the supported route.

## Usage

The Agents window has a **Usage** page with your daily processed tokens by agent and model, what that usage costs, and plan limits for Claude, Codex and OpenCode Go. Token counts come from each agent's own logs on your computer and stay there. Limits come from each agent's own reporting.

Costs are the figures an agent recorded where it has them, and otherwise estimates at public API rates, labelled as such. If you are on a subscription, an estimate is not what you pay.

The button in the chat input's bottom-right corner shows how much plan is left, in every agent's chat. It shows that agent's tightest limit, or the tightest across all agents for one with no plan, such as Pi. Clicking it opens every agent's limits, and you can fold the ones you don't need.

## Where Waypoint keeps its data

Waypoint stores everything apart from VS Code, so the two can be installed side by side without sharing settings, extensions or chats.

| | Packaged build (Linux) | Running from source |
|---|---|---|
| Settings and chat data | `~/.config/Waypoint` | `~/.config/waypoint-dev` |
| Extensions | `~/.waypoint/extensions` | `~/.waypoint-dev/extensions` |
| Shared data | `~/.waypoint-shared` | `~/.waypoint-shared` |
| Chats with no project folder | `~/.waypoint/chats` | `~/.waypoint/chats` |

A project's `.vscode` folder still works, because it belongs to the project rather than the editor. Waypoint does not import anything from an existing VS Code install.

## Building from source

Waypoint builds the same way as VS Code. You need Node.js (the version in [.nvmrc](.nvmrc)), Python and a C/C++ toolchain; see VS Code's [How to Contribute](https://github.com/microsoft/vscode/wiki/How-to-Contribute) for platform details.

```bash
npm install
npm run compile
./scripts/code.sh
```

On Windows, use `scripts\code.bat`. During development, `npm run watch` rebuilds as you edit. If you built this checkout before the rename to Waypoint, run `npm run electron` once so the app binary gets its new name.

Unit tests for the agent integration:

```bash
npm run build-fast -- --client-only
node test/unit/node/index.js --runGlob "vs/platform/agentHost/test/{node,common}/**/*.test.js"
```

## License

Waypoint is released under the [MIT license](LICENSE.txt), the same license as the VS Code source it is based on. Third-party notices are in [ThirdPartyNotices.txt](ThirdPartyNotices.txt).

Waypoint is not affiliated with or endorsed by Microsoft. "Visual Studio Code" and "VS Code" are trademarks of Microsoft Corporation; the agent CLIs named above belong to their respective owners.
