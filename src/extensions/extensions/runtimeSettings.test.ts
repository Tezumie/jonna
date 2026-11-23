import assert from "node:assert/strict";
import { test } from "node:test";
import { watchedSettingKeys } from "./runtimeSettings";

const KNOWN = [
  "editor.tabSize",
  "files.exclude",
  "workbench.colorTheme",
  "markdown.preview.breaks",
  "git.path",
  "agent.model",
  "editor.apiKey",
];

test("a VS Code package hears every setting it may read; others what they name", () => {
  // VS Code's onDidChangeConfiguration fires for editor.* / files.* / workbench.* too.
  assert.deepEqual(watchedSettingKeys(["acme.greeting"], [], KNOWN, true).sort(), [
    "acme.greeting",
    "editor.tabSize",
    "files.exclude",
    "workbench.colorTheme",
  ]);
  assert.deepEqual(watchedSettingKeys(["acme.greeting"], ["markdown.*"], KNOWN, true).sort(), [
    "acme.greeting",
    "editor.tabSize",
    "files.exclude",
    "markdown.preview.breaks",
    "workbench.colorTheme",
  ]);
  // An extension of the IDE's own format: its own, and what `readsSettings` names (D202).
  assert.deepEqual(watchedSettingKeys(["acme.greeting"], [], KNOWN, false), ["acme.greeting"]);
  assert.deepEqual(
    watchedSettingKeys(["acme.greeting"], ["markdown.*", "git.path"], KNOWN, false).sort(),
    ["acme.greeting", "git.path", "markdown.preview.breaks"],
  );
});
