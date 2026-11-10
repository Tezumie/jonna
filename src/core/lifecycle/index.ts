// Disposable lifecycle (VS Code pattern). Every listener, effect, timer, IPC subscription and child
// component is registered to its owner's DisposableStore and released when the owner is disposed.

export interface Disposable {
  dispose(): void;
}

// ---- Dev-mode leak tracking -------------------------------------------------
// Counts disposables created but not yet disposed. A count that keeps growing while the user
// repeats the same action is a leak. Production builds skip the bookkeeping entirely.

let liveCount = 0;
const track = (): void => {
  if (__DEV__) liveCount++;
};
const untrack = (): void => {
  if (__DEV__) liveCount--;
};

/** Number of live (created, not disposed) tracked disposables. Always 0 in production builds. */
export function liveDisposableCount(): number {
  return liveCount;
}

/**
 * Detects steady growth: `sample()` returns true once the live count has grown on
 * `threshold` consecutive samples. Pure logic so it can be unit-tested; the app samples on a timer.
 */
export class LeakMonitor {
  private last = -1;
  private growthStreak = 0;
  constructor(
    private readonly threshold = 5,
    private readonly read: () => number = liveDisposableCount,
  ) {}

  sample(): boolean {
    const now = this.read();
    this.growthStreak = this.last >= 0 && now > this.last ? this.growthStreak + 1 : 0;
    this.last = now;
    return this.growthStreak >= this.threshold;
  }
}

// ---- Primitives -------------------------------------------------------------

class FunctionDisposable implements Disposable {
  private fn: (() => void) | undefined;
  constructor(fn: () => void) {
    this.fn = fn;
    track();
  }
  dispose(): void {
    const fn = this.fn;
    if (!fn) return;
    this.fn = undefined;
    untrack();
    fn();
  }
}

/** Wraps a cleanup function. Safe to dispose more than once (runs once). */
export function toDisposable(fn: () => void): Disposable {
  return new FunctionDisposable(fn);
}

/** A disposable that does nothing (handy as a default). */
export const NONE: Disposable = Object.freeze({ dispose(): void {} });

/** Disposes all items, collecting errors so one failure doesn't leak the rest. */
export function disposeAll(items: Iterable<Disposable>): void {
  const errors: unknown[] = [];
  for (const item of items) {
    try {
      item.dispose();
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Errors while disposing");
}

/** Owns a set of disposables and disposes them together (in reverse order of registration). */
export class DisposableStore implements Disposable {
  private readonly items = new Set<Disposable>();
  private disposed = false;

  constructor() {
    track();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Registers `item`. If the store is already disposed, `item` is disposed immediately. */
  add<T extends Disposable>(item: T): T {
    if ((item as unknown) === this) throw new Error("Cannot add a DisposableStore to itself");
    if (this.disposed) {
      if (__DEV__) console.warn("Adding to a disposed DisposableStore; disposing item now.");
      item.dispose();
    } else {
      this.items.add(item);
    }
    return item;
  }

  /** Unregisters and disposes `item`. */
  delete(item: Disposable): void {
    if (this.items.delete(item)) item.dispose();
  }

  /** Disposes all items but keeps the store usable. */
  clear(): void {
    const items = [...this.items].reverse();
    this.items.clear();
    disposeAll(items);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    untrack();
    this.clear();
  }
}

/** Holds at most one disposable; setting a new value disposes the previous one. */
export class MutableDisposable<T extends Disposable> implements Disposable {
  private current: T | undefined;
  private disposed = false;

  get value(): T | undefined {
    return this.current;
  }

  set value(next: T | undefined) {
    if (this.disposed) {
      next?.dispose();
      return;
    }
    if (next === this.current) return;
    const previous = this.current;
    this.current = next;
    previous?.dispose();
  }

  clear(): void {
    this.value = undefined;
  }

  dispose(): void {
    this.disposed = true;
    const previous = this.current;
    this.current = undefined;
    previous?.dispose();
  }
}
