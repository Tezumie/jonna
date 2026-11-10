import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRestoreWindows, startupFolders } from "./restoreWindows";

const base = { launchFolder: null, newWindow: false, lastFolder: "/a", previous: ["/b", "/a"] };

test("all: this window takes the last folder, the others come back as windows", () => {
  assert.deepEqual(startupFolders({ ...base, setting: "all" }), {
    open: "/a",
    spawn: ["/b"],
    spawnEmpty: [],
  });
  // The last folder wasn't among the windows: the most recent window's.
  assert.deepEqual(startupFolders({ ...base, setting: "all", lastFolder: "/z" }), {
    open: "/b",
    spawn: ["/a"],
    spawnEmpty: [],
  });
  // Nothing recorded (an older version, or not the first window): the last folder.
  assert.deepEqual(startupFolders({ ...base, setting: "all", previous: [] }), {
    open: "/a",
    spawn: [],
    spawnEmpty: [],
  });
});

test("one, none, a folder from the command line and New window", () => {
  assert.deepEqual(startupFolders({ ...base, setting: "one" }), {
    open: "/a",
    spawn: [],
    spawnEmpty: [],
  });
  assert.deepEqual(startupFolders({ ...base, setting: "none" }), { spawn: [], spawnEmpty: [] });
  assert.deepEqual(startupFolders({ ...base, setting: "all", launchFolder: "/c" }), {
    open: "/c",
    spawn: [],
    spawnEmpty: [],
  });
  assert.deepEqual(startupFolders({ ...base, setting: "all", newWindow: true }), {
    spawn: [],
    spawnEmpty: [],
  });
  assert.deepEqual(
    startupFolders({ ...base, setting: "one", lastFolder: undefined, previous: [] }),
    { spawn: [], spawnEmpty: [] },
  );
});

test("empty windows with unsaved text come back (VS Code)", () => {
  const empties = { previousEmpty: ["e1", "e2"] };
  // Beside folder windows: each its own window.
  assert.deepEqual(startupFolders({ ...base, ...empties, setting: "all" }), {
    open: "/a",
    spawn: ["/b"],
    spawnEmpty: ["e1", "e2"],
  });
  // Only empty windows last time: this window is the most recent one, not the last folder.
  assert.deepEqual(startupFolders({ ...base, ...empties, setting: "all", previous: [] }), {
    spawn: [],
    takeEmpty: "e1",
    spawnEmpty: ["e2"],
  });
  // "one": the last folder, else the most recent empty window.
  assert.deepEqual(startupFolders({ ...base, ...empties, setting: "one" }), {
    open: "/a",
    spawn: [],
    spawnEmpty: [],
  });
  assert.deepEqual(
    startupFolders({ ...base, ...empties, setting: "one", lastFolder: undefined, previous: [] }),
    { spawn: [], takeEmpty: "e1", spawnEmpty: [] },
  );
  // A folder asked for, New window or "none": they stay for a later start.
  for (const opts of [
    { setting: "none" as const },
    { setting: "all" as const, newWindow: true },
    { setting: "all" as const, launchFolder: "/c" },
  ]) {
    const r = startupFolders({ ...base, ...empties, ...opts });
    assert.equal(r.takeEmpty, undefined);
    assert.deepEqual(r.spawnEmpty, []);
  }
});

test("the setting's values", () => {
  assert.equal(parseRestoreWindows("none"), "none");
  assert.equal(parseRestoreWindows("preserve"), "all");
  assert.equal(parseRestoreWindows(undefined), "all");
});
