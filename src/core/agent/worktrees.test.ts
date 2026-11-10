import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bestOfBranches,
  chatsInBatch,
  DEFAULT_COPY,
  DIFF_BUSY_MS,
  DIFF_IDLE_MS,
  diffTotals,
  elapsedText,
  modelSlug,
  nextIndex,
  outputTail,
  planWorktreeRead,
  portSettings,
  progressFromChat,
  pruneAgents,
  setupConfig,
  slimChat,
  type WorktreeAgent,
  worktreeEnv,
} from "./worktrees";

test("overview reads: a chat only when its stamp moved, git's diff after it or when quiet", () => {
  // First tick: everything.
  assert.deepEqual(planWorktreeRead(undefined, null, 0), { readChat: true, readDiff: true });
  const cache = { stamp: "10:1", chat: null, diffAt: 1000, dirty: false };
  // Nothing moved: no reads until the quiet interval.
  assert.deepEqual(planWorktreeRead(cache, "10:1", 3000), { readChat: false, readDiff: false });
  assert.deepEqual(planWorktreeRead(cache, "10:1", 1000 + DIFF_IDLE_MS), {
    readChat: false,
    readDiff: true,
  });
  // The chat moved: read it; the diff waits for the busy interval…
  assert.deepEqual(planWorktreeRead(cache, "12:2", 2000), { readChat: true, readDiff: false });
  // …and comes once it's up, even when the chat has gone quiet meanwhile (dirty).
  assert.deepEqual(
    planWorktreeRead({ ...cache, stamp: "12:2", dirty: true }, "12:2", 1000 + DIFF_BUSY_MS),
    {
      readChat: false,
      readDiff: true,
    },
  );
  // A chat that was deleted (stamp gone) is read again (and reads as missing).
  assert.equal(planWorktreeRead(cache, null, 2000).readChat, true);
});

test("a slim chat keeps what the progress reads", () => {
  const saved = {
    meta: { status: "running", updated: 5, title: "T" },
    messages: [{ role: "user", content: "x".repeat(1000) }],
    changeset: [{ path: "a.ts", before: "…", after: "…" }, { nope: 1 }],
    applied: { "1#b.ts": { big: "…" } },
  };
  const slim = slimChat(saved);
  assert.deepEqual(slim, {
    meta: saved.meta,
    changeset: [{ path: "a.ts" }],
    applied: { "1#b.ts": true },
  });
  assert.deepEqual(progressFromChat(slim, 6), progressFromChat(saved, 6));
  assert.equal(slimChat(null), null);
});

test("ports: a block per worktree, indexes reused", () => {
  assert.equal(nextIndex([]), 1);
  assert.equal(nextIndex([{ index: 1 }, { index: 3 }]), 2);
  const ports = portSettings(undefined, undefined);
  assert.deepEqual(ports, { base: 3000, step: 10 });
  assert.deepEqual(worktreeEnv(2, ports), {
    PORT: "3020",
    WORKTREE_INDEX: "2",
    WORKTREE_PORT_BASE: "3020",
    WORKTREE_PORT_STEP: "10",
  });
  assert.deepEqual(portSettings(80, 0), { base: 1024, step: 1 });
});

test("setup settings and output", () => {
  assert.deepEqual(setupConfig(" npm ci ", undefined, undefined), {
    script: "npm ci",
    files: DEFAULT_COPY,
    timeoutMs: 600_000,
  });
  assert.deepEqual(setupConfig(null, [".env", 3, ""], 30).files, [".env"]);
  assert.equal(setupConfig("", [], 99999).timeoutMs, 3_600_000);
  assert.equal(outputTail("a\r\nb\nc\n", 2), "b\nc");
});

test("best-of-N branches: one per model, unique", () => {
  assert.equal(modelSlug("anthropic/claude-sonnet-4.5"), "claude-sonnet-4-5");
  assert.equal(modelSlug("ollama/qwen3:8b"), "qwen3-8b");
  assert.deepEqual(
    bestOfBranches(
      "agent/fix-login",
      ["ollama/qwen3:8b", "openai/gpt-5", "ollama/qwen3:8b"],
      new Set(["agent/fix-login-gpt-5"]),
    ),
    ["agent/fix-login-qwen3-8b", "agent/fix-login-gpt-5-2", "agent/fix-login-qwen3-8b-3"],
  );
});

test("progress from another window's saved chat", () => {
  const now = 1_000_000;
  assert.equal(progressFromChat(null, now).state, "starting");
  const working = progressFromChat(
    {
      meta: { status: "running", updated: now - 1000, title: "Fix it" },
      changeset: [{ path: "a.ts" }, { path: "b.ts" }],
      applied: { "1#a.ts": {}, "2#c.ts": {} },
    },
    now,
  );
  assert.deepEqual(working, { state: "working", updated: now - 1000, title: "Fix it", changed: 3 });
  // Not saved for long and nothing knows the window: stopped (D207; it was "done" before).
  assert.equal(progressFromChat({ meta: { status: "running", updated: 0 } }, now).state, "stopped");
  assert.equal(progressFromChat({ meta: { status: "waiting" } }, now).state, "waiting");
  assert.equal(progressFromChat({ meta: { status: "idle", error: true } }, now).state, "error");
  assert.equal(progressFromChat({ meta: { status: "idle" } }, now).state, "done");
});

test("progress: a closed window shows Stopped at once, an open one isn't stale (D207)", () => {
  const now = 10_000_000;
  const running = { meta: { status: "running", updated: now - 1000 } };
  assert.equal(progressFromChat(running, now, undefined, false).state, "stopped");
  assert.equal(
    progressFromChat({ meta: { status: "waiting" } }, now, undefined, false).state,
    "stopped",
  );
  assert.equal(progressFromChat({ meta: { status: "idle" } }, now, undefined, false).state, "done");
  assert.equal(progressFromChat(null, now, undefined, false).state, "stopped");
  // A long model call: no save for a while, but the window is open.
  const quiet = { meta: { status: "running", updated: 0 } };
  assert.equal(progressFromChat(quiet, now, undefined, true).state, "working");
  assert.equal(progressFromChat(running, now, undefined, null).state, "working");
});

test("small helpers", () => {
  assert.equal(elapsedText(45_000), "45 s");
  assert.equal(elapsedText(12 * 60_000), "12 min");
  assert.equal(elapsedText(125 * 60_000), "2 h 5 min");
  assert.deepEqual(
    diffTotals([
      { added: 3, removed: 1 },
      { added: null, removed: null },
    ]),
    { files: 2, added: 3, removed: 1 },
  );
  const a = { folder: "/w/A" } as WorktreeAgent;
  const b = { folder: "/w/b" } as WorktreeAgent;
  assert.deepEqual(
    pruneAgents([a, b], new Set(["/w/a"]), (p) => p.toLowerCase()),
    [a],
  );
});

test("worktrees: a batch of saved-chat changes names the agents' chats (D233)", () => {
  const paths = [
    "C:\\data\\agent\\sessions\\a1.json",
    "C:\\data\\agent\\sessions\\.a1.json.tmp-12-3",
    "/home/u/.data/agent/sessions/b2.json",
    "/home/u/.data/agent/sessions/other.json",
    "/home/u/.data/agent/sessions/b2.json",
  ];
  assert.deepEqual(chatsInBatch(paths, ["a1", "b2", "c3"]).sort(), ["a1", "b2"]);
  assert.deepEqual(chatsInBatch(["/x/.c3.json.tmp-1"], ["c3"]), []);
  assert.deepEqual(chatsInBatch([], ["a1"]), []);
});
