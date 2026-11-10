import assert from "node:assert/strict";
import { test } from "node:test";
import type { SettingInfo } from "../../core/settings/schema";
import {
  filterTitle,
  hasFilter,
  isLanguageSetting,
  matchesSetting,
  parseSettingsQuery,
} from "./searchQuery";

const setting = (key: string, extra: Partial<SettingInfo> = {}): SettingInfo => ({
  key,
  type: "boolean",
  default: false,
  description: `About ${key}`,
  category: key.split(".")[0] === "agent" ? "Agent" : "Editor",
  title: key,
  ...extra,
});

const all = [
  setting("editor.fontSize", { extension: "builtin.editor" }),
  setting("editor.tabSize", { extension: "builtin.editor", tags: ["Accessibility"] }),
  setting("terminal.bell", { category: "Terminal", extension: "builtin.terminal" }),
  setting("markdown.preview.breaks", { category: "Markdown", extension: "builtin.editor" }),
  setting("agent.autoApprove", { extension: "builtin.agent" }),
];
const keys = (query: string, modified: string[] = []) => {
  const q = parseSettingsQuery(query);
  return all.filter((s) => matchesSetting(s, q, (k) => modified.includes(k))).map((s) => s.key);
};

test("settings search: filters and words", () => {
  assert.deepEqual(parseSettingsQuery("  @modified Font "), {
    text: "font",
    modified: true,
    ids: [],
    extensions: [],
    tags: [],
    languages: [],
  });
  assert.deepEqual(keys("@id:editor.fontSize,terminal.bell"), ["editor.fontSize", "terminal.bell"]);
  assert.deepEqual(keys("@ext:builtin.terminal"), ["terminal.bell"]);
  assert.deepEqual(keys("@ext:editor size"), ["editor.fontSize", "editor.tabSize"]);
  assert.deepEqual(keys("@tag:accessibility"), ["editor.tabSize"]);
  assert.deepEqual(keys("@tag:ai"), ["agent.autoApprove"]);
  // The settings a language can set for itself (D201), not the language's own preview settings.
  assert.deepEqual(keys("@lang:markdown"), ["editor.fontSize", "editor.tabSize"]);
  assert.ok(isLanguageSetting(setting("files.trimTrailingWhitespace", { category: "Files" })));
  assert.ok(!isLanguageSetting(setting("files.exclude", { category: "Files" })));
  assert.ok(!isLanguageSetting(setting("editor.vimMode")));
  assert.ok(!isLanguageSetting(setting("editor.inlineEdit.enabled")));
  assert.deepEqual(keys("@modified", ["terminal.bell"]), ["terminal.bell"]);
  assert.deepEqual(keys("@modified @ext:builtin.editor", ["terminal.bell"]), []);
  assert.deepEqual(keys("bell"), ["terminal.bell"]);
});

test("settings search: titles", () => {
  assert.equal(filterTitle(parseSettingsQuery("@modified"), 3), "Changed settings");
  assert.equal(filterTitle(parseSettingsQuery("@tag:ai"), 1), "1 setting found");
  assert.match(filterTitle(parseSettingsQuery("@lang:python"), 2), /for python/);
  assert.equal(hasFilter(parseSettingsQuery("font")), false);
  assert.equal(hasFilter(parseSettingsQuery("@id:x")), true);
});
