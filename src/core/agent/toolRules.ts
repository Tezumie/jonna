// Claude Code's permission patterns on tools other than Bash (D221), as written in a command's or
// a skill's `allowed-tools` / `disallowed-tools`: `Read(src/**)`, `Edit(/docs/**)`,
// `Write(~/notes/*.md)`, `WebFetch(domain:docs.rs)`. A path pattern follows gitignore rules: a
// pattern with no `/` matches the name in any folder, `/x` is anchored at the open folder, `//x`
// is an absolute path and `~/x` is in the home folder; a folder's pattern covers what's inside.
// D229: Read rules also cover search and find_files, as Claude Code applies them to Grep and
// Glob: a search limited to a refused folder is refused, and a refused `Read(…)` keeps its files
// out of their results. `WebSearch(…)` stands for web_search whole (it has no pattern of its own).
// Bash patterns stay in slash.ts (they match command lines). DOM-free and tested.
import { globToRegExp } from "../paths/glob";
import { hostOf } from "./autoApprove";

/** An entry as written: its tool and the pattern inside `( )`, or null for the whole tool. */
export function parseToolEntry(entry: string): { tool: string; pattern: string | null } {
  const m = /^\s*([\w-]+)\s*(?:\(([\s\S]*)\))?\s*$/.exec(entry);
  if (!m) return { tool: entry.trim(), pattern: null };
  const pattern = (m[2] ?? "").trim();
  return { tool: m[1] ?? "", pattern: pattern || null };
}

/** Claude Code's file tools → the IDE agent's tools that take a `path` of that kind. */
const PATH_TOOLS: Readonly<Record<string, readonly string[]>> = {
  read: ["read_file", "list_dir", "search"],
  edit: ["edit_file", "write_file"],
  multiedit: ["edit_file"],
  notebookedit: ["edit_file"],
  write: ["write_file"],
  ls: ["list_dir"],
  glob: ["list_dir"],
};

/** `WebSearch(…)`: the whole web_search tool, whatever is inside (D229). */
export const isWholeToolEntry = (entry: string): boolean =>
  /^websearch$/i.test(parseToolEntry(entry).tool);

export interface RuleContext {
  /** The open folder (absolute), for relative and `/` patterns. */
  root: string | null;
  /**
   * A multi-root workspace's folders (D251; `root` is the first): a relative pattern is matched
   * relative to the folder holding the path, and a relative path may start with a folder's name.
   */
  folders?: readonly { path: string; name: string }[];
  /** The home folder, for `~/` patterns. */
  home?: string | null;
  /**
   * Compare without case everywhere (a `disallowed-tools` entry: `Read(.env)` must also stop
   * `.ENV` on macOS' case-insensitive disks). Allowing stays case-sensitive outside Windows.
   */
  foldCase?: boolean;
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
/** Windows paths compare without case (a drive letter, or a UNC share). */
const windowsy = (p: string) => /^[A-Za-z]:\//.test(p) || p.startsWith("//");

/** The path of a call's `path` argument, absolute (`/` separated); null when it has none. */
function callPath(args: Record<string, unknown>, ctx: RuleContext): string | null {
  const raw = typeof args.path === "string" ? args.path.trim() : "";
  const root = ctx.root ? norm(ctx.root) : null;
  if (!raw) return root; // list_dir with no path: the folder itself
  const p = norm(raw).replace(/^\.\//, "");
  if (/^[A-Za-z]:\//.test(p) || p.startsWith("/")) return collapse(p);
  // A multi-root workspace: "api/src/x" is in the folder named api.
  if (ctx.folders && ctx.folders.length > 1) {
    const [head, ...rest] = p.split("/");
    const named = ctx.folders.find((f) => f.name === head);
    if (named) return collapse(rest.length ? `${norm(named.path)}/${rest.join("/")}` : named.path);
  }
  return root ? collapse(`${root}/${p}`) : null;
}

/** A multi-root workspace's folders holding `abs` (`/` separated); none with one folder. */
function foldersHolding(abs: string, ctx: RuleContext): string[] {
  if (!ctx.folders || ctx.folders.length < 2) return [];
  return ctx.folders
    .map((f) => norm(f.path))
    .filter((base) => {
      const fold = (s: string) => (windowsy(abs) || windowsy(base) ? s.toLowerCase() : s);
      const a = fold(abs);
      const b = fold(base);
      return a === b || a.startsWith(`${b}/`);
    });
}

/**
 * `.` and `..` folded (`src/../package.json` is `package.json`, D226 audit), so a pattern can't be
 * matched by a path that climbs out of it. A `..` above the start of the path stays, so it never
 * matches an anchored pattern.
 */
function collapse(path: string): string {
  const drive = /^[A-Za-z]:/.test(path) ? path.slice(0, 2) : "";
  const unc = !drive && path.startsWith("//");
  const rest = path.slice(drive.length);
  const out: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else out.push(part);
  }
  return `${drive}${unc ? "//" : rest.startsWith("/") ? "/" : ""}${out.join("/")}`;
}

/**
 * Whether a gitignore-style path pattern covers `abs` (absolute, `/` separated). In a multi-root
 * workspace (D251) a relative pattern is matched relative to each folder holding the path.
 */
export function pathPatternMatches(pattern: string, abs: string, ctx: RuleContext): boolean {
  const relative = !/^(\/\/|~\/)/.test(norm(pattern.trim()));
  const holding = relative ? foldersHolding(abs, ctx) : [];
  if (holding.length)
    return holding.some((root) => matchesFrom(pattern, abs, { ...ctx, root, folders: [] }));
  return matchesFrom(pattern, abs, ctx);
}

function matchesFrom(pattern: string, abs: string, ctx: RuleContext): boolean {
  let p = norm(pattern.trim());
  if (!p) return false;
  let base: string | null;
  if (p.startsWith("//")) {
    // `//c:/x` or `//home/x`: an absolute path.
    const rest = p.slice(2);
    base = "";
    p = /^[A-Za-z]:\//.test(rest) ? rest : `/${rest}`;
  } else if (p.startsWith("~/")) {
    if (!ctx.home) return false;
    base = norm(ctx.home);
    p = p.slice(2);
  } else {
    if (!ctx.root) return false;
    base = norm(ctx.root);
    if (p.startsWith("/")) p = p.slice(1);
    else if (p.startsWith("./")) p = p.slice(2);
    // No `/` inside: the name in any folder (gitignore).
    else if (!p.includes("/")) p = `**/${p}`;
  }
  const insensitive = ctx.foldCase === true || windowsy(abs) || (base !== null && windowsy(base));
  const fold = (s: string) => (insensitive ? s.toLowerCase() : s);
  const target = fold(abs);
  let rel: string;
  if (base === "") rel = target;
  else {
    const b = fold(base);
    if (target !== b && !target.startsWith(`${b}/`)) return false;
    rel = target === b ? "" : target.slice(b.length + 1);
  }
  const pat = fold(p);
  const re = globToRegExp(pat);
  if (re.test(rel)) return true;
  // A folder's pattern covers the files inside it.
  return globToRegExp(`${pat}/**`).test(rel);
}

/** `WebFetch(domain:docs.rs)` covers docs.rs and its subdomains. */
function domainMatches(pattern: string, url: string): boolean {
  const m = /^domain:\s*(.+)$/i.exec(pattern.trim());
  if (!m?.[1]) return false;
  const want = m[1].trim().toLowerCase().replace(/^\*\./, "");
  const host = hostOf(url);
  return !!host && (host === want || host.endsWith(`.${want}`));
}

/** A call's web.fetch address (web_fetch, or through call_command), or null for any other call. */
function fetchUrl(name: string, args: Record<string, unknown>): string | null {
  if (name === "web_fetch") return typeof args.url === "string" ? args.url : "";
  if (name !== "call_command" || args.id !== "web.fetch") return null;
  const url = (args.input as { url?: unknown } | null | undefined)?.url;
  return typeof url === "string" ? url : "";
}

/**
 * Whether a call is one an entry stands for, when the entry is about part of a tool: a path
 * pattern on a file tool, `WebFetch` (whole, or a domain) on web.fetch through call_command.
 * False for entries this module doesn't read (Bash, whole other tools: slash.ts decides).
 */
export function patternEntryMatches(
  entry: string,
  name: string,
  args: Record<string, unknown>,
  ctx: RuleContext,
): boolean {
  const { tool, pattern } = parseToolEntry(entry);
  const t = tool.toLowerCase();
  if (t === "webfetch") {
    const url = fetchUrl(name, args);
    if (url === null) return false;
    return pattern === null || domainMatches(pattern, url);
  }
  const tools = PATH_TOOLS[t];
  if (!tools || pattern === null || !tools.includes(name)) return false;
  // search: every folder or glob it's limited to is under the pattern (none: the whole folder,
  // which a pattern doesn't cover; its matches are filtered instead, withoutRefusedResults).
  if (name === "search") {
    const include = Array.isArray(args.include)
      ? args.include.filter((x): x is string => typeof x === "string" && x.trim() !== "")
      : [];
    const covered = (p: string) => {
      const abs = callPath({ path: p.replace(/\/\*\*$/, "") }, ctx);
      // A folder whose every file the pattern covers (`secrets/**`) counts as covered.
      return (
        abs !== null &&
        (pathPatternMatches(pattern, abs, ctx) || pathPatternMatches(pattern, `${abs}/-`, ctx))
      );
    };
    // Its `path` (D306): the folder or file it's limited to.
    if (typeof args.path === "string" && args.path.trim() && covered(args.path.trim())) return true;
    return include.length > 0 && include.every(covered);
  }
  const abs = callPath(args, ctx);
  return abs !== null && pathPatternMatches(pattern, abs, ctx);
}

/** The tools whose refused path patterns filter search's and find_files' results. */
const RESULT_TOOLS: Readonly<Record<string, readonly string[]>> = {
  search: ["read"],
  find_files: ["read"],
};

/**
 * The file a line of search's result is about (D306): a matching line (`path:12: text`, or
 * `path: text` without line numbers), a context line (`path-11- text`), a count (`path:3`), or a
 * file of files_with_matches (the line itself). "--" and notes name none that exists.
 */
function searchLinePath(line: string): string | undefined {
  return (
    /^(.+?):\d+:/.exec(line)?.[1] ??
    /^(.+?)-\d+- /.exec(line)?.[1] ??
    /^(.+):\d+$/.exec(line)?.[1] ??
    /^(.+?): /.exec(line)?.[1] ??
    (line.trim() || undefined)
  );
}

/**
 * search's or find_files' result without the files a refused path pattern names (D229):
 * `Read(.env)`, `Read(secrets/**)` in `disallowed-tools`. search's lines are
 * `path:line: text`, find_files' a path each, relative to the open folder. Other results as they
 * are.
 */
export function withoutRefusedResults(
  disallowed: readonly string[],
  name: string,
  result: string,
  ctx: RuleContext,
): string {
  const tools = RESULT_TOOLS[name];
  if (!tools || !ctx.root) return result;
  const patterns = disallowed.flatMap((e) => {
    const { tool, pattern } = parseToolEntry(e);
    return pattern !== null && tools.includes(tool.toLowerCase()) ? [pattern] : [];
  });
  if (!patterns.length) return result;
  const fold = { ...ctx, foldCase: true };
  let dropped = 0;
  const kept = result.split("\n").filter((line) => {
    const path = name === "search" ? searchLinePath(line) : line.trim();
    if (!path) return true;
    const abs = callPath({ path }, ctx);
    const refused = abs !== null && patterns.some((p) => pathPatternMatches(p, abs, fold));
    if (refused) dropped++;
    return !refused;
  });
  if (!dropped) return result;
  return `${kept.join("\n")}\n(${dropped} result${dropped === 1 ? "" : "s"} the command's disallowed-tools refuses left out.)`;
}
