# What's new

Short notes for each release, newest first. The IDE shows this page after an update (turn it off
with the setting `update.showReleaseNotes`), and Help → Release notes opens it any time.

## 0.1.0 — The first public alpha

Welcome. This is the first build anyone can download, so there is nothing to compare it with yet.
What's in it:

- **A complete editor:** Monaco with VS Code's grammars and themes, language servers, multi-cursor
  and Vim mode; VS Code's keybindings, `settings.json`, themes and `tasks.json` work as they are.
- **An agent harness:** a built-in agent with file, search, terminal, browser and IDE tools, on
  local models or hosted ones with your own key. Claude Code, Codex and other CLI agents run
  inside it over ACP, or drive it from outside over MCP.
- **Review before anything changes:** the agent's edits are a changeset you accept or reject per
  file or per hunk, with a checkpoint for every turn.
- **Git, a debugger, tests, terminals and a browser preview**, all of them reachable by the agent.
- **Extensions:** VS Code extensions from Open VSX, and small sandboxed ones the agent can write
  for you.
- **No telemetry**, and no account needed. Signing in is optional.

It's an alpha: expect rough edges, and tell us what breaks with Help → Report a problem.
