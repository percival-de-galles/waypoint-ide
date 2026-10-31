# Contributing to Waypoint

Waypoint is a fork of Visual Studio Code that runs your own coding agents in the editor. Read [FORK.md](FORK.md) first: it explains what changed from upstream, the rules changes need to follow, and what is still open.

Contributions are welcome. The maintainers decide which commits are accepted and how contributions are attributed. If you have a concern about either, raise an issue or start a discussion.

## Before you start

- A problem in the editor itself, unrelated to agents, probably belongs upstream at [microsoft/vscode](https://github.com/microsoft/vscode).
- A problem in how an agent behaves may belong to that agent's own project.
- Waypoint's rules are in [FORK.md](FORK.md#where-conflicts-will-happen): agents run the user's own CLI, no Copilot token or proxy reaches them, nothing is added to an agent's own configuration, and no GitHub sign-in is required.

## Building and testing

See [Building from source](README.md#building-from-source). Coding guidelines are in [AGENTS.md](AGENTS.md).

For a change to the agent integration, run its unit tests, then try the change in the running app with `./scripts/code.sh`. Put new user-visible text through `localize`, and name the product Waypoint.
