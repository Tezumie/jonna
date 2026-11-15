// The built-in extensions a brain with no window activates: the agent, and what its tools and
// its context rely on. The rest of the built-ins (extensions/builtins.ts) exist for a person at
// a screen and are left out; `bootHeadless` takes any list, so an entry may choose another.
//
// Activated, in the window's order:
// - workbench (its screenless form): the workspace's and the layout model's commands and state,
//   trust, notifications: what every other extension's commands assume is there.
// - explorer: the file commands (create, rename, delete, copy) the agent calls as IDE commands.
// - editor: reading a document through the IDE (`editor.getText`) and the `ide://editors` state
//   the agent's context reads (empty with no window; the agent reads files from disk).
// - tasks, terminal: running the project's tasks and long-running commands (`tasks.run`,
//   `terminal.start`), beside run_command, which needs neither.
// - settings: `settings.set` / `settings.get`, which the agent's own commands call.
// - search: `search.find`, which the agent's search tool uses when it is there.
// - mcp: the IDE's own MCP server. It stays off unless asked for (`mcp.enabled` is held false
//   for the run), and still starts when an external agent of a chat borrows the IDE's tools.
// - git: the git commands and `ide://git/status` (the agent's context, commits, worktrees).
// - accounts: the signed-in accounts git and pull requests use.
// - the agent's setup, without its views (extensions/agent/core.ts).
//
// Left out, and why:
// - palette, quickOpen, keybindings, bookmarks, viewers, help, history: views and pickers only
//   (the agent's find_files asks the file index itself when `quickOpen.search` isn't there).
// - browser, debug, testing: they drive panes of the window (the browser pane, the debugger's
//   views, the test tree). Tests and builds run through run_command.
// - windows: the registry of the app's windows, which the windowless host doesn't have.
// - remote: connects a window to another machine.
// - extensions: third-party extensions run in web workers of the page.
// - languageServers, lsp: diagnostics come from the editor's documents, which only a window
//   has; started here they would run language servers nobody reads.
import type { BuiltinExtension } from "../core/extensions/index";
import { accountsExtension } from "../extensions/accounts/index";
import { agentCoreExtension } from "../extensions/agent/core";
import { editorExtension } from "../extensions/editor/index";
import { explorerExtension } from "../extensions/explorer/index";
import { gitExtension } from "../extensions/git/index";
import { mcpExtension } from "../extensions/mcp/index";
import { searchExtension } from "../extensions/search/index";
import { settingsExtension } from "../extensions/settings/index";
import { tasksExtension } from "../extensions/tasks/index";
import { terminalExtension } from "../extensions/terminal/index";
import { createWorkbenchExtension } from "../extensions/workbench/index";
import type { WorkbenchServices } from "../workbench/services";

/** The extensions of a brain with no window, in activation order (the window's order). */
export function headlessExtensions(): BuiltinExtension<WorkbenchServices>[] {
  return [
    createWorkbenchExtension(null),
    explorerExtension,
    editorExtension,
    tasksExtension,
    terminalExtension,
    settingsExtension,
    searchExtension,
    mcpExtension,
    gitExtension,
    accountsExtension,
    agentCoreExtension,
  ];
}
