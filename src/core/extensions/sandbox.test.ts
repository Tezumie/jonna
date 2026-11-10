import assert from "node:assert/strict";
import { test } from "node:test";
import { loadsModules } from "./sandbox";

test("sandbox: import calls are found, with comments in between too", () => {
  for (const code of [
    'import("https://x.test/a.js")',
    'await import ("https://x.test/a.js")',
    'import/**/("https://x.test/a.js")',
    'import /* a */ /* b */ ("u")',
    'import // line\n("u")',
    'import <!-- old comment\n("u")',
    'import\n--> old comment\n("u")',
    'f(...import("u"))',
    'x.import("u")',
  ])
    assert.equal(loadsModules(code), true, code);
});

test("sandbox: other uses of the word aren't refused", () => {
  for (const code of [
    'const label = "Import settings";',
    "importScripts",
    "function myimport(x) { return x; }",
    "$import(1); _import(2); reimport(3);",
    "// you can't import modules here",
  ])
    assert.equal(loadsModules(code), false, code);
});
