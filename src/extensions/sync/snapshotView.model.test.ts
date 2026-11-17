import assert from "node:assert/strict";
import { test } from "node:test";
import type { SnapshotStanding } from "../../core/ipc/sync";
import {
  canRestore,
  countFiles,
  filterFiles,
  matchLine,
  moreLine,
  parseSnapshotScheme,
  type SnapshotFileRow,
  SnapshotLook,
  shownFiles,
  snapshotScheme,
  sortFiles,
  splitPath,
  stateLabel,
  summaryLine,
  textRefusal,
  truncatedNote,
} from "./snapshotView.model";

const file = (path: string, state: SnapshotStanding, deleted = false): SnapshotFileRow => ({
  path,
  size: deleted ? 0 : 10,
  deleted,
  state,
});

const FILES: SnapshotFileRow[] = [
  file("README.md", "same"),
  file("src/a.ts", "differs"),
  file("src/new.ts", "missing"),
  file("old.txt", "differs", true),
  file("gone.txt", "same", true),
  file("big/z.bin", "unknown"),
  file("Src/B.ts", "differs"),
];

test("a snapshot's files are counted by how they stand against the folder", () => {
  assert.deepEqual(countFiles(FILES), { total: 7, differ: 3, missing: 1, same: 2, unknown: 1 });
  assert.deepEqual(countFiles([]), { total: 0, differ: 0, missing: 0, same: 0, unknown: 0 });
});

test("what differs comes first, what is the same last, by path within", () => {
  assert.deepEqual(
    sortFiles(FILES).map((f) => f.path),
    ["Src/B.ts", "old.txt", "src/a.ts", "src/new.ts", "big/z.bin", "README.md", "gone.txt"],
  );
  // The list handed in is left as it was.
  assert.equal(FILES[0]?.path, "README.md");
});

test("the filter takes every word, whatever the case", () => {
  const paths = (query: string) => filterFiles(FILES, query).map((f) => f.path);
  assert.equal(filterFiles(FILES, "  "), FILES);
  assert.deepEqual(paths("src"), ["src/a.ts", "src/new.ts", "Src/B.ts"]);
  assert.deepEqual(paths("SRC .ts b"), ["Src/B.ts"]);
  assert.deepEqual(paths("nothing like it"), []);
});

test("only so many rows are drawn, and the rest are counted", () => {
  assert.deepEqual(shownFiles(FILES), { rows: FILES, more: 0 });
  const cut = shownFiles(FILES, 3);
  assert.deepEqual(
    cut.rows.map((f) => f.path),
    ["README.md", "src/a.ts", "src/new.ts"],
  );
  assert.equal(cut.more, 4);
  assert.equal(shownFiles(FILES, 7).more, 0);
});

test("a row says how its file stands, and whether it can be restored by itself", () => {
  assert.equal(stateLabel(file("a", "same")), "Same");
  assert.equal(stateLabel(file("a", "differs")), "Differs");
  assert.equal(stateLabel(file("a", "missing")), "Not in this folder");
  assert.equal(stateLabel(file("a", "unknown")), "Not compared");
  assert.equal(stateLabel(file("a", "differs", true)), "Deleted in the snapshot");
  assert.equal(stateLabel(file("a", "same", true)), "Deleted here too");
  assert.equal(stateLabel(file("a", "unknown", true)), "Not compared");

  assert.equal(canRestore(file("a", "differs")), true);
  assert.equal(canRestore(file("a", "missing")), true);
  assert.equal(canRestore(file("a", "unknown")), true);
  assert.equal(canRestore(file("a", "same")), false);
  // A deletion is repeated only by restoring the whole snapshot.
  assert.equal(canRestore(file("a", "differs", true)), false);
});

test("the summary says how many files and how they stand", () => {
  assert.equal(
    summaryLine({ total: 12, differ: 5, missing: 1, same: 6, unknown: 0 }),
    "12 files: 5 differ from this folder, 1 isn't here, 6 are the same",
  );
  assert.equal(
    summaryLine({ total: 4, differ: 1, missing: 2, same: 1, unknown: 0 }),
    "4 files: 1 differs from this folder, 2 aren't here, 1 is the same",
  );
  assert.equal(
    summaryLine({ total: 3, differ: 0, missing: 0, same: 1, unknown: 2 }),
    "3 files: 1 is the same, 2 weren't compared",
  );
  assert.equal(
    summaryLine({ total: 1, differ: 0, missing: 0, same: 0, unknown: 1 }),
    "1 file: 1 wasn't compared",
  );
  assert.equal(
    summaryLine({ total: 3, differ: 0, missing: 0, same: 3, unknown: 0 }),
    "3 files, all the same as in this folder",
  );
  assert.equal(
    summaryLine({ total: 1, differ: 0, missing: 0, same: 1, unknown: 0 }),
    "1 file, the same as in this folder",
  );
  assert.equal(
    summaryLine({ total: 0, differ: 0, missing: 0, same: 0, unknown: 0 }),
    "This snapshot has no changed files.",
  );
});

test("a snapshot with more files than are compared says so", () => {
  const counts = { total: 7200, differ: 10, missing: 0, same: 4990, unknown: 2200 };
  assert.equal(truncatedNote(counts, 0), null);
  assert.equal(
    truncatedNote(counts, 2200),
    "Only the first 5,000 files were compared with this folder; the other 2,200 are listed without a comparison.",
  );
  assert.equal(matchLine(3, 40), "3 of 40 files");
  assert.equal(matchLine(0, 40), "No file matches.");
  assert.equal(moreLine(1700), "and 1,700 more (the filter searches all of them)");
});

test("a path shows as a name and the folder it is in", () => {
  assert.deepEqual(splitPath("src/core/a.ts"), { name: "a.ts", dir: "src/core" });
  assert.deepEqual(splitPath("README.md"), { name: "README.md", dir: "" });
});

test("a file that can't be shown says why", () => {
  assert.match(textRefusal("a.bin", "binary"), /^a\.bin isn't text/);
  assert.match(textRefusal("a.log", "large"), /^a\.log is larger than 2 MB/);
});

test("a content scheme names a snapshot", () => {
  const scheme = snapshotScheme("snap.abc", "1700000000000-dev123");
  assert.equal(scheme, "syncSnapshot:snap.abc/1700000000000-dev123");
  assert.deepEqual(parseSnapshotScheme(scheme), {
    collection: "snap.abc",
    id: "1700000000000-dev123",
  });
  assert.deepEqual(parseSnapshotScheme("syncSnapshot:team/x/snap.abc/17-d"), {
    collection: "team/x/snap.abc",
    id: "17-d",
  });
  for (const bad of [
    "git:abc",
    "syncSnapshot:",
    "syncSnapshot:snap.abc",
    "syncSnapshot:/id",
    "syncSnapshot:snap.abc/",
  ])
    assert.equal(parseSnapshotScheme(bad), null, bad);
});

test("the snapshot being looked at: loading, read, compared again, closed", () => {
  const look = new SnapshotLook();
  assert.equal(look.opened.peek(), null);

  const first = look.begin("one");
  assert.deepEqual(look.opened.peek(), {
    id: "one",
    phase: "loading",
    error: null,
    counts: null,
    truncated: 0,
    refreshing: false,
  });
  look.filter = "src";
  assert.equal(look.finish(first, { files: FILES, truncated: 2 }), true);
  assert.equal(look.opened.peek()?.phase, "ready");
  assert.equal(look.opened.peek()?.truncated, 2);
  assert.deepEqual(look.opened.peek()?.counts, countFiles(FILES));
  assert.equal(look.files[0]?.path, "Src/B.ts");

  // Compared again: the list and the filter stay while it runs, and after it failed.
  const again = look.begin("one");
  assert.equal(look.opened.peek()?.refreshing, true);
  assert.equal(look.files.length, 7);
  assert.equal(look.filter, "src");
  look.fail(again, "offline");
  assert.equal(look.opened.peek()?.phase, "ready");
  assert.equal(look.opened.peek()?.refreshing, false);
  assert.equal(look.files.length, 7);

  // Another snapshot: starts empty, and the first one's late answer is dropped.
  const stale = look.begin("one");
  const other = look.begin("two");
  assert.equal(look.files.length, 0);
  assert.equal(look.filter, "");
  assert.equal(look.finish(stale, { files: FILES, truncated: 0 }), false);
  assert.equal(look.opened.peek()?.id, "two");
  assert.equal(look.opened.peek()?.phase, "loading");
  look.fail(other, "That snapshot is gone.");
  assert.deepEqual(
    [look.opened.peek()?.phase, look.opened.peek()?.error],
    ["error", "That snapshot is gone."],
  );

  // Closed: a late answer changes nothing.
  const late = look.begin("two");
  look.close();
  assert.equal(look.finish(late, { files: FILES, truncated: 0 }), false);
  assert.equal(look.opened.peek(), null);
  assert.equal(look.files.length, 0);
});
