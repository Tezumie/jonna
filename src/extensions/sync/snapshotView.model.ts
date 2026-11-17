// Looking inside a snapshot before restoring it: its files, each with how it stands against the
// open folder. The words, the order, the filter and the counts, and what the Sync tab keeps of the
// snapshot being looked at. DOM-free; the tab draws it (snapshotView.ts) and the commands fill it
// (snapshotView.commands.ts).
//
// Two kinds of snapshot are looked at this way: one of the open project's own, and one a
// teammate shared (shareView.ts). A shared one stands against the open folder only when that
// folder is the same project; otherwise its files are listed without a comparison
// (`compared` false) and nothing of it is restored into the folder.
import type { SnapshotComparedFile, SnapshotStanding } from "../../core/ipc/sync";
import { type Signal, signal } from "../../core/reactive/index";
import { countOf } from "./model";

/** A filter box shows once a snapshot has more files than this. */
export const FILTER_FROM = 15;
/** At most this many rows are drawn; the filter searches all of them. */
export const MAX_ROWS = 500;
/** The content source of a snapshot's files, for a diff's left side: `syncSnapshot:<collection>/<id>`. */
export const SNAPSHOT_SCHEME = "syncSnapshot:";

export type SnapshotFileRow = SnapshotComparedFile;

export interface SnapshotCounts {
  total: number;
  /** Other content in the folder, or deleted in the snapshot and still in the folder. */
  differ: number;
  /** In the snapshot, not in the folder. */
  missing: number;
  same: number;
  /** Not compared. */
  unknown: number;
}

export function countFiles(files: readonly SnapshotFileRow[]): SnapshotCounts {
  const counts: SnapshotCounts = {
    total: files.length,
    differ: 0,
    missing: 0,
    same: 0,
    unknown: 0,
  };
  for (const file of files) {
    if (file.state === "differs") counts.differ++;
    else counts[file.state]++;
  }
  return counts;
}

const ORDER: Record<SnapshotStanding, number> = { differs: 0, missing: 1, unknown: 2, same: 3 };

/** What differs from the folder first, what is the same last; by path within each. */
export function sortFiles(files: readonly SnapshotFileRow[]): SnapshotFileRow[] {
  return [...files].sort(
    (a, b) => ORDER[a.state] - ORDER[b.state] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}

/** The files whose path holds every word of `query`, whatever the case. */
export function filterFiles(
  files: readonly SnapshotFileRow[],
  query: string,
): readonly SnapshotFileRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return files;
  return files.filter((file) => {
    const path = file.path.toLowerCase();
    return words.every((word) => path.includes(word));
  });
}

/** The rows to draw of `files`, and how many are left out. */
export function shownFiles(
  files: readonly SnapshotFileRow[],
  max = MAX_ROWS,
): { rows: readonly SnapshotFileRow[]; more: number } {
  return files.length <= max
    ? { rows: files, more: 0 }
    : { rows: files.slice(0, max), more: files.length - max };
}

/** How a file's standing reads in its row. */
export function stateLabel(file: Pick<SnapshotFileRow, "state" | "deleted">): string {
  if (file.deleted) {
    if (file.state === "same") return "Deleted here too";
    return file.state === "unknown" ? "Not compared" : "Deleted in the snapshot";
  }
  switch (file.state) {
    case "same":
      return "Same";
    case "differs":
      return "Differs";
    case "missing":
      return "Not in this folder";
    default:
      return "Not compared";
  }
}

/**
 * Whether one file can be brought back by itself: the snapshot holds it and the folder's isn't
 * the same. A deletion is only repeated by restoring the whole snapshot.
 */
export function canRestore(file: Pick<SnapshotFileRow, "state" | "deleted">): boolean {
  return !file.deleted && file.state !== "same";
}

/**
 * "12 files: 5 differ from this folder, 1 isn't here, 6 are the same"; just "12 files" for a
 * snapshot that wasn't compared with a folder.
 */
export function summaryLine(counts: SnapshotCounts, compared = true): string {
  if (counts.total === 0) return "This snapshot has no changed files.";
  const total = countOf(counts.total, "file");
  if (!compared) return total;
  if (counts.same === counts.total)
    return counts.total === 1
      ? "1 file, the same as in this folder"
      : `${total}, all the same as in this folder`;
  const parts = [
    counts.differ > 0
      ? `${counts.differ} ${counts.differ === 1 ? "differs" : "differ"} from this folder`
      : null,
    counts.missing > 0
      ? `${counts.missing} ${counts.missing === 1 ? "isn't" : "aren't"} here`
      : null,
    counts.same > 0 ? `${counts.same} ${counts.same === 1 ? "is" : "are"} the same` : null,
    counts.unknown > 0
      ? `${counts.unknown} ${counts.unknown === 1 ? "wasn't" : "weren't"} compared`
      : null,
  ].filter(Boolean);
  return `${total}: ${parts.join(", ")}`;
}

/** What is said when a snapshot names more files than are compared; null when all were. */
export function truncatedNote(counts: SnapshotCounts, truncated: number): string | null {
  if (truncated <= 0) return null;
  const compared = Math.max(0, counts.total - truncated);
  return `Only the first ${compared.toLocaleString("en-US")} files were compared with this folder; the other ${truncated.toLocaleString("en-US")} are listed without a comparison.`;
}

/** How a file reads in a list that wasn't compared with a folder: only a deletion is said. */
export function plainLabel(file: Pick<SnapshotFileRow, "deleted">): string {
  return file.deleted ? "Deleted in the snapshot" : "";
}

/**
 * A snapshot's files as rows, when some (or all) weren't compared with a folder: those read
 * as not compared.
 */
export function asRows(
  files: readonly {
    path: string;
    size: number;
    deleted: boolean;
    state: SnapshotStanding | null;
  }[],
): SnapshotFileRow[] {
  return files.map((file) => ({
    path: file.path,
    size: file.size,
    deleted: file.deleted,
    state: file.state ?? "unknown",
  }));
}

/**
 * What a snapshot left out, in a sentence: "2 files were left out of this snapshot: .env (a
 * key file), big.bin (too large)". Null when it left nothing out.
 */
export function skippedNote(
  skipped: readonly (readonly [string, string])[],
  max = 4,
): string | null {
  if (skipped.length === 0) return null;
  const named = skipped.slice(0, max).map(([path, why]) => (why ? `${path} (${why})` : path));
  const more = skipped.length > max ? `, and ${skipped.length - max} more` : "";
  return `${countOf(skipped.length, "file")} ${skipped.length === 1 ? "was" : "were"} left out of this snapshot: ${named.join(", ")}${more}.`;
}

/** What the list says when the filter leaves fewer files: "3 of 40 files". */
export function matchLine(matched: number, total: number): string {
  return matched === 0 ? "No file matches." : `${matched} of ${countOf(total, "file")}`;
}

/** What the list says under its last row when it draws fewer rows than there are. */
export function moreLine(more: number): string {
  return `and ${more.toLocaleString("en-US")} more (the filter searches all of them)`;
}

/** A path as a row shows it: the file's name, and the folder it is in ("" at the top). */
export function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf("/");
  return at < 0 ? { name: path, dir: "" } : { name: path.slice(at + 1), dir: path.slice(0, at) };
}

/** The left side's label in a diff, and the tab's: "Snapshot Nov 17, 2:05 PM". */
export function snapshotLabel(time: number): string {
  const when = new Date(time).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Snapshot ${when}`;
}

/**
 * Why a file of a snapshot isn't shown as text. `restorable`: it is a snapshot of the open
 * project (a teammate's shared one is read, never restored into the folder).
 */
export function textRefusal(path: string, reason: "large" | "binary", restorable = true): string {
  const why =
    reason === "large"
      ? `${path} is larger than 2 MB, so it isn't shown.`
      : `${path} isn't text, so it isn't shown.`;
  return restorable ? `${why} It can still be restored.` : why;
}

export function snapshotScheme(collection: string, id: string): string {
  return `${SNAPSHOT_SCHEME}${collection}/${id}`;
}

/** The snapshot a content scheme names; null when it isn't one. */
export function parseSnapshotScheme(scheme: string): { collection: string; id: string } | null {
  if (!scheme.startsWith(SNAPSHOT_SCHEME)) return null;
  const spec = scheme.slice(SNAPSHOT_SCHEME.length);
  // A snapshot's id has no "/"; a collection's name might.
  const at = spec.lastIndexOf("/");
  if (at <= 0 || at === spec.length - 1) return null;
  return { collection: spec.slice(0, at), id: spec.slice(at + 1) };
}

/** The snapshot the Sync tab shows the files of. */
export interface OpenedSnapshot {
  id: string;
  /** "loading" until its files were read once; "error" when that failed. */
  phase: "loading" | "ready" | "error";
  error: string | null;
  /** Null until the files were read. */
  counts: SnapshotCounts | null;
  /** How many files were left uncompared (the snapshot names more than are compared). */
  truncated: number;
  /** Being compared again while the list read before stays in view. */
  refreshing: boolean;
  /** Whether its files stand against the open folder (false: listed without a comparison). */
  compared: boolean;
}

/** A snapshot's files as they arrive: `SnapshotCompared` fits. */
export interface LookedFiles {
  files: readonly SnapshotFileRow[];
  truncated: number;
  /** What the snapshot left out: [path, why]. */
  skipped?: readonly (readonly [string, string])[];
}

/**
 * The snapshot being looked at. `opened` is small (the tab redraws on it and ide://sync reports
 * it); the files themselves, which can be very many, stay beside it.
 */
export class SnapshotLook {
  readonly opened: Signal<OpenedSnapshot | null> = signal<OpenedSnapshot | null>(null);
  /** The opened snapshot's files, differing first (empty until read). */
  files: readonly SnapshotFileRow[] = [];
  /** What the opened snapshot left out: [path, why] (a shared one says; empty otherwise). */
  skipped: readonly (readonly [string, string])[] = [];
  /** What is typed in the filter box. */
  filter = "";
  private turn = 0;

  /**
   * Starts reading snapshot `id`; the number to hand back with the result. The same snapshot,
   * already read, keeps its list in view while it is compared again.
   */
  begin(id: string, compared = true): number {
    const now = this.opened.peek();
    if (now?.id === id && now.phase === "ready" && now.compared === compared) {
      this.opened.value = { ...now, refreshing: true };
    } else {
      this.files = [];
      this.skipped = [];
      this.filter = "";
      this.opened.value = {
        id,
        phase: "loading",
        error: null,
        counts: null,
        truncated: 0,
        refreshing: false,
        compared,
      };
    }
    return ++this.turn;
  }

  /** The files arrived. False when another snapshot was opened (or this one closed) meanwhile. */
  finish(turn: number, read: LookedFiles): boolean {
    const now = this.opened.peek();
    if (turn !== this.turn || !now) return false;
    this.files = sortFiles(read.files);
    this.skipped = read.skipped ?? [];
    this.opened.value = {
      id: now.id,
      phase: "ready",
      error: null,
      counts: countFiles(this.files),
      truncated: read.truncated,
      refreshing: false,
      compared: now.compared,
    };
    return true;
  }

  /** Reading failed. A list read before stays (comparing again failed, not the list). */
  fail(turn: number, message: string): void {
    const now = this.opened.peek();
    if (turn !== this.turn || !now) return;
    this.opened.value =
      now.phase === "ready"
        ? { ...now, refreshing: false }
        : { ...now, phase: "error", error: message, refreshing: false };
  }

  close(): void {
    this.turn++;
    this.files = [];
    this.skipped = [];
    this.filter = "";
    if (this.opened.peek() !== null) this.opened.value = null;
  }
}
