// A cache bounded by how much it holds, not by how many entries (D416). Entries differ wildly in
// size (a one-line chat and a book-length one, a tiny formula and a huge diagram), so a count
// limit either wastes memory or evicts too eagerly. Least recently used goes first; an entry
// over `maxEntryBytes` isn't kept at all (the caller still gets its value, it's just recomputed
// next time).

export interface SizedCacheOptions<K, V> {
  /** The estimated bytes all entries may hold together. */
  maxBytes: number;
  /** One entry over this isn't cached. */
  maxEntryBytes: number;
  /** An entry's estimated size in bytes (strings: `length * 2`, as JS keeps them in UTF-16). */
  sizeOf: (value: V, key: K) => number;
}

export class SizedCache<K, V> {
  private readonly map = new Map<K, { value: V; bytes: number }>();
  private total = 0;

  constructor(private readonly options: SizedCacheOptions<K, V>) {}

  get size(): number {
    return this.map.size;
  }

  /** The estimated bytes held now. */
  get bytes(): number {
    return this.total;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** The value, now the most recently used. */
  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /** Keeps `value` unless it's over the entry limit; returns whether it was kept. */
  set(key: K, value: V): boolean {
    this.delete(key);
    const bytes = Math.max(0, this.options.sizeOf(value, key));
    if (bytes > this.options.maxEntryBytes || bytes > this.options.maxBytes) return false;
    this.map.set(key, { value, bytes });
    this.total += bytes;
    for (const [oldest, entry] of this.map) {
      if (this.total <= this.options.maxBytes) break;
      this.map.delete(oldest);
      this.total -= entry.bytes;
    }
    return true;
  }

  delete(key: K): void {
    const entry = this.map.get(key);
    if (!entry) return;
    this.map.delete(key);
    this.total -= entry.bytes;
  }

  /** Oldest first. A copy: deleting while iterating is fine. */
  keys(): K[] {
    return [...this.map.keys()];
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }
}

/** A string's estimated bytes in memory (UTF-16). */
export const stringBytes = (text: string): number => text.length * 2;
