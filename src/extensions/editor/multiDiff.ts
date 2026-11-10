// The multi-file diff tab's model (D229, VS Code's multi-diff editor): which files it lists and
// what each side of a file is. DOM-free and tested; the view is multiDiffView.ts.

import type { Json } from "../../core/dock/index";

/** One file of a multi-file diff. */
export interface MultiDiffEntry {
  /** Absolute path (the right side's file). */
  path: string;
  /** Status letter for the header (M, A, D, R, U…). */
  status?: string;
  /** Renames: the old path (shown "old → new"; repo-relative or absolute). */
  from?: string;
  /** Staged changes (HEAD ↔ index) instead of the working tree (index ↔ file). */
  staged?: boolean;
  /** A content source for the left side (e.g. git:<rev>@<old path>). */
  base?: string;
  /** A content source for the right side, read-only (e.g. git:<rev>). */
  head?: string;
}

export interface MultiDiffState {
  /** The tab's title ("Changes", "a1b2c3d · Fix the parser", "Incoming changes"). */
  title: string;
  /** Identifies what the tab shows, so opening it again reuses the tab. */
  source?: string;
  /** What the Refresh button runs to list the files again (it reopens this source). */
  refresh?: { command: string; input?: Json };
  files: MultiDiffEntry[];
  /** Files folded by the user (paths). */
  collapsed?: string[];
}

/** How a file's two sides are read. */
export type EntryKind = "range" | "staged" | "working";

export function entryKind(entry: MultiDiffEntry): EntryKind {
  if (entry.head) return "range";
  return entry.staged ? "staged" : "working";
}

/** Whether the right side is the file itself (the shared, editable document). */
export function isEditable(entry: MultiDiffEntry): boolean {
  return entryKind(entry) === "working" && entry.status !== "D";
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function readEntry(v: unknown): MultiDiffEntry | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const path = str(o.path);
  if (!path) return null;
  const status = str(o.status);
  const from = str(o.from);
  const base = str(o.base);
  const head = str(o.head);
  return {
    path,
    ...(status && { status }),
    ...(from && { from }),
    ...(o.staged === true && { staged: true }),
    ...(base && { base }),
    ...(head && { head }),
  };
}

/** A saved or passed state, checked (unknown fields dropped, bad entries skipped). */
export function readMultiDiffState(state: Json): MultiDiffState {
  const o = (typeof state === "object" && state !== null ? state : {}) as Record<string, unknown>;
  const files = Array.isArray(o.files)
    ? o.files.map(readEntry).filter((e): e is MultiDiffEntry => e !== null)
    : [];
  const source = str(o.source);
  const r = o.refresh as { command?: unknown; input?: unknown } | undefined;
  const refreshCommand = typeof r === "object" && r !== null ? str(r.command) : undefined;
  const collapsed = Array.isArray(o.collapsed)
    ? o.collapsed.filter((p): p is string => typeof p === "string")
    : [];
  return {
    title: str(o.title) ?? "Changes",
    ...(source && { source }),
    ...(refreshCommand && {
      refresh: {
        command: refreshCommand,
        ...(r?.input !== undefined && { input: r.input as Json }),
      },
    }),
    files,
    ...(collapsed.length && { collapsed }),
  };
}

/** A file's identity in the list (the same path can appear staged and changed). */
export function entryKey(entry: MultiDiffEntry): string {
  return `${entryKind(entry)}:${entry.path}`;
}

/**
 * The height to reserve for a file's diff before its editor exists (or after it's been let go):
 * its last measured height, else a guess from the line count, at most a screenful.
 */
export function placeholderHeight(
  measured: number | undefined,
  lines: number | undefined,
  lineHeight: number,
  max = 480,
): number {
  if (measured !== undefined && measured > 0) return measured;
  const guess = (lines ?? 6) * lineHeight;
  return Math.max(3 * lineHeight, Math.min(max, guess));
}

/** "3 files" / "1 file" for the toolbar. */
export function filesLabel(n: number): string {
  return `${n} file${n === 1 ? "" : "s"}`;
}

/** A file as the comparison sees it: what its header and two sides depend on. */
function fileKey(f: unknown): string {
  const o = (typeof f === "object" && f !== null ? f : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  return JSON.stringify([
    text(o.path),
    text(o.status),
    text(o.from),
    o.staged === true,
    text(o.base),
    text(o.head),
  ]);
}

/**
 * Whether a tab's saved file list (`files` of its state) is already `files`, in order: a list
 * that follows a status (D232) is set again only when it changed.
 */
export function sameDiffFiles(shown: unknown, files: readonly unknown[]): boolean {
  if (!Array.isArray(shown) || shown.length !== files.length) return false;
  return shown.every((f, i) => fileKey(f) === fileKey(files[i]));
}

/**
 * Where the view is in the list, so a new list of files can keep it (files above may come or
 * go): the file at the top of the view and how far into it. `tops` are the files' offsets in
 * the scrolled content, in order.
 */
export function scrollAnchor(
  keys: readonly string[],
  tops: readonly number[],
  scrollTop: number,
): { key: string; offset: number } | null {
  let at = -1;
  for (let i = 0; i < tops.length; i++) if ((tops[i] ?? 0) <= scrollTop) at = i;
  const key = keys[at];
  if (key === undefined) return null;
  return { key, offset: scrollTop - (tops[at] ?? 0) };
}

/**
 * The file Next file / Previous file goes to: from the focused file (`focused`, -1: none), the
 * one after or before it; with none focused, the first file below the top of the view or the
 * last one above it. Null: there's none that way.
 */
export function adjacentFile(
  tops: readonly number[],
  scrollTop: number,
  focused: number,
  direction: 1 | -1,
): number | null {
  let next = -1;
  if (focused >= 0) next = focused + direction;
  else if (direction === 1) next = tops.findIndex((t) => t > scrollTop + 1);
  else for (let i = 0; i < tops.length; i++) if ((tops[i] ?? 0) < scrollTop - 1) next = i;
  return next >= 0 && next < tops.length ? next : null;
}
