import assert from "node:assert/strict";
import { test } from "node:test";
import { isReadOnlyFile, ReadOnlySession, readOnlyBySettings } from "./readOnlyFiles";

const none = { include: {}, exclude: {}, noWritePermission: false };

test("readOnlyBySettings: files.readonlyInclude minus files.readonlyExclude, as VS Code", () => {
  const rules = {
    include: { "**/generated/**": true, "dist/*.js": true, "**/*.lock": false },
    exclude: { "**/generated/keep.ts": true },
    noWritePermission: false,
  };
  assert.equal(readOnlyBySettings("src/generated/api.ts", "/w/src/generated/api.ts", rules), true);
  assert.equal(readOnlyBySettings("dist/app.js", "/w/dist/app.js", rules), true);
  assert.equal(readOnlyBySettings("dist/sub/app.js", "/w/dist/sub/app.js", rules), false);
  // Excluded again, and a `false` entry doesn't count.
  assert.equal(
    readOnlyBySettings("src/generated/keep.ts", "/w/src/generated/keep.ts", rules),
    false,
  );
  assert.equal(readOnlyBySettings("yarn.lock", "/w/yarn.lock", rules), false);
  assert.equal(readOnlyBySettings("src/a.ts", "/w/src/a.ts", none), false);
});

test("readOnlyBySettings: absolute patterns, files outside the folder, Windows paths", () => {
  const rules = { include: { "C:/vendor/**": true }, exclude: {}, noWritePermission: false };
  assert.equal(readOnlyBySettings("", "C:\\vendor\\lib\\x.h", rules), true);
  assert.equal(readOnlyBySettings("", "C:\\other\\x.h", rules), false);
});

test("readOnlyBySettings: no write permission on disk (files.readonlyFromPermissions)", () => {
  assert.equal(readOnlyBySettings("a.ts", "/w/a.ts", { ...none, noWritePermission: true }), true);
});

test("ReadOnlySession: an override wins over the settings until it's reset", () => {
  const session = new ReadOnlySession();
  const rules = { include: { "**": true }, exclude: {}, noWritePermission: false };
  assert.equal(isReadOnlyFile(session.get("a"), "a", "/w/a", rules), true);
  session.set("a", false);
  assert.equal(isReadOnlyFile(session.get("a"), "a", "/w/a", rules), false);
  session.set("b", true);
  assert.equal(isReadOnlyFile(session.get("b"), "b", "/w/b", none), true);
  session.rename("b", "c");
  assert.equal(session.get("b"), undefined);
  assert.equal(session.get("c"), true);
  session.set("a", null);
  assert.equal(isReadOnlyFile(session.get("a"), "a", "/w/a", rules), true);
  assert.deepEqual(session.entries(), [["c", true]]);
});
