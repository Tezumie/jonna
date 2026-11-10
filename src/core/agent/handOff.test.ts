import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "./conversation";
import {
  beforeCall,
  HANDOFF_CONTEXT_PREFIX,
  handOffChat,
  handOffContext,
  handOffMessage,
  handOffResult,
  parseHandOff,
} from "./handOff";

test("parseHandOff wants a short title and the remaining plan", () => {
  assert.ok("error" in parseHandOff({}));
  assert.ok("error" in parseHandOff({ title: "x".repeat(61), remaining_plan: "a" }));
  assert.ok("error" in parseHandOff({ title: "Fix the build", remaining_plan: "  " }));
  assert.ok("error" in parseHandOff({ title: "Fix", remaining_plan: "x".repeat(8001) }));
  const ok = parseHandOff({ title: " Fix the build ", remaining_plan: " 1. Run it\n2. Fix it " });
  assert.deepEqual(ok, { handOff: { title: "Fix the build", plan: "1. Run it\n2. Fix it" } });
});

test("the new chat's message and context", () => {
  const h = { title: "Fix the build", plan: "1. Run tsc" };
  assert.match(handOffMessage(h), /Fix the build\n\n1\. Run tsc$/);
  const ctx = handOffContext({ id: "s1", title: "Old chat" }, "USER: hi");
  assert.ok(ctx.startsWith(`${HANDOFF_CONTEXT_PREFIX} "Old chat" (s1)`));
  assert.match(ctx, /<conversation>\nUSER: hi\n<\/conversation>$/);
  assert.match(
    handOffResult({ id: "s2", title: "Fix the build" }),
    /Answer the user's new message/,
  );
});

test("beforeCall and handOffChat", () => {
  const items: Item[] = [
    { type: "user", id: "u1", text: "hi" },
    {
      type: "tool",
      id: "t1",
      name: "hand_off_task",
      args: {},
      status: "done",
      detail: "s9abc",
    },
    { type: "assistant", id: "a1", text: "ok", thinking: "" },
  ] as Item[];
  assert.equal(beforeCall(items, "t1").length, 1);
  assert.equal(beforeCall(items, "nope").length, 3);
  assert.equal(handOffChat(items[1] as Item), "s9abc");
  assert.equal(handOffChat({ ...(items[1] as Item), status: "running" } as Item), null);
  assert.equal(handOffChat(items[0] as Item), null);
});
