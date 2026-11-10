import assert from "node:assert/strict";
import { test } from "node:test";
import { viewKey } from "../../workbench/scrollMemory";
import { EDITOR_POSITION_CAP, EditorPositions } from "./positions";

test("EditorPositions: remembers, follows renames, keeps the most recent (D190)", () => {
  const p = new EditorPositions();
  let changes = 0;
  p.onChange = () => changes++;
  p.set("/w/a.ts", { top: 10.5, line: 20, column: 3 });
  p.set("/w/a.ts", { top: 10.5, line: 20, column: 3 });
  assert.equal(changes, 1, "the same spot again isn't a change");
  p.rename("/w/a.ts", "/w/b.ts");
  assert.equal(p.get("/w/a.ts"), undefined);
  assert.deepEqual(p.get("/w/b.ts"), { path: "/w/b.ts", top: 10.5, line: 20, column: 3 });
  p.set("/w/src/x.ts", { top: 1, line: 2, column: 3 });
  p.rename("/w/src", "/w/lib");
  assert.equal(p.get("/w/lib/x.ts")?.line, 2, "a folder's files follow it");
  assert.equal(p.get("/w/src/x.ts"), undefined);
  for (let i = 0; i < EDITOR_POSITION_CAP + 5; i++)
    p.set(`/w/f${i}.ts`, { top: 0, line: 1, column: 1 });
  assert.equal(p.save().length, EDITOR_POSITION_CAP);
  assert.equal(p.get("/w/b.ts"), undefined, "the oldest went first");
});

test("EditorPositions: load keeps only valid entries", () => {
  const p = new EditorPositions();
  p.load([
    { path: "/w/a.ts", top: 3, line: 4, column: 1 },
    { path: "/w/b.ts", top: -2, line: 2, column: 2 },
    { path: "/w/c.ts", top: 1, line: 0, column: 1 },
    { top: 1, line: 1, column: 1 },
    "junk",
  ]);
  assert.equal(p.save().length, 2);
  assert.equal(p.get("/w/b.ts")?.top, 0);
  p.load(null);
  assert.equal(p.save().length, 0);
});

test("viewKey: the same state in any key order is the same view", () => {
  assert.equal(viewKey("md", { path: "a", side: true }), viewKey("md", { side: true, path: "a" }));
  assert.notEqual(viewKey("md", { path: "a" }), viewKey("md", { path: "b" }));
});
