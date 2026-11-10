import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanCommitMessage } from "./commitMessage";
import { refNameProblem } from "./workflow";

test("branch and tag names", () => {
  assert.equal(refNameProblem("feature/login"), undefined);
  assert.equal(refNameProblem("v1.2.0"), undefined);
  for (const bad of ["", "has space", "-x", "a..b", "x.lock", "end/", "a~1", "q?"])
    assert.ok(refNameProblem(bad), bad);
});

test("model replies become commit messages", () => {
  assert.equal(cleanCommitMessage("```\nFix login redirect\n```"), "Fix login redirect");
  assert.equal(cleanCommitMessage('"Add tasks view"'), "Add tasks view");
  assert.equal(
    cleanCommitMessage("Add tasks\n\nRuns tasks.json in terminals."),
    "Add tasks\n\nRuns tasks.json in terminals.",
  );
});
