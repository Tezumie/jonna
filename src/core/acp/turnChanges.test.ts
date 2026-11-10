import assert from "node:assert/strict";
import { test } from "node:test";
import {
  baselineAfterSave,
  bulkCreatedFolders,
  candidates,
  changedByAgent,
  compareSnaps,
  ignoredPath,
  joinPath,
  relativeTo,
  type StepWindow,
  treeChanges,
} from "./turnChanges";

test("compareSnaps: edits, creations, deletions, other files (D208)", () => {
  const text = (t: string) => ({ kind: "text" as const, text: t });
  const missing = { kind: "missing" as const };
  assert.equal(compareSnaps("/a", text("x"), text("x")), null);
  assert.equal(compareSnaps("/a", undefined, text("x")), null);
  assert.deepEqual(compareSnaps("/a", text("x"), text("y")), {
    kind: "text",
    change: { path: "/a", before: "x", after: "y" },
  });
  assert.deepEqual(compareSnaps("/a", missing, text("new")), {
    kind: "text",
    change: { path: "/a", before: null, after: "new" },
  });
  assert.deepEqual(compareSnaps("/a", text("old"), missing), {
    kind: "text",
    change: { path: "/a", before: "old", after: null },
  });
  assert.equal(compareSnaps("/a", missing, missing), null);
  assert.equal(
    compareSnaps("/i.png", { kind: "other", sig: "1" }, { kind: "other", sig: "1" }),
    null,
  );
  assert.deepEqual(
    compareSnaps("/i.png", { kind: "other", sig: "1" }, { kind: "other", sig: "2" }),
    {
      kind: "other",
      path: "/i.png",
    },
  );
});

test("paths: joined, relative, ignored, candidates (D208)", () => {
  assert.equal(joinPath("C:\\p\\", "src/a.ts", true), "C:\\p\\src\\a.ts");
  assert.equal(joinPath("/p", "src/a.ts", false), "/p/src/a.ts");
  assert.equal(relativeTo("C:\\P", "c:\\p\\src\\a.ts", true), "src/a.ts");
  assert.equal(relativeTo("/p", "/p/src/a.ts", false), "src/a.ts");
  assert.equal(relativeTo("/p", "/pq/a.ts", false), null);
  assert.equal(relativeTo("/p", "/p", false), null);
  assert.equal(ignoredPath(".git/index"), true);
  assert.equal(ignoredPath("web/node_modules/x/y.js"), true);
  assert.equal(ignoredPath("src/git.ts"), false);
  assert.deepEqual(candidates([["C:\\p\\a"], ["c:\\P\\A", "C:\\p\\b"]], true), [
    "C:\\p\\a",
    "C:\\p\\b",
  ]);
  assert.deepEqual(candidates([["/a", "/b", "/c"]], false, 2), ["/a", "/b"]);
});

test("treeChanges: changed, created and deleted files without git (D233)", () => {
  const f = (path: string, size: number, mtimeMs: number) => ({ path, size, mtimeMs });
  const before = [f("a.ts", 1, 10), f("b.ts", 2, 10), f("gone.ts", 3, 10), f("same.ts", 4, 10)];
  const after = [f("a.ts", 1, 11), f("b.ts", 5, 10), f("new.ts", 1, 12), f("same.ts", 4, 10)];
  assert.deepEqual(treeChanges(before, after).sort(), ["a.ts", "b.ts", "gone.ts", "new.ts"]);
  // A listing cut short: neither "new" nor "gone" can be told from past the cut.
  assert.deepEqual(treeChanges(before, after, true).sort(), ["a.ts", "b.ts"]);
});

test("baselineAfterSave: the agent's write before the user's save is credited (D233)", () => {
  assert.equal(baselineAfterSave(100, 200), "start");
  assert.equal(baselineAfterSave(300, 200), "save");
  assert.equal(baselineAfterSave(undefined, 200), "save");
});

test("bulkCreatedFolders: a folder a command filled, not files added to existing ones (D294)", () => {
  const before = [
    { path: "README.md", size: 1, mtimeMs: 1 },
    { path: "src/a.ts", size: 1, mtimeMs: 1 },
  ];
  const clone = Array.from({ length: 120 }, (_, i) => `freqtrade/pkg/f${i}.py`);
  const few = ["notes/one.md", "notes/two.md"];
  const inSrc = Array.from({ length: 150 }, (_, i) => `src/gen${i}.ts`);
  const found = bulkCreatedFolders(before, [...clone, ...few, ...inSrc, "top.txt"]);
  assert.deepEqual([...found], [["freqtrade", 120]]);
  // Windows separators too; a new folder inside an existing one is the one counted.
  const nested = Array.from({ length: 100 }, (_, i) => `src\\vendor\\lib\\x${i}.js`);
  assert.deepEqual([...bulkCreatedFolders(before, nested)], [["src/vendor", 100]]);
});

test("changedByAgent: only while a step that can write ran (D403)", () => {
  const steps: StepWindow[] = [
    { kind: "read", start: 1000, end: 2000 },
    { kind: "execute", start: 10_000, end: 12_000 },
    { kind: "edit", start: 20_000, end: null },
  ];
  // During a command, or just after it (flush, clock).
  assert.equal(changedByAgent(11_000, steps, 30_000, 0, 500), true);
  assert.equal(changedByAgent(12_400, steps, 30_000, 0, 500), true);
  // Between steps, or while only a read ran: something else's.
  assert.equal(changedByAgent(15_000, steps, 30_000, 0, 500), false);
  assert.equal(changedByAgent(1500, steps, 30_000, 0, 500), false);
  // A step still running reaches to now.
  assert.equal(changedByAgent(29_000, steps, 30_000, 0, 500), true);
  // No time (deleted): the agent's, as before.
  assert.equal(changedByAgent(null, steps, 30_000), true);
  // A time from before the turn (a moved or copied file keeps its source's), or none at all
  // (0): the agent's (D407).
  assert.equal(changedByAgent(500, steps, 30_000, 900, 100), true);
  assert.equal(changedByAgent(0, steps, 30_000, 900), true);
  assert.equal(changedByAgent(15_000, steps, 30_000, 900, 500), false);
  // An agent that reports no steps: nothing to judge by, so its own (as before).
  assert.equal(changedByAgent(5000, [], 30_000), true);
});
