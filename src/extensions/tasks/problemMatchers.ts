// Problem matchers, VS Code's format (D134): regular expressions that turn a task's output into
// problems (file, line, column, severity, message, code) for the Problems view. The built-in
// ones are VS Code's common names ($tsc, $tsc-watch, $eslint-stylish, $eslint-compact, $gcc,
// $msCompile, $go, $rustc, $jshint, $lessCompile) plus $esbuild / $esbuild-watch (the problem
// matchers extension's, used by extension templates); tasks.json may define its own or extend
// one (`base`). Multi-line patterns (`loop` on the last) and background matchers (watch tasks:
// `beginsPattern` / `endsPattern` bracket each rebuild) work as in VS Code. DOM-free, tested.
import { resolveInRoot } from "../../core/paths/index";
import type { ExternalProblem } from "../../workbench/services";

export interface ProblemPattern {
  regexp: RegExp;
  file?: number;
  /** "line", "line,column" or "line,column,endLine,endColumn" in one group. */
  location?: number;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  severity?: number;
  code?: number;
  message?: number;
  /** The last pattern of several repeats for each further match (eslint-stylish). */
  loop?: boolean;
}

export interface ProblemMatcher {
  /** Problems of one owner replace each other (VS Code: the matcher's owner). */
  owner: string;
  source?: string;
  severity: ExternalProblem["severity"];
  fileLocation: { kind: "absolute" | "relative" | "autoDetect"; base?: string };
  patterns: ProblemPattern[];
  background?: { activeOnStart: boolean; begins: RegExp; ends: RegExp };
}

type RawPattern = Record<string, unknown>;

const TSC_PATTERN: RawPattern = {
  regexp:
    "^([^\\s].*)[\\(:](\\d+)[,:](\\d+)(?:\\):\\s+|\\s+-\\s+)(error|warning|info)\\s+TS(\\d+)\\s*:\\s*(.*)$",
  file: 1,
  line: 2,
  column: 3,
  severity: 4,
  code: 5,
  message: 6,
};

const ESBUILD_PATTERN: RawPattern[] = [
  {
    regexp: "^.*?(?:✘|▲)\\s*\\[(ERROR|WARNING)\\]\\s+(.*?)(?:\\s+\\[(.+)\\])?$",
    severity: 1,
    message: 2,
    code: 3,
  },
  { regexp: "^\\s*(.*?):(\\d+):(\\d+):\\s*$", file: 1, line: 2, column: 3 },
];

/** VS Code's built-in matchers (and esbuild's), as tasks.json would write them. */
const BUILT_IN: Record<string, Record<string, unknown>> = {
  tsc: { owner: "typescript", source: "ts", fileLocation: "relative", pattern: TSC_PATTERN },
  "tsc-watch": {
    owner: "typescript",
    source: "ts",
    fileLocation: "relative",
    pattern: TSC_PATTERN,
    background: {
      activeOnStart: true,
      beginsPattern:
        "(?:Starting compilation in watch mode|File change detected\\. Starting incremental compilation)",
      endsPattern: "(?:Compilation complete\\.|Found \\d+ errors?\\.) Watching for file changes\\.",
    },
  },
  "eslint-stylish": {
    owner: "eslint",
    source: "eslint",
    fileLocation: "absolute",
    pattern: [
      { regexp: "^([^\\s].*)$", file: 1 },
      {
        regexp: "^\\s+(\\d+):(\\d+)\\s+(error|warning|info)\\s+(.*?)(?:\\s\\s+(\\S*))?$",
        line: 1,
        column: 2,
        severity: 3,
        message: 4,
        code: 5,
        loop: true,
      },
    ],
  },
  "eslint-compact": {
    owner: "eslint",
    source: "eslint",
    fileLocation: "absolute",
    pattern: {
      regexp:
        "^(.+):\\sline\\s(\\d+),\\scol\\s(\\d+),\\s(Error|Warning|Info)\\s-\\s(.+)\\s\\((.+)\\)$",
      file: 1,
      line: 2,
      column: 3,
      severity: 4,
      message: 5,
      code: 6,
    },
  },
  gcc: {
    owner: "cpp",
    source: "gcc",
    fileLocation: "autoDetect",
    pattern: {
      regexp: "^(.*?):(\\d+):(\\d*):?\\s+(?:fatal\\s+)?(warning|error):\\s+(.*)$",
      file: 1,
      line: 2,
      column: 3,
      severity: 4,
      message: 5,
    },
  },
  msCompile: {
    owner: "msCompile",
    source: "cpp",
    fileLocation: "absolute",
    pattern: {
      regexp:
        "^(?:\\s*\\d+>)?(\\S.*?)(?:\\((\\d+|\\d+,\\d+|\\d+,\\d+,\\d+,\\d+)\\))?\\s*:\\s+(?:(\\S+)\\s+)?((?:fatal +)?error|warning|info)\\s+(\\w+\\d+)\\s*:\\s*(.*)$",
      file: 1,
      location: 2,
      severity: 4,
      code: 5,
      message: 6,
    },
  },
  go: {
    owner: "go",
    source: "go",
    fileLocation: "relative",
    pattern: {
      regexp: "^([^:]*: )?((.:)?[^:]*):(\\d+)(:(\\d+))?: (.*)$",
      file: 2,
      line: 4,
      column: 6,
      message: 7,
    },
  },
  rustc: {
    owner: "rustc",
    source: "rustc",
    fileLocation: "autoDetect",
    pattern: [
      { regexp: "^(warning|warn|error)(?:\\[(.*?)\\])?: (.*)$", severity: 1, code: 2, message: 3 },
      { regexp: "^[\\s->=]*(.*?):(\\d*):(\\d*)\\s*$", file: 1, line: 2, column: 3 },
    ],
  },
  jshint: {
    owner: "jshint",
    source: "jshint",
    fileLocation: "absolute",
    pattern: {
      regexp: "^(.*):\\s+line\\s+(\\d+),\\s+col\\s+(\\d+),\\s(.+?)(?:\\s+\\((\\w)(\\d+)\\))?$",
      file: 1,
      line: 2,
      column: 3,
      message: 4,
      severity: 5,
      code: 6,
    },
  },
  lessCompile: {
    owner: "lessCompile",
    source: "less",
    fileLocation: "absolute",
    pattern: { regexp: "^\\s*(.*) in file (.*) line no. (\\d+)$", message: 1, file: 2, line: 3 },
  },
  esbuild: {
    owner: "esbuild",
    source: "esbuild",
    fileLocation: "relative",
    pattern: ESBUILD_PATTERN,
  },
  "esbuild-watch": {
    owner: "esbuild",
    source: "esbuild",
    fileLocation: "relative",
    pattern: ESBUILD_PATTERN,
    background: {
      activeOnStart: true,
      beginsPattern: "\\[watch\\] build started",
      endsPattern: "\\[watch\\] build finished",
    },
  },
};

export const BUILT_IN_MATCHERS = Object.keys(BUILT_IN).map((n) => `$${n}`);

const num = (v: unknown) => (typeof v === "number" && v >= 0 ? v : undefined);

function toRegExp(v: unknown): RegExp | null {
  if (typeof v !== "string" || !v) return null;
  try {
    return new RegExp(v);
  } catch {
    return null;
  }
}

function parsePattern(raw: unknown, single: boolean): ProblemPattern | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as RawPattern;
  const regexp = toRegExp(r.regexp);
  if (!regexp) return null;
  const p: ProblemPattern = { regexp };
  for (const key of [
    "file",
    "location",
    "line",
    "column",
    "endLine",
    "endColumn",
    "severity",
    "code",
    "message",
  ] as const) {
    const n = num(r[key]);
    if (n !== undefined) p[key] = n;
  }
  if (r.loop === true) p.loop = true;
  // VS Code's defaults for a lone pattern: file 1, location 2, message 3.
  if (single) {
    p.file ??= 1;
    if (p.line === undefined && p.location === undefined) p.location = 2;
    p.message ??= 3;
  }
  return p;
}

/** A workspace folder by name, for `${workspaceFolder:Name}` in a matcher's `fileLocation`. */
export interface MatcherFolder {
  name: string;
  path: string;
}

function parseFileLocation(
  v: unknown,
  root: string,
  folders: readonly MatcherFolder[] = [],
): ProblemMatcher["fileLocation"] {
  const kind = Array.isArray(v) ? v[0] : v;
  const base = Array.isArray(v) && typeof v[1] === "string" ? v[1] : undefined;
  const k = kind === "absolute" || kind === "autoDetect" ? kind : "relative";
  // `${workspaceFolder}` is the task's folder; `${workspaceFolder:api}` names one (D251).
  const filled = base?.replace(
    /\$\{workspaceFolder(?::([^}]+))?\}/g,
    (whole, name: string | undefined) =>
      name === undefined ? root : (folders.find((f) => f.name === name)?.path ?? whole),
  );
  return { kind: k, base: filled ?? root };
}

const SEVERITIES = new Set(["error", "warning", "info"]);

/** Matchers and patterns extensions contribute, by name (VS Code's `contributes.problemMatchers`). */
export interface NamedMatchers {
  matchers: ReadonlyMap<string, unknown>;
  patterns: ReadonlyMap<string, unknown>;
}

/**
 * The matchers a task's `problemMatcher` names or defines ("$tsc", an object, or a list of
 * them; `base` extends a named one). Names are the built-in ones, then extensions' (`named`); a
 * `pattern` may name an extension's problem pattern ("$name"). Unknown names are returned in
 * `unknown`. `root` is the task's workspace folder (relative paths and `${workspaceFolder}`);
 * `folders` the workspace's, for `${workspaceFolder:Name}` (D251).
 */
export function resolveMatchers(
  value: unknown,
  root: string,
  named?: NamedMatchers,
  folders?: readonly MatcherFolder[],
): { matchers: ProblemMatcher[]; unknown: string[] } {
  const byName = (name: string): Record<string, unknown> | undefined => {
    const key = name.replace(/^\$/, "");
    const found = BUILT_IN[key] ?? named?.matchers.get(key);
    return found && typeof found === "object" ? (found as Record<string, unknown>) : undefined;
  };
  const list = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
  const matchers: ProblemMatcher[] = [];
  const unknown: string[] = [];
  for (const item of list) {
    let raw: Record<string, unknown> | undefined;
    if (typeof item === "string") {
      raw = byName(item);
      if (!raw) unknown.push(item);
    } else if (item && typeof item === "object") {
      const own = item as Record<string, unknown>;
      const base = typeof own.base === "string" ? byName(own.base) : undefined;
      if (typeof own.base === "string" && !base) unknown.push(own.base);
      raw = { ...(base ?? {}), ...own };
    }
    if (!raw) continue;
    let pattern = raw.pattern;
    // "$name": an extension's problem pattern.
    if (typeof pattern === "string") {
      const found = named?.patterns.get(pattern.replace(/^\$/, ""));
      if (found === undefined) unknown.push(pattern);
      pattern = found;
    }
    const rawPatterns = Array.isArray(pattern) ? pattern : [pattern];
    const patterns = rawPatterns
      .map((p) => parsePattern(p, rawPatterns.length === 1))
      .filter((p): p is ProblemPattern => p !== null);
    if (!patterns.length) continue;
    const bg = raw.background as Record<string, unknown> | undefined;
    const begins = toRegExp(bg?.beginsPattern);
    const ends = toRegExp(bg?.endsPattern);
    const severity = String(raw.severity ?? "error");
    matchers.push({
      owner: typeof raw.owner === "string" ? raw.owner : "external",
      ...(typeof raw.source === "string" && { source: raw.source }),
      severity: SEVERITIES.has(severity) ? (severity as ExternalProblem["severity"]) : "error",
      fileLocation: parseFileLocation(raw.fileLocation, root, folders),
      patterns,
      ...(begins &&
        ends && { background: { activeOnStart: bg?.activeOnStart === true, begins, ends } }),
    });
  }
  return { matchers, unknown };
}

function severityOf(text: string | undefined, fallback: ExternalProblem["severity"]) {
  const t = (text ?? "").toLowerCase();
  if (t.includes("err") || t === "e" || t.includes("fatal")) return "error";
  if (t.startsWith("warn") || t === "w") return "warning";
  if (t.startsWith("info") || t.startsWith("note") || t.startsWith("hint") || t === "i")
    return "info";
  return fallback;
}

/** Strips terminal escape sequences (colors, cursor moves, OSC titles). */
export function stripEscapes(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the point
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the point
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the point
      .replace(/\x1b[@-_]/g, "")
  );
}

type Partial = Record<string, string | undefined>;

/** Longest unfinished line kept while waiting for its end. */
const MAX_PENDING = 64 * 1024;
/**
 * Problems kept per matcher. A long-running task whose matcher has no background pattern (or
 * a watch build that never ends) would otherwise collect every problem it ever printed.
 */
export const MAX_PROBLEMS = 5000;

/** One output line as printed: escapes removed, and only what follows the last \r (redraws). */
export function cleanLine(raw: string): string {
  const text = stripEscapes(raw.replace(/\r+$/, ""));
  const cr = text.lastIndexOf("\r");
  return cr >= 0 ? text.slice(cr + 1) : text;
}

/**
 * Feeds a task's output through its matchers. `onChange` gets every problem found so far (a
 * background matcher's: those of its last finished rebuild, then the new ones as they come).
 */
export class ProblemCollector {
  private buffer = "";
  private readonly state: {
    matcher: ProblemMatcher;
    /** Index of the next pattern in a multi-line match; data gathered so far. */
    next: number;
    data: Partial;
    /** Background: inside a rebuild (begins seen, ends not yet). */
    active: boolean;
    found: ExternalProblem[];
    /** Background: the last finished rebuild's problems. */
    previous: ExternalProblem[];
  }[];
  /** Background matchers: the first rebuild finished (watch tasks are "ready"). */
  private idleSeen = false;
  onChange: (problems: ExternalProblem[]) => void = () => {};
  /** A background matcher's rebuild started (true) or finished (false). */
  onActivity: (active: boolean) => void = () => {};

  constructor(matchers: readonly ProblemMatcher[]) {
    this.state = matchers.map((matcher) => ({
      matcher,
      next: 0,
      data: {},
      active: matcher.background?.activeOnStart ?? true,
      found: [],
      previous: [],
    }));
  }

  get hasBackground(): boolean {
    return this.state.some((s) => s.matcher.background);
  }

  /** A background matcher finished a rebuild at least once. */
  get ready(): boolean {
    return this.idleSeen;
  }

  /**
   * Everything found so far. A background matcher: its last finished rebuild's problems, until
   * the rebuild in progress reports its first.
   */
  problems(): ExternalProblem[] {
    return this.state.flatMap((s) => {
      if (!s.matcher.background) return s.found;
      if (s.active && s.found.length) return s.found;
      return s.previous;
    });
  }

  feed(text: string): void {
    // Raw text is buffered and cleaned per complete line: an escape sequence split across two
    // chunks is then still whole. A lone \r (progress bars redrawing a line) starts the line over.
    this.buffer += text;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    // A line that never ends (a long progress bar): keep only its end.
    if (this.buffer.length > MAX_PENDING) this.buffer = this.buffer.slice(-MAX_PENDING);
    let changed = false;
    for (const line of lines) changed = this.line(cleanLine(line)) || changed;
    if (changed) this.onChange(this.problems());
  }

  /** The output ended: the last line without a newline counts too. */
  end(): void {
    const rest = this.buffer;
    this.buffer = "";
    if (rest && this.line(cleanLine(rest))) this.onChange(this.problems());
  }

  private line(text: string): boolean {
    let changed = false;
    for (const s of this.state) {
      const bg = s.matcher.background;
      if (bg?.begins.test(text)) {
        s.active = true;
        s.found = [];
        s.next = 0;
        this.onActivity(true);
        changed = true;
      }
      if (bg?.ends.test(text)) {
        s.active = false;
        s.previous = s.found;
        s.next = 0;
        this.idleSeen = true;
        this.onActivity(false);
        changed = true;
        continue;
      }
      if (bg && !s.active) continue;
      if (this.match(s, text)) changed = true;
    }
    return changed;
  }

  private match(s: (typeof this.state)[number], text: string): boolean {
    const patterns = s.matcher.patterns;
    const last = patterns.length - 1;
    // In a loop (the last pattern repeating): another match is another problem.
    if (s.next > last) {
      const m = patterns[last]?.regexp.exec(text);
      if (m) return this.emit(s, { ...s.data, ...this.groups(patterns[last], m) });
      s.next = 0;
      s.data = {};
    }
    const pattern = patterns[s.next];
    const m = pattern?.regexp.exec(text);
    if (!pattern || !m) {
      // A multi-line match broke off: this line may start a new one.
      if (s.next > 0) {
        s.next = 0;
        s.data = {};
        return this.match(s, text);
      }
      return false;
    }
    const data = { ...s.data, ...this.groups(pattern, m) };
    if (s.next < last) {
      s.next += 1;
      s.data = data;
      return false;
    }
    if (pattern.loop) {
      // Keep what the earlier patterns found (the file) for the repeats.
      s.next = last + 1;
      const earlier = new Set(
        patterns.slice(0, last).flatMap((p) => Object.keys(this.groups(p, null))),
      );
      s.data = Object.fromEntries(Object.entries(data).filter(([k]) => earlier.has(k)));
    } else {
      s.next = 0;
      s.data = {};
    }
    return this.emit(s, data);
  }

  /** The pattern's groups by role (undefined where the match has none; `m` null: the keys). */
  private groups(p: ProblemPattern | undefined, m: RegExpExecArray | null): Partial {
    const out: Partial = {};
    if (!p) return out;
    for (const key of [
      "file",
      "location",
      "line",
      "column",
      "endLine",
      "endColumn",
      "severity",
      "code",
      "message",
    ] as const) {
      const i = p[key];
      if (i !== undefined) out[key] = m ? m[i] : undefined;
    }
    return out;
  }

  private emit(s: (typeof this.state)[number], d: Partial): boolean {
    const file = d.file?.trim();
    if (!file) return false;
    const loc = (d.location ?? "").split(",").map((x) => Number.parseInt(x, 10));
    const line = Number.parseInt(d.line ?? "", 10) || loc[0] || 1;
    const column = Number.parseInt(d.column ?? "", 10) || (loc.length >= 2 ? loc[1] : 0) || 1;
    const endLine = Number.parseInt(d.endLine ?? "", 10) || (loc.length >= 4 ? loc[2] : 0) || line;
    const endColumn =
      Number.parseInt(d.endColumn ?? "", 10) ||
      (loc.length >= 4 ? loc[3] : 0) ||
      // No end: to the end of the line (Monaco clamps).
      (endLine === line ? 1000 : 1);
    // Relative paths resolve against the matcher's base (the workspace folder by default);
    // absolute ones stay (normalized).
    const path = resolveInRoot(s.matcher.fileLocation.base ?? "", file);
    const message = (d.message ?? "").trim() || "Problem";
    s.found.push({
      path,
      severity: severityOf(d.severity, s.matcher.severity),
      message,
      source: s.matcher.source ?? s.matcher.owner,
      code: d.code || undefined,
      line,
      column,
      endLine,
      endColumn,
    });
    // Past the cap the oldest go: the output's end is what's current.
    if (s.found.length > MAX_PROBLEMS) s.found.splice(0, s.found.length - MAX_PROBLEMS);
    return true;
  }
}
