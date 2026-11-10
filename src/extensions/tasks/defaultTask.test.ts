import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJsonc } from "../../core/settings/jsonc";
import { hasDefaultTask, setDefaultTask } from "./defaultTask";
import { scriptTasks, type TaskDefinition } from "./tasks";

const tasksOf = (text: string | null) => {
  assert.ok(text);
  const parsed = parseJsonc(text);
  assert.ok(parsed.ok);
  return (parsed.value as { tasks: Record<string, unknown>[] }).tasks;
};

const pkg = { scripts: { build: "tsc -p .", test: "node --test", dev: "vite" } };
const detected = (label: string, lockfiles: string[] = []): TaskDefinition => {
  const t = scriptTasks(pkg, lockfiles).find((x) => x.label === label);
  assert.ok(t, label);
  return t;
};

test("default task: an existing entry becomes the default, the old default stays in the group", () => {
  const text = `{
  // my tasks
  "version": "2.0.0",
  "tasks": [
    { "label": "compile", "type": "shell", "command": "make", "group": { "kind": "build", "isDefault": true } },
    { "label": "bundle", "type": "shell", "command": "esbuild", "group": "build" },
    { "label": "lint", "type": "shell", "command": "eslint ." }
  ]
}
`;
  const bundle = { ...detected("npm: build"), label: "bundle" };
  const out = setDefaultTask(text, "build", bundle);
  assert.ok(out?.includes("// my tasks"), "comments outside the list are kept");
  const tasks = tasksOf(out);
  assert.equal(tasks.length, 3);
  assert.equal(tasks[0]?.group, "build");
  assert.deepEqual(tasks[1]?.group, { kind: "build", isDefault: true });
  assert.equal(tasks[2]?.group, undefined);
  assert.ok(out && hasDefaultTask(out, "build"));
  assert.ok(out && !hasDefaultTask(out, "test"));
});

test("default task: a detected npm script gets its own entry, in a new file too", () => {
  const out = setDefaultTask("", "test", detected("npm: test"));
  const tasks = tasksOf(out);
  assert.deepEqual(tasks, [
    {
      type: "npm",
      script: "test",
      label: "npm: test",
      detail: "node --test",
      problemMatcher: [],
      group: { kind: "test", isDefault: true },
    },
  ]);
  assert.match(out ?? "", /"version": "2.0.0"/);
  // Picked again: the same entry, not a second one.
  assert.equal(tasksOf(setDefaultTask(out ?? "", "test", detected("npm: test"))).length, 1);
});

test("default task: pnpm scripts become shell tasks with the detected label", () => {
  const tasks = tasksOf(setDefaultTask("{}", "build", detected("pnpm: build", ["pnpm-lock.yaml"])));
  assert.equal(tasks[0]?.label, "pnpm: build");
  assert.equal(tasks[0]?.type, "shell");
  assert.equal(tasks[0]?.command, "pnpm build");
});

test("default task: clearing another file's default, and broken files", () => {
  const text = `{ "tasks": [ { "label": "a", "command": "x", "group": { "kind": "test", "isDefault": true } } ] }`;
  const tasks = tasksOf(setDefaultTask(text, "test", null));
  assert.equal(tasks[0]?.group, "test");
  assert.equal(setDefaultTask("{ not json", "build", detected("npm: build")), null);
});
