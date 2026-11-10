// Moving from VS Code in one step (D193): its keybindings (command ids and `when` contexts named
// the IDE's way), its installed extensions (installed from Open VSX, or what the IDE has built in
// instead), and its MCP servers. Settings use vscode.ts. DOM-free, tested.

export interface ImportedRule {
  key: string;
  command: string;
  when?: string;
  args?: unknown;
  mac?: string;
}

/**
 * VS Code command → the IDE's command (and its input), where both exist. Also what an
 * extension's keybindings and `executeCommand` of VS Code's own ids map to
 * (core/extensions/vscode/builtinCommands.ts).
 */
export const VSCODE_COMMANDS: Readonly<Record<string, { command: string; args?: unknown }>> = {
  "workbench.action.showCommands": { command: "palette.show" },
  "workbench.action.quickOpen": { command: "quickOpen.show" },
  "workbench.action.gotoSymbol": { command: "quickOpen.goToSymbol" },
  "workbench.action.showAllSymbols": { command: "quickOpen.goToWorkspaceSymbol" },
  "workbench.action.gotoLine": { command: "editor.gotoLine" },
  "workbench.action.files.save": { command: "editor.save" },
  "workbench.action.files.saveAs": { command: "editor.saveAs" },
  "workbench.action.files.saveAll": { command: "editor.saveAll" },
  "workbench.action.files.setActiveEditorReadonlyInSession": {
    command: "editor.setReadOnlyInSession",
  },
  "workbench.action.files.setActiveEditorWriteableInSession": {
    command: "editor.setWritableInSession",
  },
  "workbench.action.files.toggleActiveEditorReadonlyInSession": {
    command: "editor.toggleReadOnlyInSession",
  },
  "workbench.action.files.resetActiveEditorReadonlyInSession": {
    command: "editor.resetReadOnlyInSession",
  },
  "workbench.action.files.newUntitledFile": { command: "workspace.newUntitledFile" },
  "workbench.action.files.openFile": { command: "workspace.openFile" },
  "workbench.action.files.openFolder": { command: "workspace.openFolder" },
  "workbench.action.openRecent": { command: "workspace.openRecent" },
  "workbench.action.closeFolder": { command: "workspace.closeFolder" },
  "workbench.action.newWindow": { command: "workbench.newWindow" },
  "workbench.action.closeActiveEditor": { command: "editor.closeTab" },
  "workbench.action.closeAllEditors": { command: "editor.closeAll" },
  "workbench.action.closeWindow": { command: "window.close" },
  "workbench.action.toggleSidebarVisibility": { command: "layout.toggleSidebar" },
  "workbench.action.togglePanel": { command: "layout.togglePanel" },
  "workbench.action.toggleAuxiliaryBar": { command: "layout.toggleRightRegion" },
  "workbench.action.toggleZenMode": { command: "layout.toggleZenMode" },
  "workbench.action.toggleCenteredLayout": { command: "layout.toggleCenteredLayout" },
  "workbench.action.toggleFullScreen": { command: "window.toggleFullscreen" },
  "workbench.action.toggleStatusbarVisibility": { command: "workbench.toggleStatusBar" },
  "workbench.action.splitEditor": { command: "layout.splitActive" },
  "workbench.action.openSettings": { command: "settings.open" },
  "workbench.action.openSettingsJson": { command: "settings.openJson" },
  "workbench.action.openGlobalKeybindings": { command: "keybindings.show" },
  "workbench.action.openGlobalKeybindingsFile": { command: "keybindings.openJson" },
  "workbench.action.selectTheme": { command: "ui.selectColorTheme" },
  "workbench.action.selectIconTheme": { command: "ui.selectFileIconTheme" },
  "workbench.action.findInFiles": { command: "search.show" },
  "workbench.action.replaceInFiles": { command: "search.show" },
  "workbench.action.terminal.toggleTerminal": { command: "terminal.toggle" },
  "workbench.action.terminal.new": { command: "terminal.create" },
  "workbench.action.terminal.split": { command: "terminal.split" },
  "workbench.action.terminal.kill": { command: "terminal.kill" },
  "workbench.action.terminal.clear": { command: "terminal.clear" },
  "workbench.action.terminal.focus": { command: "terminal.focus" },
  "workbench.action.terminal.runSelectedText": { command: "terminal.runSelectedText" },
  "workbench.action.terminal.runRecentCommand": { command: "terminal.runRecentCommand" },
  "workbench.action.terminal.scrollToPreviousCommand": {
    command: "terminal.scrollToPreviousCommand",
  },
  "workbench.action.terminal.scrollToNextCommand": { command: "terminal.scrollToNextCommand" },
  "workbench.action.terminal.copySelection": { command: "terminal.copySelection" },
  "workbench.action.terminal.paste": { command: "terminal.paste" },
  "workbench.action.terminal.selectAll": { command: "terminal.selectAll" },
  "workbench.action.tasks.runTask": { command: "tasks.run" },
  "workbench.action.tasks.build": { command: "tasks.runBuild" },
  "workbench.action.tasks.test": { command: "tasks.runTest" },
  "workbench.action.tasks.reRunTask": { command: "tasks.rerun" },
  "workbench.action.tasks.terminate": { command: "tasks.terminate" },
  "workbench.action.debug.start": { command: "debug.start" },
  "workbench.action.debug.run": { command: "debug.runWithoutDebugging" },
  "workbench.action.debug.stop": { command: "debug.stop" },
  "workbench.action.debug.restart": { command: "debug.restart" },
  "workbench.action.debug.continue": { command: "debug.continue" },
  "workbench.action.debug.pause": { command: "debug.pause" },
  "workbench.action.debug.stepOver": { command: "debug.stepOver" },
  "workbench.action.debug.stepInto": { command: "debug.stepInto" },
  "workbench.action.debug.stepOut": { command: "debug.stepOut" },
  "editor.debug.action.toggleBreakpoint": { command: "debug.toggleBreakpoint" },
  "editor.debug.action.runToCursor": { command: "debug.runToCursor" },
  "workbench.view.explorer": { command: "explorer.focus" },
  // VS Code's own Outline view (Jupyter's notebook toolbar has an Outline button).
  "outline.focus": { command: "outline.show" },
  "workbench.view.search": { command: "search.show" },
  "workbench.view.scm": { command: "git.showView" },
  "workbench.view.debug": { command: "debug.showView" },
  "workbench.view.extensions": { command: "extensions.show" },
  "workbench.actions.view.problems": { command: "problems.show" },
  "workbench.files.action.collapseExplorerFolders": { command: "explorer.collapseAll" },
  "workbench.files.action.refreshFilesExplorer": { command: "explorer.refresh" },
  "explorer.newFile": { command: "explorer.newFile" },
  "explorer.newFolder": { command: "explorer.newFolder" },
  renameFile: { command: "explorer.rename" },
  deleteFile: { command: "explorer.delete" },
  revealFileInOS: { command: "explorer.revealInOs" },
  "workbench.files.action.showActiveFileInExplorer": { command: "explorer.reveal" },
  "editor.action.formatDocument": { command: "editor.formatDocument" },
  "editor.action.formatDocument.multiple": { command: "editor.formatDocumentWith" },
  "editor.action.formatSelection.multiple": { command: "editor.formatSelectionWith" },
  "editor.action.toggleWordWrap": { command: "editor.toggleWordWrap" },
  "editor.action.toggleMinimap": { command: "editor.toggleMinimap" },
  "editor.action.toggleStickyScroll": { command: "editor.toggleStickyScroll" },
  "editor.action.toggleRenderWhitespace": { command: "editor.toggleRenderWhitespace" },
  "editor.action.toggleColumnSelection": { command: "editor.toggleColumnSelection" },
  "editor.action.revealDefinition": { command: "lsp.definition" },
  "editor.action.goToReferences": { command: "lsp.references" },
  "editor.action.showHover": { command: "lsp.hover" },
  undo: { command: "edit.undo" },
  redo: { command: "edit.redo" },
  "git.commit": { command: "git.commit" },
  "git.commitAll": { command: "git.commitAll" },
  "git.commitStaged": { command: "git.commitStaged" },
  "git.push": { command: "git.push" },
  "git.pull": { command: "git.pull" },
  "git.fetch": { command: "git.fetch" },
  "git.sync": { command: "git.sync" },
  "git.checkout": { command: "git.checkout" },
  "git.stage": { command: "git.stage" },
  "git.unstage": { command: "git.unstage" },
  "git.stash": { command: "git.stash" },
  "git.stashPop": { command: "git.stashPop" },
  "git.clone": { command: "git.clone" },
  "git.init": { command: "git.init" },
  "git.refresh": { command: "git.refresh" },
  "markdown.showPreview": { command: "viewer.openPreview" },
  "markdown.showPreviewToSide": { command: "viewer.openPreviewToSide" },
  "testing.runAll": { command: "tests.runAll" },
  "testing.runAtCursor": { command: "tests.runAtCursor" },
  "testing.reRunFailTests": { command: "tests.runFailed" },
  "notifications.clearAll": { command: "notifications.clear" },
  "notifications.toggleDoNotDisturbMode": { command: "notifications.toggleDoNotDisturb" },
  "workbench.action.reloadWindow": { command: "dev.reload" },
};

/** VS Code `when` context keys → the IDE's (the rest aren't known here). */
const CONTEXTS: Record<string, string> = {
  editorTextFocus: "editorFocus",
  editorFocus: "editorFocus",
  textInputFocus: "inputFocus",
  inputFocus: "inputFocus",
  terminalFocus: "terminalFocus",
  sideBarFocus: "sideBarFocus",
  sideBarVisible: "sidebarVisible",
  filesExplorerFocus: "explorerFocus",
  explorerViewletFocus: "explorerFocus",
  explorerViewletVisible: "sidebarVisible",
  inQuickOpen: "quickInputVisible",
  inDebugMode: "inDebugMode",
  debugState: "debugState",
  activeEditor: "activeEditor",
  isMac: "isMac",
  isWindows: "isWindows",
  isLinux: "isLinux",
  inZenMode: "zenMode",
  scmRepository: "gitRepo",
};

/** A VS Code `when` clause with the IDE's context names; null when one isn't known here. */
export function translateWhen(when: string | undefined): string | undefined | null {
  if (!when?.trim()) return undefined;
  let unknown = false;
  // Identifiers outside quotes; values in quotes ('stopped') stay as they are.
  const out = when.replace(/'[^']*'|"[^"]*"|([A-Za-z_][\w.:-]*)/g, (match, name?: string) => {
    if (!name) return match;
    if (name === "true" || name === "false") return name;
    const mapped = CONTEXTS[name];
    if (!mapped) unknown = true;
    return mapped ?? name;
  });
  return unknown ? null : out;
}

export interface KeybindingImport {
  rules: ImportedRule[];
  /** VS Code commands with no counterpart here (or a condition the IDE can't check). */
  skipped: { command: string; key: string; reason: string }[];
}

/**
 * VS Code keybindings.json entries → the IDE's. `has(command)` says whether a command exists
 * here: same-named commands (extension commands, `git.*`) carry over as they are; `editor.action.*`
 * ones the IDE has no command for run through Monaco (`editor.runAction`).
 */
export function translateKeybindings(
  entries: unknown,
  has: (command: string) => boolean,
): KeybindingImport {
  const rules: ImportedRule[] = [];
  const skipped: KeybindingImport["skipped"] = [];
  if (!Array.isArray(entries)) return { rules, skipped };
  for (const raw of entries) {
    const e = raw as {
      key?: unknown;
      command?: unknown;
      when?: unknown;
      args?: unknown;
      mac?: unknown;
    };
    if (typeof e?.key !== "string" || typeof e.command !== "string" || !e.command) continue;
    const removal = e.command.startsWith("-");
    const id = removal ? e.command.slice(1) : e.command;
    const mapped =
      VSCODE_COMMANDS[id] ??
      (has(id)
        ? { command: id }
        : id.startsWith("editor.action.") || id.startsWith("actions.")
          ? removal
            ? undefined
            : { command: "editor.runAction", args: { action: id } }
          : undefined);
    if (!mapped || !has(mapped.command)) {
      skipped.push({ command: e.command, key: e.key, reason: "no such command here" });
      continue;
    }
    const when = translateWhen(typeof e.when === "string" ? e.when : undefined);
    if (when === null) {
      skipped.push({ command: e.command, key: e.key, reason: `condition: ${String(e.when)}` });
      continue;
    }
    const args = mapped.args ?? e.args;
    rules.push({
      key: e.key,
      command: removal ? `-${mapped.command}` : mapped.command,
      ...(when && { when }),
      ...(args !== undefined && !removal && { args }),
      ...(typeof e.mac === "string" && { mac: e.mac }),
    });
  }
  return { rules, skipped };
}

export type ExtensionFate =
  /** Installed from Open VSX on Import (the store has it; checked when the page plans). */
  | { kind: "store"; note?: string }
  /** Installed here already. */
  | { kind: "installed"; note?: string }
  /** The IDE does its job itself: nothing to install. */
  | { kind: "builtin"; note: string }
  /** The IDE does its job with a setting, turned on by Import. */
  | { kind: "setting"; note: string; setting: string }
  /** Not on Open VSX (Microsoft's own marketplace only, or unpublished). */
  | { kind: "missing"; note?: string };

/**
 * VS Code extensions the IDE replaces outright (a small editing helper the editor has as a
 * setting, path completion): installing them would do the same thing twice. Every other
 * extension installs from Open VSX when it's there (VS Code extensions run here, D295/D296).
 */
const REPLACED: Record<string, ExtensionFate> = {
  "formulahendry.auto-close-tag": {
    kind: "setting",
    note: "Built in",
    setting: "editor.autoClosingTags",
  },
  "formulahendry.auto-rename-tag": {
    kind: "setting",
    note: "Built in (linked editing)",
    setting: "editor.linkedEditing",
  },
  "coenraads.bracket-pair-colorizer-2": {
    kind: "setting",
    note: "Built in",
    setting: "editor.bracketPairColorization.enabled",
  },
  "christian-kohler.path-intellisense": { kind: "builtin", note: "Path completion is built in" },
};

/**
 * What the IDE has itself, said beside an extension that installs (or that isn't on Open VSX):
 * the user may not need it.
 */
const ALSO_BUILT_IN: Record<string, string> = {
  "eamodio.gitlens": "Inline blame and the commit graph are also built in",
  "mhutchie.git-graph": "The commit graph is also in Source control",
  "donjayamanne.githistory": "File history and the commit graph are also built in",
  "github.vscode-pull-request-github": "Pull requests and issues are also built in (gh)",
  "github.copilot": "GitHub Copilot also runs as an agent from the AI models page",
  "github.copilot-chat": "GitHub Copilot also runs as an agent from the AI models page",
  "anthropic.claude-code": "Claude Code also runs in the agent panel",
  "openai.chatgpt": "Codex also runs in the agent panel",
  "google.gemini-cli-vscode-ide-companion": "Gemini CLI also runs in the agent panel",
  "ritwickdey.liveserver": "Go Live and the browser preview are also built in",
  "ms-vscode.live-server": "Go Live and the browser preview are also built in",
  "bierner.markdown-mermaid": "Mermaid diagrams also render in the built-in Markdown preview",
  "yzhang.markdown-all-in-one": "The Markdown preview is also built in",
  "shd101wyy.markdown-preview-enhanced": "The Markdown preview is also built in",
  "ms-toolsai.jupyter": "Notebooks also run on the built-in Jupyter extension",
  "ms-python.vscode-pylance": "Pyright is built in (a language server)",
  "alefragnani.bookmarks": "Bookmarks are also built in",
  "alefragnani.project-manager": "Folders can also be pinned on the welcome page",
  "wayou.vscode-todo-highlight": "TODO highlight is also a bundled extension",
  "gruntfuggly.todo-tree": "TODO highlight is also a bundled extension",
  "ms-vscode-remote.remote-wsl": "WSL folders also open from File → Open WSL folder…",
  "ms-vscode.powershell": "PowerShell's shell integration is also built in",
};

/**
 * What becomes of a VS Code extension, before the store is asked: replaced by the IDE, or to
 * install (planImport asks Open VSX and the installed list to settle store/installed/missing).
 */
export function extensionFate(id: string): ExtensionFate {
  const key = id.toLowerCase();
  const replaced = REPLACED[key];
  if (replaced) return replaced;
  const note = ALSO_BUILT_IN[key];
  return { kind: "store", ...(note && { note }) };
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  envFile?: string;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  type?: "stdio" | "http" | "sse";
}

export interface McpInput {
  id: string;
  description: string;
  password: boolean;
  /** A `pickString` input's choices (VS Code's format; D223): one is picked, nothing typed. */
  options?: string[];
  /** The value offered first. */
  default?: string;
}

/**
 * MCP server lists in the formats in use: VS Code's `mcp.json` (`servers`, `inputs`), the
 * portable `.mcp.json` and Claude Desktop's config (`mcpServers`), and VS Code settings' `mcp`.
 */
export function parseMcpConfig(json: unknown): {
  servers: Record<string, McpServerConfig>;
  inputs: McpInput[];
} {
  const root = (json ?? {}) as {
    servers?: unknown;
    mcpServers?: unknown;
    inputs?: unknown;
    mcp?: unknown;
  };
  const nested = root.mcp && typeof root.mcp === "object" ? (root.mcp as typeof root) : null;
  const list = root.servers ?? root.mcpServers ?? nested?.servers;
  const servers: Record<string, McpServerConfig> = {};
  if (list && typeof list === "object")
    for (const [name, raw] of Object.entries(list as Record<string, unknown>)) {
      const c = raw as Record<string, unknown>;
      if (!c || typeof c !== "object") continue;
      const strings = (v: unknown) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>).filter(
                (e): e is [string, string] => typeof e[1] === "string",
              ),
            )
          : undefined;
      const type = c.type === "http" || c.type === "sse" || c.type === "stdio" ? c.type : undefined;
      if (typeof c.url === "string" && c.url) {
        servers[name] = {
          type: type === "sse" ? "sse" : "http",
          url: c.url,
          ...(strings(c.headers) && { headers: strings(c.headers) }),
        };
      } else if (typeof c.command === "string" && c.command) {
        servers[name] = {
          command: c.command,
          ...(Array.isArray(c.args) && {
            args: c.args.filter((a): a is string => typeof a === "string"),
          }),
          ...(strings(c.env) && { env: strings(c.env) }),
          ...(typeof c.envFile === "string" && { envFile: c.envFile }),
          ...(typeof c.cwd === "string" && { cwd: c.cwd }),
        };
      }
    }
  const inputs: McpInput[] = [];
  const rawInputs = root.inputs ?? nested?.inputs;
  if (Array.isArray(rawInputs))
    for (const raw of rawInputs) {
      const i = raw as {
        id?: unknown;
        description?: unknown;
        password?: unknown;
        type?: unknown;
        options?: unknown;
        default?: unknown;
      };
      const pick = i?.type === "pickString";
      if (typeof i?.id !== "string" || (i.type !== undefined && i.type !== "promptString" && !pick))
        continue;
      // VS Code's options are strings or { label, value }.
      const options =
        pick && Array.isArray(i.options)
          ? i.options
              .map((o) =>
                typeof o === "string"
                  ? o
                  : o && typeof (o as { value?: unknown }).value === "string"
                    ? (o as { value: string }).value
                    : null,
              )
              .filter((o): o is string => o !== null)
              .slice(0, 100)
          : [];
      if (pick && !options.length) continue;
      inputs.push({
        id: i.id,
        description: typeof i.description === "string" ? i.description : i.id,
        password: !pick && i.password === true,
        ...(pick && { options }),
        ...(typeof i.default === "string" && { default: i.default }),
      });
    }
  return { servers, inputs };
}
