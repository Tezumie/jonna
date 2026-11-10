import assert from "node:assert/strict";
import { test } from "node:test";
import type { Caller } from "../dispatcher/types";
import { callerRefusal, engineActionRefusal, guardedCommands, isUserCaller } from "./commandGuards";

const user: Caller = { kind: "user" };
const testScript: Caller = { kind: "test" };
const agent: Caller = { kind: "agent", session: "s" };
const acp: Caller = { kind: "acp", agent: "a", session: "s" };
const mcp: Caller = { kind: "mcp", client: "c" };
const ext: Caller = { kind: "ext", id: "me.ext" };
const others = [agent, acp, mcp, ext];

test("the user and test scripts are never limited", () => {
  assert.ok(isUserCaller(user) && isUserCaller(testScript));
  for (const c of others) assert.ok(!isUserCaller(c));
  for (const c of [user, testScript]) {
    assert.equal(callerRefusal("editor.runAction", { action: "ext.x.run.1" }, c), null);
    assert.equal(callerRefusal("editor.openMultiDiff", { refresh: { command: "a.b" } }, c), null);
    assert.equal(callerRefusal("lsp.setServerSetting", { server: "x", key: "y" }, c), null);
  }
});

test("editor.runAction: the engine's own actions only", () => {
  const run = (action: string, caller: Caller = agent) =>
    callerRefusal("editor.runAction", { action }, caller);
  for (const ok of [
    "editor.action.formatDocument",
    "editor.action.rename",
    "editor.action.commentLine",
    "editor.action.referenceSearch.trigger",
    "editor.foldAll",
    "editor.unfoldRecursively",
    "editor.toggleFold",
    "editor.gotoNextFold",
    "actions.find",
    "actions.findWithSelection",
    "cursorMove",
    "cursorDown",
    "deleteLeft",
    "scrollLineUp",
    "undo",
    "type",
    "ide.formatDocument",
  ])
    for (const c of others) assert.equal(run(ok, c), null, `${ok} for ${c.kind}`);
  // What escapes: the IDE's commands in the engine run IDE commands (or a server's) as the user.
  for (const bad of [
    "ext.me.ext.run.1",
    "lsp.typescript.run.2",
    "lsp.pyright.cells.run.3",
    "ide.resolveConflict",
    "notebook.lsp.cellEdits",
    "_setContext",
    "_executeCommand",
    "vscode.open",
    "workbench.action.terminal.new",
    "editor.action.openLink",
    "editor.action.codeAction",
    "editor.action.organizeImports",
    "editor.action.fixAll",
    "editor.action.",
    "",
  ])
    for (const c of others) assert.match(run(bad, c) ?? "", /Only you/, `${bad} for ${c.kind}`);
  // Reading the clipboard: not for extensions (agents are asked as for any write).
  assert.match(engineActionRefusal("editor.action.clipboardPasteAction", ext) ?? "", /clipboard/);
  assert.equal(engineActionRefusal("editor.action.clipboardPasteAction", agent), null);
});

test("a multi-file diff's Refresh command comes from the user only", () => {
  const input = { title: "t", files: [], refresh: { command: "terminal.runCommand" } };
  for (const c of others)
    assert.match(callerRefusal("editor.openMultiDiff", input, c) ?? "", /Refresh/);
  for (const c of others)
    assert.equal(callerRefusal("editor.openMultiDiff", { title: "t", files: [] }, c), null);
});

test("language server settings: not from extensions", () => {
  for (const id of ["lsp.setServerSetting", "lsp.setServerSettingsJson"]) {
    assert.match(callerRefusal(id, { server: "rust-analyzer" }, ext) ?? "", /not by an extension/);
    // Agents and MCP clients are asked, as for settings.set.
    const asked: Caller[] = [agent, acp, mcp];
    for (const c of asked) assert.equal(callerRefusal(id, { server: "x" }, c), null);
  }
});

test("other commands pass; the list is what the README names", () => {
  assert.equal(callerRefusal("editor.openFile", { path: "/w/a.ts" }, ext), null);
  assert.equal(callerRefusal("editor.runAction", "not an object", agent), null);
  assert.deepEqual(guardedCommands(), [
    "editor.openMultiDiff",
    "editor.runAction",
    "lsp.setServerSetting",
    "lsp.setServerSettingsJson",
  ]);
});
