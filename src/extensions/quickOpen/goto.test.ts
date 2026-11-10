import assert from "node:assert/strict";
import { test } from "node:test";
import { indexItemFile, parseQuickOpen, pushRecent } from "./goto";

test("parses file, line and column suffixes", () => {
  assert.deepEqual(parseQuickOpen("main.ts"), { file: "main.ts" });
  assert.deepEqual(parseQuickOpen("main.ts:12"), { file: "main.ts", line: 12 });
  assert.deepEqual(parseQuickOpen("src/a b.ts:3:7 "), { file: "src/a b.ts", line: 3, column: 7 });
  assert.deepEqual(parseQuickOpen(":40"), { file: "", line: 40 });
});

test("recent list keeps the newest first without duplicates", () => {
  assert.deepEqual(pushRecent(["a", "b", "c"], "b"), ["b", "a", "c"]);
  assert.deepEqual(pushRecent(["a"], "z", 1), ["z"]);
});

test("an index item becomes an absolute path and a workspace path", () => {
  const item = { path: "src/a.ts", positions: [0, 4] };
  // One folder: as the index says.
  assert.deepEqual(indexItemFile(item, [{ path: "/w", name: "w" }], "/w"), {
    path: "/w/src/a.ts",
    rel: "src/a.ts",
    positions: [0, 4],
  });
  const folders = [
    { path: "/w", name: "web" },
    { path: "C:\\x\\api", name: "api" },
  ];
  // The first folder's items carry no root.
  assert.deepEqual(indexItemFile(item, folders, "/w"), {
    path: "/w/src/a.ts",
    rel: "web/src/a.ts",
    positions: [4, 8],
  });
  assert.deepEqual(indexItemFile({ ...item, root: "C:\\x\\api" }, folders, "/w"), {
    path: "C:\\x\\api\\src\\a.ts",
    rel: "api/src/a.ts",
    positions: [4, 8],
  });
});
