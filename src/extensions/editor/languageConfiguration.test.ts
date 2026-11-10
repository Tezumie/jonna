import assert from "node:assert/strict";
import { test } from "node:test";
import { toLanguageConfiguration, toRegExp } from "./languageConfiguration";

test("language-configuration.json → editor configuration (D200)", () => {
  const c = toLanguageConfiguration({
    comments: { lineComment: "--", blockComment: ["--[[", "]]"] },
    brackets: [["{", "}"], ["(", ")"], ["bad"]],
    autoClosingPairs: [["{", "}"], { open: '"', close: '"', notIn: ["string"] }, { open: 1 }],
    surroundingPairs: [["'", "'"]],
    folding: { markers: { start: "^\\s*--\\s*#region", end: "^\\s*--\\s*#endregion" } },
    wordPattern: { pattern: "[a-z_]+", flags: "i" },
    indentationRules: { increaseIndentPattern: "\\bdo\\b", decreaseIndentPattern: "^\\s*end\\b" },
  });
  assert.deepEqual(c.comments, { lineComment: "--", blockComment: ["--[[", "]]"] });
  assert.deepEqual(c.brackets, [
    ["{", "}"],
    ["(", ")"],
  ]);
  assert.deepEqual(c.autoClosingPairs, [
    { open: "{", close: "}" },
    { open: '"', close: '"', notIn: ["string"] },
  ]);
  assert.deepEqual(c.surroundingPairs, [{ open: "'", close: "'" }]);
  assert.ok(c.folding?.markers?.start.test("  -- #region x"));
  assert.ok(c.wordPattern?.global && c.wordPattern.ignoreCase);
  assert.ok(c.indentationRules?.decreaseIndentPattern.test("end"));
  // Bad patterns are left out, the rest stays.
  assert.equal(toRegExp("("), undefined);
  assert.deepEqual(toLanguageConfiguration({ wordPattern: "(", comments: { lineComment: "#" } }), {
    comments: { lineComment: "#" },
  });
  assert.deepEqual(toLanguageConfiguration(null), {});
});

test("D258: Enter rules, as files and code give them", () => {
  const c = toLanguageConfiguration({
    onEnterRules: [
      { beforeText: "^\\s*//.*$", action: { indent: "none", appendText: "// " } },
      { beforeText: { pattern: "\\{$" }, afterText: "^\\}", action: { indentAction: 2 } },
      { beforeText: "x", action: { indent: "sideways" } },
    ],
  });
  assert.equal(c.onEnterRules?.length, 2);
  assert.equal(c.onEnterRules?.[0]?.action.appendText, "// ");
  assert.equal(c.onEnterRules?.[0]?.action.indentAction, 0);
  assert.ok(c.onEnterRules?.[1]?.afterText?.test("}"));
  assert.equal(c.onEnterRules?.[1]?.action.indentAction, 2);
});
