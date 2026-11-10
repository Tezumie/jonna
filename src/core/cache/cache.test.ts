import assert from "node:assert/strict";
import { test } from "node:test";
import { SizedCache, stringBytes } from "./index";

const cache = (maxBytes: number, maxEntryBytes = maxBytes) =>
  new SizedCache<string, string>({ maxBytes, maxEntryBytes, sizeOf: (v) => v.length });

test("a few big entries evict as many small ones would not", () => {
  const c = cache(100);
  for (let i = 0; i < 50; i++) c.set(`small${i}`, "ab");
  assert.equal(c.size, 50);
  assert.equal(c.bytes, 100);
  c.set("big", "x".repeat(60));
  // Room was made by dropping the oldest small ones, not by a count.
  assert.ok(c.has("big"));
  assert.equal(c.bytes <= 100, true);
  assert.equal(c.has("small0"), false);
  assert.equal(c.has("small49"), true);
});

test("the least recently used goes first", () => {
  const c = cache(6);
  c.set("a", "aa");
  c.set("b", "bb");
  c.set("c", "cc");
  assert.equal(c.get("a"), "aa");
  c.set("d", "dd");
  assert.deepEqual(c.keys(), ["c", "a", "d"]);
});

test("an entry over its limit isn't kept, and replaces nothing but itself", () => {
  const c = cache(100, 10);
  c.set("k", "small");
  assert.equal(c.set("k", "x".repeat(11)), false);
  assert.equal(c.has("k"), false);
  assert.equal(c.bytes, 0);
  c.set("j", "ok");
  assert.equal(c.set("huge", "x".repeat(200)), false);
  assert.equal(c.get("j"), "ok");
});

test("replacing an entry counts only its new size", () => {
  const c = cache(10);
  c.set("a", "12345");
  c.set("a", "12");
  assert.equal(c.bytes, 2);
  c.delete("a");
  c.delete("missing");
  assert.equal(c.bytes, 0);
  c.set("b", "1");
  c.clear();
  assert.equal(c.size, 0);
  assert.equal(c.bytes, 0);
});

test("strings count two bytes a character", () => {
  assert.equal(stringBytes("abc"), 6);
});
