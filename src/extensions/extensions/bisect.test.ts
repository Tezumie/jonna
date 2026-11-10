import assert from "node:assert/strict";
import { test } from "node:test";
import { type BisectAnswer, nextBisect, parseBisect, roundsLeft, startBisect } from "./bisect";

/** Answers as a user would when `culprit` causes the problem (null: none does). */
function run(ids: string[], culprit: string | null): { culprit: string | null; rounds: number } {
  let state = startBisect(ids);
  for (let i = 0; i < 20; i++) {
    const answer: BisectAnswer = culprit !== null && state.off.includes(culprit) ? "good" : "bad";
    const step = nextBisect(state, answer);
    if (step.done) return { culprit: step.culprit, rounds: state.round };
    state = step.state;
  }
  throw new Error("didn't finish");
}

test("bisect finds each culprit in about log2(n) rounds", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  for (const id of ids) {
    const r = run(ids, id);
    assert.equal(r.culprit, id);
    assert.ok(r.rounds <= 4, `${id}: ${r.rounds} rounds`);
  }
});

test("bisect: no extension causes it, one extension, duplicates", () => {
  assert.equal(run(["a", "b", "c"], null).culprit, null);
  assert.equal(run(["a"], "a").culprit, "a");
  assert.equal(run(["a"], null).culprit, null);
  assert.deepEqual(startBisect(["a", "a", "b"]), {
    candidates: ["a", "b"],
    off: ["a"],
    round: 1,
    total: 2,
  });
});

test("bisect: only the round's half is off; rounds left", () => {
  const s = startBisect(["a", "b", "c", "d"]);
  assert.deepEqual(s.off, ["a", "b"]);
  assert.equal(roundsLeft(s), 3);
  const step = nextBisect(s, "bad");
  assert.ok(!step.done);
  assert.deepEqual(step.state.candidates, ["c", "d"]);
  assert.deepEqual(step.state.off, ["c"]);
  assert.equal(step.state.round, 2);
});

test("bisect state from the registry is checked", () => {
  assert.equal(parseBisect(null), null);
  assert.equal(parseBisect({ candidates: ["a"], off: ["z"] }), null);
  assert.deepEqual(parseBisect({ candidates: ["a", "b", 3], off: ["a", "q"], round: 2.5 }), {
    candidates: ["a", "b"],
    off: ["a"],
    round: 2,
    total: 2,
  });
});
