import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DisposableStore,
  LeakMonitor,
  liveDisposableCount,
  MutableDisposable,
  toDisposable,
} from "./index";

test("toDisposable runs its function once", () => {
  let calls = 0;
  const d = toDisposable(() => calls++);
  d.dispose();
  d.dispose();
  assert.equal(calls, 1);
});

test("DisposableStore disposes in reverse order and disposes late additions", () => {
  const order: string[] = [];
  const store = new DisposableStore();
  store.add(toDisposable(() => order.push("a")));
  store.add(toDisposable(() => order.push("b")));
  store.dispose();
  assert.deepEqual(order, ["b", "a"]);
  assert.equal(store.isDisposed, true);
  let late = false;
  store.add(toDisposable(() => (late = true)));
  assert.equal(late, true);
});

test("DisposableStore.clear keeps the store usable; delete disposes one item", () => {
  const store = new DisposableStore();
  let a = 0;
  let b = 0;
  const da = store.add(toDisposable(() => a++));
  store.add(toDisposable(() => b++));
  store.delete(da);
  assert.equal(a, 1);
  store.clear();
  assert.equal(b, 1);
  store.add(toDisposable(() => a++));
  store.dispose();
  assert.equal(a, 2);
});

test("a throwing disposable doesn't stop the others", () => {
  const store = new DisposableStore();
  let ran = false;
  store.add(toDisposable(() => (ran = true)));
  store.add(
    toDisposable(() => {
      throw new Error("boom");
    }),
  );
  assert.throws(() => store.dispose(), /boom/);
  assert.equal(ran, true);
});

test("MutableDisposable disposes the previous value", () => {
  const m = new MutableDisposable();
  const log: number[] = [];
  m.value = toDisposable(() => log.push(1));
  m.value = toDisposable(() => log.push(2));
  assert.deepEqual(log, [1]);
  m.dispose();
  assert.deepEqual(log, [1, 2]);
  m.value = toDisposable(() => log.push(3));
  assert.deepEqual(log, [1, 2, 3], "values set after dispose are disposed immediately");
});

test("live disposable counter tracks creation and disposal in dev builds", () => {
  const before = liveDisposableCount();
  const store = new DisposableStore();
  store.add(toDisposable(() => {}));
  assert.equal(liveDisposableCount(), before + 2);
  store.dispose();
  assert.equal(liveDisposableCount(), before);
});

test("LeakMonitor flags steady growth only", () => {
  let n = 10;
  const monitor = new LeakMonitor(3, () => n);
  assert.equal(monitor.sample(), false);
  for (const next of [11, 12]) {
    n = next;
    assert.equal(monitor.sample(), false);
  }
  n = 13;
  assert.equal(monitor.sample(), true);
  n = 13;
  assert.equal(monitor.sample(), false, "a plateau resets the streak");
});
