import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changedFiles,
  chatWorktreeBranch,
  enteredText,
  leftText,
  parseChatWorktree,
  removalLoss,
} from "./chatWorktree";

test("D337: a chat's worktree branch comes from its name, or the chat", () => {
  assert.deepEqual(chatWorktreeBranch("fix login", "s-abc123"), { branch: "agent/fix-login" });
  assert.deepEqual(chatWorktreeBranch("agent/feat/new ui!", "s1"), { branch: "agent/feat/new-ui" });
  assert.deepEqual(chatWorktreeBranch("..weird..name..", "s1"), { branch: "agent/weird.name" });
  assert.deepEqual(chatWorktreeBranch(undefined, "s-1a2b3c4d5e"), {
    branch: "agent/chat-2b3c4d5e",
  });
  assert.deepEqual(chatWorktreeBranch("  ", "s9"), { branch: "agent/chat-s9" });
  assert.ok("error" in chatWorktreeBranch("!!!", "s1"));
  assert.ok("error" in chatWorktreeBranch(5, "s1"));
  const long = chatWorktreeBranch("x".repeat(100), "s1");
  assert.ok("branch" in long && long.branch.length === "agent/".length + 64);
});

test("D337: a saved worktree comes back only when whole", () => {
  const w = { folder: "/r.wt", branch: "agent/x", agent: "s1", from: "/r", created: true };
  assert.deepEqual(parseChatWorktree(w), w);
  assert.deepEqual(parseChatWorktree({ ...w, created: "yes" }), { ...w, created: false });
  assert.equal(parseChatWorktree({ ...w, folder: "" }), null);
  assert.equal(parseChatWorktree("x"), null);
  assert.equal(parseChatWorktree(null), null);
});

test("D337: removing asks when it would lose changes or commits", () => {
  assert.equal(changedFiles(" M a.ts\n?? b.ts\n\n"), 2);
  assert.equal(changedFiles(""), 0);
  assert.equal(removalLoss({ changed: 0, commits: 0 }), null);
  assert.equal(
    removalLoss({ changed: 1, commits: 2 }),
    "It has 1 uncommitted change and 2 commits not merged: removing it deletes them.",
  );
  assert.equal(
    removalLoss({ changed: 3, commits: 0 }),
    "It has 3 uncommitted changes: removing it deletes them.",
  );
});

test("D337: what the model is told on the way in and out", () => {
  const w = { folder: "/r.wt", branch: "agent/x", agent: "s1", from: "/r", created: true };
  assert.match(
    enteredText(w),
    /working in a git worktree: \/r\.wt \(branch agent\/x, new, from \/r\)/,
  );
  assert.match(leftText(w, "keep"), /branch agent\/x and its folder stay/);
  assert.match(leftText(w, "remove"), /^Removed the worktree \/r\.wt/);
});
