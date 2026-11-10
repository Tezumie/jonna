import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeLinesText, mergeNamedListText, mergeSettingsText } from "./workspaceMerge";

test("mergeSettingsText: adds only keys the IDE's own lacks, keeps its comments (D189)", () => {
  const own = '{\n  // mine\n  "editor.fontSize": 14\n}\n';
  const r = mergeSettingsText(own, { "editor.fontSize": 20, "editor.tabSize": 2 });
  assert.ok(r);
  assert.deepEqual(r.added, ["editor.tabSize"]);
  assert.match(r.text, /\/\/ mine/);
  assert.match(r.text, /"editor.fontSize": 14/);
  assert.match(r.text, /"editor.tabSize": 2/);
  assert.deepEqual(mergeSettingsText("", { a: 1 })?.added, ["a"]);
  // D203: the IDE's own file with a syntax error is left alone, not replaced.
  assert.equal(mergeSettingsText('{ "a": 1, ', { b: 2 }), null);
});

test("mergeNamedListText: appends tasks with new labels only", () => {
  const own = '{ "version": "2.0.0", "tasks": [{ "label": "build" }] }';
  const lower = '{ "tasks": [{ "label": "build", "x": 1 }, { "label": "test" }] }';
  const r = mergeNamedListText(own, lower, "tasks", "label");
  assert.deepEqual(r?.added, ["test"]);
  const tasks = JSON.parse(r?.text ?? "{}").tasks;
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].x, undefined);
  assert.equal(mergeNamedListText("nope", lower, "tasks", "label"), null);
});

test("mergeLinesText: appends missing lines, skips headings", () => {
  const r = mergeLinesText("# Style\n- a\n", "# Style\n- a\n- b\n");
  assert.equal(r.added, 1);
  assert.equal(r.text, "# Style\n- a\n- b\n");
});
