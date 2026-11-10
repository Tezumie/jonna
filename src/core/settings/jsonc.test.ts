import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJsonc, parseJsoncOrThrow } from "./jsonc";

test("parses plain JSON identically to JSON.parse", () => {
  const samples = [
    '{"a":[1,2.5,-3e2,true,false,null],"b":{"c":"\\u00e9\\n\\"q\\""}}',
    "[]",
    '"x"',
    "0",
  ];
  for (const text of samples) assert.deepEqual(parseJsoncOrThrow(text), JSON.parse(text));
});

test("supports comments and trailing commas", () => {
  const text = `﻿// user settings
{
  /* block
     comment */
  "editor.fontSize": 14, // trailing comment
  "files.exclude": { "**/.git": true, },
  "list": [1, 2, 3,],
  "url": "http://example.com/*not-a-comment*/",
}`;
  assert.deepEqual(parseJsoncOrThrow(text), {
    "editor.fontSize": 14,
    "files.exclude": { "**/.git": true },
    list: [1, 2, 3],
    url: "http://example.com/*not-a-comment*/",
  });
});

test("reports errors with line and column", () => {
  const result = parseJsonc('{\n  "a": 1\n  "b": 2\n}');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.line, 3);
  assert.equal(result.error.column, 3);
  assert.match(result.error.message, /Expected "," or "}"/);
  for (const bad of [
    "",
    "{",
    "[1,,2]",
    '{"a" 1}',
    "/* open",
    '"unterminated',
    "01",
    "{} x",
    "[1] // ok\n,",
  ]) {
    assert.equal(parseJsonc(bad).ok, false, bad);
  }
  assert.throws(() => parseJsoncOrThrow("{,}", "settings.json"), /settings\.json:1:2/);
});

test("__proto__ keys are plain data", () => {
  const value = parseJsoncOrThrow('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.deepEqual(Object.keys(value), ["__proto__"]);
});
