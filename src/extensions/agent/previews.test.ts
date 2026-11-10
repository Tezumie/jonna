import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "../../core/agent/conversation";
import { itemsForSaving, MAX_PREVIEWS } from "./previews";

const shot = (id: string, previews: string[]): Item => ({
  type: "tool",
  id,
  callId: id,
  name: "screenshot",
  args: {},
  status: "done",
  images: previews.map(() => "PNGDATA"),
  previews,
});

test("saved chats keep previews of the newest images, never the full ones (D156)", () => {
  const items: Item[] = [
    { type: "user", id: "u", text: "hi", images: ["PNG"], previews: ["data:a"] },
  ];
  for (let i = 0; i < MAX_PREVIEWS; i++) items.push(shot(`t${i}`, [`data:${i}`]));
  const saved = itemsForSaving(items);
  // No full image is saved.
  assert.ok(saved.every((it) => !("images" in it) || it.images === undefined));
  // The newest MAX_PREVIEWS keep theirs; the oldest (the user's paste) is over the limit.
  const first = saved[0];
  assert.equal(first?.type === "user" && first.previews, undefined);
  const last = saved.at(-1);
  assert.deepEqual(last?.type === "tool" && last.previews, [`data:${MAX_PREVIEWS - 1}`]);
  // The conversation in memory is untouched.
  assert.equal(items[0]?.type === "user" && items[0].images?.length, 1);
});

test("itemsForSaving: items before the newest summary drop what only the model used (D163)", () => {
  const items = [
    { type: "user", id: "u1", text: "hi", context: ["big file"], state: "ide state" },
    {
      type: "tool",
      id: "t1",
      callId: "c",
      name: "read_file",
      args: {},
      status: "done",
      result: "x".repeat(5000),
    },
    { type: "summary", id: "s1", text: "summary" },
    { type: "user", id: "u2", text: "next", context: ["kept"] },
  ] as unknown as Parameters<typeof itemsForSaving>[0];
  const saved = itemsForSaving(items) as unknown as Record<string, unknown>[];
  assert.equal(saved[0]?.context, undefined);
  assert.equal(saved[0]?.state, undefined);
  assert.ok(String(saved[1]?.result).length < 2100);
  assert.deepEqual(saved[3]?.context, ["kept"]);
});
