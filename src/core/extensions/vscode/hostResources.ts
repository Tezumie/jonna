// What an extension leaves running in the shared Node extension host (D295) that unloading its
// modules doesn't stop: its timers (VS Code ends them with the whole extension host; here one
// extension leaves while the others run, so they're cleared with it) and its native addons
// (`.node` files: Node can't unload them, and Windows keeps their files locked, so the folder of
// an extension being uninstalled or updated couldn't be deleted — the host restarts instead, as
// VS Code restarts its extension host). Owners are found as console output's are: the extension
// whose file is on the stack (timers) or whose folder holds the file (addons). DOM-free and
// unit-tested; `src/workers/extension.node.ts` installs it.

/** The timer functions this replaces (Node's globals; a test's fakes). */
export interface TimerGlobals {
  setTimeout: (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => unknown;
  clearInterval: (handle: unknown) => void;
  setImmediate?: (callback: (...args: unknown[]) => void, ...args: unknown[]) => unknown;
  clearImmediate?: (handle: unknown) => void;
}

type TimerKind = "timeout" | "interval" | "immediate";

/** A function's own properties (Node's `promisify.custom` on setTimeout) onto its replacement. */
function copyProperties(from: unknown, to: unknown): void {
  if (typeof from !== "function" || typeof to !== "function") return;
  for (const key of Reflect.ownKeys(from)) {
    if (key === "length" || key === "name" || key === "prototype") continue;
    const descriptor = Object.getOwnPropertyDescriptor(from, key);
    if (descriptor) Object.defineProperty(to, key, descriptor);
  }
}

export class ExtensionResources {
  /** Each extension's live timers (lowercase id → handle → kind). */
  private readonly timers = new Map<string, Map<unknown, TimerKind>>();
  /** Each extension's native addons (lowercase id → files). */
  private readonly native = new Map<string, Set<string>>();
  private clear: Record<TimerKind, (handle: unknown) => void> | null = null;

  /**
   * Replaces the timer functions on `globals` with ones that remember whose timer it is
   * (`owner()`, the extension on the stack when it's set; none: not tracked). Returns the
   * originals' restore.
   */
  trackTimers(globals: TimerGlobals, owner: () => string | undefined): () => void {
    // By name: `globals` is globalThis in the host, whose properties a spread would all copy
    // (and miss any that aren't enumerable).
    const original: TimerGlobals = {
      setTimeout: globals.setTimeout,
      clearTimeout: globals.clearTimeout,
      setInterval: globals.setInterval,
      clearInterval: globals.clearInterval,
      ...(globals.setImmediate && { setImmediate: globals.setImmediate }),
      ...(globals.clearImmediate && { clearImmediate: globals.clearImmediate }),
    };
    const { setImmediate, clearImmediate } = original;
    this.clear = {
      timeout: (h) => original.clearTimeout(h),
      interval: (h) => original.clearInterval(h),
      immediate: (h) => clearImmediate?.(h),
    };
    const remember = (handle: unknown, kind: TimerKind, id: string | undefined) => {
      if (id === undefined) return;
      const own = this.timers.get(id) ?? new Map<unknown, TimerKind>();
      this.timers.set(id, own);
      own.set(handle, kind);
    };
    const forget = (handle: unknown) => {
      for (const [id, own] of this.timers)
        if (own.delete(handle)) {
          if (!own.size) this.timers.delete(id);
          return;
        }
    };
    globals.setTimeout = (callback, ms, ...args) => {
      const id = owner();
      if (id === undefined || typeof callback !== "function")
        return original.setTimeout(callback, ms, ...args);
      // Done once it has run: forgotten then (a one-off timer isn't kept for the extension).
      const handle = original.setTimeout(
        (...a: unknown[]) => {
          forget(handle);
          callback(...a);
        },
        ms,
        ...args,
      );
      remember(handle, "timeout", id);
      return handle;
    };
    globals.setInterval = (callback, ms, ...args) => {
      const handle = original.setInterval(callback, ms, ...args);
      remember(handle, "interval", owner());
      return handle;
    };
    globals.clearTimeout = (handle) => {
      forget(handle);
      original.clearTimeout(handle);
    };
    globals.clearInterval = (handle) => {
      forget(handle);
      original.clearInterval(handle);
    };
    if (setImmediate && clearImmediate) {
      globals.setImmediate = (callback, ...args) => {
        const id = owner();
        if (id === undefined || typeof callback !== "function")
          return setImmediate(callback, ...args);
        const handle = setImmediate(
          (...a: unknown[]) => {
            forget(handle);
            callback(...a);
          },
          ...args,
        );
        remember(handle, "immediate", id);
        return handle;
      };
      globals.clearImmediate = (handle) => {
        forget(handle);
        clearImmediate(handle);
      };
    }
    // `util.promisify(setTimeout)` and the like read Node's own properties (promisify.custom).
    for (const name of ["setTimeout", "setInterval", "setImmediate"] as const)
      if (globals[name] !== original[name]) copyProperties(original[name], globals[name]);
    return () => Object.assign(globals, original);
  }

  /** `id`'s timers still pending. */
  timerCount(id: string): number {
    return this.timers.get(id.toLowerCase())?.size ?? 0;
  }

  /** A native addon was loaded from `file`, in `id`'s folder (none: not an extension's). */
  addNative(id: string | undefined, file: string): void {
    if (id === undefined) return;
    const key = id.toLowerCase();
    const files = this.native.get(key) ?? new Set<string>();
    this.native.set(key, files);
    files.add(file);
  }

  /** The native addons `id` loaded (they stay loaded until the process ends). */
  nativeOf(id: string): string[] {
    return [...(this.native.get(id.toLowerCase()) ?? [])];
  }

  /**
   * `id` is unloaded: its timers are cleared. Its native addons are returned (and forgotten:
   * the host restarts, or the extension loads them again from the same files).
   */
  release(id: string): { native: string[]; timers: number } {
    const key = id.toLowerCase();
    const own = this.timers.get(key);
    this.timers.delete(key);
    let timers = 0;
    for (const [handle, kind] of own ?? []) {
      this.clear?.[kind](handle);
      timers++;
    }
    const native = this.nativeOf(key);
    this.native.delete(key);
    return { native, timers };
  }
}
