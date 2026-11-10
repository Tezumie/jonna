import assert from "node:assert/strict";
import { test } from "node:test";
import { allowTab, forgetTab, readPopup } from "./opening";

test("a page opens a few tabs at a time, not a flood", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) assert.equal(allowTab("t1", t0 + i), true);
  assert.equal(allowTab("t1", t0 + 10), false);
  assert.equal(allowTab("t2", t0 + 10), true); // per tab
  assert.equal(allowTab("t1", t0 + 10_001), true); // the window moved on
  forgetTab("t1");
  for (let i = 0; i < 5; i++) assert.equal(allowTab("t1", t0 + 20_000 + i), true);
});

test("popup links from tab state", () => {
  assert.deepEqual(readPopup({ opener: "t3", id: "p1a" }), { opener: "t3", id: "p1a" });
  assert.equal(readPopup({ opener: "t3", id: "bad id" }), null);
  assert.equal(readPopup("x"), null);
  assert.equal(readPopup(null), null);
});
