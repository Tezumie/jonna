import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonical,
  conflictPath,
  type FileBase,
  fileRecordId,
  type LocalFile,
  mergeSettings,
  planFiles,
  type RemoteFile,
} from "./merge";

const none = () => false;

test("canonical: key order doesn't matter, array order does", () => {
  assert.equal(
    canonical({ b: 1, a: [2, { d: 1, c: 2 }] }),
    canonical({ a: [2, { c: 2, d: 1 }], b: 1 }),
  );
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
  assert.equal(canonical(undefined), "null");
});

test("mergeSettings: the first computer sends everything it has", () => {
  const r = mergeSettings({
    local: { a: 1, b: "x" },
    base: {},
    remote: null,
    localTime: 10,
    skip: none,
  });
  assert.equal(r.recordChanged, true);
  assert.deepEqual(r.record.keys, { a: { v: 1, t: 10 }, b: { v: "x", t: 10 } });
  assert.deepEqual(r.apply, []);
  assert.deepEqual(r.base, { a: "1", b: '"x"' });
});

test("mergeSettings: a new computer takes the account's settings and keeps its own", () => {
  const remote = { keys: { a: { v: 1, t: 10 }, gone: { d: true as const, t: 5 } } };
  const r = mergeSettings({ local: { mine: true }, base: {}, remote, localTime: 20, skip: none });
  assert.deepEqual(r.apply, [{ key: "a", value: 1 }]);
  assert.deepEqual(r.record.keys.mine, { v: true, t: 20 });
  assert.equal(r.recordChanged, true);
  assert.deepEqual(r.base, { mine: "true", a: "1" });
});

test("mergeSettings: different settings changed on two computers both survive", () => {
  const base = { a: "1", b: "1" };
  const remote = { keys: { a: { v: 1, t: 1 }, b: { v: 2, t: 30 } } };
  const r = mergeSettings({ local: { a: 5, b: 1 }, base, remote, localTime: 40, skip: none });
  assert.deepEqual(r.apply, [{ key: "b", value: 2 }]);
  assert.deepEqual(r.record.keys.a, { v: 5, t: 40 });
  assert.deepEqual(r.base, { a: "5", b: "2" });
});

test("mergeSettings: the same setting changed on both takes the later change", () => {
  const base = { a: "1" };
  const later = mergeSettings({
    local: { a: 2 },
    base,
    remote: { keys: { a: { v: 3, t: 50 } } },
    localTime: 40,
    skip: none,
  });
  assert.deepEqual(later.apply, [{ key: "a", value: 3 }]);
  assert.equal(later.recordChanged, false);
  const earlier = mergeSettings({
    local: { a: 2 },
    base,
    remote: { keys: { a: { v: 3, t: 30 } } },
    localTime: 40,
    skip: none,
  });
  assert.deepEqual(earlier.apply, []);
  assert.deepEqual(earlier.record.keys.a, { v: 2, t: 40 });
  const same = mergeSettings({
    local: { a: 3 },
    base,
    remote: { keys: { a: { v: 3, t: 30 } } },
    localTime: 40,
    skip: none,
  });
  assert.equal(same.recordChanged, false);
  assert.deepEqual(same.apply, []);
  assert.deepEqual(same.base, { a: "3" });
});

test("mergeSettings: removing a setting travels, both ways", () => {
  const sent = mergeSettings({
    local: {},
    base: { a: "1" },
    remote: { keys: { a: { v: 1, t: 1 } } },
    localTime: 9,
    skip: none,
  });
  assert.deepEqual(sent.record.keys.a, { d: true, t: 9 });
  assert.deepEqual(sent.base, {});
  const got = mergeSettings({
    local: { a: 1 },
    base: { a: "1" },
    remote: { keys: { a: { d: true, t: 9 } } },
    localTime: 1,
    skip: none,
  });
  assert.deepEqual(got.apply, [{ key: "a", value: undefined }]);
  assert.equal(got.recordChanged, false);
  assert.deepEqual(got.base, {});
});

test("mergeSettings: nothing changed is nothing to do, and skipped settings stay here", () => {
  const remote = { keys: { a: { v: 1, t: 1 }, "accounts.serverUrl": { v: "x", t: 1 } } };
  const r = mergeSettings({
    local: { a: 1, "accounts.serverUrl": "http://127.0.0.1" },
    base: { a: "1" },
    remote,
    localTime: 99,
    skip: (k) => k === "accounts.serverUrl",
  });
  assert.equal(r.recordChanged, false);
  assert.deepEqual(r.apply, []);
  assert.deepEqual(r.base, { a: "1" });
  assert.deepEqual(r.record.keys["accounts.serverUrl"], { v: "x", t: 1 }, "left as it was");
});

const files = (o: Record<string, LocalFile>) => new Map(Object.entries(o));
const remotes = (o: Record<string, RemoteFile>) => new Map(Object.entries(o));

test("planFiles: one side changed", () => {
  const base: Record<string, FileBase> = {
    same: { hash: "h", version: 1 },
    edited: { hash: "h", version: 1 },
    removedHere: { hash: "h", version: 1 },
    newer: { hash: "h", version: 1 },
    removedThere: { hash: "h", version: 1 },
  };
  const local = files({
    same: { hash: "h", mtimeMs: 1 },
    edited: { hash: "h2", mtimeMs: 2 },
    newer: { hash: "h", mtimeMs: 1 },
    removedThere: { hash: "h", mtimeMs: 1 },
    created: { hash: "c", mtimeMs: 3 },
  });
  const remote = remotes({
    same: { version: 1, deleted: false, hash: "h" },
    edited: { version: 1, deleted: false, hash: "h" },
    removedHere: { version: 1, deleted: false, hash: "h" },
    newer: { version: 2, deleted: false, hash: "n", mtimeMs: 9 },
    removedThere: { version: 2, deleted: true },
    arrived: { version: 1, deleted: false, hash: "a", mtimeMs: 4 },
    longGone: { version: 3, deleted: true },
  });
  assert.deepEqual(planFiles(local, base, remote), [
    { kind: "download", path: "arrived" },
    { kind: "upload", path: "created", expect: null },
    { kind: "upload", path: "edited", expect: 1 },
    { kind: "download", path: "newer" },
    { kind: "deleteRemote", path: "removedHere", expect: 1 },
    { kind: "deleteLocal", path: "removedThere" },
  ]);
});

test("planFiles: both sides changed", () => {
  const base: Record<string, FileBase> = {
    both: { hash: "h", version: 1 },
    bothLater: { hash: "h", version: 1 },
    agree: { hash: "h", version: 1 },
    editedHereGoneThere: { hash: "h", version: 1 },
    goneHereEditedThere: { hash: "h", version: 1 },
    goneBoth: { hash: "h", version: 1 },
  };
  const local = files({
    both: { hash: "l", mtimeMs: 50 },
    bothLater: { hash: "l", mtimeMs: 50 },
    agree: { hash: "x", mtimeMs: 5 },
    editedHereGoneThere: { hash: "l", mtimeMs: 5 },
    firstTime: { hash: "f", mtimeMs: 5 },
  });
  const remote = remotes({
    both: { version: 2, deleted: false, hash: "r", mtimeMs: 40 },
    bothLater: { version: 2, deleted: false, hash: "r", mtimeMs: 60 },
    agree: { version: 2, deleted: false, hash: "x", mtimeMs: 9 },
    editedHereGoneThere: { version: 2, deleted: true },
    goneHereEditedThere: { version: 2, deleted: false, hash: "r", mtimeMs: 9 },
    goneBoth: { version: 2, deleted: true },
    firstTime: { version: 4, deleted: false, hash: "f", mtimeMs: 1 },
  });
  assert.deepEqual(planFiles(local, base, remote), [
    { kind: "adopt", path: "agree" },
    { kind: "conflict", path: "both", winner: "local", expect: 2 },
    { kind: "conflict", path: "bothLater", winner: "remote", expect: 2 },
    { kind: "upload", path: "editedHereGoneThere", expect: 2 },
    { kind: "adopt", path: "firstTime" },
    { kind: "adopt", path: "goneBoth" },
    { kind: "download", path: "goneHereEditedThere" },
  ]);
});

test("planFiles: a file deleted as of the last sync and still gone is nothing to do", () => {
  const base: Record<string, FileBase> = { gone: { version: 2 } };
  const tombstone = remotes({ gone: { version: 2, deleted: true } });
  assert.deepEqual(planFiles(files({}), base, tombstone), []);
  // Made again here: sent over the tombstone.
  assert.deepEqual(planFiles(files({ gone: { hash: "n", mtimeMs: 1 } }), base, tombstone), [
    { kind: "upload", path: "gone", expect: 2 },
  ]);
});

test("conflictPath and fileRecordId", () => {
  assert.equal(conflictPath("keybindings.json"), "keybindings.conflict.json");
  assert.equal(conflictPath("skills/a.b/SKILL.md"), "skills/a.b/SKILL.conflict.md");
  assert.equal(conflictPath("agents/README"), "agents/README.conflict");
  assert.equal(conflictPath("x/.hidden"), "x/.hidden.conflict");
  assert.equal(fileRecordId("snippets/my snippets.json"), "snippets__my_20_snippets.json");
  const long = `skills/${"a".repeat(100)}/SKILL.md`;
  const other = `skills/${"a".repeat(101)}/SKILL.md`;
  assert.ok(fileRecordId(long).length <= 80);
  assert.match(fileRecordId(long), /^[A-Za-z0-9_.-]+$/);
  assert.notEqual(fileRecordId(long), fileRecordId(other));
});
