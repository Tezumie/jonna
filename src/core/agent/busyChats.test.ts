import assert from "node:assert/strict";
import { test } from "node:test";
import { busyChatIds, setBusyChatSource } from "./busyChats";

test("the chats being written are read from the agent each time, and none without one", () => {
  assert.equal(busyChatIds().size, 0);
  const busy = ["s1"];
  const source = setBusyChatSource(() => busy);
  assert.deepEqual([...busyChatIds()], ["s1"]);
  busy.push("s2");
  assert.deepEqual([...busyChatIds()], ["s1", "s2"]);
  source.dispose();
  assert.equal(busyChatIds().size, 0);
});

test("an older source going away doesn't take the newer one with it, and an error means none", () => {
  const first = setBusyChatSource(() => ["a"]);
  const second = setBusyChatSource(() => ["b"]);
  first.dispose();
  assert.deepEqual([...busyChatIds()], ["b"]);
  second.dispose();
  const broken = setBusyChatSource(() => {
    throw new Error("no sessions");
  });
  assert.equal(busyChatIds().size, 0);
  broken.dispose();
});
