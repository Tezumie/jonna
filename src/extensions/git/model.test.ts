import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitStatus } from "../../core/ipc/git";
import { pathKey } from "../../core/paths/index";
import {
  buildDecorations,
  changeColor,
  changeName,
  commitSummary,
  conflictKind,
  groupChanges,
  isDeletionConflict,
  mergeEditorHandles,
} from "./model";

const status: GitStatus = {
  branch: { head: "main", oid: "abc", upstream: "origin/main", ahead: 1, behind: 0 },
  files: [
    { path: "src/a.ts", origPath: null, index: "M", worktree: "M", conflict: false },
    { path: "src/new.ts", origPath: null, index: "?", worktree: "?", conflict: false },
    { path: "old.txt", origPath: null, index: ".", worktree: "D", conflict: false },
    { path: "b.ts", origPath: "a.ts", index: "R", worktree: ".", conflict: false },
    { path: "c.ts", origPath: null, index: "U", worktree: "U", conflict: true },
  ],
};

test("groupChanges splits staged, working-tree and conflicted files", () => {
  const g = groupChanges("/repo", status);
  assert.deepEqual(
    g.staged.map((c) => [c.rel, c.letter]),
    [
      ["b.ts", "R"],
      ["src/a.ts", "M"],
    ],
  );
  assert.deepEqual(
    g.changes.map((c) => [c.rel, c.letter]),
    [
      ["old.txt", "D"],
      ["src/a.ts", "M"],
      ["src/new.ts", "U"],
    ],
  );
  assert.deepEqual(
    g.merge.map((c) => [c.rel, c.letter]),
    [["c.ts", "!"]],
  );
  assert.equal(g.staged[0]?.path, "/repo/b.ts");
  assert.equal(g.staged[0]?.origRel, "a.ts");
  assert.equal(commitSummary(g), "Commit 2 staged files");
});

test("decorations color files and their folders by the most important change", () => {
  const repo = { root: "/repo", gitDir: "/repo/.git" };
  const { files, dirs } = buildDecorations(repo, groupChanges("/repo", status));
  assert.deepEqual(files.get(pathKey("/repo/old.txt")), {
    color: "--diff-removed-fg",
    badge: "D",
    tooltip: "Deleted",
    strike: true,
  });
  assert.equal(files.get(pathKey("/repo/src/new.ts"))?.badge, "U");
  assert.equal(files.get(pathKey("/repo/c.ts"))?.color, "--status-warning-fg");
  // src/ has a modified and an untracked file: modified wins.
  assert.equal(dirs.get(pathKey("/repo/src"))?.color, "--git-modified-fg");
  assert.equal(dirs.get(pathKey("/repo"))?.color, "--status-warning-fg");
  assert.equal(dirs.has(pathKey("/")), false);
});

test("Windows paths resolve with backslashes", () => {
  const g = groupChanges("C:\\work\\repo", status);
  assert.equal(g.staged[1]?.path, "C:\\work\\repo\\src\\a.ts");
});

test("conflicts carry git's unmerged kind with VS Code's letters", () => {
  const conflicted = (path: string, xy: string) => ({
    path,
    origPath: null,
    index: xy[0] ?? "U",
    worktree: xy[1] ?? "U",
    conflict: true,
  });
  // git's rename / rename and rename / delete conflicts (checked against git 2.4x's ort).
  const g = groupChanges("/repo", {
    branch: { head: "main", oid: "abc", upstream: null, ahead: 0, behind: 0 },
    files: [
      conflicted("a.txt", "DD"),
      conflicted("b.txt", "AU"),
      conflicted("c.txt", "UA"),
      conflicted("e.txt", "DU"),
      conflicted("f.txt", "UD"),
      conflicted("g.txt", "AA"),
      conflicted("h.txt", "UU"),
    ],
  });
  assert.deepEqual(
    g.merge.map((c) => [c.rel, c.letter, c.conflict]),
    [
      ["a.txt", "D", "bothDeleted"],
      ["b.txt", "A", "addedByUs"],
      ["c.txt", "A", "addedByThem"],
      ["e.txt", "D", "deletedByUs"],
      ["f.txt", "D", "deletedByThem"],
      ["g.txt", "A", "bothAdded"],
      ["h.txt", "!", "bothModified"],
    ],
  );
  for (const c of g.merge) assert.equal(changeColor(c), "--status-warning-fg");
  const first = g.merge[0];
  assert.ok(first);
  assert.equal(changeName(first), "Conflict: both deleted");
  assert.equal(conflictKind("X", "Y"), "bothModified");
  assert.deepEqual(
    g.merge.filter((c) => c.conflict && mergeEditorHandles(c.conflict)).map((c) => c.rel),
    ["e.txt", "f.txt", "g.txt", "h.txt"],
  );
  assert.deepEqual(
    g.merge.filter((c) => isDeletionConflict(c.conflict)).map((c) => c.rel),
    ["e.txt", "f.txt"],
  );
  // A both-deleted file is struck through but keeps the conflict color, as do its folders.
  const { files, dirs } = buildDecorations({ root: "/repo", gitDir: "/repo/.git" }, g);
  assert.deepEqual(files.get(pathKey("/repo/a.txt")), {
    color: "--status-warning-fg",
    badge: "D",
    tooltip: "Conflict: both deleted",
    strike: true,
  });
  assert.equal(dirs.get(pathKey("/repo"))?.color, "--status-warning-fg");
});
