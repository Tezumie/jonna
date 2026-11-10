import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveBindings, type SourcedRule } from "../../core/keybindings/effective";
import { quotedKey, shortcutRows } from "./rows";

const rules: SourcedRule[] = [
  {
    key: "ctrl+d",
    command: "editor.action.addSelectionToNextFindMatch",
    when: "editorFocus",
    source: "default",
    engine: true,
  },
  {
    key: "alt+up",
    command: "editor.action.moveLinesUpAction",
    when: "editorTextFocus && !editorReadonly",
    source: "default",
    engine: true,
  },
  { key: "down", command: "cursorDown", when: "textInputFocus", source: "default", engine: true },
  {
    key: "tab",
    command: "acceptSelectedSuggestion",
    when: "suggestWidgetVisible",
    source: "default",
    engine: true,
  },
  { key: "tab", command: "tab", when: "editorTextFocus", source: "default", engine: true },
  { key: "ctrl+shift+p", command: "palette.show", source: "default" },
  { key: "ctrl+d", command: "x.duplicate", source: "user" },
];

const commands = [
  { id: "palette.show", title: "Show all commands", category: "View" },
  {
    id: "editor.action.addSelectionToNextFindMatch",
    title: "Add selection to next find match",
    engine: true,
  },
  { id: "editor.action.moveLinesUpAction", title: "Move line up", engine: true },
  { id: "editor.action.unbound", title: "Never bound", engine: true },
  { id: "x.duplicate", title: "Duplicate", category: "X" },
];

test("Monaco's keys are rows, searchable by key in quotes (D204)", () => {
  const table = effectiveBindings(rules, "linux");
  const all = shortcutRows(commands, table, "");
  // Bound engine commands without an action (cursorDown) get a row with a readable title (D207).
  assert.ok(all.some((r) => r.command.id === "cursorDown" && r.command.title === "Cursor down"));
  // Unbound actions are listed last.
  assert.equal(all[all.length - 1]?.command.id, "editor.action.unbound");
  const ctrlD = shortcutRows(commands, table, '"ctrl+d"').map((r) => r.command.id);
  assert.deepEqual(ctrlD.sort(), ["editor.action.addSelectionToNextFindMatch", "x.duplicate"]);
  // Any spelling of the key, and the label form, find the same rows.
  assert.equal(shortcutRows(commands, table, '"Control+D"').length, 2);
  assert.equal(shortcutRows(commands, table, '"Alt+↑"').length, 1); // Show same keybindings' label form
  assert.equal(
    shortcutRows(commands, table, '"alt+up"')[0]?.command.id,
    "editor.action.moveLinesUpAction",
  );
  // Plain text matches titles, ids, keys and when clauses.
  assert.ok(
    shortcutRows(commands, table, "move line").some(
      (r) => r.command.id === "editor.action.moveLinesUpAction",
    ),
  );
  assert.ok(
    shortcutRows(commands, table, "suggestWidgetVisible").some(
      (r) => r.command.id === "acceptSelectedSuggestion",
    ),
  );
  assert.deepEqual(quotedKey('"ctrl+k  ctrl+c"'), {
    chords: "ctrl+k ctrl+c",
    label: "ctrl+k ctrl+c",
  });
  assert.equal(quotedKey("ctrl+d"), undefined);
});

test("engine defaults on one key don't count as conflicts; an IDE key on them is resolved", () => {
  const table = effectiveBindings(rules, "linux");
  const tab = table.filter((b) => b.chords[0] === "tab");
  assert.ok(tab.every((b) => b.conflicts.length === 0 && b.resolved.length === 0));
  // D209: the user's key wins over the editor's, so it's settled, not a conflict.
  const ctrlD = table.find((b) => b.command === "x.duplicate");
  assert.deepEqual(ctrlD?.conflicts, []);
  assert.deepEqual(
    ctrlD?.resolved.map((r) => r.command),
    ["editor.action.addSelectionToNextFindMatch"],
  );
  assert.match(ctrlD?.resolved[0]?.note ?? "", /Your keybinding wins/);
  // A user removal takes a Monaco default away from the table.
  const removed = effectiveBindings(
    [
      ...rules,
      { key: "ctrl+d", command: "-editor.action.addSelectionToNextFindMatch", source: "user" },
    ],
    "linux",
  );
  assert.ok(!removed.some((b) => b.command === "editor.action.addSelectionToNextFindMatch"));
});
