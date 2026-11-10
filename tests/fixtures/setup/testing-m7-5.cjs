// Writes the projects tests/scripts/testing-m7-5.jsonc uses (D204), in the sample copy: a node:test
// project for coverage, expected / actual and debugging; a Mocha project whose `mocha` is a fake
// that prints the JSON reporter's output (no network needed); a unittest package.
const fs = require("node:fs");
const path = require("node:path");
const w = (p, t, m) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, t);
  if (m) fs.chmodSync(p, m);
};

// node:test, its own project (cov/package.json): lib.mjs lines 3-4 and 7-9 never run.
w("cov/package.json", '{ "name": "cov", "private": true }\n');
w(
  "cov/lib.mjs",
  [
    "export function add(a, b) {",
    "  if (a < 0) {",
    "    return -1;",
    "  }",
    "  return a + b;",
    "}",
    "export function unused() {",
    "  return 1;",
    "}",
    "",
  ].join("\n"),
);
w(
  "cov/lib.test.mjs",
  [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './lib.mjs';",
    "",
    "test('adds', () => {",
    "  assert.equal(add(1, 2), 3);",
    "});",
    "",
    "test('greets', () => {",
    "  assert.equal('hello world', 'hello there');",
    "});",
    "",
  ].join("\n"),
);

// Mocha: .mocharc.json's spec, and a fake mocha that prints a JSON report (filtered by --grep).
w(
  "moch/package.json",
  '{ "name": "moch", "private": true, "devDependencies": { "mocha": "10.0.0" } }\n',
);
w("moch/.mocharc.json", '{ "spec": "spec/*.js" }\n');
w(
  "moch/spec/math.js",
  "const assert = require('assert');\n\ndescribe('math', () => {\n  it('adds', () => {\n    assert.equal(1 + 1, 2);\n  });\n  it('fails', () => {\n    assert.equal(1 + 1, 3);\n  });\n});\n",
);
const fakeMocha = `#!/usr/bin/env node
// A stand-in for Mocha's JSON reporter (the test machine has no network to install Mocha).
const path = require("node:path");
const args = process.argv.slice(2);
const g = args.indexOf("--grep");
const grep = g >= 0 ? new RegExp(args[g + 1]) : null;
const file = path.resolve("spec/math.js");
const all = [
  { title: "adds", fullTitle: "math adds", file, duration: 1, err: {} },
  {
    title: "fails",
    fullTitle: "math fails",
    file,
    duration: 2,
    err: { message: "2 == 3", stack: "AssertionError [ERR_ASSERTION]: 2 == 3\\n    at Context.<anonymous> (spec/math.js:8:12)", actual: 2, expected: 3, operator: "==" },
  },
];
const tests = all.filter((t) => !grep || grep.test(t.fullTitle));
const failures = tests.filter((t) => t.err.message);
const passes = tests.filter((t) => !t.err.message);
console.log("fake mocha", args.join(" "));
console.log(JSON.stringify({ stats: { suites: 1, tests: tests.length, passes: passes.length, pending: 0, failures: failures.length }, tests, pending: [], failures, passes }, null, 2));
process.exitCode = failures.length ? 1 : 0;
`;
w(
  "moch/node_modules/mocha/package.json",
  '{ "name": "mocha", "version": "10.0.0", "bin": { "mocha": "bin/mocha.js", "_mocha": "bin/_mocha" } }\n',
);
w("moch/node_modules/mocha/bin/mocha.js", fakeMocha, 0o755);
w("moch/node_modules/mocha/bin/_mocha", fakeMocha, 0o755);
w("moch/node_modules/.bin/mocha", fakeMocha, 0o755);
w("moch/node_modules/.bin/mocha.cmd", '@node "%~dp0\\..\\mocha\\bin\\mocha.js" %*\r\n');

// unittest: a package (discovery needs __init__.py), no pytest set up.
w("ut/__init__.py", "");
w(
  "ut/test_calc.py",
  "import unittest\n\n\nclass CalcTests(unittest.TestCase):\n    def test_double(self):\n        self.assertEqual(2 * 2, 4)\n\n    def test_wrong(self):\n        self.assertEqual(2 * 3, 5)\n",
);
console.log("testing fixtures written");
