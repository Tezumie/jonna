// One extension's worker (PLAN §9.4, D102): starts it with the extension's main file, answers its
// requests through `handle` (the runtime checks permissions there), and calls into it for the
// extension's command handlers, tree data, webview messages and events. A worker that doesn't
// start (an IDE-format one within ACTIVATION_MS) or dies is reported as failed; one whose
// activate threw keeps running, failed (ActivationFailed, D295). Where the code runs is its
// transport: the sandboxed Web Worker, a Node process of its own (D255, `nodeTransport`,
// src/workers/extension.node.ts) speaking the same messages as JSON lines, or its slice of the
// shared Node host every VS Code package runs in (D295, sharedHost.ts).

import type {
  CallMessage,
  FromWorker,
  InitMessage,
  RequestMessage,
  ToWorker,
} from "../../core/extensions/rpc";
import { extIpc } from "../../core/ipc/extensions";
import { lspIpc } from "../../core/ipc/process";
import { appIpc } from "../../core/ipc/system";
import type { Disposable } from "../../core/lifecycle/index";

/** Where an extension's code runs, as the worker host talks to it. */
export interface HostTransport {
  post(message: ToWorker): void;
  onMessage(handler: (message: FromWorker) => void): void;
  /** It failed to load or died. */
  onError(handler: (error: string) => void): void;
  /** Ends it; a Node process resolves once it has exited (D261: its files are free then). */
  terminate(): void | Promise<void>;
}

/** The sandboxed Web Worker (the default). */
export function webWorkerTransport(name: string): HostTransport {
  const worker = new Worker("./workers/extension.worker.js", { name: `ext:${name}` });
  return {
    post: (m) => worker.postMessage(m),
    onMessage: (h) =>
      worker.addEventListener("message", (e: MessageEvent) => h(e.data as FromWorker)),
    onError: (h) =>
      worker.addEventListener("error", (e: ErrorEvent) => {
        e.preventDefault();
        h(e.message || "the worker failed");
      }),
    terminate: () => worker.terminate(),
  };
}

let hostText: Promise<string> | null = null;
/**
 * The Node host's script on disk, written from the app's own copy. Asked before every start, not
 * once (D285): another version of the IDE running beside this one (an update installed, a dev
 * build) could have removed this one's copy, and Node then failed with "Cannot find module" —
 * Claude Code's icon and status item gone, Live Server "failed". The backend writes it only when
 * it's missing.
 */
function nodeHostScript(): Promise<string> {
  // A chunk of its own (build.mjs), loaded the first time a Node extension starts.
  hostText ??= import("virtual:node-host")
    .then((m) => m.default)
    .catch((err: unknown) => {
      hostText = null;
      throw err;
    });
  return hostText.then((text) => extIpc.nodeHostScript(text));
}

/**
 * A Node process for one extension (D255): `node <host script>` in the extension's folder, one
 * JSON message per line. Its stderr goes to the log; its end is a crash unless it was stopped.
 * Rejects when Node can't start (not installed).
 */
export async function nodeTransport(
  extensionId: string,
  root: string,
  onStderr: (line: string) => void,
  /** `node` on PATH, or the pinned one the IDE downloaded (nodeRuntime.ts, D267). */
  program = "node",
): Promise<HostTransport> {
  const script = await nodeHostScript();
  const id = `ext-node:${extensionId}`;
  const messages: ((m: FromWorker) => void)[] = [];
  const errors: ((e: string) => void)[] = [];
  let stopped = false;
  // Its last words: why Node ended goes into the error, not only the log (D261).
  const lastLines: string[] = [];
  const stderr = (line: string) => {
    lastLines.push(line);
    if (lastLines.length > 4) lastLines.shift();
    onStderr(line);
  };
  const start = () =>
    lspIpc.start(
      id,
      {
        command: program,
        args: [script],
        // The shared host (D295) isn't one extension's: it runs in the script's own folder.
        cwd: root || script.replace(/[\\/][^\\/]*$/, ""),
        framing: "ndjson",
      },
      (event) => {
        if (event.kind === "message") {
          try {
            const m = JSON.parse(event.body) as FromWorker;
            for (const h of messages) h(m);
          } catch {
            stderr(event.body);
          }
        } else if (event.kind === "stderr") stderr(event.line);
        else if (!stopped) {
          const why = lastLines
            .filter((l) => l.trim())
            .join(" ")
            .slice(-400);
          for (const h of errors)
            h(`Node ended (exit code ${event.code ?? "unknown"})${why ? `: ${why}` : ""}`);
        }
      },
    );
  const notFound = (err: unknown) =>
    /not found|cannot find|no such file|os error 2/i.test(
      err instanceof Error ? err.message : String(err),
    );
  await start()
    .catch(async (err: unknown) => {
      // Installed since the IDE started, or by an installer that only changed PATH for new
      // processes: PATH is read again from the system, once (D261, as language servers do).
      if (!notFound(err) || !(await appIpc.refreshPath().catch(() => false))) throw err;
      return start();
    })
    .catch((err: unknown) => {
      const text = err instanceof Error ? err.message : String(err);
      throw new Error(
        notFound(err)
          ? "Node.js wasn't found on PATH: this extension runs in Node. Install Node.js 18 or newer from nodejs.org (with fnm or nvm, make a version the default for all programs, not only your shell), then try again."
          : text,
      );
    });
  return {
    post: (m) => void lspIpc.send(id, JSON.stringify(m)).catch(() => {}),
    onMessage: (h) => messages.push(h),
    onError: (h) => errors.push(h),
    terminate: () => {
      stopped = true;
      return lspIpc.stop(id).catch(() => {});
    },
  };
}

const ACTIVATION_MS = 10_000;
/** When a VS Code package's activation is called slow in its log (D295: never failed for it). */
const SLOW_ACTIVATION_MS = 10_000;

/** The extension's `activate` threw (D295): it stays as it is, failed, as in VS Code. */
export class ActivationFailed extends Error {}
const CALL_MS = 30_000;
const MAX_LOG = 500;

export interface LogLine {
  time: number;
  level: "log" | "info" | "warn" | "error";
  text: string;
}

export type RequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export class ExtensionWorker implements Disposable {
  private readonly worker: HostTransport;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void; timer: number }
  >();
  private disposed = false;
  readonly log: LogLine[] = [];

  constructor(
    private readonly name: string,
    private readonly handle: RequestHandler,
    private readonly onLog: (line: LogLine) => void,
    private readonly onCrash: (error: string) => void,
    transport?: HostTransport,
  ) {
    this.worker = transport ?? webWorkerTransport(name);
    this.worker.onMessage((m) => this.receive(m));
    this.worker.onError((error) => {
      this.addLog("error", error);
      if (!this.started) this.startFailed?.(error);
      else this.onCrash(error);
    });
  }

  private started = false;
  private startFailed?: (error: string) => void;

  /**
   * Runs the extension's main file; resolves once `activate` returned. Rejects with
   * ActivationFailed when `activate` threw: the worker keeps running then, with what it
   * registered (VS Code's), and with any other error when it couldn't start at all.
   */
  start(init: Omit<InitMessage, "t">): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // A VS Code package may take as long as it takes (VS Code has no limit; one often starts
      // its language server first): it's only said in its log. The IDE's own have 10 s.
      const timer = init.vscode
        ? window.setTimeout(
            () =>
              this.addLog(
                "warn",
                `Slow activation: still activating after ${SLOW_ACTIVATION_MS / 1000} s.`,
              ),
            SLOW_ACTIVATION_MS,
          )
        : window.setTimeout(
            () => fail(`didn't finish activating within ${ACTIVATION_MS / 1000} s`),
            ACTIVATION_MS,
          );
      const fail = (error: string) => {
        window.clearTimeout(timer);
        this.startFailed = undefined;
        this.activated = undefined;
        reject(new Error(error));
      };
      this.startFailed = fail;
      this.activated = (error) => {
        window.clearTimeout(timer);
        this.startFailed = undefined;
        this.started = true;
        if (error) reject(new ActivationFailed(error));
        else resolve();
      };
      this.post({ t: "init", ...init });
    });
  }
  private activated?: (error?: string) => void;

  /** Calls one of the extension's callbacks. */
  call<T = unknown>(
    kind: CallMessage["kind"],
    target: string,
    args?: unknown,
    context?: unknown,
    /** How long it may take (default 30 s; a notebook cell runs as long as it runs: 0 = no limit). */
    timeoutMs = CALL_MS,
    /**
     * The caller no longer needs the answer (a language provider's request the editor
     * cancelled): the call rejects at once and the worker's token for it fires.
     */
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new Error(`${this.name} isn't running.`));
    if (signal?.aborted) return Promise.reject(new Error("Canceled"));
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const abandon = (error: Error) => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        window.clearTimeout(p.timer);
        this.post({ t: "cancel", id });
        p.reject(error);
      };
      const onAbort = () => abandon(new Error("Canceled"));
      const settled = () => signal?.removeEventListener("abort", onAbort);
      const timer =
        timeoutMs > 0
          ? window.setTimeout(
              () => abandon(new Error(`${this.name} didn't answer within ${timeoutMs / 1000} s.`)),
              timeoutMs,
            )
          : 0;
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v: unknown) => {
          settled();
          resolve(v as T);
        },
        reject: (e: Error) => {
          settled();
          reject(e);
        },
        timer,
      });
      this.post({ t: "call", id, kind, target, args, ...(context !== undefined && { context }) });
    });
  }

  /** Fire-and-forget call (events, webview messages, settings changes). */
  notify(kind: CallMessage["kind"], target: string, args?: unknown): void {
    this.call(kind, target, args).catch((err: unknown) =>
      this.addLog("error", err instanceof Error ? err.message : String(err)),
    );
  }

  private post(message: ToWorker): void {
    if (!this.disposed) this.worker.post(message);
  }

  private receive(m: FromWorker): void {
    if (this.disposed || !m || typeof m !== "object") return;
    switch (m.t) {
      case "req":
        void this.answer(m);
        return;
      case "res": {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        window.clearTimeout(p.timer);
        if (m.ok) p.resolve(m.value);
        else p.reject(new Error(m.error ?? "failed"));
        return;
      }
      case "log":
        this.addLog(m.level, String(m.text));
        return;
      case "status":
        if (m.status === "failed") this.addLog("error", m.error ?? "activation failed");
        this.activated?.(m.status === "failed" ? (m.error ?? "activation failed") : undefined);
        this.activated = undefined;
        return;
    }
  }

  private async answer(m: RequestMessage): Promise<void> {
    try {
      const params =
        m.params && typeof m.params === "object" ? (m.params as Record<string, unknown>) : {};
      const value = await this.handle(String(m.method), params);
      this.post({ t: "res", id: m.id, ok: true, value });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.post({ t: "res", id: m.id, ok: false, error });
    }
  }

  addLog(level: LogLine["level"], text: string): void {
    const line = { time: Date.now(), level, text };
    this.log.push(line);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    this.onLog(line);
  }

  /** Resolves once a stopped worker's process has exited (right away for a Web Worker). */
  exited: Promise<void> = Promise.resolve();

  /** Asks the extension to deactivate (briefly), then stops the worker. */
  async stop(): Promise<void> {
    if (this.disposed) return;
    if (this.started)
      await Promise.race([
        this.call("deactivate", "").catch(() => {}),
        new Promise((r) => window.setTimeout(r, 1000)),
      ]);
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // An activation still waiting ends now, not when its timer runs out (D261).
    this.startFailed?.("stopped");
    this.exited = Promise.resolve(this.worker.terminate()).catch(() => {});
    for (const p of this.pending.values()) {
      window.clearTimeout(p.timer);
      p.reject(new Error(`${this.name} stopped.`));
    }
    this.pending.clear();
  }
}
