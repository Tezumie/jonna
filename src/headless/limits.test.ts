import assert from "node:assert/strict";
import { test } from "node:test";
import { type LimitedChat, RunLimiter } from "./limits";

/** A chat as the limits see it: Stop does nothing while it is idle, as the real one's. */
function fakeChat() {
  const chat = {
    state: "idle",
    stops: [] as string[],
    notices: [] as string[],
    ownCost: null as number | null,
    requests: 0,
    sideCost: 0,
    price: undefined as unknown,
    stop(reason?: string) {
      if (chat.state === "idle") return;
      chat.stops.push(reason ?? "");
      chat.state = "idle";
    },
    status: { peek: () => chat.state },
    cost: { peek: () => chat.ownCost },
    totals: { peek: () => ({ requests: chat.requests }) },
    addNotice: (text: string) => void chat.notices.push(text),
  };
  return chat satisfies LimitedChat;
}

const tick = () => new Promise<void>((done) => setTimeout(done, 0));

test("a limit that fires before the turn runs stops the turn as it starts", async () => {
  const chat = fakeChat();
  let ended = 0;
  const limiter = new RunLimiter(chat, undefined, () => ended++);
  // The message was taken, the turn isn't running yet: Stop has nothing to stop.
  limiter.stopFor("timeout", "the time limit of this run was reached");
  assert.deepEqual(chat.stops, []);
  assert.equal(limiter.limit, "timeout");
  // The turn starts: stopped, once it has set itself up.
  chat.state = "running";
  limiter.onEvent({ type: "turn.start" });
  assert.deepEqual(chat.stops, []);
  await tick();
  assert.deepEqual(chat.stops, ["the time limit of this run was reached"]);
  // A later limit doesn't change the reason, and a turn something starts afterwards (a queued
  // message, a background command's end) is stopped too.
  limiter.stopFor("cancelled", "the run was cancelled");
  assert.equal(limiter.limit, "timeout");
  chat.state = "running";
  limiter.onEvent({ type: "status", status: "running" });
  await tick();
  assert.equal(chat.stops.length, 2);
  // What would start another turn by itself is ended with each stop.
  assert.equal(ended, 3);
  // The chat coming to rest stops nothing.
  limiter.onEvent({ type: "status", status: "idle" });
  await tick();
  assert.equal(chat.stops.length, 2);
});

test("a run cancelled before it starts is remembered", async () => {
  const chat = fakeChat();
  const limiter = new RunLimiter(chat, undefined, () => {});
  limiter.cancelledBeforeStart();
  assert.equal(limiter.limit, "cancelled");
  chat.state = "running";
  limiter.onEvent({ type: "turn.start" });
  await tick();
  assert.deepEqual(chat.stops, ["the run was cancelled"]);
});

test("the cost limit counts the chat's requests and its subagents'", () => {
  const chat = fakeChat();
  chat.ownCost = 1;
  chat.sideCost = 0.5;
  chat.price = { input: 1, output: 1 };
  chat.state = "running";
  const limiter = new RunLimiter(chat, 0.1, () => {});
  // What was spent before the run doesn't count.
  limiter.onEvent({ type: "usage" });
  assert.equal(limiter.limit, null);
  chat.ownCost = 1.04;
  chat.requests = 1;
  limiter.onEvent({ type: "usage" });
  assert.equal(limiter.limit, null);
  // A subagent's spend reaches the limit, at whatever event comes next.
  chat.sideCost = 0.57;
  limiter.onEvent({ type: "tool.update" });
  assert.equal(limiter.limit, "max_cost");
  assert.equal(Math.round(limiter.spent() * 100), 11);
  assert.deepEqual(chat.stops, ["the cost limit of this run was reached"]);
  assert.deepEqual(chat.notices, []);
});

test("a cost limit on a model with no known price says so, once", () => {
  const chat = fakeChat();
  chat.state = "running";
  const limiter = new RunLimiter(chat, 1, () => {});
  // Nothing asked of the model yet: nothing to say.
  limiter.onEvent({ type: "usage" });
  assert.deepEqual(chat.notices, []);
  chat.requests = 1;
  limiter.onEvent({ type: "usage" });
  chat.requests = 2;
  limiter.onEvent({ type: "usage" });
  assert.equal(chat.notices.length, 1);
  assert.match(chat.notices[0] ?? "", /cost limit can't be enforced/);
  assert.equal(limiter.limit, null);
  // No limit asked for: nothing said.
  const other = fakeChat();
  const unlimited = new RunLimiter(other, undefined, () => {});
  other.requests = 3;
  unlimited.onEvent({ type: "usage" });
  assert.deepEqual(other.notices, []);
});
