import assert from "node:assert/strict";
import { test } from "node:test";
import {
  effectiveBindings,
  type SourcedRule,
  validateUserKeybindings,
  whensCanOverlap,
} from "./effective";

const d = (key: string, command: string, when?: string): SourcedRule => ({
  key,
  command,
  source: "default",
  ...(when && { when }),
});

test("user rules remove and add bindings", () => {
  const rules: SourcedRule[] = [
    d("ctrl+p", "quickOpen.show"),
    d("ctrl+b", "layout.toggleSidebar"),
    { key: "", command: "-layout.toggleSidebar", source: "user" },
    { key: "ctrl+alt+b", command: "layout.toggleSidebar", source: "user" },
  ];
  const table = effectiveBindings(rules, "linux");
  assert.deepEqual(
    table.map((b) => [b.command, b.label, b.source]),
    [
      ["quickOpen.show", "Ctrl+P", "default"],
      ["layout.toggleSidebar", "Ctrl+Alt+B", "user"],
    ],
  );
});

test("conflicts: same key, overlapping when", () => {
  const table = effectiveBindings(
    [d("ctrl+e", "a"), d("ctrl+e", "b", "editorFocus"), d("ctrl+e", "c", "x"), d("ctrl+r", "d")],
    "linux",
  );
  const byCommand = Object.fromEntries(table.map((b) => [b.command, b.conflicts]));
  assert.deepEqual(byCommand.a, ["b", "c"]);
  assert.deepEqual(byCommand.b, ["a"]); // "editorFocus" vs "x" may both hold, but differ: not flagged
  assert.deepEqual(byCommand.d, []);
});

test("when clauses that can't hold together aren't conflicts (D209)", () => {
  assert.equal(whensCanOverlap("explorerFocus && !inputFocus", "editorFocus"), false);
  assert.equal(whensCanOverlap("isMac", "!isMac && x"), false);
  assert.equal(whensCanOverlap("a == 'one'", "a == 'two'"), false);
  assert.equal(whensCanOverlap("editorFocus || explorerFocus", "explorerFocus"), true);
  assert.equal(whensCanOverlap("editorFocus && x", "editorTextFocus"), true);
  assert.equal(whensCanOverlap("terminalFocus", undefined), true);
  assert.equal(whensCanOverlap("((", "x"), true);
  // Undo in the explorer and the editor's own undo: one key, never both.
  const table = effectiveBindings(
    [
      { key: "ctrl+z", command: "undo", source: "default", engine: true },
      d("ctrl+z", "workspace.undo", "explorerFocus && !inputFocus"),
      d("ctrl+z", "other.undo"),
    ],
    "linux",
  );
  const by = Object.fromEntries(table.map((b) => [b.command, b]));
  assert.deepEqual(by["workspace.undo"]?.conflicts, ["other.undo"]);
  assert.deepEqual(by["workspace.undo"]?.resolved, []);
  // The IDE's default on the editor's key: settled (the editor's runs in an editor).
  assert.deepEqual(by.undo?.conflicts, []);
  assert.deepEqual(
    by.undo?.resolved.map((r) => r.command),
    ["other.undo"],
  );
  assert.match(by["other.undo"]?.resolved[0]?.note ?? "", /In an editor/);
});

test("validation reports bad entries and keeps the rest", () => {
  const { rules, problems } = validateUserKeybindings([
    { key: "ctrl+k ctrl+t", command: "ui.toggleTheme" },
    { key: "ctrl+", command: "x" },
    { command: "y" },
  ]);
  assert.equal(rules.length, 1);
  assert.equal(problems.length, 2);
});
