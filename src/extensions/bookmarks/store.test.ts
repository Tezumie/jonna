import assert from "node:assert/strict";
import { test } from "node:test";
import { renamedPath } from "../../workbench/gutterMarks";
import { BookmarkStore } from "./store";

test("bookmarks: toggle, order, next / previous across files", () => {
  const s = new BookmarkStore();
  s.toggle("/w/b.ts", 10);
  s.toggle("/w/a.ts", 5);
  s.add("/w/a.ts", 20, "todo");
  assert.deepEqual(
    s.list.peek().map((b) => `${b.path}:${b.line}`),
    ["/w/a.ts:5", "/w/a.ts:20", "/w/b.ts:10"],
  );
  assert.equal(s.toggle("/w/a.ts", 5), null);
  s.add("/w/a.ts", 5);
  assert.equal(s.next("/w/a.ts", 5, 1)?.line, 20);
  assert.equal(s.next("/w/a.ts", 20, 1)?.path, "/w/b.ts");
  assert.equal(s.next("/w/b.ts", 10, 1)?.line, 5, "wraps to the first");
  assert.equal(s.next("/w/a.ts", 5, -1)?.path, "/w/b.ts", "wraps to the last");
  assert.equal(s.next("/w/a.ts", 7, -1)?.line, 5);
  assert.equal(s.next("/w/c.ts", 1, 1)?.path, "/w/a.ts");
  // Relabel without duplicating.
  s.add("/w/a.ts", 20);
  assert.equal(s.at("/w/a.ts", 20)?.label, undefined);
  assert.equal(s.forPath("/w/a.ts").length, 2);
});

test("bookmarks follow edits and renames, and persist", () => {
  const s = new BookmarkStore();
  s.add("/w/src/a.ts", 3);
  s.add("/w/src/a.ts", 8, "here");
  s.moveLines("/w/src/a.ts", [4, 9]);
  assert.deepEqual(
    s.forPath("/w/src/a.ts").map((b) => b.line),
    [4, 9],
  );
  s.moveLines("/w/src/a.ts", [4, 4]);
  assert.equal(s.forPath("/w/src/a.ts").length, 1);
  s.add("/w/src/a.ts", 9, "here");
  s.renamed("/w/src", "/w/lib");
  assert.equal(s.forPath("/w/lib/a.ts").length, 2);
  s.renamed("/w/lib/a.ts", "/w/lib/b.ts");
  assert.equal(s.forPath("/w/lib/b.ts").length, 2);
  const t = new BookmarkStore();
  t.restore(JSON.parse(JSON.stringify(s.save())));
  assert.deepEqual(t.save(), s.save());
  t.restore([{ path: 1 }, { path: "/x", line: 0 }]);
  assert.equal(t.list.peek().length, 0);
  assert.equal(s.clear("/w/lib/b.ts"), 2);

  assert.equal(renamedPath("/w/a/b.ts", "/w/a", "/w/z"), "/w/z/b.ts");
  assert.equal(renamedPath("/w/ab/b.ts", "/w/a", "/w/z"), null);
  assert.equal(renamedPath("C:\\w\\a\\b.ts", "C:\\w\\a", "C:\\w\\z"), "C:\\w\\z\\b.ts");
});
