// Commands the agent runs in the background (D201, Claude Code's `run_in_background`): a dev
// server or a watcher started by run_command keeps running with an id ("bg1"); process_output
// reads what it printed since the last read, kill_process ends it. Each belongs to its chat:
// the chat lists them (the user can see their output and stop them), and they're killed when
// the chat is deleted, the folder closes or the IDE ends (Rust ties every command to the IDE's
// process, D180; a reloaded page kills what it started, D163). Stop doesn't end them: a server
// started in an earlier step keeps running, as in Claude Code.
//
// They run through the same exec plumbing as foreground commands (`execIpc`): no terminal, no
// pty, stdin closed, output merged and kept in an OutputBuffer.
import { savedOutputs } from "../../core/agent/savedOutput";
import { type ExecSandboxPolicy, execIpc } from "../../core/ipc/process";
import { type Disposable, toDisposable } from "../../core/lifecycle/index";
import { type ReadonlySignal, signal } from "../../core/reactive/index";
import { findServerUrls } from "../terminal/servers";
import { OutputBuffer } from "./processOutput";

export type ProcessStatus = "running" | "exited" | "killed" | "failed";

export interface BackgroundProcess {
  /** "bg1", "bg2"… (unique while the IDE runs). */
  readonly id: string;
  readonly session: string;
  readonly command: string;
  /** Workspace-relative folder it runs in ("." the root). */
  readonly cwd: string;
  readonly startedAt: number;
  status: ProcessStatus;
  exitCode: number | null;
  endedAt: number | null;
  /** Local server addresses it printed (http://localhost:5173/). */
  urls: string[];
  /** When output last arrived. */
  lastOutputAt: number;
  readonly output: OutputBuffer;
  error?: string;
  /** Tell the chat's agent when it ends on its own (run_command's notify_on_exit, D253). */
  notify?: boolean;
  /**
   * A monitor (D322, monitors.ts): its output lines are events sent to the chat. `ws`: a
   * WebSocket monitor (D328), `command` is its address and each frame is an event.
   */
  monitor?: { description: string; timeoutMs: number; events: number; ws?: true };
  /** Gets each output chunk as it arrives (a monitor's events). */
  onChunk?: (chunk: string) => void;
  /** Hosts the sandbox's network filter refused it, while it runs and after (D372). */
  blockedHosts?: string[];
}

/** How often a running sandboxed command's refused hosts are read (D372). */
const BLOCKED_POLL_MS = 3000;

/** Background commands run until killed; Rust needs a limit: a week. */
const BACKGROUND_TIMEOUT_MS = 7 * 24 * 3600 * 1000;
/** Ended processes a chat keeps (to read their last output); older ones are forgotten. */
const KEEP_ENDED = 10;
/** What an ended command keeps of its output (the agent can still read its end). */
const ENDED_OUTPUT = 200_000;
/** Most running at once per chat: a model starting servers in a loop is stopped here. */
export const MAX_RUNNING_PER_CHAT = 8;

/**
 * What runs a background entry: a command through `execIpc`, or a monitor's WebSocket (D328).
 * `run` resolves when it ends; `cancel` ends it.
 */
export interface ProcessRunner {
  run(onChunk: (chunk: string) => void): Promise<{
    exitCode: number | null;
    cancelled?: boolean;
    timedOut?: boolean;
    blockedHosts?: string[];
  }>;
  cancel(): Promise<void>;
  /** A sandboxed command's refused hosts so far (D372). */
  blockedHosts?(): Promise<string[]>;
}

export class BackgroundProcesses {
  private readonly all = new Map<string, BackgroundProcess & { cancel: () => Promise<void> }>();
  private next = 1;
  private readonly changes = signal(0);
  private readonly endListeners = new Set<(p: BackgroundProcess) => void>();

  /** Called when a process ends (exits, is killed or fails to start). */
  onDidEnd(listener: (p: BackgroundProcess) => void): Disposable {
    this.endListeners.add(listener);
    return toDisposable(() => this.endListeners.delete(listener));
  }

  private ended(p: BackgroundProcess): void {
    for (const listener of [...this.endListeners]) {
      try {
        listener(p);
      } catch (err) {
        console.warn("background process end listener failed", err);
      }
    }
  }
  /** Bumps when a process starts, ends or prints a server address (not on every output chunk). */
  readonly version: ReadonlySignal<number> = this.changes;

  private bump(): void {
    this.changes.value = this.changes.peek() + 1;
  }

  /** New refused hosts: kept, and the lists redraw. */
  private noteBlocked(p: BackgroundProcess, hosts: readonly string[]): void {
    const fresh = hosts.filter((h) => !p.blockedHosts?.includes(h));
    if (!fresh.length) return;
    p.blockedHosts = [...(p.blockedHosts ?? []), ...fresh];
    this.bump();
  }

  /** A process's details were changed from outside (a monitor's): its lists redraw. */
  noteChanged(): void {
    this.bump();
  }

  /**
   * Starts `command` in `cwd` (absolute; `cwdLabel` is how it's shown) for chat `session`; `env`:
   * a headless helper's PORT / WORKTREE_* (nothing else is passed on).
   */
  start(
    session: string,
    command: string,
    cwd: string,
    cwdLabel: string,
    env: Record<string, string> = {},
    /** In the command sandbox (D336), with its policy (D349, D350). */
    sandbox: boolean | ExecSandboxPolicy = false,
  ): BackgroundProcess {
    return this.startWith(session, command, cwdLabel, (id) => {
      const execId = `agent-bg-${id}-${Date.now()}`;
      return {
        run: (onChunk) =>
          execIpc.run(
            execId,
            command,
            {
              cwd,
              timeoutMs: BACKGROUND_TIMEOUT_MS,
              ...(Object.keys(env).length && { env }),
              ...(sandbox && { sandbox }),
            },
            onChunk,
          ),
        cancel: () => execIpc.cancel(execId),
        ...(sandbox && { blockedHosts: () => execIpc.blockedHosts(execId) }),
      };
    });
  }

  /**
   * Starts an entry run by `runner` (made with its id): a command, or a monitor's WebSocket
   * (D328, `command` its address). It counts toward the chat's limit like a command.
   */
  startWith(
    session: string,
    command: string,
    cwdLabel: string,
    runner: (id: string) => ProcessRunner,
  ): BackgroundProcess {
    const running = this.list(session).filter((p) => p.status === "running").length;
    if (running >= MAX_RUNNING_PER_CHAT)
      throw new Error(
        `${running} background commands are running in this chat already; stop one with kill_process first.`,
      );
    const id = `bg${this.next++}`;
    const run = runner(id);
    const p: BackgroundProcess & { cancel: () => Promise<void> } = {
      id,
      cancel: () => run.cancel(),
      session,
      command,
      cwd: cwdLabel,
      startedAt: Date.now(),
      status: "running",
      exitCode: null,
      endedAt: null,
      urls: [],
      lastOutputAt: Date.now(),
      output: new OutputBuffer(),
    };
    this.all.set(id, p);
    // A sandboxed command's refused hosts, while it runs (the foreground ones say so at the end).
    const readBlocked = run.blockedHosts;
    const poll = readBlocked
      ? setInterval(() => {
          void readBlocked().then(
            (hosts) => this.noteBlocked(p, hosts),
            () => {},
          );
        }, BLOCKED_POLL_MS)
      : undefined;
    // The end of the previous chunk: an address split across two chunks is still found.
    let carry = "";
    run
      .run((chunk) => {
        p.output.append(chunk);
        p.lastOutputAt = Date.now();
        p.onChunk?.(chunk);
        if (p.urls.length < 5) {
          const joined = carry + chunk;
          carry = joined.slice(-300);
          let found = false;
          for (const { url } of findServerUrls(joined))
            if (!p.urls.includes(url)) {
              p.urls.push(url);
              found = true;
            }
          if (found) this.bump();
        }
      })
      .then(
        (r) => {
          clearInterval(poll);
          if (r.blockedHosts) this.noteBlocked(p, r.blockedHosts);
          p.output.end();
          p.exitCode = r.exitCode;
          if (p.status === "running") p.status = r.cancelled || r.timedOut ? "killed" : "exited";
          p.endedAt = Date.now();
          p.output.shrink(ENDED_OUTPUT);
          this.forgetOld(session);
          this.bump();
          this.ended(p);
        },
        (err: unknown) => {
          clearInterval(poll);
          p.output.end();
          p.status = "failed";
          p.error = err instanceof Error ? err.message : String(err);
          p.endedAt = Date.now();
          p.output.shrink(ENDED_OUTPUT);
          this.forgetOld(session);
          this.bump();
          this.ended(p);
        },
      );
    this.bump();
    return p;
  }

  /** A chat's processes (or every chat's), oldest first. */
  list(session?: string): BackgroundProcess[] {
    return [...this.all.values()].filter((p) => !session || p.session === session);
  }

  get(id: string): BackgroundProcess | undefined {
    return this.all.get(id.trim());
  }

  /** The same command already running in this chat in that folder (asked twice). */
  findRunning(session: string, command: string, cwdLabel: string): BackgroundProcess | undefined {
    return this.list(session).find(
      (p) =>
        p.status === "running" &&
        !p.monitor &&
        p.command.trim() === command.trim() &&
        p.cwd === cwdLabel,
    );
  }

  /** Ends a process and what it started. False when it isn't running. */
  async kill(id: string): Promise<boolean> {
    const p = this.all.get(id.trim());
    if (!p || p.status !== "running") return false;
    p.status = "killed";
    this.bump();
    await p.cancel().catch(() => {});
    return true;
  }

  /** Ends a chat's processes and forgets them (the chat was deleted). Returns how many ran. */
  killSession(session: string): number {
    let n = 0;
    for (const p of this.list(session)) {
      if (p.status === "running") {
        n++;
        void this.kill(p.id);
      }
      this.all.delete(p.id);
    }
    // Its kept outputs of cut foreground runs go too (D311).
    savedOutputs.forget(session);
    this.bump();
    return n;
  }

  /** Ends every process (the folder closed, the extension stops). */
  killAll(): void {
    for (const p of this.all.values()) if (p.status === "running") void this.kill(p.id);
    this.all.clear();
    this.bump();
  }

  /** Drops a chat's oldest ended processes past KEEP_ENDED. */
  private forgetOld(session: string): void {
    const ended = this.list(session).filter((p) => p.status !== "running");
    for (const p of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED))) this.all.delete(p.id);
  }
}

/** The window's background processes (one agent extension per window). */
export const backgroundProcesses = new BackgroundProcesses();

/** How long ago, for the model and the list ("2m 5s"). */
export function runningFor(p: BackgroundProcess, now = Date.now()): string {
  const s = Math.max(0, Math.round(((p.endedAt ?? now) - p.startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** One line about a process ("bg1 running 2m 5s · npm run dev · http://localhost:5173/"). */
export function describeProcess(p: BackgroundProcess): string {
  const status =
    p.status === "running"
      ? `running ${runningFor(p)}`
      : p.status === "exited"
        ? `exited with ${p.exitCode ?? "?"} after ${runningFor(p)}`
        : p.status === "killed"
          ? "killed"
          : `failed to start${p.error ? `: ${p.error}` : ""}`;
  return [
    `${p.id} ${status}`,
    ...(p.monitor ? [`monitor: ${p.monitor.description} (${p.monitor.events} events)`] : []),
    p.command,
    ...(p.cwd !== "." ? [`in ${p.cwd}`] : []),
    ...p.urls.slice(0, 2),
    // The sandbox's network filter refused it (D372): the model can ask for the host.
    ...(p.blockedHosts?.length
      ? [`the sandbox refused these hosts: ${p.blockedHosts.join(", ")}`]
      : []),
  ].join(" · ");
}
