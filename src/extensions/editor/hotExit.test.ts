import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backupsOf,
  emptyWindowBackups,
  emptyWindowJson,
  madeOnOtherText,
  textStamp,
  withoutBackup,
  withPending,
} from "./hotExit";

test("a backup knows which disk text its edits were made on", () => {
  const onDisk = "const a = 1;\n";
  const [backup] = backupsOf([
    { path: "/a.ts", dirty: true, text: "const a = 2;\n", base: textStamp(onDisk) },
  ]);
  assert.ok(backup);
  assert.equal(backup.base, textStamp(onDisk));
  // Reopened with the file as it was: the edits go back as before.
  assert.equal(madeOnOtherText(backup, onDisk), false);
  // The file changed while the IDE was closed (a pull): a conflict.
  assert.equal(madeOnOtherText(backup, "const a = 1;\nconst b = 3;\n"), true);
  assert.equal(madeOnOtherText(backup, "const a = 9;\n"), true);
  // The stamp survives the saved state's JSON.
  const [back] = emptyWindowBackups(emptyWindowJson([backup]));
  assert.deepEqual(back, backup);
  // What can't be told is no conflict: a backup from before the stamp, an untitled document,
  // a stamp that isn't a string.
  assert.equal(madeOnOtherText({ path: "/a.ts", text: "x" }, "anything"), false);
  assert.equal(madeOnOtherText(backup, undefined), false);
  assert.equal(
    madeOnOtherText({ path: "/a.ts", text: "x", base: 5 as unknown as string }, "anything"),
    false,
  );
  assert.deepEqual(backupsOf([{ path: "untitled:Untitled-1", dirty: true, text: "n" }]), [
    { path: "untitled:Untitled-1", text: "n" },
  ]);
});

test("textStamp tells texts apart, same length or not", () => {
  assert.equal(textStamp("abc"), textStamp("abc"));
  assert.notEqual(textStamp("abc"), textStamp("abd"));
  assert.notEqual(textStamp("ab"), textStamp("ba"));
  assert.notEqual(textStamp("a\n"), textStamp("a\r\n"));
  assert.notEqual(textStamp(""), textStamp(" "));
});

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
