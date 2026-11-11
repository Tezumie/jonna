# What's new

Short notes for each release, newest first. The IDE shows this page after an update (turn it off
with the setting `update.showReleaseNotes`), and Help → Release notes opens it any time.

## 0.1.2

Agents you bring (Claude Code, Codex…) work with the IDE the way its own agent does, and
extensions with their own editors behave better.

- **An agent you brought asks in its chat.** Its questions about IDE commands are cards in the
  chat, under the chat's access mode, not a dialog over the window. One question per action, not
  two.
- **It knows this isn't VS Code.** A guide for agents is among its tools: how to reach the IDE,
  where the documentation is, and how to build an extension in the IDE's own format or as a VS
  Code extension.
- **It can load and install an extension folder for you**, after asking. Installing the same
  folder again updates the installed copy.
- **Extensions with their own editors** (VS Code's custom editors):
  - their buttons show in the tab's toolbar and their keys work;
  - "open as text" opens the text editor;
  - undo and redo work;
  - a file open in one comes back when you reopen the folder;
  - their pages can use the IDE's colors, sizes and corners;
  - their JSON schemas check and complete your files.
- **Resize handles next to an extension's page** show their highlight fully and are easier to
  grab.
- **The Send button's icon is back** in the agent's message box.
- **The language server settings page scrolls.**

## 0.1.1

Small fixes, and the first update delivered through the app itself.

- **The agent's icon is right from the start.** An agent that shows its model's logo could show a
  stand-in character until something else redrew it.
- **The icon beside the agent's name follows the chat's model.** It showed the default model's
  logo even after the chat was switched to another provider.
- **A macOS installer** (Apple silicon and Intel). It isn't signed yet: see Install in the README
  for how to open it.

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
