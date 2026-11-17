import assert from "node:assert/strict";
import { test } from "node:test";
import type { SyncKept } from "../../core/ipc/sync";
import { keptWords, wentOffWords } from "./kept";

const DAY = 86_400_000;

function kept(over: Partial<SyncKept> = {}): SyncKept {
  return {
    reason: "reset",
    at: 1_000,
    until: 1_000 + 30 * DAY,
    resumable: false,
    deviceName: "Laptop",
    ...over,
  };
}

test("sync kept: the keys are kept and that is said, with how long", () => {
  const words = keptWords(kept(), 1_000);
  assert.equal(words.resume, false);
  assert.match(words.text, /^Sync was reset on your account page, so sync stopped here\./);
  assert.match(words.text, /kept for 30 more days/);
  assert.match(keptWords(kept(), 1_000 + 29 * DAY + 1).text, /kept for 1 more day /);
  // Never "0 days", nor a negative number, on the last day.
  assert.match(keptWords(kept(), 1_000 + 31 * DAY).text, /kept for 1 more day /);
});

test("sync kept: each reason is said as what happened", () => {
  assert.match(keptWords(kept({ reason: "removed" })).text, /^This computer was removed from sync/);
  assert.match(keptWords(kept({ reason: "account" })).text, /^Another account signed in/);
  assert.match(keptWords(kept({ reason: "server" })).text, /^The account's server changed/);
});

test("sync kept: when the account lists the computer again, turning back on is offered", () => {
  const words = keptWords(kept({ resumable: true }));
  assert.equal(words.resume, true);
  assert.match(words.text, /turn sync back on with the keys it kept/);
});

test("sync kept: the notice says the keys are kept, except when they are what was lost", () => {
  assert.match(wentOffWords("reset"), /keys are kept for 30 days/);
  assert.match(wentOffWords("removed"), /keys are kept for 30 days/);
  assert.doesNotMatch(wentOffWords("keysLost"), /kept/);
});
