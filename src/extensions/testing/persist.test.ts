import assert from "node:assert/strict";
import { test } from "node:test";
import { outputPaneText, plainOutputText, RunHistory } from "./history";
import { parseGoJson, parsePytest, parseTap } from "./model";
import { parseCoverage, parseResults, serializeCoverage, serializeResults } from "./persist";

test("results and history survive a reload (D209)", () => {
  const h = new RunHistory(5);
  h.add({
    label: "All tests",
    startedAt: 1,
    durationMs: 2,
    target: { file: "a.test.js" },
    coverage: false,
    cancelled: false,
    passed: 1,
    failed: 1,
    skipped: 0,
    commands: ["npx vitest"],
    results: [
      { id: "a", name: "a", file: "a.test.js", status: "passed", output: "hello\n" },
      { id: "b", name: "b", file: "a.test.js", status: "failed", message: "boom" },
    ],
  });
  const text = serializeResults(
    h,
    new Map([
      ["a", { status: "passed" as const, output: "hello\n" }],
      ["b", { status: "failed" as const, message: "boom", expected: "1", actual: "2" }],
      ["c", { status: "running" as const }],
    ]),
  );
  const back = parseResults(text);
  assert.ok(back);
  assert.deepEqual([...back.results.keys()], ["a", "b"], "a running test isn't kept");
  assert.equal(back.results.get("b")?.expected, "1");
  const again = new RunHistory(5);
  assert.equal(again.restore(back.history), 1);
  assert.equal(again.list()[0]?.results.find((r) => r.id === "a")?.output, "hello\n");
  // New runs number on from the kept ones.
  const kept = again.list()[0];
  assert.ok(kept);
  const next = again.add({ ...kept, results: [] });
  assert.equal(next.id, 2);
  // Not ours, or damaged: nothing.
  assert.equal(parseResults("{"), null);
  assert.equal(parseResults('{"version":99}'), null);
  assert.equal(new RunHistory().restore({ runs: [{ id: "x" }] }), 0);
});

test("a run keeps each test's output, failures first, within limits", () => {
  const h = new RunHistory(2);
  const big = "y".repeat(30_000);
  const r = h.add({
    label: "x",
    startedAt: 1,
    durationMs: 1,
    target: {},
    coverage: false,
    cancelled: false,
    passed: 1,
    failed: 0,
    skipped: 0,
    commands: [],
    results: [{ id: "a", name: "a", file: "f", status: "passed", output: `${big}END` }],
  });
  const out = r.results[0]?.output ?? "";
  assert.ok(out.length < 21_000 && out.endsWith("END"), "the end is kept");
});

test("coverage survives a restart (D209)", () => {
  const report = {
    files: [
      {
        file: "src/a.ts",
        lines: new Map([
          [1, 2],
          [2, 0],
        ]),
        branches: new Map([[1, { covered: 1, total: 2 }]]),
        functions: { covered: 1, total: 1 },
        declarations: [{ name: "add", line: 1, hits: 2 }],
      },
    ],
    finishedAt: 5,
    label: "All tests",
    problems: ["go: no coverage report"],
  };
  const back = parseCoverage(serializeCoverage(report));
  assert.deepEqual(back, report);
  assert.equal(parseCoverage("[]"), null);
});

test("each test's own output from the frameworks (D209)", () => {
  const go = parseGoJson(
    [
      '{"Action":"run","Test":"TestA"}',
      '{"Action":"output","Test":"TestA","Output":"=== RUN   TestA\\n"}',
      '{"Action":"output","Test":"TestA","Output":"hello from A\\n"}',
      '{"Action":"pass","Test":"TestA","Elapsed":0.01}',
      '{"Action":"output","Test":"TestB","Output":"b fails\\n"}',
      '{"Action":"fail","Test":"TestB","Elapsed":0}',
    ].join("\n"),
    new Map(),
  );
  const [a, b] = [...go.results.values()];
  assert.match(a?.output ?? "", /hello from A/);
  assert.equal(a?.message, undefined, "a pass has output but no message");
  assert.match(b?.output ?? "", /b fails/);

  const py =
    parsePytest(`============================= test session starts ==============================
collected 2 items

test_a.py .F                                                             [100%]

=================================== FAILURES ===================================
___________________________________ test_bad ___________________________________

    def test_bad():
        print("about to fail")
>       assert 1 == 2
E       assert 1 == 2

test_a.py:6: AssertionError
----------------------------- Captured stdout call -----------------------------
about to fail
==================================== PASSES ====================================
___________________________________ test_ok ____________________________________
----------------------------- Captured stdout call -----------------------------
all good
=========================== short test summary info ============================
PASSED test_a.py::test_ok
FAILED test_a.py::test_bad - assert 1 == 2
========================= 1 failed, 1 passed in 0.02s ==========================
`);
  const ok = [...py.results.entries()].find(([id]) => id.endsWith("test_ok"))?.[1];
  const bad = [...py.results.entries()].find(([id]) => id.endsWith("test_bad"))?.[1];
  assert.match(ok?.output ?? "", /all good/);
  assert.equal(ok?.status, "passed");
  assert.match(bad?.output ?? "", /about to fail/);
  assert.equal(bad?.status, "failed");

  const tap = parseTap(
    "TAP version 13\n# Subtest: two\nnot ok 1 - two\n  ---\n  duration_ms: 1\n  error: '1 == 2'\n  stack: |-\n    at x.js:3\n  ...\n1..1\n",
    "x.test.js",
  );
  assert.match([...tap.results.values()][0]?.output ?? "", /stack: \|-\n {2}at x\.js:3/);
  assert.equal(
    outputPaneText({ id: "a", name: "a", file: "f", status: "passed" }),
    "This test printed nothing its framework reports per test.",
  );
  assert.equal(
    outputPaneText({ id: "a", name: "a", file: "f", status: "failed", message: "m" }),
    "m",
  );
  // The pane draws the colors; agents get the text without them.
  const colored = {
    id: "a",
    name: "a",
    file: "f",
    status: "failed" as const,
    output: "\u001b[31;1mfail\u001b[0m \u001b[38;5;208mx\u001b[39m\u001b[2K",
  };
  assert.equal(outputPaneText(colored), colored.output);
  assert.equal(plainOutputText(colored), "fail x");
});

test("results keep the naming their ids were written in (D251)", () => {
  const naming = {
    multi: true,
    folders: [
      { path: "/w/app", name: "app" },
      { path: "/w/api", name: "api" },
    ],
  };
  const text = serializeResults(new RunHistory(5), new Map(), naming);
  assert.deepEqual(parseResults(text)?.naming, naming);
  // A file from before: no naming (read as the folder's own).
  assert.equal(parseResults(serializeResults(new RunHistory(5), new Map()))?.naming, undefined);
});
