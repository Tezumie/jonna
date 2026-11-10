import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyWindowBackups, emptyWindowJson, withoutBackup, withPending } from "./hotExit";

// D203: closing the window asks about the dirty documents hot exit can't keep.
test("withoutBackup lists dirty documents past the limits or without text", () => {
  const big = "x".repeat(3 * 1024 * 1024);
  const docs = [
    { path: "/a", dirty: true, text: "edited" },
    { path: "/b", dirty: false, text: "clean" },
    { path: "/c", dirty: true, text: null },
    { path: "/d", dirty: true, text: big },
    { path: "untitled:Untitled-1", dirty: true, text: "notes" },
  ];
  assert.deepEqual(
    withoutBackup(docs).map((d) => d.path),
    ["/c", "/d"],
  );
  assert.deepEqual(withoutBackup([{ path: "/a", dirty: true, text: "x" }]), []);
  // Past the 10 MB total: the biggest that don't fit are left out.
  const two = "y".repeat(2 * 1024 * 1024 - 1);
  const many = Array.from({ length: 6 }, (_, i) => ({ path: `/f${i}`, dirty: true, text: two }));
  assert.deepEqual(
    withoutBackup(many).map((d) => d.path),
    ["/f5"],
  );
});

test("withPending keeps restored backups not applied yet; the current text wins", () => {
  const pending = [
    { path: "/a", text: "backup a" },
    { path: "/b", text: "backup b" },
  ];
  assert.deepEqual(withPending([], pending), pending);
  assert.deepEqual(withPending([{ path: "/a", text: "now" }], pending), [
    { path: "/a", text: "now" },
    { path: "/b", text: "backup b" },
  ]);
  assert.deepEqual(withPending([{ path: "/c", text: "c" }], []), [{ path: "/c", text: "c" }]);
});

test("an empty window's unsaved text round-trips; nothing kept is no file", () => {
  const backups = [
    { path: "untitled:Untitled-1", text: "notes" },
    { path: "/elsewhere/a.md", text: "# a" },
  ];
  assert.equal(emptyWindowJson([]), null);
  assert.deepEqual(emptyWindowBackups(emptyWindowJson(backups)), backups);
  assert.deepEqual(emptyWindowBackups(null), []);
  assert.deepEqual(emptyWindowBackups("not json"), []);
  assert.deepEqual(
    emptyWindowBackups(JSON.stringify({ backups: [{ path: 1, text: "x" }, backups[0]] })),
    [backups[0]],
  );
});
