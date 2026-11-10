import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic } from "./engine";
import { countProblems } from "./problemCounts";

const d = (path: string, severity: Diagnostic["severity"]): Diagnostic =>
  ({ path, severity, line: 1, column: 1, message: "m" }) as Diagnostic;

test("counts errors and warnings per file and marks the folders above them", () => {
  const { files, dirs } = countProblems([
    d("/w/src/a.ts", "error"),
    d("/w/src/a.ts", "warning"),
    d("/w/src/a.ts", "info"),
    d("/w/lib/b.ts", "warning"),
    d("/w/lib/c.ts", "hint"),
  ]);
  assert.deepEqual(files.get("/w/src/a.ts"), { errors: 1, warnings: 1 });
  assert.deepEqual(files.get("/w/lib/b.ts"), { errors: 0, warnings: 1 });
  assert.equal(files.has("/w/lib/c.ts"), false);
  assert.equal(dirs.get("/w/src"), true);
  assert.equal(dirs.get("/w/lib"), false);
  // An error anywhere below makes the folder an error folder.
  assert.equal(dirs.get("/w"), true);
});

test("Windows paths are compared without case", () => {
  const { files, dirs } = countProblems([d("C:\\W\\Src\\A.ts", "error")]);
  assert.deepEqual(files.get("c:\\w\\src\\a.ts"), { errors: 1, warnings: 0 });
  assert.equal(dirs.get("c:\\w"), true);
});
