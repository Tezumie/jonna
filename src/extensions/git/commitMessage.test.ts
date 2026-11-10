import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanCommitMessage,
  commitPrompt,
  hunkContext,
  looksLikeCommitMessage,
  splitDiff,
} from "./commitMessage";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  "-old",
  "+new",
  "+more",
  "diff --git a/package-lock.json b/package-lock.json",
  "--- a/package-lock.json",
  "+++ b/package-lock.json",
  "@@ -1 +1 @@",
  "-x",
  "+y",
  "diff --git a/logo.png b/logo.png",
  "Binary files a/logo.png and b/logo.png differ",
].join("\n");

test("commit prompt: files with counts, style, capped diff without lockfiles (D174)", () => {
  const files = splitDiff(DIFF);
  assert.deepEqual(
    files.map((f) => [f.path, f.added, f.removed, f.binary]),
    [
      ["src/a.ts", 2, 1, false],
      ["package-lock.json", 1, 1, false],
      ["logo.png", 0, 0, true],
    ],
  );
  const prompt = commitPrompt({
    branch: "main",
    diff: DIFF,
    staged: true,
    recent: ["Fix the thing"],
  });
  assert.match(prompt, /- src\/a\.ts \(\+2 -1\)/);
  assert.match(prompt, /- logo\.png \(binary\)/);
  assert.match(prompt, /- Fix the thing/);
  assert.match(prompt, /\+more/);
  assert.doesNotMatch(prompt, /\+y/); // the lockfile is listed, not shown
  assert.match(prompt, /Output only the message\.$/);
  // One huge file doesn't take the whole budget.
  const big = `diff --git a/big.ts b/big.ts\n${"+x\n".repeat(5000)}diff --git a/small.ts b/small.ts\n+tiny\n`;
  const p = commitPrompt({ branch: null, diff: big, staged: false });
  assert.match(p, /rest of this file's diff left out/);
  assert.match(p, /\+tiny/);
  assert.ok(p.length < 24_000);
});

test("a review of the diff isn't a commit message; a message is cleaned (D174)", () => {
  const review =
    "The diff you've provided shows changes to several markdown files.\n\n---\n\n### ✅ **Key Features**\n- Search";
  assert.equal(looksLikeCommitMessage(review), false);
  assert.equal(looksLikeCommitMessage("### Summary\nAdd search history"), false);
  assert.equal(looksLikeCommitMessage("Here's a commit message:\n\nAdd x"), false);
  assert.equal(looksLikeCommitMessage("Add search history and folder tree"), true);
  // Conventional Commits, one line per change (VS Code's style).
  assert.equal(
    looksLikeCommitMessage("feat: add search history\n\ntest: cover the folder tree"),
    true,
  );
  assert.equal(
    looksLikeCommitMessage(
      "Add search history\n\n- Up/Down walks earlier queries\n- Saved per folder",
    ),
    true,
  );
  assert.equal(looksLikeCommitMessage("<think>hmm</think>```\nFix the build\n```"), true);
  assert.equal(
    cleanCommitMessage('Commit message: "**Add** `search` history ✨."\n- one\n* two'),
    "Add search history\n\n- one\n- two",
  );
  const long = cleanCommitMessage(
    "Add a very long summary line that goes on and on about everything that changed in this commit",
  );
  assert.ok(long.length <= 72, long);
  assert.equal(cleanCommitMessage("<think>still thinking"), "");
});

test("commit prompt: hunk context per file, the budget shared out (D201)", () => {
  const file = (name: string, n: number) =>
    `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,2 +1,2 @@ function ${name.replace(/\W/g, "")}() {\n${"+line\n".repeat(n)}`;
  const diff = file("big.ts", 3000) + file("small.ts", 3);
  const p = commitPrompt({ branch: "main", diff, staged: true });
  assert.match(p, /- big\.ts \(\+3000 -0\) — in: function bigts\(\)/);
  // The big file doesn't take the whole budget: the small one is shown too.
  assert.match(p, /diff --git a\/small\.ts/);
  assert.equal(hunkContext("@@ -1 +1 @@\n+x\n"), "");
});
