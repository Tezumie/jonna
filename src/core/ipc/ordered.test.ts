import assert from "node:assert/strict";
import { test } from "node:test";
import { orderedSender } from "./ordered";

test("sends to one program in order, even when the host answers out of order", async () => {
  const written: string[] = [];
  // The first write is slow: without the queue the second would land first.
  const sender = orderedSender(async (_id, body) => {
    if (body === "a") await new Promise((r) => setTimeout(r, 20));
    written.push(body);
  });
  await Promise.all([sender.send("s", "a"), sender.send("s", "b"), sender.send("s", "c")]);
  assert.deepEqual(written, ["a", "b", "c"]);
});

test("a failed send doesn't stop the next one; other ids don't wait", async () => {
  const written: string[] = [];
  let release = () => {};
  const sender = orderedSender(async (id, body) => {
    if (body === "slow") await new Promise<void>((r) => (release = r));
    if (body === "bad") throw new Error("pipe closed");
    written.push(`${id}:${body}`);
  });
  const slow = sender.send("x", "slow");
  await sender.send("y", "fast");
  assert.deepEqual(written, ["y:fast"]);
  release();
  await slow;
  await assert.rejects(sender.send("x", "bad"));
  await sender.send("x", "after");
  assert.deepEqual(written, ["y:fast", "x:slow", "x:after"]);
});

test("reset drops what's queued for the old program", async () => {
  const written: string[] = [];
  let release = () => {};
  const sender = orderedSender(async (_id, body) => {
    if (body === "first") await new Promise<void>((r) => (release = r));
    written.push(body);
  });
  const first = sender.send("s", "first");
  const exit = sender.send("s", "exit");
  await new Promise((r) => setTimeout(r, 0)); // "first" is with the host now
  sender.reset("s");
  const fresh = sender.send("s", "initialize");
  release();
  await first;
  await assert.rejects(exit);
  await fresh;
  assert.deepEqual(written, ["first", "initialize"]);
});
