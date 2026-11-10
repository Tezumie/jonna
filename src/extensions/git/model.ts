// Git state for the views: status grouped the way the source control view shows it, plus file
// decorations (DESIGN.md §3.5). DOM-free; the extension (index.ts) feeds it from Rust.
import type { FileStatus, GitStatus, RepoInfo } from "../../core/ipc/git";
import { dirname, isWithin, pathKey, resolveInRoot } from "../../core/paths/index";
import type { FileDecoration } from "../../workbench/services";

export type ChangeGroup = "merge" | "staged" | "changes";

/** One row in the source control view. A file staged and changed again appears in both groups. */
export interface Change {
  group: ChangeGroup;
  /** Absolute path. */
  path: string;
  /** Repo-relative, "/" separators. */
  rel: string;
  /** Renames: the old repo-relative path. */
  origRel: string | null;
  /**
   * Badge letter: M, A, D, R, C, T, U (untracked); conflicts as VS Code shows them: ! (both
   * modified), A (both added, added by one side), D (both deleted, deleted by one side).
   */
  letter: string;
  untracked: boolean;
  /** Merge conflicts: what each side did (git's unmerged XY codes). */
  conflict: ConflictKind | null;
}

/** git's unmerged states (`git status` XY: UU, AA, DD, AU, UA, DU, UD), VS Code's names. */
export type ConflictKind =
  | "bothModified"
  | "bothAdded"
  | "bothDeleted"
  | "addedByUs"
  | "addedByThem"
  | "deletedByUs"
  | "deletedByThem";

const CONFLICTS: Record<string, ConflictKind> = {
  UU: "bothModified",
  AA: "bothAdded",
  DD: "bothDeleted",
  AU: "addedByUs",
  UA: "addedByThem",
  DU: "deletedByUs",
  UD: "deletedByThem",
};

const CONFLICT_LETTERS: Record<ConflictKind, string> = {
  bothModified: "!",
  bothAdded: "A",
  bothDeleted: "D",
  addedByUs: "A",
  addedByThem: "A",
  deletedByUs: "D",
  deletedByThem: "D",
};

const CONFLICT_NAMES: Record<ConflictKind, string> = {
  bothModified: "Conflict: both modified",
  bothAdded: "Conflict: both added",
  bothDeleted: "Conflict: both deleted",
  addedByUs: "Conflict: added by us",
  addedByThem: "Conflict: added by them",
  deletedByUs: "Conflict: deleted by us",
  deletedByThem: "Conflict: deleted by them",
};

/** A conflict's kind from git's index / worktree letters (unknown pairs read as both modified). */
export function conflictKind(index: string, worktree: string): ConflictKind {
  return CONFLICTS[`${index}${worktree}`] ?? "bothModified";
}

/** "Conflict: deleted by them" (the row's and the file decoration's tooltip). */
export function conflictName(kind: ConflictKind): string {
  return CONFLICT_NAMES[kind];
}

/**
 * Whether the merge editor resolves this conflict: two versions (both modified / added) or one
 * side deleted and the other changed it (D209). Both deleted, or added by one side only (git's
 * rename / rename), have nothing to merge: staging resolves them.
 */
export function mergeEditorHandles(kind: ConflictKind): boolean {
  return (
    kind === "bothModified" ||
    kind === "bothAdded" ||
    kind === "deletedByUs" ||
    kind === "deletedByThem"
  );
}

/** Delete / modify conflicts: staging them asks whether to keep the file or delete it (VS Code's). */
export function isDeletionConflict(kind: ConflictKind | null): boolean {
  return kind === "deletedByUs" || kind === "deletedByThem";
}

/** The color of a change's letter: conflicts are all the conflict color, whatever their letter. */
export function changeColor(change: Change): string | undefined {
  return change.conflict ? COLORS["!"] : COLORS[change.letter];
}

/** The row's status text: "Modified", "Conflict: deleted by us"… */
export function changeName(change: Change): string {
  return change.conflict ? conflictName(change.conflict) : letterName(change.letter);
}

const COLORS: Record<string, string> = {
  // VS Code's file colors: modified yellowish, renamed like added (green).
  M: "--git-modified-fg",
  T: "--git-modified-fg",
  R: "--diff-added-fg",
  C: "--diff-added-fg",
  A: "--diff-added-fg",
  U: "--diff-added-fg",
  D: "--diff-removed-fg",
  "!": "--status-warning-fg",
};

const NAMES: Record<string, string> = {
  M: "Modified",
  T: "Type changed",
  R: "Renamed",
  C: "Copied",
  A: "Added",
  U: "Untracked",
  D: "Deleted",
  "!": "Conflict",
};

export function letterColor(letter: string): string | undefined {
  return COLORS[letter];
}

export function letterName(letter: string): string {
  return NAMES[letter] ?? "Changed";
}

function changeFor(root: string, f: FileStatus, group: ChangeGroup, code: string): Change {
  const untracked = code === "?";
  const conflict = group === "merge" ? conflictKind(f.index, f.worktree) : null;
  return {
    group,
    path: resolveInRoot(root, f.path),
    rel: f.path,
    origRel: f.origPath,
    letter: conflict ? CONFLICT_LETTERS[conflict] : untracked ? "U" : code,
    untracked,
    conflict,
  };
}

export interface GroupedChanges {
  merge: Change[];
  staged: Change[];
  changes: Change[];
}

export function groupChanges(root: string, status: GitStatus): GroupedChanges {
  const out: GroupedChanges = { merge: [], staged: [], changes: [] };
  for (const f of status.files) {
    if (f.index === "!") continue;
    if (f.conflict) {
      out.merge.push(changeFor(root, f, "merge", "U"));
      continue;
    }
    if (f.index === "?") {
      out.changes.push(changeFor(root, f, "changes", "?"));
      continue;
    }
    if (f.index !== ".") out.staged.push(changeFor(root, f, "staged", f.index));
    if (f.worktree !== ".") out.changes.push(changeFor(root, f, "changes", f.worktree));
  }
  const byRel = (a: Change, b: Change) => a.rel.localeCompare(b.rel);
  out.merge.sort(byRel);
  out.staged.sort(byRel);
  out.changes.sort(byRel);
  return out;
}

const RANK: Record<string, number> = { "!": 4, D: 3, M: 2, T: 2, R: 2, C: 1, A: 1, U: 1 };

/**
 * Decorations by path key: each changed file (working-tree state wins over staged) and every folder
 * between it and the repository root (colored by its most important change, no badge).
 */
export function buildDecorations(
  repo: RepoInfo,
  groups: GroupedChanges,
): { files: Map<string, FileDecoration>; dirs: Map<string, FileDecoration> } {
  const files = new Map<string, FileDecoration>();
  const dirs = new Map<string, FileDecoration>();
  const dirRank = new Map<string, number>();
  // Later groups override earlier ones: staged < changes < merge.
  for (const change of [...groups.staged, ...groups.changes, ...groups.merge]) {
    const color = changeColor(change);
    const staged = change.group === "staged" ? ", staged" : "";
    files.set(pathKey(change.path), {
      color,
      badge: change.letter,
      tooltip: `${changeName(change)}${staged}`,
      strike: change.letter === "D",
    });
    const rank = (change.conflict ? RANK["!"] : RANK[change.letter]) ?? 1;
    let dir = dirname(change.path);
    while (isWithin(repo.root, dir)) {
      const key = pathKey(dir);
      const before = dirRank.get(key) ?? 0;
      if (rank > before) {
        dirRank.set(key, rank);
        // Folders holding deletions read as modified (the folder itself still exists).
        const folderColor = change.letter === "D" && !change.conflict ? COLORS.M : color;
        dirs.set(key, { color: folderColor, tooltip: "Contains changes" });
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return { files, dirs };
}

/** A conventional summary of what a commit would include, for the commit button tooltip. */
export function commitSummary(groups: GroupedChanges): string {
  const n = groups.staged.length;
  if (n > 0) return `Commit ${n} staged file${n === 1 ? "" : "s"}`;
  const tracked = groups.changes.filter((c) => !c.untracked).length;
  return tracked > 0
    ? `Nothing staged: commit all ${tracked} changed file${tracked === 1 ? "" : "s"}`
    : "Nothing to commit";
}
