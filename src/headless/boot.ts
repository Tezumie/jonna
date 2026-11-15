// The screenless entry: the logic layer (dispatcher, state tree, settings, workspace, events, the
// extensions' logic) started without a window, in a runtime with no page. It follows the window's
// boot (main.ts) step for step and leaves out what paints: the same services from
// createServices with the screenless implementations, the same extension host, the same order
// (activate, load state and settings, open the folder). No command line and no agent wiring:
// those are built on top of the session this returns. DOM-free.
import {
  type ActivatedExtension,
  type BuiltinExtension,
  ExtensionHost,
} from "../core/extensions/index";
import { execIpc } from "../core/ipc/process";
import { appIpc, auditIpc } from "../core/ipc/system";
import type { Platform } from "../core/keybindings/index";
import { type Disposable, DisposableStore } from "../core/lifecycle/index";
import { effect } from "../core/reactive/index";
import { createServices } from "../workbench/createServices";
import type { WorkbenchServices } from "../workbench/services";
import { type HeadlessPolicy, type ScreenlessParts, screenlessImplementations } from "./services";

/**
 * Where backend calls go. `connect` makes the call layer (core/ipc) reach a backend, and the
 * disposable it returns disconnects it: a transport to a host process, or a fake in tests
 * (fakeBackend.ts). One connection per JavaScript realm: the call layer is module-level state.
 */
export interface HeadlessBackend {
  connect(): HeadlessConnection | Promise<HeadlessConnection>;
}

/** A connected backend. `dispose` disconnects at once; `close` first lets it shut down. */
export interface HeadlessConnection extends Disposable {
  /**
   * Ends the backend in order (a host process is asked to shut down and waited for), when the
   * connection owns one. The session's `dispose` awaits it before disconnecting.
   */
  close?(): Promise<void>;
}

export interface HeadlessBootOptions {
  backend: HeadlessBackend;
  /** The built-in extensions to activate, in order (extensions/builtins.ts has the list). */
  extensions: readonly BuiltinExtension<WorkbenchServices>[];
  /** The folder (or workspace file) the session is for; none: no folder is open. */
  folder?: string | null;
  /** Who answers questions with nobody at a screen; default: everything is declined. */
  policy?: HeadlessPolicy;
  /** The backend's OS, when the caller knows it; default: what the backend's app info says. */
  backendPlatform?: Platform;
  /**
   * Called with the services once they exist and before any extension activates: where an entry
   * sets what extensions read as they start (the agent's host, settings that hold for this run).
   */
  beforeActivate?(services: WorkbenchServices): void | Promise<void>;
}

/** A running screenless session. */
export interface HeadlessSession {
  /** The whole service set, as extensions get it (dispatcher, state, settings, workspace, events…). */
  readonly services: WorkbenchServices;
  /** The screenless services by their own types (the kept notifications, the questions asked…). */
  readonly screenless: ScreenlessParts;
  /** How each extension's activation went (`error` on the ones that failed). */
  readonly extensions: readonly ActivatedExtension[];
  /** The folder that opened, or null (none asked for, or it couldn't open: see `folderError`). */
  readonly folder: string | null;
  /** Why the folder didn't open, when it was asked for and didn't. */
  readonly folderError: string | null;
  /** Deactivates the extensions, disposes the services and disconnects the backend. */
  dispose(): Promise<void>;
}

/** The backend's OS name (Rust's `std::env::consts::OS`) as the IDE's platform. */
export function platformOf(os: string): Platform {
  return os === "windows" ? "windows" : os === "macos" ? "mac" : "linux";
}

/**
 * Starts a screenless session: connects the backend, builds the services, activates
 * `extensions`, loads the saved state and settings, and opens `folder`. An extension that fails
 * to activate doesn't stop the others (as in the window); its error is in `extensions`.
 */
export async function bootHeadless(options: HeadlessBootOptions): Promise<HeadlessSession> {
  const store = new DisposableStore();
  const connection = await options.backend.connect();
  try {
    // A session started: what an earlier one of this backend left running stops (D163).
    void execIpc.pageLoaded().catch(() => {});
    const info = await appIpc.info();
    const set = screenlessImplementations({
      backendPlatform: options.backendPlatform ?? platformOf(info.os),
      ...(options.policy && { policy: options.policy }),
      audit: (entry) => auditIpc.append(entry),
    });
    store.add({ dispose: set.dispose });
    const services = createServices(set.implementations);
    const { dispatcher, keyboard, settings, languageClients, persistence, workspace } = services;
    await options.beforeActivate?.(services);

    // ---- Extensions ---------------------------------------------------------
    const extensionHost = store.add(
      new ExtensionHost(services, (id: string) => dispatcher.has(id)),
    );
    keyboard.setRules(extensionHost.keybindings(options.extensions));
    for (const contributed of extensionHost.settings(options.extensions))
      settings.register(contributed);
    languageClients.contributed = extensionHost.languageServers(options.extensions);
    const extensions = await extensionHost.activateAll(options.extensions);

    // ---- Saved state and settings -------------------------------------------
    const global = await persistence.loadGlobal();
    workspace.recent.value = global.recentFolders ?? (global.lastFolder ? [global.lastFolder] : []);
    workspace.pinned.value = global.pinnedFolders ?? [];
    settings.attachWorkspace(workspace);
    await settings.load().catch((err: unknown) => console.warn("settings unavailable", err));
    store.add(workspace.onDidOpen(() => void settings.load().catch(() => {})));
    // A multi-root workspace (D251): folders added or removed bring their own settings, and the
    // workspace file's settings are its workspace layer.
    store.add(workspace.onDidChangeFolders(() => void settings.load().catch(() => {})));
    store.add(
      effect(() => {
        workspace.fileData.value;
        if (workspace.file.peek()) void settings.reload("workspace").catch(() => {});
        return undefined;
      }),
    );
    store.add(workspace.onDidClose(() => void workspace.refreshLists().catch(() => {})));

    // ---- The folder ---------------------------------------------------------
    let folder: string | null = null;
    let folderError: string | null = null;
    if (options.folder) {
      try {
        folder = await workspace.open(options.folder);
        if (folder === null) folderError = `${options.folder} was not opened.`;
      } catch (err) {
        folderError = err instanceof Error ? err.message : String(err);
      }
    }

    let disposed = false;
    return {
      services,
      screenless: set.parts,
      extensions,
      folder,
      folderError,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        // Extensions first (they use the services), then the services, then the connection.
        store.dispose();
        services.trust.dispose();
        services.keyboard.dispose();
        services.quickDiff.dispose();
        services.views.dispose();
        await connection.close?.().catch(() => {});
        connection.dispose();
      },
    };
  } catch (err) {
    store.dispose();
    connection.dispose();
    throw err;
  }
}
