import assert from "node:assert/strict";
import { test } from "node:test";
import {
  affectedFiles,
  continuousTargets,
  isWatchable,
  stemOf,
  type WatchedTest,
} from "./continuous";

const tests: WatchedTest[] = [
  { id: "a1", file: "src/util.test.ts", project: "" },
  { id: "a2", file: "src/util.test.ts", project: "" },
  { id: "b1", file: "src/main.spec.ts", project: "" },
  { id: "p1", file: "py/tests/test_calc.py", project: "py" },
  { id: "p2", file: "py/tests/test_io.py", project: "py" },
  { id: "g1", file: "goapp/calc_test.go", project: "goapp" },
  { id: "g2", file: "goapp/sub/other_test.go", project: "goapp" },
];

const none = { all: false, files: new Set<string>(), tests: new Set<string>() };

test("stems and watchable files", () => {
  assert.equal(stemOf("src/util.test.ts"), "util");
  assert.equal(stemOf("a/test_calc.py"), "calc");
  assert.equal(stemOf("calc_test.go"), "calc");
  assert.equal(stemOf("Main.spec.tsx"), "main");
  assert.ok(isWatchable("src/util.ts"));
  assert.ok(!isWatchable("README.md"));
  assert.ok(!isWatchable("node_modules/x/index.js"));
  assert.ok(!isWatchable("app/target/debug/build.rs"));
});

test("which test files a save affects", () => {
  // A test file: itself.
  assert.deepEqual(affectedFiles("src/main.spec.ts", tests), ["src/main.spec.ts"]);
  // A source file: the tests named after it.
  assert.deepEqual(affectedFiles("src/util.ts", tests), ["src/util.test.ts"]);
  assert.deepEqual(affectedFiles("py/calc.py", tests), ["py/tests/test_calc.py"]);
  // No test named after it: the project's tests.
  assert.deepEqual(affectedFiles("py/helpers.py", tests), [
    "py/tests/test_calc.py",
    "py/tests/test_io.py",
  ]);
  // Go: the same folder's tests.
  assert.deepEqual(affectedFiles("goapp/sub/x.go", tests), ["goapp/sub/other_test.go"]);
  // Not code: nothing.
  assert.deepEqual(affectedFiles("notes.md", tests), []);
  // Only in the root project: the root's tests (not py's or goapp's).
  assert.deepEqual(affectedFiles("src/other.ts", tests), ["src/util.test.ts", "src/main.spec.ts"]);
});

test("continuous targets: the whole run, files and single tests", () => {
  assert.deepEqual(continuousTargets(["src/util.ts"], tests, none), []);
  assert.deepEqual(continuousTargets(["src/util.ts", "README.md"], tests, { ...none, all: true }), [
    { files: ["src/util.test.ts"] },
  ]);
  // A watched file runs when it's affected; one that isn't stays quiet.
  assert.deepEqual(
    continuousTargets(["py/calc.py"], tests, {
      ...none,
      files: new Set(["py/tests/test_calc.py", "src/util.test.ts"]),
    }),
    [{ files: ["py/tests/test_calc.py"] }],
  );
  // Single tests: alone, unless their file runs anyway.
  assert.deepEqual(
    continuousTargets(["src/util.ts"], tests, { ...none, tests: new Set(["a1", "b1"]) }),
    [{ testId: "a1" }],
  );
  assert.deepEqual(
    continuousTargets(["src/util.ts"], tests, {
      all: false,
      files: new Set(["src/util.test.ts"]),
      tests: new Set(["a1"]),
    }),
    [{ files: ["src/util.test.ts"] }],
  );
});
