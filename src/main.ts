// Boot sequence:
//   1. build core services and paint the shell synchronously (no IPC before first paint),
//   2. activate built-in extensions and keybindings,
//   3. reopen the folder from the command line or the last session (restores its state),
//   4. Monaco warms up in the background (editor extension).

import { OperationHistory } from "./core/history/index";
import { NotebookProviders } from "./core/notebook/providers";
import { ExtensionFeatures, toolsOf } from "./workbench/extensionFeatures";
import "./styles/index.css";
import { ContextKeyService, type ContextValue } from "./core/context/index";
import { Dispatcher } from "./core/dispatcher/index";
import { EventBus } from "./core/events/index";
import { type BuiltinExtension, ExtensionHost } from "./core/extensions/index";
import { instancesIpc } from "./core/ipc/instances";
import { isTauri } from "./core/ipc/invoke";
import { execIpc } from "./core/ipc/process";
import { appIpc, auditIpc } from "./core/ipc/system";
import type { Platform } from "./core/keybindings/index";
import { LayoutModel } from "./core/layout/index";
import { basename } from "./core/paths/index";
import { perf } from "./core/perf";
import { createM2Policy } from "./core/permissions/index";
import { product } from "./core/product";
import { computed, effect, signal } from "./core/reactive/index";
import { StateTree } from "./core/state/index";
import { accountsExtension } from "./extensions/accounts/index";
import { agentExtension } from "./extensions/agent/index";
import { bookmarksExtension } from "./extensions/bookmarks/index";
import { browserExtension } from "./extensions/browser/index";
import { debugExtension } from "./extensions/debug/index";
import { editorExtension } from "./extensions/editor/index";
import { explorerExtension } from "./extensions/explorer/index";
import { extensionsExtension } from "./extensions/extensions/index";
import { gitExtension } from "./extensions/git/index";
import { helpExtension } from "./extensions/help/index";
import { historyExtension } from "./extensions/history/index";
import { keybindingsExtension } from "./extensions/keybindings/index";
import { languageServersExtension } from "./extensions/languageServers/index";
import { lspExtension } from "./extensions/lsp/index";
import { mcpExtension } from "./extensions/mcp/index";
import { paletteExtension } from "./extensions/palette/index";
import { quickOpenExtension } from "./extensions/quickOpen/index";
import { connectAtStartup, remoteExtension } from "./extensions/remote/index";
import { searchExtension } from "./extensions/search/index";
import { settingsExtension } from "./extensions/settings/index";
import { tasksExtension } from "./extensions/tasks/index";
import { terminalExtension } from "./extensions/terminal/index";
import { testingExtension } from "./extensions/testing/index";
import { viewersExtension } from "./extensions/viewers/index";
import { windowsExtension, windowsStartupDone } from "./extensions/windows/index";
import { createWorkbenchExtension } from "./extensions/workbench/index";
import { confirmAction } from "./ui/Dialog";
import { installIconSprite } from "./ui/Icon";
import { Notifications } from "./ui/Notifications";
import { QuickInput } from "./ui/QuickInput";
import { installSelectMenus } from "./ui/SelectMenu";
import { Tooltips } from "./ui/Tooltip";
import { AuxWindowService } from "./workbench/auxWindow";
import { applyBaseLayout } from "./workbench/baseLayout";
import { suppressBrowserDefaults } from "./workbench/browserDefaults";
import { Contributions } from "./workbench/contributions";
import { DebugMarks } from "./workbench/debugMarks";
import { DockService } from "./workbench/dock/service";
import { DockViewRegistry } from "./workbench/dock/views";
import { GitAccess } from "./workbench/gitAccess";
import { GutterMarks } from "./workbench/gutterMarks";
import { KeyboardService } from "./workbench/keyboard";
import { registerMovableViews } from "./workbench/movableViews";
import { askAgentPermission, askMcpPermission } from "./workbench/permissionPrompts";
import { PersistenceService } from "./workbench/persistence";
import { parseRestoreWindows, startupFolders } from "./workbench/restoreWindows";
import type { ExtensionGate, IdeEvents, WorkbenchServices } from "./workbench/services";
import {
  DocumentTexts,
  FileDecorationService,
  LanguageClientRegistry,
  ProblemCollections,
  QuickDiffService,
  ViewerRegistry,
} from "./workbench/services";
import { SettingsService } from "./workbench/settings";
import { runTestScriptFile } from "./workbench/testRun";
import { ThemeService } from "./workbench/theme";
import { WorkspaceTrust } from "./workbench/trust";
import { ViewRegistry } from "./workbench/views";
import { Workbench } from "./workbench/workbench";
import { WorkspaceService } from "./workbench/workspace";

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPad/.test(ua)) return "mac";
  if (/Windows/.test(ua)) return "windows";
  return "linux";
}

/** True during a `--run-test-script` run (the policy then allows `caller: test`). */
let testRun = false;

async function boot(): Promise<void> {
  const host = document.getElementById("app");
  if (!host) throw new Error("#app missing");
  installIconSprite();
  // Dropdowns open the IDE's own menu (D282).
  installSelectMenus(document);
  // A reload mid-turn: the old page's model requests and agent commands stop (D163).
  if (isTauri()) void execIpc.pageLoaded().catch(() => {});
  const platform = detectPlatform();
  // Per-OS tokens (the code font, D382) key off this, before the first paint.
  document.documentElement.dataset.platform = platform;
  // Theme attributes before the first paint (cached copy of the global preference).
  const theme = new ThemeService();
  const firstPaint = SettingsService.cachedFirstPaint();
  theme.apply({
    theme: firstPaint["workbench.theme"],
    density: firstPaint["workbench.density"],
    panels: firstPaint["workbench.panels"],
    sideBar: firstPaint["workbench.sideBarColor"],
    tabs: firstPaint["workbench.tabStyle"],
  } as Parameters<ThemeService["apply"]>[0]);
  // The last start's color theme (its token overrides and syntax colors), so a theme other than
  // the built-ins is there from the first frame instead of after its files load (D136).
  const overrides = firstPaint["theme.overrides"];
  // Only string values: the cache is read before anything else, and a value of another type (a
  // damaged cache) threw while the accent was parsed, so the app never started.
  if (overrides && typeof overrides === "object")
    theme.setOverrides(
      Object.fromEntries(
        Object.entries(overrides).filter((e): e is [string, string] => typeof e[1] === "string"),
      ),
    );
  const syntax = firstPaint["theme.syntax"] as
    | { name?: unknown; json?: unknown }
    | null
    | undefined;
  if (syntax && typeof syntax.name === "string")
    theme.setSyntaxTheme({ name: syntax.name, json: syntax.json });
  const settings = new SettingsService();

  // ---- Core services --------------------------------------------------------
  // `config.<setting>` in when clauses is the setting's value, as in VS Code (D262).
  const context = new ContextKeyService((key) =>
    key.startsWith("config.") ? (settings.peek<unknown>(key.slice(7)) as ContextValue) : undefined,
  );
  settings.model.onDidChange((keys) => context.changedOutside(keys.map((k) => `config.${k}`)));
  context.setMany({
    isMac: platform === "mac",
    isWindows: platform === "windows",
    isLinux: platform === "linux",
    isDev: __DEV__,
  });
  const events = new EventBus<IdeEvents>();
  const state = new StateTree();
  const layout = new LayoutModel();
  const views = new ViewRegistry();
  const dock = new DockService(new DockViewRegistry());
  const persistence = new PersistenceService();
  const workspace = new WorkspaceService(context, persistence);

  // Notifications/QuickInput need the overlay host, which the workbench creates; the dispatcher
  // needs a confirm function for destructive commands. Create in dependency order.
  const extensionGate: ExtensionGate = {
    authorize: async () => "deny",
    folders: () => [],
    enabledIds: signal<readonly string[]>([]),
  };
  const dispatcher = new Dispatcher({
    context,
    events,
    permissions: createM2Policy({
      confirm: (message, title) => confirmAction(title, message, "Delete", true),
      askMcp: askMcpPermission,
      askAgent: askAgentPermission,
      // Browser protection (D179): every page action asks, even ones declared without effects
      // (back, reload, scroll) and ones granted for the chat before it was turned on.
      agentAlwaysAsks: (request) =>
        request.commandId.startsWith("browser.") &&
        !(request.effects.length > 0 && request.effects.every((e) => e === "read")) &&
        settings.peek<boolean>("agent.browserProtection") === true,
      testMode: () => testRun,
      authorizeExtension: (request) => extensionGate.authorize(request),
    }),
    audit: (entry) => (isTauri() ? auditIpc.append(entry) : undefined),
    validateOutput: __DEV__,
  });
  // Overlays (notifications, quick input) live outside the workbench grid.
  const overlay = document.createElement("div");
  overlay.className = "overlay-host";
  document.body.appendChild(overlay);
  const notifications = new Notifications(overlay);
  const keyboard = new KeyboardService(platform, dispatcher, context, notifications);
  new Tooltips((command) => keyboard.labelFor(command));
  keyboard.attach(window);
  suppressBrowserDefaults(window);

  /** The active editor's name, shown in the window title (set by the editor extension). */
  const titleDetail = signal<string | null>(null);
  const decorations = new FileDecorationService();
  const quickDiff = new QuickDiffService();
  const languageClients = new LanguageClientRegistry();
  const viewers = new ViewerRegistry();
  const notebooks = new NotebookProviders();
  const documents = new DocumentTexts();
  const history = new OperationHistory();
  const title = computed(() =>
    [titleDetail.value, workspace.name.value, product.nameLong].filter(Boolean).join(" — "),
  );
  // Before the workbench: New tab lists extensions' tools (D181).
  const extensionFeatures = new ExtensionFeatures();
  const workbench = new Workbench(host, {
    platform,
    dispatcher,
    context,
    layout,
    views,
    keyboard,
    dock,
    title,
    workspaceName: workspace.name,
    regions: { bottom: dock.regionVisible("bottom"), right: dock.regionVisible("right") },
    decorations,
    tools: () => toolsOf(extensionFeatures, context),
  });
  const quickInput = new QuickInput(overlay);
  quickInput.anchor = () => workbench.titleBar.commandField.getBoundingClientRect();
  effect(() => {
    context.set("quickInputVisible", quickInput.visible.value);
    return undefined;
  });
  // User-run commands that fail surface as a toast (declined confirmations don't).
  events.on("command.executed", (e) => {
    if (e.caller.kind === "user" && e.error && e.status !== "denied")
      notifications.show("error", e.error);
  });

  const services: WorkbenchServices = {
    platform,
    dispatcher,
    context,
    state,
    events,
    layout,
    views,
    statusBar: workbench.statusBar,
    quickInput,
    notifications,
    keyboard,
    workspace,
    persistence,
    dock,
    theme,
    settings,
    iframes: workbench.iframes,
    auxWindows: new AuxWindowService(keyboard),
    contributions: new Contributions(),
    extensionGate,
    codeCheck: { newErrors: async () => null },
    languageModel: {
      model: () => null,
      generate: () => Promise.reject(new Error("No model is set up (see the agent panel).")),
    },
    trust: new WorkspaceTrust(workspace, persistence, context),
    dragFile: (down, source, path, paths) =>
      workbench.drag.arm(
        { kind: "file", path, ...(paths && paths.length > 1 && { paths }) },
        down,
        source,
        paths && paths.length > 1 ? `${paths.length} items` : basename(path),
      ),
    dragViews: (down, source, items, label) =>
      workbench.drag.arm({ kind: "views", items }, down, source, label),
    fileDropTarget: (element, drop) => workbench.drag.addFileTarget(element, drop),
    tabDropTarget: (element, accepts, drop) => workbench.drag.addTabTarget(element, accepts, drop),
    titleDetail,
    decorations,
    quickDiff,
    languageClients,
    viewers,
    notebooks,
    documents,
    history,
    problems: new ProblemCollections(),
    extensionFeatures,
    taskTerminals: {
      run: () => Promise.reject(new Error("Terminals aren't available.")),
    },
    debugMarks: new DebugMarks(),
    gutterMarks: new GutterMarks(),
    gitAccess: new GitAccess(),
  };
  registerShellStatus(services);
  // Sidebar views that move into the dock (D233); before extensions, so the dock restores them.
  registerMovableViews(services, workbench.sidebar);
  // Dev builds: a handle for automated UI tests (scripts/ui-smoke.mjs). Not present in production.
  if (__DEV__) Reflect.set(window, "__ide", { dispatcher, state, dock, theme });

  // ---- 1. First paint -------------------------------------------------------
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  perf.mark("shellPainted");

  // ---- 2. Extensions ----------------------------------------------------------
  const builtins: BuiltinExtension<WorkbenchServices>[] = [
    createWorkbenchExtension(workbench),
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
    extensionsExtension,
    languageServersExtension,
    lspExtension,
    agentExtension,
  ];
  if (__DEV__) builtins.push((await import("./extensions/dev/index")).devExtension);
  const extensionHost = new ExtensionHost(services, (id) => dispatcher.has(id));
  keyboard.setRules(extensionHost.keybindings(builtins));
  for (const contributed of extensionHost.settings(builtins)) settings.register(contributed);
  languageClients.contributed = extensionHost.languageServers(builtins);
  const status = await extensionHost.activateAll(builtins);
  for (const failed of status.filter((s) => s.error)) {
    notifications.show("error", `Extension ${failed.id} failed to start: ${failed.error}`);
  }
  perf.mark("extensionsActivated");
  workbench.showSidebarView("explorer.view", false);
  // Until a folder's layout is restored, the dock shows the welcome view.
  dock.resetToDefault(["welcome"], [], []);

  // ---- 3. Reopen a folder -----------------------------------------------------
  if (!isTauri()) {
    notifications.show(
      "warning",
      "Running outside the desktop shell: file system, terminal and dialogs are unavailable.",
    );
    return;
  }
  const info = await appIpc.info();
  perf.setProcessStart(info.processStartMs);
  const global = await persistence.loadGlobal();
  workspace.recent.value = global.recentFolders ?? (global.lastFolder ? [global.lastFolder] : []);
  workspace.pinned.value = global.pinnedFolders ?? [];
  settings.attachWorkspace(workspace);
  await settings.load().catch((err: unknown) => console.warn("settings unavailable", err));
  workspace.onDidOpen(() => void settings.load().catch(() => {}));
  // A multi-root workspace (D251): folders added or removed bring their own settings, and the
  // workspace file's settings are its workspace layer.
  workspace.onDidChangeFolders(() => void settings.load().catch(() => {}));
  effect(() => {
    workspace.fileData.value;
    if (workspace.file.peek()) void settings.reload("workspace").catch(() => {});
    return undefined;
  });
  // The workspace file may have been edited elsewhere (another editor, a git pull).
  window.addEventListener("focus", () => {
    if (workspace.file.peek()) void workspace.reloadFile().catch(() => {});
    // Folders opened in another window belong in this one's recent list too (D273).
    void workspace.refreshLists().catch(() => {});
  });
  workspace.onDidClose(() => void workspace.refreshLists().catch(() => {}));
  await migrateUiPreferences(global.ui, settings, persistence);
  // Test runs start from a known state (no README opened for a fresh folder).
  context.set("testRun", !!info.testScript);
  // window.restoreWindows (D209): the last folder here, the last session's other windows as
  // windows of their own, empty ones with their unsaved untitled text.
  const previous = await instancesIpc
    .restorable()
    .catch(() => ({ folders: [] as string[], empty: [] as string[] }));
  const restore = startupFolders({
    setting: parseRestoreWindows(settings.peek("window.restoreWindows")),
    launchFolder: info.launchFolder,
    newWindow: info.newWindow === true,
    lastFolder: global.lastFolder,
    previous: previous.folders,
    previousEmpty: previous.empty,
  });
  if (restore.takeEmpty) await instancesIpc.adoptEmpty(restore.takeEmpty).catch(() => {});
  // A window launched for a remote (D252): connected before its folder opens (a remote path).
  const remoteWindow = await connectAtStartup(services, info.remote);
  const folder = info.remote && !remoteWindow ? null : restore.open;
  let opened = false;
  if (folder) {
    opened = await workspace.open(folder).then(
      (root) => root !== null,
      (err: unknown) => {
        console.warn(`Could not reopen ${folder}`, err);
        return false;
      },
    );
  }
  // No folder: the base layout (explorer, welcome, agent; no terminal), the same every time (D163).
  if (!opened)
    applyBaseLayout(
      { layout, dock },
      { terminal: false, showSidebar: () => workbench.showSidebarView("agent.chats", false) },
    );
  perf.mark("workspaceRestored");
  // Files from the command line wait for the folder (D209); the other windows start now.
  windowsStartupDone();
  for (const other of restore.spawn) void appIpc.restoreWindow(other).catch(() => {});
  for (const id of restore.spawnEmpty) void instancesIpc.restoreEmptyWindow(id).catch(() => {});
  if (info.testScript) {
    testRun = true;
    await runTestScriptFile(info.testScript, dispatcher, state);
  }
}

/**
 * M1.5 kept theme/density/panels in global state. Move theme and density into user settings once;
 * the old panel style is dropped on purpose: flush is the new default for everyone (D47).
 */
async function migrateUiPreferences(
  ui: Record<string, unknown> | undefined,
  settings: SettingsService,
  persistence: PersistenceService,
): Promise<void> {
  if (!ui) return;
  if (ui.theme === "light" && settings.model.inspect("workbench.colorTheme", "user") === undefined)
    await settings.update("workbench.colorTheme", "Light+", "user").catch(() => {});
  if (
    (ui.density === "compact" || ui.density === "comfortable") &&
    settings.model.inspect("workbench.density", "user") === undefined
  )
    await settings.update("workbench.density", ui.density, "user").catch(() => {});
  await persistence.saveGlobal({ ui: undefined });
}

function registerShellStatus(services: WorkbenchServices): void {
  const { statusBar, workspace, keyboard } = services;
  statusBar.add({
    id: "workspace.folder",
    name: "Folder",
    alignment: "left",
    priority: 100,
    text: () => (workspace.root.value ? (workspace.name.value ?? "") : "No folder open"),
    // A multi-root workspace lists its folders (D251).
    tooltip: () =>
      workspace.file.value
        ? [
            workspace.file.value,
            ...workspace.folders.value.map((f) => `${f.name}: ${f.path}`),
          ].join("\n")
        : (workspace.root.value ?? "Open a folder to start"),
    command: "workspace.openFolder",
  });
  statusBar.add({
    id: "keyboard.chord",
    name: "Key chord",
    hideable: false,
    alignment: "left",
    priority: 50,
    text: () =>
      keyboard.pendingChord.value
        ? `(${keyboard.pendingChord.value}) was pressed. Waiting for second key of chord…`
        : "",
  });
}

boot().catch((err: unknown) => {
  console.error("Startup failed", err);
  const pre = document.createElement("pre");
  pre.className = "fatal-error";
  pre.textContent = `Startup failed: ${err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)}`;
  document.body.appendChild(pre);
});
