import assert from "node:assert/strict";
import { test } from "node:test";
import {
  autoMergeAllowed,
  autoMergeLine,
  headMoved,
  judgedHead,
  mergeDecision,
  mergedByIdeText,
  mergeFailedText,
  mergeMethod,
} from "./prAutoMerge";
import { type PrSnapshot, prSnapshot } from "./prWatch";

const check = (name: string, conclusion: string | null) =>
  conclusion
    ? { name, status: "COMPLETED", conclusion }
    : { name, status: "IN_PROGRESS", conclusion: null };

/** A snapshot as `gh pr view` gives it, with `extra` over a ready pull request. */
function pr(extra: Record<string, unknown> = {}): PrSnapshot {
  return prSnapshot(
    {
      number: 7,
      title: "Add the feature",
      url: "https://github.com/o/r/pull/7",
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      isDraft: false,
      statusCheckRollup: [check("build", "SUCCESS"), check("test", "SUCCESS")],
      comments: [],
      ...extra,
    },
    null,
  );
}

test("the snapshot reads review, draft, auto-merge and merge state", () => {
  const s = pr({ autoMergeRequest: { mergeMethod: "SQUASH" }, reviewDecision: "review_required" });
  assert.equal(s.reviewDecision, "REVIEW_REQUIRED");
  assert.equal(s.autoMerge, true);
  assert.equal(s.mergeState, "CLEAN");
  assert.equal(pr({ autoMergeRequest: null }).autoMerge, false);
});

test("ready: every check passed, approved, mergeable", () => {
  assert.deepEqual(mergeDecision(pr()), { ready: true });
  // No review required ("") and no checks at all: nothing to wait for.
  assert.deepEqual(mergeDecision(pr({ reviewDecision: "", statusCheckRollup: [] })), {
    ready: true,
  });
});

test("not ready, with the reason", () => {
  const reason = (extra: Record<string, unknown>) => {
    const d = mergeDecision(pr(extra));
    return d.ready ? "ready" : d.reason;
  };
  assert.match(
    reason({ statusCheckRollup: [check("b", "SUCCESS"), check("t", null)] }),
    /1 check still running/,
  );
  assert.match(reason({ statusCheckRollup: [check("t", "FAILURE")] }), /1 check failing/);
  assert.match(reason({ reviewDecision: "REVIEW_REQUIRED" }), /approving review/);
  assert.match(reason({ reviewDecision: "CHANGES_REQUESTED" }), /changes were requested/);
  assert.match(reason({ mergeable: "CONFLICTING" }), /merge conflict/);
  assert.match(reason({ mergeable: "UNKNOWN" }), /still working out/);
  assert.match(reason({ mergeStateStatus: "BLOCKED" }), /rules block it/);
  assert.match(reason({ isDraft: true }), /draft/);
  const merged = mergeDecision(pr({ state: "MERGED" }));
  assert.ok(!merged.ready && "ended" in merged);
});

test("a pull request that had checks isn't ready while its newest commit has none", () => {
  const none = pr({ reviewDecision: "", statusCheckRollup: [] });
  const waiting = mergeDecision(none, true);
  assert.ok(!waiting.ready);
  assert.match(waiting.ready ? "" : waiting.reason, /haven't started on the newest commit/);
  // One that never had any: nothing to wait for, as before.
  assert.deepEqual(mergeDecision(none, false), { ready: true });
  // Once they are there and passed, it is ready again.
  assert.deepEqual(mergeDecision(pr(), true), { ready: true });
  assert.match(
    autoMergeLine({ method: "merge", mode: "ide", since: 0 }, none, true),
    /waiting: its checks haven't started/,
  );
});

test("the merge is pinned to the commit the decision was made on, when the view names it", () => {
  const head = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(pr({ headRefOid: head }).head, head);
  assert.equal(judgedHead(pr({ headRefOid: head })), head);
  assert.equal(pr().head, undefined);
  assert.equal(judgedHead(pr()), undefined);
  assert.equal(judgedHead(pr({ headRefOid: "--admin" })), undefined);
  // Refused because a push landed in between: auto-merge stays on for the next look.
  assert.equal(
    headMoved("GraphQL: Head branch was modified. Review and try the merge again."),
    true,
  );
  assert.equal(headMoved("Head sha didn't match expected value"), true);
  assert.equal(
    headMoved("Pull request is not mergeable: the base branch policy prohibits it"),
    false,
  );
});

test("the method, the repository's setting and the messages", () => {
  assert.equal(mergeMethod("squash"), "squash");
  assert.equal(mergeMethod("--admin"), "merge");
  assert.equal(autoMergeAllowed({ autoMergeAllowed: true }), true);
  assert.equal(autoMergeAllowed({ autoMergeAllowed: false }), false);
  assert.equal(autoMergeAllowed(null), false);
  const merged = mergedByIdeText(pr(), "squash");
  assert.match(
    merged.split("\n")[0] ?? "",
    /^Pull request #7 \(Add the feature\): merged by auto-merge \(squash\)$/,
  );
  assert.match(merged, /all 2 checks passed, approved, mergeable/);
  assert.match(
    mergeFailedText(pr(), "not allowed"),
    /merge failed: not allowed\. Auto-merge is off/,
  );
  assert.equal(
    autoMergeLine({ method: "rebase", mode: "ide", since: 0 }, pr({ mergeable: "CONFLICTING" })),
    "auto-merge (rebase) by the IDE · waiting: it has a merge conflict",
  );
  assert.equal(
    autoMergeLine({ method: "squash", mode: "github", since: 0 }, pr()),
    "auto-merge (squash) by GitHub · ready",
  );
});
