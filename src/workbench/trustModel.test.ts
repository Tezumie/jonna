import assert from "node:assert/strict";
import { test } from "node:test";
import { trustOf, withDecision } from "./trustModel";

test("trust: a folder's own decision, else a trusted parent's", () => {
  assert.deepEqual(trustOf(undefined, "/home/me/app"), { state: "unknown" });
  const decisions = withDecision({}, "/home/me/work/app", true, true);
  assert.deepEqual(decisions, { "/home/me/work/app": true, "/home/me/work": true });
  assert.deepEqual(trustOf(decisions, "/home/me/work/app"), { state: "trusted" });
  assert.deepEqual(trustOf(decisions, "/home/me/work/other/deep"), {
    state: "trusted",
    inheritedFrom: "/home/me/work",
  });
  assert.deepEqual(trustOf(decisions, "/home/me/elsewhere"), { state: "unknown" });
  // A folder's own "no" wins over a trusted parent; a restricted parent isn't inherited.
  const mixed = withDecision(decisions, "/home/me/work/untrusted", false, true);
  assert.equal(mixed["/home/me/work/untrusted"], false);
  assert.equal(trustOf(mixed, "/home/me/work/untrusted").state, "restricted");
  assert.equal(trustOf({ "/home/me": false }, "/home/me/x").state, "unknown");
});

test("trust: a risky folder doesn't inherit a trusted parent (D213)", () => {
  const decisions = withDecision({}, "/home/me", true);
  assert.equal(trustOf(decisions, "/home/me/Downloads").state, "trusted");
  assert.equal(trustOf(decisions, "/home/me/Downloads", false).state, "unknown");
  assert.equal(
    trustOf({ "/home/me/Downloads": false }, "/home/me/Downloads", false).state,
    "restricted",
  );
});

test("trust: Windows paths compare without case", () => {
  const decisions = withDecision({}, "C:\\Users\\me\\Repo", true, true);
  assert.equal(trustOf(decisions, "c:\\users\\me\\other").state, "trusted");
  // A drive root has no parent to trust.
  assert.deepEqual(Object.keys(withDecision({}, "C:\\", true, true)), ["c:\\"]);
});
