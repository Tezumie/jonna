import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isUntitled,
  nextUntitled,
  suggestedName,
  untitledFor,
  untitledName,
  untitledTarget,
} from "./untitled";

test("an untitled document for a file that doesn't exist yet: named after it, saved there", () => {
  const win = untitledFor("C:\\w\\docs\\notes.md");
  assert.ok(isUntitled(win));
  assert.equal(untitledTarget(win), "C:\\w\\docs\\notes.md");
  assert.equal(untitledName(win), "notes.md");
  assert.equal(untitledName(untitledFor("/home/a/new.ts")), "new.ts");
  assert.equal(untitledTarget("untitled:Untitled-1"), null);
  assert.equal(untitledTarget("/a/b.txt"), null);
  assert.equal(nextUntitled([win]), "untitled:Untitled-1");
});

test("untitled paths: names and the next free number", () => {
  assert.ok(isUntitled("untitled:Untitled-1"));
  assert.ok(!isUntitled("/a/b.txt"));
  assert.equal(untitledName("untitled:Untitled-3"), "Untitled-3");
  assert.equal(nextUntitled([]), "untitled:Untitled-1");
  assert.equal(
    nextUntitled(["untitled:Untitled-1", "/x", "untitled:Untitled-3"]),
    "untitled:Untitled-2",
  );
});

test("suggestedName: the first line, without comment markers or bad characters", () => {
  assert.equal(suggestedName("\n# Shopping list\n- eggs"), "Shopping list");
  assert.equal(suggestedName("// a/b: notes?"), "ab notes");
  assert.equal(suggestedName("   \n", "Untitled-2"), "Untitled-2");
});
