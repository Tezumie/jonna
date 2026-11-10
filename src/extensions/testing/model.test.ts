import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coverageReport,
  discoverGo,
  discoverJs,
  discoverPython,
  discoverRust,
  jsFramework,
  parseCargo,
  parseGoJson,
  parseJestJson,
  parsePytest,
  parseTap,
  plainOutput,
  quoteArg,
  runCommand,
  rustModulePath,
  testAt,
  testId,
  testRunEnv,
  unittestModule,
} from "./model";

test("JavaScript tests nest in their describe blocks", () => {
  const src = [
    'import { describe, it, expect } from "vitest";',
    "// it('commented out', () => {})",
    'describe("math", () => {',
    "  it('adds', () => {",
    '    expect("it(not a test)").toBe(1);',
    "  });",
    "  describe.skip(`nested ${'x'}`, () => {",
    '    test.each([1, 2])("twice %s", () => {});',
    "  });",
    "});",
    'test("top level", async () => {});',
    "/* test('in a block comment') */",
  ].join("\n");
  const tests = discoverJs(src, "src/a.test.ts", "vitest");
  assert.deepEqual(
    tests.map((t) => [t.path.join(" > "), t.line]),
    [
      ["math > adds", 4],
      ["math > nested ${'x'} > twice %s", 8],
      ["top level", 11],
    ],
  );
  assert.equal(tests[0]?.id, testId("vitest", "src/a.test.ts", ["math", "adds"]));
});

test("pytest functions and class methods", () => {
  const src = [
    "import pytest",
    "def helper():",
    "    def test_inner(): pass",
    "def test_one():",
    "    assert 1",
    "class TestThing:",
    "    def test_a(self):",
    "        pass",
    "    async def test_b(self):",
    "        pass",
    "class Other:",
    "    def test_not(self): pass",
    "def test_two(): pass",
  ].join("\n");
  assert.deepEqual(
    discoverPython(src, "tests/test_x.py").map((t) => [t.path.join("::"), t.line]),
    [
      ["test_one", 4],
      ["TestThing::test_a", 7],
      ["TestThing::test_b", 9],
      ["test_two", 13],
    ],
  );
});

test("Rust tests with their module path", () => {
  assert.deepEqual(rustModulePath("src/lib.rs"), []);
  assert.deepEqual(rustModulePath("src/git/mod.rs"), ["git"]);
  assert.deepEqual(rustModulePath("crates/a/src/git/ops.rs"), ["git", "ops"]);
  const src = [
    "fn real() {}",
    "#[cfg(test)]",
    "mod tests {",
    "    use super::*;",
    "    #[test]",
    "    fn adds() { assert_eq!(1, 1); }",
    "    #[tokio::test]",
    "    async fn waits() {}",
    "}",
    "#[test]",
    "fn outside() {}",
  ].join("\n");
  assert.deepEqual(
    discoverRust(src, "src/git/ops.rs").map((t) => t.path.join("::")),
    ["git::ops::tests::adds", "git::ops::tests::waits", "git::ops::outside"],
  );
});

test("Go tests", () => {
  const tests = discoverGo(
    "package x\nfunc TestAdd(t *testing.T) {}\nfunc helper() {}\nfunc TestSub( t *testing.T ) {}",
    "pkg/x_test.go",
  );
  assert.deepEqual(
    tests.map((t) => [t.path[0], t.line]),
    [
      ["TestAdd", 2],
      ["TestSub", 4],
    ],
  );
});

test("the JavaScript framework from package.json or the file", () => {
  assert.equal(jsFramework('{"devDependencies":{"vitest":"1"}}', ""), "vitest");
  assert.equal(jsFramework('{"devDependencies":{"jest":"29"}}', ""), "jest");
  assert.equal(jsFramework("{}", 'import { test } from "node:test";'), "node");
  assert.equal(jsFramework(null, ""), null);
});

test("commands quote names safely", () => {
  assert.equal(quoteArg("it's", false), "'it'\\''s'");
  assert.equal(quoteArg("it's", true), "'it''s'");
  // PowerShell ends a string at ’ too: a test name can't break out of its quotes.
  assert.equal(quoteArg("it’s; calc", true), "'it’’s; calc'");
  const t = {
    id: "x",
    framework: "vitest" as const,
    file: "src/a b.test.ts",
    path: ["math", "adds (1+1)"],
    line: 3,
  };
  assert.equal(
    runCommand("vitest", { file: t.file, test: t }, false),
    "npx vitest run --reporter=json 'src/a b.test.ts' -t '^math adds \\(1\\+1\\)$'",
  );
  assert.equal(runCommand("jest", {}, false), "npx jest --json --testLocationInResults");
  assert.equal(
    runCommand(
      "pytest",
      { test: { ...t, framework: "pytest", file: "t/test_x.py", path: ["TestA", "test_b"] } },
      true,
    ),
    "python -m pytest -rA --color=yes 't/test_x.py::TestA::test_b'",
  );
  assert.equal(
    runCommand(
      "cargo",
      { test: { ...t, framework: "cargo", path: ["git", "tests", "adds"] } },
      false,
    ),
    "cargo test 'git::tests::adds' -- --exact",
  );
  assert.equal(runCommand("cargo", { file: "src/git/ops.rs" }, false), "cargo test 'git::ops::'");
  assert.equal(runCommand("cargo", { file: "tests/flow.rs" }, false), "cargo test --test 'flow'");
  assert.equal(runCommand("go", { file: "pkg/x_test.go" }, false), "go test -json ./pkg");
  assert.equal(runCommand("go", {}, false), "go test -json ./...");
  assert.equal(
    runCommand("node", { file: "a.test.ts" }, false),
    "npx tsx --test --test-reporter=tap 'a.test.ts'",
  );
});

test("Jest / Vitest JSON among other output", () => {
  const json = JSON.stringify({
    numFailedTests: 1,
    numPassedTests: 1,
    numPendingTests: 0,
    testResults: [
      {
        name: "/repo/src/a.test.ts",
        assertionResults: [
          { ancestorTitles: ["math"], title: "adds", status: "passed", duration: 3 },
          {
            ancestorTitles: ["math"],
            title: "subs",
            status: "failed",
            failureMessages: ["\u001b[31mAssertionError\u001b[39m: expected 1 to be 2"],
            location: { line: 9 },
          },
        ],
      },
      { name: "/repo/src/broken.test.ts", message: "SyntaxError: x", assertionResults: [] },
    ],
  });
  const run = parseJestJson(`console.log noise {not json}\n${json}\nDone`, "vitest", "/repo");
  assert.equal(
    run.results.get(testId("vitest", "src/a.test.ts", ["math", "adds"]))?.status,
    "passed",
  );
  const failed = run.results.get(testId("vitest", "src/a.test.ts", ["math", "subs"]));
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.message, "AssertionError: expected 1 to be 2");
  // The output keeps the colors (the Test results tab draws them).
  assert.equal(failed?.output, "\u001b[31mAssertionError\u001b[39m: expected 1 to be 2");
  assert.equal(run.results.get(testId("vitest", "src/broken.test.ts", []))?.status, "failed");
  assert.equal(run.extra[1]?.line, 9);
  assert.equal(run.summary, "1 passed, 1 failed, 0 skipped");
});

test("pytest's -rA summary and failure sections", () => {
  const out = [
    "============================= FAILURES ==============================",
    "_________________________ TestThing.test_a _________________________",
    "    def test_a(self):",
    ">       assert 1 == 2",
    "E       assert 1 == 2",
    "======================= short test summary info =====================",
    "PASSED tests/test_x.py::test_one",
    "PASSED tests/test_x.py::test_p[1]",
    "FAILED tests/test_x.py::test_p[2] - assert 0",
    "FAILED tests/test_x.py::TestThing::test_a - assert 1 == 2",
    "SKIPPED [1] tests/test_x.py:9: no network",
    "=================== 2 failed, 2 passed in 0.12s ====================",
  ].join("\n");
  const run = parsePytest(out);
  assert.equal(
    run.results.get(testId("pytest", "tests/test_x.py", ["test_one"]))?.status,
    "passed",
  );
  assert.equal(run.results.get(testId("pytest", "tests/test_x.py", ["test_p"]))?.status, "failed");
  const a = run.results.get(testId("pytest", "tests/test_x.py", ["TestThing", "test_a"]));
  assert.equal(a?.status, "failed");
  assert.match(a?.message ?? "", /E {7}assert 1 == 2/);
  assert.equal(run.summary, "2 failed, 2 passed in 0.12s");
});

test("cargo test output", () => {
  const known = discoverRust("mod tests {\n#[test]\nfn adds() {}\n}", "src/lib.rs")[0];
  assert.ok(known);
  const out = [
    "running 2 tests",
    "test tests::adds ... ok",
    "test tests::fails ... FAILED",
    "test tests::slow ... ignored",
    "",
    "failures:",
    "",
    "---- tests::fails stdout ----",
    "thread 'tests::fails' panicked at src/lib.rs:9:5:",
    "assertion failed",
    "",
    "failures:",
    "    tests::fails",
    "test result: FAILED. 1 passed; 1 failed; 1 ignored",
  ].join("\n");
  const run = parseCargo(out, new Map([["tests::adds", known]]));
  assert.equal(run.results.get(known.id)?.status, "passed");
  const fails = [...run.results.entries()].find(([id]) => id.endsWith("fails"))?.[1];
  assert.equal(fails?.status, "failed");
  assert.match(fails?.message ?? "", /assertion failed/);
  assert.equal(run.extra.length, 2);
  assert.equal(run.summary, "FAILED. 1 passed; 1 failed; 1 ignored");
});

test("go test -json events", () => {
  const known = discoverGo("func TestAdd(t *testing.T) {}", "x_test.go")[0];
  assert.ok(known);
  const ev = (o: object) => JSON.stringify(o);
  const out = [
    ev({ Action: "run", Package: "p", Test: "TestAdd" }),
    ev({ Action: "pass", Package: "p", Test: "TestAdd", Elapsed: 0.01 }),
    ev({
      Action: "output",
      Package: "p",
      Test: "TestSub",
      Output: "x_test.go:9: \u001b[1mwant 2\u001b[0m\n",
    }),
    ev({ Action: "fail", Package: "p", Test: "TestSub/case", Elapsed: 0 }),
    ev({ Action: "fail", Package: "p", Test: "TestSub", Elapsed: 0.02 }),
    "FAIL",
  ].join("\n");
  const run = parseGoJson(out, new Map([["TestAdd", known]]));
  assert.equal(run.results.get(known.id)?.durationMs, 10);
  const sub = run.results.get(testId("go", "p", ["TestSub"]));
  assert.equal(sub?.status, "failed");
  assert.equal(sub?.message, "x_test.go:9: want 2");
  assert.equal(sub?.output, "x_test.go:9: \u001b[1mwant 2\u001b[0m");
});

test("node:test TAP, nested suites", () => {
  const out = [
    "TAP version 13",
    "# Subtest: math",
    "    # Subtest: adds",
    "    ok 1 - adds",
    "      ---",
    "      duration_ms: 0.4",
    "      ...",
    "    # Subtest: subs",
    "    not ok 2 - subs",
    "      ---",
    "      error: 'Expected values to be strictly equal'",
    "      ...",
    "    1..2",
    "not ok 1 - math",
    "# Subtest: alone",
    "ok 2 - alone # SKIP",
    "1..2",
    "# pass 1",
    "# fail 1",
  ].join("\n");
  const run = parseTap(out, "a.test.ts");
  assert.deepEqual(
    [...run.results.entries()].map(([id, r]) => [id.split("::")[1], r.status]),
    [
      ["math › adds", "passed"],
      ["math › subs", "failed"],
      ["alone", "skipped"],
    ],
  );
  assert.match(
    run.results.get(testId("node", "a.test.ts", ["math", "subs"]))?.message ?? "",
    /strictly equal/,
  );
  assert.equal(run.summary, "1 passed, 1 failed");
});

test("the test at the cursor", () => {
  const tests = discoverJs('it("a", () => {\n\n});\nit("b", () => {});', "x.test.js", "jest");
  assert.equal(testAt(tests, "x.test.js", 2)?.path[0], "a");
  assert.equal(testAt(tests, "x.test.js", 4)?.path[0], "b");
  assert.equal(testAt(tests, "y.test.js", 4), null);
});

test("the JavaScript framework: Playwright's import, Mocha's dependency or config", () => {
  assert.equal(
    jsFramework('{"devDependencies":{"vitest":"1"}}', "import { test } from '@playwright/test';"),
    "playwright",
  );
  assert.equal(jsFramework('{"devDependencies":{"mocha":"10"}}', ""), "mocha");
  assert.equal(jsFramework("{}", "describe('a', () => {});", true), "mocha");
  assert.equal(jsFramework('{"devDependencies":{"jest":"29","mocha":"10"}}', ""), "jest");
});

test("commands for Mocha, Playwright and unittest", () => {
  const t = {
    id: "x",
    framework: "mocha" as const,
    file: "test/a.js",
    path: ["s", "t (1)"],
    line: 3,
  };
  assert.equal(
    runCommand("mocha", { file: t.file, test: t }, false),
    "npx mocha --reporter json --grep '^s t \\(1\\)$' 'test/a.js'",
  );
  assert.equal(runCommand("mocha", {}, false), "npx mocha --reporter json");
  const pw = {
    ...t,
    framework: "playwright" as const,
    file: "e2e/a.spec.ts",
    line: 7,
    runnerProject: "firefox",
  };
  assert.equal(
    runCommand("playwright", { file: pw.file, test: pw }, false),
    "npx playwright test --reporter=json 'e2e/a.spec.ts:7' --project 'firefox'",
  );
  assert.equal(
    runCommand("playwright", { file: "e2e/a.spec.ts" }, true),
    "npx playwright test --reporter=json 'e2e/a.spec.ts'",
  );
  const ut = { ...t, framework: "unittest" as const, file: "pkg/test_a.py", path: ["T", "test_b"] };
  assert.equal(
    runCommand("unittest", { test: ut }, false),
    "python3 -m unittest -v 'pkg.test_a.T.test_b'",
  );
  assert.equal(
    runCommand("unittest", { file: "test_a.py" }, true),
    "python -m unittest -v 'test_a'",
  );
  assert.equal(runCommand("unittest", {}, true), "python -m unittest -v");
});

test("coverage commands: each framework's reporter into the folder", () => {
  const dir = "/w/.ide/coverage/1";
  assert.equal(
    runCommand("node", { file: "t.test.mjs" }, false, dir),
    "node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination '/w/.ide/coverage/1/lcov.info' --test-reporter=tap --test-reporter-destination=stdout 't.test.mjs'",
  );
  assert.equal(
    runCommand("vitest", {}, false, dir),
    "npx vitest run --reporter=json --coverage.enabled=true --coverage.reporter=json --coverage.reportsDirectory '/w/.ide/coverage/1'",
  );
  assert.equal(
    runCommand("jest", {}, false, dir),
    "npx jest --json --testLocationInResults --coverage --coverageReporters=json --coverageDirectory '/w/.ide/coverage/1'",
  );
  assert.equal(
    runCommand("mocha", {}, false, dir),
    "npx c8 --reporter=lcovonly --reports-dir '/w/.ide/coverage/1' mocha --reporter json",
  );
  assert.equal(
    runCommand("pytest", {}, true, "C:\\w\\cov"),
    "python -m pytest -rA --color=yes --cov=. --cov-branch --cov-context=test --cov-report=; python -m coverage json --show-contexts -o 'C:\\w\\cov\\coverage.json'",
  );
  assert.equal(
    runCommand("unittest", { file: "test_a.py" }, false, dir),
    "python3 -m coverage run --branch --data-file '/w/.ide/coverage/1/.coverage' -m unittest -v 'test_a'; python3 -m coverage json --data-file '/w/.ide/coverage/1/.coverage' -o '/w/.ide/coverage/1/coverage.json'",
  );
  assert.equal(
    runCommand("go", { file: "pkg/x_test.go" }, false, dir),
    "go test -json -coverprofile '/w/.ide/coverage/1/cover.out' ./pkg",
  );
  assert.equal(
    runCommand("cargo", { file: "src/store/ops.rs" }, false, dir),
    "cargo llvm-cov --lcov --output-path '/w/.ide/coverage/1/lcov.info' -- 'store::ops::'",
  );
  const ct = {
    id: "x",
    framework: "cargo" as const,
    file: "src/lib.rs",
    path: ["a", "b"],
    line: 1,
  };
  assert.equal(
    runCommand("cargo", { test: ct }, false, dir),
    "cargo llvm-cov --lcov --output-path '/w/.ide/coverage/1/lcov.info' -- 'a::b' --exact",
  );
  assert.deepEqual(coverageReport("vitest"), { file: "coverage-final.json", format: "istanbul" });
  assert.equal(coverageReport("playwright"), null);
  assert.equal(unittestModule("pkg/sub/__init__.py"), "pkg.sub");
});

test("expected / actual: node:test's YAML, Jest's failureDetails, pytest's text", () => {
  // What node:test printed for assert.equal("hello\nworld", "hello\nthere") inside a describe.
  const tap = `TAP version 13
# Subtest: s
    # Subtest: str
    not ok 1 - str
      ---
      duration_ms: 0.691196
      type: 'test'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal:
      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      expected: |-
        hello
        there
      actual: |-
        hello
        world
      operator: 'strictEqual'
      stack: |-
        TestContext.<anonymous> (file:///w/a.test.mjs:7:30)
      ...
    1..1
not ok 1 - s
  ---
  duration_ms: 1.25
  type: 'suite'
  ...
1..1
`;
  const r = parseTap(tap, "a.test.mjs").results.get(testId("node", "a.test.mjs", ["s", "str"]));
  assert.equal(r?.status, "failed");
  assert.equal(r?.expected, "hello\nthere");
  assert.equal(r?.actual, "hello\nworld");
  assert.equal(r?.durationMs, 1);

  const jest = JSON.stringify({
    numFailedTests: 1,
    testResults: [
      {
        name: "/w/a.test.js",
        assertionResults: [
          {
            ancestorTitles: [],
            title: "eq",
            status: "failed",
            failureMessages: ["Error: expect(received).toEqual(expected)"],
            failureDetails: [
              { matcherResult: { actual: { a: 1 }, expected: { a: 2 }, pass: false } },
            ],
          },
          {
            ancestorTitles: [],
            title: "vitest style",
            status: "failed",
            failureMessages: [
              "AssertionError: expected 1 to be 2\n\n- Expected\n+ Received\n\n- 2\n+ 1\n",
            ],
          },
        ],
      },
    ],
  });
  const run = parseJestJson(jest, "jest", "/w");
  const eq = run.results.get(testId("jest", "a.test.js", ["eq"]));
  assert.equal(eq?.expected, '{\n  "a": 2\n}');
  assert.equal(eq?.actual, '{\n  "a": 1\n}');
  const vs = run.results.get(testId("jest", "a.test.js", ["vitest style"]));
  assert.deepEqual([vs?.expected, vs?.actual], ["2", "1"]);

  const py =
    parsePytest(`=================================== FAILURES ===================================
__________________________________ test_add ___________________________________

    def test_add():
>       assert 1 + 1 == 3
E       assert (1 + 1) == 3

t/test_a.py:2: AssertionError
=========================== short test summary info ============================
FAILED t/test_a.py::test_add - assert (1 + 1) == 3
`).results.get(testId("pytest", "t/test_a.py", ["test_add"]));
  assert.deepEqual([py?.expected, py?.actual], ["3", "(1 + 1)"]);
});

const ESC = "\u001b";
const red = (s: string) => `${ESC}[31m${s}${ESC}[0m`;

test("plainOutput: plain text for parsing, colored slices back from it", () => {
  const out = `a ${red("bad")} b\r\nc`;
  const plain = plainOutput(out);
  assert.equal(plain.text, "a bad b\r\nc");
  assert.ok(plain.hasColor);
  // The codes around the word come with it.
  assert.equal(plain.recolor("bad"), red("bad"));
  assert.equal(plain.colored(0, 1), "a");
  assert.equal(plain.recolor("missing"), "missing");
  const crlf = plainOutput(out, true);
  assert.equal(crlf.text, "a bad b\nc");
  assert.equal(crlf.recolor("b\nc"), "b\nc");
  // Without codes, nothing is copied.
  const none = plainOutput("x y");
  assert.equal(none.hasColor, false);
  assert.equal(none.recolor("y"), "y");
});

test("pytest, cargo and TAP results come from the plain text; a test's output keeps its colors", () => {
  const pytest = [
    `${ESC}[1m=================== FAILURES ===================${ESC}[0m`,
    `${ESC}[31m${ESC}[1m___________________ test_b ___________________${ESC}[0m`,
    `    def test_b():`,
    `>       assert ${red("1 == 2")}`,
    `${ESC}[1m=========== short test summary info ===========${ESC}[0m`,
    `${ESC}[32mPASSED${ESC}[0m t/test_x.py::test_a`,
    `${ESC}[31mFAILED${ESC}[0m t/test_x.py::test_b - assert 1 == 2`,
    `${ESC}[31m========= 1 failed, 1 passed in 0.1s =========${ESC}[0m`,
  ].join("\n");
  const r = parsePytest(pytest);
  assert.equal(r.results.get(testId("pytest", "t/test_x.py", ["test_a"]))?.status, "passed");
  const failed = r.results.get(testId("pytest", "t/test_x.py", ["test_b"]));
  assert.equal(failed?.status, "failed");
  assert.ok(!failed?.message?.includes(ESC), "the message is plain");
  assert.ok(failed?.output?.includes(red("1 == 2")), "the output keeps its colors");
  assert.equal(r.summary, "1 failed, 1 passed in 0.1s");

  const cargo = [
    `test a::b ... ${red("FAILED")}`,
    "",
    "failures:",
    "",
    "---- a::b stdout ----",
    `thread panicked: ${red("boom")}`,
    "",
    "failures:",
    `test result: ${red("FAILED")}. 0 passed; 1 failed`,
  ].join("\n");
  const c = parseCargo(cargo, new Map());
  const cr = c.results.get(testId("cargo", "", ["a", "b"]));
  assert.equal(cr?.status, "failed");
  assert.equal(cr?.message, "thread panicked: boom");
  assert.ok(cr?.output?.includes(red("boom")));

  const tap = [
    "TAP version 13",
    "not ok 1 - adds",
    "  ---",
    `  error: ${red("Expected 1")}`,
    "  ...",
    "# pass 0",
    "# fail 1",
  ].join("\n");
  const t = parseTap(tap, "a.test.js").results.get(testId("node", "a.test.js", ["adds"]));
  assert.equal(t?.status, "failed");
  assert.equal(t?.message, "error: Expected 1");
  assert.equal(t?.output, `error: ${red("Expected 1")}`);
});

test("test runs force colors through the pipe; pytest coverage writes its data file aside", () => {
  assert.deepEqual(testRunEnv("jest"), { FORCE_COLOR: "1", CARGO_TERM_COLOR: "always" });
  assert.equal(testRunEnv("pytest", "/c/.coverage").COVERAGE_FILE, "/c/.coverage");
  assert.equal(testRunEnv("go", "/c/.coverage").COVERAGE_FILE, undefined);
});
