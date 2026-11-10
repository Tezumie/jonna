import assert from "node:assert/strict";
import { test } from "node:test";
import { debugConfiguration, debugPackage, debugUnsupported } from "./debugConfig";
import { countsLabel, durationLabel, RunHistory, type RunRecord } from "./history";

const run = (over: Partial<Omit<RunRecord, "id">> = {}): Omit<RunRecord, "id"> => ({
  label: "All tests",
  startedAt: 1000,
  durationMs: 1200,
  target: {},
  coverage: false,
  cancelled: false,
  passed: 1,
  failed: 1,
  skipped: 0,
  commands: ["node --test"],
  results: [
    { id: "a", name: "a", file: "t.mjs", status: "passed", durationMs: 3 },
    { id: "b", name: "b", file: "t.mjs", status: "failed", message: "x".repeat(10_000) },
  ],
  ...over,
});

test("RunHistory: newest first, ids, kept runs, failures first, messages cut", () => {
  const h = new RunHistory(3);
  const first = h.add(run());
  assert.equal(first.id, 1);
  assert.deepEqual(
    first.results.map((r) => r.id),
    ["b", "a"],
    "failures first",
  );
  assert.equal(first.results[0]?.message?.length, 4000);
  for (let i = 0; i < 3; i++) h.add(run({ startedAt: 2000 + i, label: `run ${i}` }));
  assert.deepEqual(
    h.list().map((r) => r.id),
    [4, 3, 2],
  );
  assert.equal(h.get(1), undefined, "the oldest dropped");
  assert.equal(h.get(3)?.label, "run 1");
  h.setMax(1);
  assert.equal(h.list().length, 1);
  h.setMax(Number.NaN);
  h.add({ ...h.list()[0], label: "after NaN" } as Omit<RunRecord, "id">);
  assert.equal(h.list().length, 2, "a bad setting keeps the default, not zero runs");
  h.clear();
  assert.equal(h.list().length, 0);
});

test("RunHistory.testHistory: a test's results across runs, newest first", () => {
  const h = new RunHistory();
  h.add(run({ startedAt: 1 }));
  h.add(
    run({
      startedAt: 2,
      results: [{ id: "a", name: "a", file: "t.mjs", status: "failed", durationMs: 9 }],
    }),
  );
  h.add(run({ startedAt: 3, results: [] }));
  assert.deepEqual(h.testHistory("a"), [
    { run: 2, at: 2, status: "failed", durationMs: 9 },
    { run: 1, at: 1, status: "passed", durationMs: 3 },
  ]);
  assert.deepEqual(h.testHistory("a", 1).length, 1);
  assert.deepEqual(h.testHistory("zzz"), []);
});

test("labels", () => {
  assert.equal(countsLabel({ passed: 3, failed: 0, skipped: 0 }), "3 passed, 0 failed");
  assert.equal(countsLabel({ passed: 3, failed: 1, skipped: 2 }), "3 passed, 1 failed, 2 skipped");
  assert.equal(durationLabel(450), "450 ms");
  assert.equal(durationLabel(2340), "2.3 s");
  assert.equal(durationLabel(65_000), "1 min 5 s");
});

test("debugConfiguration: node:test runs the file itself with a name pattern", () => {
  const c = debugConfiguration(
    {
      framework: "node",
      file: "tests/a.test.mjs",
      test: { path: ["math", "adds (1)"], line: 4 },
      cwd: "/w",
    },
    false,
  );
  assert.equal(c?.type, "node");
  assert.equal(c?.program, "/w/tests/a.test.mjs");
  assert.deepEqual(c?.runtimeArgs, ["--test-name-pattern=^adds \\(1\\)$"]);
  assert.equal(c?.cwd, "/w");
  const ts = debugConfiguration({ framework: "node", file: "a.test.ts", cwd: "C:\\w" }, true);
  assert.equal(ts?.program, "C:\\w\\a.test.ts");
  assert.deepEqual(ts?.runtimeArgs, ["--import", "tsx"]);
});

test("debugConfiguration: Jest in band, Mocha's _mocha, pytest and unittest under debugpy", () => {
  const jest = debugConfiguration(
    {
      framework: "jest",
      file: "src/a.test.ts",
      test: { path: ["suite", "works"], line: 3 },
      cwd: "/w/pkg",
      nodeModules: "/w/node_modules",
    },
    false,
  );
  assert.equal(jest?.program, "/w/node_modules/jest/bin/jest.js");
  assert.deepEqual(jest?.args, [
    "--runInBand",
    "--watchAll=false",
    "--runTestsByPath",
    "src/a.test.ts",
    "-t",
    "^suite works$",
  ]);
  const mocha = debugConfiguration({ framework: "mocha", file: "test/a.js", cwd: "/w" }, false);
  assert.equal(mocha?.program, "/w/node_modules/mocha/bin/_mocha");
  assert.deepEqual(mocha?.args, ["--no-timeouts", "test/a.js"]);
  const py = debugConfiguration(
    {
      framework: "pytest",
      file: "tests/test_a.py",
      test: { path: ["TestX", "test_y"], line: 1 },
      cwd: "/w",
    },
    false,
  );
  assert.equal(py?.type, "debugpy");
  assert.equal(py?.module, "pytest");
  assert.deepEqual(py?.args, ["tests/test_a.py::TestX::test_y", "--no-header", "-q"]);
  const ut = debugConfiguration(
    {
      framework: "unittest",
      file: "pkg/test_a.py",
      test: { path: ["T", "test_b"], line: 1 },
      cwd: "/w",
    },
    false,
  );
  assert.equal(ut?.module, "unittest");
  assert.deepEqual(ut?.args, ["-v", "pkg.test_a.T.test_b"]);
  assert.equal(debugPackage("jest"), "jest");
  assert.equal(debugPackage("node"), null);
});

test("debugUnsupported: Vitest, Playwright, cargo and go say what to do instead", () => {
  for (const fw of ["vitest", "playwright", "cargo", "go"] as const) {
    assert.ok(debugUnsupported(fw));
    assert.equal(debugConfiguration({ framework: fw, file: "a", cwd: "/w" }, false), null);
  }
  assert.equal(debugUnsupported("node"), null);
});

test("RunHistory.rename: ids and files renamed, a gone folder's results dropped (D251)", () => {
  const h = new RunHistory(5);
  h.add(
    run({
      target: { file: "t.mjs", testIds: ["node:t.mjs::a", "node:gone.mjs::c"] },
      results: [
        { id: "node:t.mjs::a", name: "a", file: "t.mjs", status: "passed" },
        { id: "node:gone.mjs::c", name: "c", file: "gone.mjs", status: "failed" },
      ],
    }),
  );
  const file = (f: string) => (f === "gone.mjs" ? null : `app/${f}`);
  const id = (i: string) => (i.includes("gone") ? null : i.replace("node:", "node:app/"));
  h.rename(id, file);
  const [r] = h.list();
  assert.deepEqual(
    r?.results.map((x) => [x.id, x.file]),
    [["node:app/t.mjs::a", "app/t.mjs"]],
  );
  // What to run again keeps a name it can't rename (it finds nothing rather than run all).
  assert.deepEqual(r?.target, {
    file: "app/t.mjs",
    testIds: ["node:app/t.mjs::a", "node:gone.mjs::c"],
  });
});
