// Boot sequence:
//   1. build the services (createServices, with the window's implementations) and paint the shell
//      synchronously (no IPC before first paint),
//   2. activate built-in extensions and keybindings,
//   3. reopen the folder from the command line or the last session (restores its state),
//   4. Monaco warms up in the background (editor extension).

import "./styles/index.css";
import { ExtensionHost } from "./core/extensions/index";
import { instancesIpc } from "./core/ipc/instances";
import { hasBackend } from "./core/ipc/invoke";
import { execIpc } from "./core/ipc/process";
import { appIpc, auditIpc, storeIpc } from "./core/ipc/system";
import type { Platform } from "./core/keybindings/index";
import { basename } from "./core/paths/index";
import { perf } from "./core/perf";
import { product } from "./core/product";
import { computed, effect } from "./core/reactive/index";
import { builtinExtensions } from "./extensions/builtins";
import { connectAtStartup } from "./extensions/remote/index";
import { windowsStartupDone } from "./extensions/windows/index";
import { createWorkbenchExtension } from "./extensions/workbench/index";
import { confirmAction, isModalDialogOpen } from "./ui/Dialog";
import { installIconSprite } from "./ui/Icon";
import { Notifications } from "./ui/Notifications";
import { QuickInput } from "./ui/QuickInput";
import { installSelectMenus } from "./ui/SelectMenu";
import { Tooltips } from "./ui/Tooltip";
import { AuxWindowService } from "./workbench/auxWindow";
import { applyBaseLayout } from "./workbench/baseLayout";
import { suppressBrowserDefaults } from "./workbench/browserDefaults";
import { createServices } from "./workbench/createServices";
import { toolsOf } from "./workbench/extensionFeatures";
import { registerMovableViews } from "./workbench/movableViews";
import { askAgentPermission, askMcpPermission } from "./workbench/permissionPrompts";
import type { PersistenceService } from "./workbench/persistence";
import { parseRestoreWindows, startupFolders } from "./workbench/restoreWindows";
import { localStorageFirstPaintCache, SettingsService } from "./workbench/settings";
import { runTestScriptFile } from "./workbench/testRun";
import { ThemeService } from "./workbench/theme";
import { trustDialogs } from "./workbench/trustDialogs";
import { Workbench } from "./workbench/workbench";

/** The OS of the machine this window is on (the desktop app's backend is on the same one). */
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
  if (hasBackend()) void execIpc.pageLoaded().catch(() => {});
  const platform = detectPlatform();
  // Per-OS tokens (the code font, D382) key off this, before the first paint.
  document.documentElement.dataset.platform = platform;
  // Theme attributes before the first paint (cached copy of the global preference).
  const theme = new ThemeService();
  const firstPaint = localStorageFirstPaintCache.read();
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
  const settings = new SettingsService(localStorageFirstPaintCache);

  // ---- Services -------------------------------------------------------------
  // The window's implementations; everything else is built by createServices, the same way a
  // screenless entry builds it. Notifications/QuickInput need the overlay host, and the workbench
  // needs the logic services, so those are made inside the callbacks, in dependency order.
  // Overlays (notifications, quick input) live outside the workbench grid.
  const overlay = document.createElement("div");
  overlay.className = "overlay-host";
  const shell: { workbench: Workbench | null } = { workbench: null };
  const services = createServices({
    screenPlatform: platform,
    backendPlatform: platform,
    hasScreen: true,
    settings,
    theme,
    permissions: {
      confirm: (message, title) => confirmAction(title, message, "Delete", true),
      askMcp: askMcpPermission,
      askAgent: askAgentPermission,
      testMode: () => testRun,
    },
    stateBackend: storeIpc,
    audit: (entry) => (hasBackend() ? auditIpc.append(entry) : undefined),
    validateOutput: __DEV__,
    notifications: () => {
      document.body.appendChild(overlay);
      return new Notifications(overlay);
    },
    modalDialogOpen: isModalDialogOpen,
    trustPrompts: trustDialogs,
    nextFrame: (run) => void requestAnimationFrame(run),
    screen: (logic) => {
      const { dispatcher, context, keyboard, workspace, dock, extensionFeatures } = logic;
      new Tooltips((command) => keyboard.labelFor(command));
      keyboard.attach(window);
      suppressBrowserDefaults(window);
      const title = computed(() =>
        [logic.titleDetail.value, workspace.name.value, product.nameLong]
          .filter(Boolean)
          .join(" — "),
      );
      const made = new Workbench(host, {
        platform,
        dispatcher,
        context,
        layout: logic.layout,
        views: logic.views,
        keyboard,
        dock,
        title,
        workspaceName: workspace.name,
        regions: { bottom: dock.regionVisible("bottom"), right: dock.regionVisible("right") },
        decorations: logic.decorations,
        tools: () => toolsOf(extensionFeatures, context),
      });
      shell.workbench = made;
      const quickInput = new QuickInput(overlay);
      quickInput.anchor = () => made.titleBar.commandField.getBoundingClientRect();
      return {
        statusBar: made.statusBar,
        quickInput,
        iframes: made.iframes,
        auxWindows: new AuxWindowService(keyboard),
        dragFile: (down, source, path, paths) =>
          made.drag.arm(
            { kind: "file", path, ...(paths && paths.length > 1 && { paths }) },
            down,
            source,
            paths && paths.length > 1 ? `${paths.length} items` : basename(path),
          ),
        dragViews: (down, source, items, label) =>
          made.drag.arm({ kind: "views", items }, down, source, label),
        fileDropTarget: (element, drop) => made.drag.addFileTarget(element, drop),
        tabDropTarget: (element, accepts, drop) => made.drag.addTabTarget(element, accepts, drop),
      };
    },
  });
  const workbench = shell.workbench;
  if (!workbench) throw new Error("The workbench was not built.");
  const { dispatcher, context, state, layout, dock, persistence, workspace } = services;
  const { notifications, keyboard, languageClients } = services;
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
  const builtins = builtinExtensions(createWorkbenchExtension(workbench));
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
  if (!hasBackend()) {
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
  // No folder: the base layout the user chose (workbench.defaultLayout), the same every time (D163).
  if (!opened)
    applyBaseLayout(
      { layout, dock, settings },
      { folder: false, showSidebar: (view) => workbench.showSidebarView(view, false) },
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

boot().catch((err: unknown) => {
  console.error("Startup failed", err);
  const pre = document.createElement("pre");
  pre.className = "fatal-error";
  pre.textContent = `Startup failed: ${err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)}`;
  document.body.appendChild(pre);
});
