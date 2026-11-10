import assert from "node:assert/strict";
import { test } from "node:test";
import { belongsToWorkspace, chatWorkspaceKey } from "./chatWorkspace";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

test("a single folder stores and matches the folder, as before", () => {
  const place = { root: "C:\\app", file: null };
  assert.equal(chatWorkspaceKey(place), "C:\\app");
  assert.equal(belongsToWorkspace("c:\\APP", place, same), true);
  assert.equal(belongsToWorkspace("C:\\other", place, same), false);
  assert.equal(belongsToWorkspace(null, place, same), false);
  // A workspace's chat isn't the folder's.
  assert.equal(belongsToWorkspace("C:\\ws\\x.code-workspace", place, same), false);
});

test("a multi-root workspace stores its first folder and matches it or its file", () => {
  const place = { root: "C:\\app", file: "C:\\ws\\x.code-workspace" };
  assert.equal(chatWorkspaceKey(place), "C:\\app");
  assert.equal(belongsToWorkspace("C:\\app", place, same), true);
  // Chats saved while the workspace file was the key.
  assert.equal(belongsToWorkspace("C:\\ws\\x.code-workspace", place, same), true);
  assert.equal(belongsToWorkspace("C:\\ws\\y.code-workspace", place, same), false);
});

test("an untitled workspace saved under a name keeps its chats", () => {
  const untitled = { root: "C:\\app", file: "C:\\data\\workspaces\\untitled\\1.code-workspace" };
  const stored = chatWorkspaceKey(untitled);
  const saved = { root: "C:\\app", file: "C:\\ws\\named.code-workspace" };
  assert.equal(belongsToWorkspace(stored, saved, same), true);
  // And the folder alone again (the workspace closed, the folder opened).
  assert.equal(belongsToWorkspace(stored, { root: "C:\\app", file: null }, same), true);
});

test("nothing open: no chat is the window's", () => {
  const place = { root: null, file: null };
  assert.equal(chatWorkspaceKey(place), null);
  assert.equal(belongsToWorkspace("C:\\app", place, same), false);
});
