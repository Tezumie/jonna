// Third-party extensions (PLAN §9, D102): finds them (installed, and folders loaded unpacked),
// keeps the registry (unpacked folders, disabled ids, granted permissions), asks for permissions
// when an extension is added or starts asking for more, starts and stops them, and reloads
// unpacked ones when their files change. The dispatcher asks `authorize` about every command an
// extension runs.

import { output } from "../../core/diagnostics/output";
import {
  ActivationMemory,
  activateDependencies,
  type DependencyState,
  dependentsOf,
  extensionDependencies,
  RestartBudget,
} from "../../core/extensions/activation";
import {
  type ContributedViewContainer,
  describePermission,
  hasPermission,
  parseManifest,
  requiredPermissions,
  type ThirdPartyManifest,
} from "../../core/extensions/thirdParty";
import type { InstalledExtension } from "../../core/extensions/vscode/extensionRegistry";
import { vscodeLanguageId } from "../../core/extensions/vscode/languageIds";
import { vscodeNotebookType } from "../../core/extensions/vscode/notebookEditors";
import { declarativeOnly, localizePackage } from "../../core/extensions/vscodePackage";
import { sessionIpc } from "../../core/ipc/diagnostics";
import { type ExtEntry, extIpc } from "../../core/ipc/extensions";
import { fsIpc } from "../../core/ipc/fs";
import { execIpc } from "../../core/ipc/process";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { joinPath } from "../../core/paths/index";
import type { AuthorizeRequest, Decision } from "../../core/permissions/index";
import { effect, type Signal, signal } from "../../core/reactive/index";
import { showDialog } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import { workspaceFolderPaths } from "../../workbench/workspaceFolder";
import type { BisectState } from "./bisect";
import {
  CodeCommandOwners,
  findViewContainer,
  routeVscodeCommand,
  vscodePackageList,
} from "./crossExtension";
import {
  missingPermissions,
  parseRegistry,
  type Registry,
  type RepoSource,
  startOrder,
} from "./registry";
import { ExtensionRuntime } from "./runtime";
import { SharedNodeHost } from "./sharedHost";
import type { LogLine } from "./workerHost";

const DEV_POLL_MS = 1500;
const FOLDER_POLL_MS = 4000;
const MAX_LOG = 500;

export type ExtensionStatus =
  /** Running (or ready: code starts on its activation event). */
  | "active"
  | "disabled"
  /** Waiting for the user to grant the permissions it asks for. */
  | "needsPermission"
  | "failed"
  /** The manifest couldn't be read. */
  | "invalid";

export interface ExtensionRecord {
  id: string;
  root: string;
  manifestFile: string;
  manifest: ThirdPartyManifest | null;
  dev: boolean;
  mtimeMs: number;
  status: ExtensionStatus;
  error?: string;
  /** Problems with some contributed files (the rest still works). */
  warnings: string[];
  /** The repository it was installed from (D185). */
  source?: RepoSource;
  /**
   * A development copy using the same id as an installed extension replaces it while loaded
   * (D189): the installed one isn't run, and installing this copy permanently updates it.
   */
  replaces?: { version: string; root: string; bundled: boolean; source?: RepoSource };
  /** A bundled extension the user replaced with a changed copy (the IDE's updates skip it). */
  customized?: boolean;
  /**
   * A VS Code package whose code waits for these permissions (D256): until they're allowed it
   * runs as before the shim, its themes, grammars and snippets only.
   */
  codeWaiting?: string[];
  /** A VS Code package's `extensionDependencies` (lowercase ids, D295). */
  dependencies?: string[];
}

interface Loaded {
  runtime: ExtensionRuntime;
  mtimeMs: number;
  /** Started without its code (`codeWaiting`): allowing it starts it again with it. */
  codeWaiting: boolean;
}

/** An extension folder in the open folder's `<workspace folder>/extensions` that isn't loaded. */
export interface WorkspaceExtension {
  root: string;
  /** The folder name. */
  name: string;
  /** From the manifest, when it has one. */
  id?: string;
  displayName?: string;
  /** Why it can't load as it is (no manifest, or what's wrong with it). */
  error?: string;
}

export class ExtensionManager implements Disposable {
  readonly records: Signal<readonly ExtensionRecord[]> = signal([]);
  /** Folders in `<workspace folder>/extensions` that aren't loaded (D110): shown so they can be loaded or fixed. */
  readonly workspace: Signal<readonly WorkspaceExtension[]> = signal([]);
  private registry: Registry = {
    customized: [],
    dev: [],
    disabled: [],
    granted: {},
    declined: {},
    bundled: [],
    sources: {},
    bisect: null,
    disabledIn: {},
    autoUpdate: {},
  };
  private readonly loaded = new Map<string, Loaded>();
  private readonly logs = new Map<string, LogLine[]>();
  private timer = 0;
  private refreshing: Promise<void> | null = null;
  private disposed = false;
  /** Ids the user was already asked about this session (don't ask again on every refresh). */
  private readonly asked = new Set<string>();
  /** Every VS Code package's code runs in this one Node process (D295). */
  private readonly sharedHost: SharedNodeHost;
  /** Activation events that fired this session (D295): an extension enabled later gets them. */
  readonly activationMemory = new ActivationMemory();
  /** The shared host's restarts after a crash (VS Code: at most 3 in 5 minutes). */
  private readonly restarts = new RestartBudget();
  /** Extensions whose code was running in the shared host when it died: started again. */
  private readonly crashedInHost = new Set<string>();
  /** Why a loaded extension failed (activation, crash): kept across refreshes (D295). */
  private readonly failures = new Map<string, string>();
  /** Extensions resolving their dependencies now: a cycle is cut there. */
  private readonly resolvingDependencies = new Set<string>();
  private readonly subscriptions = new DisposableStore();
  /** The loaded extensions' ids at the last refresh (a change clears dependency refusals). */
  private enabledKey = "";

  constructor(private readonly services: WorkbenchServices) {
    this.sharedHost = new SharedNodeHost((level, text) =>
      output.append("exthost", level, `[extension host] ${text}`),
    );
    this.subscriptions.add(this.sharedHost);
    this.subscriptions.add(
      this.sharedHost.onDidCrash((error, planned) => this.sharedHostCrashed(error, planned)),
    );
    // VS Code's activation events, remembered (an extension enabled later activates for them).
    const memory = this.activationMemory;
    // Another folder is another session for activation (VS Code reloads the window for it).
    this.subscriptions.add(services.workspace.onDidOpen(() => memory.clear()));
    this.subscriptions.add(
      services.events.on("documents.didOpen", ({ languageId }) => {
        memory.record(`onLanguage:${languageId}`);
        memory.record(`onLanguage:${vscodeLanguageId(languageId)}`);
      }),
    );
    this.subscriptions.add(
      services.events.on("notebook.didOpen", ({ notebookType }) => {
        memory.record(`onNotebook:${notebookType}`);
        memory.record(`onNotebook:${vscodeNotebookType(notebookType)}`);
      }),
    );
    this.subscriptions.add(
      services.events.on("debug.didStartSession", ({ type }) => {
        memory.record("onDebug");
        memory.record(`onDebugResolve:${type}`);
      }),
    );
    this.subscriptions.add(
      services.extensionFeatures.fileSystems.onWillNeedScheme((scheme) =>
        memory.record(`onFileSystem:${scheme}`),
      ),
    );
    // The shared host's `vscode.extensions` list follows installs, enables and disables.
    this.subscriptions.add(
      effect(() => {
        this.records.value;
        this.sharedHost.setInstalled(this.vscodePackages());
      }),
    );
  }
  // ---- Discovery -------------------------------------------------------------------------------

  /** Re-reads the extension folders; starts new ones, reloads changed ones, stops removed ones. */
  refresh(): Promise<void> {
    // One already running read the registry before this call's change: run once more after it
    // (D185: a repository source saved during a refresh was otherwise lost until the next one).
    if (this.refreshing) {
      // After the running one, even if it failed (D261: a rejection kept here failed every
      // later refresh).
      this.refreshAgain ??= this.refreshing
        .catch(() => {})
        .then(() => {
          this.refreshAgain = null;
          return this.refresh();
        });
      return this.refreshAgain;
    }
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  private refreshAgain: Promise<void> | null = null;
  /** Ids an install, update or uninstall is working on: a refresh doesn't start them meanwhile. */
  private readonly busy = new Set<string>();

  /** Runs `work` with `id` marked busy (see `busy`). */
  private async whileBusy<T>(id: string, work: () => Promise<T>): Promise<T> {
    this.busy.add(id);
    try {
      return await work();
    } finally {
      this.busy.delete(id);
    }
  }

  private async doRefresh(): Promise<void> {
    const { entries, registry } = await extIpc.list();
    this.registry = parseRegistry(registry);
    const seen = new Set<string>();
    const records: ExtensionRecord[] = [];
    // Development copies first: one with an installed extension's id replaces it (D189).
    const ordered = [...entries.filter((e) => e.dev), ...entries.filter((e) => !e.dev)];
    for (const entry of ordered) {
      const record = this.read(entry);
      const dev = records.find((r) => r.dev && r.id === record.id && r.status !== "invalid");
      if (!entry.dev && dev && record.manifest) {
        dev.replaces = {
          version: record.manifest.version,
          root: record.root,
          bundled: this.registry.bundled.includes(record.id),
          ...(record.source && { source: record.source }),
        };
        continue;
      }
      if (!entry.dev && this.registry.customized.includes(record.id)) record.customized = true;
      if (seen.has(record.id)) {
        record.status = "invalid";
        record.error = `Another extension already uses the id ${record.id}.`;
        records.push(record);
        continue;
      }
      // A broken manifest's id is its folder's name: it never takes a real extension's id.
      if (record.manifest) seen.add(record.id);
      records.push(record);
    }
    // A VS Code package's code waits for its permissions; its declarative parts don't (D256).
    for (const record of records) {
      const m = record.manifest;
      if (m?.format !== "vscode" || !m.main) continue;
      if (!missingPermissions(m, this.granted(record.id, record)).length) continue;
      record.codeWaiting = [...m.permissions];
      record.manifest = declarativeOnly(m);
    }
    // Stop what's gone, changed, disabled or no longer valid.
    for (const [id, loaded] of [...this.loaded]) {
      const record = records.find((r) => r.id === id && r.status !== "invalid");
      if (
        !record ||
        record.mtimeMs !== loaded.mtimeMs ||
        loaded.codeWaiting !== !!record.codeWaiting ||
        this.registry.disabled.includes(id) ||
        this.disabledHere(id) ||
        this.registry.bisect?.off.includes(id) ||
        (record.manifest && missingPermissions(record.manifest, this.granted(id, record)).length)
      ) {
        await this.stopRuntime(id);
        if (record && record.mtimeMs !== loaded.mtimeMs)
          this.log(id, "info", "Reloaded (files changed).");
      }
    }
    // Started with extensions off (D204: --disable-extensions or "Restart with extensions off").
    const allOff = await sessionIpc.extensionsOff();
    const started: ExtensionRuntime[] = [];
    // What a starting extension may look up in the others (another's view containers).
    this.reading = records;
    // The earliest installed first: their commands keep their ids (D264).
    for (const record of startOrder(records, this.registry.installedAt)) {
      if (record.status === "invalid" || !record.manifest) continue;
      const running = this.loaded.get(record.id);
      if (allOff) {
        record.status = "disabled";
        record.error = "Extensions are off for this session (Help → Restart with extensions on).";
        continue;
      }
      if (this.registry.disabled.includes(record.id)) {
        record.status = "disabled";
        continue;
      }
      if (this.disabledHere(record.id)) {
        record.status = "disabled";
        record.error = "Disabled in this workspace.";
        continue;
      }
      if (this.registry.bisect?.off.includes(record.id)) {
        record.status = "disabled";
        record.error = "Off for this round of extension bisect (Help → Extension bisect).";
        continue;
      }
      const missing = missingPermissions(record.manifest, this.granted(record.id, record));
      if (missing.length) {
        record.status = "needsPermission";
        continue;
      }
      if (running) {
        const previous = this.records.peek().find((r) => r.id === record.id);
        record.status = previous?.status ?? "active";
        record.error = previous?.error;
        record.warnings = running.runtime.warnings;
        continue;
      }
      // Being installed, updated or removed right now (D261): that operation starts it after.
      if (this.busy.has(record.id)) continue;
      const runtime = await this.startRuntime(record);
      if (runtime) started.push(runtime);
    }
    // A failure reported while the list was being made (a background activation) is kept.
    for (const record of records) {
      const failure = this.loaded.has(record.id) ? this.failures.get(record.id) : undefined;
      if (failure !== undefined) {
        record.status = "failed";
        record.error = failure;
      }
    }
    this.records.value = records;
    // What's enabled changed: an extension refused for a missing dependency may run now.
    const enabled = records
      .filter((r) => this.loaded.has(r.id))
      .map((r) => r.id)
      .join(",");
    if (enabled !== this.enabledKey) {
      this.enabledKey = enabled;
      for (const l of this.loaded.values()) l.runtime.clearRefusal();
    }
    // Every extension's contributions are in: now their code starts, in the background, those
    // that start with the IDE and those whose activation events already fired (D295, as VS Code).
    const fired = (activation: readonly string[]) => this.activationMemory.matches(activation);
    for (const runtime of started) if (!runtime.running) runtime.startIfDue(fired);
    const folders = this.folderKey();
    this.setWorkspace(await this.scanWorkspace(records), folders);
    this.schedulePoll();
    // An extension that now asks for permissions (added, or changed to ask for more — e.g. one
    // the agent is building): ask right away, one dialog at a time, unless the user already said
    // no to this same list.
    for (const r of records)
      if (r.status === "needsPermission" && r.manifest && !this.asked.has(r.id)) {
        this.asked.add(r.id);
        if (this.registry.declined[this.grantKey(r.id, r)] === r.manifest.permissions.join(","))
          continue;
        const id = r.id;
        this.prompts = this.prompts.then(() =>
          this.reviewPermissions(id).then(
            () => {},
            () => {},
          ),
        );
      }
  }

  private prompts: Promise<void> = Promise.resolve();

  private read(entry: ExtEntry): ExtensionRecord {
    const base = {
      root: entry.root,
      manifestFile: entry.manifestFile,
      dev: entry.dev,
      mtimeMs: entry.mtimeMs,
      warnings: [],
    };
    try {
      const manifest = manifestOf(entry);
      const source = entry.dev ? undefined : this.registry.sources[manifest.id];
      const dependencies =
        manifest.format === "vscode" ? dependenciesOf(entry.manifest, manifest.id) : [];
      return {
        ...base,
        id: manifest.id,
        manifest,
        status: "active",
        ...(source && { source }),
        ...(dependencies.length && { dependencies }),
      };
    } catch (err) {
      const folder = entry.root.split(/[\\/]/).pop() ?? entry.root;
      return {
        ...base,
        id: folder,
        manifest: null,
        status: "invalid",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Looks for unloaded folders again (the open folder changed, or a poll). */
  async rescanWorkspace(): Promise<void> {
    if (this.refreshing) return;
    const folders = this.folderKey();
    this.setWorkspace(await this.scanWorkspace(this.records.peek()), folders);
  }

  /** The workspace's folders, to tell whether they changed while a scan ran. */
  private folderKey(): string {
    return [this.services.workspace.root.peek(), ...this.services.workspace.folderPaths()].join(
      "\n",
    );
  }

  /** Takes a scan's result unless the folders changed while it ran. */
  private setWorkspace(found: WorkspaceExtension[], folders: string): void {
    if (this.folderKey() !== folders) return;
    if (JSON.stringify(found) !== JSON.stringify(this.workspace.peek()))
      this.workspace.value = found;
  }

  /**
   * Folders under `<workspace>/<workspace folder>/extensions` that no record uses: made by hand (or by an agent
   * that skipped extensions.create). They aren't run until the user loads them. Every folder of
   * a multi-root workspace has its own (D251).
   */
  private async scanWorkspace(records: readonly ExtensionRecord[]): Promise<WorkspaceExtension[]> {
    const root = this.services.workspace.root.peek();
    if (!root) return [];
    const roots = this.services.workspace.folderPaths();
    const dirs: { name: string; path: string }[] = [];
    for (const folder of roots.length ? roots : [root]) {
      // Every settings folder of it (D189): the IDE's own first; a same-named folder in a lower
      // one is skipped.
      const own: { name: string; path: string }[] = [];
      for (const parent of workspaceFolderPaths(folder, "extensions")) {
        const entries = await fsIpc.listDir(parent).catch(() => []);
        for (const e of entries)
          if (e.kind === "dir" && !own.some((d) => d.name.toLowerCase() === e.name.toLowerCase()))
            own.push(e);
      }
      dirs.push(...own);
    }
    const norm = (p: string) =>
      p
        .replace(/[\\/]+$/, "")
        .replace(/\\/g, "/")
        .toLowerCase();
    const used = new Set(records.map((r) => norm(r.root)));
    const found: WorkspaceExtension[] = [];
    for (const dir of dirs) {
      if (used.has(norm(dir.path))) continue;
      const item: WorkspaceExtension = { root: dir.path, name: dir.name };
      try {
        const entry = await extIpc.peek(dir.path);
        const record = this.read({ ...entry, dev: true });
        if (record.manifest) {
          item.id = record.manifest.id;
          item.displayName = record.manifest.displayName;
        } else item.error = record.error;
      } catch (err) {
        item.error = err instanceof Error ? err.message : String(err);
      }
      found.push(item);
    }
    return found;
  }

  /** Adds an extension's contributions; its code starts later (the caller's `startIfDue`). */
  private async startRuntime(record: ExtensionRecord): Promise<ExtensionRuntime | undefined> {
    const manifest = record.manifest;
    if (!manifest) return undefined;
    const id = manifest.id;
    this.failures.delete(id);
    const runtime = new ExtensionRuntime(manifest, record.root, {
      services: this.services,
      granted: () => this.granted(id),
      // As shipped: not a development copy or one the user changed (D202: may claim state paths).
      bundled: !record.dev && !record.customized && this.registry.bundled.includes(id),
      dev: record.dev,
      log: (line) => this.pushLog(id, line),
      crashed: (error) => {
        if (this.loaded.get(id)?.runtime !== runtime) return;
        // The shared host died (D295): restarted with the others below, if VS Code's limit allows.
        if (manifest.format === "vscode" && manifest.host === "node") this.crashedInHost.add(id);
        this.setStatus(id, "failed", error);
      },
      failed: (error) => {
        if (this.loaded.get(id)?.runtime !== runtime) return;
        this.log(id, "error", error);
        this.setStatus(id, "failed", error);
      },
      activated: () => {
        if (this.loaded.get(id)?.runtime !== runtime) return;
        if (this.failures.has(id)) this.setStatus(id, "active");
      },
      beforeActivate: () => this.activateDependenciesOf(id),
      sharedHost: this.sharedHost,
      others: () => this.vscodePackages(),
      activateOther: (other) => this.activateFor(id, other),
      fired: (event) => this.activationMemory.record(event),
      vscodeCommand: (command, args) => this.vscodeCommand(id, command, args),
      announceVscodeCommand: (command) => this.announceVscodeCommand(id, command),
      viewContainer: (container) => this.viewContainer(id, container),
    });
    this.loaded.set(id, {
      runtime,
      mtimeMs: record.mtimeMs,
      codeWaiting: !!record.codeWaiting,
    });
    try {
      await runtime.activate();
      record.status = "active";
      record.error = undefined;
    } catch (err) {
      record.status = "failed";
      record.error = err instanceof Error ? err.message : String(err);
      this.failures.set(id, record.error);
      this.log(id, "error", `Failed to start: ${record.error}`);
      // Keep its declarative parts and commands (the code may work after a reload).
    }
    record.warnings = runtime.warnings;
    return runtime;
  }

  /**
   * `id`'s extensionDependencies activate before it (D295, VS Code's activator): one missing,
   * disabled or not allowed to run refuses it ("depends on unknown extension"), as does one
   * whose activation failed. The refusal is shown as a notification and on the extension.
   */
  private async activateDependenciesOf(id: string): Promise<void> {
    const record = this.get(id);
    const dependencies = record?.dependencies ?? [];
    if (!dependencies.length) return;
    const displayName = record?.manifest?.displayName ?? id;
    this.resolvingDependencies.add(id);
    try {
      await activateDependencies(displayName, dependencies, (dep) => this.dependencyState(dep));
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.services.notifications.show("error", text, { title: displayName });
      throw err;
    } finally {
      this.resolvingDependencies.delete(id);
    }
  }

  private dependencyState(dep: string): DependencyState {
    const record = this.get(dep);
    const runtime = this.loaded.get(dep)?.runtime;
    if (!record?.manifest || !runtime || record.status === "disabled") return { kind: "missing" };
    // Without code (or a cycle back to one resolving its own): nothing to wait for.
    if (!runtime.manifest.main || this.resolvingDependencies.has(dep))
      return { kind: "declarative" };
    return {
      kind: "code",
      displayName: runtime.manifest.displayName,
      activate: async () => {
        await runtime.ensureWorker();
        if (runtime.activationError) throw new Error(runtime.activationError);
      },
    };
  }

  /**
   * `caller`'s `vscode.extensions.getExtension(id).activate()` (D295): only code that runs in Node
   * (which can already do what the target can) may, and only a VS Code package is activated.
   * Resolves once it has activated (its exports are then live in the shared host).
   */
  private async activateFor(caller: string, id: string): Promise<void> {
    const target = this.loaded.get(id.toLowerCase())?.runtime;
    const from = this.loaded.get(caller)?.runtime;
    if (from?.manifest.host !== "node") throw new Error("Only extensions running in Node can.");
    if (target?.manifest.format !== "vscode")
      throw new Error(`Extension '${id}' isn't installed and enabled.`);
    if (!target.manifest.main) return;
    await target.ensureWorker();
    if (target.activationError) throw new Error(target.activationError);
  }

  /**
   * The shared host died (D295): every extension in it was marked failed. As VS Code does, the
   * host restarts with those that were running, at most 3 times in 5 minutes.
   */
  private sharedHostCrashed(error: string, planned = false): void {
    const ids = [...this.crashedInHost];
    this.crashedInHost.clear();
    if (!ids.length || this.disposed) return;
    // Ended on purpose (an extension with native addons left): they start again, quietly.
    if (planned) {
      for (const id of ids) {
        const runtime = this.loaded.get(id)?.runtime;
        if (!runtime) continue;
        this.setStatus(id, "active");
        void runtime.ensureWorker().catch(() => {});
      }
      return;
    }
    if (!this.restarts.take(Date.now())) {
      this.services.notifications.show(
        "error",
        `The extension host terminated unexpectedly 3 times within the last 5 minutes (${error.slice(0, 200)}). Its extensions stay stopped until you reload them.`,
      );
      return;
    }
    this.services.notifications.show(
      "warning",
      "The extension host terminated unexpectedly. Restarting its extensions.",
    );
    for (const id of ids) {
      const runtime = this.loaded.get(id)?.runtime;
      if (!runtime) continue;
      this.setStatus(id, "active");
      void runtime.ensureWorker().catch(() => {});
    }
  }

  /** The records of the refresh under way (or the last one), before `records` is set. */
  private reading: readonly ExtensionRecord[] = [];

  /** Commands extensions registered in code only (crossExtension.ts). */
  private readonly codeCommands = new CodeCommandOwners();

  /** `owner` registered the VS Code command `id` in code: other extensions may run it. */
  private announceVscodeCommand(owner: string, id: string): void {
    this.codeCommands.announce(owner, id, (other) => this.loaded.has(other));
  }

  /** Another extension's VS Code command `id` (crossExtension.ts routeVscodeCommand). */
  private vscodeCommand(caller: string, id: string, args: unknown[]) {
    return routeVscodeCommand(this.loadedRuntimes(), this.codeCommands, caller, id, args);
  }

  /** A view container another enabled VS Code package declares (crossExtension.ts). */
  private viewContainer(caller: string, id: string): ContributedViewContainer | undefined {
    return findViewContainer(
      this.loadedRuntimes().values(),
      this.reading,
      this.registry.disabled,
      caller,
      id,
    );
  }

  /** What `vscode.extensions` lists in the shared host (crossExtension.ts). */
  private vscodePackages(): InstalledExtension[] {
    return vscodePackageList(this.records.peek(), this.loadedRuntimes().values());
  }

  private loadedRuntimes(): Map<string, ExtensionRuntime> {
    return new Map([...this.loaded].map(([id, l]) => [id, l.runtime]));
  }

  /** A running extension's code-written pages and its frames (ExtensionRuntime.codePageReport). */
  codePages(id: string) {
    return this.loaded.get(id)?.runtime.codePageReport() ?? [];
  }

  /**
   * The folder isn't trusted (any more, or another folder was opened): extensions whose code runs
   * in Node stop it (D261). Trust was asked only when that code started.
   */
  async stopUntrustedCode(): Promise<void> {
    await Promise.all(
      [...this.loaded.values()]
        .filter((l) => l.runtime.manifest.host === "node")
        .map((l) => l.runtime.stopCode().catch(() => {})),
    );
  }

  /**
   * The folder is trusted now (D273): Node code that starts with the IDE starts again (stopped
   * for trust, or never let run).
   */
  resumeTrustedCode(): void {
    // Also those whose activation events fired while it wasn't trusted (D295).
    const fired = (activation: readonly string[]) => this.activationMemory.matches(activation);
    for (const l of this.loaded.values())
      if (l.runtime.manifest.host === "node") l.runtime.resumeStartupCode(fired);
  }

  private async stopRuntime(id: string): Promise<void> {
    const loaded = this.loaded.get(id);
    if (!loaded) return;
    this.loaded.delete(id);
    this.failures.delete(id);
    this.crashedInHost.delete(id);
    this.codeCommands.forget(id);
    await loaded.runtime.stop().catch(() => loaded.runtime.dispose());
  }

  private setStatus(id: string, status: ExtensionStatus, error?: string): void {
    // Kept for the next refresh's list too (D295: a background activation's failure).
    if (status === "failed") this.failures.set(id, error ?? "failed");
    else this.failures.delete(id);
    this.records.value = this.records.peek().map((r) => {
      if (r.id !== id) return r;
      if (status === "active") return { ...r, status, error: undefined };
      return { ...r, status, ...(error !== undefined ? { error } : {}) };
    });
  }

  private schedulePoll(): void {
    window.clearTimeout(this.timer);
    if (this.disposed) return;
    if (!this.records.peek().some((r) => r.dev)) {
      // Nothing unpacked: just look for new folders in <workspace folder>/extensions now and then.
      if (!this.services.workspace.root.peek()) return;
      this.timer = window.setTimeout(() => {
        if (document.visibilityState === "hidden") return this.schedulePoll();
        void this.rescanWorkspace().finally(() => this.schedulePoll());
      }, FOLDER_POLL_MS);
      return;
    }
    this.timer = window.setTimeout(() => {
      if (document.visibilityState === "hidden") return this.schedulePoll();
      void this.refresh().catch(() => this.schedulePoll());
    }, DEV_POLL_MS);
  }

  // ---- Registry --------------------------------------------------------------------------------

  granted(id: string, record?: ExtensionRecord): readonly string[] {
    return this.registry.granted[this.grantKey(id, record)] ?? [];
  }

  /**
   * Where an extension's grants are kept: by id — but a development copy replacing an installed
   * extension has its own (D189), so changing a copy never runs with the original's grants.
   */
  private grantKey(id: string, record = this.get(id)): string {
    return record?.dev && record.replaces ? `${id}#dev` : id;
  }

  private async saveRegistry(change: (r: Registry) => void): Promise<void> {
    const current = parseRegistry((await extIpc.list()).registry);
    change(current);
    this.registry = current;
    await extIpc.saveRegistry(JSON.stringify(current, null, 2));
  }

  get(id: string): ExtensionRecord | undefined {
    return this.records.peek().find((r) => r.id === id);
  }

  require(id: string): ExtensionRecord {
    const r = this.get(id);
    if (!r) throw new Error(`No extension ${id}.`);
    return r;
  }

  // ---- Actions ---------------------------------------------------------------------------------

  /** Asks the user to grant what the extension asks for. Returns true when granted. */
  async reviewPermissions(id: string, answerForTest?: boolean): Promise<boolean> {
    const record = this.require(id);
    const manifest = record.manifest;
    if (!manifest) throw new Error(record.error ?? "The extension's manifest is invalid.");
    const asked = record.codeWaiting ?? manifest.permissions;
    if (!asked.length) return true;
    const answer =
      answerForTest !== undefined
        ? answerForTest
          ? "grant"
          : "cancel"
        : await this.permissionDialog(manifest, asked, false);
    const key = this.grantKey(id, record);
    if (answer !== "grant") {
      await this.saveRegistry((r) => {
        r.declined[key] = asked.join(",");
      });
      return false;
    }
    await this.saveRegistry((r) => {
      r.granted[key] = [...asked];
      delete r.declined[key];
    });
    await this.refresh();
    return true;
  }

  /**
   * Asks to allow what an extension asks for. Before a new extension is installed (D259) Cancel
   * means it isn't installed, and a VS Code package whose code would run can be installed without
   * its code ("declarative": its themes, grammars and snippets work, as before D256).
   */
  private async permissionDialog(
    manifest: ThirdPartyManifest,
    asked: readonly string[],
    installing: boolean,
  ): Promise<"grant" | "cancel" | "declarative"> {
    const lines = asked.map((p) => `• ${describePermission(p)}`).join("\n");
    // Code that runs in Node isn't sandboxed (D255, D256): say so instead.
    const how = asked.includes("node")
      ? "Its code runs in Node.js with your access to files and programs, like any program you install: allow it only if you trust who made it."
      : "It runs in a sandbox and can only do what you allow here.";
    const withoutCode = installing && manifest.format === "vscode" && !!manifest.main;
    // Its code wouldn't run on this computer (D265): said before it's installed, not after.
    const noNode =
      asked.includes("node") &&
      !(await execIpc
        .installed(["node"])
        .then((r) => r[0] !== false)
        .catch(() => true));
    // The IDE's own pinned Node (D267): already downloaded, or offered when its code starts.
    const pinned = noNode ? await extIpc.nodeStatus().catch(() => null) : null;
    const nodeNote =
      !noNode || pinned?.path
        ? ""
        : pinned?.available
          ? `\n\nNode.js isn't installed on this computer: when its code first starts, the IDE offers to download Node.js ${pinned.version} for extensions (about 30 MB), or install Node.js 18 or newer yourself.`
          : "\n\nNode.js wasn't found on this computer, so its code can't run here yet: install Node.js 18 or newer (nodejs.org), then reload extensions.";
    return showDialog<"grant" | "cancel" | "declarative">({
      title: installing ? `Install ${manifest.displayName}?` : `Allow ${manifest.displayName}?`,
      message: `${manifest.displayName} ${manifest.version}${manifest.publisher ? ` by ${manifest.publisher}` : ""} asks to:\n\n${lines}\n\n${how}${withoutCode ? " Without its code, its themes, languages and snippets still work." : ""} You can disable or remove it at any time from the Extensions view.${nodeNote}`,
      actions: [
        { label: "Cancel", value: "cancel", variant: "secondary" },
        ...(withoutCode
          ? [
              {
                label: "Install without its code",
                value: "declarative" as const,
                variant: "secondary" as const,
              },
            ]
          : []),
        { label: installing ? "Allow and install" : "Allow", value: "grant", variant: "primary" },
      ],
      cancelValue: "cancel",
      defaultValue: "cancel",
    });
  }

  /** Extension bisect's state (bisect.ts), kept in the registry across restarts. */
  get bisect(): BisectState | null {
    return this.registry.bisect;
  }

  /** Saves bisect's next round (null: it's over) and applies it to what runs. */
  async setBisect(state: BisectState | null, apply = true): Promise<void> {
    await this.saveRegistry((r) => {
      r.bisect = state;
    });
    if (apply) await this.refresh();
  }

  /** The workspace's key for Disable (Workspace) (D258): its first folder. */
  private workspaceKey(): string {
    return this.services.workspace.root.peek() ?? "";
  }

  /** Off in the open workspace only (D258). */
  disabledHere(id: string): boolean {
    const key = this.workspaceKey();
    return !!key && (this.registry.disabledIn[key] ?? []).includes(id);
  }

  /** Whether an extension is off everywhere (Disable) rather than in this workspace. */
  disabledEverywhere(id: string): boolean {
    return this.registry.disabled.includes(id);
  }

  /** VS Code's Enable / Disable (Workspace) (D258). */
  async setEnabledHere(id: string, enabled: boolean): Promise<void> {
    this.require(id);
    const key = this.workspaceKey();
    if (!key) throw new Error("Open a folder first: this turns it off for that folder only.");
    await this.saveRegistry((r) => {
      const ids = (r.disabledIn[key] ?? []).filter((d) => d !== id);
      if (!enabled) ids.push(id);
      if (ids.length) r.disabledIn[key] = ids;
      else delete r.disabledIn[key];
    });
    await this.refresh();
  }

  /** Whether it comes with the IDE (VS Code's @builtin filter, D284). */
  isBundled(id: string): boolean {
    return this.registry.bundled.includes(id);
  }

  /** Whether it updates by itself from Open VSX (D258): its own choice, else the setting. */
  autoUpdates(id: string): boolean {
    return (
      this.registry.autoUpdate[id] ??
      this.services.settings.peek<boolean>("extensions.autoUpdate") === true
    );
  }

  async setAutoUpdate(id: string, on: boolean | null): Promise<void> {
    await this.saveRegistry((r) => {
      if (on === null) delete r.autoUpdate[id];
      else r.autoUpdate[id] = on;
    });
    this.registry.autoUpdate = { ...this.registry.autoUpdate };
    if (on === null) delete this.registry.autoUpdate[id];
    else this.registry.autoUpdate[id] = on;
    this.records.value = [...this.records.peek()];
  }

  /**
   * Before `id` is disabled or uninstalled (D295, as VS Code asks): the enabled extensions that
   * depend on it, directly or not, go too ("all"), stay ("only" `id`), or nothing happens (null).
   * Returns the dependents to act on as well; [] when none depend on it.
   */
  async askAboutDependents(
    id: string,
    action: "disable" | "uninstall",
    answerForTest?: "all" | "only" | "cancel",
  ): Promise<string[] | null> {
    const enabled = this.records
      .peek()
      .filter((r) => r.manifest && r.status !== "disabled" && r.status !== "invalid")
      .map((r) => ({ id: r.id, dependencies: r.dependencies ?? [] }));
    const dependents = dependentsOf(id, enabled);
    if (!dependents.length) return [];
    const nameOf = (x: string) => this.get(x)?.manifest?.displayName ?? x;
    const names = dependents.map((d) => `'${nameOf(d)}'`);
    const others =
      names.length === 1
        ? `${names[0]} extension depends on this.`
        : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} extensions depend on this.`;
    const verb = action === "disable" ? "disable" : "uninstall";
    const answer =
      answerForTest ??
      (await showDialog<"all" | "only" | "cancel">({
        title: action === "disable" ? "Disable extension" : "Uninstall extension",
        message: `Cannot ${verb} '${nameOf(id)}' extension alone. ${others} Do you want to ${verb} all these extensions?`,
        actions: [
          { label: "Cancel", value: "cancel", variant: "secondary" },
          {
            label: action === "disable" ? "Disable only this one" : "Uninstall only this one",
            value: "only",
            variant: "secondary",
          },
          {
            label: action === "disable" ? "Disable all" : "Uninstall all",
            value: "all",
            variant: action === "disable" ? "primary" : "danger",
          },
        ],
        cancelValue: "cancel",
        defaultValue: "all",
      }));
    if (answer === "cancel") return null;
    return answer === "all" ? dependents : [];
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    this.require(id);
    await this.saveRegistry((r) => {
      r.disabled = r.disabled.filter((d) => d !== id);
      if (!enabled) r.disabled.push(id);
    });
    await this.refresh();
  }

  async reload(id?: string): Promise<void> {
    if (id) {
      this.require(id);
      await this.stopRuntime(id);
    } else for (const loaded of [...this.loaded.keys()]) await this.stopRuntime(loaded);
    await this.refresh();
  }

  /**
   * Copies an extension folder into the installed extensions. A new extension that asks for
   * permissions is asked about first (D259): Cancel installs nothing (null).
   */
  /**
   * `granted`: its permissions were granted with another extension the user allowed (a pack's
   * member, a dependency): installed and allowed without a dialog of its own, as VS Code installs
   * them with the extension.
   */
  async installFrom(folder: string, ask = true, granted = false): Promise<string | null> {
    const manifest = await this.peekFolder(folder);
    const installed = this.get(manifest.id);
    let answered: "grant" | "declarative" | null = granted && !installed ? "grant" : null;
    if (ask && !granted && !installed) {
      const missing = missingPermissions(manifest, this.registry.granted[manifest.id] ?? []);
      if (missing.length) {
        const answer = await this.permissionDialog(manifest, manifest.permissions, true);
        if (answer === "cancel") return null;
        answered = answer;
      }
    }
    // Replacing an installed copy (an update): stopped first, so none of its files are held open.
    await this.whileBusy(manifest.id, async () => {
      if (installed && !installed.dev) await this.stopRuntime(manifest.id);
      await extIpc.install(folder, manifest.id);
    }).catch(async (err: unknown) => {
      // Not replaced (a file in use): the copy it had runs again, not stopped until a refresh.
      await this.refresh().catch(() => {});
      throw err;
    });
    // First installed now (an update keeps its time, D264).
    if (!this.registry.installedAt?.[manifest.id])
      await this.saveRegistry((r) => {
        r.installedAt = { ...r.installedAt, [manifest.id]: Date.now() };
      });
    if (answered)
      await this.saveRegistry((r) => {
        if (answered === "grant") {
          r.granted[manifest.id] = [...manifest.permissions];
          delete r.declined[manifest.id];
        } else r.declined[manifest.id] = manifest.permissions.join(",");
      });
    await this.afterAdd(manifest, ask && !answered);
    return manifest.id;
  }

  /**
   * A development (unpacked or project) extension copied into the installed extensions and used
   * from there (D176): it keeps its permissions; its folder stays where it is, no longer loaded.
   */
  async installPermanently(
    id: string,
    mode: "replace" | "new" = "replace",
    newId?: string,
  ): Promise<{ id: string; from: string; replaced?: string; customized?: boolean }> {
    const record = this.require(id);
    if (!record.dev) throw new Error(`${record.manifest?.displayName ?? id} is already installed.`);
    if (!record.manifest) throw new Error(`Fix ${id}'s manifest first: ${record.error ?? ""}`);
    const replaces = record.replaces;
    let target = id;
    if (replaces && mode === "new") {
      // Its own id, written into the copy's manifest, so both stay installed.
      target = newId?.trim() || (await this.freeId(id));
      if (this.get(target)) throw new Error(`Another extension already uses the id ${target}.`);
      await this.stopRuntime(id);
      await rewriteManifestId(record.root, record.manifestFile, target);
    } else await this.stopRuntime(id);
    try {
      await extIpc.install(record.root, target);
    } catch (err) {
      // Not copied: the development one runs again as it was.
      await this.refresh().catch(() => {});
      throw err;
    }
    const replacing = !!replaces && mode === "replace";
    await this.saveRegistry((r) => {
      r.dev = r.dev.filter((d) => d !== record.root);
      // The copy's own grants (what the user allowed for its code) go with it.
      const own = r.granted[`${id}#dev`];
      if (replaces) {
        if (own) r.granted[target] = own;
        delete r.granted[`${id}#dev`];
        delete r.declined[`${id}#dev`];
      }
      if (replacing) {
        // A bundled extension now has the user's changes: the IDE's updates mustn't undo them.
        if (replaces.bundled && !r.customized.includes(id)) r.customized.push(id);
        // Changed locally: "Update from repository" would undo the changes.
        delete r.sources[id];
      }
    });
    await this.refresh();
    return {
      id: target,
      from: record.root,
      ...(replacing && { replaced: replaces.version }),
      ...(replacing && replaces.bundled && { customized: true }),
    };
  }

  /** `<id>-2`, `<id>-3`… the first no extension uses. */
  private async freeId(id: string): Promise<string> {
    for (let n = 2; ; n++) {
      const candidate = `${id}-${n}`;
      if (
        !this.get(candidate) &&
        !this.records.peek().some((r) => r.replaces && r.id === candidate)
      )
        return candidate;
    }
  }

  /**
   * Goes back to the IDE's own version of a bundled extension the user replaced (D189): their
   * copy is removed and the bundled one is installed again (and updated with the IDE from then on).
   */
  async revertToBundled(id: string): Promise<void> {
    if (!this.registry.bundled.includes(id)) throw new Error(`${id} doesn't come with the IDE.`);
    const record = this.get(id);
    if (record?.dev)
      throw new Error("Remove the development copy first (it replaces the installed one).");
    // Only this one, as it was (enabled or not): not every bundled extension the user removed.
    await this.whileBusy(id, async () => {
      await this.stopRuntime(id);
      await extIpc.reinstallBundled(id);
    }).catch(async (err: unknown) => {
      // Not replaced: the user's copy runs again.
      await this.refresh().catch(() => {});
      throw err;
    });
    await this.saveRegistry((r) => {
      r.customized = r.customized.filter((c) => c !== id);
    });
    await this.refresh();
  }

  /** The repository an installed extension came from (D185), if it did. */
  sourceOf(id: string): RepoSource | undefined {
    return this.registry.sources[id];
  }

  /** Remembers (or forgets) where an installed extension came from. */
  async setSource(id: string, source: RepoSource | undefined): Promise<void> {
    await this.saveRegistry((r) => {
      if (source) r.sources[id] = source;
      else delete r.sources[id];
    });
    await this.refresh();
  }

  /** Uses a folder in place (development: reloads when its files change). */
  async loadUnpacked(folder: string, ask = true): Promise<string> {
    const manifest = await this.peekFolder(folder);
    await this.saveRegistry((r) => {
      if (!r.dev.includes(folder)) r.dev.push(folder);
    });
    await this.afterAdd(manifest, ask);
    return manifest.id;
  }

  private async afterAdd(manifest: ThirdPartyManifest, ask: boolean): Promise<void> {
    this.asked.add(manifest.id);
    // Permissions granted for an earlier version that asked for less don't cover the new ones.
    await this.refresh();
    const added = this.get(manifest.id);
    if (ask && (added?.status === "needsPermission" || added?.codeWaiting))
      await this.reviewPermissions(manifest.id);
  }

  /** Reads and checks a folder's manifest before installing it. */
  private async peekFolder(folder: string): Promise<ThirdPartyManifest> {
    return manifestOf(await extIpc.peek(folder));
  }

  /**
   * Removes an extension. Installed ones: their copy is deleted. Unpacked ones: taken off the
   * list, and with `deleteFiles` their folder is deleted too (to the IDE's trash when it is inside
   * the open folder, so Undo brings it back).
   */
  async uninstall(id: string, deleteFiles: boolean): Promise<{ deleted: boolean }> {
    const record = this.require(id);
    let deleted = !record.dev;
    // A refresh meanwhile doesn't start it again from the folder being removed (D261).
    await this.whileBusy(id, async () => {
      await this.stopRuntime(id);
      if (record.dev) {
        if (deleteFiles) {
          if (this.services.workspace.contains(record.root)) await fsIpc.trash(record.root);
          else await extIpc.deleteUnpacked(record.root);
          deleted = true;
        }
        await this.saveRegistry((r) => {
          r.dev = r.dev.filter((d) => d !== record.root);
        });
      } else await extIpc.uninstall(id);
    }).catch(async (err: unknown) => {
      // Not removed (a file in use): it runs again as it was, not stopped until a refresh.
      await this.refresh().catch(() => {});
      throw err;
    });
    await this.saveRegistry((r) => {
      // A copy that replaced an installed extension: only its own grants go; the installed
      // one's permissions, source and enabled state are kept (it comes back as it was).
      if (record.replaces) {
        delete r.granted[`${id}#dev`];
        delete r.declined[`${id}#dev`];
        return;
      }
      delete r.granted[id];
      delete r.declined[id];
      delete r.sources[id];
      r.disabled = r.disabled.filter((d) => d !== id);
      r.customized = r.customized.filter((c) => c !== id);
    });
    this.asked.delete(id);
    await this.refresh();
    if (deleted) this.services.events.emit("files.didDelete", { path: record.root });
    return { deleted };
  }

  // ---- Permissions for commands ----------------------------------------------------------------

  /** The dispatcher's question for `caller: ext` (D102). */
  async authorize(request: AuthorizeRequest & { extension: string }): Promise<Decision> {
    const { extension, commandId, effects } = request;
    const loaded = this.loaded.get(extension);
    if (!loaded) return "deny";
    const own = loaded.runtime.manifest.contributes.commands.some((c) => c.id === commandId);
    if (own) return "allow";
    const granted = this.granted(extension);
    const needed = requiredPermissions(commandId, effects);
    const missing = needed.filter((p) => !hasPermission(granted, p));
    if (missing.length) {
      this.log(
        extension,
        "warn",
        `Denied ${commandId}: needs ${missing.map((p) => `"${p}"`).join(", ")}.`,
      );
      return "deny";
    }
    // Managing extensions (install a version, disable, auto update…) changes what code runs: an
    // extension needs the user's yes, whatever it was granted (D261). Reading never asks.
    const manages =
      commandId.startsWith("extensions.") && !effects.every((e) => e === "read") && effects.length;
    if (effects.includes("destructive") || manages) {
      const answer = await showDialog<boolean>({
        title: request.title,
        message: `${loaded.runtime.manifest.displayName} wants to run "${request.title}".${request.confirmMessage ? `\n\n${request.confirmMessage}` : ""}`,
        actions: [
          { label: "Cancel", value: false, variant: "secondary" },
          { label: "Allow", value: true, variant: "danger" },
        ],
        cancelValue: false,
        defaultValue: false,
      });
      return answer ? "allow" : "deny";
    }
    return "allow";
  }

  // ---- Logs ------------------------------------------------------------------------------------

  private log(id: string, level: LogLine["level"], text: string): void {
    this.pushLog(id, { time: Date.now(), level, text });
  }

  private pushLog(id: string, line: LogLine): void {
    const list = this.logs.get(id) ?? [];
    list.push(line);
    if (list.length > MAX_LOG) list.splice(0, list.length - MAX_LOG);
    this.logs.set(id, list);
    // The Extension host output channel and its file (D209).
    output.append(
      "exthost",
      line.level === "log" ? "info" : line.level,
      `[${id}] ${line.text}`,
      undefined,
      id,
    );
    const prefix = `[ext ${id}]`;
    if (line.level === "error") console.error(prefix, line.text);
    else if (line.level === "warn") console.warn(prefix, line.text);
    else console.info(prefix, line.text);
  }

  logOf(id: string): readonly LogLine[] {
    return this.logs.get(id) ?? [];
  }

  isRunning(id: string): boolean {
    return this.loaded.get(id)?.runtime.running ?? false;
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.timer);
    for (const loaded of this.loaded.values()) loaded.runtime.dispose();
    this.loaded.clear();
    this.subscriptions.dispose();
  }
}

/** A VS Code package's extensionDependencies (D295), itself left out. */
function dependenciesOf(packageJson: string, self: string): string[] {
  try {
    return extensionDependencies(JSON.parse(packageJson)).filter((d) => d !== self);
  } catch {
    return [];
  }
}

/** Writes a new id into a development copy's manifest (extension.json `id`; VS Code: `name`). */
/** A folder's manifest, a VS Code package's `%key%` strings resolved first (D256). */
function manifestOf(entry: ExtEntry): ThirdPartyManifest {
  let nls: unknown;
  try {
    nls = entry.nls ? JSON.parse(entry.nls) : undefined;
  } catch {
    nls = undefined;
  }
  const value = localizePackage(JSON.parse(entry.manifest) as unknown, nls);
  return parseManifest(value, entry.manifestFile);
}

async function rewriteManifestId(root: string, manifestFile: string, id: string): Promise<void> {
  const path = joinPath(root, manifestFile);
  const text = new TextDecoder().decode(await fsIpc.read(path));
  const json = JSON.parse(text) as Record<string, unknown>;
  if (manifestFile === "package.json") {
    const dot = id.indexOf(".");
    json.name = dot > 0 ? id.slice(dot + 1) : id;
    if (dot > 0) json.publisher = id.slice(0, dot);
  } else json.id = id;
  await fsIpc.write(path, new TextEncoder().encode(`${JSON.stringify(json, null, 2)}\n`), "user");
}
