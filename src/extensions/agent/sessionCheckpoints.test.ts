import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "../../core/agent/conversation";
import { noteSnapshot } from "./sessionCheckpoints";

function chat() {
  const state = {
    checkpoints: [] as number[],
    items: [] as Item[],
    bumps: 0,
    saves: 0,
    bump: () => {
      state.bumps++;
    },
    save: async () => {
      state.saves++;
    },
  };
  return state;
}

test("a turn is one of the chat's checkpoints from its first snapshot, and the chat is saved then", () => {
  const session = chat();
  noteSnapshot(session, 7, null);
  assert.deepEqual(session.checkpoints, [7]);
  assert.equal(session.saves, 1, "saved at once: a crash mid-turn still knows the turn");
  // The turn's later snapshots change nothing.
  noteSnapshot(session, 7, null);
  noteSnapshot(session, 7, null);
  assert.deepEqual(session.checkpoints, [7]);
  assert.equal(session.saves, 1);
  noteSnapshot(session, 8, null);
  assert.deepEqual(session.checkpoints, [7, 8]);
  assert.equal(session.items.length, 0);
});

test("a snapshot that couldn't be kept is said once a turn, and lists no checkpoint", () => {
  const session = chat();
  noteSnapshot(session, 3, "No space left on device");
  noteSnapshot(session, 3, "No space left on device");
  assert.deepEqual(session.checkpoints, []);
  assert.equal(session.items.length, 1);
  const notice = session.items[0];
  assert.ok(notice?.type === "notice" && notice.tone === "error");
  assert.match(notice.text, /checkpoint couldn't be saved/);
  assert.equal(notice.detail, "No space left on device");
  assert.equal(session.bumps, 1);
  // The next turn says it again.
  noteSnapshot(session, 4, "No space left on device");
  assert.equal(session.items.length, 2);
});
