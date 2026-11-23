import assert from "node:assert/strict";
import { test } from "node:test";
import { Emitter, EventBus } from "../events/index";
import { batch, computed, effect, signal, untracked } from "./index";

test("signal read/write and equality short-circuit", () => {
  const s = signal(1);
  let runs = 0;
  const e = effect(() => {
    void s.value;
    runs++;
  });
  s.value = 1;
  assert.equal(runs, 1);
  s.value = 2;
  assert.equal(runs, 2);
  e.dispose();
  s.value = 3;
  assert.equal(runs, 2, "disposed effects don't run");
});

test("computed is lazy and cached", () => {
  const a = signal(2);
  let computations = 0;
  const double = computed(() => {
    computations++;
    return a.value * 2;
  });
  assert.equal(computations, 0);
  assert.equal(double.value, 4);
  assert.equal(double.value, 4);
  assert.equal(computations, 1);
  a.value = 5;
  assert.equal(double.value, 10);
  assert.equal(computations, 2);
});

test("effects track conditional dependencies", () => {
  const useA = signal(true);
  const a = signal("a");
  const b = signal("b");
  const seen: string[] = [];
  const e = effect(() => {
    seen.push(useA.value ? a.value : b.value);
  });
  b.value = "b2"; // not a dependency yet
  useA.value = false;
  a.value = "a2"; // no longer a dependency
  b.value = "b3";
  assert.deepEqual(seen, ["a", "b2", "b3"]);
  e.dispose();
});

test("batch runs dependent effects once", () => {
  const a = signal(1);
  const b = signal(2);
  const sum = computed(() => a.value + b.value);
  const seen: number[] = [];
  const e = effect(() => {
    seen.push(sum.value);
  });
  batch(() => {
    a.value = 10;
    b.value = 20;
  });
  assert.deepEqual(seen, [3, 30]);
  e.dispose();
});

test("effect cleanup runs before re-run and on dispose", () => {
  const s = signal(0);
  const log: string[] = [];
  const e = effect(() => {
    const v = s.value;
    log.push(`run ${v}`);
    return () => log.push(`cleanup ${v}`);
  });
  s.value = 1;
  e.dispose();
  assert.deepEqual(log, ["run 0", "cleanup 0", "run 1", "cleanup 1"]);
});

test("untracked reads don't subscribe; effects writing signals settle", () => {
  const a = signal(1);
  const b = signal(0);
  let runs = 0;
  const e1 = effect(() => {
    runs++;
    untracked(() => a.value);
  });
  a.value = 2;
  assert.equal(runs, 1);
  const e2 = effect(() => {
    b.value = a.value * 10;
  });
  a.value = 3;
  assert.equal(b.peek(), 30);
  e1.dispose();
  e2.dispose();
});

test("Emitter and EventBus deliver to live listeners only", () => {
  const emitter = new Emitter<number>();
  const got: number[] = [];
  const sub = emitter.event((v) => got.push(v));
  emitter.fire(1);
  sub.dispose();
  emitter.fire(2);
  assert.deepEqual(got, [1]);

  const bus = new EventBus<{ ping: { n: number } }>();
  const seen: number[] = [];
  const d = bus.on("ping", (e) => seen.push(e.n));
  bus.emit("ping", { n: 7 });
  d.dispose();
  bus.emit("ping", { n: 8 });
  assert.deepEqual(seen, [7]);
});

test("a computed that threw rethrows until a dependency changes, then recovers and notifies", () => {
  const input = signal(-1);
  let runs = 0;
  const doubled = computed(() => {
    runs++;
    if (input.value < 0) throw new Error("negative");
    return input.value * 2;
  });
  const seen: (number | string)[] = [];
  const stop = effect(() => {
    try {
      seen.push(doubled.value);
    } catch (err) {
      seen.push((err as Error).message);
    }
    return undefined;
  });
  assert.throws(() => doubled.peek(), /negative/);
  assert.equal(runs, 1, "the stored error is rethrown without recomputing");
  input.value = 3;
  assert.deepEqual(seen, ["negative", 6]);
  input.value = -2;
  input.value = 4;
  assert.deepEqual(seen, ["negative", 6, "negative", 8]);
  stop.dispose();
});

test("an effect that writes a signal it read on its first run keeps one cleanup", () => {
  const s = signal(0);
  let cleanups = 0;
  let live = 0;
  const e = effect(() => {
    if (s.value === 0) s.value = 1;
    live++;
    return () => {
      cleanups++;
      live--;
    };
  });
  // Every run's cleanup is called before the next run: none is lost to a nested run.
  e.dispose();
  assert.equal(live, 0);
  assert.equal(cleanups, 2);
});

test("an effect whose first run throws doesn't stay subscribed", () => {
  const s = signal(0);
  let runs = 0;
  assert.throws(() =>
    effect(() => {
      runs++;
      if (s.value === 0) throw new Error("boom");
      return undefined;
    }),
  );
  s.value = 1;
  assert.equal(runs, 1, "nobody can dispose it, so it must not run again");
});

test("an effect disposed during its own run keeps no subscriptions and runs its cleanup", () => {
  const trigger = signal(0);
  const later = signal(0);
  let runs = 0;
  let cleanups = 0;
  let self: { dispose(): void } | undefined;
  self = effect(() => {
    runs++;
    if (trigger.value === 1) self?.dispose();
    // Read after the dispose: must not subscribe the dead effect again.
    void later.value;
    return () => {
      cleanups++;
    };
  });
  assert.equal(runs, 1);
  trigger.value = 1;
  assert.equal(runs, 2);
  // The first run's cleanup before the second run, and the second run's own on the way out.
  assert.equal(cleanups, 2);
  later.value = 1;
  trigger.value = 2;
  assert.equal(runs, 2);
  assert.equal(cleanups, 2);
  const observers = (s: unknown) => (s as { observers: Set<unknown> }).observers.size;
  assert.equal(observers(trigger), 0);
  assert.equal(observers(later), 0);
});

test("an effect disposed during a run that then throws still lets go of its subscriptions", () => {
  const trigger = signal(0);
  const later = signal(0);
  let self: { dispose(): void } | undefined;
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    self = effect(() => {
      if (trigger.value === 1) {
        self?.dispose();
        void later.value;
        throw new Error("after dispose");
      }
    });
    trigger.value = 1;
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  assert.equal((later as unknown as { observers: Set<unknown> }).observers.size, 0);
});
