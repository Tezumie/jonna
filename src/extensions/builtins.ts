// The built-in extensions, in activation order. One list for every entry: the window's (main.ts)
// and a screenless one (headless/boot.ts is handed it, so it doesn't import the views behind it).
import type { BuiltinExtension } from "../core/extensions/index";
import { hasSync, hasTeams } from "../core/ownServices";
import type { WorkbenchServices } from "../workbench/services";
import { accountsExtension } from "./accounts/index";
import { agentExtension } from "./agent/index";
import { bookmarksExtension } from "./bookmarks/index";
import { browserExtension } from "./browser/index";
import { debugExtension } from "./debug/index";
import { editorExtension } from "./editor/index";
import { explorerExtension } from "./explorer/index";
import { extensionsExtension } from "./extensions/index";
import { gitExtension } from "./git/index";
import { helpExtension } from "./help/index";
import { historyExtension } from "./history/index";
import { keybindingsExtension } from "./keybindings/index";
import { languageServersExtension } from "./languageServers/index";
import { lspExtension } from "./lsp/index";
import { mcpExtension } from "./mcp/index";
import { paletteExtension } from "./palette/index";
import { quickOpenExtension } from "./quickOpen/index";
import { remoteExtension } from "./remote/index";
import { searchExtension } from "./search/index";
import { settingsExtension } from "./settings/index";
import { syncExtension } from "./sync/index";
import { tasksExtension } from "./tasks/index";
import { teamExtension } from "./team/index";
import { terminalExtension } from "./terminal/index";
import { testingExtension } from "./testing/index";
import { viewersExtension } from "./viewers/index";
import { windowsExtension } from "./windows/index";

/** The agent extension's id: a screenless entry leaves it out until its setup is split from its views. */
export const AGENT_EXTENSION_ID = agentExtension.manifest.id;

/**
 * Every built-in, the workbench extension first. That one is made by the entry: the window's
 * drives its workbench, a screenless one has none (`createWorkbenchExtension(null)`).
 */
export function builtinExtensions(
  workbenchExtension: BuiltinExtension<WorkbenchServices>,
): BuiltinExtension<WorkbenchServices>[] {
  return [
    workbenchExtension,
    paletteExtension,
    explorerExtension,
    editorExtension,
    viewersExtension,
    historyExtension,
    helpExtension,
    browserExtension,
    tasksExtension,
    terminalExtension,
    settingsExtension,
    quickOpenExtension,
    searchExtension,
    keybindingsExtension,
    mcpExtension,
    gitExtension,
    debugExtension,
    bookmarksExtension,
    windowsExtension,
    remoteExtension,
    testingExtension,
    accountsExtension,
    // Sync only in a build that has it (product.json, docs/own-services.md): without it, no
    // tab, command, setting, status bar item or ide://sync is registered.
    ...(hasSync() ? [syncExtension] : []),
    // The team's library only in a build whose service has teams (and Sync): without it, no
    // team.* command or setting, no ide://team, and nothing of a team is read or applied.
    ...(hasTeams() ? [teamExtension] : []),
    extensionsExtension,
    languageServersExtension,
    lspExtension,
    agentExtension,
  ];
}
