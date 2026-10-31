# Waypoint fork notes

How Waypoint differs from upstream VS Code, where it branched off, how upstream changes are brought in, and what is still open. Keep this file current as the fork changes.

## Upstream base

| | |
|---|---|
| Upstream | [microsoft/vscode](https://github.com/microsoft/vscode), `main` |
| Commit | `69e9e92f233fa339095aff467676bfa601c22ecd` (29 Oct 2026, "Fix custom agent name collisions in the Copilot agent host (#344955)") |
| Version | 1.145.0 |
| Electron / Node | 43.8.3 / 24.22.1 |

The original git history was removed, so Waypoint starts as a new repository. The commit above is the only link to upstream history; the merge procedure below depends on it.

## Goal

Run any coding agent in the editor, through the agent's own CLI, with no GitHub account and no Copilot. Each agent keeps its own sign-in, settings, skills and MCP servers; Waypoint adds no layer of its own on top of them.

## What changed

### Agents run on the user's own CLIs

- `src/vs/platform/agentHost/node/agentRegistration.ts` (new) registers every agent in one place: Claude, Codex, Cursor and OpenCode (ACP), and Pi. The Copilot agent is no longer registered.
- `src/vs/platform/agentHost/node/agentBinary.ts` (new) finds each CLI from the `chat.agentHost.binaryPaths` setting or `PATH`. Claude runs the user's `claude` through the Claude Agent SDK (`pathToClaudeCodeExecutable`); Codex runs the user's `codex app-server`. The CDN download of bundled copies (`build/agent-sdk`, `product.agentSdks`) is no longer used.
- `src/vs/platform/agentHost/node/acp/` (new) drives any Agent Client Protocol agent over stdio, reusing `base/common/jsonRpcProtocol.ts`. Cursor and OpenCode use it.
- `src/vs/platform/agentHost/node/pi/piAgent.ts` (new) drives `pi --mode rpc`. A Pi extension's `confirm` dialog becomes a Waypoint confirmation.
- `src/vs/platform/agentHost/node/cliAgentBase.ts` (new) holds what the ACP and Pi agents share.

### Pi as a first-class agent

- Pi is not bundled. `agentRegistration.ts` runs the user's `pi`, and the setup banner offers **Install in Terminal**, which runs Pi's official installer (`installCommand` in `agentSdkSetup.ts`). So `pi update`, `pi install` and `~/.pi/agent` work as they do in a terminal, and a Pi release needs no Waypoint release. Waypoint adds no tools to Pi.
- `PiAgent` publishes its setup status, loads models at startup and marks Pi's configured default so the picker selects it, watches Pi's config files, and restarts idle chats when they change, resuming them with `switch_session` (Pi reads keys only at startup). The session file is stored as the chat's provider data, so restored chats resume too.
- `agentHost/node/pi/piCustomizations.ts` feeds the Customizations view from Pi: `get_commands` for skills and prompts, and Pi's `mcp.json`, `settings.json` and `extensions/` for MCP servers, packages and extensions, at user level and in a project's `.pi`.
- `workbench/contrib/chat/browser/agentSessions/agentHost/piAgentConfig.ts` adds two Manage Models vendors (`pi-agent`, `pi-agent-custom`) that write Pi's `auth.json` and `models.json`, and copies user-level MCP servers to its `mcp.json`. It only replaces entries it wrote itself (tracked in application storage), and writes nothing until Pi is installed.

### No Copilot routing or GitHub sign-in

- Claude always uses its native transport (`claudeTransportMode.ts`), and neither Claude nor Codex advertises the Copilot protected resource, so no Copilot token reaches them. Codex no longer replaces the user's `OPENAI_API_KEY` or adds a Copilot model provider (`codexLaunchConfig.ts`).
- `chat.agentHost.allowSignedOutWhenUsable` defaults to `true`, and `product.json` has empty `defaultChatAgent.extensionId` and `chatExtensionId`. Together these turn off Copilot chat setup, the Copilot sign-in title bar entry and the Agents window sign-in wall (`chatEntitlementService.ts`, `sessionsSetUpService.ts`).
- The agent setup banner (`agentHostSdkSetupNotification.ts`) offers **Sign In in Terminal**, which runs the agent's own login command (`loginCommand` in `agentSdkSetup.ts`), and says "not installed" instead of offering an SDK download. It never offers GitHub sign-in.

### Agents everywhere

- Upstream chat counts as enabled only when a default chat participant exists, and only the Copilot extension provides one. `agentHostDefaultChatAgent.ts` registers a small core one, in `chat.shared.contribution.ts` so that both the editor and Agents windows load it. It only answers a chat that reached no agent.
- The first-run overlay (`onboardingVariationA.ts`) lists the agents with an **Install** button for each missing one (`agentInstallCommands` in `agentBinary.ts`) instead of a sign-in step. The Welcome page's GitHub button, the walkthrough's Copilot steps and the model picker's Copilot sign-in are gone, and the Agents window has no Cloud provider without a default chat extension.
- **No model or agent traffic goes to Microsoft, Copilot or GitHub.** Agents talk only to their own providers, through the user's CLIs. `product.json` has no Copilot service URLs and no `voiceWsUrl`, `getAccountUrl` refuses to build one for GitHub Enterprise, the agent host's Copilot and Microsoft telemetry senders exist only in a product with a default chat extension, and cloud automations are off. GitHub still serves what it serves in VS Code: repositories, pull and push, and sign-in. Keep those URLs empty when merging upstream's `product.json`.
- GitHub sign-in is optional. **Sign In with GitHub...** in either window's account menu uses the default account without touching Copilot, and the account button then shows the GitHub avatar unless the user chose a picture. `vscode.github-authentication` is allowed in the Agents window for this.
- The Agents window never asks for sign-in: without a default chat extension its account button is a profile button, and `chat.remoteAgentHostsEnabled` defaults to `false`, which removes GitHub Environments, Dev Tunnels, SSH and Remote Connections from both windows. Set it to `true` to bring them back.
- Profile pictures are local (`workbench/services/accounts/browser/profilePicture.ts`): the image is cropped, scaled to 160×160 and kept in application storage, so both windows share it and no account is involved.
- **Usage** (Agents window, `contrib/usage`) shows daily tokens and plan limits. `AgentUsageCollector` in the agent host answers a root-config request with a transient snapshot. Tokens come from each agent's own logs on this machine: `~/.claude/projects`, `~/.codex/sessions`, `~/.pi/agent/sessions` and OpenCode's `opencode.db`. Limits come from Claude Code's own usage request through the SDK, `ICodexAccountService` for Codex, and `opencode.ai/zen/go/v1/usage` with the user's own OpenCode Go key. Waypoint never reads Claude's credentials or calls Anthropic's private usage endpoint with them. Cursor keeps no local history to read.
- The chat input's bottom-right corner has a limits button (`chatAgentLimitsWidget.ts`) in every agent's chat, in both windows. It shows the current agent's tightest limit, or the tightest of all for an agent with no plan such as Pi, and opens a popup of every agent's limits. Each card there folds down to its tightest limit, and the folded cards are remembered per profile. Claude can report an available plan with no windows; the card then keeps its last reading.
- The Agent picker is hidden when a CLI agent has no custom agents to pick, in both windows (`chatSessionHasNoAgentsToPick` in the editor, `hasNoAgentsToPick` in `agentHostAgentPicker.ts`). It stays visible while a custom agent is selected.
- The editor's chat list shows only sessions run in a folder that window has open (`AgentSessionsFilter.isOutsideWorkspace`); empty windows and the Agents window list everything. Subagent chats appear as branches under their chat alongside forks and side chats. Pi reports token use and context windows, so its chats get the context ring.
- The editor's chat list leaves out sessions nobody used: a placeholder title, a modified time equal to the start time, and nothing running (`isUnusedSession`). `AgentSessionsFilter` hides them; they are not deleted, and a pending new chat stays in the session model.
- Thinking levels in the model picker: Pi's come from each model's `reasoning` and `thinkingLevelMap` and apply with `set_thinking_level`. OpenCode only shows its `thought_level` option once a model is selected, so the startup probe selects each model in a throwaway session to read them.
- New chats in the editor start on Pi when its session type is listed (`getComputedDefaultSessionType`); this does not check that Pi is installed. OpenCode's and Cursor's skills, commands, plugins and MCP servers are read from their own folders and config files (`cliCustomizations.ts`) and shown through the same view as Pi's.
- Usage's **Cost** tab shows what an agent recorded when it has a real figure (Pi, OpenCode), and otherwise an estimate from Anthropic's published rates in `agentUsagePricing.ts`, keeping 5-minute and 1-hour cache writes apart. Update that table when Anthropic's prices change. Models with neither stay unpriced and are named on the page, which is the case for Codex until its rates are added.
- OpenCode, Cursor and Pi use logos from `agentSessions/media/agentIcons.ttf` (`agentIcons.ts`). They need their own font because every build copies `codicon.ttf` over from `@vscode/codicons`; the logos belong to their owners. The Cursor glyph comes from `@lobehub/icons` (MIT), and OpenCode's and Pi's from their own marks.
- The status bar's Copilot entry and Add Models' GitHub Copilot sign-in only appear with a default chat extension, which Waypoint's `product.json` leaves empty.
- `chat.editor.localAgent.enabled` defaults to `false` (`agentHostEnablementService.ts`), so new chats open on an agent rather than the Copilot-based local chat. Session types report `readiness` (not installed, installed, has models), and inline and terminal chat's `auto` picks the readiest (`resolveAgentSessionType` in `chat/common/constants.ts`).
- CLI agents receive only the `<terminal_chat>` and `<editor_inline_chat>` host instructions (`CliAgentBase._withSurfaceInstructions`). The others rely on host tools such as `rename_chat` that they cannot call, and adding them would inject text into every prompt.
- Inline chat and terminal chat use the agent in `chat.inlineChat.agentHost.agent` and `chat.terminal.agentHost.agent` instead of the Copilot agent. Both default to `auto` (see above), and both are on by default (`inlineChatSessionResolver.ts`, `terminalChatSessionResolver.ts`, `agentHostChatContribution.ts`).
- Codex appears in the editor window as well as the Agents window (`shouldSurfaceLocalAgentHostProvider`).

### Waypoint's identity and data

- `product.json` carries Waypoint's names, IDs, URL scheme (`waypoint:`) and data folders. Its Windows app IDs and macOS profile UUIDs are new, and `reportIssueUrl` is gone. `getUserDataPath` uses `waypoint-dev` when running from source (`environment/node/userDataPath.ts`).
- Data lives in `~/.config/Waypoint` (`~/.config/waypoint-dev` from source), `~/.waypoint` (`.waypoint-dev` from source) and `~/.waypoint-shared`, and scratch folders for chats with no project in `~/.waypoint/chats`. Nothing is migrated: data from the earlier `code-oss-dev` folders stays where it is.
- User-visible strings say Waypoint, including agent commit authorship and Agent Merge's PR replies. These stay, on purpose: `VSCODE_*` variables, the `vscode` extension API, a project's `.vscode` folder, theme IDs such as `VS Code Dark` (saved settings refer to them), and strings naming the real product, such as the VS Code Speech extension and the VS Code marketplace.
- Upstream's new strings will say VS Code, so check the `localize` calls in each merge's diff.
- The default for `chat.agentSessions.showExternal` is 30 days, the longest the host keeps external sessions.
- `chatViewPane.ts` keeps the sessions header visible when a folder has no chats, and gives the list's space to the welcome.

### Switching agents within a session

- `chat.agentHost.multipleChatProviders.enabled` defaults to `true`, so a session can hold chats on different agents.
- `chatContributions/agentHandoff/agentHandoffContribution.ts` (new) gives the first message of a chat on another agent the session's main conversation (bounded to 20,000 characters, using the side-chat context builder).

## Excluded from upstream

These upstream parts are not used, and are removed or switched off in Waypoint. Changes to them upstream can usually be dropped during a merge.

| Upstream part | Status in Waypoint |
|---|---|
| Copilot agent harness (`agentHost/node/copilot/`) | Deleted |
| Copilot proxies for Claude and Codex, Copilot API client (`claudeProxyService.ts`, `codexProxyService.ts`, `shared/copilotApiService.ts`) | Deleted |
| `copilot_shim/` launcher and `build/lib/copilot.ts` | Still in the tree; deletion pending |
| CDN-downloaded agent SDKs (`build/agent-sdk`, `product.agentSdks`) | Not used; the Claude SDK's JS ships from the app's own `node_modules` |
| Copilot chat setup, entitlement and quota UI | Off (empty default chat extension id) |
| Copilot Chat extension (`extensions/copilot`) | Never loaded (skipped in `extensionsScannerService.ts`); still in the tree and built, so removing the folder and its build entries is pending |
| Mission Control, Copilot cloud agent, cloud sandboxes | Still in the tree, off by default; depend on GitHub services |

Still undecided: the BYOK model bridge and local-model (llama.cpp) services that the Copilot agent used. Pi does not use them; its Manage Models vendors are Waypoint's own (`piAgentConfig.ts`).

## Merging upstream updates

Because history was reset, git does not know that Waypoint descends from the upstream commit. A local *graft* tells it, so that ordinary merges work.

One-time setup, in each clone that will merge upstream:

```bash
git remote add upstream https://github.com/microsoft/vscode.git
git fetch upstream 69e9e92f233fa339095aff467676bfa601c22ecd
git replace --graft "$(git rev-list --max-parents=0 HEAD)" 69e9e92f233fa339095aff467676bfa601c22ecd
```

This makes Waypoint's first commit a child of the upstream base. It works only if that first commit contains Waypoint's changes on top of the upstream tree, which is how the new repository is created from this working folder.

For each update:

```bash
git fetch upstream main            # or a release branch, such as release/1.146
git checkout -b merge-upstream
git merge upstream/main
# resolve conflicts, run the checks below, then merge the branch into main
```

After the first merge, the merge commit has a real upstream parent, so later merges no longer need the graft. Merging brings upstream history into the repository. To keep the repository small instead, apply upstream changes as a patch and record the new base commit here:

```bash
git diff 69e9e92f233fa339095aff467676bfa601c22ecd <new upstream commit> > upstream.patch
git apply --3way upstream.patch
```

### Where conflicts will happen

Upstream changes the agent host almost daily. Expect conflicts in:

- `src/vs/platform/agentHost/node/agentHostMain.ts`, `agentHostServerMain.ts` (registration was moved to `agentRegistration.ts`; keep that)
- `src/vs/platform/agentHost/node/claude/claudeAgent.ts`, `claudeAgentSdkService.ts`, `claudeSdkOptions.ts`, `claudeTransportMode.ts`
- `src/vs/platform/agentHost/node/codex/codexAgent.ts`, `codexLaunchConfig.ts`, `codexSavedChatReader.ts`
- `src/vs/platform/agentHost/common/agentService.ts`, `agentHostStarter.config.contribution.ts`, `agentSdkSetup.ts`
- `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostSdkSetupNotification.ts`, `agentHostChatContribution.ts`
- `src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts`, `chat/common/constants.ts`
- `product.json`, `package.json`, `build/gulpfile.vscode.ts`, `build/gulpfile.reh.ts`
- Tests under `src/vs/platform/agentHost/test/node/codex/` and `claudeAgent.test.ts`

When resolving: keep upstream's behaviour changes, but keep Waypoint's rules. Agents run the user's CLI; no Copilot token, proxy or model reaches them; nothing is added to an agent's own configuration; and there is no GitHub sign-in requirement. New upstream features that need Copilot or GitHub stay off.

### Checks after a merge

```bash
npm install
npm run typecheck-client
npm run build-fast -- --client-only
node test/unit/node/index.js --timeout 30000 --runGlob "vs/platform/agentHost/test/{node,common}/**/*.test.js"
```

Then launch with `./scripts/code.sh`, and check that each agent starts, streams a reply, asks for permission and shows the sign-in banner when signed out.

## Progress

| Area | State |
|---|---|
| Claude and Codex on the user's CLIs, no Copilot | Done, tested |
| Cursor and OpenCode (ACP), Pi (RPC) | Done, tested against fake agents that speak the real protocols |
| No GitHub sign-in, terminal sign-in banner | Done; the banner test needs the browser test runner and was only type-checked |
| Inline and terminal chat with any agent | Done, tested |
| Agent handoff within a session | Done, tested |
| Claude SDK JS shipped in packaged builds | Done; a full packaged build has not been run yet |
| Deleting the dead Copilot code | Partly done: the agent harness and proxies are gone; `copilot_shim/`, `build/lib/copilot.ts` and `extensions/copilot` remain |
| Product rename to Waypoint | Done for names, IDs, data folders and user-visible strings; icons not started |
| Usage page, cost tab and limits popup | Done, tried in the app with real Claude and OpenCode Go data. Codex limits are untested |
| Thinking levels for Pi and OpenCode | Done; the picker was checked in the app, and applying a level is tested against fake agents only |
| Browser pages and attachments for Pi, OpenCode and Cursor | Done; tried in the app with a stand-in Pi |
| OpenCode's Customizations | Done, checked in the app. Cursor uses the same code but is untested, because its CLI wasn't available |
| Pi: install banner, Manage Models providers, MCP servers, Customizations view, live reload, session resume | Done; tested with unit tests and by running `PiAgent` against real Pi 1.4.0 in a scratch folder. The installer itself has not been run |
| Tried in the running app | Done with a throwaway profile against a fake model: banners, Manage Models, Customizations, chat, inline chat, Agents window. Terminal chat, Pi's installer and a packaged build were not run |

At the last full run, all 26,118 Node unit tests passed. The Electron run of the chat, sessions, onboarding, actions and agent-host suites has 67 failures, nearly all timeouts in tests that wait on animation frames or layout. They also fail under a virtual display, their cause is unproven, and with no git history there is no upstream baseline to compare against. A failed cleanup hook can also make mocha skip the rest of `ChatListRenderer`, so the pass count moves between runs.

### Known gaps

Marked in the code with `shortcut:` comments:

- ACP chats restored after a restart show only what Waypoint stored, and start a new native session on the next message. Pi chats resume on the next message, but the earlier turns aren't shown again.
- Pi and the ACP agents get attachments as text in the message, using Claude's resolver. Images are not sent. They have no browser tools, so a page shared with them arrives as its accessibility text at send time (`_withBrowserPageText`); they can read a page but not click in it. A message queued behind a running turn keeps only the page's title.
- A signed-out ACP agent keeps its "Default" model, so its sign-in error appears in the chat rather than the banner.
- On Windows, npm-installed CLIs resolve to `.cmd` launchers that some SDKs can't start; set `chat.agentHost.binaryPaths` to the real executable.
- Inline and terminal chat use a configured agent or the readiest one, not the last one you used.
- The editor's Pi default does not check that Pi is installed, so someone with only Claude starts on Pi and sees its setup banner.
- The Agents window still defaults to Claude, and hiding unused sessions and the folder filter apply to the editor's chat list only.
- OpenCode's Customizations do not refresh while the app is running; reopen the chat after adding a skill. Its agents aren't listed, and its build and plan modes aren't wired, because picking an agent does nothing on ACP yet.
- Pi, OpenCode and Cursor have no agents to pick, so the Agent picker is hidden for them.
- OpenCode and Cursor don't report token use, so their chats have no context ring.
- The Customizations view still says "Copilot" in places, and doc links go to `code.visualstudio.com`.
- `package.json` still names Microsoft as author and the upstream repository.
- `chat.agentSessions.showExternal` can't go past 30 days, so older Claude Code sessions don't appear.
- Customizations shows a Plugins list under a "Session" heading, and its "Loaded" badge means Pi's config lists the entry, not that it loaded.
- Waypoint has no ghost-text autocomplete. It came from the Copilot extension, and agents are too slow for it; it needs a small provider that calls a fast model directly.
- Manage Models assumes Pi's default folder; a `PI_CODING_AGENT_DIR` set for Pi is not followed there. The agent host does follow it.
- Pi's plugins appear under the view's "Plugins" heading.
- Adding a project-level MCP server still means `pi mcp add -l`, and Pi loads project config only after you trust the project.
