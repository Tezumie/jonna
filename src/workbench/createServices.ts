// Builds the services extensions get (WorkbenchServices) from a set of implementations. The
// window's entry (main.ts) and a screenless one (headless/boot.ts) call this with different sets
// and nothing else differs: the logic services (dispatcher, state, settings, workspace, events,
// trust, the registries) are built here, the same way for both; what a screen draws or asks is
// passed in. DOM-free.
import { ContextKeyService, type ContextValue } from "../core/context/index";
import { type AuditEntry, Dispatcher } from "../core/dispatcher/index";
import { EventBus } from "../core/events/index";
import { OperationHistory } from "../core/history/index";
import type { Platform } from "../core/keybindings/index";
import { LayoutModel } from "../core/layout/index";
import { NotebookProviders } from "../core/notebook/providers";
import { createM2Policy, type M2PolicyOptions } from "../core/permissions/index";
import { effect, type Signal, signal } from "../core/reactive/index";
import { StateTree } from "../core/state/index";
import { Contributions } from "./contributions";
import { DebugMarks } from "./debugMarks";
import { DockService } from "./dock/service";
import { DockViewRegistry } from "./dock/views";
import { ExtensionFeatures } from "./extensionFeatures";
import { GitAccess } from "./gitAccess";
import { GutterMarks } from "./gutterMarks";
import { KeyboardService } from "./keyboard";
import { PersistenceService, type StateBackend } from "./persistence";
import {
  DocumentTexts,
  type ExtensionGate,
  FileDecorationService,
  type IdeEvents,
  LanguageClientRegistry,
  type NotificationService,
  ProblemCollections,
  QuickDiffService,
  type ThemeApi,
  ViewerRegistry,
  type WorkbenchServices,
} from "./services";
import type { SettingsService } from "./settings";
import { type TrustPrompts, WorkspaceTrust } from "./trust";
import { ViewRegistry } from "./viewRegistry";
import { WorkspaceService } from "./workspace";

/** The services only a screen has; a screenless set passes inert ones. */
export type ScreenServices = Pick<
  WorkbenchServices,
  | "statusBar"
  | "quickInput"
  | "iframes"
  | "auxWindows"
  | "dragFile"
  | "dragViews"
  | "fileDropTarget"
  | "tabDropTarget"
>;

/** Everything built before the screen's services (they are built from these). */
export type LogicServices = Omit<WorkbenchServices, keyof ScreenServices>;

/** What an entry chooses; the rest of the service set follows from it. */
export interface ServiceImplementations {
  /** The machine the screen is on (keys and their labels). */
  screenPlatform: Platform;
  /** The machine the backend is on (paths, shells, line endings). */
  backendPlatform: Platform;
  /** Whether there is a screen at all: without one, commands marked `needsScreen` are refused. */
  hasScreen: boolean;
  /** Built by the entry: the window reads its first-paint cache before anything else exists. */
  settings: SettingsService;
  theme: ThemeApi;
  /**
   * A person's answers for the permission policy: the destructive-command confirmation, an MCP
   * client's and an agent's requests, and whether a test script is running.
   */
  permissions: Pick<M2PolicyOptions, "confirm" | "askMcp" | "askAgent" | "testMode">;
  /** Where the saved state (global, and the open workspace's) is read and written. */
  stateBackend: StateBackend;
  /** Keeps one audit entry (the backend appends it to its log). */
  audit(entry: AuditEntry): Promise<void> | void;
  /** Check commands' outputs against their schemas (dev builds). */
  validateOutput: boolean;
  /** Built once (the window's needs its overlay host, which the entry makes). */
  notifications(): NotificationService;
  /** Whether a modal dialog has the keys now. */
  modalDialogOpen(): boolean;
  /** Workspace trust's questions. */
  trustPrompts: TrustPrompts;
  /** Runs a callback before the next paint; null: there are no frames. */
  nextFrame: ((run: () => void) => void) | null;
  /** The screen's own services, built from the logic ones (the window's workbench needs them). */
  screen(logic: LogicServices): ScreenServices;
}

/**
 * The whole service set. Nothing here starts work or touches the backend: extensions are
 * activated and a folder is opened by the entry, afterwards.
 */
export function createServices(impl: ServiceImplementations): WorkbenchServices {
  const { settings, theme } = impl;
  // `config.<setting>` in when clauses is the setting's value, as in VS Code (D262).
  const context = new ContextKeyService((key) =>
    key.startsWith("config.") ? (settings.peek<unknown>(key.slice(7)) as ContextValue) : undefined,
  );
  settings.model.onDidChange((keys) => context.changedOutside(keys.map((k) => `config.${k}`)));
  // Key bindings' `when` clauses read these: the keyboard's machine (as VS Code's, which are its
  // window's OS when the workspace is remote).
  context.setMany({
    isMac: impl.screenPlatform === "mac",
    isWindows: impl.screenPlatform === "windows",
    isLinux: impl.screenPlatform === "linux",
    isDev: __DEV__,
  });
  const events = new EventBus<IdeEvents>();
  const state = new StateTree();
  const layout = new LayoutModel();
  const views = new ViewRegistry();
  const dock = new DockService(new DockViewRegistry());
  const persistence = new PersistenceService(impl.stateBackend);
  const workspace = new WorkspaceService(context, persistence);

  const extensionGate: ExtensionGate = {
    authorize: async () => "deny",
    folders: () => [],
    enabledIds: signal<readonly string[]>([]),
  };
  const dispatcher = new Dispatcher({
    context,
    events,
    permissions: createM2Policy({
      ...impl.permissions,
      // Browser protection (D179): every page action asks, even ones declared without effects
      // (back, reload, scroll) and ones granted for the chat before it was turned on.
      agentAlwaysAsks: (request) =>
        request.commandId.startsWith("browser.") &&
        !(request.effects.length > 0 && request.effects.every((e) => e === "read")) &&
        settings.peek<boolean>("agent.browserProtection") === true,
      authorizeExtension: (request) => extensionGate.authorize(request),
    }),
    audit: impl.audit,
    validateOutput: impl.validateOutput,
    hasScreen: () => impl.hasScreen,
  });
  const notifications = impl.notifications();
  const keyboard = new KeyboardService(
    impl.screenPlatform,
    dispatcher,
    context,
    notifications,
    impl.modalDialogOpen,
  );

  /** The active editor's name, shown in the window title (set by the editor extension). */
  const titleDetail: Signal<string | null> = signal<string | null>(null);
  const logic: LogicServices = {
    hasScreen: impl.hasScreen,
    screenPlatform: impl.screenPlatform,
    backendPlatform: impl.backendPlatform,
    // One machine in the desktop app; a screenless set has only the backend's.
    platform: impl.hasScreen ? impl.screenPlatform : impl.backendPlatform,
    dispatcher,
    context,
    state,
    events,
    layout,
    views,
    notifications,
    keyboard,
    workspace,
    persistence,
    dock,
    theme,
    settings,
    contributions: new Contributions(),
    extensionGate,
    codeCheck: { newErrors: async () => null },
    languageModel: {
      model: () => null,
      generate: () => Promise.reject(new Error("No model is set up (see the agent panel).")),
    },
    trust: new WorkspaceTrust(workspace, persistence, context, impl.trustPrompts),
    titleDetail,
    decorations: new FileDecorationService(impl.nextFrame),
    quickDiff: new QuickDiffService(),
    languageClients: new LanguageClientRegistry(),
    viewers: new ViewerRegistry(),
    notebooks: new NotebookProviders(),
    documents: new DocumentTexts(),
    history: new OperationHistory(),
    problems: new ProblemCollections(),
    // Before the screen's services: the window's New tab lists extensions' tools (D181).
    extensionFeatures: new ExtensionFeatures(),
    taskTerminals: {
      run: () => Promise.reject(new Error("Terminals aren't available.")),
    },
    debugMarks: new DebugMarks(),
    gutterMarks: new GutterMarks(),
    gitAccess: new GitAccess(),
  };
  const screen = impl.screen(logic);
  effect(() => {
    context.set("quickInputVisible", screen.quickInput.visible.value);
    return undefined;
  });
  // User-run commands that fail surface as a notice (declined confirmations don't).
  events.on("command.executed", (e) => {
    if (e.caller.kind === "user" && e.error && e.status !== "denied")
      notifications.show("error", e.error);
  });
  const services: WorkbenchServices = { ...logic, ...screen };
  registerShellStatus(services);
  return services;
}

/** The status items that belong to no extension: the open folder and a pending key chord. */
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
