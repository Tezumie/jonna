// One running third-party extension (PLAN §9, D102): its declarative contributions, its commands,
// keybindings, settings and views, and (when it has code) its worker, whose every request is
// answered here after checking the permissions the user granted. Commands the extension runs go
// through the dispatcher as `caller: ext`, where the policy applies the same permissions.
// Beside it, one module per subject (runtime*.ts): its declared views (runtimeContributedViews.ts),
// the plain requests (runtimeBasics.ts), the events it follows (runtimeSubscriptions.ts), its
// settings and storage (runtimeSettings.ts), and the rest of the API.

import type { Caller } from "../../core/dispatcher/types";
import { RestartBudget } from "../../core/extensions/activation";
import { commandCallerKind, commandInputSchema } from "../../core/extensions/commandInput";
import {
  activatesOn,
  type ContributedViewContainer,
  hasPermission,
  inClaimedNamespace,
  type ThirdPartyManifest,
} from "../../core/extensions/thirdParty";
import {
  ANNOUNCE_VSCODE_COMMAND,
  RUN_VSCODE_COMMAND,
} from "../../core/extensions/vscode/commandIds";
import type { InstalledExtension } from "../../core/extensions/vscode/extensionRegistry";
import type { VscodeInit } from "../../core/extensions/vscode/index";
import { vscodeLanguageId } from "../../core/extensions/vscode/languageIds";
import { vscodeNotebookType } from "../../core/extensions/vscode/notebookEditors";
import { resolveVscodeKeybindings } from "../../core/extensions/vscodePackage";
import { extIpc } from "../../core/ipc/extensions";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { joinPath } from "../../core/paths/index";
import { product } from "../../core/product";
import { effect } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { addDeclarative } from "./contributions";
import { nodeProgram } from "./nodeRuntime";
import { ExtensionApiHost, UNHANDLED } from "./runtimeApi";
import { ExtensionBasicsHost } from "./runtimeBasics";
import { ExtensionContributedViews } from "./runtimeContributedViews";
import { ExtensionEditorEvents } from "./runtimeEditorEvents";
import { ExtensionEnvHost, workspaceContains } from "./runtimeEnv";
import { ExtensionExtrasHost } from "./runtimeExtras";
import { ExtensionFileDecorations } from "./runtimeFileDecorations";
import { ExtensionGitHost } from "./runtimeGit";
import { ExtensionHooksHost } from "./runtimeHooks";
import { ExtensionNotebooks } from "./runtimeNotebooks";
import { ExtensionOutputHost } from "./runtimeOutput";
import { ExtensionProcesses } from "./runtimeProcess";
import { ExtensionSettingsHost } from "./runtimeSettings";
import { ExtensionSubscriptions } from "./runtimeSubscriptions";
import { ExtensionWorkbenchHost } from "./runtimeWorkbench";
import { ExtensionWorkspaceHost } from "./runtimeWorkspace";
import type { SharedNodeHost } from "./sharedHost";
import {
  ActivationFailed,
  ExtensionWorker,
  type HostTransport,
  type LogLine,
  nodeTransport,
} from "./workerHost";

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

/** Crashes of its own worker or process within 5 minutes after which it stays stopped. */
const CRASH_LIMIT = 3;

/** `workspaceContains:` for a folder just added: checked again this often, this many times. */
const ADDED_FOLDER_RECHECK_MS = 3000;
const ADDED_FOLDER_RECHECKS = 5;

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
  /** Language configurations its code set (D258). */
  private readonly languageConfigs = new Map<string, Disposable>();
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
  /** Its declared views and viewers, and the requests about them (runtimeContributedViews.ts). */
  private readonly views: ExtensionContributedViews;
  /** State, files, the active editor, messages and prompts, fetch (runtimeBasics.ts). */
  private readonly basics: ExtensionBasicsHost;
  /** The events its code follows (runtimeSubscriptions.ts). */
  private readonly subscriptions: ExtensionSubscriptions;
  /** Its settings and its storage (runtimeSettings.ts). */
  private readonly settings: ExtensionSettingsHost;

  constructor(
    readonly manifest: ThirdPartyManifest,
    readonly root: string,
    private readonly host: RuntimeHost,
  ) {
    this.caller = { kind: "ext", id: manifest.id };
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
      revealView: (viewId) => this.views.revealView(this.views.ownView(viewId)),
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
      has: (permission) => hasPermission(host.granted(), permission),
      name: manifest.displayName,
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
    this.views = new ExtensionContributedViews({
      manifest,
      services: host.services,
      root,
      caller: this.caller,
      store: this.store,
      warnings: this.warnings,
      log: (line) => host.log(line),
      granted: () => host.granted(),
      workspacePath: (path) => this.workspacePath(path),
      worker: () => this.ensureWorker(),
      running: () => this.worker,
      origin: () => this.origin(),
      image: (path) => this.treeImage(path),
      hooks: this.hooks,
      viewContainer: (id) => host.viewContainer?.(id),
    });
    this.basics = new ExtensionBasicsHost({
      manifest,
      services: host.services,
      root,
      caller: this.caller,
      store: this.store,
      need: (permission, what) => this.need(permission, what),
      granted: () => host.granted(),
      workspacePath: (path) => this.workspacePath(path),
      writablePath: (path) => this.writablePath(path),
      log: (line) => host.log(line),
      pickMany: (method, p) => this.hooks.handle(method, p),
    });
    this.subscriptions = new ExtensionSubscriptions({
      services: host.services,
      need: (permission, what) => this.need(permission, what),
      running: () => this.worker,
      extras: this.extras,
      git: this.git,
      editorEvents: this.editorEvents,
      hooks: this.hooks,
    });
    this.settings = new ExtensionSettingsHost({
      manifest,
      services: host.services,
      store: this.store,
      shipped: this.shipped,
      running: () => this.worker,
      log: (line) => host.log(line),
      storageKey: (p) => this.workspace.storageKey(p),
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
    this.settings.registerSettings(warn);
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
      await this.views.pagesReady();
    for (const view of c.views) if (allowed(view.id, "View")) this.views.registerView(view);
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
    if (c.viewers.length) this.store.add(this.views.registerViewers());
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
    // Crashed again and again: an activation event (the next file opened) mustn't start it once
    // more. A reload, or enabling it again, makes a new runtime.
    if (this.crashBlocked) return Promise.reject(new Error(this.crashBlocked));
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
          // The shared host's crashes are counted by the manager (`stayStopped`); its own worker
          // or process here, by the same rule.
          const shared = this.manifest.format === "vscode" && this.manifest.host === "node";
          if (!shared && !this.crashes.take(Date.now()))
            this.stayStopped(
              `${this.manifest.displayName} crashed ${CRASH_LIMIT + 1} times within 5 minutes: it stays stopped until you reload it.`,
            );
          this.host.crashed(this.crashBlocked ?? error);
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
              this.services.backendPlatform === "mac"
                ? "macos"
                : this.services.backendPlatform === "windows"
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

  /** Why its code stays stopped after crashing repeatedly (until this runtime is replaced). */
  private crashBlocked: string | null = null;
  private readonly crashes = new RestartBudget(CRASH_LIMIT);

  /** Its code isn't started again by this runtime: it (or the host it shares) keeps crashing. */
  stayStopped(reason: string): void {
    this.crashBlocked = reason;
  }

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
    if (this.worker || this.starting || !manifest.main || this.refused || this.crashBlocked) return;
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
    this.views.workerGone();
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
      harmless: (id) =>
        this.services.dispatcher.info(id)?.effects.every((effect) => effect === "read") === true,
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
   * Tells its proxy which folders its pages may read besides its own: with the "fs.read"
   * permission, the workspace's folders and the declared roots (the native side keeps those
   * inside the workspace only).
   */
  private syncRoots(closing = false): void {
    if (!this.proxyOrigin || this.store.isDisposed) return;
    // Only with "fs.read": a page fetching the folder's files reads them as its code would
    // (the declared roots are inside the workspace too).
    const roots =
      closing || !hasPermission(this.host.granted(), "fs.read")
        ? []
        : [...this.services.workspace.folders.peek().map((f) => f.path), ...this.declaredRoots];
    void extIpc.webviewRoots(this.root, roots).catch(() => {});
  }

  /** Pages its code wrote for its views, and what each open frame shows (D260, its live state). */
  codePageReport(): { id: string; page: string; frames: { path: string; loaded: boolean }[] }[] {
    return this.views.codePageReport();
  }

  // ---- Requests from the worker ----------------------------------------------------------------

  private need(permission: string, what: string): void {
    if (!hasPermission(this.host.granted(), permission))
      throw new Error(
        `${this.manifest.displayName} needs the "${permission}" permission to ${what}.`,
      );
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
      default: {
        for (const host of [
          this.views,
          this.basics,
          this.subscriptions,
          this.settings,
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

  async stop(): Promise<void> {
    this.stopping = true;
    const saving = this.settings.flushStorage();
    if (saving) await saving;
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
    this.views.dispose();
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
    this.subscriptions.dispose();
    this.store.dispose();
  }
}
