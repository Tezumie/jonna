// What the frontend sends to the session log (D204): records are batched, a run of the same
// message is collapsed ("repeated 12 times"), and a flood (an error in a render loop) is capped
// per minute with one line saying so. The last errors are kept for the problem report. DOM-free.

/** debug and trace (D209): only while `log.level` asks for them. */
export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

export interface LogRecord {
  level: LogLevel;
  /** Where it came from: "window", "promise", "console", "ipc:<command>", "panic"… */
  source: string;
  message: string;
  /** ms since the epoch. */
  time: number;
}

export interface LogBufferOptions {
  /** Records accepted per minute (default 120). */
  perMinute?: number;
  /** Errors and warnings kept for the report (default 50). */
  recentSize?: number;
  now?: () => number;
}

export class LogBuffer {
  private pending: LogRecord[] = [];
  private readonly recentErrors: LogRecord[] = [];
  private windowStart = 0;
  private inWindow = 0;
  private dropped = 0;
  private readonly perMinute: number;
  private readonly recentSize: number;
  private readonly now: () => number;

  constructor(options: LogBufferOptions = {}) {
    this.perMinute = options.perMinute ?? 120;
    this.recentSize = options.recentSize ?? 50;
    this.now = options.now ?? Date.now;
  }

  /** Adds a record; false when the minute's limit dropped it. */
  push(level: LogLevel, source: string, message: string): boolean {
    const time = this.now();
    if (time - this.windowStart >= 60_000) {
      if (this.dropped)
        this.pending.push({
          level: "warn",
          source: "log",
          message: `${this.dropped} more records were dropped (more than ${this.perMinute} a minute).`,
          time,
        });
      this.windowStart = time;
      this.inWindow = 0;
      this.dropped = 0;
    }
    if (this.inWindow >= this.perMinute) {
      this.dropped++;
      return false;
    }
    this.inWindow++;
    const record: LogRecord = { level, source, message, time };
    this.pending.push(record);
    if (level === "error" || level === "warn") {
      const last = this.recentErrors[this.recentErrors.length - 1];
      if (!last || last.message !== message || last.source !== source) {
        this.recentErrors.push(record);
        if (this.recentErrors.length > this.recentSize) this.recentErrors.shift();
      }
    }
    return true;
  }

  /** Whether there's anything to send. */
  get size(): number {
    return this.pending.length;
  }

  /** Takes the pending records, with runs of the same message collapsed. */
  drain(): LogRecord[] {
    const out: LogRecord[] = [];
    let repeats = 0;
    const flush = () => {
      const last = out[out.length - 1];
      if (last && repeats)
        last.message += ` (repeated ${repeats} more time${repeats > 1 ? "s" : ""})`;
      repeats = 0;
    };
    for (const r of this.pending) {
      const last = out[out.length - 1];
      if (last && last.message === r.message && last.source === r.source && last.level === r.level)
        repeats++;
      else {
        flush();
        out.push({ ...r });
      }
    }
    flush();
    this.pending = [];
    return out;
  }

  /** The last errors and warnings, oldest first. */
  recent(): readonly LogRecord[] {
    return this.recentErrors;
  }
}

/** One line for an error-like value: the message and the first lines of its stack. */
export function describeError(value: unknown, stackLines = 6): string {
  if (value instanceof Error) {
    const stack = (value.stack ?? "")
      .split("\n")
      .filter((l) => /^\s+at |@/.test(l))
      .slice(0, stackLines)
      .map((l) => l.trim());
    return [`${value.name}: ${value.message}`, ...stack].join("\n");
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
