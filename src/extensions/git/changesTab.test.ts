import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitStatus } from "../../core/ipc/git";
import { changesFiles, rangeFiles } from "./changesTab";
import { groupChanges } from "./model";

const status: GitStatus = {
  branch: { head: "main", oid: "abc", upstream: null, ahead: 0, behind: 0 },
  files: [
    { path: "src/a.ts", origPath: null, index: "M", worktree: "M", conflict: false },
    { path: "new.ts", origPath: null, index: "?", worktree: "?", conflict: false },
    { path: "gone.ts", origPath: null, index: ".", worktree: "D", conflict: false },
    { path: "b.ts", origPath: "old.ts", index: "R", worktree: ".", conflict: false },
    { path: "c.ts", origPath: null, index: "U", worktree: "U", conflict: true },
  ],
};

test("View all changes lists the working tree; View staged changes the index; no conflicts", () => {
  const g = groupChanges("/r", status);
  assert.deepEqual(changesFiles(g, false), [
    { path: "/r/gone.ts", status: "D" },
    { path: "/r/new.ts", status: "U" },
    { path: "/r/src/a.ts", status: "M" },
  ]);
  assert.deepEqual(changesFiles(g, true), [
    { path: "/r/b.ts", status: "R", from: "old.ts", staged: true },
    { path: "/r/src/a.ts", status: "M", staged: true },
  ]);
});

test("a commit's or a range's files are git:<base>[@old path] ↔ git:<tip>", () => {
  const files = [
    { status: "M", path: "a.ts", origPath: null },
    { status: "R", path: "b.ts", origPath: "old.ts" },
    { status: "", path: "c.ts", origPath: null },
  ];
  assert.deepEqual(rangeFiles("/r", files, "p1", "t2"), [
    { path: "/r/a.ts", status: "M", base: "git:p1", head: "git:t2" },
    { path: "/r/b.ts", status: "R", from: "old.ts", base: "git:p1@old.ts", head: "git:t2" },
    { path: "/r/c.ts", status: "M", base: "git:p1", head: "git:t2" },
  ]);
  // A root commit: nothing on the left.
  assert.deepEqual(
    rangeFiles("C:\\r", [{ status: "A", path: "x/y.ts", origPath: null }], null, "t"),
    [{ path: "C:\\r\\x\\y.ts", status: "A", head: "git:t" }],
  );
});
