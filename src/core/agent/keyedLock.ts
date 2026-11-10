// One-at-a-time per key (D253): the agent's calls in a step can run together, and so can several
// subagents, but two edits of the same file must not both read it, change it and write it back
// (the first one's change would be lost). Calls with other keys don't wait.

export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  /** Runs `fn` once the calls before it with the same key have finished (or failed). */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const before = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = before.then(() => mine);
    this.tails.set(key, tail);
    try {
      await before;
      return await fn();
    } finally {
      release();
      // The last in line: nothing waits on this key any more.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Keys with a call running or waiting (tests). */
  get size(): number {
    return this.tails.size;
  }
}

/**
 * The key for an edit of `path` as the agent wrote it: separators and a leading `./` don't
 * matter, nor letter case (Windows and macOS file names ignore it; on Linux two files differing
 * only in case just wait for each other).
 */
export function fileLockKey(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/{2,}/g, "/")
    .toLowerCase();
}
