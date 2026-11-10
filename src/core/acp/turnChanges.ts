// The files an external agent changed in one turn (D208), DOM-free and tested. Codex, Claude Code
// and Gemini CLI write files themselves, not through ACP's fs/write_text_file, so the IDE compares
// the folder with what it was when the turn began: git's dirty files then and now (a file clean at
// the start is compared with HEAD), plus the files the agent's steps named, read when first named.

/** A file as it was read: its text, gone, or something not compared as text (binary, huge). */
export type FileSnap =
  | { kind: "text"; text: string }
  | { kind: "missing" }
  | { kind: "other"; sig: string };

export interface TextChange {
  path: string;
  /** null: the agent created it. */
  before: string | null;
  /** null: the agent deleted it. */
  after: string | null;
}

export type SnapChange = { kind: "text"; change: TextChange } | { kind: "other"; path: string };

/** What changed between two reads of `path`, or null (the same, or nothing to compare with). */
export function compareSnaps(
  path: string,
  before: FileSnap | undefined,
  after: FileSnap,
): SnapChange | null {
  if (!before) return null;
  if (before.kind === "missing" && after.kind === "missing") return null;
  if (before.kind === "other" || after.kind === "other") {
    if (before.kind === "other" && after.kind === "other" && before.sig === after.sig) return null;
    return { kind: "other", path };
  }
  const b = before.kind === "text" ? before.text : null;
  const a = after.kind === "text" ? after.text : null;
  if (b === a) return null;
  return { kind: "text", change: { path, before: b, after: a } };
}

/** `rel` (git's, with `/`) under `root`, with the platform's separator. */
export function joinPath(root: string, rel: string, windows: boolean): string {
  const sep = windows ? "\\" : "/";
  const base = root.replace(/[\\/]+$/, "");
  return `${base}${sep}${rel.split("/").filter(Boolean).join(sep)}`;
}

/** `path` relative to `root` with `/` (for git), or null when it's outside. */
export function relativeTo(root: string, path: string, windows: boolean): string | null {
  const norm = (p: string) => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return windows ? s.toLowerCase() : s;
  };
  const r = norm(root);
  const p = norm(path);
  if (!p.startsWith(`${r}/`)) return null;
  return path.replace(/\\/g, "/").slice(r.length + 1);
}

/** A path inside git's own folder or a dependency folder: never a change to show. */
export function ignoredPath(rel: string): boolean {
  return /(^|\/)(\.git|node_modules)(\/|$)/.test(rel);
}

/**
 * The paths to compare after a turn: dirty at the start or now (git), and the ones the agent's
 * steps named; each once (case-insensitive on Windows), at most `limit`.
 */
export function candidates(
  lists: readonly (readonly string[])[],
  windows: boolean,
  limit = 300,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists)
    for (const p of list) {
      const key = windows ? p.replace(/\//g, "\\").toLowerCase() : p;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
      if (out.length >= limit) return out;
    }
  return out;
}

/** A file's size and modified time, as `agent_tree_stats` lists it (D233). */
export interface TreeStat {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * Without git (D233): the files (relative, `/`) whose size or time differ between the folder's
 * listing at the turn's start and at its end, created ones and deleted ones. A listing that was
 * cut short (`truncated`) can't tell a deleted file from one past the cut, so deletions are only
 * reported when the start's listing was whole.
 */
export function treeChanges(
  before: readonly TreeStat[],
  after: readonly TreeStat[],
  beforeTruncated = false,
): string[] {
  const was = new Map(before.map((f) => [f.path, f]));
  const out: string[] = [];
  const now = new Set<string>();
  for (const f of after) {
    now.add(f.path);
    const old = was.get(f.path);
    if (!old) {
      // A file past the start's cut isn't new.
      if (!beforeTruncated) out.push(f.path);
    } else if (old.size !== f.size || old.mtimeMs !== f.mtimeMs) out.push(f.path);
  }
  if (!beforeTruncated) for (const f of before) if (!now.has(f.path)) out.push(f.path);
  return out;
}

/**
 * Folders a command filled in bulk during the turn (D294: a `git clone`, a download, an install):
 * a folder that didn't exist at the start and now holds at least `min` new files, by its path
 * relative to the root, with how many. Their files aren't put under review one by one (a clone of
 * 540 files kept the chat "working" while each was compared, and filled the review with them).
 * `created` are the new files' relative paths. Only meaningful when the start's listing was whole.
 */
export function bulkCreatedFolders(
  before: readonly TreeStat[],
  created: readonly string[],
  min = 100,
): Map<string, number> {
  const split = (p: string) => p.split(/[\\/]/).filter(Boolean);
  // Every folder that held a file at the start.
  const existed = new Set<string>([""]);
  for (const f of before) {
    const parts = split(f.path);
    for (let i = 1; i < parts.length; i++) existed.add(parts.slice(0, i).join("/"));
  }
  const counts = new Map<string, number>();
  for (const path of created) {
    const parts = split(path);
    // The highest folder of its path that didn't exist: the one the command made.
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (existed.has(dir)) continue;
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
      break;
    }
  }
  return new Map([...counts].filter(([, n]) => n >= min));
}

/**
 * What a file the user saved during the turn is compared from (D233): the agent's own write
 * before that save (a step that changed it) keeps the turn's start as the baseline, so the
 * agent's edit is credited (the user's save is part of the diff, and the chat says so);
 * otherwise the user's save is the baseline, so only what the agent did after it counts.
 */
export function baselineAfterSave(
  agentWroteAt: number | undefined,
  savedAt: number,
): "start" | "save" {
  return agentWroteAt !== undefined && agentWroteAt <= savedAt ? "start" : "save";
}

/** When one of an external agent's steps ran (D403), from its tool call's start to its end. */
export interface StepWindow {
  /** ACP's tool kind: read, edit, delete, move, search, execute, think, fetch, other. */
  kind: string;
  start: number;
  /** Still running: null. */
  end: number | null;
}

/** Kinds that can't write a file: a change made while only these ran isn't the agent's. */
const READ_ONLY_KINDS = new Set(["read", "search", "fetch", "think"]);

/** How far a file's time may sit outside a step's run and still be its change (clock, flush). */
export const STEP_SLACK_MS = 2000;

/**
 * Whether a file the agent's steps didn't name was changed by the agent (D403): it was modified
 * while one of its steps that can write was running. Something else editing the folder during
 * the turn (the person, a formatter, another agent) changes files between or beside its steps.
 * Without a time (the file was deleted), or from an agent that reported no steps at all (nothing
 * to judge by), it counts as the agent's, as before. So does a time from before the turn began
 * (`turnStart`, D407): a moved, copied or unpacked file keeps its source's time, which says
 * nothing about who made it.
 */
export function changedByAgent(
  modifiedAt: number | null,
  steps: readonly StepWindow[],
  now: number,
  turnStart = 0,
  slackMs = STEP_SLACK_MS,
): boolean {
  if (modifiedAt === null || modifiedAt <= 0 || !steps.length) return true;
  if (modifiedAt < turnStart - slackMs) return true;
  return steps.some(
    (s) =>
      !READ_ONLY_KINDS.has(s.kind) &&
      modifiedAt >= s.start - slackMs &&
      modifiedAt <= (s.end ?? now) + slackMs,
  );
}
