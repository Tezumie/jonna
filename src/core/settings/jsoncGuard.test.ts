import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJsonc } from "./jsonc";
import {
  assertEditableJsoncObject,
  JsoncEditError,
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
