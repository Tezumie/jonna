import assert from "node:assert/strict";
import { test } from "node:test";
import { EventFeed, FEED_SIZE } from "./eventFeed";

test("EventFeed: numbered events after a point, and how many were missed (D191)", () => {
  const feed = new EventFeed();
  feed.push("file.saved", { path: "a.ts" });
  feed.push("file.saved", { path: "b.ts" });
  const all = feed.since(0);
  assert.equal(all.events.length, 2);
  assert.equal(all.next, 2);
  assert.deepEqual(feed.since(2).events, []);
  assert.equal(feed.since(2).next, 2);
  for (let i = 0; i < FEED_SIZE + 10; i++) feed.push("tab.opened", { tab: String(i) });
  const late = feed.since(1, 5);
  assert.equal(late.events.length, 5);
  assert.ok((late.missed ?? 0) > 0, "older events dropped");
  assert.equal(feed.since(99_999).reset, true, "a number from before a reload starts over");
  feed.dispose();
});
