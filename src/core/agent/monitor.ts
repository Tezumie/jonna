// The agent's monitors (D322, Claude Code's Monitor): a background command whose every output
// line is an event. Lines that arrive within MONITOR_BATCH_MS of each other go to the chat as one
// message; a monitor that sends too many is stopped; every monitor ends after its timeout. The
// DOM-free part: splitting output into lines, batching, the flood limit, the messages' text.

/** Lines within this long of the first one of a batch go in the same message. */
export const MONITOR_BATCH_MS = 200;
export const MONITOR_DEFAULT_TIMEOUT_MS = 5 * 60_000;
export const MONITOR_MAX_TIMEOUT_MS = 30 * 60_000;
export const MONITOR_MIN_TIMEOUT_MS = 5_000;
/** More messages than this in a minute: the monitor is stopped (each one may start a turn). */
export const MONITOR_MAX_PER_MINUTE = 20;
/** More lines than this in a minute: stopped too (a log that floods). */
export const MONITOR_MAX_LINES_PER_MINUTE = 2000;
/** What one message carries at most; the rest of its batch is counted, not sent. */
export const MONITOR_MAX_LINES = 40;
export const MONITOR_MAX_CHARS = 4000;
/** One line longer than this is cut. */
const LINE_LIMIT = 500;

const MINUTE = 60_000;

/** The timeout asked for (milliseconds), kept within its bounds; default 5 minutes. */
export function monitorTimeout(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return MONITOR_DEFAULT_TIMEOUT_MS;
  return Math.min(MONITOR_MAX_TIMEOUT_MS, Math.max(MONITOR_MIN_TIMEOUT_MS, Math.round(n)));
}

// Terminal colors and titles: not part of an event.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
  "g",
);

/** Output chunks → whole lines (a line split across chunks is joined; blank lines dropped). */
export class LineSplitter {
  private carry = "";

  push(chunk: string): string[] {
    const text = this.carry + chunk;
    const parts = text.split(/\r\n|\n|\r/);
    this.carry = parts.pop() ?? "";
    // A line that never ends (a progress bar without newlines) is let out in pieces.
    if (this.carry.length > LINE_LIMIT * 4) {
      parts.push(this.carry);
      this.carry = "";
    }
    return clean(parts);
  }

  /** The output ended: what's left is the last line. */
  end(): string[] {
    const rest = this.carry;
    this.carry = "";
    return clean([rest]);
  }
}

function clean(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(ANSI, "").trimEnd();
    if (!line.trim()) continue;
    out.push(line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT)}…` : line);
  }
  return out;
}

export interface MonitorBatch {
  lines: string[];
  /** Lines of this batch not sent (past MONITOR_MAX_LINES / MONITOR_MAX_CHARS). */
  omitted: number;
}

/** A monitor's events: the batch being gathered, the counts, the flood limit. */
export class MonitorEvents {
  private pending: string[] = [];
  /** When each message was sent (the last minute's). */
  private sent: number[] = [];
  /** When lines arrived, with how many (the last minute's). */
  private arrived: { at: number; count: number }[] = [];
  /** Every line seen. */
  total = 0;
  /** Messages sent. */
  notifications = 0;

  /**
   * Lines arrived at `now`. True when they start a batch: the caller takes it MONITOR_BATCH_MS
   * later.
   */
  add(lines: readonly string[], now: number): boolean {
    if (!lines.length) return false;
    const starts = this.pending.length === 0;
    this.pending.push(...lines);
    this.total += lines.length;
    this.arrived.push({ at: now, count: lines.length });
    return starts;
  }

  /** Lines waiting for the next message. */
  get waiting(): number {
    return this.pending.length;
  }

  /** The batch to send now (null: nothing waits); it counts as a message sent at `now`. */
  take(now: number): MonitorBatch | null {
    if (!this.pending.length) return null;
    const lines: string[] = [];
    let chars = 0;
    for (const line of this.pending) {
      if (lines.length >= MONITOR_MAX_LINES || chars + line.length > MONITOR_MAX_CHARS) break;
      lines.push(line);
      chars += line.length + 1;
    }
    const omitted = this.pending.length - lines.length;
    this.pending = [];
    this.sent.push(now);
    this.notifications++;
    return { lines, omitted };
  }

  /** Drops what waits (the monitor stopped). */
  clear(): void {
    this.pending = [];
  }

  /**
   * Too much in the last minute: more than MONITOR_MAX_PER_MINUTE messages (counting the one
   * about to go) or MONITOR_MAX_LINES_PER_MINUTE lines. Null when it's within bounds.
   */
  flood(now: number): { messages: number; lines: number } | null {
    const since = now - MINUTE;
    this.sent = this.sent.filter((t) => t > since);
    this.arrived = this.arrived.filter((a) => a.at > since);
    const messages = this.sent.length + (this.pending.length ? 1 : 0);
    const lines = this.arrived.reduce((n, a) => n + a.count, 0);
    return messages > MONITOR_MAX_PER_MINUTE || lines > MONITOR_MAX_LINES_PER_MINUTE
      ? { messages, lines }
      : null;
  }
}

/** "5m", "90s", "1m 30s". */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

/** The chat message for a batch of events. Its first line is what the chat shows. */
export function monitorEventText(
  id: string,
  description: string,
  batch: MonitorBatch,
  /** A WebSocket monitor's (D328): each event is a frame, in a block of its own. */
  frames = false,
): string {
  const n = batch.lines.length + batch.omitted;
  const unit = frames ? "frame" : "line";
  return [
    `Monitor ${id} (${description}): ${n} new ${unit}${n === 1 ? "" : "s"}`,
    ...(frames
      ? batch.lines.flatMap((frame) => ["```", frame, "```"])
      : ["```", ...batch.lines, "```"]),
    ...(batch.omitted
      ? [`[${batch.omitted} more ${unit}${batch.omitted === 1 ? "" : "s"} not shown]`]
      : []),
    `It keeps watching; stop it with kill_process { id: "${id}" } when you're done.`,
  ].join("\n");
}

export type MonitorEnd =
  | { kind: "exited"; code: number | null }
  | { kind: "expired"; afterMs: number }
  | { kind: "flood"; messages: number; lines: number }
  | { kind: "failed"; error: string }
  /** A WebSocket monitor's socket closed (D328): by the server, or the connection dropped. */
  | { kind: "closed"; code: number | null; reason: string };

/** The chat message when a monitor ends on its own (not when it's killed). */
export function monitorEndText(
  id: string,
  description: string,
  end: MonitorEnd,
  events: number,
): string {
  const seen = `${events} event${events === 1 ? "" : "s"}`;
  switch (end.kind) {
    case "exited":
      return `Monitor ${id} (${description}) ended: its command exited${end.code === null ? "" : ` with ${end.code}`} after ${seen}.`;
    case "expired":
      return `Monitor ${id} (${description}) expired after ${shortDuration(end.afterMs)} with ${seen}; it was stopped. Start it again if you still need to watch.`;
    case "flood":
      return `Monitor ${id} (${description}) was stopped: too many events (${end.messages} messages, ${end.lines} lines in the last minute). Narrow its command (grep for the lines that matter) and start it again.`;
    case "failed":
      return `Monitor ${id} (${description}) failed to start: ${end.error}`;
    case "closed":
      return `Monitor ${id} (${description}) ended: its WebSocket closed ${wsCloseLabel(end.code, end.reason)} after ${seen}.`;
  }
}

// ---------------------------------------------------------------------------------------------
// WebSocket monitors (D328, Claude Code's Monitor `ws`): each incoming text frame is one event
// (a multiline frame stays one), a binary frame is its size, the socket's close ends the watch.

/** One frame longer than this is cut (an event carries at most MONITOR_MAX_CHARS). */
export const WS_FRAME_LIMIT = 2000;

/** A WebSocket address the monitor may open: ws:// or wss://, with a host. Null: not one. */
export function wsAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  const m = /^(wss?):\/\/([^/\s?#]+)([^\s]*)$/i.exec(url);
  if (!m) return null;
  return `${(m[1] ?? "").toLowerCase()}://${m[2]}${m[3] ?? ""}`;
}

/** The subprotocols asked for: HTTP tokens only (they go in a header). Null: one isn't valid. */
export function wsProtocols(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const p of list) {
    if (typeof p !== "string" || !/^[A-Za-z0-9!#$%&'*+\-.^_`|~]{1,128}$/.test(p)) return null;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** A frame as one event: a text frame whole (escapes out, cut when very long), binary by size. */
export function wsFrameEvent(frame: { text: string } | { bytes: number }): string {
  if ("bytes" in frame) return `[binary frame, ${frame.bytes} bytes]`;
  const text = frame.text.replace(ANSI, "").replace(/\r\n?/g, "\n").trimEnd();
  if (!text.trim()) return "[empty frame]";
  if (text.length <= WS_FRAME_LIMIT) return text;
  return `${text.slice(0, WS_FRAME_LIMIT)}… [${text.length - WS_FRAME_LIMIT} more characters]`;
}

/** What a close code means, for the end message ("1000 normal closure"). */
export function wsCloseLabel(code: number | null, reason: string): string {
  const names: Record<number, string> = {
    1000: "normal closure",
    1001: "going away",
    1002: "protocol error",
    1003: "unsupported data",
    1006: "abnormal closure",
    1008: "policy violation",
    1009: "message too big",
    1011: "server error",
    1012: "service restart",
    1013: "try again later",
  };
  const said = reason.trim() ? ` "${reason.trim().slice(0, 200)}"` : "";
  if (code === null) return `without a close code${said}`;
  return `with code ${code}${names[code] ? ` (${names[code]})` : ""}${said}`;
}

/**
 * A closed socket as an exit code (the background list's status): a normal close (1000) or the
 * server going away (1001) is 0; a dropped connection 1; any other close its code.
 */
export function wsExitCode(code: number | null): number {
  if (code === 1000 || code === 1001) return 0;
  return code ?? 1;
}
