// The frontend's side of the session log (D204): uncaught errors, unhandled promise rejections,
// console.error from the IDE's own code (extensions run in workers and frames, with their own
// consoles), failed IPC calls and failed commands go to the Rust log every couple of seconds.
// The last ones are kept for Help → Report a problem.
import { describeError, LogBuffer, type LogLevel } from "../../core/diagnostics/logBuffer";
import { output, WINDOW_CHANNEL } from "../../core/diagnostics/output";
import { logIpc } from "../../core/ipc/diagnostics";
import { onFailedCall } from "../../core/ipc/invoke";
import type { Disposable } from "../../core/lifecycle/index";
import type { WorkbenchServices } from "../../workbench/services";

const FLUSH_MS = 2_000;
/** Expected failures (a probe for a file that isn't there, a cancel), not problems. */
const QUIET_CODES = new Set(["NotFound", "Cancelled", "NoWorkspace"]);

export class ErrorCapture implements Disposable {
  readonly buffer = new LogBuffer();
  /** Debug and trace records (D209, log.level): their own flood limit, never in the report. */
  private readonly verbose = new LogBuffer({ perMinute: 1000, recentSize: 0 });
  private readonly cleanups: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private sending = false;

  constructor(private readonly services: WorkbenchServices) {}

  /** A record for the session log and the Window output channel, unless its level drops it. */
  record(level: LogLevel, source: string, message: string): void {
    if (!output.enabled(level)) return;
    if (level === "debug" || level === "trace") this.verbose.push(level, source, message);
    else this.buffer.push(level, source, message);
    output.append(WINDOW_CHANNEL, level, `[${source}] ${message}`);
  }

  install(win: Window): void {
    const onError = (e: ErrorEvent) => {
      const where = e.filename
        ? ` (${e.filename.replace(/^.*\//, "")}:${e.lineno}:${e.colno})`
        : "";
      this.record("error", "window", `${describeError(e.error ?? e.message)}${where}`);
    };
    const onRejection = (e: PromiseRejectionEvent) =>
      this.record("error", "promise", `Unhandled rejection: ${describeError(e.reason)}`);
    win.addEventListener("error", onError);
    win.addEventListener("unhandledrejection", onRejection);
    this.cleanups.push(() => {
      win.removeEventListener("error", onError);
      win.removeEventListener("unhandledrejection", onRejection);
    });

    // console.error: still printed; recorded once (an error while recording isn't recorded again).
    const original = console.error;
    let inside = false;
    const wrapped = (...args: unknown[]) => {
      original.apply(console, args);
      if (inside) return;
      inside = true;
      try {
        this.record("error", "console", args.map((a) => describeError(a)).join(" "));
      } finally {
        inside = false;
      }
    };
    console.error = wrapped;
    this.cleanups.push(() => {
      if (console.error === wrapped) console.error = original;
    });

    onFailedCall((err) => {
      if (QUIET_CODES.has(err.code) || err.command === "log_write") return;
      this.record("warn", `ipc:${err.command}`, `${err.code}: ${err.message}`);
    });
    this.cleanups.push(() => onFailedCall(null));

    // Failed commands (any caller; the user's also show as a toast). Declined ones aren't failures.
    const executed = this.services.events.on("command.executed", (e) => {
      if (e.error && e.status !== "denied") this.record("warn", `command:${e.id}`, e.error);
      // log.level debug (D209): every command that ran, by whom and how long it took.
      else if (output.enabled("debug"))
        this.record(
          "debug",
          `command:${e.id}`,
          `${e.status} in ${Math.round(e.durationMs)} ms (${e.caller.kind})`,
        );
    });
    this.cleanups.push(() => executed.dispose());

    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.cleanups.push(() => clearInterval(this.timer));
  }

  /** Sends what's pending to the session log now. */
  async flush(): Promise<void> {
    if (this.sending || this.buffer.size + this.verbose.size === 0) return;
    this.sending = true;
    try {
      const records = [...this.buffer.drain(), ...this.verbose.drain()].sort(
        (a, b) => a.time - b.time,
      );
      await logIpc
        .write(records.map((r) => ({ level: r.level, source: r.source, message: r.message })))
        .catch(() => {});
    } finally {
      this.sending = false;
    }
  }

  dispose(): void {
    void this.flush();
    for (const c of this.cleanups.splice(0)) c();
  }
}
