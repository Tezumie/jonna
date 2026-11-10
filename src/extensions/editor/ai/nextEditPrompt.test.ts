import assert from "node:assert/strict";
import { test } from "node:test";
import { nextEditPrompt, parseNextEdit, recentChange } from "./nextEditPrompt";

const before = "function greet(name) {\n  return 'hi ' + name;\n}\ngreet(name);\n";
const after = "function greet(person) {\n  return 'hi ' + name;\n}\ngreet(name);\n";

test("the prompt shows numbered lines and the change just made", () => {
  const p = nextEditPrompt({
    path: "a.js",
    languageId: "javascript",
    text: after,
    before,
    cursorLine: 1,
  });
  assert.match(p, /1\| function greet\(person\) \{/);
  assert.match(p, /-function greet\(name\) \{\n\+function greet\(person\) \{/);
  assert.equal(recentChange("a\nb", "a\nb"), "@@ line 3 @@");
});

test("replies become edits; NONE, no-ops and far lines don't", () => {
  assert.deepEqual(parseNextEdit("<<<LINES 2-2\n  return 'hi ' + person;\n>>>", after, 1), {
    startLine: 2,
    endLine: 2,
    text: "  return 'hi ' + person;",
  });
  assert.deepEqual(parseNextEdit("<<<LINES 2-2\n2| x\n>>>", after, 1)?.text, "x");
  assert.equal(parseNextEdit("NONE", after, 1), null);
  assert.equal(
    parseNextEdit("<<<LINES 2-2\n  return x >>> 0;\n>>>", after, 1)?.text,
    "  return x >>> 0;",
  );
  assert.equal(parseNextEdit("<<<LINES 2-2\n  return 'hi ' + name;\n>>>", after, 1), null);
  assert.equal(parseNextEdit("<<<LINES 90-91\nx\n>>>", after, 1), null);
});
