// A scriptable status line (D357), after Claude Code's `statusLine`: the user's command gets the
// chat as JSON on stdin (Claude Code's field names) and the first line it prints shows in the
// status bar, ANSI colors and all. It runs again when the conversation changes, at most every
// 300 ms. This is the DOM-free part: the setting, the input, the output's line, the throttle.
// D373: OSC 8 hyperlinks in the line are kept and clickable (statusLineSegments, statusLinkTarget).
// Tested.

/** `agent.statusLine`: Claude Code's `{ "type": "command", "command": "…", "padding": 0 }`. */
export interface StatusLineSetting {
  command: string;
  /** Spaces before the text (Claude Code's `padding`), 0 to 8. */
  padding: number;
}

/** The setting as given (a bare string is a command too); null when it's off. */
export function statusLineSetting(raw: unknown): StatusLineSetting | null {
  if (typeof raw === "string") return raw.trim() ? { command: raw.trim(), padding: 0 } : null;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.type !== undefined && o.type !== "command") return null;
  const command = typeof o.command === "string" ? o.command.trim() : "";
  if (!command) return null;
  const pad = typeof o.padding === "number" && Number.isFinite(o.padding) ? o.padding : 0;
  return { command, padding: Math.max(0, Math.min(8, Math.round(pad))) };
}

/** What the IDE knows about a chat, for the command's input. */
export interface StatusLineChat {
  sessionId: string;
  transcriptPath: string | null;
  /** The working folder (where the command runs). */
  cwd: string;
  /** The workspace's (first) folder. */
  projectDir: string;
  model: { id: string; displayName: string };
  version: string;
  outputStyle: string;
  /** Dollars so far, when the model's price is known. */
  cost: number | null;
  /** Since the chat started (in this window), and how long its turns ran. */
  durationMs: number;
  apiDurationMs: number;
  linesAdded: number;
  linesRemoved: number;
  /** Prompt tokens of the latest request and the model's window, when known. */
  contextTokens: number | null;
  contextWindow: number | null;
}

/** The JSON the command reads on stdin: Claude Code's shape, where the IDE has the field. */
export function statusLineInput(c: StatusLineChat): string {
  return JSON.stringify({
    hook_event_name: "Status",
    session_id: c.sessionId,
    transcript_path: c.transcriptPath,
    cwd: c.cwd,
    model: { id: c.model.id, display_name: c.model.displayName },
    workspace: { current_dir: c.cwd, project_dir: c.projectDir },
    version: c.version,
    output_style: { name: c.outputStyle },
    cost: {
      total_cost_usd: c.cost ?? 0,
      total_duration_ms: Math.round(c.durationMs),
      total_api_duration_ms: Math.round(c.apiDurationMs),
      total_lines_added: c.linesAdded,
      total_lines_removed: c.linesRemoved,
    },
    exceeds_200k_tokens: (c.contextTokens ?? 0) > 200_000,
    ...(c.contextWindow && {
      context_window: {
        context_window_size: c.contextWindow,
        current_usage: c.contextTokens ?? 0,
      },
    }),
  });
}

/** The most of a status line shown (characters, escapes not counted). */
export const MAX_STATUS_CHARS = 200;

const ESC = "\u001b";
const BEL = "\u0007";
const SGR = new RegExp(`${ESC}\\[[0-9;:]*m`, "g");
/** Escapes other than colors (cursor moves, titles…): dropped; OSC 8 links are kept (D373). */
const OTHER_ESCAPES = new RegExp(
  `${ESC}\\[[0-9;:?]*[A-Za-ln-z]|${ESC}\\][^\u0007${ESC}]*(?:\u0007|${ESC}\\\\)|${ESC}[()][A-Z0-9]|${ESC}[=>]`,
  "g",
);
/** An OSC 8 hyperlink's start (with its URI) or end (an empty URI). */
const OSC8 = new RegExp(
  `${ESC}\\]8;[^;\u0007${ESC}]*;([^\u0007${ESC}]*)(?:\u0007|${ESC}\\\\)`,
  "g",
);
/** What takes no room on screen: colors and links. */
const ZERO_WIDTH = new RegExp(`${SGR.source}|${OSC8.source}`, "g");

/**
 * The line to show: the output's first line, colors kept, other escapes and control characters
 * dropped, at most MAX_STATUS_CHARS visible characters ("" when it printed nothing).
 */
export function statusLineText(output: string): string {
  const first = (output.replace(/^﻿/, "").split(/\r?\n/)[0] ?? "")
    // A link's BEL ending becomes ESC \ (the control characters go next).
    .replace(OTHER_ESCAPES, (m) =>
      m.startsWith(`${ESC}]8;`) ? (m.endsWith(BEL) ? `${m.slice(0, -1)}${ESC}\\` : m) : "",
    )
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what's dropped
    .replace(/[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f]/g, "")
    .replace(/\t/g, " ")
    .trimEnd();
  if (first.replace(ZERO_WIDTH, "").length <= MAX_STATUS_CHARS) return first;
  // Cut by visible characters, keeping the escapes up to there.
  let shown = 0;
  let out = "";
  for (let i = 0; i < first.length && shown < MAX_STATUS_CHARS - 1; ) {
    ZERO_WIDTH.lastIndex = i;
    const m = first[i] === ESC ? ZERO_WIDTH.exec(first) : null;
    if (m && m.index === i) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    out += first[i];
    shown++;
    i++;
  }
  return `${out}…${ESC}[0m`;
}

/** The text without its colors and links (the tooltip, the state). */
export function plainStatus(text: string): string {
  return text.replace(ZERO_WIDTH, "");
}

/** A piece of the line: its text (colors kept) and the link it's under, if any (D373). */
export interface StatusSegment {
  text: string;
  href: string | null;
}

/** The line cut at its OSC 8 links: what's between a link's start and end carries its URI. */
export function statusLineSegments(text: string): StatusSegment[] {
  const out: StatusSegment[] = [];
  let href: string | null = null;
  let at = 0;
  const push = (end: number) => {
    const t = text.slice(at, end);
    if (t) out.push({ text: t, href });
  };
  for (const m of text.matchAll(OSC8)) {
    push(m.index);
    href = m[1] ? m[1] : null;
    at = m.index + m[0].length;
  }
  push(text.length);
  return out;
}

/** Where a link goes: a web page, a file (at a line), or one of the IDE's commands. */
export type StatusLinkTarget =
  | { kind: "web"; url: string }
  | { kind: "file"; path: string; line?: number }
  | { kind: "command"; id: string; input: unknown };

/**
 * A link's target: http(s) and mailto; `file://` (`#L12` or `:12` for a line; a Windows drive
 * path loses the slash before it); `command:<id>` with an optional `?<JSON input>` (URI-encoded),
 * as VS Code's command links. Anything else: null (not opened).
 */
export function statusLinkTarget(href: string): StatusLinkTarget | null {
  const h = href.trim();
  if (/^(https?:|mailto:)/i.test(h)) return { kind: "web", url: h };
  const command = /^command:([\w.-]+)(?:\?(.*))?$/.exec(h);
  if (command?.[1]) {
    let input: unknown = {};
    if (command[2]) {
      try {
        input = JSON.parse(decodeURIComponent(command[2]));
      } catch {
        return null;
      }
    }
    return { kind: "command", id: command[1], input };
  }
  // file:///C:/x, file:///home/x, or a share's file://server/share/x (UNC on Windows).
  const file = /^file:\/\/([^/]*)(\/.*)$/i.exec(h);
  if (!file?.[2]) return null;
  let path: string;
  try {
    const host = file[1] && file[1].toLowerCase() !== "localhost" ? `//${file[1]}` : "";
    path = host + decodeURIComponent(file[2]);
  } catch {
    return null;
  }
  let line: number | undefined;
  const at = /(?:#L|:)(\d+)$/.exec(path);
  if (at?.[1]) {
    line = Number(at[1]);
    path = path.slice(0, at.index);
  }
  // file:///C:/x → C:/x
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  return { kind: "file", path, ...(line && { line }) };
}

export interface Timers {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/**
 * Runs `run` when asked, at most once every `gapMs`, one at a time: asks while it runs or within
 * the gap come together into one run when they're over.
 */
export class Throttle {
  private lastStart = Number.NEGATIVE_INFINITY;
  private running = false;
  private wanted = false;
  private timer: unknown = null;
  private disposed = false;

  constructor(
    private readonly gapMs: number,
    private readonly run: () => Promise<void>,
    private readonly timers: Timers,
  ) {}

  request(): void {
    if (this.disposed) return;
    this.wanted = true;
    this.pump();
  }

  private pump(): void {
    if (!this.wanted || this.running || this.timer !== null || this.disposed) return;
    const wait = this.lastStart + this.gapMs - this.timers.now();
    if (wait > 0) {
      this.timer = this.timers.set(() => {
        this.timer = null;
        this.pump();
      }, wait);
      return;
    }
    this.wanted = false;
    this.running = true;
    this.lastStart = this.timers.now();
    void this.run()
      .catch(() => {})
      .finally(() => {
        this.running = false;
        this.pump();
      });
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}
