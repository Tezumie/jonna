import assert from "node:assert/strict";
import { test } from "node:test";
import { blameAge, cloneErrorHint, normalizeCloneUrl } from "./cloneBlame";

test("clone URLs: shorthand, hosts without scheme, full URLs and paths as given", () => {
  assert.equal(normalizeCloneUrl("vercel/next.js"), "https://github.com/vercel/next.js.git");
  assert.equal(normalizeCloneUrl(" owner/repo.git "), "https://github.com/owner/repo.git");
  assert.equal(normalizeCloneUrl("github.com/a/b"), "https://github.com/a/b");
  assert.equal(normalizeCloneUrl("git clone https://x.org/a.git"), "https://x.org/a.git");
  assert.equal(normalizeCloneUrl("git@github.com:a/b.git"), "git@github.com:a/b.git");
  assert.equal(normalizeCloneUrl("C:\\repos\\a"), "C:\\repos\\a");
  assert.equal(normalizeCloneUrl("../a"), "../a");
  assert.match(cloneErrorHint("fatal: Authentication failed for 'x'"), /sign-in/);
  assert.equal(blameAge(1000, 1000 + 3 * 86400), "3 days ago");
  assert.equal(blameAge(1000, 1030), "just now");
});
