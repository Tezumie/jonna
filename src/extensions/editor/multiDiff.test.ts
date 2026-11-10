import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adjacentFile,
  entryKey,
  entryKind,
  filesLabel,
  isEditable,
  placeholderHeight,
  readMultiDiffState,
  sameDiffFiles,
  scrollAnchor,
} from "./multiDiff";

test("a multi-file diff's state is checked: bad entries skipped, unknown fields dropped", () => {
  const st = readMultiDiffState({
    title: "Changes",
    source: "git:changes:/r",
    refresh: { command: "git.viewChanges", input: { repository: "/r" } },
    files: [
      { path: "/r/a.ts", status: "M", extra: 1 },
      { path: "" },
      "nope",
      { path: "/r/b.ts", staged: true },
      { path: "/r/c.ts", base: "git:abc@old.ts", head: "git:def", from: "old.ts", status: "R" },
    ],
    collapsed: ["working:/r/a.ts", 3],
  });
  assert.deepEqual(st, {
    title: "Changes",
    source: "git:changes:/r",
    refresh: { command: "git.viewChanges", input: { repository: "/r" } },
    files: [
      { path: "/r/a.ts", status: "M" },
      { path: "/r/b.ts", staged: true },
      { path: "/r/c.ts", status: "R", from: "old.ts", base: "git:abc@old.ts", head: "git:def" },
    ],
    collapsed: ["working:/r/a.ts"],
  });
  assert.deepEqual(readMultiDiffState(null), { title: "Changes", files: [] });
});

test("each file's sides: working tree (editable unless deleted), staged, or a range", () => {
  assert.equal(entryKind({ path: "/a" }), "working");
  assert.equal(entryKind({ path: "/a", staged: true }), "staged");
  assert.equal(entryKind({ path: "/a", head: "git:x", staged: true }), "range");
  assert.equal(isEditable({ path: "/a", status: "M" }), true);
  assert.equal(isEditable({ path: "/a", status: "D" }), false);
  assert.equal(isEditable({ path: "/a", staged: true }), false);
  assert.equal(isEditable({ path: "/a", head: "git:x" }), false);
  // The same file staged and changed is listed twice.
  assert.notEqual(entryKey({ path: "/a" }), entryKey({ path: "/a", staged: true }));
});

test("a file keeps its measured height; before that, a guess capped at a screenful", () => {
  assert.equal(placeholderHeight(250, 1000, 19), 250);
  assert.equal(placeholderHeight(undefined, 10, 19), 190);
  assert.equal(placeholderHeight(undefined, 1000, 19), 480);
  assert.equal(placeholderHeight(undefined, 1, 19), 57);
  assert.equal(placeholderHeight(undefined, undefined, 19), 114);
  assert.equal(filesLabel(1), "1 file");
  assert.equal(filesLabel(3), "3 files");
});

test("a followed tab is listed again only when its files differ", () => {
  const files = [
    { path: "/r/a.ts", status: "M" },
    { path: "/r/b.ts", status: "R", from: "old.ts", staged: true },
  ];
  assert.equal(
    sameDiffFiles(
      [
        { path: "/r/a.ts", status: "M" },
        { staged: true, from: "old.ts", status: "R", path: "/r/b.ts" },
      ],
      files,
    ),
    true,
  );
  // A status changed, a file came or went, the order changed, a side changed.
  assert.equal(sameDiffFiles([{ path: "/r/a.ts", status: "A" }, files[1]], files), false);
  assert.equal(sameDiffFiles([files[0]], files), false);
  assert.equal(sameDiffFiles([files[1], files[0]], files), false);
  assert.equal(
    sameDiffFiles([{ path: "/r/a.ts", head: "git:HEAD" }], [{ path: "/r/a.ts", head: "git:x" }]),
    false,
  );
  assert.equal(sameDiffFiles(undefined, []), false);
  assert.equal(sameDiffFiles([], []), true);
});

test("a new list keeps the file at the top of the view and how far into it", () => {
  const keys = ["a", "b", "c"];
  const tops = [0, 300, 700];
  assert.deepEqual(scrollAnchor(keys, tops, 0), { key: "a", offset: 0 });
  assert.deepEqual(scrollAnchor(keys, tops, 450), { key: "b", offset: 150 });
  assert.deepEqual(scrollAnchor(keys, tops, 900), { key: "c", offset: 200 });
  assert.equal(scrollAnchor([], [], 10), null);
});

test("next / previous file: from the focused one, else from the top of the view", () => {
  const tops = [0, 300, 700];
  // Focused: the one after or before it, none past the ends.
  assert.equal(adjacentFile(tops, 0, 0, 1), 1);
  assert.equal(adjacentFile(tops, 0, 2, 1), null);
  assert.equal(adjacentFile(tops, 0, 1, -1), 0);
  assert.equal(adjacentFile(tops, 0, 0, -1), null);
  // Nothing focused: the first file below the top, the last one above it.
  assert.equal(adjacentFile(tops, 0, -1, 1), 1);
  assert.equal(adjacentFile(tops, 450, -1, 1), 2);
  assert.equal(adjacentFile(tops, 450, -1, -1), 1);
  assert.equal(adjacentFile(tops, 300, -1, -1), 0);
  assert.equal(adjacentFile(tops, 800, -1, 1), null);
  assert.equal(adjacentFile([], 0, -1, 1), null);
});
