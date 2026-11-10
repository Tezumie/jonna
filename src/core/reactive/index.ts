// Tiny signal store: signal / computed / effect / batch.
//
// Model: reading `.value` inside a computed or effect subscribes it. Writing a signal marks
// dependent computeds dirty (lazily recomputed on next read) and queues dependent effects, which
// run once after the outermost batch ends. Effects re-subscribe on every run, so conditional
// dependencies are handled correctly.
import { type Disposable, toDisposable } from "../lifecycle/index";

interface Observer {
  /** Called when a dependency changed. */
  invalidate(): void;
  /** Sources this observer read during its last run. */
  readonly sources: Set<Source>;
}

interface Source {
  readonly observers: Set<Observer>;
}

let currentObserver: Observer | null = null;
let batchDepth = 0;
const pendingEffects = new Set<EffectNode>();

function track(source: Source): void {
  if (currentObserver) {
    source.observers.add(currentObserver);
    currentObserver.sources.add(source);
  }
}

function unlink(observer: Observer): void {
  for (const source of observer.sources) source.observers.delete(observer);
  observer.sources.clear();
}

function notify(source: Source): void {
  batch(() => {
    for (const observer of [...source.observers]) observer.invalidate();
  });
}

export interface ReadonlySignal<T> {
  readonly value: T;
  /** Read without subscribing. */
  peek(): T;
}

export interface Signal<T> extends ReadonlySignal<T> {
  value: T;
}

class SignalNode<T> implements Signal<T>, Source {
  readonly observers = new Set<Observer>();
  constructor(
    private current: T,
    private readonly equals: (a: T, b: T) => boolean,
  ) {}

  get value(): T {
    track(this);
    return this.current;
  }

  set value(next: T) {
    if (this.equals(this.current, next)) return;
    this.current = next;
    notify(this);
  }

  peek(): T {
    return this.current;
  }
}

class ComputedNode<T> implements ReadonlySignal<T>, Source, Observer {
  readonly observers = new Set<Observer>();
  readonly sources = new Set<Source>();
  private dirty = true;
  private current: T | undefined;
  /** Set when `fn` threw: rethrown on every read until a dependency changes. */
  private error: { thrown: unknown } | undefined;
  private computing = false;

  constructor(private readonly fn: () => T) {}

  invalidate(): void {
    if (this.dirty) return;
    this.dirty = true;
    for (const observer of [...this.observers]) observer.invalidate();
  }

  get value(): T {
    track(this);
    return this.peek();
  }

  peek(): T {
    if (this.dirty) {
      if (this.computing) throw new Error("Cycle detected in computed()");
      this.computing = true;
      unlink(this);
      const previous = currentObserver;
      currentObserver = this;
      try {
        this.current = this.fn();
        this.error = undefined;
      } catch (err) {
        // Remember the failure and count as computed: staying dirty would make invalidate()
        // return early forever, so dependents would never hear of a later (fixed) change.
        this.error = { thrown: err };
      } finally {
        this.dirty = false;
        currentObserver = previous;
        this.computing = false;
      }
    }
    if (this.error) throw this.error.thrown;
    return this.current as T;
  }
}

type EffectFn = () => (() => void) | undefined;

class EffectNode implements Observer, Disposable {
  readonly sources = new Set<Source>();
  private cleanup: (() => void) | undefined;
  private disposed = false;

  constructor(private readonly fn: EffectFn) {}

  invalidate(): void {
    if (!this.disposed) pendingEffects.add(this);
  }

  run(): void {
    if (this.disposed) return;
    this.cleanup?.();
    this.cleanup = undefined;
    unlink(this);
    const previous = currentObserver;
    currentObserver = this;
    try {
      const result = this.fn();
      if (typeof result === "function") this.cleanup = result;
    } finally {
      currentObserver = previous;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    pendingEffects.delete(this);
    unlink(this);
    this.cleanup?.();
    this.cleanup = undefined;
  }
}

/** A writable reactive value. Assigning an equal value (Object.is by default) is a no-op. */
export function signal<T>(initial: T, equals: (a: T, b: T) => boolean = Object.is): Signal<T> {
  return new SignalNode(initial, equals);
}

/** A derived value, recomputed lazily when a dependency changed. */
export function computed<T>(fn: () => T): ReadonlySignal<T> {
  return new ComputedNode(fn);
}

/**
 * Runs `fn` now and again whenever a signal it read changes. `fn` may return a cleanup function,
 * called before each re-run and on dispose. Register the returned Disposable with an owner store.
 */
export function effect(fn: EffectFn): Disposable {
  const node = new EffectNode(fn);
  // In a batch, so a write to a signal it read re-runs it after this run, not nested inside it
  // (a nested run's cleanup would be overwritten and never called). If the first run throws,
  // the caller never gets the Disposable: drop the subscriptions it made.
  batch(() => {
    try {
      node.run();
    } catch (err) {
      node.dispose();
      throw err;
    }
  });
  const disposable = toDisposable(() => node.dispose());
  return disposable;
}

/** Groups writes: dependent effects run once, after `fn` returns. */
export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) flush();
  }
}

/** Reads signals without subscribing the current computed/effect. */
export function untracked<T>(fn: () => T): T {
  const previous = currentObserver;
  currentObserver = null;
  try {
    return fn();
  } finally {
    currentObserver = previous;
  }
}

function flush(): void {
  // Effects may write signals and queue more effects; loop until stable, with a guard.
  let rounds = 0;
  while (pendingEffects.size > 0) {
    if (++rounds > 100) {
      pendingEffects.clear();
      throw new Error("effect() loop: signals keep changing after 100 rounds");
    }
    const effects = [...pendingEffects];
    pendingEffects.clear();
    batchDepth++;
    try {
      for (const node of effects) {
        try {
          node.run();
        } catch (err) {
          console.error("effect failed", err);
        }
      }
    } finally {
      batchDepth--;
    }
  }
}
