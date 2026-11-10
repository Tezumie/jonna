// The shared Node extension host (D295): every VS Code package runs in one Node process, as in
// VS Code, so another extension's exports are live objects and synchronous APIs stay
// synchronous. Each extension still has its own ExtensionRuntime and ExtensionWorker here, talking
// to its own slice of the process: messages carry the extension's id (`x`), so every request is
// answered (and its permissions checked) as that extension's. The process starts with the first
// extension and ends with the last; when it dies, every extension in it gets the crash, and the
// manager restarts them (`onDidCrash`, at most 3 times in 5 minutes as VS Code). An extension
// unloaded in place has its timers cleared there (hostResources.ts); one that loaded native
// addons ends the process instead (they can't be unloaded, and Windows locks their files), and
// the others start again in a new one before its folder is deleted or replaced. The process runs
// in the host script's folder, not an extension's (VS Code's extension host doesn't run in one
// either): an extension spawning a program by a path relative to its own folder must join it to
// `extensionPath`, as in VS Code — `process.chdir` would move every extension's working folder.

import type {
  ExtensionsListMessage,
  FromWorker,
  Tagged,
  ToWorker,
} from "../../core/extensions/rpc";
import type { Disposable } from "../../core/lifecycle/index";
import { type HostTransport, nodeTransport } from "./workerHost";

/** How long an extension's unload may take before its slice is let go anyway. */
const UNLOAD_MS = 3000;

interface Slice {
  messages: ((m: FromWorker) => void)[];
  errors: ((e: string) => void)[];
  /** Its unload is done; `native`: it loaded native addons (the process must end). */
  unloaded?: (native?: boolean) => void;
}

/** Starts a host process (nodeTransport; a test's fake). */
export type StartHost = (
  name: string,
  /** Where the process starts (a folder the IDE lets a process start in; it then moves). */
  root: string,
  onStderr: (line: string) => void,
  program: string,
) => Promise<HostTransport>;

export class SharedNodeHost implements Disposable {
  private process: Promise<HostTransport> | null = null;
  /** The process once started (`process` resolved), the one whose messages count. */
  private current: HostTransport | null = null;
  private readonly slices = new Map<string, Slice>();
  /** Each process gets its own id: a new one may start while the last one still exits. */
  private generation = 0;
  private installed: ExtensionsListMessage["list"] = [];
  private readonly crashListeners = new Set<(error: string, planned: boolean) => void>();
  private disposed = false;

  constructor(
    /** The process's own output (stderr, and console output no extension's file is on). */
    private readonly log: (level: "info" | "warn" | "error", text: string) => void,
    private readonly startHost: StartHost = (name, root, onStderr, program) =>
      nodeTransport(name, root, onStderr, program),
  ) {}

  /** Extensions in it now. */
  get size(): number {
    return this.slices.size;
  }

  /**
   * The installed and enabled VS Code packages (`vscode.extensions`): sent now and to every new
   * process before its first extension.
   */
  setInstalled(list: ExtensionsListMessage["list"]): void {
    if (JSON.stringify(list) === JSON.stringify(this.installed)) return;
    this.installed = list;
    void this.process?.then((p) => p.post({ t: "extensions", list })).catch(() => {});
  }

  /**
   * Called with the error after every extension in a dead process was told. `planned`: the IDE
   * ended it (an extension with native addons left, nativeRestart) — not a crash: its extensions
   * start again without counting against the crash limit.
   */
  onDidCrash(listener: (error: string, planned: boolean) => void): Disposable {
    this.crashListeners.add(listener);
    return { dispose: () => this.crashListeners.delete(listener) };
  }

  /**
   * `extensionId`'s side of the process (started with `program` when none runs, in `root`: the
   * folder of the extension that starts it, a place a process may run in — the open folder or an
   * extension's own, D202; the app data folder isn't one).
   */
  async connect(extensionId: string, program: string, root: string): Promise<HostTransport> {
    if (this.disposed) throw new Error("The extension host has stopped.");
    let process = await this.ensureProcess(program, root);
    // The last extension's stop ended that process meanwhile: a new one.
    for (let tries = 0; process !== this.current && tries < 3; tries++)
      process = await this.ensureProcess(program, root);
    if (process !== this.current) throw new Error("The extension host didn't start.");
    // A slice still unloading (a reload) is let go once the new one is in: messages go to it.
    const old = this.slices.get(extensionId);
    const slice: Slice = { messages: [], errors: [] };
    this.slices.set(extensionId, slice);
    old?.unloaded?.();
    const own = () => this.slices.get(extensionId) === slice;
    return {
      post: (m) => {
        if (own()) process.post({ ...m, x: extensionId } as Tagged<ToWorker>);
      },
      onMessage: (h) => slice.messages.push(h),
      onError: (h) => slice.errors.push(h),
      terminate: () => {
        if (!own()) return Promise.resolve();
        // Its deactivate (if the stop's call didn't run it) and its modules dropped; the slice
        // waits for that, so a reload doesn't load the old files again.
        return new Promise<void>((resolve) => {
          const timer = setTimeout(() => done(), UNLOAD_MS);
          let finished = false;
          const done = (native?: boolean) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (this.slices.get(extensionId) === slice) this.slices.delete(extensionId);
            // Its native addons stay loaded (and, on Windows, their files locked) until the
            // process ends: it restarts before the caller deletes or replaces the folder.
            const ending = native
              ? this.nativeRestart(process, extensionId)
              : this.stopWhenEmpty(process);
            void ending.then(resolve, resolve);
          };
          slice.unloaded = done;
          process.post({ t: "unload", x: extensionId } as Tagged<ToWorker>);
        });
      },
    };
  }

  private ensureProcess(program: string, root: string): Promise<HostTransport> {
    if (this.process) return this.process;
    const generation = ++this.generation;
    const started = this.startHost(
      `shared-${generation}`,
      root,
      (line) => this.log("warn", line),
      program,
    ).then((process) => {
      if (this.process !== started || this.disposed) {
        void Promise.resolve(process.terminate()).catch(() => {});
        throw new Error("The extension host has stopped.");
      }
      this.current = process;
      process.onMessage((m) => this.receive(process, m as Tagged<FromWorker>));
      process.onError((error) => this.crashed(process, error));
      process.post({ t: "extensions", list: this.installed });
      return process;
    });
    this.process = started;
    // A process that couldn't start: the next connect tries again.
    started.catch(() => {
      if (this.process === started) this.process = null;
    });
    return started;
  }

  private receive(process: HostTransport, m: Tagged<FromWorker>): void {
    // Only the running process's messages count (an old one may still be exiting).
    if (process !== this.current || !m || typeof m !== "object") return;
    const id = typeof m.x === "string" ? m.x : undefined;
    if (id === undefined) {
      if (m.t === "log") this.log(m.level === "log" ? "info" : m.level, String(m.text));
      return;
    }
    const slice = this.slices.get(id);
    if (!slice) return;
    if (m.t === "unloaded") {
      slice.unloaded?.(Array.isArray(m.native) && m.native.length > 0);
      return;
    }
    const { x: _x, ...message } = m;
    for (const h of slice.messages) h(message as FromWorker);
  }

  private crashed(process: HostTransport, error: string, planned = false): void {
    if (process !== this.current) return;
    this.current = null;
    this.process = null;
    const lost = [...this.slices.values()];
    this.slices.clear();
    this.log(planned ? "info" : "error", `The extension host ended: ${error}`);
    for (const slice of lost) {
      slice.unloaded?.();
      for (const h of slice.errors) h(error);
    }
    for (const l of [...this.crashListeners]) l(error, planned);
  }

  /** The last extension left: the process ends (its files, and Node, are free again). */
  private async stopWhenEmpty(process: HostTransport): Promise<void> {
    if (this.slices.size || process !== this.current) return;
    this.current = null;
    this.process = null;
    await Promise.resolve(process.terminate()).catch(() => {});
  }

  /**
   * `extensionId` left with native addons loaded (D295): Node can't unload them and Windows keeps
   * their files locked, so — as VS Code restarts its extension host to remove or update an
   * extension — the process ends; the other extensions in it are told it ended (planned) and the
   * manager starts them again in a new one. Resolves once the old process has exited.
   */
  private async nativeRestart(process: HostTransport, extensionId: string): Promise<void> {
    if (process !== this.current) return;
    if (!this.slices.size) return this.stopWhenEmpty(process);
    const ended = Promise.resolve(process.terminate()).catch(() => {});
    this.crashed(
      process,
      `restarted to unload ${extensionId}, which loaded native modules that can't be unloaded while the extension host runs`,
      true,
    );
    await ended;
  }

  dispose(): void {
    this.disposed = true;
    const process = this.current;
    this.current = null;
    this.process = null;
    this.slices.clear();
    this.crashListeners.clear();
    void Promise.resolve(process?.terminate()).catch(() => {});
  }
}
