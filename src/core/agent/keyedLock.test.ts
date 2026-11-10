import assert from "node:assert/strict";
import { test } from "node:test";
import { fileLockKey, KeyedLock } from "./keyedLock";

const tick = () => new Promise((r) => setTimeout(r, 1));

test("calls with the same key run one at a time, in order; other keys don't wait", async () => {
  const lock = new KeyedLock();
  const log: string[] = [];
  const slow = (name: string) => async () => {
    log.push(`${name} start`);
    await tick();
    await tick();
    log.push(`${name} end`);
    return name;
  };
  const results = await Promise.all([
    lock.run("a", slow("a1")),
    lock.run("a", slow("a2")),
    lock.run("b", slow("b1")),
  ]);
  assert.deepEqual(results, ["a1", "a2", "b1"]);
  // a2 starts only after a1 ends; b1 runs alongside a1.
  assert.ok(log.indexOf("a2 start") > log.indexOf("a1 end"));
  assert.ok(log.indexOf("b1 start") < log.indexOf("a1 end"));
  assert.equal(lock.size, 0);
});

test("a failed call doesn't block the next one", async () => {
  const lock = new KeyedLock();
  await assert.rejects(
    lock.run("a", async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(await lock.run("a", async () => 2), 2);
  assert.equal(lock.size, 0);
});

test("edits of one file share a key however the path is written", () => {
  assert.equal(fileLockKey("./src\\App.ts"), "src/app.ts");
  assert.equal(fileLockKey("src//app.ts"), "src/app.ts");
  assert.notEqual(fileLockKey("src/a.ts"), fileLockKey("src/b.ts"));
});
