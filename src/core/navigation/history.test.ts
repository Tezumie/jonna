import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_ENTRIES, NavigationHistory } from "./history";

const at = (path: string, line: number, column = 1) => ({ path, line, column });

test("moves nearby update the current entry; far moves and other files add one", () => {
  const h = new NavigationHistory();
  h.record(at("/a.ts", 1));
  h.record(at("/a.ts", 5));
  assert.equal(h.snapshot().entries.length, 1);
  assert.equal(h.snapshot().entries[0]?.line, 5);
  h.record(at("/a.ts", 40));
  h.record(at("/b.ts", 3));
  assert.deepEqual(
    h.snapshot().entries.map((e) => `${e.path}:${e.line}`),
    ["/a.ts:5", "/a.ts:40", "/b.ts:3"],
  );
  assert.equal(h.canGoBack, true);
  assert.equal(h.canGoForward, false);
});

test("back and forward step through the places; arriving isn't a new move", () => {
  const h = new NavigationHistory();
  h.record(at("/a.ts", 1));
  h.record(at("/b.ts", 20));
  h.record(at("/c.ts", 7));
  assert.deepEqual(h.back(), at("/b.ts", 20));
  // A late event from the editor being left is ignored; the target reports where it landed.
  h.record(at("/c.ts", 8));
  h.record(at("/b.ts", 20, 4));
  assert.equal(h.snapshot().entries.length, 3);
  assert.equal(h.canGoForward, true);
  assert.deepEqual(h.back(), at("/a.ts", 1));
  assert.equal(h.back(), null);
  assert.deepEqual(h.forward(), at("/b.ts", 20, 4));
  assert.deepEqual(h.forward(), at("/c.ts", 7));
  assert.equal(h.forward(), null);
});

test("a new place after going back drops the ones ahead", () => {
  const h = new NavigationHistory();
  h.record(at("/a.ts", 1));
  h.record(at("/b.ts", 1));
  h.record(at("/c.ts", 1));
  h.back();
  h.landed();
  h.record(at("/d.ts", 1));
  assert.deepEqual(
    h.snapshot().entries.map((e) => e.path),
    ["/a.ts", "/b.ts", "/d.ts"],
  );
  assert.equal(h.canGoForward, false);
});

test("a nearby move after going back keeps the places ahead", () => {
  const h = new NavigationHistory();
  h.record(at("/a.ts", 1));
  h.record(at("/b.ts", 1));
  h.back();
  h.landed();
  h.record(at("/a.ts", 3));
  assert.equal(h.canGoForward, true);
});

test("keeps the newest entries", () => {
  const h = new NavigationHistory();
  for (let i = 0; i < MAX_ENTRIES + 5; i++) h.record(at(`/f${i}.ts`, 1));
  const { entries, index } = h.snapshot();
  assert.equal(entries.length, MAX_ENTRIES);
  assert.equal(entries[0]?.path, "/f5.ts");
  assert.equal(index, MAX_ENTRIES - 1);
});

test("removing a file's places merges the neighbors it separated", () => {
  const h = new NavigationHistory();
  h.record(at("/a.ts", 1));
  h.record(at("/gone.ts", 1));
  h.record(at("/a.ts", 2));
  h.record(at("/b.ts", 1));
  h.remove("/gone.ts");
  assert.deepEqual(
    h.snapshot().entries.map((e) => e.path),
    ["/a.ts", "/b.ts"],
  );
  assert.equal(h.snapshot().index, 1);
  h.clear();
  assert.equal(h.canGoBack, false);
});

test("going back within one file ignores the old place's late event", () => {
  const h = new NavigationHistory();
  h.record(at("/a.ts", 5));
  h.record(at("/a.ts", 40));
  assert.deepEqual(h.back(), at("/a.ts", 5));
  h.record(at("/a.ts", 40));
  h.record(at("/a.ts", 5, 2));
  assert.deepEqual(
    h.snapshot().entries.map((e) => e.line),
    [5, 40],
  );
  assert.equal(h.canGoForward, true);
});

test("removing a file keeps the index on the place it was, when neighbors merge", () => {
  const h = new NavigationHistory();
  h.record({ path: "/a.ts", line: 1, column: 1 });
  h.record({ path: "/b.ts", line: 1, column: 1 });
  h.record({ path: "/a.ts", line: 3, column: 1 });
  h.record({ path: "/c.ts", line: 1, column: 1 });
  h.back();
  h.landed(); // on a.ts:3
  h.remove("/b.ts"); // a.ts:1 and a.ts:3 merge
  const { entries, index } = h.snapshot();
  assert.deepEqual(
    entries.map((e) => e.path),
    ["/a.ts", "/c.ts"],
  );
  assert.equal(entries[index]?.path, "/a.ts");
});
