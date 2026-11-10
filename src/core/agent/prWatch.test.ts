import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkOutcome,
  diffPr,
  endsWatch,
  nextPollDelay,
  PR_MAX_BACKOFF_MS,
  PR_POLL_MS,
  type PrSnapshot,
  prEventText,
  prSnapshot,
  prStatusLine,
} from "./prWatch";

const view = (over: Record<string, unknown> = {}) => ({
  number: 7,
  title: "Add the feature",
  url: "https://github.com/o/r/pull/7",
  state: "OPEN",
  mergeable: "MERGEABLE",
  statusCheckRollup: [
    { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "test", status: "IN_PROGRESS", conclusion: null },
  ],
  comments: [{ author: { login: "amy" }, body: "Nice", createdAt: "2026-01-01T00:00:00Z" }],
  ...over,
});

const threads = (comments: { id: number; body: string }[], resolved = false) => ({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [
            {
              isResolved: resolved,
              path: "src/a.ts",
              line: 12,
              comments: {
                nodes: comments.map((c) => ({
                  databaseId: c.id,
                  body: c.body,
                  author: { login: "rev" },
                })),
              },
            },
          ],
        },
      },
    },
  },
});

test("check outcomes from check runs and commit statuses", () => {
  assert.equal(checkOutcome({ status: "COMPLETED", conclusion: "FAILURE" }), "fail");
  assert.equal(checkOutcome({ status: "COMPLETED", conclusion: "SKIPPED" }), "pass");
  assert.equal(checkOutcome({ status: "QUEUED" }), "pending");
  assert.equal(checkOutcome({ state: "SUCCESS" }), "pass");
  assert.equal(checkOutcome({ state: "ERROR" }), "fail");
  assert.equal(checkOutcome({ state: "PENDING" }), "pending");
});

test("a snapshot reads checks, mergeable, conversation and unresolved review comments", () => {
  const s = prSnapshot(view(), threads([{ id: 5, body: "Rename this" }]));
  assert.equal(s.number, 7);
  assert.deepEqual(
    s.checks.map((c) => c.outcome),
    ["pass", "pending"],
  );
  assert.equal(s.comments.length, 2);
  assert.deepEqual(s.comments[1], {
    id: "r:5",
    author: "rev",
    body: "Rename this",
    path: "src/a.ts",
    line: 12,
  });
  // Resolved threads aren't news; a failed threads query leaves just the conversation.
  assert.equal(prSnapshot(view(), threads([{ id: 5, body: "x" }], true)).comments.length, 1);
  assert.equal(prSnapshot(view(), null).comments.length, 1);
  assert.equal(prStatusLine(s), "checks: 1 pending, 1 passing; mergeable; 2 comments");
});

test("the first snapshot is the baseline: nothing to tell", () => {
  const s = prSnapshot(
    view({ statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "FAILURE" }] }),
    null,
  );
  assert.deepEqual(diffPr(null, s), []);
});

test("a check that fails, then all passing, then a conflict, then comments", () => {
  const a = prSnapshot(view(), null);
  const failing = prSnapshot(
    view({
      statusCheckRollup: [
        { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "test", status: "COMPLETED", conclusion: "FAILURE" },
      ],
    }),
    null,
  );
  assert.deepEqual(diffPr(a, failing), [{ kind: "checks-failed", failed: ["test"] }]);
  // Still failing: not told again.
  assert.deepEqual(diffPr(failing, failing), []);
  const passing = prSnapshot(
    view({
      statusCheckRollup: [
        { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
    }),
    null,
  );
  assert.deepEqual(diffPr(failing, passing), [{ kind: "checks-passed", count: 2 }]);
  assert.deepEqual(diffPr(passing, passing), []);
  const conflict: PrSnapshot = { ...passing, mergeable: "CONFLICTING" };
  assert.deepEqual(diffPr(passing, conflict), [{ kind: "conflict" }]);
  // UNKNOWN while GitHub works it out isn't "resolved".
  assert.deepEqual(diffPr(conflict, { ...conflict, mergeable: "UNKNOWN" }), []);
  assert.deepEqual(diffPr(conflict, passing), [{ kind: "conflict-resolved" }]);
  const commented = prSnapshot(
    view({
      statusCheckRollup: passing.checks.map((c) => ({
        name: c.name,
        status: "COMPLETED",
        conclusion: "SUCCESS",
      })),
    }),
    threads([{ id: 9, body: "Please add a test" }]),
  );
  const events = diffPr(passing, commented);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "comments");
  const text = prEventText(commented, events);
  assert.match(text, /^Pull request #7 \(Add the feature\): 1 new comment\n/);
  assert.match(text, /rev on src\/a\.ts:12:\n> Please add a test/);
  assert.match(text, /no need to poll/);
});

test("a re-run that fails again is told again", () => {
  const failing = prSnapshot(
    view({ statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }] }),
    null,
  );
  const rerun = prSnapshot(view({ statusCheckRollup: [{ name: "test", status: "QUEUED" }] }), null);
  assert.deepEqual(diffPr(failing, rerun), []);
  assert.deepEqual(diffPr(rerun, failing), [{ kind: "checks-failed", failed: ["test"] }]);
});

test("merged or closed ends the watch", () => {
  const open = prSnapshot(view(), null);
  const merged = prSnapshot(view({ state: "MERGED" }), null);
  const events = diffPr(open, merged);
  assert.deepEqual(events, [{ kind: "merged" }]);
  assert.ok(endsWatch(events));
  assert.match(prEventText(merged, events), /merged; the watch has ended/);
  assert.doesNotMatch(prEventText(merged, events), /no need to poll/);
  assert.deepEqual(diffPr(null, prSnapshot(view({ state: "CLOSED" }), null)), [{ kind: "closed" }]);
});

test("polling backs off after errors, up to a cap", () => {
  assert.equal(nextPollDelay(0), PR_POLL_MS);
  assert.equal(nextPollDelay(1), 2 * PR_POLL_MS);
  assert.equal(nextPollDelay(2), 4 * PR_POLL_MS);
  assert.equal(nextPollDelay(50), PR_MAX_BACKOFF_MS);
});
