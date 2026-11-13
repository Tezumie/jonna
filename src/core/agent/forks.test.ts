import assert from "node:assert/strict";
import { test } from "node:test";
import { forkedChat, forkOrder, forkTitle, itemsUpTo } from "./forks";

test("a fork's title is marked once", () => {
  assert.equal(forkTitle("Plan the API"), "Plan the API (fork)");
  assert.equal(forkTitle("Plan the API (fork)"), "Plan the API (fork)");
  assert.equal(forkTitle(undefined), "Chat (fork)");
});

test("a fork keeps the conversation up to its message", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(itemsUpTo(items, "b"), [{ id: "a" }, { id: "b" }]);
  assert.equal(itemsUpTo(items, "x"), null);
});

test("a forked chat: its own review state, the source named, later turns forgotten", () => {
  const saved = {
    meta: { title: "Chat", pinned: true, archived: true, pending: 2, mode: "custom:x", updated: 1 },
    items: [{ id: "a" }, { id: "b" }, { id: "c" }],
    changeset: [1],
    checkpoints: [1],
    acpResume: { id: "r" },
    externalSeen: "c",
    plan: [{ step: 1 }],
    toldSkills: { s: 1 },
    chatMode: "custom:x",
    turn: 3,
  };
  const whole = forkedChat(saved, { from: "s1", now: 9 });
  assert.deepEqual(whole?.meta, {
    title: "Chat (fork)",
    mode: "custom:x",
    updated: 9,
    forkOf: "s1",
  });
  assert.equal(whole?.changeset, undefined);
  assert.equal(whole?.acpResume, undefined);
  assert.equal(whole?.externalSeen, undefined);
  assert.deepEqual(whole?.plan, [{ step: 1 }]);
  assert.deepEqual(whole?.items, saved.items);

  const cut = forkedChat(saved, { from: "s1", item: "b", now: 9 });
  assert.deepEqual(cut?.items, [{ id: "a" }, { id: "b" }]);
  assert.equal(cut?.plan, undefined);
  assert.equal(cut?.toldSkills, undefined);
  assert.equal(cut?.chatMode, "custom:x");
  // At the last message nothing is forgotten.
  assert.deepEqual(forkedChat(saved, { from: "s1", item: "c", now: 9 })?.plan, [{ step: 1 }]);
  assert.equal(forkedChat(saved, { from: "s1", item: "nope", now: 9 }), null);
  // The saved chat isn't changed.
  assert.equal(saved.items.length, 3);
  assert.equal(saved.meta.pinned, true);
});

test("forks are listed under their chat, forks of forks under those", () => {
  const rows = [
    { id: "new" },
    { id: "f2", forkOf: "f1" },
    { id: "root" },
    { id: "f1", forkOf: "root" },
    { id: "f3", forkOf: "root" },
    { id: "orphan", forkOf: "gone" },
  ];
  assert.deepEqual(
    forkOrder(rows).map((r) => `${r.depth}:${r.row.id}`),
    ["0:new", "0:root", "1:f1", "2:f2", "1:f3", "0:orphan"],
  );
  // Chats that point at each other are still listed, once each.
  const loop = [
    { id: "a", forkOf: "b" },
    { id: "b", forkOf: "a" },
    { id: "c", forkOf: "c" },
  ];
  assert.deepEqual(
    forkOrder(loop)
      .map((r) => r.row.id)
      .sort(),
    ["a", "b", "c"],
  );
});
