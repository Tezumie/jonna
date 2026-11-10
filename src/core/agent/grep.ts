// The agent's search tool (D306, after Claude Code's Grep): its arguments (Claude Code's names and
// the tool's older ones), the include globs a path / glob / type make, and the result in its three
// modes (matching lines with context, files, counts), paged with head_limit / offset. DOM-free;
// the extension runs the search and reads the files that context lines come from.

export type GrepMode = "content" | "files_with_matches" | "count";

export interface GrepArgs {
  pattern: string;
  regex: boolean;
  /** null: smart case (insensitive unless the pattern has a capital letter). */
  ignoreCase: boolean | null;
  mode: GrepMode;
  before: number;
  after: number;
  lineNumbers: boolean;
  onlyMatching: boolean;
  multiline: boolean;
  /** 0: no limit. */
  headLimit: number;
  offset: number;
  path: string | null;
  glob: string | null;
  type: string | null;
  /** The tool's older `include` globs (a union, as before). */
  include: string[];
}

export interface GrepMatch {
  /** 1-based. */
  line: number;
  text: string;
  /** [start, end) in `text`. */
  ranges: [number, number][];
}

export interface GrepFile {
  path: string;
  matches: GrepMatch[];
}

/** Matching lines (content mode), files or count entries a search returns by default. */
export const DEFAULT_HEAD_LIMIT = 250;
/** Context lines at most, before or after a match. */
const MAX_CONTEXT = 20;
/** The longest result: past it the page ends early and says where the next one starts. */
export const GREP_RESULT_CHARS = 20_000;
/** Context lines are cut like matching lines are (the engine cuts those at 300). */
const LINE_CHARS = 300;

/** File types for `type` (ripgrep's names), as extensions. */
const FILE_TYPES: Record<string, string[]> = {
  js: ["js", "jsx", "mjs", "cjs"],
  ts: ["ts", "tsx", "mts", "cts"],
  py: ["py", "pyi"],
  rust: ["rs"],
  go: ["go"],
  java: ["java"],
  kotlin: ["kt", "kts"],
  c: ["c", "h"],
  cpp: ["cpp", "cc", "cxx", "c++", "hpp", "hh", "hxx", "h"],
  cs: ["cs"],
  css: ["css", "scss", "sass", "less"],
  html: ["html", "htm"],
  json: ["json", "jsonc"],
  md: ["md", "markdown", "mdx"],
  yaml: ["yaml", "yml"],
  toml: ["toml"],
  xml: ["xml"],
  sh: ["sh", "bash", "zsh"],
  ps: ["ps1", "psm1", "psd1"],
  ruby: ["rb"],
  php: ["php"],
  swift: ["swift"],
  scala: ["scala"],
  lua: ["lua"],
  dart: ["dart"],
  sql: ["sql"],
  vue: ["vue"],
  svelte: ["svelte"],
  r: ["r", "R"],
  txt: ["txt"],
};
const TYPE_ALIASES: Record<string, string> = {
  javascript: "js",
  typescript: "ts",
  python: "py",
  rs: "rust",
  golang: "go",
  csharp: "cs",
  "c++": "cpp",
  markdown: "md",
  yml: "yaml",
  shell: "sh",
  bash: "sh",
  powershell: "ps",
  rb: "ruby",
  kt: "kotlin",
};

/** The extensions of file type `type`, or null when it isn't one. */
export function typeExtensions(type: string): string[] | null {
  const key = type.trim().toLowerCase().replace(/^\./, "");
  return FILE_TYPES[TYPE_ALIASES[key] ?? key] ?? null;
}

const first = (args: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys)
    if (args[k] !== undefined && args[k] !== null && args[k] !== "") return args[k];
  return undefined;
};

/** A count from a model (a number, or a number in a string); `fallback` otherwise. */
function count(v: unknown, fallback: number): number {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function flag(v: unknown): boolean | null {
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return null;
}

/**
 * The search's arguments from a call: Claude Code's Grep names (`pattern`, `-A`, `-i`,
 * `output_mode`…), the readable names the tool advertises (`context`, `ignore_case`…) and its
 * older ones (`query` + `regex`, `include`). `pattern` is a regular expression unless `regex` is
 * false; `query` is literal text unless `regex` is true.
 */
export function grepArgs(args: Record<string, unknown>): GrepArgs | { error: string } {
  const pattern = first(args, ["pattern", "query", "regex_pattern", "q"]);
  if (typeof pattern !== "string" || !pattern)
    return { error: '"pattern" is required (the text or regular expression to find).' };
  const fromPattern = typeof args.pattern === "string" && args.pattern !== "";
  const regexFlag = flag(args.regex ?? args.isRegex);
  const modeRaw = String(first(args, ["output_mode", "mode", "outputMode"]) ?? "content");
  const mode: GrepMode | null =
    modeRaw === "content" || modeRaw === "lines"
      ? "content"
      : modeRaw === "files_with_matches" || modeRaw === "files" || modeRaw === "files_only"
        ? "files_with_matches"
        : modeRaw === "count" || modeRaw === "counts"
          ? "count"
          : null;
  if (!mode)
    return {
      error: `output_mode "${modeRaw}" isn't one of "content", "files_with_matches", "count".`,
    };
  const both = count(first(args, ["context", "-C", "C"]), 0);
  const include = (() => {
    const raw = args.include;
    if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === "string" && !!g);
    return typeof raw === "string" && raw ? [raw] : [];
  })();
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const type = text(args.type);
  if (type && !typeExtensions(type))
    return {
      error: `type "${type}" isn't a file type this search knows (${Object.keys(FILE_TYPES).join(", ")}); use glob instead, e.g. "*.ext".`,
    };
  const ignoreCase = flag(first(args, ["ignore_case", "-i", "i", "case_insensitive"]));
  const caseSensitive = flag(args.case_sensitive ?? args.matchCase);
  return {
    pattern,
    regex: regexFlag ?? fromPattern,
    ignoreCase: ignoreCase ?? (caseSensitive === null ? null : !caseSensitive),
    mode,
    before: Math.min(MAX_CONTEXT, count(first(args, ["before", "-B", "B"]), both)),
    after: Math.min(MAX_CONTEXT, count(first(args, ["after", "-A", "A"]), both)),
    lineNumbers: flag(first(args, ["line_numbers", "-n", "n"])) ?? true,
    onlyMatching: flag(first(args, ["only_matching", "-o", "o"])) ?? false,
    multiline: flag(args.multiline) ?? false,
    headLimit: count(first(args, ["head_limit", "limit", "max_results"]), DEFAULT_HEAD_LIMIT),
    offset: count(args.offset, 0),
    path: text(args.path),
    glob: text(first(args, ["glob", "files"])),
    type,
    include,
  };
}

/** Whether matching ignores case: as asked, else smart case. */
export function grepIgnoresCase(a: GrepArgs): boolean {
  return a.ignoreCase ?? !/\p{Lu}/u.test(a.pattern);
}

/** A path as a glob that matches only itself (`app/[id]` has glob characters). */
function literalGlob(path: string): string {
  return path.replace(/[[\]*?{}]/g, "[$&]");
}

/**
 * The search engine's include globs for a call: `path` (a folder: everything in it; a file: that
 * file), then `glob` or `type` inside it. A glob without `/` matches a name at any depth (as
 * ripgrep's --glob). The old `include` globs join as they are.
 */
export function includeGlobs(
  a: Pick<GrepArgs, "glob" | "type" | "include">,
  path: { rel: string; isFile: boolean } | null,
): string[] {
  const exts = a.type ? typeExtensions(a.type) : null;
  const patterns = a.glob
    ? [a.glob]
    : exts
      ? [exts.length === 1 ? `*.${exts[0]}` : `*.{${exts.join(",")}}`]
      : [];
  const rel =
    path?.rel
      .replace(/\\/g, "/")
      .replace(/^\.\/?/, "")
      .replace(/\/+$/, "") ?? "";
  if (!path || !rel) return [...patterns, ...a.include];
  if (path.isFile) return [rel, ...a.include];
  const dir = literalGlob(rel);
  if (!patterns.length) return [`${dir}/**`, ...a.include];
  return [
    ...patterns.map((p) => {
      const inner = p.replace(/^\.\//, "").replace(/^\/+/, "");
      return inner.includes("/") || inner.startsWith("**")
        ? `${dir}/${inner}`
        : `${dir}/**/${inner}`;
    }),
    ...a.include,
  ];
}

/** Whether `path` has one of `type`'s extensions (a type given with a glob filters afterwards). */
export function matchesType(path: string, type: string | null): boolean {
  if (!type) return true;
  const exts = typeExtensions(type);
  if (!exts) return true;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return exts.some((e) => name.toLowerCase().endsWith(`.${e.toLowerCase()}`));
}

/** Files in a stable order (paging with offset needs the same order every time). */
export function sortFiles(files: readonly GrepFile[]): GrepFile[] {
  return [...files]
    .map((f) => ({ ...f, matches: [...f.matches].sort((x, y) => x.line - y.line) }))
    .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/** One page of the result: the entries it shows and how many there are in all. */
export interface GrepPage {
  /** content: the shown matches, by file; files / count: the shown files. */
  files: GrepFile[];
  total: number;
  /** Index (0-based, in `total`) of the first entry shown. */
  start: number;
  /** Entries shown. */
  shown: number;
}

/** The entries `offset` and `head_limit` pick (content: matching lines; else files). */
export function grepPage(files: readonly GrepFile[], a: GrepArgs): GrepPage {
  const limit = a.headLimit === 0 ? Number.POSITIVE_INFINITY : a.headLimit;
  if (a.mode !== "content") {
    const page = files.slice(a.offset, a.offset + limit);
    return { files: page, total: files.length, start: a.offset, shown: page.length };
  }
  const total = files.reduce((n, f) => n + f.matches.length, 0);
  const out: GrepFile[] = [];
  let index = 0;
  let shown = 0;
  for (const f of files) {
    if (shown >= limit) break;
    if (index + f.matches.length <= a.offset) {
      index += f.matches.length;
      continue;
    }
    const from = Math.max(0, a.offset - index);
    const take = f.matches.slice(from, from + (limit - shown));
    index += f.matches.length;
    if (take.length) {
      out.push({ path: f.path, matches: take });
      shown += take.length;
    }
  }
  return { files: out, total, start: Math.min(a.offset, total), shown };
}

const cut = (text: string) => (text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS)}…` : text);

/**
 * The result text of a page. `linesOf` gives a shown file's lines for context (null: unreadable,
 * the matches show alone). `extra`: notes after the page (files left out, the engine's cap).
 */
export function grepResult(
  page: GrepPage,
  a: GrepArgs,
  linesOf: (path: string) => readonly string[] | null,
  extra: string[] = [],
): string {
  const kind =
    a.mode === "content" ? "matching lines" : a.mode === "count" ? "files with counts" : "files";
  if (page.total === 0) return ["No matches.", ...extra].join("\n");
  if (page.shown === 0)
    return [`offset ${a.offset} is past the end: there are ${page.total} ${kind}.`, ...extra].join(
      "\n",
    );
  const out: string[] = [];
  let chars = 0;
  // Entries actually written (the character cap may end the page early).
  let written = 0;
  const push = (lines: string[]): boolean => {
    const size = lines.reduce((n, l) => n + l.length + 1, 0);
    if (written > 0 && chars + size > GREP_RESULT_CHARS) return false;
    out.push(...lines);
    chars += size;
    return true;
  };
  if (a.mode === "files_with_matches") {
    for (const f of page.files) {
      if (!push([f.path])) break;
      written++;
    }
  } else if (a.mode === "count") {
    for (const f of page.files) {
      if (!push([`${f.path}:${f.matches.length}`])) break;
      written++;
    }
  } else {
    const num = (n: number, sep: string) => (a.lineNumbers ? `${n}${sep} ` : " ");
    const context = (a.before > 0 || a.after > 0) && !a.onlyMatching;
    let full = false;
    for (const f of page.files) {
      if (full) break;
      const lines = context ? linesOf(f.path) : null;
      if (!lines) {
        for (const m of f.matches) {
          const rows = a.onlyMatching
            ? (m.ranges.length ? m.ranges : [[0, m.text.length] as [number, number]]).map(
                ([s, e]) => `${f.path}:${num(m.line, ":")}${m.text.slice(s, e)}`,
              )
            : [`${f.path}:${num(m.line, ":")}${m.text.trimEnd()}`];
          if (!push(rows)) {
            full = true;
            break;
          }
          written++;
        }
        continue;
      }
      // Context: each match's lines around it, overlapping groups merged, "--" between groups.
      const matched = new Set(f.matches.map((m) => m.line));
      let group: string[] = [];
      let groupMatches = 0;
      let end = 0;
      const flush = (): boolean => {
        if (!group.length) return true;
        const rows = out.length ? ["--", ...group] : group;
        if (!push(rows)) return false;
        written += groupMatches;
        group = [];
        groupMatches = 0;
        return true;
      };
      for (const m of f.matches) {
        const from = Math.max(1, m.line - a.before);
        const to = Math.min(lines.length, m.line + a.after);
        if (group.length && from > end + 1 && !flush()) {
          full = true;
          break;
        }
        for (let n = Math.max(from, end + 1); n <= to; n++) {
          const text = n === m.line ? m.text.trimEnd() : cut((lines[n - 1] ?? "").trimEnd());
          group.push(
            matched.has(n) && n !== m.line
              ? `${f.path}:${num(n, ":")}${cut((lines[n - 1] ?? "").trimEnd())}`
              : n === m.line
                ? `${f.path}:${num(n, ":")}${text}`
                : `${f.path}-${num(n, "-")}${text}`,
          );
        }
        groupMatches++;
        end = Math.max(end, to);
      }
      if (!full && !flush()) full = true;
    }
  }
  const next = page.start + written;
  const left = page.total - next;
  const notes = [
    ...(left > 0
      ? [
          `… ${left} more ${kind} (showing ${page.start + 1}-${next} of ${page.total}): pass offset: ${next} for the next page${written < page.shown ? "" : ", or narrow the search with path, glob or type"}.`,
        ]
      : page.start > 0
        ? [`(${kind} ${page.start + 1}-${next} of ${page.total})`]
        : []),
    ...(a.mode === "count"
      ? [
          `${page.files.slice(0, written).reduce((n, f) => n + f.matches.length, 0)} matching lines in these ${written} files.`,
        ]
      : []),
    ...extra,
  ];
  return [...out, ...notes].join("\n");
}
