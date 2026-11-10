import assert from "node:assert/strict";
import { test } from "node:test";
import {
  combinedPercent,
  contextKey,
  coverageContexts,
  coverageForTest,
  fileTotals,
  goModulePath,
  goResolver,
  hasPerTestCoverage,
  lineStates,
  mergeCoverage,
  nextUncovered,
  parseCoveragePyJson,
  parseGoProfile,
  parseIstanbulJson,
  parseLcov,
  percent,
  resolverFor,
  testsCovering,
  totals,
  uncoveredRanges,
  untakenArms,
} from "./coverage";
import { parseCoverage, serializeCoverage } from "./persist";

// What `node --test --experimental-test-coverage --test-reporter=lcov` writes (Node 22).
const NODE_LCOV = `TN:
SF:lib.mjs
FN:1,add
FN:7,unused
FNDA:1,add
FNDA:0,unused
FNF:2
FNH:1
BRDA:1,0,0,1
BRDA:1,1,0,1
BRDA:2,2,0,0
BRF:3
BRH:2
DA:1,1
DA:2,1
DA:3,0
DA:4,0
DA:5,1
DA:6,1
DA:7,1
DA:8,0
DA:9,0
LH:5
LF:9
end_of_record
SF:node_modules/dep/index.js
DA:1,1
end_of_record
`;

test("resolverFor: relative to the command's folder, absolute, Windows, outside", () => {
  const r = resolverFor("/w", "/w/pkg");
  assert.equal(r("src/a.ts"), "pkg/src/a.ts");
  assert.equal(r("./src/a.ts"), "pkg/src/a.ts");
  assert.equal(r("../shared/b.ts"), "shared/b.ts");
  assert.equal(r("/w/pkg/x.ts"), "pkg/x.ts");
  assert.equal(r("file:///w/pkg/x.ts"), "pkg/x.ts");
  assert.equal(r("/elsewhere/x.ts"), null);
  assert.equal(r("/w/node_modules/x/index.js"), null);
  const win = resolverFor("C:\\Work\\app", "C:\\Work\\app");
  assert.equal(win("C:\\Work\\app\\src\\a.ts"), "src/a.ts");
  assert.equal(win("c:/work/app/src/a.ts"), "src/a.ts", "drive and case differ");
  assert.equal(win("src\\b.ts"), "src/b.ts");
});

test("parseLcov: lines, branches per line, functions; dependencies dropped", () => {
  const [fc, ...rest] = parseLcov(NODE_LCOV, resolverFor("/w", "/w"));
  assert.equal(rest.length, 0);
  assert.ok(fc);
  assert.equal(fc.file, "lib.mjs");
  assert.equal(fc.lines.size, 9);
  assert.equal(fc.lines.get(3), 0);
  assert.equal(fc.lines.get(5), 1);
  assert.deepEqual(fc.branches.get(1), { covered: 2, total: 2 });
  assert.deepEqual(fc.branches.get(2), { covered: 0, total: 1 });
  assert.deepEqual(fc.functions, { covered: 1, total: 2 });
  const t = fileTotals(fc);
  assert.deepEqual(t.lines, { covered: 5, total: 9 });
  assert.deepEqual(t.branches, { covered: 2, total: 3 });
  assert.equal(percent(t.lines), 55.6);
  assert.equal(combinedPercent(t), 58.3);
  assert.equal(uncoveredRanges(fc), "3-4, 8-9");
  assert.equal(lineStates(fc).get(2), "partial");
  assert.equal(lineStates(fc).get(3), "uncovered");
  assert.equal(lineStates(fc).get(5), "covered");
});

test("parseLcov: no FNF/FNH counts functions from FNDA; '-' branches weren't taken", () => {
  const [fc] = parseLcov(
    "SF:/w/a.js\nFNDA:0,f\nFNDA:3,g\nBRDA:4,0,0,-\nBRDA:4,0,1,2\nDA:4,2\nend_of_record\n",
    resolverFor("/w", "/w"),
  );
  assert.deepEqual(fc?.functions, { covered: 1, total: 2 });
  assert.deepEqual(fc?.branches.get(4), { covered: 1, total: 2 });
});

test("parseIstanbulJson: Jest / Vitest coverage-final.json", () => {
  const json = JSON.stringify({
    "/w/src/a.ts": {
      path: "/w/src/a.ts",
      statementMap: {
        "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
        "1": { start: { line: 2, column: 2 }, end: { line: 2, column: 12 } },
        "2": { start: { line: 2, column: 14 }, end: { line: 2, column: 20 } },
        "3": { start: { line: 4, column: 0 }, end: { line: 4, column: 9 } },
      },
      s: { "0": 3, "1": 0, "2": 2, "3": 0 },
      branchMap: { "0": { line: 2, loc: { start: { line: 2 } }, locations: [{}, {}] } },
      b: { "0": [2, 0] },
      fnMap: { "0": {}, "1": {} },
      f: { "0": 1, "1": 0 },
    },
    "/other/x.ts": { path: "/other/x.ts", statementMap: {}, s: {} },
  });
  const list = parseIstanbulJson(json, resolverFor("/w", "/w"));
  assert.equal(list.length, 1);
  const fc = list[0];
  assert.equal(fc?.file, "src/a.ts");
  assert.equal(fc?.lines.get(1), 3);
  assert.equal(fc?.lines.get(2), 2, "a line's most-run statement");
  assert.equal(fc?.lines.get(4), 0);
  assert.deepEqual(fc?.branches.get(2), { covered: 1, total: 2 });
  assert.deepEqual(fc?.functions, { covered: 1, total: 2 });
  assert.deepEqual(parseIstanbulJson("not json", resolverFor("/w", "/w")), []);
});

test("parseCoveragePyJson: pytest-cov's report with branches", () => {
  const json = JSON.stringify({
    meta: { version: "7.6.1", branch_coverage: true },
    files: {
      "pkg/calc.py": {
        executed_lines: [1, 2, 4],
        missing_lines: [3, 6],
        excluded_lines: [],
        executed_branches: [[2, 4]],
        missing_branches: [[2, 3]],
        functions: { "": {}, double: { summary: { covered_lines: 2 } }, unused: { summary: {} } },
      },
    },
    totals: {},
  });
  const [fc] = parseCoveragePyJson(json, resolverFor("/w", "/w/py"));
  assert.equal(fc?.file, "py/pkg/calc.py");
  assert.deepEqual(
    [...(fc?.lines ?? [])].sort((a, b) => a[0] - b[0]),
    [
      [1, 1],
      [2, 1],
      [3, 0],
      [4, 1],
      [6, 0],
    ],
  );
  assert.deepEqual(fc?.branches.get(2), { covered: 1, total: 2 });
  assert.deepEqual(fc?.functions, { covered: 1, total: 2 });
});

test("parseGoProfile: blocks to lines, module path to folder", () => {
  // What `go test -coverprofile` wrote for a small module (go 1.24).
  const profile = `mode: set
example.com/goapp/calc.go:3.24,4.11 1 1
example.com/goapp/calc.go:4.11,6.3 1 0
example.com/goapp/calc.go:7.2,7.14 1 1
example.com/other/x.go:1.1,2.1 1 1
`;
  assert.equal(goModulePath("module example.com/goapp\n\ngo 1.21\n"), "example.com/goapp");
  assert.equal(goModulePath('module "example.com/q"\n'), "example.com/q");
  const [fc, ...rest] = parseGoProfile(profile, goResolver("example.com/goapp", "goapp"));
  assert.equal(rest.length, 0);
  assert.equal(fc?.file, "goapp/calc.go");
  assert.deepEqual(
    [...(fc?.lines ?? [])].sort((a, b) => a[0] - b[0]),
    [
      [3, 1],
      [4, 1],
      [5, 0],
      [6, 0],
      [7, 1],
    ],
  );
  const [root] = parseGoProfile(profile, goResolver("example.com/goapp", ""));
  assert.equal(root?.file, "calc.go");
});

test("mergeCoverage: hits add up; the same branches aren't counted twice", () => {
  const r = resolverFor("/w", "/w");
  const a = parseLcov("SF:a.js\nDA:1,1\nDA:2,0\nBRDA:1,0,0,1\nBRDA:1,0,1,0\nend_of_record\n", r);
  const b = parseLcov(
    "SF:a.js\nDA:1,2\nDA:2,1\nBRDA:1,0,0,0\nBRDA:1,0,1,1\nend_of_record\nSF:b.js\nDA:1,0\nend_of_record\n",
    r,
  );
  const merged = mergeCoverage(a, b);
  assert.deepEqual(
    merged.map((f) => f.file),
    ["a.js", "b.js"],
  );
  assert.equal(merged[0]?.lines.get(1), 3);
  assert.equal(merged[0]?.lines.get(2), 1);
  assert.deepEqual(merged[0]?.branches.get(1), { covered: 1, total: 2 });
  assert.deepEqual(a[0]?.lines.get(1), 1, "inputs untouched");
  const t = totals(merged);
  assert.deepEqual(t.lines, { covered: 2, total: 3 });
  assert.equal(percent({ covered: 0, total: 0 }), null);
});

test("malformed reports are skipped, not thrown on", () => {
  const r = resolverFor("/w", "/w");
  const istanbul = JSON.stringify({
    "/w/a.js": {
      path: 7,
      statementMap: { "0": null, "1": { start: { line: "x" } }, "2": { start: { line: 3 } } },
      s: { "2": "many" },
      branchMap: { "0": null, "1": { line: 3 } },
      b: { "1": 5 },
      fnMap: null,
      f: null,
    },
    "/w/b.js": null,
  });
  const ist = parseIstanbulJson(istanbul, r);
  assert.equal(ist.length, 1);
  assert.equal(ist[0]?.lines.get(3), 0);
  const py = JSON.stringify({
    files: {
      "a.py": { executed_lines: 5, missing_lines: [1, "2", -3], executed_branches: [7, [2, 3]] },
      "b.py": null,
    },
  });
  const cov = parseCoveragePyJson(py, r);
  assert.equal(cov.length, 2);
  assert.deepEqual([...(cov[0]?.lines.keys() ?? [])], [1]);
  assert.deepEqual(cov[0]?.branches.get(2), { covered: 1, total: 1 });
  assert.deepEqual(parseCoveragePyJson("null", r), []);
  // A block over a billion lines is dropped instead of filling a map.
  const go = parseGoProfile(
    "mode: set\nexample.com/m/a.go:1.1,999999999.2 1 1\nexample.com/m/a.go:2.1,3.2 1 1\n",
    goResolver("example.com/m", ""),
  );
  assert.deepEqual([...(go[0]?.lines.keys() ?? [])], [2, 3]);
});

test("goResolver keeps files inside the module", () => {
  const resolve = goResolver("example.com/m", "svc");
  assert.equal(resolve("example.com/m/pkg/a.go"), "svc/pkg/a.go");
  assert.equal(resolve("example.com/m/../../etc/a.go"), null);
});

test("functions by name: lcov FN / FNDA, Istanbul's fnMap, coverage.py's functions (D229)", () => {
  const root = "/w";
  const r = resolverFor(root, root);
  const lcov = parseLcov(
    "SF:/w/a.js\nFN:3,add\nFN:9,12,sub\nFNDA:2,add\nFNDA:0,sub\nDA:3,2\nend_of_record\n",
    r,
  );
  assert.deepEqual(lcov[0]?.declarations, [
    { name: "add", line: 3, hits: 2 },
    { name: "sub", line: 9, hits: 0 },
  ]);
  const ist = parseIstanbulJson(
    JSON.stringify({
      "/w/b.ts": {
        path: "/w/b.ts",
        statementMap: {},
        s: {},
        branchMap: {},
        b: {},
        fnMap: {
          0: { name: "run", decl: { start: { line: 5 } }, loc: { start: { line: 5 } } },
          1: { name: "", loc: { start: { line: 2 } } },
        },
        f: { 0: 0, 1: 3 },
      },
    }),
    r,
  );
  assert.deepEqual(ist[0]?.declarations, [
    { name: "(anonymous)", line: 2, hits: 3 },
    { name: "run", line: 5, hits: 0 },
  ]);
  const py = parseCoveragePyJson(
    JSON.stringify({
      files: {
        "/w/c.py": {
          executed_lines: [1, 2],
          missing_lines: [6],
          functions: {
            "": { executed_lines: [1], missing_lines: [], summary: { covered_lines: 1 } },
            go: { executed_lines: [2], missing_lines: [], summary: { covered_lines: 1 } },
            never: { executed_lines: [], missing_lines: [6, 7], summary: { covered_lines: 0 } },
          },
        },
      },
    }),
    r,
  );
  assert.deepEqual(py[0]?.declarations, [
    { name: "go", line: 2, hits: 1 },
    { name: "never", line: 6, hits: 0 },
  ]);
  // Two commands' reports of one file: hits add up.
  const merged = mergeCoverage(lcov, lcov);
  assert.deepEqual(merged[0]?.declarations?.[0], { name: "add", line: 3, hits: 4 });
});

test("next and previous uncovered line wrap around the file (D229)", () => {
  const fc = {
    file: "a.js",
    lines: new Map([
      [1, 1],
      [3, 0],
      [5, 2],
      [8, 0],
    ]),
    branches: new Map([[5, { covered: 1, total: 2 }]]),
    functions: { covered: 0, total: 0 },
  };
  assert.equal(nextUncovered(fc, 1, 1), 3);
  assert.equal(nextUncovered(fc, 3, 1), 5);
  assert.equal(nextUncovered(fc, 8, 1), 3);
  assert.equal(nextUncovered(fc, 5, -1), 3);
  assert.equal(nextUncovered(fc, 2, -1), 8);
  assert.equal(nextUncovered({ ...fc, lines: new Map([[1, 1]]), branches: new Map() }, 1, 1), null);
});

test("coverage.py's dynamic contexts: which tests ran each line, and one test's coverage", () => {
  const json = JSON.stringify({
    files: {
      "pkg/calc.py": {
        executed_lines: [1, 2, 4],
        missing_lines: [6],
        contexts: {
          "1": [""],
          "2": [
            "tests/test_calc.py::test_add|run",
            "tests/test_calc.py::TestCalc::test_sub[1]|run",
          ],
          "4": ["tests/test_calc.py::TestCalc::test_sub[2]|run"],
        },
      },
      "pkg/other.py": { executed_lines: [1], missing_lines: [], contexts: { "1": [""] } },
    },
  });
  const files = parseCoveragePyJson(json, resolverFor("/w", "/w/proj"));
  const calc = files.find((f) => f.file === "proj/pkg/calc.py");
  assert.ok(calc && hasPerTestCoverage(files));
  // Workspace-relative keys, parameters folded, the import-time context left out.
  assert.deepEqual(testsCovering(calc, 2), [
    "proj/tests/test_calc.py::test_add",
    "proj/tests/test_calc.py::TestCalc::test_sub",
  ]);
  assert.deepEqual(testsCovering(calc, 1), []);
  assert.deepEqual(coverageContexts(files), [
    "proj/tests/test_calc.py::TestCalc::test_sub",
    "proj/tests/test_calc.py::test_add",
  ]);
  const sub = coverageForTest(files, {
    file: "proj/tests/test_calc.py",
    path: ["TestCalc", "test_sub"],
  });
  assert.equal(sub.length, 1);
  assert.deepEqual(
    [...(sub[0]?.lines ?? [])],
    [
      [1, 0],
      [2, 1],
      [4, 1],
      [6, 0],
    ],
  );
  assert.deepEqual(coverageForTest(files, { file: "x.py", path: ["nope"] }), []);
  assert.equal(contextKey("|run", resolverFor("/w", "/w")), null);
  // Kept with the report (D209's last.json).
  const back = parseCoverage(
    serializeCoverage({ files, finishedAt: 1, label: "All tests", problems: [] }),
  );
  assert.deepEqual(back?.files.find((f) => f.file === "proj/pkg/calc.py")?.contexts, calc.contexts);
});

test("lcov's TN: names the test of its records; Istanbul's branch arms keep their columns", () => {
  const lcov = `TN:adds
SF:/w/a.js
DA:1,1
DA:2,0
end_of_record
TN:subs
SF:/w/a.js
DA:1,1
DA:2,3
end_of_record
`;
  const merged = mergeCoverage(parseLcov(lcov, resolverFor("/w", "/w")));
  assert.deepEqual(testsCovering(merged[0] ?? (undefined as never), 1), ["adds", "subs"]);
  assert.deepEqual(testsCovering(merged[0] ?? (undefined as never), 2), ["subs"]);
  assert.equal(coverageForTest(merged, { file: "a.test.js", path: ["adds"] })[0]?.lines.get(2), 0);

  const istanbul = JSON.stringify({
    "/w/b.js": {
      path: "/w/b.js",
      statementMap: { "0": { start: { line: 3 } } },
      s: { "0": 1 },
      branchMap: {
        "0": {
          line: 3,
          locations: [{ start: { line: 3, column: 8 } }, { start: { line: 3, column: 20 } }],
        },
      },
      b: { "0": [2, 0] },
      fnMap: {},
      f: {},
    },
  });
  const [b] = parseIstanbulJson(istanbul, resolverFor("/w", "/w"));
  assert.deepEqual(b?.branchArms?.get(3), [
    { column: 9, taken: true },
    { column: 21, taken: false },
  ]);
  assert.deepEqual(untakenArms(b ?? (undefined as never), 3), [21]);
});
