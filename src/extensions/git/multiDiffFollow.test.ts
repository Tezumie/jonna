import assert from "node:assert/strict";
import { test } from "node:test";
import { changesSource } from "./changesTab";
import { followedChanges } from "./multiDiffFollow";

test("only the repositories' open changes tabs are followed", () => {
  assert.equal(changesSource("/r", false), "git:changes:/r");
  assert.equal(changesSource("/r", true), "git:staged:/r");
  const open = new Set(["git:staged:/a", "git:changes:/b", "commit:abc", "git:changes:/gone"]);
  assert.deepEqual(followedChanges(open, ["/a", "/b"]), [
    { root: "/a", staged: true },
    { root: "/b", staged: false },
  ]);
  assert.deepEqual(followedChanges(new Set(), ["/a"]), []);
});
