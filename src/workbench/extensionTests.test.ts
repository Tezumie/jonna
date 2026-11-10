// The host's side of extensions' test controllers: the checks of a worker's items and profiles,
// a run's events into results, and the tree helpers the Testing view draws with.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyTestRunEvents,
  checkTestItems,
  checkTestProfiles,
  coverageOf,
  type ExtTestItem,
  profileFor,
  rollUpStatus,
  settleTestResults,
  testChildren,
  testLeaves,
} from "./extensionTests";

const inFolder = (path: string) =>
  path.startsWith("..") || path.startsWith("/etc") ? null : `/ws/${path}`;

test("checkTestItems: wids, parents in order, files in the folder, limits", () => {
  const items = checkTestItems(
    [
      { wid: "i1", parent: null, id: "a.memo", label: "a.memo", path: "a.memo" },
      { wid: "i2", parent: "i1", id: "one", label: "one", path: "a.memo", line: 3, busy: true },
      { wid: "i3", parent: "i9", id: "orphan", label: "orphan", path: "../x", line: 2 },
      { wid: "i1", label: "duplicate" },
      { wid: "i4" },
      "nope",
      { wid: "i5", parent: "i2", id: "deep", label: "deep", canResolveChildren: true, error: "x" },
    ],
    inFolder,
  );
  assert.deepEqual(items, [
    {
      wid: "i1",
      parent: null,
      id: "a.memo",
      label: "a.memo",
      path: "/ws/a.memo",
      canResolveChildren: false,
      busy: false,
    },
    {
      wid: "i2",
      parent: "i1",
      id: "one",
      label: "one",
      path: "/ws/a.memo",
      line: 3,
      canResolveChildren: false,
      busy: true,
    },
    // Its parent isn't there: at the top; its file is outside the folder: none (and no line).
    {
      wid: "i3",
      parent: null,
      id: "orphan",
      label: "orphan",
      canResolveChildren: false,
      busy: false,
    },
    {
      wid: "i5",
      parent: "i2",
      id: "deep",
      label: "deep",
      canResolveChildren: true,
      busy: false,
      error: "x",
    },
  ]);
  assert.deepEqual(checkTestItems("nope", inFolder), []);
  const many = Array.from({ length: 20_100 }, (_, i) => ({ wid: `w${i}`, label: "t" }));
  assert.equal(checkTestItems(many, inFolder).length, 20_000);
});

test("checkTestProfiles and profileFor: the kind's default, else its first", () => {
  const profiles = checkTestProfiles([
    { id: "p1", label: "Run", kind: "run" },
    { id: "p2", label: "Run fast", kind: "run", isDefault: true },
    { id: "p3", kind: "debug" },
    { id: "p3", kind: "run" },
    { id: "p4", kind: "bogus" },
  ]);
  assert.deepEqual(
    profiles.map((p) => [p.id, p.kind, p.label, p.isDefault]),
    [
      ["p1", "run", "Run", false],
      ["p2", "run", "Run fast", true],
      ["p3", "debug", "debug", false],
    ],
  );
  assert.equal(profileFor(profiles, "run")?.id, "p2");
  assert.equal(profileFor(profiles, "debug")?.id, "p3");
  assert.equal(profileFor(profiles, "coverage"), undefined);
});

test("applyTestRunEvents: states, failures with expected / actual, output; settle drops the unrun", () => {
  const start = new Map([["i9", { status: "passed" as const }]]);
  const { results, output } = applyTestRunEvents(start, [
    { kind: "enqueued", test: "i1" },
    { kind: "enqueued", test: "i2" },
    { kind: "enqueued", test: "i3" },
    { kind: "started", test: "i1" },
    { kind: "passed", test: "i1", durationMs: 12.4 },
    { kind: "output", text: "hello\r\n" },
    { kind: "errored", test: "i2", message: "boom", expected: "1", actual: "2" },
    { kind: "skipped", test: "i4" },
    { kind: "passed" },
    "junk",
  ]);
  assert.equal(output, "hello\r\n");
  assert.deepEqual(Object.fromEntries(results), {
    i9: { status: "passed" },
    i1: { status: "passed", durationMs: 12 },
    i2: { status: "failed", message: "boom", expected: "1", actual: "2" },
    i3: { status: "queued" },
    i4: { status: "skipped" },
  });
  assert.equal(start.size, 1);
  assert.deepEqual([...settleTestResults(results).keys()], ["i9", "i1", "i2", "i4"]);
});

test("testChildren, testLeaves and rollUpStatus: the tree the view draws", () => {
  const item = (wid: string, parent: string | null, label: string, sortText?: string) =>
    ({
      wid,
      parent,
      id: wid,
      label,
      canResolveChildren: false,
      busy: false,
      ...(sortText && { sortText }),
    }) as ExtTestItem;
  const items = [
    item("f", null, "file"),
    item("b", "f", "beta"),
    item("a", "f", "alpha"),
    item("s", "f", "suite", "0"),
    item("s1", "s", "inner"),
  ];
  assert.deepEqual(
    testChildren(items, "f").map((i) => i.wid),
    ["s", "a", "b"],
  );
  assert.deepEqual(
    testLeaves(items, null)
      .map((i) => i.wid)
      .sort(),
    ["a", "b", "s1"],
  );
  assert.deepEqual(
    testLeaves(items, "a").map((i) => i.wid),
    ["a"],
  );
  const results = new Map([
    ["a", { status: "passed" as const }],
    ["b", { status: "passed" as const }],
  ]);
  assert.equal(rollUpStatus(results, ["a", "b"]), "passed");
  assert.equal(rollUpStatus(results, ["a", "s1"]), "unknown");
  assert.equal(rollUpStatus(new Map([["a", { status: "failed" as const }]]), ["a", "b"]), "failed");
  assert.equal(rollUpStatus(new Map([["a", { status: "queued" as const }]]), ["a"]), "running");
  assert.equal(rollUpStatus(new Map([["a", { status: "skipped" as const }]]), ["a"]), "skipped");
  assert.equal(rollUpStatus(results, []), "unknown");
});

test("coverage from a run: files in the folder, numbers only, the last report of a file wins (D255)", () => {
  const files = coverageOf(
    [
      { kind: "passed", test: "w1" },
      {
        kind: "coverage",
        path: "src/a.ts",
        lines: [
          [1, 2],
          [2, 0],
          ["x", 1],
        ],
        branches: [
          [2, 1, 2],
          [3, 3, 2],
        ],
      },
      { kind: "coverage", path: "../outside.ts", lines: [[1, 1]] },
      {
        kind: "coverage",
        path: "src/a.ts",
        lines: [{ line: 5, count: 1 }],
        functions: [{ name: "f", line: 5, hits: 1 }],
      },
    ],
    (p) => (p.startsWith("..") ? null : p),
  );
  assert.equal(files.length, 1);
  assert.deepEqual(files[0]?.lines, [[5, 1]]);
  assert.deepEqual(files[0]?.functions, [{ name: "f", line: 5, hits: 1 }]);
  const first = coverageOf(
    [
      {
        kind: "coverage",
        path: "b.ts",
        lines: [
          [1, 2],
          [2, 0],
          ["x", 1],
        ],
        branches: [
          [2, 1, 2],
          [3, 3, 2],
        ],
      },
    ],
    (p) => p,
  );
  assert.deepEqual(first[0]?.lines, [
    [1, 2],
    [2, 0],
  ]);
  assert.deepEqual(first[0]?.branches, [[2, 1, 2]]);
});

test("a profile with a tag runs only items that have it (D255)", () => {
  const profiles = checkTestProfiles([
    { id: "p1", kind: "run", isDefault: true, tag: "slow" },
    { id: "p2", kind: "run" },
  ]);
  assert.equal(profiles[0]?.tag, "slow");
  assert.equal(profileFor(profiles, "run")?.id, "p1");
  assert.equal(profileFor(profiles, "run", ["fast"])?.id, "p2");
  assert.equal(profileFor(profiles, "run", ["slow"])?.id, "p1");
  const items = checkTestItems([{ wid: "w1", label: "a", tags: ["slow", 3, ""] }], (p) => p);
  assert.deepEqual(items[0]?.tags, ["slow"]);
});

test("D264: a failure's location, a workspace path, is kept", () => {
  const inFolder = (p: string) => (p.startsWith("/w/") ? p : null);
  const { results } = applyTestRunEvents(
    new Map(),
    [
      { kind: "failed", test: "a", message: "boom", location: { path: "/w/a.test.ts", line: 12 } },
      { kind: "failed", test: "b", message: "x", location: { path: "/etc/passwd", line: 1 } },
    ],
    inFolder,
  );
  assert.deepEqual(results.get("a")?.location, { path: "/w/a.test.ts", line: 12 });
  assert.equal(results.get("b")?.location, undefined);
});
