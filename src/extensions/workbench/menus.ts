// The menu bar's menus (File, Edit, Selection, View, Go, Git, Terminal, Help) and the ☰ menu
// (DESIGN.md §10.1, §12.5). Items are commands; unregistered ones are left out, ones not usable
// right now (no active editor…) are shown disabled.
import type { Disposable, DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import { isWorkspaceFile } from "../../core/workspace/workspaceFile";
import type { IconName } from "../../ui/Icon";
import { type MenuAnchor, type MenuItem, showMenu } from "../../ui/Menu";
import type { WorkbenchServices } from "../../workbench/services";
import { MENU_BAR } from "../../workbench/titlebar";
import { locationLabel } from "../../workbench/workspace";

interface Entry {
  label: string;
  /** A dispatcher command; or `action`, an editor engine action run through editor.runAction. */
  command?: string;
  action?: string;
  input?: unknown;
  icon?: IconName;
  /** The app's logo instead of an icon. */
  logo?: boolean;
  separatorBefore?: boolean;
  /** Shown disabled unless this context expression holds (e.g. "activeEditor"). */
  when?: string;
  /** Left out altogether unless this holds (a platform's own item: "isWindows"). */
  only?: string;
  /** Key hint for engine actions (the editor handles those keys itself): "ctrl+/", mac "cmd+/". */
  keys?: string;
  mac?: string;
  /** A toggle: checked while this setting is on (true, or anything but "off" / "none"). */
  setting?: string;
  /** A fixed submenu (the Git menu's Branches, Stash…). */
  children?: Entry[];
  /** A submenu built at open time (shown instead of running `command`). */
  submenu?: "recent" | "preferences" | "appearance" | "layout" | "switchEditor" | "tools";
}

const ED = "activeEditor";
/** Engine action in the active editor. */
const act = (
  label: string,
  action: string,
  keys?: string,
  mac?: string,
  extra: Partial<Entry> = {},
): Entry => ({
  label,
  action,
  when: ED,
  ...(keys && { keys }),
  ...(mac && { mac }),
  ...extra,
});
const sep = { separatorBefore: true };
const isOn = (v: unknown) => v === true || (typeof v === "string" && v !== "off" && v !== "none");

/** VS Code's menus, as far as the IDE has the features (plus Git). */
const MENUS: Record<string, Entry[]> = {
  file: [
    { label: "New text file", command: "workspace.newUntitledFile", icon: "file-plus" },
    { label: "New file…", command: "explorer.newFile", icon: "file-plus" },
    { label: "New folder…", command: "explorer.newFolder", icon: "folder-plus" },
    { label: "New window", command: "workbench.newWindow", icon: "app-window" },
    { label: "Open file…", command: "workspace.openFile", ...sep, icon: "file-input" },
    { label: "Open folder…", command: "workspace.openFolder", icon: "folder-open" },
    {
      label: "Open WSL folder…",
      command: "workspace.openWslFolder",
      icon: "terminal",
      only: "isWindows",
    },
    { label: "Open workspace from file…", command: "workspace.openWorkspaceFile", icon: "layers" },
    { label: "Open recent", submenu: "recent", icon: "history" },
    // Multi-root workspaces (D251).
    {
      label: "Add folder to workspace…",
      command: "workspace.addFolder",
      when: "workspaceOpen",
      ...sep,
      icon: "folder-plus",
    },
    {
      label: "Save workspace as…",
      command: "workspace.saveAs",
      when: "workspaceOpen",
      icon: "save",
    },
    {
      label: "Restore deleted files…",
      command: "explorer.restoreDeleted",
      icon: "archive-restore",
    },
    { label: "Save", command: "editor.save", ...sep, icon: "save" },
    { label: "Save as…", command: "editor.saveAs", icon: "file-output" },
    { label: "Save all", command: "editor.saveAll", icon: "save-all" },
    { label: "Preferences", submenu: "preferences", ...sep, icon: "settings" },
    {
      label: "Compare with saved",
      command: "editor.compareWithSaved",
      when: ED,
      ...sep,
      icon: "git-compare",
    },
    { label: "Revert file", command: "editor.reloadFromDisk", when: ED, icon: "undo-2" },
    { label: "Close editor", command: "layout.closeTab", icon: "x" },
    { label: "Close all editors", command: "editor.closeAll", icon: "list-x" },
    {
      label: "Close folder",
      command: "workspace.closeFolder",
      only: "workbenchState != workspace",
      icon: "folder-x",
    },
    {
      label: "Close workspace",
      command: "workspace.closeFolder",
      only: "workbenchState == workspace",
      icon: "folder-x",
    },
    { label: "Close window", command: "window.close", icon: "log-out" },
  ],
  edit: [
    // Text undo in an editor, else the workspace's (file operations, replace all, agent edits).
    { label: "Undo", command: "edit.undo", keys: "ctrl+z", mac: "cmd+z", icon: "undo-2" },
    { label: "Redo", command: "edit.redo", keys: "ctrl+y", mac: "cmd+shift+z", icon: "redo-2" },
    act("Cut", "editor.action.clipboardCutAction", "ctrl+x", "cmd+x", { ...sep, icon: "scissors" }),
    act("Copy", "editor.action.clipboardCopyAction", "ctrl+c", "cmd+c", { icon: "copy" }),
    act("Paste", "editor.action.clipboardPasteAction", "ctrl+v", "cmd+v", {
      icon: "clipboard-paste",
    }),
    act("Find", "actions.find", "ctrl+f", "cmd+f", { ...sep, icon: "search" }),
    act("Replace", "editor.action.startFindReplaceAction", "ctrl+h", "cmd+alt+f", {
      icon: "replace",
    }),
    {
      label: "Find in files",
      command: "search.show",
      icon: "search",
      keys: "ctrl+shift+f",
      mac: "cmd+shift+f",
      ...sep,
    },
    {
      label: "Replace in files",
      command: "search.show",
      keys: "ctrl+shift+h",
      mac: "cmd+shift+h",
      icon: "replace-all",
    },
    act("Toggle line comment", "editor.action.commentLine", "ctrl+/", "cmd+/", {
      ...sep,
      icon: "message-square-code",
    }),
    act("Toggle block comment", "editor.action.blockComment", "shift+alt+a", "shift+alt+a"),
    act("Format document", "editor.action.formatDocument", "shift+alt+f", "shift+alt+f", {
      ...sep,
      icon: "wand-sparkles",
    }),
    act("Rename symbol", "editor.action.rename", "f2", undefined, { icon: "text-cursor-input" }),
  ],
  selection: [
    act("Select all", "editor.action.selectAll", "ctrl+a", "cmd+a", { icon: "text-select" }),
    act(
      "Expand selection",
      "editor.action.smartSelect.expand",
      "shift+alt+right",
      "ctrl+shift+cmd+right",
    ),
    act(
      "Shrink selection",
      "editor.action.smartSelect.shrink",
      "shift+alt+left",
      "ctrl+shift+cmd+left",
    ),
    act("Copy line up", "editor.action.copyLinesUpAction", "shift+alt+up", "shift+alt+up", {
      ...sep,
      icon: "copy",
    }),
    act("Copy line down", "editor.action.copyLinesDownAction", "shift+alt+down", "shift+alt+down", {
      icon: "copy",
    }),
    act("Move line up", "editor.action.moveLinesUpAction", "alt+up", "alt+up", {
      icon: "arrow-up",
    }),
    act("Move line down", "editor.action.moveLinesDownAction", "alt+down", "alt+down", {
      icon: "arrow-down",
    }),
    act("Duplicate selection", "editor.action.duplicateSelection"),
    act("Add cursor above", "editor.action.insertCursorAbove", "ctrl+alt+up", "cmd+alt+up", sep),
    act("Add cursor below", "editor.action.insertCursorBelow", "ctrl+alt+down", "cmd+alt+down"),
    act(
      "Add cursors to line ends",
      "editor.action.insertCursorAtEndOfEachLineSelected",
      "shift+alt+i",
      "shift+alt+i",
    ),
    act("Add next occurrence", "editor.action.addSelectionToNextFindMatch", "ctrl+d", "cmd+d"),
    act("Add previous occurrence", "editor.action.addSelectionToPreviousFindMatch"),
    act("Select all occurrences", "editor.action.selectHighlights", "ctrl+shift+l", "cmd+shift+l"),
    {
      label: "Column selection mode",
      command: "editor.toggleColumnSelection",
      setting: "editor.columnSelection",
      ...sep,
    },
  ],
  view: [
    { label: "Command palette…", command: "palette.show", icon: "search" },
    { label: "Appearance", submenu: "appearance", ...sep, icon: "palette" },
    { label: "Editor layout", submenu: "layout", icon: "columns-2" },
    {
      label: "Explorer",
      command: "view.show",
      input: { id: "explorer.view" },
      icon: "files",
      ...sep,
    },
    { label: "Search", command: "view.show", input: { id: "search.view" }, icon: "search" },
    { label: "Source control", command: "git.showView", icon: "git-branch" },
    { label: "Agent", command: "layout.focusAgent", icon: "agent" },
    { label: "Problems", command: "problems.show", ...sep, icon: "circle-alert" },
    { label: "Terminal", command: "terminal.toggle", icon: "square-terminal" },
    { label: "Browser", command: "browser.open", icon: "globe" },
    {
      label: "Open running server…",
      command: "terminal.servers",
      input: { open: true },
      icon: "server",
    },
    // Every tool in one place, the IDE's and extensions' (D181), searchable when it grows.
    { label: "Tools", submenu: "tools", icon: "blocks" },
    { label: "Word wrap", command: "editor.toggleWordWrap", setting: "editor.wordWrap", ...sep },
    { label: "Minimap", command: "editor.toggleMinimap", setting: "editor.minimap.enabled" },
    {
      label: "Sticky scroll",
      command: "editor.toggleStickyScroll",
      setting: "editor.stickyScroll.enabled",
    },
    {
      label: "Render whitespace",
      command: "editor.toggleRenderWhitespace",
      setting: "editor.renderWhitespace",
    },
  ],
  go: [
    { label: "Back", command: "workbench.navigateBack", icon: "arrow-left" },
    { label: "Forward", command: "workbench.navigateForward", icon: "arrow-right" },
    { label: "Switch editor", submenu: "switchEditor", ...sep, icon: "files" },
    { label: "Next editor", command: "layout.nextTab", icon: "arrow-right" },
    { label: "Previous editor", command: "layout.previousTab", icon: "arrow-left" },
    { label: "Go to file…", command: "quickOpen.show", ...sep, icon: "file-search" },
    {
      label: "Go to symbol in workspace…",
      command: "quickOpen.goToWorkspaceSymbol",
      icon: "square-function",
    },
    {
      label: "Go to symbol in editor…",
      command: "quickOpen.goToSymbol",
      when: ED,
      ...sep,
      icon: "at-sign",
    },
    act("Go to definition", "editor.action.revealDefinition", "f12", "f12"),
    act("Go to type definition", "editor.action.goToTypeDefinition"),
    act("Go to implementations", "editor.action.goToImplementation", "ctrl+f12", "cmd+f12"),
    act("Go to references", "editor.action.goToReferences", "shift+f12", "shift+f12", {
      icon: "search",
    }),
    { label: "Go to line/column…", command: "editor.gotoLine", when: ED, ...sep, icon: "hash" },
    act("Go to bracket", "editor.action.jumpToBracket", "ctrl+shift+\\", "cmd+shift+\\"),
    act("Next problem", "editor.action.marker.nextInFiles", "f8", "f8", {
      ...sep,
      icon: "circle-alert",
    }),
    act("Previous problem", "editor.action.marker.prevInFiles", "shift+f8", "shift+f8"),
    act("Next change", "editor.action.dirtydiff.next", "alt+f3", "alt+f3", sep),
    act("Previous change", "editor.action.dirtydiff.previous", "shift+alt+f3", "shift+alt+f3"),
  ],
  // Grouped like VS Code's Source Control "…" menu (D191): the everyday actions at the top, the
  // rest in submenus, so the menu fits a small window.
  git: [
    { label: "Source control", command: "git.showView", icon: "git-branch" },
    { label: "Commit", command: "git.commit", icon: "git-commit-horizontal", ...sep },
    { label: "Stage all changes", command: "git.stage", icon: "plus" },
    { label: "Unstage all changes", command: "git.unstage", icon: "minus" },
    { label: "Discard all changes…", command: "git.discard", icon: "undo-2" },
    { label: "Pull", command: "git.pull", icon: "arrow-down", ...sep },
    { label: "Push", command: "git.push", icon: "arrow-up" },
    { label: "Fetch", command: "git.fetch", icon: "refresh-ccw" },
    { label: "Sync", command: "git.sync", icon: "refresh-cw" },
    {
      label: "Branch",
      icon: "git-branch",
      ...sep,
      children: [
        { label: "Checkout branch…", command: "git.checkout", icon: "git-branch" },
        { label: "Create branch from…", command: "git.createBranchFrom", icon: "git-branch" },
        { label: "Interactive rebase…", command: "git.rebaseInteractive" },
        { label: "Worktrees…", command: "git.worktrees", icon: "folder-git-2", ...sep },
        { label: "Create worktree…", command: "git.createWorktree" },
      ],
    },
    {
      label: "Stash",
      icon: "archive",
      children: [
        { label: "Stash changes…", command: "git.stash", icon: "archive" },
        { label: "Stash (include untracked)…", command: "git.stashIncludeUntracked" },
        { label: "Pop stash…", command: "git.stashPop", icon: "archive-restore", ...sep },
        { label: "Apply stash…", command: "git.stashApply" },
        { label: "Drop stash…", command: "git.stashDrop" },
      ],
    },
    {
      label: "History",
      icon: "history",
      children: [
        { label: "Show git log", command: "git.log", icon: "git-graph" },
        { label: "Show file history", command: "git.fileHistory", icon: "history" },
        { label: "Show who changed this line", command: "git.blameLine" },
        { label: "Toggle inline blame", command: "git.toggleInlineBlame" },
      ],
    },
    {
      label: "GitHub",
      icon: "git-pull-request",
      children: [
        { label: "Pull requests…", command: "github.pullRequests", icon: "git-pull-request" },
        {
          label: "Create pull request…",
          command: "github.createPullRequest",
          icon: "git-pull-request",
        },
        { label: "Checkout pull request…", command: "github.checkoutPullRequest" },
        { label: "Issues…", command: "github.issues", icon: "circle-dot", ...sep },
      ],
    },
    { label: "Clone repository…", command: "git.clone", icon: "cloud-download", ...sep },
    { label: "Initialize repository", command: "git.init", icon: "folder-git-2" },
  ],
  terminal: [
    { label: "New terminal", command: "terminal.create", icon: "square-terminal" },
    { label: "Split terminal", command: "terminal.split", icon: "columns-2" },
    { label: "Run task…", command: "tasks.run", ...sep, icon: "play" },
    {
      label: "Run build task",
      command: "tasks.runBuild",
      keys: "ctrl+shift+b",
      mac: "cmd+shift+b",
    },
    { label: "Rerun last task", command: "tasks.rerun", icon: "rotate-cw" },
    { label: "Show running tasks…", command: "tasks.showRunning" },
    { label: "Restart running task…", command: "tasks.restart" },
    { label: "Terminate task…", command: "tasks.terminate", icon: "square" },
    { label: "Configure tasks…", command: "tasks.configure", ...sep, icon: "settings" },
    { label: "Open user tasks", command: "tasks.openUserTasks" },
    { label: "Configure default build task…", command: "tasks.configureDefaultBuild" },
    { label: "Configure default test task…", command: "tasks.configureDefaultTest" },
    { label: "Run selected text", command: "terminal.runSelectedText", ...sep },
    { label: "Clear terminal", command: "terminal.clear", ...sep, icon: "ban" },
    { label: "Rename terminal…", command: "terminal.rename", icon: "pencil" },
    { label: "Kill terminal", command: "terminal.kill", icon: "trash-2" },
    { label: "Toggle terminal", command: "terminal.toggle", ...sep },
  ],
  help: [
    { label: "Welcome", command: "layout.openView", input: { viewType: "welcome" }, logo: true },
    { label: "Documentation", command: "help.showDocs", icon: "book-open" },
    { label: "Release notes", command: "help.showReleaseNotes", icon: "sparkles" },
    { label: "Show all commands", command: "palette.show", icon: "search" },
    { label: "Keyboard shortcuts", command: "keybindings.show", icon: "keyboard" },
    { label: "Keyboard shortcuts reference", command: "keybindings.showReference" },
    { label: "Import from VS Code…", command: "settings.showImport", icon: "download" },
    { label: "Show language server log", command: "lsp.showLog", ...sep, icon: "scroll-text" },
    { label: "MCP connection info", command: "mcp.showConnectionInfo", icon: "info" },
    {
      label: "Report a problem…",
      command: "help.reportProblem",
      icon: "message-circle-question",
      ...sep,
    },
    { label: "Open logs folder", command: "help.openLogsFolder", icon: "scroll-text" },
    { label: "Restart with extensions off", command: "help.restartWithExtensionsOff" },
    { label: "Start extension bisect", command: "extensions.startBisect" },
    { label: "Show startup timings", command: "workbench.startupTimings", icon: "info", ...sep },
    { label: "Reload window", command: "dev.reload", icon: "refresh-cw" },
    { label: "Toggle zen mode", command: "layout.toggleZenMode", ...sep, icon: "scan" },
    { label: "Check for updates…", command: "update.check", ...sep, icon: "cloud-download" },
    { label: "About", command: "workbench.about", icon: "info" },
  ],
};

export function registerMenus(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, keyboard, workspace } = services;
  const anchorFor = (selector: string | undefined, fallback: string): MenuAnchor =>
    document.querySelector<HTMLElement>(selector ?? fallback) ?? { x: 8, y: 40 };
  const run = (command: string, input: unknown = {}) =>
    void dispatcher.execute(command, input).catch(() => {});
  const submenus: Record<NonNullable<Entry["submenu"]>, () => MenuItem[]> = {
    appearance: () => {
      const theme = services.theme;
      return [
        ...build([
          { label: "Sidebar", command: "layout.toggleSidebar", icon: "panel-left" },
          { label: "Panel", command: "layout.togglePanel", icon: "panel-bottom" },
          { label: "Right region", command: "layout.toggleRightRegion", icon: "panel-right" },
          {
            label: "Full screen",
            command: "window.toggleFullscreen",
            separatorBefore: true,
            icon: "maximize-2",
          },
          { label: "Zen mode", command: "layout.toggleZenMode", icon: "scan" },
          { label: "Centered layout", command: "layout.toggleCenteredLayout", icon: "columns-2" },
          {
            label:
              services.layout.sidebarSide.peek() === "right"
                ? "Move sidebar left"
                : "Move sidebar right",
            command: "layout.toggleSidebarPosition",
          },
        ]),
        ...(["dark", "light"] as const).map((t, i) => ({
          label: t === "dark" ? "Dark theme" : "Light theme",
          checked: theme.theme.peek() === t,
          separatorBefore: i === 0,
          run: () => run("ui.setTheme", { theme: t }),
        })),
        ...(["compact", "default", "comfortable"] as const).map((d, i) => ({
          label: `${d[0]?.toUpperCase()}${d.slice(1)} density`,
          checked: theme.density.peek() === d,
          separatorBefore: i === 0,
          run: () => run("ui.setDensity", { density: d }),
        })),
        ...(["flush", "floating"] as const).map((p, i) => ({
          label: p === "flush" ? "Flush panels" : "Floating panels",
          checked: theme.panels.peek() === p,
          separatorBefore: i === 0,
          run: () => run("ui.setPanelStyle", { panels: p }),
        })),
      ];
    },
    layout: () =>
      build([
        {
          label: "Split right",
          command: "layout.splitActive",
          input: { direction: "right" },
          icon: "columns-2",
        },
        {
          label: "Split down",
          command: "layout.splitActive",
          input: { direction: "down" },
          icon: "rows-2",
        },
        {
          label: "Maximize group",
          command: "layout.toggleMaximize",
          icon: "maximize-2",
          separatorBefore: true,
        },
        { label: "Equalize group sizes", command: "layout.equalize", icon: "columns-2" },
        { label: "Close group", command: "layout.closeGroup", icon: "x" },
        {
          label: "Reset layout",
          command: "layout.reset",
          icon: "layout-dashboard",
          separatorBefore: true,
        },
      ]),
    switchEditor: () => {
      const active = services.dock.activeTab()?.id;
      const tabs = services.dock.tabs().filter((t) => services.dock.isEditorLike(t));
      return tabs.length === 0
        ? [{ label: "No open editors", disabled: true }]
        : tabs.slice(0, 20).map((t) => ({
            label: services.dock.title(t),
            checked: t.id === active,
            run: () => run("layout.focusTab", { tabId: t.id }),
          }));
    },
    recent: () => {
      const recent = workspace.recentOrdered();
      return recent.length === 0
        ? [{ label: "No recent folders", disabled: true }]
        : [
            ...recent.slice(0, 10).map((path) => ({
              // A workspace file (D251): its name, with "(Workspace)".
              label: isWorkspaceFile(path) ? `${locationLabel(path)} — ${path}` : path,
              icon: isWorkspaceFile(path) ? ("layers" as const) : ("folder" as const),
              run: () => run("workspace.openRecent", { path }),
            })),
            { label: "More…", separatorBefore: true, run: () => run("workspace.openRecent") },
          ];
    },
    tools: () => {
      const f = services.extensionFeatures;
      const view = (id: string) => ({ command: "view.show", input: { id } });
      const builtIn: Entry[] = [
        { label: "Explorer", ...view("explorer.view"), icon: "files" },
        { label: "Search", ...view("search.view"), icon: "search" },
        { label: "Source control", ...view("scm.view"), icon: "git-branch" },
        { label: "Run and debug", ...view("debug.view"), icon: "bug-play" },
        { label: "Testing", ...view("testing.view"), icon: "flask-conical" },
        { label: "Outline", ...view("outline.view"), icon: "list-tree" },
        { label: "Extensions", ...view("extensions.view"), icon: "blocks" },
        { label: "Agent", command: "layout.focusAgent", icon: "agent", ...sep },
        { label: "Channels", ...view("agent.chats"), icon: "message-circle-question" },
        { label: "Terminal", command: "terminal.toggle", icon: "square-terminal", ...sep },
        { label: "Problems", command: "problems.show", icon: "circle-alert" },
        { label: "Browser", command: "browser.open", icon: "globe" },
        { label: "Settings", command: "settings.open", icon: "settings", ...sep },
        { label: "Keyboard shortcuts", command: "keybindings.show", icon: "keyboard" },
        { label: "AI models", command: "agent.showSetup", icon: "agent" },
        { label: "Documentation", command: "help.showDocs", icon: "book-open" },
        { label: "Debug console", command: "debug.showConsole", icon: "bug-play" },
      ];
      const items: MenuItem[] = build(builtIn);
      let last = "";
      const openers = f.allOpeners((when) => services.context.matches(when));
      for (const o of openers) {
        items.push({
          label: o.title,
          icon: (o.icon ?? "box") as IconName,
          // A line before each extension's tools.
          separatorBefore: o.owner !== last,
          run: () => run(o.command, o.input),
        });
        last = o.owner;
      }
      return items;
    },
    preferences: () =>
      [
        { label: "Settings", command: "settings.open", icon: "settings" as const },
        { label: "Keyboard shortcuts", command: "keybindings.show", icon: "keyboard" as const },
        { label: "Snippets", command: "editor.configureSnippets", icon: "braces" as const },
        { label: "Appearance…", command: "ui.showAppearanceMenu", icon: "palette" as const },
        { label: "Toggle light/dark theme", command: "ui.toggleTheme", icon: "sun" as const },
        {
          label: "Export profile…",
          command: "settings.exportProfile",
          separatorBefore: true,
          icon: "upload" as const,
        },
        { label: "Import profile…", command: "settings.importProfile", icon: "download" as const },
        {
          label: "Import from VS Code…",
          command: "settings.showImport",
          icon: "download" as const,
        },
      ]
        .filter((e) => dispatcher.has(e.command))
        .map((e) => ({
          label: e.label,
          ...("separatorBefore" in e && { separatorBefore: true }),
          ...(e.icon && { icon: e.icon }),
          ...(keyboard.labelFor(e.command) && { keybinding: keyboard.labelFor(e.command) }),
          run: () => run(e.command),
        })),
  };
  const enabledMap = () => new Map(dispatcher.list().map((c) => [c.id, c.enabled]));
  /** Entries → menu items: unknown commands are left out, unavailable ones shown disabled. */
  const build = (entries: readonly Entry[]): MenuItem[] => {
    const enabled = enabledMap();
    const out: MenuItem[] = [];
    let pendingSeparator = false;
    for (const entry of entries) {
      if (entry.only && !services.context.matches(entry.only)) continue;
      pendingSeparator ||= entry.separatorBefore === true;
      const command = entry.action ? "editor.runAction" : entry.command;
      const input = entry.action ? { action: entry.action } : (entry.input ?? {});
      const fixed = entry.children ? build(entry.children) : undefined;
      if (!entry.submenu && !fixed && (!command || !enabled.has(command))) continue;
      const usable =
        entry.submenu !== undefined ||
        // A fixed submenu is usable while any of its items is.
        fixed?.some((i) => !i.disabled) ||
        (enabled.get(command as string) === true && services.context.matches(entry.when));
      const key = entry.keys
        ? keyboard.labelForKeys(entry.keys, entry.mac)
        : command && entry.input === undefined && !entry.action
          ? keyboard.labelFor(command)
          : undefined;
      const submenu = fixed ?? (entry.submenu ? submenus[entry.submenu]() : undefined);
      if (submenu && submenu.length === 0) continue;
      out.push({
        label: entry.label,
        ...(entry.icon && { icon: entry.icon }),
        ...(entry.logo && { logo: true }),
        ...(key && !submenu && { keybinding: key }),
        ...(submenu && {
          submenu,
          searchable: submenu.length > 10 || entry.submenu === "switchEditor",
        }),
        ...(!usable && { disabled: true }),
        ...(entry.setting && { checked: isOn(services.settings.peek(entry.setting)) }),
        separatorBefore: pendingSeparator && out.length > 0,
        ...(command && !submenu && { run: () => run(command, input) }),
      });
      pendingSeparator = false;
    }
    return out;
  };
  const items = (menu: string): MenuItem[] => build(MENUS[menu] ?? []);

  // Menu bar behaviour: one menu open at a time; while one is open, hovering another title opens
  // it; ←/→ move between menus; clicking the open menu's title closes it.
  let open: { id: string; handle: Disposable; closedAt?: number } | null = null;
  let lastClosed: { id: string; at: number } | null = null;
  const ids = MENU_BAR.map((m) => m.id);
  const openMenu = (menu: string, anchor: string | undefined, focusFirst: boolean) => {
    if (open?.id === menu) return;
    open?.handle.dispose();
    const label = MENU_BAR.find((m) => m.id === menu)?.label ?? menu;
    const title = document.querySelector<HTMLElement>(`[data-menu="${menu}"]`);
    title?.classList.add("is-open");
    const entry: { id: string; handle: Disposable } = { id: menu, handle: { dispose() {} } };
    open = entry;
    entry.handle = showMenu(anchorFor(anchor, ".titlebar-menu"), items(menu), {
      label,
      focusFirst,
      onNavigate: (dir) => {
        const next = ids[(ids.indexOf(menu) + dir + ids.length) % ids.length] as string;
        const target = document.querySelector<HTMLElement>(`[data-menu="${next}"]`);
        openMenu(next, target?.offsetParent ? `[data-menu="${next}"]` : anchor, true);
      },
      onClose: () => {
        title?.classList.remove("is-open");
        if (open === entry) {
          open = null;
          lastClosed = { id: menu, at: performance.now() };
        }
      },
    });
  };
  sub.add({ dispose: () => open?.handle.dispose() });
  sub.add(
    dispatcher.register({
      id: "ui.showMenu",
      title: "Show menu",
      category: "View",
      description: "Opens one of the menu bar's menus (file, edit, view, go, git, terminal, help).",
      input: s.object({
        menu: s.enum(MENU_BAR.map((m) => m.id) as [string, ...string[]]),
        anchor: s.string().describe("CSS selector of the element to open below").optional(),
        hover: s.boolean().describe("Only switch if another menu bar menu is open").optional(),
      }),
      effects: [],
      agent: "hidden",
      palette: false,
      run: ({ menu, anchor, hover }) => {
        if (hover) {
          if (open && open.id !== menu) openMenu(menu, anchor, false);
          return;
        }
        // The press on this menu's title closed it (outside press): don't reopen.
        if (lastClosed?.id === menu && performance.now() - lastClosed.at < 300) return;
        openMenu(menu, anchor, false);
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "ui.showAppMenu",
      title: "Application menu",
      category: "View",
      description:
        "Opens the application menu: every menu bar menu as a submenu (they collapse into it on narrow windows).",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: () => {
        showMenu(
          anchorFor(".titlebar-menu", ".titlebar-menu"),
          MENU_BAR.map(({ id, label }) => ({ label, submenu: items(id) })),
          "Application menu",
        );
      },
    }),
  );
}
