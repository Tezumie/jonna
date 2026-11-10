// What the Output tab shows of a channel (D209 leftovers): its filter box (VS Code's "Filter",
// `text, !exclude`) and the Git channel's lines (the git command lines the IDE ran, VS Code's
// `> git status -z`), with the level a git call is logged at. DOM-free and tested.
import type { OutputLevel } from "./output";

export interface OutputFilter {
  /** A line is shown when it holds one of these (any, when there are none)… */
  include: string[];
  /** …and none of these. */
  exclude: string[];
}

/** "error, !timeout" → include ["error"], exclude ["timeout"] (lowercased; blanks dropped). */
export function parseOutputFilter(query: string): OutputFilter {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const raw of query.split(",")) {
    const term = raw.trim().toLowerCase();
    if (term.startsWith("!")) {
      const rest = term.slice(1).trim();
      if (rest) exclude.push(rest);
    } else if (term) include.push(term);
  }
  return { include, exclude };
}

/** Whether `filter` is empty (every line shows). */
export function isEmptyFilter(filter: OutputFilter): boolean {
  return !filter.include.length && !filter.exclude.length;
}

/** Whether a line (as the tab shows it: time, level, text) passes `filter`. Case-insensitive. */
export function matchesFilter(line: string, filter: OutputFilter): boolean {
  if (isEmptyFilter(filter)) return true;
  const lower = line.toLowerCase();
  if (filter.exclude.some((t) => lower.includes(t))) return false;
  return !filter.include.length || filter.include.some((t) => lower.includes(t));
}

/** The lines that pass `filter`. */
export function filterLines(lines: readonly string[], filter: OutputFilter): string[] {
  return isEmptyFilter(filter) ? [...lines] : lines.filter((l) => matchesFilter(l, filter));
}

/** One argument as a shell would need it: quoted when it has spaces, quotes or is empty. */
function quoteArg(arg: string): string {
  // A Windows path's backslashes stay as they are (readable, and what PowerShell and cmd take).
  if (arg && !/[\s"'`$&|<>;()]/.test(arg)) return arg;
  return `"${arg.replace(/(["`$])/g, "\\$1")}"`;
}

/** `git status -z -- "a b.txt"`: the command line a git call ran. */
export function gitCommandLine(args: readonly string[]): string {
  return ["git", ...args.map(quoteArg)].join(" ");
}

/** Git's subcommands that only read: logged at trace (status refreshes run them all the time). */
const READ_ONLY = new Set([
  "blame",
  "cat-file",
  "check-attr",
  "check-ignore",
  "check-ref-format",
  "count-objects",
  "describe",
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
  "for-each-ref",
  "grep",
  "log",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "merge-base",
  "name-rev",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "show-ref",
  "status",
  "symbolic-ref",
  "var",
  "version",
]);

/** Options before the subcommand that take a value (`-c key=value`, `-C dir`). */
const GLOBAL_WITH_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace"]);

/** The subcommand of git's arguments (after global options), or "". */
export function gitSubcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (GLOBAL_WITH_VALUE.has(a)) i++;
    else if (!a.startsWith("-")) return a;
  }
  return "";
}

/** Whether a call with these arguments only reads (listing branches, tags, config, stashes…). */
export function gitReadsOnly(args: readonly string[]): boolean {
  const sub = gitSubcommand(args);
  if (READ_ONLY.has(sub)) return true;
  const rest = args.slice(args.indexOf(sub) + 1);
  const has = (...flags: string[]) => rest.some((a) => flags.includes(a));
  switch (sub) {
    case "config":
      return has("--get", "--get-all", "--get-regexp", "-l", "--list");
    case "branch":
    case "tag":
      if (has("-d", "-D", "-m", "-M", "-f", "--delete", "--force", "--set-upstream-to", "-u"))
        return false;
      // Listing: no name given (`git branch -a --format=…`, `git tag --sort=-creatordate`).
      return rest.every((a) => a.startsWith("-")) || has("-l", "--list", "--show-current");
    case "remote":
      return !rest.length || rest[0] === "-v" || rest[0] === "get-url" || rest[0] === "show";
    case "stash":
    case "worktree":
      return rest[0] === "list" || rest[0] === "show";
    default:
      return false;
  }
}

/** A finished git call as the Git channel shows it, and its level: changes at info, reads at
 * trace, failures at warn. */
export function gitCallRecord(call: {
  args: readonly string[];
  ms: number;
  error: string | null;
}): { level: OutputLevel; text: string } {
  const line = `> ${gitCommandLine(call.args)} [${Math.round(call.ms)} ms]`;
  if (call.error) return { level: "warn", text: `${line}\n${call.error}` };
  return { level: gitReadsOnly(call.args) ? "trace" : "info", text: line };
}
