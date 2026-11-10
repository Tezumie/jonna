import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsModel } from "./model";
import { SettingsRegistry } from "./schema";

function model() {
  const registry = new SettingsRegistry();
  registry.register({
    "editor.tabSize": { type: "number", default: 4, description: "Tab size." },
    "files.exclude": { type: "object", default: {}, description: "Excluded files." },
    "terminal.profile": {
      type: "string",
      default: "",
      restricted: true,
      description: "A profile.",
    },
    "agent.key": { type: "string", default: "", scope: "user", description: "A key." },
  });
  return new SettingsModel(registry);
}

test("each folder's settings apply to its own files (D251)", () => {
  const m = model();
  m.setText("user", '{ "editor.tabSize": 8 }');
  m.setText("workspace", '{ "editor.tabSize": 2 }');
  const fired: string[][] = [];
  m.onDidChange((keys) => fired.push([...keys]));
  m.setFolderLayer("a", { "editor.tabSize": 3, "[python]": { "editor.tabSize": 6 } });
  assert.deepEqual(fired, [["editor.tabSize"]]);
  // The window's value doesn't change; a file of folder a gets its folder's.
  assert.equal(m.get("editor.tabSize"), 2);
  assert.equal(m.getAt("editor.tabSize", "a"), 3);
  assert.equal(m.getAt("editor.tabSize", "b"), 2);
  assert.equal(m.getAt("editor.tabSize", null), 2);
  // A language block wins for that language, the folder's first.
  assert.equal(m.getForLanguageAt("editor.tabSize", "python", "a"), 6);
  assert.equal(m.getForLanguageAt("editor.tabSize", "rust", "a"), 3);
  m.setText("workspace", '{ "editor.tabSize": 2, "[rust]": { "editor.tabSize": 5 } }');
  assert.equal(m.getForLanguageAt("editor.tabSize", "rust", "a"), 5);
  assert.equal(m.getForLanguageAt("editor.tabSize", "rust", "b"), 5);
  // Invalid values fall through; dropping the layer forgets it.
  m.setFolderLayer("c", { "editor.tabSize": "big" });
  assert.equal(m.getAt("editor.tabSize", "c"), 2);
  m.setFolderLayer("a", null);
  assert.equal(m.getAt("editor.tabSize", "a"), 2);
  assert.deepEqual(m.folderLayers(), ["c"]);
});

test("a folder can't set user-only keys, nor restricted ones before it's trusted", () => {
  const m = model();
  m.setText("user", '{ "agent.key": "mine", "terminal.profile": "bash" }');
  m.setFolderLayer("a", { "agent.key": "theirs", "terminal.profile": "evil" });
  assert.equal(m.getAt("agent.key", "a"), "mine");
  assert.equal(m.getAt("terminal.profile", "a"), "bash");
  m.setTrusted(true);
  assert.equal(m.getAt("terminal.profile", "a"), "evil");
  assert.equal(m.getAt("agent.key", "a"), "mine");
});

test("object settings merge across layers, as VS Code's do (D379)", () => {
  const registry = new SettingsRegistry();
  registry.register({
    "files.exclude": {
      type: "object",
      default: { "**/.git": true, "**/.DS_Store": true },
      description: "Excluded files.",
    },
    "terminal.automationProfile.windows": {
      type: "object",
      default: {},
      description: "One profile, replaced whole.",
    },
  });
  const m = new SettingsModel(registry);
  m.setText("user", '{ "files.exclude": { "**/out": true } }');
  m.setText("workspace", '{ "files.exclude": { "**/dist": true, "**/.DS_Store": false } }');
  // The project's adds to the defaults and the user's; false still turns one off.
  assert.deepEqual(m.get("files.exclude"), {
    "**/.git": true,
    "**/.DS_Store": false,
    "**/out": true,
    "**/dist": true,
  });
  assert.equal(m.resolve("files.exclude").source, "workspace");
  m.setFolderLayer("a", { "files.exclude": { "**/tmp": true } });
  assert.deepEqual(Object.keys(m.getAt("files.exclude", "a") as object).sort(), [
    "**/.DS_Store",
    "**/.git",
    "**/dist",
    "**/out",
    "**/tmp",
  ]);
  // A profile isn't merged: the top layer's is the one used.
  m.setText("user", '{ "terminal.automationProfile.windows": { "path": "bash", "args": ["-l"] } }');
  m.setText("workspace", '{ "terminal.automationProfile.windows": { "path": "pwsh" } }');
  assert.deepEqual(m.get("terminal.automationProfile.windows"), { path: "pwsh" });
});
