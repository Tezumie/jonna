// Programs an extension runs (`ide.process.spawn`, D202), for a language kernel, a formatter, a
// tool's server. Built on the stdio host the language servers use (lspIpc, src-tauri/src/lsp):
// stdout arrives a line at a time, stderr lines and the exit separately. Needs "shell" and a
// trusted folder, like the folder's own tasks; at most MAX_PROCESSES per extension, and all of
// them are killed when the extension stops, its worker dies or the folder closes.
import type { ProcessBatch, ProcessEvent } from "../../core/extensions/rpc";
import type { ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { lspIpc } from "../../core/ipc/process";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { isWithin } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";

export const MAX_PROCESSES = 8;
/** For the IDE's own shipped extensions (Jupyter: a kernel per open notebook, D203 audit). */
export const MAX_PROCESSES_SHIPPED = 32;
/** Events sent to the worker in one call, and how long output is gathered first (ms). */
const MAX_BATCH = 256;
const BATCH_MS = 8;
const MAX_SEND = 16 * 1024 * 1024;
const MAX_STDERR_LINE = 8 * 1024;

export interface ProcessHostDeps {
  /** One of the IDE's own extensions, as shipped (a higher process limit). */
  shipped?: boolean;
  manifest: ThirdPartyManifest;
  services: WorkbenchServices;
  /** The extension's folder. */
  root: string;
  need(permission: string, what: string): void;
  /** Sends a batch of a process's events to the worker (dropped when it isn't running). */
  post(processId: string, batch: ProcessBatch): void;
}

interface Running {
  ipcId: string;
  framing: "lines" | "ndjson";
  /** Stopped by the extension or the IDE (the exit then reports signal "SIGKILL"). */
  killed: boolean;
  exited: boolean;
  queue: ProcessEvent[];
  timer: number;
}

let nextSeq = 0;

export class ExtensionProcesses implements Disposable {
  private readonly store = new DisposableStore();
  private readonly running = new Map<string, Running>();
  /** Spawns that are waiting for the trust question or the start. */
  private starting = 0;
  private disposed = false;
  /** Bumped when the worker goes: a spawn it asked for before then doesn't start after. */
  private workerGeneration = 0;

  constructor(private readonly deps: ProcessHostDeps) {
    // The open folder is where they run: closing it ends them (as for the folder's tasks).
    this.store.add(deps.services.workspace.onDidClose(() => this.killAll()));
    // Trust taken back (restricted mode): what was started for the folder stops too.
    this.store.add(
      effect(() => {
        if (deps.services.trust.state.value === "restricted") this.killAll();
        return undefined;
      }),
    );
  }

  get count(): number {
    return this.running.size;
  }

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    switch (method) {
      case "process.spawn":
        return this.spawn(p);
      case "process.send":
        return this.send(p);
      case "process.kill":
        return this.kill(String(p.id));
      case "process.closeStdin":
        return this.live(p.id).then((e) => lspIpc.closeStdin(e.ipcId));
      case "process.interrupt":
        return this.live(p.id).then((e) => lspIpc.interrupt(e.ipcId));
      default:
        return UNHANDLED;
    }
  }

  private async spawn(p: Record<string, unknown>): Promise<void> {
    const { manifest, services } = this.deps;
    this.deps.need("shell", "run programs");
    const id = String(p.id ?? "");
    if (!/^p\d{1,9}$/.test(id) || this.running.has(id)) throw new Error("Bad process id.");
    const command = typeof p.command === "string" ? p.command.trim() : "";
    if (!command || command.length > 1000) throw new Error("process.spawn needs a command.");
    const args = Array.isArray(p.args) ? p.args : [];
    if (args.length > 500 || !args.every((a) => typeof a === "string" && a.length <= 32_768))
      throw new Error("args must be a list of strings.");
    const env: Record<string, string> = {};
    if (p.env !== undefined) {
      if (!p.env || typeof p.env !== "object") throw new Error("env must be an object.");
      const entries = Object.entries(p.env as Record<string, unknown>);
      if (entries.length > 200) throw new Error("env has too many variables.");
      for (const [k, v] of entries) {
        if (typeof v !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
          throw new Error(`env.${k}: names are letters, digits and _, values strings.`);
        env[k] = v;
      }
    }
    const framing = p.framing === "ndjson" ? "ndjson" : "lines";
    const max = this.deps.shipped ? MAX_PROCESSES_SHIPPED : MAX_PROCESSES;
    if (this.running.size + this.starting >= max)
      throw new Error(`An extension can run at most ${max} processes at a time.`);
    const root = services.workspace.root.peek();
    if (!root) throw new Error("Open a folder first: an extension's processes run in it.");
    const generation = this.workerGeneration;
    this.starting++;
    try {
      // The folder's trust, as for its tasks: a program started for it may run its code (a
      // notebook's kernel imports the project's modules).
      await services.trust.require(`${manifest.displayName}'s program “${basename(command)}”`);
      // Stopped, or its worker went while the user was asked (a new one reuses the ids).
      if (this.disposed || generation !== this.workerGeneration)
        throw new Error(`${manifest.displayName} has stopped.`);
      if (services.workspace.root.peek() !== root) throw new Error("The folder closed.");
      const cwd = this.cwd(root, p.cwd);
      const ipcId = `ext:${manifest.id}:${++nextSeq}`;
      const entry: Running = {
        ipcId,
        framing,
        killed: false,
        exited: false,
        queue: [],
        timer: 0,
      };
      this.running.set(id, entry);
      try {
        await lspIpc.start(
          ipcId,
          { command, args: args as string[], cwd, env, framing: "ndjson" },
          (e) => {
            if (e.kind === "message") this.push(id, entry, { kind: "message", body: e.body });
            else if (e.kind === "stderr")
              this.push(id, entry, { kind: "stderr", line: e.line.slice(0, MAX_STDERR_LINE) });
            else this.ended(id, entry, e.code);
          },
        );
      } catch (err) {
        this.running.delete(id);
        throw err;
      }
      // Stopped while it started (the extension, the folder, trust or the worker went): the
      // stop sent then may have come before the host knew the id, so it's stopped now.
      if (this.disposed || entry.killed) {
        void lspIpc.stop(ipcId).catch(() => {});
        if (entry.killed && !this.disposed)
          throw new Error("The process was stopped while it started.");
      }
    } finally {
      this.starting--;
    }
  }

  /**
   * The working directory: the (first) folder by default; inside one of the workspace's folders
   * (D251: relative ones as the workspace resolves them) or the extension's folder.
   */
  private cwd(root: string, raw: unknown): string {
    if (raw === undefined || raw === null || raw === "") return root;
    if (typeof raw !== "string") throw new Error("cwd must be a string.");
    const { workspace } = this.deps.services;
    const full = workspace.resolve(raw);
    if (workspace.contains(full) || isWithin(this.deps.root, full)) return full;
    throw new Error(
      workspace.folders.peek().length > 1
        ? `cwd ${raw} is outside the workspace's folders and the extension's folder.`
        : `cwd ${raw} is outside the open folder and the extension's folder.`,
    );
  }

  private async send(p: Record<string, unknown>): Promise<void> {
    const entry = this.running.get(String(p.id));
    if (!entry || entry.exited) throw new Error(`Process ${String(p.id)} isn't running.`);
    const data = p.data;
    let lines: string[];
    if (entry.framing === "ndjson" && typeof data !== "string") {
      lines = [JSON.stringify(data ?? null)];
    } else {
      if (typeof data !== "string") throw new Error("send() takes a string (or JSON with ndjson).");
      // The host writes one line per message: a multi-line string is several lines.
      lines = entry.framing === "lines" ? data.replace(/\r?\n$/, "").split(/\r?\n/) : [data];
    }
    if (lines.reduce((n, l) => n + l.length + 1, 0) > MAX_SEND || lines.length > 100_000)
      throw new Error("Too much to send at once (16 MB or 100 000 lines).");
    for (const line of lines) await lspIpc.send(entry.ipcId, line);
  }

  /** A process of this extension that's still running. */
  private async live(id: unknown): Promise<Running> {
    const entry = this.running.get(String(id));
    if (!entry || entry.exited || entry.killed)
      throw new Error(`Process ${String(id)} isn't running.`);
    return entry;
  }

  private async kill(id: string): Promise<void> {
    const entry = this.running.get(id);
    if (!entry || entry.exited) return;
    entry.killed = true;
    await lspIpc.stop(entry.ipcId).catch(() => {});
  }

  private push(id: string, entry: Running, event: ProcessEvent): void {
    if (entry.exited) return;
    entry.queue.push(event);
    if (entry.queue.length >= MAX_BATCH) this.flush(id, entry);
    else if (!entry.timer) entry.timer = window.setTimeout(() => this.flush(id, entry), BATCH_MS);
  }

  private flush(id: string, entry: Running): void {
    window.clearTimeout(entry.timer);
    entry.timer = 0;
    if (!entry.queue.length) return;
    const events = entry.queue.splice(0);
    if (!this.disposed) this.deps.post(id, { events });
  }

  private ended(id: string, entry: Running, code: number | null): void {
    if (entry.exited) return;
    entry.queue.push({ kind: "exit", code, ...(entry.killed && { signal: "SIGKILL" }) });
    this.flush(id, entry);
    entry.exited = true;
    if (this.running.get(id) === entry) this.running.delete(id);
  }

  /** Ends every process (the folder closed, the worker died, the extension stops). */
  killAll(workerGone = false): void {
    for (const entry of this.running.values()) {
      entry.killed = true;
      window.clearTimeout(entry.timer);
      void lspIpc.stop(entry.ipcId).catch(() => {});
      // The worker that knew them is gone: nothing more goes to the next one (it counts its
      // ids from p1 again).
      if (workerGone) entry.exited = true;
    }
    if (workerGone) {
      this.running.clear();
      this.workerGeneration++;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.killAll();
    this.disposed = true;
    this.running.clear();
    this.store.dispose();
  }
}

function basename(command: string): string {
  return command.split(/[\\/]/).pop() || command;
}
