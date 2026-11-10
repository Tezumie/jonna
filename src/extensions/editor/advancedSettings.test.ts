import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ADVANCED_EDITOR_SETTINGS, advancedEngineOptions } from "./advancedSettings";

test("advanced editor settings nest by path and keep the IDE's line height at 0", () => {
  const values: Record<string, unknown> = {
    "editor.scrollbar.verticalScrollbarSize": 20,
    "editor.cursorStyle": "block",
  };
  const o = advancedEngineOptions((k) => values[k]);
  assert.deepEqual((o.scrollbar as Record<string, unknown>).verticalScrollbarSize, 20);
  assert.equal((o.scrollbar as Record<string, unknown>).horizontalScrollbarSize, 12);
  assert.equal(o.cursorStyle, "block");
  assert.equal("lineHeight" in o, false);
  assert.equal(
    advancedEngineOptions((k) => (k === "editor.lineHeight" ? 22 : undefined)).lineHeight,
    22,
  );
});

test("every advanced setting is declared in the manifest with the same default", () => {
  const manifest = JSON.parse(readFileSync("src/extensions/editor/extension.json", "utf8")) as {
    contributes: { settings: Record<string, { default?: unknown }> };
  };
  const declared = manifest.contributes.settings;
  for (const [key, , fallback] of ADVANCED_EDITOR_SETTINGS) {
    assert.ok(declared[key], `${key} is missing from extension.json`);
    assert.deepEqual(declared[key]?.default, fallback, key);
  }
});
