import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJsonc } from "../settings/jsonc";
import { setJsoncArrayItem } from "../settings/jsoncEdit";
import {
  addBinding,
  applyRuleEdits,
  type BindingRef,
  changeKey,
  changeWhen,
  findUserEntry,
  removeBinding,
} from "./edit";
import { effectiveBindings } from "./effective";

const FILE = `// my keys
[
  { "key": "ctrl+alt+t", "command": "terminal.new" }, // keep this comment
  { "key": "ctrl+shift+d", "command": "editor.action.copyLinesDownAction", "when": "editorTextFocus" }
]
`;

const parse = (text: string): unknown[] => {
  const parsed = parseJsonc(text);
  assert.ok(parsed.ok);
  return parsed.value as unknown[];
};

const monacoDefault: BindingRef = {
  command: "editor.action.addSelectionToNextFindMatch",
  key: "ctrl+d",
  when: "editorFocus",
  source: "default",
};

test("changing a default binding's key: a removal rule plus the new rule (D204)", () => {
  const edits = changeKey(parse(FILE), monacoDefault, "ctrl+alt+d", "linux");
  const next = applyRuleEdits(FILE, edits);
  assert.ok(next.includes("// keep this comment"));
  assert.deepEqual(parse(next).slice(2), [
    { key: "ctrl+d", command: "-editor.action.addSelectionToNextFindMatch", when: "editorFocus" },
    {
      key: "ctrl+alt+d",
      command: "editor.action.addSelectionToNextFindMatch",
      when: "editorFocus",
    },
  ]);
  // The table then has the new key and not the old one.
  const table = effectiveBindings(
    [
      {
        key: "ctrl+d",
        command: monacoDefault.command,
        when: "editorFocus",
        source: "default",
        engine: true,
      },
      ...(parse(next) as { key: string; command: string }[]).map((r) => ({
        ...r,
        source: "user" as const,
      })),
    ],
    "linux",
  );
  assert.deepEqual(
    table.filter((b) => b.command === monacoDefault.command).map((b) => b.label),
    ["Ctrl+Alt+D"],
  );
});

test("a user's own entry is changed in place, keeping the file's comments", () => {
  const ref: BindingRef = {
    command: "editor.action.copyLinesDownAction",
    key: "ctrl+shift+d",
    when: "editorTextFocus",
    source: "user",
  };
  assert.equal(findUserEntry(parse(FILE), ref, "linux"), 1);
  const rekeyed = applyRuleEdits(FILE, changeKey(parse(FILE), ref, "ctrl+alt+down", "linux"));
  assert.deepEqual(parse(rekeyed)[1], {
    key: "ctrl+alt+down",
    command: "editor.action.copyLinesDownAction",
    when: "editorTextFocus",
  });
  assert.ok(rekeyed.startsWith("// my keys") && rekeyed.includes("// keep this comment"));
  const when = applyRuleEdits(
    FILE,
    changeWhen(parse(FILE), ref, "editorTextFocus && !editorReadonly", "linux"),
  );
  assert.equal((parse(when)[1] as { when: string }).when, "editorTextFocus && !editorReadonly");
  const noWhen = applyRuleEdits(FILE, changeWhen(parse(FILE), ref, "  ", "linux"));
  assert.equal("when" in (parse(noWhen)[1] as object), false);
  const removed = applyRuleEdits(FILE, removeBinding(parse(FILE), ref, "linux"));
  assert.deepEqual(parse(removed), [{ key: "ctrl+alt+t", command: "terminal.new" }]);
  assert.ok(removed.includes("// keep this comment"));
});

test("changing a default's when clause and removing a default", () => {
  const when = applyRuleEdits(
    FILE,
    changeWhen(parse(FILE), monacoDefault, "editorTextFocus", "linux"),
  );
  assert.deepEqual(parse(when).slice(2), [
    { key: "ctrl+d", command: "-editor.action.addSelectionToNextFindMatch", when: "editorFocus" },
    {
      key: "ctrl+d",
      command: "editor.action.addSelectionToNextFindMatch",
      when: "editorTextFocus",
    },
  ]);
  assert.deepEqual(changeWhen(parse(FILE), monacoDefault, "editorFocus", "linux"), []);
  const removed = applyRuleEdits(FILE, removeBinding(parse(FILE), monacoDefault, "linux"));
  assert.deepEqual(parse(removed).slice(2), [
    { key: "ctrl+d", command: "-editor.action.addSelectionToNextFindMatch", when: "editorFocus" },
  ]);
  const added = applyRuleEdits("", addBinding("terminal.new", "ctrl+alt+n", "terminalFocus"));
  assert.deepEqual(parse(added), [
    { key: "ctrl+alt+n", command: "terminal.new", when: "terminalFocus" },
  ]);
});

test("macOS entries with a mac key are matched and changed through it", () => {
  const text = `[{ "key": "ctrl+e", "mac": "cmd+e", "command": "x.run" }]`;
  const ref: BindingRef = { command: "x.run", key: "meta+e", source: "user" };
  assert.equal(findUserEntry(parse(text), ref, "mac"), 0);
  assert.equal(findUserEntry(parse(text), ref, "linux"), -1);
  const next = applyRuleEdits(text, changeKey(parse(text), ref, "meta+shift+e", "mac"));
  assert.deepEqual(parse(next), [{ key: "ctrl+e", mac: "meta+shift+e", command: "x.run" }]);
  assert.throws(
    () => changeKey(parse(text), { ...ref, key: "meta+q" }, "meta+w", "mac"),
    /no entry/,
  );
});

test("setJsoncArrayItem replaces and removes items, first, middle and last", () => {
  const text = '[\n  1, // one\n  { "a": [2, 3] },\n  4\n]\n';
  assert.deepEqual(parse(setJsoncArrayItem(text, 1, { b: 1 })), [1, { b: 1 }, 4]);
  assert.deepEqual(parse(setJsoncArrayItem(text, 0, undefined)), [{ a: [2, 3] }, 4]);
  assert.deepEqual(parse(setJsoncArrayItem(text, 1, undefined)), [1, 4]);
  const last = setJsoncArrayItem(text, 2, undefined);
  assert.deepEqual(parse(last), [1, { a: [2, 3] }]);
  assert.ok(last.includes("// one"));
  assert.deepEqual(parse(setJsoncArrayItem("[5]", 0, undefined)), []);
  assert.throws(() => setJsoncArrayItem(text, 3, 1), /No entry 4/);
});
