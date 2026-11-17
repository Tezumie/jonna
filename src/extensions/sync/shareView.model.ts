// A teammate's shared project on the Team page: what the tab keeps of the share being looked
// at (its snapshots, and inside it the snapshot whose files are shown), how a share's row and
// a snapshot's row read, and how one of its files is titled when it opens by itself. DOM-free;
// shareView.ts draws it and shareCommands.ts fills it. The words about keys and people are
// core/team/shares.ts.
import type { SharedSnapshot, ShareLatest } from "../../core/ipc/share";
import { type Signal, signal } from "../../core/reactive/index";
import { serviceTime, snapshotFacts } from "./model";
import { SnapshotLook, snapshotLabel, splitPath } from "./snapshotView.model";

/** The share the Team page shows the snapshots of. */
export interface OpenedShare {
  id: string;
  /** "loading" until its snapshots were read once; "error" when that failed. */
  phase: "loading" | "ready" | "error";
  error: string | null;
  /** How many snapshots it has (0 until read). */
  snapshots: number;
  /** Being read again while the list read before stays in view. */
  refreshing: boolean;
}

/**
 * The share being looked at. `opened` is small (the tab redraws on it); the snapshots stay
 * beside it, and `snapshot` is the one of them whose files are shown (none: the list).
 */
export class ShareLook {
  readonly opened: Signal<OpenedShare | null> = signal<OpenedShare | null>(null);
  /** The opened share's snapshots, newest first (empty until read). */
  rows: readonly SharedSnapshot[] = [];
  /** The snapshot of it being looked at. */
  readonly snapshot = new SnapshotLook();
  private turn = 0;

  /**
   * Starts reading share `id`; the number to hand back with the result. The same share,
   * already read, keeps its list in view while it is read again.
   */
  begin(id: string): number {
    const now = this.opened.peek();
    if (now?.id === id && now.phase === "ready") {
      this.opened.value = { ...now, refreshing: true };
    } else {
      this.rows = [];
      this.snapshot.close();
      this.opened.value = { id, phase: "loading", error: null, snapshots: 0, refreshing: false };
    }
    return ++this.turn;
  }

  /** The snapshots arrived. False when another share was opened (or this one closed) meanwhile. */
  finish(turn: number, snapshots: readonly SharedSnapshot[]): boolean {
    const now = this.opened.peek();
    if (turn !== this.turn || !now) return false;
    this.rows = newestFirst(snapshots);
    this.opened.value = {
      id: now.id,
      phase: "ready",
      error: null,
      snapshots: this.rows.length,
      refreshing: false,
    };
    // A snapshot that is gone from the share (it keeps its latest ten) isn't looked at any more.
    const looked = this.snapshot.opened.peek();
    if (looked && !this.rows.some((row) => row.id === looked.id)) this.snapshot.close();
    return true;
  }

  /** Reading failed. A list read before stays (reading again failed, not the list). */
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
    this.rows = [];
    this.snapshot.close();
    if (this.opened.peek() !== null) this.opened.value = null;
  }
}

/** A share's snapshots, newest first. */
export function newestFirst(snapshots: readonly SharedSnapshot[]): SharedSnapshot[] {
  return [...snapshots].sort(
    (a, b) => b.summary.time - a.summary.time || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
}

/**
 * A share's newest snapshot as its row says it: when (null: not known), and "Ana's laptop ·
 * main · 12 files · 3 MB". Null when the share has no snapshot yet.
 */
export function latestFacts(
  latest: ShareLatest | null,
): { time: number | null; facts: string } | null {
  if (!latest) return null;
  return {
    time: serviceTime(latest.time),
    facts: [
      latest.computer.trim() || null,
      latest.branch,
      snapshotFacts(latest.files, latest.bytes),
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

/** A shared snapshot's row: "Ana's laptop · main · 12 files · 3 MB". */
export function sharedSnapshotFacts(snapshot: SharedSnapshot): string {
  const { summary } = snapshot;
  return [
    summary.deviceName.trim() || null,
    summary.branch,
    snapshotFacts(summary.files, summary.bytes),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The left side's label in a diff of a shared file: "Ana's snapshot Nov 17, 2:05 PM". */
export function sharedLabel(owner: string, time: number, mine: boolean): string {
  const when = snapshotLabel(time).replace(/^Snapshot/, "snapshot");
  const who = owner.trim();
  return mine || !who ? `Shared ${when}` : `${who}'s ${when}`;
}

/**
 * The title of a shared file opened by itself, read only: the project, when, and the file's
 * path with its name last (the tab picks the language by the title's extension). No slash: a
 * title is one name, and two files of one name in different folders keep titles of their own.
 */
export function sharedFileTitle(project: string, time: number, path: string): string {
  const { name, dir } = splitPath(path);
  const folders = dir ? `${dir.split("/").filter(Boolean).join(" › ")} › ` : "";
  const when = snapshotLabel(time).replace(/^Snapshot /, "");
  return `${project.trim() || "Shared project"} (${when}) · ${folders}${name}`;
}

/** A path as a command takes it: forward slashes, no leading "./" or "/"; "" when it climbs. */
export function sharedPath(path: string): string {
  const plain = path.replaceAll("\\", "/").replace(/^\.?\/+/, "");
  return plain.split("/").some((part) => part === "..") ? "" : plain;
}
