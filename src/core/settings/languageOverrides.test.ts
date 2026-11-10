import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJsonc } from "./jsonc";
import { setJsoncNestedProperty } from "./jsoncEdit";
import {
  changedOverrideKeys,
  isLanguageOverrideKey,
  languageValues,
  overrideLanguages,
  validBlock,
  withLanguageValue,
} from "./languageOverrides";
import { SettingsModel } from "./model";
import { SettingsRegistry } from "./schema";
import { translateVscodeSettings } from "./vscode";

const parse = (text: string) => {
  const r = parseJsonc(text);
  assert.ok(r.ok, text);
  return r.value as Record<string, unknown>;
};

test("language block keys and their languages", () => {
  assert.ok(isLanguageOverrideKey("[python]"));
  assert.ok(isLanguageOverrideKey("[javascript][typescript]"));
  assert.ok(isLanguageOverrideKey("[javascript] [typescript]"));
  assert.ok(!isLanguageOverrideKey("editor.tabSize"));
  assert.ok(!isLanguageOverrideKey("[]"));
  assert.ok(!isLanguageOverrideKey("[python].x"));
  assert.deepEqual(overrideLanguages("[javascript][typescript]"), ["javascript", "typescript"]);
  // VS Code's ids for TSX / JSX are the editor's tsx / jsx.
  assert.deepEqual(overrideLanguages("[typescriptreact]"), ["tsx"]);
  assert.deepEqual(overrideLanguages("editor.tabSize"), []);
});

test("languageValues merges every block naming the language, later wins", () => {
  const layer = {
    "editor.tabSize": 8,
    "[javascript][typescript]": { "editor.tabSize": 2, "editor.formatOnSave": true },
    "[typescript]": { "editor.tabSize": 4 },
    "[python]": { "editor.tabSize": 4 },
    "[bad]": 3,
  };
  assert.deepEqual(languageValues(layer, "typescript"), {
    "editor.tabSize": 4,
    "editor.formatOnSave": true,
  });
  assert.deepEqual(languageValues(layer, "javascript"), {
    "editor.tabSize": 2,
    "editor.formatOnSave": true,
  });
  assert.deepEqual(languageValues(layer, "rust"), {});
  assert.deepEqual(languageValues(layer, "bad"), {});
});

test("changes inside blocks are reported by their own keys", () => {
  assert.deepEqual(
    changedOverrideKeys(
      { "[python]": { "editor.tabSize": 4, "files.eol": "\n" } },
      { "[python]": { "editor.tabSize": 2, "files.eol": "\n" }, "[go]": { "editor.rulers": [] } },
    ).sort(),
    ["editor.rulers", "editor.tabSize"],
  );
  assert.deepEqual(withLanguageValue({ "[go]": { a: 1 } }, "go", "a", undefined), undefined);
  assert.deepEqual(withLanguageValue({}, "go", "a", 2), { a: 2 });
  assert.deepEqual(
    validBlock({ a: 1, b: "x" }, (_k, v) => typeof v === "number"),
    { a: 1 },
  );
  assert.equal(
    validBlock({ b: "x" }, () => false),
    undefined,
  );
});

test("SettingsModel resolves per language in VS Code's order", () => {
  const registry = new SettingsRegistry();
  registry.register({
    "editor.tabSize": { type: "integer", default: 4, description: "", minimum: 1 },
    "editor.formatOnSave": { type: "boolean", default: false, description: "" },
    "editor.vimMode": { type: "boolean", default: false, description: "", scope: "user" },
  });
  const model = new SettingsModel(registry);
  const changes: string[][] = [];
  model.onDidChange((keys) => changes.push([...keys]));
  model.setText(
    "user",
    `{
      "editor.tabSize": 3,
      "[python]": { "editor.tabSize": 8, "editor.formatOnSave": true },
      "[go]": { "editor.tabSize": 0 }
    }`,
  );
  assert.equal(model.get("editor.tabSize"), 3);
  assert.equal(model.getForLanguage("editor.tabSize", "python"), 8);
  assert.equal(model.getForLanguage("editor.tabSize", "rust"), 3);
  assert.equal(model.getForLanguage("editor.tabSize", null), 3);
  // An invalid block value falls back to the plain value (and is a problem).
  assert.equal(model.getForLanguage("editor.tabSize", "go"), 3);
  assert.ok(model.problems().some((p) => p.key === "[go].editor.tabSize"));
  // The workspace's plain value beats the user's, but a user block beats both (VS Code).
  model.setText("workspace", `{ "editor.tabSize": 6 }`);
  assert.equal(model.getForLanguage("editor.tabSize", "rust"), 6);
  assert.deepEqual(model.resolveForLanguage("editor.tabSize", "python"), {
    value: 8,
    source: "user",
    language: true,
  });
  model.setText("workspace", `{ "[python]": { "editor.tabSize": 5 }, "[python][go]": {} }`);
  assert.equal(model.getForLanguage("editor.tabSize", "python"), 5);
  assert.equal(model.inspectForLanguage("editor.tabSize", "workspace", "python"), 5);
  assert.deepEqual(model.overriddenLanguages(), ["go", "python"]);
  // A block change reports the key inside it.
  changes.length = 0;
  model.setText("workspace", `{ "[python]": { "editor.tabSize": 7 } }`);
  assert.ok(changes.some((c) => c.includes("editor.tabSize")));
  // The other folder's (.vscode) blocks sit between the workspace's and the user's.
  model.setText("workspace", "");
  model.setVscode({ "[python]": { "editor.tabSize": 2 } });
  assert.equal(model.getForLanguage("editor.tabSize", "python"), 2);
  // A user-only setting in a workspace block is ignored.
  model.setText("workspace", `{ "[python]": { "editor.vimMode": true } }`);
  assert.equal(model.getForLanguage("editor.vimMode", "python"), false);
});

test("setJsoncNestedProperty edits one setting of a language block", () => {
  const text = `{
  // mine
  "editor.tabSize": 2,
  "[python]": {
    // keep
    "editor.tabSize": 4
  }
}
`;
  const changed = setJsoncNestedProperty(text, "[python]", "editor.tabSize", 8);
  assert.ok(changed.includes("// keep") && changed.includes("// mine"));
  assert.deepEqual(parse(changed)["[python]"], { "editor.tabSize": 8 });
  const added = setJsoncNestedProperty(text, "[python]", "editor.formatOnSave", true);
  assert.deepEqual(parse(added)["[python]"], {
    "editor.tabSize": 4,
    "editor.formatOnSave": true,
  });
  assert.ok(added.includes('\n    "editor.formatOnSave": true'));
  // The block goes when its last setting does.
  const removed = setJsoncNestedProperty(text, "[python]", "editor.tabSize", undefined);
  assert.deepEqual(parse(removed), { "editor.tabSize": 2 });
  assert.equal(setJsoncNestedProperty(text, "[python]", "missing", undefined), text);
  // A new block.
  assert.deepEqual(parse(setJsoncNestedProperty(text, "[go]", "editor.tabSize", 8))["[go]"], {
    "editor.tabSize": 8,
  });
  assert.deepEqual(parse(setJsoncNestedProperty("", "[go]", "a", 1)), { "[go]": { a: 1 } });
  const empty = setJsoncNestedProperty(`{ "[go]": {} }`, "[go]", "a", 1);
  assert.deepEqual(parse(empty), { "[go]": { a: 1 } });
  // Removing one of two keeps the other and stays valid JSON.
  const two = setJsoncNestedProperty(added, "[python]", "editor.tabSize", undefined);
  assert.deepEqual(parse(two)["[python]"], { "editor.formatOnSave": true });
});

test("VS Code language blocks are kept on import, translated", () => {
  const known = new Set(["editor.tabSize", "editor.wordWrap"]);
  const r = translateVscodeSettings(
    {
      "[python]": { "editor.tabSize": 4, "python.formatting.provider": "black" },
      "[markdown]": { "editor.wordWrap": "bounded" },
      "[go]": { "go.lintOnSave": true },
    },
    (k) => known.has(k),
  );
  assert.deepEqual(r.values, {
    "[python]": { "editor.tabSize": 4 },
    "[markdown]": { "editor.wordWrap": "on" },
  });
  assert.deepEqual(r.skipped, ["[python] python.formatting.provider", "[go] go.lintOnSave"]);
});
