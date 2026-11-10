// One running third-party extension (PLAN §9, D102): its declarative contributions, its commands,
// keybindings, settings and views, and (when it has code) its worker, whose every request is
// answered here after checking the permissions the user granted. Commands the extension runs go
// through the dispatcher as `caller: ext`, where the policy applies the same permissions.

import { matchesWhen } from "../../core/context/index";
import type { Caller } from "../../core/dispatcher/types";
import { Emitter } from "../../core/events/index";
import { commandCallerKind, commandInputSchema } from "../../core/extensions/commandInput";
import { toSettingSchemas } from "../../core/extensions/index";
import { missingBundledProgram } from "../../core/extensions/missingProgram";
import type { TreeItem } from "../../core/extensions/rpc";
import {
  canReadSetting,
  isBlockedSetting,
  matchesReadsSettings,
} from "../../core/extensions/settingsAccess";
import {
  activatesOn,
  type ContributedViewContainer,
  hasPermission,
  inClaimedNamespace,
  networkAllows,
  ownsStatePath,
  type ThirdPartyManifest,
} from "../../core/extensions/thirdParty";
import { treeItemMenu, treeMenuInput } from "../../core/extensions/treeMenus";
import {
  ANNOUNCE_VSCODE_COMMAND,
  RUN_VSCODE_COMMAND,
} from "../../core/extensions/vscode/commandIds";
import type { InstalledExtension } from "../../core/extensions/vscode/extensionRegistry";
import type { VscodeInit } from "../../core/extensions/vscode/index";
import { vscodeLanguageId } from "../../core/extensions/vscode/languageIds";
import { vscodeNotebookType } from "../../core/extensions/vscode/notebookEditors";
import { placeInContainer, resolveVscodeKeybindings } from "../../core/extensions/vscodePackage";
import { extIpc } from "../../core/ipc/extensions";
import { fsIpc } from "../../core/ipc/fs";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { dirname, joinPath } from "../../core/paths/index";
import { product } from "../../core/product";
import { effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { acceptsDefaultOverride } from "../../core/settings/schema";
import { imageIcon } from "../../ui/Icon";
import type { DockView } from "../../workbench/dock/views";
import { showDismissible } from "../../workbench/notices";
import type { IdeEvents, WorkbenchServices } from "../../workbench/services";
import { addDeclarative } from "./contributions";
import { nodeProgram } from "./nodeRuntime";
import { ExtensionApiHost, UNHANDLED } from "./runtimeApi";
import { CodePages } from "./runtimeCodePages";
import { EDITOR_EVENTS, type EditorEventType, ExtensionEditorEvents } from "./runtimeEditorEvents";
import { ExtensionEnvHost, findText, workspaceContains } from "./runtimeEnv";
import { ExtensionExtrasHost, WORKSPACE_EVENTS, type WorkspaceEventType } from "./runtimeExtras";
import { ExtensionFileDecorations } from "./runtimeFileDecorations";
import { ExtensionGitHost } from "./runtimeGit";
import { ExtensionHooksHost } from "./runtimeHooks";
import { ExtensionNotebooks } from "./runtimeNotebooks";
import { ExtensionOutputHost } from "./runtimeOutput";
import { ExtensionProcesses } from "./runtimeProcess";
import { ExtensionWorkbenchHost } from "./runtimeWorkbench";
import { ExtensionWorkspaceHost } from "./runtimeWorkspace";
import type { SharedNodeHost } from "./sharedHost";
import { ExtensionTreeView, safeIcon } from "./treeView";
import { closeTabsOf, registerViewers, setViewerDirty } from "./viewers";
import { WebviewFrame, withPageSetup } from "./webview";
import {
  ActivationFailed,
  ExtensionWorker,
  type HostTransport,
  type LogLine,
  nodeTransport,
} from "./workerHost";

/** `workspaceContains:` for a folder just added: checked again this often, this many times. */
/** 32 random hex digits. */
const randomId = (): string =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** This window's session id (`env.sessionId`, D255): one per page load. */
const SESSION_ID = randomId();

/**
 * `env.machineId` (D255): made once per installation and kept in the global state; random, not
 * derived from the machine.
 */
function envIds(services: WorkbenchServices): { machineId: string; sessionId: string } {
  let machineId = services.persistence.globalState().installationId;
  if (!machineId) {
    machineId = randomId();
    void services.persistence.saveGlobal({ installationId: machineId }).catch(() => {});
  }
  return { machineId, sessionId: SESSION_ID };
}

const ADDED_FOLDER_RECHECK_MS = 3000;
const ADDED_FOLDER_RECHECKS = 5;

/** `ide://` paths an extension may read, by the permission they need ("" = none). */
const STATE_PERMISSIONS: [prefix: string, permission: string][] = [
  ["ide://agent", "agent"],
  ["ide://browser", "browser"],
  ["ide://git", "git"],
  ["ide://terminals", "terminal"],
  ["ide://editors", "fs.read"],
  // Breakpoints and sessions for ide.debug (D255).
  ["ide://debug", "fs.read"],
  ["ide://diagnostics", "fs.read"],
  ["ide://history", "fs.read"],
  ["ide://search", "fs.read"],
  ["ide://workspace", "fs.read"],
  ["ide://layout", ""],
  ["ide://settings", ""],
  ["ide://keybindings", ""],
  ["ide://notifications", ""],
  ["ide://lsp", ""],
  ["ide://mcp", ""],
  ["ide://extensions", ""],
];

/** Events an extension may subscribe to (all are about files: they need fs.read). */
const EVENTS: readonly (keyof IdeEvents)[] = [
  "files.didCreate",
  "files.didRename",
  "files.didDelete",
  "files.didSave",
  "files.didChange",
  "documents.didOpen",
  "documents.didClose",
  // Notebooks in the notebook editor (D204).
  "notebook.didOpen",
  "notebook.didChange",
  "notebook.didSave",
  "notebook.didClose",
  "notebook.didRunCell",
  // The debugger's sessions and breakpoints (D255).
  "debug.didStartSession",
  "debug.didTerminateSession",
  "debug.didChangeActiveSession",
  "debug.didChangeBreakpoints",
  "debug.didReceiveCustomEvent",
  "debug.didChangeActiveStackItem",
];

export interface RuntimeHost {
  services: WorkbenchServices;
  granted(): readonly string[];
  /** It comes with the IDE (installed as shipped, not a development or customized copy). */
  bundled?: boolean;
  log(line: LogLine): void;
  /** A development copy (loaded unpacked): VS Code's ExtensionMode.Development (D295). */
  dev?: boolean;
  /** The worker died after starting. */
  crashed(error: string): void;
  /** Its code couldn't start, or its activate threw (D295: shown in the Extensions view). */
  failed?(error: string): void;
  /** Its code activated. */
  activated?(): void;
  /**
   * Before its code starts (D295): its extensionDependencies activate first; throws VS Code's
   * message when one is missing or fails.
   */
  beforeActivate?(): Promise<void>;
  /** The shared Node host every VS Code package runs in (D295). */
  sharedHost?: SharedNodeHost;
  /** The VS Code packages installed and enabled, its `vscode.extensions` (D295). */
  others?(): InstalledExtension[];
  /** An activation event happened (D295: remembered for extensions enabled later). */
  fired?(event: string): void;
  /** Its `vscode.extensions.getExtension(id).activate()`: activates another one (D295). */
  activateOther?(id: string): Promise<void>;
  /** Another extension's VS Code command (VS Code's one registry), or undefined. */
  vscodeCommand?(
    id: string,
    args: unknown[],
  ): { command: string; input: unknown } | { run(): Promise<unknown> } | undefined;
  /** It registered the VS Code command `id` in code only. */
  announceVscodeCommand?(id: string): void;
  /** Another enabled VS Code package's view container with this id (for views placed in it). */
  viewContainer?(id: string): ContributedViewContainer | undefined;
}

export class ExtensionRuntime implements Disposable {
  /** stop() has begun: nothing starts the worker again (D261). */
  private stopping = false;
  /** The worker while it activates (not yet `worker`), so stopping disposes it too. */
  private startingWorker: ExtensionWorker | null = null;
  /** This run of the extension: viewer tabs' saved page state is keyed by it (D263). */
  private readonly pageStamp = Date.now().toString(36);
  private readonly store = new DisposableStore();
  private worker: ExtensionWorker | null = null;
  private starting: Promise<ExtensionWorker> | null = null;
  /**
   * A stop of its code still finishing (D285): a start waits for it, or the old worker's
   * clean-up (`workerGone`: its status items, context keys, processes) would undo the new one's.
   */
  private stoppingCode: Promise<void> | null = null;
  /** Counts stops of its code: a start that a stop overtook gives up (D285). */
  private codeGeneration = 0;
  /** `codeGeneration` when `starting` began. */
  private startingGeneration = 0;
  private readonly handlers = new Set<string>();
  /**
   * Its declared commands whose id the IDE (or an earlier extension) has: not registered, so
   * they don't replace the IDE's for everyone; its own keys for them still run its code.
   */
  private readonly collided = new Set<string>();
  private readonly trees = new Map<string, ExtensionTreeView[]>();
  private readonly treeProviders = new Set<string>();
  /** Views whose title or description its code set (cleared when it stops). */
  private readonly viewTitles = new Set<string>();
  /** view id → the message its trees show above the rows (D208). */
  private readonly treeMessages = new Map<string, string>();
  private readonly webviews = new Map<string, WebviewFrame[]>();
  /** Language configurations its code set (D258). */
  private readonly languageConfigs = new Map<string, Disposable>();
  /** Pages its code writes for webview views and viewers (D257). */
  private readonly codePages: CodePages;
  /** A code-page viewer's open tabs: instance → its frame (D257). */
  private readonly viewerTabs = new Map<number, WebviewFrame>();
  private viewerTabSeq = 0;
  private readonly events = new Map<string, Disposable>();
  private storage: Record<string, unknown> | null = null;
  private storageTimer = 0;
  private settingsWatch: Disposable | null = null;
  private proxyOrigin: Promise<string> | null = null;
  readonly caller: Caller;
  readonly warnings: string[] = [];
  /** Status bar, editor, languages, windows and the declarative extras (D176). */
  private readonly api: ExtensionApiHost;
  /** Its notebook types and kernel sources (D202). */
  private readonly notebooks: ExtensionNotebooks;
  /** Trust, folder events, context keys, dialogs, state paths (D202). */
  private readonly extras: ExtensionExtrasHost;
  /** Programs it runs (D202). */
  private readonly processes: ExtensionProcesses;
  /** Read-only git, GitHub notifications, line annotations (D208). */
  private readonly git: ExtensionGitHost;
  /** Its own Output channels (`ide.ui.createOutputChannel`). */
  private readonly outputs: ExtensionOutputHost;
  /** It ships with the IDE (installed as shipped): may use the namespaces its manifest claims. */
  private readonly shipped: boolean;
  /** Terminals, tasks, source control, debug adapters, sign-ins, file systems (D233). */
  private readonly workbench: ExtensionWorkbenchHost;
  /** The active editor's events (D234). */
  private readonly editorEvents: ExtensionEditorEvents;
  /** `ide.env` and findFiles (D234). */
  private readonly env: ExtensionEnvHost;
  /** `type`, URIs, applyEdit, will-save, comments, `lm` and chat (runtimeHooks.ts). */
  private readonly hooks: ExtensionHooksHost;
  /** File decorations from its code (D258). */
  private readonly fileDecorations: ExtensionFileDecorations;
  /** The workspace's folders: the path gate, the worker's mirror, workspaceState (D251). */
  private readonly workspace: ExtensionWorkspaceHost;

  constructor(
    readonly manifest: ThirdPartyManifest,
    readonly root: string,
    private readonly host: RuntimeHost,
  ) {
    this.caller = { kind: "ext", id: manifest.id };
    this.codePages = new CodePages(root);
    this.shipped = host.bundled === true && manifest.id.startsWith("bundled.");
    this.workspace = new ExtensionWorkspaceHost({
      services: host.services,
      displayName: manifest.displayName,
      granted: () => host.granted(),
      need: (permission, what) => this.need(permission, what),
    });
    this.git = new ExtensionGitHost({
      manifest,
      services: host.services,
      need: (permission, what) => this.need(permission, what),
      workspacePath: (path) => this.workspacePath(path),
    });
    this.api = new ExtensionApiHost({
      manifest,
      services: host.services,
      caller: this.caller,
      need: (permission, what) => this.need(permission, what),
      workspacePath: (path) => this.workspacePath(path),
      writablePath: (path) => this.writablePath(path),
      worker: () => this.ensureWorker(),
      revealView: (viewId) => this.revealView(this.ownView(viewId)),
    });
    this.notebooks = new ExtensionNotebooks({
      services: host.services,
      extensionId: manifest.id,
      displayName: manifest.displayName,
      notebooks: manifest.contributes.notebooks,
      renderers: manifest.contributes.notebookRenderers,
      root,
      granted: () => host.granted(),
      commands: manifest.contributes.commands.map((c) => c.id),
      need: (permission, what) => this.need(permission, what),
      worker: () => this.ensureWorker(),
      warn: (m) => {
        this.warnings.push(m);
        this.host.log({ time: Date.now(), level: "warn", text: m });
      },
    });
    this.extras = new ExtensionExtrasHost({
      manifest,
      services: host.services,
      granted: () => host.granted(),
      bundled: host.bundled === true && manifest.id.startsWith("bundled."),
      worker: () => this.worker,
    });
    this.outputs = new ExtensionOutputHost({
      extensionId: manifest.id,
      services: host.services,
      caller: this.caller,
    });
    this.processes = new ExtensionProcesses({
      manifest,
      services: host.services,
      root,
      need: (permission, what) => this.need(permission, what),
      post: (id, batch) => this.worker?.notify("process", id, batch),
      shipped: host.bundled === true && manifest.id.startsWith("bundled."),
    });
    this.editorEvents = new ExtensionEditorEvents(host.services);
    this.env = new ExtensionEnvHost({
      services: host.services,
      need: (permission, what) => this.need(permission, what),
    });
    this.hooks = new ExtensionHooksHost({
      manifest,
      services: host.services,
      caller: this.caller,
      need: (permission, what) => this.need(permission, what),
      granted: () => host.granted(),
      workspacePath: (path) => this.workspacePath(path),
      writablePath: (path) => this.writablePath(path),
      worker: () => this.ensureWorker(),
      running: () => this.worker,
    });
    this.fileDecorations = new ExtensionFileDecorations({
      services: host.services,
      running: () => this.worker,
      need: (permission, what) => this.need(permission, what),
    });
    this.workbench = new ExtensionWorkbenchHost({
      manifest,
      services: host.services,
      caller: this.caller,
      need: (permission, what) => this.need(permission, what),
      granted: (permission) => hasPermission(host.granted(), permission),
      workspacePath: (path) => this.workspacePath(path),
      worker: () => this.ensureWorker(),
      running: () => this.worker,
      image: (path) => this.treeImage(path),
      warn: (m) => {
        this.warnings.push(m);
        this.host.log({ time: Date.now(), level: "warn", text: m });
      },
      root,
      origin: () => this.origin(),
      allowRoots: (roots) => {
        const before = this.declaredRoots.size;
        for (const r of roots) if (this.declaredRoots.size < 50) this.declaredRoots.add(r);
        if (this.declaredRoots.size !== before) this.syncRoots();
      },
    });
  }

  private get services(): WorkbenchServices {
    return this.host.services;
  }

  /** Adds the contributions; starts the worker now if it activates at startup. */
  async activate(): Promise<void> {
    const { manifest } = this;
    const warn = (m: string) => {
      this.warnings.push(m);
      this.host.log({ time: Date.now(), level: "warn", text: m });
    };
    this.store.add(await addDeclarative(manifest, this.root, this.services.contributions, warn));
    const c = manifest.contributes;
    // Names in a claimed built-in namespace ("git.…", D208) only for the IDE's own extensions.
    const allowed = (name: string, what: string) => {
      if (this.shipped || !inClaimedNamespace(manifest, name)) return true;
      warn(`${what} ${name} skipped: only extensions that come with the IDE may use that name.`);
      return false;
    };
    // What its package.json declares that the IDE leaves out (reserved names, refused areas).
    for (const text of manifest.warnings ?? []) warn(text);
    this.registerSettings(warn);
    // The log levels the user picks ("Set log level…") reach its code as they change (VS Code's
    // onDidChangeLogLevel); its log channels leave that list when it goes.
    let firstLevels = true;
    this.store.add(
      effect(() => {
        const levels = this.outputs.levels();
        if (firstLevels) firstLevels = false;
        else this.worker?.notify("provider", "logLevels", levels);
        return undefined;
      }),
    );
    this.store.add(toDisposable(() => this.outputs.workerGone()));
    for (const cmd of c.commands) if (allowed(cmd.id, "Command")) this.registerCommand(cmd);
    this.registerKeybindings(warn);
    // The empty page a code-written view or viewer shows until its code sets one (D257).
    if (c.views.some((v) => v.codePage) || c.viewers.some((v) => v.codePage))
      await this.codePages.ready();
    for (const view of c.views) if (allowed(view.id, "View")) this.registerView(view);
    // Menu items' own icon files (VS Code's command icons), read before they're added (D262).
    const images = new Map<string, string>();
    await Promise.all(
      [...new Set(c.menus.flatMap((m) => [m.iconPath, m.iconPathDark]))]
        .filter((p): p is string => !!p)
        .slice(0, 50)
        .map(async (p) => {
          const url = await this.treeImage(p);
          if (url) images.set(p, url);
        }),
    );
    if (this.store.isDisposed) return;
    this.api.contribute(images);
    this.notebooks.contribute();
    this.workbench.contribute();
    this.hooks.contribute();
    // File viewers (custom editors): pages that open files, beside the text editor (D176).
    if (c.viewers.length)
      this.store.add(
        registerViewers(this.services, manifest, {
          origin: () => this.origin(),
          granted: () => this.host.granted(),
          workspacePath: (path) => this.workspacePath(path),
          blankPage: () => this.codePages.path(""),
          opened: (viewerId, frame) => {
            if (manifest.main) void this.ensureWorker().catch(() => {});
            this.add(this.webviews, viewerId, frame);
            const instance = ++this.viewerTabSeq;
            this.viewerTabs.set(instance, frame);
            return {
              instance,
              dispose: () => {
                this.remove(this.webviews, viewerId, frame);
                this.viewerTabs.delete(instance);
                this.codePages.drop(`viewer#${instance}`);
              },
            };
          },
          receive: (viewerId, message) => {
            // A closing tab's notice doesn't start a worker that has stopped (or never ran);
            // an opening one does, like the page's own messages.
            const notice =
              typeof message === "object" && message !== null
                ? (message as { ide?: unknown }).ide
                : undefined;
            if (notice === "viewerClosed") {
              if (this.worker && !this.store.isDisposed)
                this.worker.notify("webview", viewerId, message);
              return;
            }
            void this.ensureWorker().then((w) => w.notify("webview", viewerId, message));
          },
        }),
      );
    // "*" and onStartup start later, in the background (D295, `startIfDue`): every extension's
    // contributions are in first, as VS Code registers them all before activating any.
    // After the IDE has settled (VS Code's onStartupFinished): no hurry at startup.
    if (manifest.main && manifest.activation.includes("onStartupFinished")) {
      const timer = window.setTimeout(() => void this.ensureWorker().catch(() => {}), 2000);
      this.store.add(toDisposable(() => window.clearTimeout(timer)));
    }
    // When the open folder has a file ("workspaceContains:package.json", "…:**/*.csproj").
    const contains = manifest.activation
      .filter((a) => a.startsWith("workspaceContains:"))
      .map((a) => a.slice("workspaceContains:".length));
    if (manifest.main && contains.length) {
      const timers = new Set<number>();
      this.store.add(
        toDisposable(() => {
          for (const t of timers) window.clearTimeout(t);
        }),
      );
      const check = (folders?: readonly string[], retries = 0): void =>
        void workspaceContains(this.services, contains, folders).then((yes) => {
          if (this.store.isDisposed || this.worker) return;
          if (yes) {
            void this.ensureWorker().catch(() => {});
            return;
          }
          // A folder just added isn't in the file index yet (a glob is matched there): look
          // again a few times while it's scanned, as long as the folder stays.
          const left = folders?.filter((f) => this.services.workspace.folderOf(f)) ?? [];
          if (!left.length || retries <= 0) return;
          const timer = window.setTimeout(() => {
            timers.delete(timer);
            check(left, retries - 1);
          }, ADDED_FOLDER_RECHECK_MS);
          timers.add(timer);
        });
      check();
      // A folder added to the workspace may have it (D251).
      this.store.add(
        this.services.workspace.onDidChangeFolders(({ added }) => {
          if (!this.worker && added.length)
            check(
              added.map((f) => f.path),
              ADDED_FOLDER_RECHECKS,
            );
        }),
      );
    }
    // A file of a scheme it serves is opened (a restored tab, D234: VS Code's onFileSystem).
    if (manifest.main && manifest.activation.some((a) => a.startsWith("onFileSystem:")))
      this.store.add(
        this.services.extensionFeatures.fileSystems.onWillNeedScheme((scheme) => {
          if (manifest.activation.includes(`onFileSystem:${scheme}`))
            void this.ensureWorker().catch(() => {});
        }),
      );
    // D255: a notebook of its type opens (VS Code's onNotebook), a debug session starts (onDebug).
    if (manifest.main && manifest.activation.some((a) => a.startsWith("onNotebook:")))
      this.store.add(
        this.services.events.on("notebook.didOpen", ({ notebookType }) => {
          // A VS Code package names Jupyter's type as VS Code does ("jupyter-notebook").
          if (
            manifest.activation.includes(`onNotebook:${notebookType}`) ||
            manifest.activation.includes(`onNotebook:${vscodeNotebookType(notebookType)}`) ||
            manifest.activation.includes("onNotebook:*")
          )
            void this.ensureWorker().catch(() => {});
        }),
      );
    if (manifest.main && manifest.activation.includes("onDebug"))
      this.store.add(
        this.services.events.on("debug.didStartSession", () => {
          void this.ensureWorker().catch(() => {});
        }),
      );
    if (manifest.main && manifest.activation.some((a) => a.startsWith("onLanguage:"))) {
      this.store.add(
        this.services.events.on("documents.didOpen", ({ languageId }) => {
          // VS Code's name for it too ("tsx" is "onLanguage:typescriptreact").
          if (
            manifest.activation.includes(`onLanguage:${languageId}`) ||
            manifest.activation.includes(`onLanguage:${vscodeLanguageId(languageId)}`)
          )
            void this.ensureWorker().catch(() => {});
        }),
      );
      // Documents open already (restored tabs, an extension installed or enabled while one is
      // open): VS Code activates for those too.
      void this.services.state
        .get("ide://editors")
        .then((snap) => {
          const docs =
            (snap?.value as { documents?: { language: string; kind: string }[] } | null)
              ?.documents ?? [];
          if (
            !this.store.isDisposed &&
            docs.some(
              (d) =>
                d.kind === "text" &&
                (manifest.activation.includes(`onLanguage:${d.language}`) ||
                  manifest.activation.includes(`onLanguage:${vscodeLanguageId(d.language)}`)),
            )
          )
            void this.ensureWorker().catch(() => {});
        })
        .catch(() => {});
    }
  }

  get running(): boolean {
    return this.worker !== null;
  }

  get log(): readonly LogLine[] {
    return this.worker?.log ?? [];
  }

  /** The worker, started on first use (activation events). */
  ensureWorker(): Promise<ExtensionWorker> {
    if (this.worker) return Promise.resolve(this.worker);
    // Stopped or stopping (disabled, reloaded, uninstalled): a page still open, a command or an
    // activation event mustn't start it again (D261: it would outlive the runtime).
    if (this.store.isDisposed || this.stopping)
      return Promise.reject(new Error(`${this.manifest.displayName} has stopped.`));
    if (!this.manifest.main)
      return Promise.reject(new Error(`${this.manifest.displayName} has no code to run.`));
    // Refused for its dependencies (D295): not tried again on every event, as in VS Code, until
    // what it depends on changes (the manager clears it).
    if (this.refused) return Promise.reject(new Error(this.refused));
    // A start still under way is shared, unless a stop overtook it (D285): that one ends in
    // "stopped", and a resume right after the stop (the folder's trust flipping as it opens)
    // used to be handed it, so nothing started again ("Not started yet").
    if (this.starting && this.startingGeneration === this.codeGeneration) return this.starting;
    if (this.starting)
      return this.starting.then(
        () => this.ensureWorker(),
        () => this.ensureWorker(),
      );
    const main = this.manifest.main;
    const generation = this.codeGeneration;
    this.startingGeneration = generation;
    const overtaken = () =>
      this.store.isDisposed || this.stopping || generation !== this.codeGeneration;
    this.starting = (async () => {
      // The folder opened, closed or changed trust a moment ago: the old code finishes stopping
      // first (D285: Claude Code's icon and status item, Live Server "failed").
      if (this.stoppingCode) await this.stoppingCode;
      if (overtaken()) throw new Error("stopped");
      // Its extensionDependencies first (D295, VS Code's activator): one that's missing or whose
      // activation fails refuses this one, with VS Code's message.
      if (this.host.beforeActivate)
        try {
          await this.host.beforeActivate();
        } catch (err) {
          if (overtaken()) throw new Error("stopped");
          this.refused = err instanceof Error ? err.message : String(err);
          throw err;
        }
      if (overtaken()) throw new Error("stopped");
      // `"host": "node"` (D255): Node, with the "node" permission, in a trusted folder (its code
      // can run programs and read files like any program). Every VS Code package shares one
      // Node process (D295); an extension of the IDE's format gets one of its own.
      const inNode = this.manifest.host === "node";
      const vscode = inNode && this.manifest.format === "vscode";
      let transport: HostTransport | undefined;
      if (inNode) {
        this.need("node", "run its code in Node.js");
        await this.services.trust.require(`${this.manifest.displayName} (runs in Node.js)`);
        if (overtaken()) throw new Error("stopped");
        // No Node on this computer: the pinned one, downloaded when the user agrees (D267).
        const program = await nodeProgram(this.services);
        if (overtaken()) throw new Error("stopped");
        const shared = vscode ? this.host.sharedHost : undefined;
        transport = shared
          ? await shared.connect(this.manifest.id, program, this.root)
          : await nodeTransport(
              this.manifest.id,
              this.root,
              (line) => this.host.log({ time: Date.now(), level: "warn", text: line }),
              program,
            );
        if (overtaken()) {
          void transport.terminate();
          throw new Error("stopped");
        }
      }
      const code = inNode ? "" : await extIpc.readText(this.root, main);
      if (overtaken()) throw new Error("stopped");
      const worker = new ExtensionWorker(
        this.manifest.id,
        (method, params) => this.request(method, params),
        (line) => this.host.log(line),
        (error) => {
          // An old worker's end (stopped, then replaced) isn't the running one's (D285).
          if (this.worker !== worker && this.startingWorker !== worker) return;
          this.worker?.dispose();
          this.worker = null;
          this.activationError = null;
          this.workerGone();
          this.host.crashed(error);
        },
        transport,
      );
      // Stopping while it activates disposes it (D261).
      this.startingWorker = worker;
      // The folders as they are now: the worker's mirror (VS Code's workspaceFolders, D251).
      const workspace = this.workspace.snapshot();
      let failed: string | null = null;
      try {
        const started = worker.start({
          manifest: {
            id: this.manifest.id,
            version: this.manifest.version,
            displayName: this.manifest.displayName,
            path: this.root,
            platform:
              this.services.platform === "mac"
                ? "macos"
                : this.services.platform === "windows"
                  ? "windows"
                  : "linux",
            appName: product.nameShort,
            uriScheme: product.urlScheme,
            themeKind: this.services.theme.theme.peek(),
            ...envIds(this.services),
            language: navigator.language || "en",
            ...(workspace && { workspace }),
          },
          code,
          filename: `${this.manifest.id}/${main}`,
          ...(inNode && { file: joinPath(this.root, main) }),
          ...(vscode && { vscode: this.vscodeInit() }),
        });
        // Changes while it activates reach it too (the start message went first).
        this.workspace.attach(worker, workspace);
        await started;
      } catch (err) {
        // Its activate threw (D295, VS Code's): what it registered stays, it's marked failed and
        // isn't activated again this session. Anything else (it didn't start) ends the worker.
        if (err instanceof ActivationFailed && !overtaken()) failed = err.message;
        else {
          this.workspace.detach();
          worker.dispose();
          throw err;
        }
      } finally {
        if (this.startingWorker === worker) this.startingWorker = null;
      }
      if (overtaken()) {
        this.workspace.detach();
        worker.dispose();
        throw new Error("stopped");
      }
      this.worker = worker;
      this.activationError = failed;
      if (failed) this.host.failed?.(`Activating failed: ${failed}`);
      else this.host.activated?.();
      return worker;
    })();
    const starting = this.starting;
    starting
      .catch((err: unknown) => {
        // Seen in the Extensions view, whatever event started it (D295); a stop isn't a failure.
        if (overtaken()) return;
        const text = err instanceof Error ? err.message : String(err);
        if (text !== "stopped") this.host.failed?.(text);
      })
      .finally(() => {
        if (this.starting === starting) this.starting = null;
      });
    return starting;
  }

  /** Why its dependencies refused it (D295), until they change. */
  private refused: string | null = null;
  /** Its `activate` threw (D295): the error, while the worker keeps what it registered. */
  activationError: string | null = null;

  /** What it depends on changed (installed, enabled): a refused activation may run now. */
  clearRefusal(): void {
    this.refused = null;
  }

  /**
   * Starts its code now if it activates at startup ("*", onStartup) or one of its activation
   * events already fired this session (D295, `fired`): after its contributions were added, and
   * again once the folder is trusted.
   */
  startIfDue(fired?: (activation: readonly string[]) => boolean): void {
    const { manifest } = this;
    if (this.worker || this.starting || !manifest.main || this.refused) return;
    if (activatesOn(manifest, "onStartup") || fired?.(manifest.activation))
      void this.ensureWorker().catch(() => {});
  }
  /** Its code stopped (crashed, or stopCode): what the worker registered goes with it. */
  private workerGone(): void {
    this.workspace.detach();
    // Nothing would read its processes' output or answer for its state any more.
    this.processes.killAll(true);
    this.extras.workerGone();
    this.notebooks.workerGone();
    this.workbench.workerGone();
    this.hooks.workerGone();
    this.fileDecorations.workerGone();
    for (const d of this.languageConfigs.values()) d.dispose();
    this.languageConfigs.clear();
    this.outputs.workerGone();
    // Titles its code set go with it (the manifest's show again).
    for (const viewId of this.viewTitles) this.services.views.titles.set(viewId, {});
  }

  /**
   * Stops its code but keeps the extension (its themes, views, settings): the folder stopped
   * being trusted (D261). Its next use starts the code again, which asks for trust first.
   */
  stopCode(): Promise<void> {
    const worker = this.worker;
    const starting = this.startingWorker;
    this.worker = null;
    this.activationError = null;
    this.codeGeneration++;
    starting?.dispose();
    // A stop already under way finishes first (D293): otherwise its workerGone() could run after
    // a new worker started, tearing that one's mirror and context keys down.
    const previous = this.stoppingCode;
    const done = (async () => {
      await previous;
      if (worker) {
        await worker.stop();
        this.workerGone();
      }
      await Promise.all([worker?.exited, starting?.exited]);
    })();
    const tracked: Promise<void> = done
      .catch(() => {})
      .finally(() => {
        if (this.stoppingCode === tracked) this.stoppingCode = null;
      });
    this.stoppingCode = tracked;
    return done;
  }

  /**
   * The folder became trusted after its code was stopped for not being trusted (D273): what
   * starts with the IDE starts again, as VS Code activates it once a folder is trusted, and so
   * does one whose activation events fired meanwhile (D295, `fired`). Without this, an extension
   * whose views wait for its own context keys (Claude Code's activity bar icon) stayed gone until
   * something used it.
   */
  resumeStartupCode(fired?: (activation: readonly string[]) => boolean): void {
    const { manifest } = this;
    if (this.worker || !manifest.main) return;
    if (manifest.activation.includes("onStartupFinished")) void this.ensureWorker().catch(() => {});
    else this.startIfDue(fired);
  }

  /** What the Node host's `vscode` shim needs of a VS Code package (D256). */
  private vscodeInit(): VscodeInit {
    const c = this.manifest.contributes;
    return {
      commands: c.commands.map((cmd) => ({
        id: cmd.id,
        ...(cmd.vscodeId && { vscodeId: cmd.vscodeId }),
        ...(cmd.vscodeTool && { tool: cmd.vscodeTool, description: cmd.description ?? "" }),
        ...(cmd.vscodeTool && cmd.input && { inputSchema: cmd.input }),
      })),
      shimCommand: c.commands.find((cmd) => cmd.id.endsWith(".runVscodeCommand"))?.id ?? "",
      settings: Object.keys(c.settings),
      others: this.host.others?.() ?? [],
      ...(this.host.dev && { dev: true }),
    };
  }

  /**
   * `vscode.commands.executeCommand` of a command that isn't its own (VS Code's one registry):
   * another extension's (declared: run as this extension, with the usual permission checks; in
   * code only: its worker runs it), else the IDE's by that id with the first argument as input.
   */
  private runVscodeCommand(prefixed: string, input: unknown): Promise<unknown> {
    const id = prefixed.slice(RUN_VSCODE_COMMAND.length);
    const raw = (input as { arguments?: unknown } | null)?.arguments;
    const args = Array.isArray(raw) ? raw : [];
    const target = this.host.vscodeCommand?.(id, args);
    if (target && "command" in target)
      return this.services.dispatcher.execute(target.command, target.input as object, this.caller);
    if (target) return target.run();
    if (this.services.dispatcher.has(id)) {
      const first = args[0];
      return this.services.dispatcher.execute(
        id,
        first && typeof first === "object" && !Array.isArray(first) ? first : {},
        this.caller,
      );
    }
    return Promise.reject(new Error(`command '${id}' not found`));
  }

  /** Runs a VS Code command its code registered (another extension asked, by its VS Code id). */
  async runCodeCommand(id: string, args: unknown[]): Promise<unknown> {
    const shim = this.manifest.contributes.commands.find((c) => c.id.endsWith(".runVscodeCommand"));
    if (!this.worker || !shim || !this.handlers.has(shim.id))
      throw new Error(`command '${id}' not found`);
    return this.worker.call(
      "command",
      shim.id,
      { id, arguments: args },
      { caller: "extension" },
      0,
    );
  }

  // ---- Contributions ---------------------------------------------------------------------------

  /**
   * Its settings and its defaults for others (VS Code's `configurationDefaults`). A setting the
   * IDE or another extension declared already is shared, as in VS Code: the first declaration
   * (and its default) stays, and both extensions may change it (python.defaultInterpreterPath,
   * the IDE's and ms-python's).
   */
  private registerSettings(warn: (text: string) => void): void {
    const { manifest } = this;
    const c = manifest.contributes;
    const registry = this.services.settings.registry;
    const settings = Object.fromEntries(
      Object.entries(c.settings).filter(([key, setting]) => {
        if (!this.shipped && inClaimedNamespace(manifest, key)) {
          warn(`Setting ${key} skipped: only extensions that come with the IDE may use that name.`);
          return false;
        }
        const existing = registry.get(key);
        if (!existing) return true;
        if (existing.extension === manifest.id) return false;
        const differs = JSON.stringify(existing.default) !== JSON.stringify(setting.default);
        warn(
          `Setting ${key} is declared already (by ${existing.extension ?? "the IDE"}): it's shared${
            differs ? `, with that declaration's default (${JSON.stringify(existing.default)})` : ""
          }.`,
        );
        // Only a VS Code package shares another's setting (an extension of the IDE's own format
        // can't declare one outside its names).
        if (manifest.format === "vscode")
          this.store.add(toDisposable(registry.addOwner(key, manifest.id)));
        return false;
      }),
    );
    if (Object.keys(settings).length)
      this.store.add(this.services.settings.register(toSettingSchemas(manifest.id, settings)));
    const defaults = c.configurationDefaults;
    if (!defaults) return;
    // VS Code's rule: no defaults for machine-wide settings (here: user-only and restricted ones,
    // which start programs), nor for the areas that hold credentials.
    const takes = (key: string, where = "") => {
      const schema = registry.get(key);
      const refused =
        isBlockedSetting(key) || (schema !== undefined && !acceptsDefaultOverride(schema));
      if (refused)
        warn(
          `Default for ${key}${where} skipped: only defaults for window, resource and language settings are taken (not ones that start programs or hold credentials).`,
        );
      return !refused;
    };
    const accepted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(defaults)) {
      if (!/^\s*\[/.test(key)) {
        if (takes(key)) accepted[key] = value;
        continue;
      }
      // A language block: the same rule for each of its settings.
      const block = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([inner]) =>
          takes(inner, ` in ${key}`),
        ),
      );
      if (Object.keys(block).length) accepted[key] = block;
    }
    if (Object.keys(accepted).length)
      this.store.add(this.services.settings.registerDefaults(manifest.id, accepted));
  }

  /**
   * Its keybindings, VS Code's way (vscodePackage.ts `resolveVscodeKeybindings`): a command it
   * doesn't declare is VS Code's own, the IDE's, another extension's or one its code registers.
   */
  private registerKeybindings(warn: (text: string) => void): void {
    const c = this.manifest.contributes;
    if (!c.keybindings.length) return;
    const shim =
      this.manifest.main && this.manifest.format === "vscode"
        ? c.commands.find((cmd) => cmd.id.endsWith(".runVscodeCommand"))?.id
        : undefined;
    // A key for one of its commands the IDE's id took: its code's handler, by VS Code's id.
    const rules = c.keybindings.map((rule) => {
      const cmd = c.commands.find((x) => x.id === rule.command && this.collided.has(x.id));
      if (!cmd || !shim || rule.vscodeCommand) return rule;
      const { args, ...rest } = rule;
      return {
        ...rest,
        command: shim,
        args: {
          id: cmd.vscodeId ?? cmd.id,
          arguments: args === undefined ? [] : [args],
          resolve: true,
        },
      };
    });
    const resolved = resolveVscodeKeybindings(rules, {
      has: (id) => this.services.dispatcher.has(id),
      declaredElsewhere: (id) => {
        const target = this.host.vscodeCommand?.(id, []);
        return target && "command" in target ? target.command : undefined;
      },
      ...(shim && { shim }),
    });
    for (const text of resolved.warnings.slice(0, 20)) warn(text);
    if (resolved.warnings.length > 20)
      warn(`${resolved.warnings.length - 20} more keybindings skipped.`);
    if (resolved.rules.length) this.store.add(this.services.keyboard.addRules(resolved.rules));
  }

  private registerCommand(cmd: ThirdPartyManifest["contributes"]["commands"][number]): void {
    // Its input schema (D202): agents see it, the dispatcher checks input against it.
    // A command in a tree row's menu is run with `{ item }`: its schema takes it.
    const { schema, error } = commandInputSchema(cmd.input, {
      treeItem: this.manifest.contributes.menus.some(
        (m) => m.location === "view/item/context" && m.command === cmd.id,
      ),
    });
    if (error) {
      const text = `${cmd.id}: input schema ignored (${error}).`;
      this.warnings.push(text);
      this.host.log({ time: Date.now(), level: "warn", text });
    }
    let registration: Disposable;
    try {
      registration = this.services.dispatcher.register({
        id: cmd.id,
        title: cmd.title,
        category: cmd.category ?? this.manifest.displayName,
        description:
          cmd.description ?? `${cmd.title} (from the ${this.manifest.displayName} extension).`,
        input: schema,
        effects: cmd.effects ?? [],
        agent: cmd.agent ?? "discoverable",
        ...(cmd.palette === false && { palette: false }),
        ...(cmd.when && { when: cmd.when }),
        run: async (input, ctx) => {
          // VS Code's onCommand event, remembered for extensions enabled later (D295).
          this.host.fired?.(`onCommand:${cmd.vscodeId ?? cmd.id}`);
          const worker = await this.ensureWorker();
          if (!this.handlers.has(cmd.id))
            throw new Error(`${this.manifest.displayName} didn't register ${cmd.id}.`);
          // As in VS Code, a command runs as long as it takes (exporting, building, a long
          // notebook run); calls for views, hovers and the like keep their 30 s (D203).
          return worker.call(
            "command",
            cmd.id,
            input ?? {},
            { caller: commandCallerKind(ctx.caller) },
            0,
          );
        },
      });
    } catch (err) {
      // A VS Code package's command may have a name the IDE already uses (D256): skipped. VS
      // Code would let the extension's handler shadow the built-in one for every caller; here
      // the IDE's commands are what agents and the UI run under their permission checks, so it
      // stays the IDE's, and only the extension's own keybindings reach its handler.
      if (this.manifest.format !== "vscode") throw err;
      this.collided.add(cmd.id);
      const text = `${cmd.id} skipped: ${err instanceof Error ? err.message : String(err)}`;
      this.warnings.push(text);
      this.host.log({ time: Date.now(), level: "warn", text });
      return;
    }
    this.store.add(registration);
  }

  /**
   * A view of the extension; one with a `when` (VS Code's views and containers, D260) is there
   * only while it holds, coming and going as context keys change.
   */
  private registerView(placed: ThirdPartyManifest["contributes"]["views"][number]): void {
    const view = this.inContainer(placed);
    const { when } = view;
    if (!when) {
      this.tryRegisterViewIn(this.store, view);
      return;
    }
    let shown: DisposableStore | null = null;
    const sync = () => {
      let holds = false;
      try {
        holds = matchesWhen(when, (k) => this.services.context.get(k));
      } catch {
        holds = false;
      }
      if (holds && !shown) {
        shown = new DisposableStore();
        this.tryRegisterViewIn(shown, view);
      } else if (!holds && shown) {
        shown.dispose();
        shown = null;
      }
    };
    sync();
    this.store.add(this.services.context.onDidChange(sync));
    this.store.add(toDisposable(() => shown?.dispose()));
  }

  /**
   * A view in another extension's container (Cell Tags in Jupyter's panel) goes where that
   * container is; one whose container no enabled extension has stays in the Explorer, with
   * VS Code's warning.
   */
  private inContainer(
    view: ThirdPartyManifest["contributes"]["views"][number],
  ): ThirdPartyManifest["contributes"]["views"][number] {
    if (!view.container) return view;
    const container = this.host.viewContainer?.(view.container);
    if (container) return placeInContainer(view, container);
    const text = `View container '${view.container}' does not exist and all views registered to it will be added to 'Explorer'.`;
    if (!this.warnings.includes(text)) {
      this.warnings.push(text);
      this.host.log({ time: Date.now(), level: "warn", text });
    }
    return view;
  }

  /** Where its view `viewId` shows, its container resolved (undefined: not one of its views). */
  private viewLocation(viewId: string): string | undefined {
    const declared = this.manifest.contributes.views.find((v) => v.id === viewId);
    return declared && this.inContainer(declared).location;
  }

  /**
   * A view whose id another extension (or the IDE) has is skipped with a warning, as VS Code
   * does: the rest of the extension still loads.
   */
  private tryRegisterViewIn(
    store: DisposableStore,
    view: ThirdPartyManifest["contributes"]["views"][number],
  ): void {
    const views = new DisposableStore();
    try {
      this.registerViewIn(views, view);
      store.add(views);
    } catch (err) {
      views.dispose();
      this.host.log({
        time: Date.now(),
        level: "warn",
        text: `View ${view.id} skipped: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private registerViewIn(
    store: DisposableStore,
    view: ThirdPartyManifest["contributes"]["views"][number],
  ): void {
    const title = view.title;
    const viewIcon = safeIcon(view.icon, "box");
    // An image of the extension as its icon (VS Code's container icons, D260), once it's read.
    const iconImage = signal<string | null>(null);
    if (view.iconPath)
      void this.treeImage(view.iconPath).then((url) => {
        if (!store.isDisposed) iconImage.value = url;
      });
    const create = (): {
      element: HTMLElement;
      focus?(): void;
      onWindowChanged?(win: Window): void;
      dispose(): void;
    } => {
      if (this.manifest.main) void this.ensureWorker().catch(() => {});
      if (view.type === "webview") {
        const frame = new WebviewFrame(
          this.services,
          {
            path: view.codePage ? this.codePages.path(view.id) : (view.path ?? "index.html"),
            origin: () => this.origin(),
            receive: (message) =>
              void this.ensureWorker().then((w) => w.notify("webview", view.id, message)),
          },
          title,
        );
        this.add(this.webviews, view.id, frame);
        // VS Code's WebviewView.visible (runtimeViews.ts).
        const shown = this.hooks.views.track(view.id, frame.element);
        return {
          element: frame.element,
          onWindowChanged: (win) => frame.onWindowChanged(win),
          dispose: () => {
            shown.dispose();
            this.remove(this.webviews, view.id, frame);
            frame.dispose();
          },
        };
      }
      const tree = new ExtensionTreeView(
        {
          ready: () => this.treeProviders.has(view.id),
          children: async (parent?: TreeItem) => {
            if (!this.manifest.main) return [];
            const worker = await this.ensureWorker();
            if (!this.treeProviders.has(view.id)) return [];
            const items = await worker.call<TreeItem[]>("tree", view.id, { parent });
            return Array.isArray(items) ? items.slice(0, 5000) : [];
          },
          run: (command) =>
            void this.services.dispatcher
              .execute(command.id, command.input ?? {}, this.caller)
              .catch((err: unknown) =>
                this.services.notifications.show(
                  "error",
                  err instanceof Error ? err.message : String(err),
                ),
              ),
          ...this.hooks.treeSource(view.id),
          // A row's image of the extension (D258), the dark one with a dark theme.
          image: (item) => {
            const dark = this.services.theme.theme.peek() === "dark";
            const path =
              (dark ? item.iconPathDark : item.iconPath) ?? item.iconPath ?? item.iconPathDark;
            return path ? this.treeImage(path) : Promise.resolve(null);
          },
          // `menus["view/item/context"]` (VS Code's): `when` sees `view` and `viewItem`.
          menu: (item) => {
            const menu = treeItemMenu(
              this.manifest.contributes.menus,
              view.id,
              item,
              (k) => this.services.context.get(k),
              (command) =>
                this.manifest.contributes.commands.find((c) => c.id === command)?.title ?? command,
            );
            const input = treeMenuInput(view.id, item);
            const entry = (e: (typeof menu.inline)[number]) => ({
              title: e.title,
              ...(e.icon && { icon: e.icon }),
              command: { id: e.command, input },
            });
            return { inline: menu.inline.map(entry), groups: menu.groups.map((g) => g.map(entry)) };
          },
        },
        title,
      );
      const message = this.treeMessages.get(view.id);
      if (message) tree.setMessage(message);
      this.add(this.trees, view.id, tree);
      // VS Code's TreeView.visible (runtimeViews.ts).
      const shown = this.hooks.views.track(view.id, tree.element);
      return {
        element: tree.element,
        focus: () => tree.focus(),
        dispose: () => {
          shown.dispose();
          this.remove(this.trees, view.id, tree);
          tree.dispose();
        },
      };
    };

    // Buttons on the view's title (`menus` "view/title", when e.g. "view == acme.todo.list").
    const titleActions = this.manifest.contributes.menus
      .filter((m) => m.location === "view/title")
      .filter((m) => {
        try {
          return matchesWhen(m.when, (k) =>
            k === "view" ? view.id : this.services.context.get(k),
          );
        } catch {
          return false;
        }
      })
      .slice(0, 5)
      .map((m) => ({
        command: m.command,
        icon: safeIcon(m.icon, "circle-dot"),
        title:
          m.title ??
          this.manifest.contributes.commands.find((c) => c.id === m.command)?.title ??
          m.command,
      }));
    if (view.location === "sidebar") {
      store.add(
        this.services.views.register({
          id: view.id,
          title,
          icon: viewIcon,
          ...(view.iconPath && { iconImage: () => iconImage.value }),
          ...(titleActions.length && { actions: titleActions }),
          // A section of Source control or the Explorer while off the activity bar (D208).
          ...(view.sectionOf && { sectionOf: view.sectionOf }),
          ...(view.sectionOf && view.sectionOnly && { sectionOnly: true }),
          ...(view.sectionOrder !== undefined && { sectionOrder: view.sectionOrder }),
          menu: () => {
            const id = this.manifest.id;
            return [
              { label: "Extension details", command: "extensions.showDetails", input: { id } },
              {
                label: `Disable ${this.manifest.displayName}`,
                command: "extensions.disable",
                input: { id },
              },
              {
                label: `Uninstall ${this.manifest.displayName}…`,
                command: "extensions.uninstall",
                input: { id },
                danger: true,
              },
            ];
          },
          create: (host) => {
            const inst = create();
            host.append(inst.element);
            return inst;
          },
        }),
      );
      return;
    }
    const type = `ext:${view.id}`;
    store.add(
      this.services.dock.views.register({
        type,
        title: () => title,
        icon: () => viewIcon,
        // Its own image as the tab's icon too (D260).
        ...(view.iconPath && {
          iconElement: () => (iconImage.value ? imageIcon(iconImage.value) : undefined),
        }),
        singleton: true,
        // VS Code's secondary side bar is the dock's right side, beside the agent (D260).
        defaultPlacement:
          view.location === "editor" ? "main" : view.location === "secondary" ? "right" : "bottom",
        // Its own window too (D176): the page reloads there and messages follow it.
        detachable: true,
        actions: () => titleActions,
        create: (): DockView => {
          const inst = create();
          // A title its code set (VS Code's TreeView.title) on the tab too.
          const titleChanged = new Emitter<void>();
          const watching = effect(() => {
            this.services.views.titles.all.value.get(view.id);
            titleChanged.fire();
            return undefined;
          });
          return {
            element: inst.element,
            title: () => this.services.views.titles.all.peek().get(view.id)?.title ?? title,
            onDidChange: titleChanged.event,
            focus: () => inst.focus?.(),
            onWindowChanged: (win) => inst.onWindowChanged?.(win),
            serialize: () => null,
            // Extensions start after the layout is restored: their tabs don't come back.
            persist: () => false,
            dispose: () => {
              watching.dispose();
              titleChanged.dispose();
              inst.dispose();
            },
          };
        },
      }),
    );
    // Its tabs close with it, before the view type goes (disposal runs in reverse; D176: a page
    // left open could restart a stopped extension).
    store.add(closeTabsOf(this.services, type));
    const show = `${view.id}.show`;
    if (/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/.test(show))
      store.add(
        this.services.dispatcher.register({
          id: show,
          title: `Show ${title}`,
          category: this.manifest.displayName,
          description: `Opens the ${title} panel of the ${this.manifest.displayName} extension.`,
          input: s.empty(),
          effects: [],
          run: async () => {
            await this.revealView(view.id);
          },
        }),
      );
  }

  /** Opens one of its views; resolves with the tab's id for a dock tab (panel, editor). */
  private async revealView(viewId: string, background = false): Promise<string | null> {
    const declared = this.manifest.contributes.views.find((v) => v.id === viewId);
    if (!declared) throw new Error(`${viewId} isn't one of the extension's views.`);
    // Where it is: another extension's container moves it (a panel tab, not a side bar view).
    const view = this.inContainer(declared);
    if (view.location === "sidebar") {
      // In the background, a side bar view is its activity bar icon: nothing more to open.
      if (!background) await this.services.dispatcher.execute("view.show", { id: viewId });
      return null;
    }
    this.services.dock.openView(`ext:${viewId}`, null, undefined, !background, { background });
    return this.services.dock.tabs(`ext:${viewId}`)[0]?.id ?? null;
  }

  private origin(): Promise<string> {
    if (!this.proxyOrigin) {
      this.proxyOrigin = extIpc
        .webviewProxy(this.root, hasPermission(this.host.granted(), "web.embed"))
        .then((p) => p.origin);
      // Its pages may read the workspace's files too (VS Code's default localResourceRoots).
      void this.proxyOrigin.then(() => this.syncRoots()).catch(() => {});
      this.store.add(this.services.workspace.onDidChangeFolders(() => this.syncRoots()));
      this.store.add(this.services.workspace.onDidOpen(() => this.syncRoots()));
      // The folder closing: none of its files any more (before the native side forgets it).
      this.store.add(this.services.workspace.onDidClose(() => this.syncRoots(true)));
    }
    return this.proxyOrigin;
  }

  /** Folders its pages declared (VS Code's localResourceRoots), beside the workspace's. */
  private readonly declaredRoots = new Set<string>();

  /**
   * Tells its proxy which folders its pages may read besides its own: the workspace's folders
   * and the declared roots (the native side keeps those inside the workspace only).
   */
  private syncRoots(closing = false): void {
    if (!this.proxyOrigin || this.store.isDisposed) return;
    const roots = closing
      ? []
      : [...this.services.workspace.folders.peek().map((f) => f.path), ...this.declaredRoots];
    void extIpc.webviewRoots(this.root, roots).catch(() => {});
  }

  /** Pages its code wrote for its views, and what each open frame shows (D260, its live state). */
  codePageReport(): { id: string; page: string; frames: { path: string; loaded: boolean }[] }[] {
    return this.manifest.contributes.views
      .filter((v) => v.codePage)
      .map((v) => ({
        id: v.id,
        page: this.codePages.path(v.id),
        frames: (this.webviews.get(v.id) ?? []).map((f) => f.shown),
      }));
  }

  private add<T>(map: Map<string, T[]>, key: string, value: T): void {
    const list = map.get(key) ?? [];
    list.push(value);
    map.set(key, list);
  }

  private remove<T>(map: Map<string, T[]>, key: string, value: T): void {
    const list = map.get(key)?.filter((v) => v !== value) ?? [];
    if (list.length) map.set(key, list);
    else map.delete(key);
  }

  // ---- Requests from the worker ----------------------------------------------------------------

  private need(permission: string, what: string): void {
    if (!hasPermission(this.host.granted(), permission))
      throw new Error(
        `${this.manifest.displayName} needs the "${permission}" permission to ${what}.`,
      );
  }

  private ownView(viewId: unknown, type?: "tree" | "webview"): string {
    // A file viewer is a webview too (messages both ways).
    if (type === "webview" && this.manifest.contributes.viewers.some((v) => v.id === viewId))
      return String(viewId);
    const view = this.manifest.contributes.views.find((v) => v.id === viewId);
    if (!view || (type && view.type !== type))
      throw new Error(`${String(viewId)} isn't one of the extension's ${type ?? ""} views.`);
    return view.id;
  }

  /** Images of tree rows (D258): a blob URL per file of the extension, made once. */
  private readonly treeImages = new Map<string, Promise<string | null>>();

  private treeImage(path: string): Promise<string | null> {
    const root = this.root.replace(/\\/g, "/").replace(/\/+$/, "");
    let rel = path.replace(/\\/g, "/");
    if (rel.toLowerCase().startsWith(`${root.toLowerCase()}/`)) rel = rel.slice(root.length + 1);
    rel = rel.replace(/^\.?\//, "");
    if (!rel || /^[a-z]:/i.test(rel) || rel.startsWith("/") || rel.split("/").includes(".."))
      return Promise.resolve(null);
    let url = this.treeImages.get(rel);
    if (!url) {
      if (this.treeImages.size >= 500) return Promise.resolve(null);
      const type = /\.svg$/i.test(rel)
        ? "image/svg+xml"
        : /\.png$/i.test(rel)
          ? "image/png"
          : /\.gif$/i.test(rel)
            ? "image/gif"
            : /\.webp$/i.test(rel)
              ? "image/webp"
              : "image/jpeg";
      url = extIpc.read(this.root, rel).then(
        (bytes) => URL.createObjectURL(new Blob([bytes as BlobPart], { type })),
        () => null,
      );
      this.treeImages.set(rel, url);
    }
    return url;
  }

  /** A workspace path from the extension (relative to the folders, or absolute inside one). */
  private workspacePath(path: unknown): string {
    return this.workspace.workspacePath(path);
  }

  /** A path the extension may write: in the folders, not inside a `.git` folder (D207). */
  private writablePath(path: unknown): string {
    return this.workspace.writablePath(path);
  }

  private async request(method: string, p: Record<string, unknown>): Promise<unknown> {
    // A worker's late request after its runtime went registers nothing (D261).
    if (this.store.isDisposed) throw new Error(`${this.manifest.displayName} has stopped.`);
    const { services } = this;
    switch (method) {
      case "commands.register": {
        const id = String(p.id);
        // VS Code's `type` override (Vim keymaps): what's typed in the editor (runtimeHooks.ts).
        if (id === "type") return this.hooks.claimTyping();
        if (!this.manifest.contributes.commands.some((c) => c.id === id))
          throw new Error(
            `${id} isn't declared in the extension's manifest (contributes.commands).`,
          );
        this.handlers.add(id);
        return undefined;
      }
      case "commands.unregister":
        if (p.id === "type") this.hooks.releaseTyping();
        this.handlers.delete(String(p.id));
        return undefined;
      // Another VS Code package's `activate()` (D295): it runs in the same shared host, so once
      // it has activated its exports are there as a live object.
      case "extensions.activate":
        if (!this.host.activateOther) throw new Error("Other extensions aren't available here.");
        await this.host.activateOther(String(p.id ?? ""));
        return null;
      case "commands.execute": {
        if (p.id === "default:type" || p.id === "type") return this.hooks.defaultType(p.input);
        const id = String(p.id);
        if (id.startsWith(ANNOUNCE_VSCODE_COMMAND)) {
          this.host.announceVscodeCommand?.(id.slice(ANNOUNCE_VSCODE_COMMAND.length));
          return undefined;
        }
        if (id.startsWith(RUN_VSCODE_COMMAND)) return this.runVscodeCommand(id, p.input);
        return services.dispatcher.execute(id, p.input ?? {}, this.caller);
      }
      case "state.get": {
        const path = String(p.path);
        const rule = STATE_PERMISSIONS.find(
          ([prefix]) => path === prefix || path.startsWith(`${prefix}/`),
        );
        // Its own state paths (what its code registered, D202).
        if (!rule && ownsStatePath(this.manifest.id, path.split("?")[0] ?? path))
          return (await services.state.get(path)).value;
        if (!rule) throw new Error(`${path} isn't available to extensions.`);
        if (rule[1]) this.need(rule[1], `read ${path}`);
        return (await services.state.get(path)).value;
      }
      case "events.subscribe": {
        const sub = String(p.sub);
        // The folder's lifecycle and trust (D202): no permission (the path needs fs.read).
        if ((WORKSPACE_EVENTS as readonly string[]).includes(String(p.type))) {
          this.events.get(sub)?.dispose();
          this.events.set(
            sub,
            this.extras.subscribe(p.type as WorkspaceEventType, (payload) =>
              this.worker?.notify("event", sub, payload),
            ),
          );
          return undefined;
        }
        // The theme changed (VS Code's onDidChangeActiveColorTheme): its kind, no permission.
        if (p.type === "theme.didChange") {
          const theme = services.theme;
          this.events.get(sub)?.dispose();
          this.events.set(
            sub,
            theme.onDidChange(() =>
              this.worker?.notify("event", sub, { kind: theme.theme.peek() }),
            ),
          );
          return undefined;
        }
        // A repository's HEAD, index or refs moved (D208; needs "git").
        if (p.type === "git.didChange") {
          const off = this.git.subscribe((payload) => this.worker?.notify("event", sub, payload));
          this.events.get(sub)?.dispose();
          this.events.set(sub, off);
          return undefined;
        }
        // An open document's text changed as it's edited (D208; unsaved): at most every 250 ms
        // per file.
        if (p.type === "documents.didChange") {
          this.need("fs.read", "follow documents.didChange");
          const timers = new Map<string, number>();
          const off = services.documents.onDidChange((path) => {
            if (timers.has(path)) return;
            timers.set(
              path,
              window.setTimeout(() => {
                timers.delete(path);
                this.worker?.notify("event", sub, { path });
              }, 250),
            );
          });
          this.events.get(sub)?.dispose();
          this.events.set(sub, {
            dispose: () => {
              off.dispose();
              for (const t of timers.values()) window.clearTimeout(t);
              timers.clear();
            },
          });
          return undefined;
        }
        // The active editor, its selections and visible lines (D234; "fs.read").
        if ((EDITOR_EVENTS as readonly string[]).includes(String(p.type))) {
          this.need("fs.read", `follow ${String(p.type)}`);
          this.events.get(sub)?.dispose();
          this.events.set(
            sub,
            this.editorEvents.subscribe(sub, p.type as EditorEventType, (payload) =>
              this.worker?.notify("event", sub, payload),
            ),
          );
          return undefined;
        }
        // The editor tabs (VS Code's window.tabGroups; runtimeTabs.ts): their files, "fs.read".
        if (p.type === "tabs.didChange") {
          this.need("fs.read", "follow the editor tabs");
          this.events.get(sub)?.dispose();
          this.events.set(
            sub,
            this.hooks.tabs.subscribe((snapshot) => this.worker?.notify("event", sub, snapshot)),
          );
          return undefined;
        }
        const type = String(p.type) as keyof IdeEvents;
        if (!EVENTS.includes(type)) throw new Error(`Unknown event ${type}.`);
        this.need("fs.read", `follow ${type}`);
        this.events.get(sub)?.dispose();
        this.events.set(
          sub,
          services.events.on(type, (payload) => this.worker?.notify("event", sub, payload)),
        );
        return undefined;
      }
      case "events.unsubscribe": {
        const sub = String(p.sub);
        this.events.get(sub)?.dispose();
        this.events.delete(sub);
        return undefined;
      }
      case "fs.read":
        this.need("fs.read", "read files");
        return new TextDecoder().decode(await fsIpc.read(this.workspacePath(p.path)));
      case "fs.readBase64": {
        this.need("fs.read", "read files");
        const full = this.workspacePath(p.path);
        // Checked before reading: a huge file never crosses into the page.
        if ((await fsIpc.stat(full)).size > 8 * 1024 * 1024)
          throw new Error(`${String(p.path)} is over 8 MB: too large to read this way.`);
        const bytes = await fsIpc.read(full);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000)
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(binary);
      }
      case "fs.writeBase64": {
        this.need("fs.write", "change files");
        const path = this.writablePath(p.path);
        const text = String(p.data ?? "");
        if (text.length > 22 * 1024 * 1024) throw new Error("Too large to write this way (16 MB).");
        const binary = atob(text);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        await fsIpc.write(path, bytes, "extension");
        services.events.emit("files.didChange", { path });
        return undefined;
      }
      case "fs.write": {
        this.need("fs.write", "change files");
        const path = this.writablePath(p.path);
        const existed = await fsIpc.stat(path).then(
          () => true,
          () => false,
        );
        await fsIpc.write(path, new TextEncoder().encode(String(p.text ?? "")), "extension");
        // A new file (and maybe its folders) shows in the explorer at once (D189).
        if (existed) services.events.emit("files.didChange", { path });
        else services.events.emit("files.didCreate", { path, kind: "file" });
        return undefined;
      }
      case "fs.stat":
        this.need("fs.read", "read files");
        return fsIpc.stat(this.workspacePath(p.path));
      case "fs.list":
        this.need("fs.read", "read files");
        return (await fsIpc.listDir(this.workspacePath(p.path))).map((e) => ({
          name: e.name,
          path: e.path,
          kind: e.kind,
        }));
      case "fs.findText":
        this.need("fs.read", "search files");
        return findText(this.services, p);
      case "editor.active": {
        this.need("fs.read", "see the active editor");
        if (!services.state.has("ide://editors/active")) return null;
        const v = (await services.state.get("ide://editors/active")).value as {
          path?: string;
          absolutePath?: string | null;
          language?: string;
          cursor?: { line: number; column: number };
          selectedText?: string;
          selections?: {
            start: { line: number; column: number };
            end: { line: number; column: number };
          }[];
        } | null;
        if (!v?.absolutePath) return null;
        const cursor = v.cursor ?? { line: 1, column: 1 };
        const sel = v.selections?.[0];
        return {
          path: v.absolutePath,
          language: v.language ?? "",
          cursor,
          selectedText: v.selectedText ?? "",
          // The first selection (D208): a line range for line-based tools (line history).
          selection: sel
            ? {
                startLine: sel.start.line,
                startColumn: sel.start.column,
                endLine: sel.end.line,
                endColumn: sel.end.column,
              }
            : {
                startLine: cursor.line,
                startColumn: cursor.column,
                endLine: cursor.line,
                endColumn: cursor.column,
              },
        };
      }
      case "editor.insert":
        this.need("fs.write", "type into the editor");
        await services.dispatcher.execute(
          "editor.insertText",
          { text: String(p.text ?? "") },
          this.caller,
        );
        return undefined;
      case "ui.notify":
        return this.notify(p);
      case "ui.showQuickPick": {
        if (p.canPickMany === true) return this.hooks.handle(method, p);
        const items = Array.isArray(p.items)
          ? (p.items as {
              label?: unknown;
              description?: unknown;
              icon?: unknown;
              detail?: unknown;
              separator?: unknown;
            }[])
          : [];
        const picked = await services.quickInput.pick(
          items.slice(0, 5000).map((item, i) => ({
            id: String(i),
            label: String(item?.label ?? ""),
            ...(typeof item?.separator === "string" && { separator: item.separator.slice(0, 80) }),
            ...(typeof item?.description === "string" && { description: item.description }),
            ...(typeof item?.icon === "string" && { icon: safeIcon(item.icon, "circle-dot") }),
            ...(typeof item?.detail === "string" && { detail: item.detail.slice(0, 1000) }),
          })),
          {
            placeholder: typeof p.placeholder === "string" ? p.placeholder : "",
            ...(typeof p.activeIndex === "number" &&
              p.activeIndex > 0 && { activeIndex: Math.floor(p.activeIndex) }),
            // VS Code's matchOnDescription (D234).
            ...(p.matchOnDescription === true && {
              matchOn: (item) => `${item.label} ${item.description ?? ""}`,
            }),
          },
        );
        return picked ? Number(picked.id) : null;
      }
      case "ui.showInput":
        return (
          (await services.quickInput.prompt({
            prompt: typeof p.prompt === "string" ? p.prompt : "",
            ...(typeof p.value === "string" && { value: p.value }),
            ...(typeof p.placeholder === "string" && { placeholder: p.placeholder }),
            ...(p.password === true && { password: true }),
            ...(typeof p.error === "string" && p.error && { error: p.error.slice(0, 500) }),
          })) ?? null
        );
      case "tree.register":
        this.treeProviders.add(this.ownView(p.viewId, "tree"));
        this.hooks.treeRegistered(String(p.viewId), p);
        for (const t of this.trees.get(String(p.viewId)) ?? []) void t.refresh();
        return undefined;
      case "languages.setConfiguration": {
        // D258: merged over the language's own configuration while the extension runs.
        const key = String(p.key ?? "");
        const languageId = String(p.languageId ?? "");
        if (!/^[\w.+-]{1,60}$/.test(languageId))
          throw new Error(`${languageId} isn't a language id.`);
        this.languageConfigs.get(key)?.dispose();
        this.languageConfigs.set(
          key,
          this.services.extensionFeatures.languageConfigurations.add({
            owner: this.manifest.id,
            languageId,
            configuration: p.configuration ?? {},
          }),
        );
        return undefined;
      }
      case "languages.unsetConfiguration": {
        const key = String(p.key ?? "");
        this.languageConfigs.get(key)?.dispose();
        this.languageConfigs.delete(key);
        return undefined;
      }
      case "tree.refresh":
        for (const t of this.trees.get(this.ownView(p.viewId, "tree")) ?? []) void t.refresh();
        return undefined;
      case "tree.reveal": {
        // VS Code's TreeView.reveal (D258): the view shows, then the row.
        const viewId = this.ownView(p.viewId, "tree");
        const path = Array.isArray(p.path) ? p.path.map(String).slice(0, 50) : [];
        await this.revealView(viewId).catch(() => null);
        // A section that was collapsed makes its tree when it opens: wait a moment for it.
        for (let i = 0; i < 20 && !this.trees.get(viewId)?.length; i++)
          await new Promise((r) => setTimeout(r, 50));
        const options = {
          select: p.select !== false,
          focus: p.focus === true,
          expand: p.expand === true,
        };
        for (const t of this.trees.get(viewId) ?? []) await t.reveal(path, options);
        return undefined;
      }
      case "tree.message": {
        // A line above the rows (VS Code's TreeView.message, D208); empty removes it.
        const viewId = this.ownView(p.viewId, "tree");
        const text = typeof p.message === "string" ? p.message.slice(0, 500) : "";
        this.treeMessages.set(viewId, text);
        for (const t of this.trees.get(viewId) ?? []) t.setMessage(text);
        return undefined;
      }
      case "view.title": {
        // A title and description its code set (VS Code's TreeView / WebviewView title and
        // description): shown in the view's header in place of its manifest title.
        const viewId = this.ownView(p.viewId);
        const text = (v: unknown) => (typeof v === "string" ? v : undefined);
        this.services.views.titles.set(viewId, {
          title: text(p.title),
          description: text(p.description),
        });
        if (!this.viewTitles.has(viewId)) {
          this.viewTitles.add(viewId);
          // Back to its own when the extension goes.
          this.store.add(toDisposable(() => this.services.views.titles.set(viewId, {})));
        }
        return undefined;
      }
      case "webview.post": {
        const viewId = this.ownView(p.viewId, "webview");
        // After a page still being served (D261: `html = …; postMessage(…)` reaches the new page).
        await this.codePages.settled(
          typeof p.instance === "number" ? `viewer#${p.instance}` : viewId,
        );
        // One tab of a code-page viewer (D257), or every page of the view.
        const tab = typeof p.instance === "number" ? this.viewerTabs.get(p.instance) : undefined;
        for (const w of tab ? [tab] : (this.webviews.get(viewId) ?? [])) w.post(p.message);
        return undefined;
      }
      case "webview.setDirty":
        // A code-page viewer tab's unsaved state (D258).
        this.ownView(p.viewId, "webview");
        if (typeof p.instance === "number" && this.viewerTabs.has(p.instance))
          setViewerDirty(p.instance, p.dirty === true);
        return undefined;
      case "webview.setHtml": {
        // A webview view's or a viewer tab's page, written by its code (D257).
        const viewId = this.ownView(p.viewId, "webview");
        if (typeof p.html !== "string") throw new Error("setHtml needs the page's HTML.");
        if (typeof p.instance === "number") {
          const tab = this.viewerTabs.get(p.instance);
          if (!tab) return undefined;
          return this.codePages.set(
            `viewer#${p.instance}`,
            withPageSetup(p.html, services, `viewer:${this.pageStamp}#${p.instance}`),
            () => (this.viewerTabs.has(Number(p.instance)) ? [tab] : []),
          );
        }
        return this.codePages.set(
          viewId,
          withPageSetup(
            p.html,
            services,
            `view:${viewId}`,
            this.viewLocation(viewId) === "sidebar",
          ),
          () => this.webviews.get(viewId) ?? [],
        );
      }
      case "webview.reveal":
        return this.revealView(this.ownView(p.viewId), p.background === true).then(() => undefined);
      case "settings.get": {
        const key = String(p.key);
        if (!this.readableSetting(key))
          throw new Error(
            `${key}: extensions can read their own settings, editor/workbench/files ones and those their manifest lists in "readsSettings" (never credentials).`,
          );
        return services.settings.peek(key) ?? null;
      }
      case "settings.subscribe":
        this.watchSettings();
        return undefined;
      case "storage.get":
        return (await this.loadStorage())[this.storageKey(p)];
      case "storage.set": {
        const data = await this.loadStorage();
        const key = this.storageKey(p);
        if (p.value === undefined || p.value === null) delete data[key];
        else data[key] = p.value;
        this.saveStorageSoon();
        return undefined;
      }
      case "net.fetch": {
        const headers =
          p.headers && typeof p.headers === "object"
            ? Object.entries(p.headers as Record<string, unknown>).map(
                ([k, v]) => [k, String(v)] as [string, string],
              )
            : [];
        // Redirects are followed here, each new address checked against the permission (Rust
        // doesn't follow them: D203 audit). A 303, or a 301/302 after a POST, becomes a GET.
        let url = String(p.url);
        let method = typeof p.method === "string" ? p.method : "GET";
        let body = typeof p.body === "string" ? p.body : undefined;
        for (let hop = 0; ; hop++) {
          if (!networkAllows(this.host.granted(), url))
            throw new Error(`${this.manifest.displayName} may not connect to ${safeHost(url)}.`);
          const r = await extIpc.fetch({
            url,
            method,
            headers,
            ...(body !== undefined && { body }),
          });
          const location = r.headers.find(([k]) => k.toLowerCase() === "location")?.[1];
          if (r.status < 300 || r.status >= 400 || r.status === 304 || !location) return r;
          if (hop >= 5) throw new Error("Too many redirects.");
          url = new URL(location, url).toString();
          if (r.status === 303 || ((r.status === 301 || r.status === 302) && method !== "GET")) {
            method = "GET";
            body = undefined;
          }
        }
      }
      default: {
        for (const host of [
          this.notebooks,
          this.api,
          this.extras,
          this.processes,
          this.git,
          this.outputs,
          this.workbench,
          this.env,
          this.hooks,
          this.fileDecorations,
          this.workspace,
        ]) {
          const handled = host.handle(method, p);
          if (handled !== UNHANDLED) return handled;
        }
        throw new Error(`Unknown request ${method}.`);
      }
    }
  }

  /** A storage key: its own, or (workspaceState) under the workspace's location (D234, D251). */
  private storageKey(p: Record<string, unknown>): string {
    return this.workspace.storageKey(p);
  }

  private readableSetting(key: string): boolean {
    return canReadSetting(
      Object.keys(this.manifest.contributes.settings),
      this.manifest.readsSettings,
      key,
    );
  }

  /** The keys `settings.onChange` reports: its own, and what `readsSettings` names (D202). */
  private watchedSettingKeys(): string[] {
    const own = Object.keys(this.manifest.contributes.settings);
    const reads = this.manifest.readsSettings;
    if (!reads.length) return own;
    const known = this.services.settings.registry.all().map((s) => s.key);
    const exact = reads.filter((r) => !r.endsWith(".*"));
    const listed = [...new Set([...exact, ...known])].filter(
      (k) => matchesReadsSettings(reads, k) && this.readableSetting(k),
    );
    return [...new Set([...own, ...listed])];
  }

  private watchSettings(): void {
    if (this.settingsWatch) return;
    const snapshot = () =>
      new Map(
        this.watchedSettingKeys().map(
          (k) => [k, JSON.stringify(this.services.settings.peek(k)) ?? ""] as const,
        ),
      );
    let seen = snapshot();
    this.settingsWatch = this.store.add(
      effect(() => {
        this.services.settings.version.value;
        // A setting registered later (another extension's) counts from then on.
        const now = snapshot();
        const changed = [...now]
          .filter(([k, v]) => seen.has(k) && seen.get(k) !== v)
          .map(([k]) => k);
        seen = now;
        if (changed.length) this.worker?.notify("settings", "", changed);
        return undefined;
      }),
    );
  }

  private notify(p: Record<string, unknown>): Promise<string | null> {
    const kind = ["info", "success", "warning", "error"].includes(p.kind as string)
      ? (p.kind as "info" | "success" | "warning" | "error")
      : "info";
    const labels = Array.isArray(p.actions)
      ? p.actions.filter((a): a is string => typeof a === "string").slice(0, 3)
      : [];
    // A program its Open VSX build doesn't carry: one plain notice the user can turn off, not
    // an error on every start (D362).
    const missing = missingBundledProgram(String(p.message ?? ""), dirname(this.root));
    if (missing) {
      this.host.log({ time: Date.now(), level: "warn", text: String(p.message) });
      showDismissible(
        this.services,
        `missing-program.${missing.extensionFolder}.${missing.program}`.toLowerCase(),
        "info",
        `${this.manifest.displayName} couldn't start ${missing.program}: the Open VSX build of ${missing.extensionFolder} doesn't include it. What needs it won't work; the rest does.`,
      );
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let done = false;
      // Unanswered notifications resolve when the extension stops; an answered one leaves the
      // store (D261: one entry per message otherwise, for the extension's whole life).
      const pending = toDisposable(() => finish(null));
      const finish = (v: string | null) => {
        if (!done) {
          done = true;
          this.store.delete(pending);
          resolve(v);
        }
      };
      this.services.notifications.show(kind, String(p.message ?? "").slice(0, 2000), {
        title: this.manifest.displayName,
        actions: labels.map((label) => ({ label, run: () => finish(label) })),
        onClose: () => finish(null),
      });
      if (!labels.length) finish(null);
      else this.store.add(pending);
    });
  }

  private async loadStorage(): Promise<Record<string, unknown>> {
    if (!this.storage) {
      const text = await extIpc.storageLoad(this.manifest.id).catch(() => "{}");
      try {
        const parsed = JSON.parse(text || "{}") as unknown;
        this.storage =
          parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
      } catch {
        this.storage = {};
      }
    }
    return this.storage;
  }

  private saveStorageSoon(): void {
    window.clearTimeout(this.storageTimer);
    this.storageTimer = window.setTimeout(() => void this.saveStorage(), 300);
  }

  private async saveStorage(): Promise<void> {
    if (!this.storage) return;
    await extIpc
      .storageSave(this.manifest.id, JSON.stringify(this.storage))
      .catch((err: unknown) =>
        this.host.log({ time: Date.now(), level: "error", text: `storage: ${String(err)}` }),
      );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.storageTimer) {
      window.clearTimeout(this.storageTimer);
      await this.saveStorage();
    }
    const worker = this.worker;
    this.worker = null;
    await worker?.stop();
    const starting = this.startingWorker;
    this.dispose();
    // Its process gone, so an update or uninstall can replace its folder (D261).
    await Promise.all([worker?.exited, starting?.exited]);
  }

  dispose(): void {
    for (const url of this.treeImages.values())
      void url.then((u) => {
        if (u) URL.revokeObjectURL(u);
      });
    this.treeImages.clear();
    this.codePages.dispose();
    this.notebooks.dispose();
    this.processes.dispose();
    this.extras.dispose();
    this.api.dispose();
    this.git.dispose();
    this.workbench.dispose();
    this.editorEvents.dispose();
    this.hooks.dispose();
    this.fileDecorations.dispose();
    for (const d of this.languageConfigs.values()) d.dispose();
    this.languageConfigs.clear();
    this.workspace.dispose();
    this.startingWorker?.dispose();
    this.startingWorker = null;
    this.worker?.dispose();
    this.worker = null;
    for (const e of this.events.values()) e.dispose();
    this.events.clear();
    this.store.dispose();
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url.slice(0, 80);
  }
}
