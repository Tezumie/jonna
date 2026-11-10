// The worker's `ide.ui.createOutputChannel(name)`: the extension's own channel in the Output tab
// (VS Code's `window.createOutputChannel`, both the plain and the log channel's methods). Lines
// are collected and sent in one request per turn of the event loop; text without a newline waits
// for the rest of its line (or `show` / `clear` / `dispose`, or a second). The host side is
// extensions/extensions/runtimeOutput.ts. DOM-free.

export type OutputLineLevel = "trace" | "debug" | "info" | "warn" | "error";

export interface OutputChannel {
  readonly name: string;
  /** Text; each newline ends a line (the rest waits for its line's end). */
  append(text: string): void;
  appendLine(text: string): void;
  /** Clears the channel, then appends `text`. */
  replace(text: string): void;
  clear(): void;
  /** Opens the Output tab on this channel. */
  show(preserveFocus?: boolean): void;
  /** Nothing to hide in the IDE's Output tab (VS Code's API has it). */
  hide(): void;
  trace(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string | Error, ...args: unknown[]): void;
  /** Stops writing to it (its lines stay in the Output tab for the session). */
  dispose(): void;
}

type Request = <T>(method: string, params?: unknown) => Promise<T>;

/** The most lines in one request (the host takes no more). */
export const MAX_OUTPUT_BATCH = 500;
/** Text without a newline is sent as a line after this long. */
const PARTIAL_MS = 1000;
const LINE_BREAK = /\r?\n/;

/** The channel id of an extension's channel `name` ("acme.todo", "Todo scan" → "ext.acme.todo~todo-scan"). */
export function extensionChannelId(extensionId: string, name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "output";
  // `~` can't be in an extension id: "acme" and "acme.todo" never share a prefix.
  return `ext.${extensionId}~${slug}`;
}

/** An extension's channel ids among `ids` (ide://extensions lists them). */
export function channelsOf(extensionId: string, ids: readonly string[]): string[] {
  const prefix = `ext.${extensionId}~`;
  return ids.filter((id) => id.startsWith(prefix));
}

function text(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * `log`: a log channel (VS Code's `{ log: true }`), listed in "Set log level…" so the user can
 * pick what it writes.
 */
export function createOutputChannel(
  request: Request,
  rawName: unknown,
  options: { log?: boolean } = {},
): OutputChannel {
  const name = String(rawName ?? "").trim();
  if (!name) throw new Error("An output channel needs a name.");
  let lines: { level: OutputLineLevel; text: string }[] = [];
  let partial = "";
  let scheduled = false;
  let partialTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  // Created before anything is written to it (the host makes the channel, refusing past its limit).
  let ready: Promise<unknown> = request("output.create", {
    name,
    ...(options.log === true && { log: true }),
  }).catch(() => {});

  const send = () => {
    scheduled = false;
    const batch = lines;
    lines = [];
    for (let i = 0; i < batch.length; i += MAX_OUTPUT_BATCH) {
      const part = batch.slice(i, i + MAX_OUTPUT_BATCH);
      ready = ready.then(() => request("output.append", { name, lines: part }).catch(() => {}));
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(send);
  };
  const push = (level: OutputLineLevel, line: string) => {
    if (disposed) return;
    lines.push({ level, text: line });
    schedule();
  };
  const flushPartial = () => {
    clearTimeout(partialTimer);
    partialTimer = undefined;
    if (!partial) return;
    const rest = partial;
    partial = "";
    push("info", rest);
  };
  /** Sends what's waiting now, then runs `method` after it (order kept). */
  const after = (method: string, params: Record<string, unknown> = {}) => {
    flushPartial();
    if (scheduled) send();
    ready = ready.then(() => request(method, { name, ...params }).catch(() => {}));
  };
  const log =
    (level: OutputLineLevel) =>
    (message: unknown, ...args: unknown[]) => {
      flushPartial();
      push(level, [message, ...args].map(text).join(" "));
    };

  const append = (value: unknown) => {
    if (disposed) return;
    const parts = (partial + text(value)).split(LINE_BREAK);
    partial = parts.pop() ?? "";
    for (const line of parts) push("info", line);
    clearTimeout(partialTimer);
    partialTimer = partial ? setTimeout(flushPartial, PARTIAL_MS) : undefined;
  };
  const clear = () => {
    if (disposed) return;
    // What's waiting is dropped with the rest.
    lines = [];
    partial = "";
    clearTimeout(partialTimer);
    after("output.clear");
  };

  return {
    name,
    append,
    appendLine: (value) => append(`${text(value)}\n`),
    replace: (value) => {
      clear();
      append(value);
    },
    clear,
    show(preserveFocus) {
      if (disposed) return;
      after("output.show", { preserveFocus: preserveFocus === true });
    },
    hide() {},
    trace: log("trace"),
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    dispose() {
      if (disposed) return;
      flushPartial();
      if (scheduled) send();
      disposed = true;
    },
  };
}
