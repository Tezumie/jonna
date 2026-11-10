// Starts language servers on demand (the first document of one of their languages), wires each to
// a LanguageClient over the Rust host, publishes running clients to the editor, keeps a log, and
// stops everything when the folder closes.
import { lspChannel, output } from "../../core/diagnostics/output";
import { Emitter } from "../../core/events/index";
import { lspIpc } from "../../core/ipc/process";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { LanguageClient } from "../../core/lsp/client";
import { product } from "../../core/product";
import { signal } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { expandArgs, resolveServers, type ServerConfig } from "./servers";

export type ServerState = "starting" | "running" | "stopped" | "failed" | "missing";

export interface ServerStatus {
  name: string;
  languages: readonly string[];
  command: string;
  source: string;
  state: ServerState;
  error?: string;
  pid?: number;
}

interface Runtime {
  config: ServerConfig;
  status: ServerStatus;
  client?: LanguageClient;
  scope: DisposableStore;
  /** Published to the editor while running. */
  published?: Disposable;
  log: string[];
  /**
   * Settles once the process spawn has been answered (either way). Stopping waits for it, so a
   * process still being spawned when Stop lands is killed rather than left running.
   */
  spawned: Promise<void>;
}

const LOG_LINES = 1000;
/** Crash restarts (restartAfterCrash): how many, within what time, after what pause. */
const CRASH_LIMIT = 4;
const CRASH_WINDOW_MS = 3 * 60_000;
const CRASH_RESTART_DELAY_MS = 1000;

/** `settings` value at a dotted section ("python.analysis"), or the whole object. */
export function section(
  settings: Record<string, unknown> | undefined,
  key: string | undefined,
): unknown {
  if (!settings) return null;
  if (!key) return settings;
  let at: unknown = settings;
  for (const part of key.split(".")) {
    if (!at || typeof at !== "object") return null;
    at = (at as Record<string, unknown>)[part];
  }
  return at ?? null;
}

/** `extra` merged over `base`, objects key by key (D200: the Python interpreter over pyright's). */
export function mergeSettings(
  base: Record<string, unknown> | undefined,
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!extra) return base;
  if (!base) return extra;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    const b = out[k];
    out[k] =
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      b &&
      typeof b === "object" &&
      !Array.isArray(b)
        ? mergeSettings(b as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}

export class LspManager implements Disposable {
  /**
   * Settings the IDE adds for a server at the time it asks (D200: python.pythonPath from the
   * chosen interpreter), over the server's own.
   */
  extraSettings: (
    config: ServerConfig,
    /** The file or folder the server asked for (D251: each folder its own interpreter). */
    scope?: string,
  ) => Record<string, unknown> | undefined = () => undefined;
  private readonly runtimes = new Map<string, Runtime>();
  /** Which runtime's process is running under each name (the host keys processes by name). */
  private readonly processOwner = new Map<string, Runtime>();
  /** When each server crashed lately (restartAfterCrash). */
  private readonly crashes = new Map<string, number[]>();
  private readonly restartTimers = new Set<ReturnType<typeof setTimeout>>();
  readonly statuses = signal<readonly ServerStatus[]>([]);
  private readonly logEmitter = new Emitter<string>();
  readonly onLog = this.logEmitter.event;
  /** A server wasn't found on PATH (D199: offered for install). */
  private readonly missingEmitter = new Emitter<ServerConfig>();
  readonly onMissing = this.missingEmitter.event;
  /** A server that started and then failed (its message): a repair can be offered (D369). */
  private readonly failedEmitter = new Emitter<{ config: ServerConfig; message: string }>();
  readonly onFailed = this.failedEmitter.event;
  /** Running clients changed their work progress ("indexing…"). */
  private readonly progressEmitter = new Emitter<void>();
  readonly onProgress = this.progressEmitter.event;

  constructor(private readonly services: WorkbenchServices) {}

  configs(): ServerConfig[] {
    return this.allConfigs().filter((c) => !this.yieldsTo(c));
  }

  /** Every configured server, those stepping aside for an extension included. */
  private allConfigs(): ServerConfig[] {
    if (this.services.settings.peek<boolean>("lsp.enabled") === false) return [];
    // Plugins' servers (D375) count as contributed: the user's lsp.servers still go over them.
    return resolveServers(
      {
        ...this.services.languageClients.contributed,
        ...this.services.languageClients.plugins.peek(),
      },
      this.services.settings.peek("lsp.servers"),
    );
  }

  /** The enabled extension a server steps aside for (its `yieldTo`), or undefined. */
  yieldsTo(config: ServerConfig): string | undefined {
    const enabled = this.services.extensionGate.enabledIds.peek();
    for (const entry of config.yieldTo ?? []) {
      const id = (typeof entry === "string" ? entry : entry.extension).toLowerCase();
      if (!enabled.includes(id)) continue;
      const unless = typeof entry === "string" ? undefined : entry.unlessSetting;
      if (unless && Object.entries(unless).some(([k, v]) => this.services.settings.peek(k) === v))
        continue;
      return id;
    }
    return undefined;
  }

  /** Servers stepping aside now, and for which extension (ide://lsp, the status item). */
  yielded(): { name: string; title: string; extension: string }[] {
    return this.allConfigs().flatMap((c) => {
      const extension = this.yieldsTo(c);
      return extension ? [{ name: c.name, title: c.title ?? c.name, extension }] : [];
    });
  }

  /** A server was wanted while the folder isn't trusted (shown in ide://lsp). */
  waitingForTrust = false;

  /** Starts every configured server for `languageId` that isn't running or known missing. */
  ensureFor(languageId: string): void {
    // Language servers run the folder's own code (its TypeScript, rust-analyzer's build scripts
    // and proc macros, gopls' go list): only in a trusted folder, like tasks (D207 audit). The
    // extension starts them for the open files once the folder is trusted.
    if (!this.services.trust.trusted) {
      if (this.configs().some((c) => c.languages.includes(languageId))) this.waitingForTrust = true;
      return;
    }
    for (const config of this.configs()) {
      if (!config.languages.includes(languageId)) continue;
      const existing = this.runtimes.get(config.name);
      if (existing && existing.status.state !== "stopped") continue;
      void this.start(config);
    }
  }

  /** Answers a server's question (set by the extension: a notification with its buttons). */
  ask: (
    config: ServerConfig,
    message: string,
    actions: string[],
    type: number,
  ) => Promise<string | null> = async () => null;

  /** Work the running servers report: "Pyright: indexing 40%". */
  progress(): string[] {
    const out: string[] = [];
    for (const r of this.runtimes.values())
      for (const p of r.client?.progress.values() ?? [])
        out.push(
          `${r.config.title ?? r.config.name}: ${[p.title, p.message].filter(Boolean).join(" ")}${p.percentage !== undefined ? ` ${p.percentage}%` : ""}`,
        );
    return out;
  }

  /** A server's settings as it gets them: its own (with the user's) plus the IDE's extra ones. */
  settingsOf(config: ServerConfig, scope?: string): Record<string, unknown> | undefined {
    return mergeSettings(config.settings, this.extraSettings(config, scope));
  }

  /**
   * Tells running servers whose settings changed (`languages` they handle): the settings go
   * with workspace/didChangeConfiguration (servers that don't pull them read them there), and
   * the others ask again (workspace/configuration).
   */
  configurationChanged(language?: string): void {
    for (const r of this.runtimes.values())
      if (r.status.state === "running" && (!language || r.client?.handles(language)))
        r.client?.didChangeConfiguration(this.settingsOf(r.config) ?? null);
  }

  /** The definitions the starting or running servers were started with (or reconfigured to). */
  liveConfigs(): ServerConfig[] {
    return [...this.runtimes.values()]
      .filter((r) => r.status.state === "starting" || r.status.state === "running")
      .map((r) => r.config);
  }

  /** Servers whose settings alone changed (D204): new settings, no restart. */
  reconfigure(configs: readonly ServerConfig[]): void {
    for (const config of configs) {
      const r = this.runtimes.get(config.name);
      if (!r) continue;
      r.config = config;
      if (r.status.state === "running")
        r.client?.didChangeConfiguration(this.settingsOf(config) ?? null);
    }
  }

  /** Tells running servers about files changed on disk (a checkout, a save elsewhere). */
  filesChanged(changes: { path: string; type: 1 | 2 | 3 }[]): void {
    for (const r of this.runtimes.values())
      if (r.status.state === "running") r.client?.didChangeWatchedFiles(changes);
  }

  /** The workspace's folders as servers get them. */
  private folderList(): { path: string; name: string }[] {
    return this.services.workspace.folders.peek().map((f) => ({ path: f.path, name: f.name }));
  }

  /**
   * Folders were added to or taken out of the workspace (D251): running servers that support it
   * get `workspace/didChangeWorkspaceFolders`; the others keep their first folder (VS Code
   * doesn't restart them either).
   */
  foldersChanged(): void {
    const folders = this.folderList();
    for (const r of this.runtimes.values()) {
      // A starting one answers workspace/workspaceFolders with the new list, and is told the
      // change once initialized.
      if ((r.status.state !== "running" && r.status.state !== "starting") || !r.client) continue;
      const result = r.client.setWorkspaceFolders(folders);
      // A rename only (nothing added or taken out): nothing to say.
      if (r.status.state === "running" && result !== "unchanged")
        this.append(
          r,
          result === "told"
            ? `workspace folders: ${folders.map((f) => f.name).join(", ")}`
            : "workspace folders changed (the server doesn't take folder changes: it keeps its first folder)",
        );
    }
  }

  log(name: string): string[] {
    return this.runtimes.get(name)?.log ?? [];
  }

  clientFor(languageId: string): LanguageClient | undefined {
    for (const r of this.runtimes.values())
      if (r.status.state === "running" && r.client?.handles(languageId)) return r.client;
    return undefined;
  }

  private publish(): void {
    this.statuses.value = [...this.runtimes.values()].map((r) => ({ ...r.status }));
  }

  private append(r: Runtime, line: string): void {
    // Its own output channel and file in the session's logs folder (D209).
    output.append(
      lspChannel(r.config.name),
      "info",
      line,
      `Language server: ${r.config.title ?? r.config.name}`,
      "lsp",
    );
    r.log.push(line);
    if (r.log.length > LOG_LINES) r.log.splice(0, r.log.length - LOG_LINES);
    this.logEmitter.fire(r.config.name);
  }

  async start(config: ServerConfig): Promise<void> {
    const root = this.services.workspace.root.peek();
    if (!root) return;
    const previous = this.runtimes.get(config.name);
    const scope = new DisposableStore();
    let spawned = (): void => {};
    const r: Runtime = {
      config,
      scope,
      log: previous?.log ?? [],
      status: {
        name: config.name,
        languages: config.languages,
        command: config.command,
        source: config.source,
        state: "starting",
      },
      spawned: new Promise<void>((resolve) => {
        spawned = resolve;
      }),
    };
    // Recorded before the first await: a second ensureFor in the same tick (clangd for both c
    // and cpp on restore) must see this one starting, or the server is started twice.
    this.runtimes.set(config.name, r);
    this.publish();
    if (previous) await this.stopRuntime(previous);
    if (!this.isCurrent(r)) {
      // Superseded or stopped while the old one stopped: nothing was spawned.
      scope.dispose();
      spawned();
      return;
    }
    const messages = scope.add(new Emitter<string>());
    const client = scope.add(
      new LanguageClient(
        {
          send: (body) =>
            void lspIpc
              .send(config.name, body)
              .catch((e: unknown) => this.append(r, `send failed: ${e}`)),
          onMessage: messages.event,
        },
        {
          id: config.name,
          // One server per language for the window, with every folder (D251, VS Code's way);
          // `rootUri` and `${workspaceFolder}` in its args are the first.
          rootPath: root,
          folders: this.folderList(),
          languages: config.languages,
          initializationOptions: config.initializationOptions,
          // r.config, not config: a settings-only change updates it without a restart (D204).
          configuration: (key, scope) => section(this.settingsOf(r.config, scope), key),
          clientName: product.nameLong,
        },
      ),
    );
    r.client = client;
    scope.add(client.onLog((line) => this.append(r, line)));
    scope.add(client.onProgress(() => this.progressEmitter.fire()));
    client.ask = (message, actions, type) => this.ask(config, message, actions, type);
    this.append(
      r,
      `[${new Date().toLocaleTimeString()}] starting ${config.command} ${(config.args ?? []).join(" ")}`,
    );
    let pid: number;
    try {
      pid = await lspIpc.start(
        config.name,
        {
          command: config.command,
          args: expandArgs(config.args, root, this.folderList()),
          cwd: root,
        },
        (event) => {
          if (event.kind === "message") messages.fire(event.body);
          else if (event.kind === "stderr") this.append(r, event.line);
          else {
            this.append(r, "server exited");
            // A replaced runtime's exit is expected and must not fail (stop) its successor,
            // which shares the server name.
            if (!this.isCurrent(r)) return;
            const wasRunning = r.status.state === "running";
            client.exited();
            this.fail(r, "The server exited.");
            if (wasRunning) this.restartAfterCrash(r);
          }
        },
      );
    } catch (err) {
      spawned();
      if (!this.isCurrent(r)) {
        scope.dispose();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.append(r, message);
      r.status = {
        ...r.status,
        state: /not found/.test(message) ? "missing" : "failed",
        error: message,
      };
      scope.dispose();
      r.client = undefined;
      this.publish();
      if (r.status.state === "missing") this.missingEmitter.fire(config);
      // Built-in definitions for tools you don't have are expected; your own settings aren't.
      if (config.source === "settings")
        this.services.notifications.show("error", `Language server ${config.name}: ${message}`);
      return;
    }
    this.processOwner.set(config.name, r);
    spawned();
    // Stopped while spawning: stopRuntime (waiting on `spawned`) now stops the process.
    if (!this.isCurrent(r)) return;
    r.status = { ...r.status, pid };
    try {
      await client.start(pid);
    } catch (err) {
      this.fail(r, err instanceof Error ? err.message : String(err));
      return;
    }
    if (!this.isCurrent(r)) return;
    // Servers that read their settings from didChangeConfiguration only (typescript-language-
    // server) get them now, as VS Code sends them after initialized.
    const initial = this.settingsOf(r.config);
    if (initial && Object.keys(initial).length) client.didChangeConfiguration(initial);
    r.status = { ...r.status, state: "running" };
    r.published = this.services.languageClients.add(client);
    this.publish();
  }

  /**
   * A server that crashed while running starts again, like VS Code: at most CRASH_LIMIT times in
   * CRASH_WINDOW_MS, after a short pause; then it stays failed (the status bar offers Restart).
   */
  private restartAfterCrash(r: Runtime): void {
    const name = r.config.name;
    const now = Date.now();
    const recent = (this.crashes.get(name) ?? []).filter((t) => now - t < CRASH_WINDOW_MS);
    recent.push(now);
    this.crashes.set(name, recent);
    if (recent.length > CRASH_LIMIT) {
      this.append(r, `The server crashed ${recent.length} times in 3 minutes: not restarted.`);
      this.services.notifications.show(
        "error",
        `Language server ${r.config.title ?? name} crashed ${recent.length} times in 3 minutes and won't be restarted. See its log.`,
      );
      return;
    }
    this.append(r, "restarting after the crash…");
    const timer = setTimeout(() => {
      this.restartTimers.delete(timer);
      // Still the failed runtime (not restarted by hand, stopped, or the folder closed).
      if (this.runtimes.get(name) === r && r.status.state === "failed") void this.start(r.config);
    }, CRASH_RESTART_DELAY_MS);
    this.restartTimers.add(timer);
  }

  /** `r` is still the live runtime for its name (not replaced, not stopped). */
  private isCurrent(r: Runtime): boolean {
    return this.runtimes.get(r.config.name) === r && r.status.state !== "stopped";
  }

  private fail(r: Runtime, message: string): void {
    // A stale runtime failing late must not stop the process its successor started; one that
    // already failed (its exit arriving after) has nothing left to tear down.
    if (!this.isCurrent(r) || (r.status.state !== "starting" && r.status.state !== "running"))
      return;
    this.append(r, message);
    r.status = { ...r.status, state: "failed", error: message };
    this.failedEmitter.fire({ config: r.config, message });
    r.published?.dispose();
    r.published = undefined;
    r.scope.dispose();
    r.client = undefined;
    if (this.processOwner.get(r.config.name) === r) {
      this.processOwner.delete(r.config.name);
      void lspIpc.stop(r.config.name).catch(() => {});
    }
    this.publish();
  }

  async stop(name: string): Promise<void> {
    const r = this.runtimes.get(name);
    if (r) await this.stopRuntime(r);
  }

  private async stopRuntime(r: Runtime): Promise<void> {
    if (r.status.state !== "starting" && r.status.state !== "running") return;
    r.status = { ...r.status, state: "stopped" };
    r.published?.dispose(); // the editor detaches first
    r.published = undefined;
    this.publish();
    // Still spawning: wait for the answer so the process it starts is stopped below.
    await r.spawned;
    const client = r.client;
    r.client = undefined;
    await client?.stop().catch(() => {});
    r.scope.clear();
    // Processes are keyed by name: stop it only if it's still ours, not a newer runtime's.
    if (this.processOwner.get(r.config.name) === r) {
      this.processOwner.delete(r.config.name);
      await lspIpc.stop(r.config.name).catch(() => {});
    }
    this.publish();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map((n) => this.stop(n)));
  }

  /** Forget everything (folder closed). */
  async reset(): Promise<void> {
    this.clearRestarts();
    await this.stopAll();
    this.runtimes.clear();
    this.publish();
  }

  private clearRestarts(): void {
    for (const t of this.restartTimers) clearTimeout(t);
    this.restartTimers.clear();
    this.crashes.clear();
  }

  dispose(): void {
    this.clearRestarts();
    void this.stopAll();
    this.logEmitter.dispose();
    this.missingEmitter.dispose();
    this.failedEmitter.dispose();
    this.progressEmitter.dispose();
  }
}
