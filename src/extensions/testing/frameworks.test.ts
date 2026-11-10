import assert from "node:assert/strict";
import { test } from "node:test";
import { resolverFor } from "./coverage";
import {
  discoverUnittest,
  mochaSpec,
  parseMochaJson,
  parsePlaywrightJson,
  parseUnittest,
  parseUnittestList,
  specGlobs,
  UNITTEST_LIST_SCRIPT,
  unittestListCommand,
} from "./frameworks";
import { discoverJs, type TestCase, testId } from "./model";

test("mochaSpec: .mocharc.json(c), .yml, package.json", () => {
  assert.deepEqual(mochaSpec('{ "spec": "test/**/*.spec.js" }', "json"), ["test/**/*.spec.js"]);
  assert.deepEqual(
    mochaSpec('{\n  // where\n  "spec": ["a/*.js", "b"], "timeout": 5000,\n}', "json"),
    ["a/*.js", "b"],
  );
  assert.deepEqual(mochaSpec("spec: 'test/**/*.mjs'\nrecursive: true\n", "yaml"), [
    "test/**/*.mjs",
  ]);
  assert.deepEqual(mochaSpec("ui: bdd\nspec:\n  - one/*.js\n  - two\nreporter: x\n", "yaml"), [
    "one/*.js",
    "two",
  ]);
  assert.deepEqual(mochaSpec("spec: [a.js, 'b.js']\n", "yaml"), ["a.js", "b.js"]);
  assert.deepEqual(mochaSpec('{"name":"x","mocha":{"spec":"t/*.js"}}', "package"), ["t/*.js"]);
  assert.deepEqual(mochaSpec('{"devDependencies":{"mocha":"10"}}', "package"), []);
  assert.deepEqual(mochaSpec("not json", "json"), []);
});

test("specGlobs: folders and globs, under the project", () => {
  assert.deepEqual(specGlobs(["./test", "spec/**/*.js", "unit/a.test.ts"], "pkg"), [
    "pkg/test/*.{js,cjs,mjs,ts}",
    "pkg/spec/**/*.js",
    "pkg/unit/a.test.ts",
  ]);
  assert.deepEqual(specGlobs(["test/*.{js,cjs,mjs}"], ""), ["test/*.{js,cjs,mjs}"]);
});

const MOCHA_JSON = `some console output
{
  "stats": { "suites": 1, "tests": 3, "passes": 1, "pending": 1, "failures": 1, "duration": 5 },
  "tests": [
    { "title": "adds", "fullTitle": "math adds", "file": "/w/test/math.js", "duration": 1, "err": {} },
    { "title": "fails", "fullTitle": "math fails", "file": "/w/test/math.js", "duration": 0,
      "err": { "stack": "AssertionError [ERR_ASSERTION]: 1 == 2\\n    at Context.<anonymous> (test/math.js:6:12)",
               "message": "1 == 2", "name": "AssertionError", "actual": 1, "expected": 2, "operator": "==" } },
    { "title": "later", "fullTitle": "math later", "file": "/w/test/math.js", "err": {} }
  ],
  "pending": [{ "title": "later", "fullTitle": "math later", "file": "/w/test/math.js", "err": {} }],
  "failures": [
    { "title": "fails", "fullTitle": "math fails", "file": "/w/test/math.js", "err": { "message": "1 == 2" } },
    { "title": "\\"before all\\" hook", "fullTitle": "other \\"before all\\" hook", "file": "/w/test/other.js",
      "err": { "message": "setup broke", "stack": "Error: setup broke" } }
  ],
  "passes": []
}`;

test("parseMochaJson: statuses, known tests by full title, values, hooks", () => {
  const text =
    "describe('math', () => {\n  it('adds', () => {});\n  it('fails', () => {});\n  it.skip('later', () => {});\n});\n";
  const known = discoverJs(text, "test/math.js", "mocha");
  const map = new Map<string, TestCase>(known.map((t) => [`${t.file}|${t.path.join(" ")}`, t]));
  const run = parseMochaJson(MOCHA_JSON, resolverFor("/w", "/w"), map);
  const id = (name: string) => testId("mocha", "test/math.js", ["math", name]);
  assert.equal(run.results.get(id("adds"))?.status, "passed");
  assert.equal(run.results.get(id("adds"))?.durationMs, 1);
  const failed = run.results.get(id("fails"));
  assert.equal(failed?.status, "failed");
  assert.match(failed?.message ?? "", /1 == 2/);
  assert.equal(failed?.expected, "2");
  assert.equal(failed?.actual, "1");
  assert.equal(run.results.get(id("later"))?.status, "skipped");
  // A hook that failed: listed under its file as its own entry.
  const hook = run.extra.find((t) => t.file === "test/other.js");
  assert.ok(hook);
  assert.equal(run.results.get(hook.id)?.status, "failed");
  assert.equal(run.summary, "1 passed, 1 failed, 1 skipped");
  assert.equal(parseMochaJson("no json", resolverFor("/w", "/w"), new Map()).results.size, 0);
});

const PLAYWRIGHT_JSON = JSON.stringify({
  config: {
    rootDir: "/w/e2e",
    projects: [{ name: "chromium" }, { name: "firefox" }],
  },
  suites: [
    {
      title: "home.spec.ts",
      file: "home.spec.ts",
      line: 0,
      specs: [
        {
          title: "has title",
          file: "home.spec.ts",
          line: 3,
          tests: [
            {
              projectName: "chromium",
              expectedStatus: "passed",
              status: "expected",
              results: [{ status: "passed", duration: 812, errors: [] }],
            },
            {
              projectName: "firefox",
              expectedStatus: "passed",
              status: "unexpected",
              results: [
                {
                  status: "failed",
                  duration: 1500,
                  errors: [
                    {
                      message:
                        'Error: expect(page).toHaveTitle(expected)\n\nExpected pattern: /Playwright/\nReceived string:  "Example"',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      suites: [
        {
          title: "menu",
          file: "home.spec.ts",
          specs: [
            {
              title: "opens",
              file: "home.spec.ts",
              line: 9,
              tests: [
                { projectName: "chromium", status: "skipped", results: [{ status: "skipped" }] },
              ],
            },
          ],
        },
      ],
    },
  ],
  stats: { expected: 1, unexpected: 1, skipped: 1, flaky: 0 },
});

test("parsePlaywrightJson: projects, nested describes, statuses, expected / received", () => {
  const run = parsePlaywrightJson(`Running 3 tests\n${PLAYWRIGHT_JSON}`, "/w", "/w/e2e");
  assert.deepEqual(run.projects, ["chromium", "firefox"]);
  assert.deepEqual(
    run.tests.map((t) => [t.file, t.path.join(" › "), t.line, t.runnerProject]),
    [
      ["e2e/home.spec.ts", "chromium › has title", 3, "chromium"],
      ["e2e/home.spec.ts", "firefox › has title", 3, "firefox"],
      ["e2e/home.spec.ts", "chromium › menu › opens", 9, "chromium"],
    ],
  );
  const [ok, bad, skipped] = run.tests.map((t) => run.results.get(t.id));
  assert.equal(ok?.status, "passed");
  assert.equal(ok?.durationMs, 812);
  assert.equal(bad?.status, "failed");
  assert.equal(bad?.expected, "/Playwright/");
  assert.equal(bad?.actual, "Example");
  assert.equal(skipped?.status, "skipped");
  assert.equal(run.summary, "1 passed, 1 failed, 1 skipped");
});

test("parsePlaywrightJson: --list output (no results), one project: no project in the path", () => {
  const list = JSON.stringify({
    config: { rootDir: "/w/tests", projects: [{ name: "chromium" }] },
    suites: [
      {
        title: "a.spec.ts",
        file: "a.spec.ts",
        specs: [
          { title: "works", file: "a.spec.ts", line: 4, tests: [{ projectName: "chromium" }] },
        ],
      },
    ],
  });
  const run = parsePlaywrightJson(list, "/w", "/w");
  assert.deepEqual(
    run.tests.map((t) => [t.file, t.path, t.runnerProject]),
    [["tests/a.spec.ts", ["works"], "chromium"]],
  );
  assert.equal(run.results.size, 0);
});

test("unittest listing: the script's lines, decorated methods, import errors", () => {
  assert.match(UNITTEST_LIST_SCRIPT, /TestLoader\(\)\.discover/);
  const cmd = unittestListCommand(true);
  assert.match(cmd, /^python -c "import base64;exec\(base64\.b64decode\('[A-Za-z0-9+/=]+'\)\)"$/);
  assert.match(unittestListCommand(false), /^python3 -c/);
  const out = [
    '@@TEST {"id": "pkg.test_math.MathTests.test_add", "file": "pkg/test_math.py", "line": 4}',
    '@@TEST {"id": "pkg.test_math.MathTests.test_skip", "file": "../../usr/lib/python3/unittest/case.py", "line": 11}',
    '@@TEST {"id": "unittest.loader._FailedTest.broken", "error": "No module named x"}',
    "noise",
  ].join("\n");
  const listed = parseUnittestList(out, "py");
  assert.deepEqual(
    listed.tests.map((t) => [t.id, t.line]),
    [
      [testId("unittest", "py/pkg/test_math.py", ["MathTests", "test_add"]), 4],
      [testId("unittest", "py/pkg/test_math.py", ["MathTests", "test_skip"]), 1],
    ],
  );
  assert.deepEqual(listed.errors, [
    { id: "unittest.loader._FailedTest.broken", message: "No module named x" },
  ]);
});

test("discoverUnittest: TestCase subclasses only", () => {
  const text =
    "import unittest\n\nclass MathTests(unittest.TestCase):\n    def setUp(self):\n        pass\n\n    def test_add(self):\n        pass\n\nclass Helper:\n    def test_not(self):\n        pass\n\nclass More(TestCase):\n    async def test_async(self):\n        pass\n";
  assert.deepEqual(
    discoverUnittest(text, "test_m.py").map((t) => [t.path.join("."), t.line]),
    [
      ["MathTests.test_add", 7],
      ["More.test_async", 15],
    ],
  );
});

// What `python3 -m unittest -v` printed (Python 3.13).
const UNITTEST_OUT = `test_add (pkg.test_math.MathTests.test_add) ... ok
test_bad (pkg.test_math.MathTests.test_bad)
Doc line. ... FAIL
test_err (pkg.test_math.MathTests.test_err) ... ERROR
test_skip (pkg.test_math.MathTests.test_skip) ... skipped 'later'
test_old (pkg.test_old.OldTests) ... ok

======================================================================
ERROR: test_err (pkg.test_math.MathTests.test_err)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/w/pkg/test_math.py", line 16, in test_err
    raise ValueError("boom")
ValueError: boom

======================================================================
FAIL: test_bad (pkg.test_math.MathTests.test_bad)
Doc line.
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/w/pkg/test_math.py", line 9, in test_bad
    self.assertEqual(1 + 1, 3)
AssertionError: 2 != 3

----------------------------------------------------------------------
Ran 5 tests in 0.001s

FAILED (failures=1, errors=1, skipped=1)
`;

test("parseUnittest: -v lines (docstrings, old Pythons), failure sections, values", () => {
  const known = new Map<string, TestCase>(
    discoverUnittest(
      "import unittest\nclass MathTests(unittest.TestCase):\n    def test_add(self): pass\n    def test_bad(self): pass\n    def test_err(self): pass\n    def test_skip(self): pass\n",
      "pkg/test_math.py",
    ).map((t) => [`pkg.test_math.${t.path.join(".")}`, t]),
  );
  const run = parseUnittest(UNITTEST_OUT, known);
  const id = (m: string) => testId("unittest", "pkg/test_math.py", ["MathTests", m]);
  assert.equal(run.results.get(id("test_add"))?.status, "passed");
  const bad = run.results.get(id("test_bad"));
  assert.equal(bad?.status, "failed");
  assert.match(bad?.message ?? "", /AssertionError: 2 != 3/);
  assert.doesNotMatch(bad?.message ?? "", /Ran 5 tests/);
  assert.equal(bad?.expected, "3");
  assert.equal(bad?.actual, "2");
  assert.match(run.results.get(id("test_err"))?.message ?? "", /ValueError: boom/);
  assert.equal(run.results.get(id("test_skip"))?.status, "skipped");
  // Not discovered (and printed the old way): added from its module.
  assert.deepEqual(
    run.extra.map((t) => [t.file, t.path]),
    [["pkg/test_old.py", ["OldTests", "test_old"]]],
  );
  assert.equal(run.summary, "5 ran, failed (failures=1, errors=1, skipped=1)");
});

test("parseUnittest: a module that didn't import is its file's failure", () => {
  const out = `pkg.test_broken (unittest.loader._FailedTest.pkg.test_broken) ... ERROR

======================================================================
ERROR: pkg.test_broken (unittest.loader._FailedTest.pkg.test_broken)
----------------------------------------------------------------------
ImportError: Failed to import test module: pkg.test_broken
ModuleNotFoundError: No module named 'nothere'

----------------------------------------------------------------------
Ran 1 test in 0.000s
`;
  const run = parseUnittest(out, new Map());
  const r = run.results.get(testId("unittest", "pkg/test_broken.py", []));
  assert.equal(r?.status, "failed");
  assert.match(r?.message ?? "", /No module named 'nothere'/);
  assert.equal(run.extra.length, 0);
});

test("unittest: a failure's traceback keeps its colors as the test's output", () => {
  const E = "\u001b";
  const out = [
    `test_a (test_m.T.test_a) ... FAIL`,
    "",
    "======================================================================",
    "FAIL: test_a (test_m.T.test_a)",
    "----------------------------------------------------------------------",
    `Traceback: ${E}[35mAssertionError${E}[0m: 1 != 2`,
    "",
    "----------------------------------------------------------------------",
    "Ran 1 test in 0.001s",
    "",
    "FAILED (failures=1)",
  ].join("\r\n");
  const r = parseUnittest(out, new Map()).results.get(
    testId("unittest", "test_m.py", ["T", "test_a"]),
  );
  assert.equal(r?.status, "failed");
  assert.equal(r?.message, "Traceback: AssertionError: 1 != 2");
  assert.equal(r?.output, `Traceback: ${E}[35mAssertionError${E}[0m: 1 != 2`);
});
