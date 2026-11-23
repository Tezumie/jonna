import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJsonc } from "./jsonc";
import {
  appendJsoncArrayItem,
  assertEditableJsoncArray,
  assertEditableJsoncObject,
  JsoncEditError,
  setJsoncArrayItem,
  setJsoncNestedProperty,
  setJsoncProperty,
} from "./jsoncEdit";

// D203: a settings write never replaces a file the user is in the middle of fixing.
test("setJsoncProperty refuses a document without a readable top-level object", () => {
  for (const broken of ['{ "a": 1, ', '"a": 1', "nonsense", '{ "a": [1, 2 }'])
    assert.throws(() => setJsoncProperty(broken, "b", true), JsoncEditError, broken);
  assert.throws(() => setJsoncNestedProperty('{ "a": 1, ', "[go]", "x", 1), JsoncEditError);
  // Empty or comment-only text still gets a fresh object (comments kept).
  const fresh = setJsoncProperty("// mine\n", "a", 1);
  assert.match(fresh, /^\/\/ mine\n\{/);
  const parsed = parseJsonc(fresh);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, { a: 1 });
  assert.equal(setJsoncProperty("  ", "a", undefined), "  ");
});

test("assertEditableJsoncObject: only empty text or an object passes", () => {
  assertEditableJsoncObject("", "settings.json");
  assertEditableJsoncObject("  // only a comment\n", "settings.json");
  assertEditableJsoncObject('{ "a": 1, // ok\n }', "settings.json");
  assert.throws(
    () => assertEditableJsoncObject('{\n  "a": 1\n  "b": 2\n}', "Your user settings.json"),
    /Your user settings\.json has a syntax error \(line 3\)/,
  );
  assert.throws(() => assertEditableJsoncObject("[1]", "x"), /must contain an object/);
  assert.throws(() => assertEditableJsoncObject("3", "x"), JsoncEditError);
});

// An entry added to keybindings.json never replaces a file that is being edited.
test("appendJsoncArrayItem refuses text that isn't a closed top-level array", () => {
  const rule = { key: "ctrl+k", command: "x" };
  for (const broken of [
    '[\n  { "key": "a", "command": "b" },\n', // the closing ] not typed yet
    "{}",
    '{ "list": [1] }',
    '"text"',
    "[1] 2",
    "[1]]",
  ])
    assert.throws(() => appendJsoncArrayItem(broken, rule), JsoncEditError, broken);
  // Empty or comment-only text still becomes a new array (comments kept above it).
  assert.deepEqual(JSON.parse(appendJsoncArrayItem("  \n", rule)), [rule]);
  const fresh = appendJsoncArrayItem("// my keys\n", rule);
  assert.match(fresh, /^\/\/ my keys\n\[/);
  const parsed = parseJsonc(fresh);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, [rule]);
  // A nested array's end isn't the file's.
  const nested = parseJsonc(appendJsoncArrayItem('[{ "args": [1, 2] }]', rule));
  assert.ok(nested.ok);
  assert.deepEqual(nested.value, [{ args: [1, 2] }, rule]);
});

test("assertEditableJsoncArray: only empty text or an array passes", () => {
  assertEditableJsoncArray("", "keybindings.json");
  assertEditableJsoncArray("// only a comment\n", "keybindings.json");
  assertEditableJsoncArray("[ { }, // ok\n ]", "keybindings.json");
  assert.throws(
    () => assertEditableJsoncArray("[\n  1\n  2\n]", "keybindings.json"),
    /keybindings\.json has a syntax error \(line 3\)/,
  );
  assert.throws(() => assertEditableJsoncArray("{}", "x"), /must contain an array/);
});

test("removing the last property keeps the comments around the one before it", () => {
  const text = '{\n  "a": 1, // keep me\n  // note\n  "b": 2\n}\n';
  assert.equal(setJsoncProperty(text, "b", undefined), '{\n  "a": 1 // keep me\n  // note\n}\n');
  // A block comment between the comma and the removed property stays too.
  assert.equal(
    setJsoncProperty('{ "a": 1, /* why */ "b": 2 }', "b", undefined),
    '{ "a": 1 /* why */  }',
  );
  // In a language block as well.
  const nested = '{\n  "[go]": {\n    "x": 1, // one\n    "y": 2\n  }\n}\n';
  assert.equal(
    setJsoncNestedProperty(nested, "[go]", "y", undefined),
    '{\n  "[go]": {\n    "x": 1 // one\n  }\n}\n',
  );
});

test("edits keep a CRLF file's line endings", () => {
  const text = '{\r\n  "a": 1,\r\n  "b": 2,\r\n  "c": 3\r\n}\r\n';
  const noBareLf = (s: string) => assert.ok(!/(^|[^\r])\n/.test(s), JSON.stringify(s));
  // A removal takes the whole line, its line break included (no empty line left).
  assert.equal(setJsoncProperty(text, "b", undefined), '{\r\n  "a": 1,\r\n  "c": 3\r\n}\r\n');
  assert.equal(setJsoncProperty(text, "c", undefined), '{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n');
  const added = setJsoncProperty(text, "d", { deep: [1] });
  noBareLf(added);
  assert.deepEqual((parseJsonc(added) as { value: unknown }).value, {
    a: 1,
    b: 2,
    c: 3,
    d: { deep: [1] },
  });
  noBareLf(setJsoncProperty(text, "a", { x: 1 }));
  noBareLf(setJsoncProperty("// mine\r\n", "a", 1));
  const keys = '[\r\n  { "key": "a" },\r\n  { "key": "b" }\r\n]\r\n';
  noBareLf(appendJsoncArrayItem(keys, { key: "c" }));
  assert.equal(setJsoncArrayItem(keys, 0, undefined), '[\r\n  { "key": "b" }\r\n]\r\n');
  noBareLf(setJsoncArrayItem(keys, 1, { key: "z", command: "w" }));
  // An LF file stays LF.
  assert.ok(!setJsoncProperty('{\n  "a": 1\n}\n', "b", 2).includes("\r"));
});
