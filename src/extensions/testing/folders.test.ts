import assert from "node:assert/strict";
import { test } from "node:test";
import {
  prefixRel,
  prefixRun,
  projectCandidates,
  renameTestFile,
  renameTestId,
  sameNaming,
} from "./folders";
import type { ParsedRun } from "./model";

test("prefixRel puts a folder's name in front", () => {
  assert.equal(prefixRel("", "src/a.test.ts"), "src/a.test.ts");
  assert.equal(prefixRel("api", "src/a.test.ts"), "api/src/a.test.ts");
  assert.equal(prefixRel("api", ""), "api");
});

test("prefixRun moves a folder's report under its name, keeping known ids", () => {
  const run: ParsedRun = {
    results: new Map([
      ["vitest:src/a.test.ts::adds", { status: "passed" }],
      ["vitest:api/src/b.test.ts::known", { status: "failed" }],
    ]),
    extra: [
      {
        id: "vitest:src/c.test.ts::new",
        framework: "vitest",
        file: "src/c.test.ts",
        path: ["new"],
        line: 1,
      },
    ],
  };
  const out = prefixRun(run, "vitest", "api", new Set(["vitest:api/src/b.test.ts::known"]));
  assert.deepEqual(
    [...out.results.keys()],
    ["vitest:api/src/a.test.ts::adds", "vitest:api/src/b.test.ts::known"],
  );
  assert.equal(out.extra[0]?.id, "vitest:api/src/c.test.ts::new");
  assert.equal(out.extra[0]?.file, "api/src/c.test.ts");
  // One folder: as it was.
  assert.equal(prefixRun(run, "vitest", "", new Set()), run);
});

test("projectCandidates never leave the file's folder with several folders", () => {
  assert.deepEqual(projectCandidates("pkg/src/a.test.ts", 0), ["pkg/src", "pkg", ""]);
  assert.deepEqual(projectCandidates("api/pkg/a.test.ts", 1), ["api/pkg", "api"]);
  assert.deepEqual(projectCandidates("a.test.ts", 0), [""]);
});

const ONE = { multi: false, folders: [{ path: "/w/app", name: "app" }] };
const TWO = {
  multi: true,
  folders: [
    { path: "/w/app", name: "app" },
    { path: "/w/api", name: "api" },
  ],
};

test("test ids follow the workspace from one folder to several and back (D251)", () => {
  const id = "vitest:src/a.test.ts::sums › adds";
  const multi = renameTestId(id, ONE, TWO);
  assert.equal(multi, "vitest:app/src/a.test.ts::sums › adds");
  assert.equal(renameTestId(multi ?? "", TWO, ONE), id);
  // Another folder's test has no place with the first folder alone.
  assert.equal(renameTestId("vitest:api/src/b.test.ts::x", TWO, ONE), null);
  // A rename.
  const renamed = { multi: true, folders: [TWO.folders[0], { path: "/w/api", name: "server" }] };
  assert.equal(
    renameTestId("go:api/pkg/x_test.go::TestX", TWO, renamed as typeof TWO),
    "go:server/pkg/x_test.go::TestX",
  );
  // The top project ("" with one folder, the folder's name with several).
  assert.equal(renameTestFile("", ONE, TWO), "app");
  assert.equal(renameTestFile("app", TWO, ONE), "");
  assert.equal(sameNaming(TWO, { multi: true, folders: [...TWO.folders] }), true);
  assert.equal(sameNaming(ONE, TWO), false);
});

test("a nested folder's file goes to the innermost folder", () => {
  const nested = {
    multi: true,
    folders: [
      { path: "/w/app", name: "app" },
      { path: "/w/app/packages/ui", name: "ui" },
    ],
  };
  assert.equal(renameTestFile("packages/ui/x.test.ts", ONE, nested), "ui/x.test.ts");
});

test("Windows folders: forward-slash files, any case", () => {
  const one = { multi: false, folders: [{ path: "C:\\w\\app", name: "app" }] };
  const two = {
    multi: true,
    folders: [
      { path: "C:\\w\\app", name: "app" },
      { path: "D:\\api", name: "api" },
    ],
  };
  assert.equal(renameTestFile("src/a.test.ts", one, two), "app/src/a.test.ts");
  assert.equal(renameTestFile("app/src/a.test.ts", two, one), "src/a.test.ts");
});
