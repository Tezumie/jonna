import assert from "node:assert/strict";
import { test } from "node:test";
import { pathKey } from "../../core/paths/index";
import { BreakpointStore } from "./breakpoints";
import {
  breakpointsHit,
  dropDanglingTriggers,
  forgetSession,
  isWaiting,
  markTriggered,
  sentTo,
  type TriggerFields,
  triggerCandidates,
  triggeredBy,
} from "./triggers";

const bp = (id: number, line: number, extra: Partial<TriggerFields> = {}): TriggerFields => ({
  id,
  path: "/w/a.js",
  line,
  enabled: true,
  ...extra,
});

test("triggers: a waiting breakpoint is sent only to the sessions that hit its trigger", () => {
  const list = [bp(1, 3), bp(2, 7, { triggeredBy: 1 })];
  assert.equal(sentTo(list[0] ?? bp(0, 0), "s1"), true);
  assert.equal(sentTo(list[1] ?? bp(0, 0), "s1"), false);
  assert.equal(isWaiting(list[1] ?? bp(0, 0)), true);
  // s1 stops at breakpoint 1: breakpoint 2 is set there, not in s2.
  const ids = triggeredBy(list, breakpointsHit(list, { hitBreakpointIds: [1], reason: "x" }), "s1");
  assert.deepEqual(ids, [2]);
  const after = markTriggered(list, ids, "s1");
  assert.equal(sentTo(after[1] ?? bp(0, 0), "s1"), true);
  assert.equal(sentTo(after[1] ?? bp(0, 0), "s2"), false);
  assert.equal(isWaiting(after[1] ?? bp(0, 0)), false);
  // Hitting it again changes nothing; the session's end resets it.
  assert.deepEqual(triggeredBy(after, [1], "s1"), []);
  assert.equal(markTriggered(after, [], "s1"), after);
  const reset = forgetSession(after, "s1");
  assert.equal(reset[1]?.triggeredIn, undefined);
  assert.equal(isWaiting(reset[1] ?? bp(0, 0)), true);
  assert.equal(forgetSession(reset, "s1"), reset);
  // A disabled one isn't triggered (nor waiting).
  const off = [bp(1, 3), bp(2, 7, { triggeredBy: 1, enabled: false })];
  assert.deepEqual(triggeredBy(off, [1], "s1"), []);
  assert.equal(isWaiting(off[1] ?? bp(0, 0)), false);
});

test("triggers: without the debugger's ids, a breakpoint stop on a breakpoint's line hits it", () => {
  const list = [bp(1, 3), bp(2, 7, { triggeredBy: 1 }), bp(3, 3, { path: "/w/b.js" })];
  assert.deepEqual(breakpointsHit(list, { reason: "breakpoint", path: "/w/a.js", line: 3 }), [1]);
  assert.deepEqual(breakpointsHit(list, { reason: "step", path: "/w/a.js", line: 3 }), []);
  assert.deepEqual(breakpointsHit(list, { reason: "breakpoint", path: null, line: 3 }), []);
  assert.deepEqual(breakpointsHit(list, { hitBreakpointIds: [3], reason: "breakpoint" }), [3]);
});

test("triggers: links to removed breakpoints drop; candidates leave out loops", () => {
  const list = [bp(1, 3), bp(2, 7, { triggeredBy: 1 }), bp(3, 9, { triggeredBy: 2 })];
  assert.equal(dropDanglingTriggers(list), list);
  const without1 = dropDanglingTriggers(list.filter((b) => b.id !== 1));
  assert.equal(without1[0]?.triggeredBy, undefined);
  assert.equal(without1[1]?.triggeredBy, 2);
  assert.equal(dropDanglingTriggers([bp(4, 1, { triggeredBy: 4 })])[0]?.triggeredBy, undefined);
  // 1 may not wait for 2 or 3 (they wait for it); 3 may wait for 1 or 2.
  assert.deepEqual(
    triggerCandidates(list, 1).map((b) => b.id),
    [],
  );
  assert.deepEqual(
    triggerCandidates(list, 3).map((b) => b.id),
    [1, 2],
  );
  assert.deepEqual(
    triggerCandidates(list, null).map((b) => b.id),
    [1, 2, 3],
  );
});

test("breakpoints: triggered ones are saved by their trigger's place and restored", () => {
  const s = new BreakpointStore();
  const first = s.add("/w/a.js", 3);
  const second = s.add("/w/b.js", 9, { triggeredBy: first.id, condition: "x > 1" });
  assert.equal(second.triggeredBy, first.id);
  const saved = s.save();
  assert.deepEqual(saved.breakpoints[1], {
    path: "/w/b.js",
    line: 9,
    enabled: true,
    condition: "x > 1",
    triggeredBy: { path: "/w/a.js", line: 3 },
  });
  const t = new BreakpointStore();
  // A trigger listed after the breakpoint waiting for it.
  t.restore({ breakpoints: [saved.breakpoints[1], saved.breakpoints[0]] });
  const [waiting, trigger] = t.list.peek();
  assert.equal(waiting?.triggeredBy, trigger?.id);
  // A trigger that isn't there any more: a plain breakpoint.
  const u = new BreakpointStore();
  u.restore({ breakpoints: [saved.breakpoints[1]] });
  assert.equal(u.list.peek()[0]?.triggeredBy, undefined);

  // Removing the trigger makes the other a plain breakpoint; the glyph is conditional, and
  // pending (a dashed ring) while a session runs and it waits.
  s.markTriggered("s1", [second.id]);
  assert.deepEqual(s.get(second.id)?.triggeredIn, ["s1"]);
  s.sessionEnded("s1");
  assert.equal(s.get(second.id)?.triggeredIn, undefined);
  const glyph = s.glyphs(true).get(pathKey("/w/b.js"))?.[0];
  assert.equal(glyph?.conditional, true);
  assert.equal(glyph?.state, "pending");
  assert.equal(s.glyphs(false).get(pathKey("/w/b.js"))?.[0]?.state, "verified");
  // Another trigger (or none) waits again; clearing it keeps the rest.
  s.markTriggered("s1", [second.id]);
  s.update(second.id, { triggeredBy: undefined });
  assert.equal(s.get(second.id)?.triggeredBy, undefined);
  assert.equal(s.get(second.id)?.triggeredIn, undefined);
  assert.equal(s.get(second.id)?.condition, "x > 1");
  s.update(second.id, { triggeredBy: first.id });
  s.remove(first.id);
  assert.equal(s.get(second.id)?.triggeredBy, undefined);
  // A breakpoint can't wait for itself.
  const self = s.add("/w/b.js", 9, { triggeredBy: second.id });
  assert.equal(self.triggeredBy, undefined);
});
