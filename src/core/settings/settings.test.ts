import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJsonc } from "./jsonc";
import { setJsoncProperty } from "./jsoncEdit";
import { SettingsModel } from "./model";
import { describeKey, isValid, SettingsRegistry } from "./schema";

const parse = (text: string) => {
  const r = parseJsonc(text);
  assert.ok(r.ok, text);
  return r.value as Record<string, unknown>;
};

test("setJsoncProperty keeps comments and formatting", () => {
  const text = `{
  // my theme
  "workbench.theme": "dark", /* trailing */
  "editor.fontSize": 13
}
`;
  const replaced = setJsoncProperty(text, "workbench.theme", "light");
  assert.ok(replaced.includes("// my theme") && replaced.includes("/* trailing */"));
  assert.equal(parse(replaced)["workbench.theme"], "light");
  const added = setJsoncProperty(text, "terminal.bell", "visual");
  assert.deepEqual(parse(added), {
    "workbench.theme": "dark",
    "editor.fontSize": 13,
    "terminal.bell": "visual",
  });
  const removedLast = setJsoncProperty(text, "editor.fontSize", undefined);
  assert.deepEqual(parse(removedLast), { "workbench.theme": "dark" });
  assert.ok(removedLast.includes("// my theme"));
  const removedFirst = setJsoncProperty(text, "workbench.theme", undefined);
  assert.deepEqual(parse(removedFirst), { "editor.fontSize": 13 });
  assert.equal(setJsoncProperty(text, "missing", undefined), text);
});

test("setJsoncProperty handles empty, trailing commas and nested values", () => {
  assert.deepEqual(parse(setJsoncProperty("", "a", 1)), { a: 1 });
  assert.deepEqual(parse(setJsoncProperty("{}", "a", [1, 2])), { a: [1, 2] });
  assert.deepEqual(parse(setJsoncProperty('{ "x": { "y": 1 }, }', "a", { b: true })), {
    x: { y: 1 },
    a: { b: true },
  });
  assert.deepEqual(parse(setJsoncProperty('{ "x": { "a": 1 } }', "a", 2)), { x: { a: 1 }, a: 2 });
  assert.deepEqual(parse(setJsoncProperty('{ "x": [1, {"a": 2}], "y": 1 }', "x", undefined)), {
    y: 1,
  });
  assert.deepEqual(parse(setJsoncProperty('{ "s": "has \\" quote and }" }', "t", 1)), {
    s: 'has " quote and }',
    t: 1,
  });
});

test("schema validation and key descriptions", () => {
  assert.deepEqual(describeKey("editor.stickyScroll.enabled"), {
    category: "Editor",
    title: "Sticky scroll enabled",
  });
  assert.deepEqual(describeKey("terminal.bell"), { category: "Terminal", title: "Bell" });
  assert.deepEqual(describeKey("agent.ollama.url"), { category: "Agent", title: "Ollama URL" });
  assert.deepEqual(describeKey("lsp.servers"), { category: "Language servers", title: "Servers" });
  assert.deepEqual(describeKey("todoTree.groupByTag"), {
    category: "TODO tree",
    title: "Group by tag",
  });
  assert.equal(
    isValid({ type: "string", default: "a", description: "", enum: ["a", "b"] }, "c"),
    false,
  );
  assert.equal(
    isValid({ type: "integer", default: 1, description: "", minimum: 1, maximum: 5 }, 3),
    true,
  );
  assert.equal(isValid({ type: "integer", default: 1, description: "", minimum: 1 }, 0.5), false);
});

test("model resolves defaults < user < workspace and reports changed keys", () => {
  const registry = new SettingsRegistry();
  registry.register({
    "workbench.theme": {
      type: "string",
      enum: ["dark", "light"],
      default: "dark",
      description: "",
    },
    "terminal.bell": {
      type: "string",
      enum: ["none", "visual", "sound"],
      default: "none",
      description: "",
      scope: "user",
    },
  });
  const model = new SettingsModel(registry);
  const changes: string[][] = [];
  model.onDidChange((keys) => changes.push([...keys]));
  assert.equal(model.get("workbench.theme"), "dark");
  model.setText("user", '{ "workbench.theme": "light", "terminal.bell": "visual" }');
  assert.equal(model.get("workbench.theme"), "light");
  assert.deepEqual(changes.pop()?.sort(), ["terminal.bell", "workbench.theme"]);
  model.setText("workspace", '{ "workbench.theme": "dark", "terminal.bell": "sound" }');
  assert.equal(model.resolve("workbench.theme").source, "workspace");
  assert.equal(
    model.get("terminal.bell"),
    "visual",
    "user-only settings ignore the workspace file",
  );
  assert.ok(model.problems().some((p) => p.key === "terminal.bell"));
  model.setText("workspace", '{ "workbench.theme": "purple" }');
  assert.equal(
    model.get("workbench.theme"),
    "light",
    "invalid workspace value falls through to user",
  );
  model.setText("user", '{ "workbench.theme": ');
  assert.equal(model.get("workbench.theme"), "light", "a syntax error keeps the previous values");
  assert.ok(model.problems().some((p) => p.scope === "user" && !p.key));
  model.setText("user", null);
  assert.equal(model.get("workbench.theme"), "dark");
});

test("restricted settings come from a folder only once it's trusted (D209)", () => {
  const registry = new SettingsRegistry();
  registry.register({
    "terminal.profiles.linux": { type: "object", default: {}, description: "", restricted: true },
  });
  const model = new SettingsModel(registry);
  const changes: string[][] = [];
  model.onDidChange((keys) => changes.push([...keys]));
  model.setText("user", '{ "terminal.profiles.linux": { "mine": { "path": "zsh" } } }');
  model.setText("workspace", '{ "terminal.profiles.linux": { "theirs": { "path": "evil" } } }');
  model.setVscode({ "terminal.profiles.linux": { vs: { path: "x" } } });
  assert.equal(model.resolve("terminal.profiles.linux").source, "user");
  assert.ok(model.problems().some((p) => p.key === "terminal.profiles.linux"));
  changes.length = 0;
  model.setTrusted(true);
  assert.deepEqual(changes, [["terminal.profiles.linux"]]);
  assert.equal(model.resolve("terminal.profiles.linux").source, "workspace");
  assert.ok(!model.problems().some((p) => p.key === "terminal.profiles.linux"));
  model.setText("workspace", null);
  assert.equal(model.resolve("terminal.profiles.linux").source, "vscode");
  model.setTrusted(false);
  assert.equal(model.resolve("terminal.profiles.linux").source, "user");
});

test("appendJsoncArrayItem keeps comments and adds commas", async () => {
  const { appendJsoncArrayItem } = await import("./jsoncEdit");
  assert.equal(appendJsoncArrayItem("", { a: 1 }), '[\n  {\n    "a": 1\n  }\n]\n');
  const text = '// mine\n[\n  { "key": "x", "command": "y" } // keep\n]\n';
  const out = appendJsoncArrayItem(text, { key: "z", command: "w" });
  assert.ok(out.startsWith('// mine\n[\n  { "key": "x", "command": "y" },'));
  assert.ok(out.includes('"command": "w"'));
  assert.ok(out.includes("}, // keep\n"));
  assert.equal(appendJsoncArrayItem("[\n]\n", 1), "[\n  1\n]\n");
});

test("model: resetting a value that equals the default is still reported (the editor's bar)", () => {
  const registry = new SettingsRegistry();
  registry.register({ "editor.fontSize": { type: "number", default: 14, description: "" } });
  const model = new SettingsModel(registry);
  const changes: string[][] = [];
  model.onDidChange((keys) => changes.push([...keys]));
  model.setText("user", '{ "editor.fontSize": 14 }');
  assert.deepEqual(changes.pop(), ["editor.fontSize"]);
  model.setText("user", "{}");
  assert.deepEqual(changes.pop(), ["editor.fontSize"]);
});
