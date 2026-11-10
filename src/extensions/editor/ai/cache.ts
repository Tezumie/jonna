// Caches for AI suggestions in the editor (D224). Copilot and Cursor Tab don't ask the model on
// every key: while the user types the suggestion they're shown, the rest of it is still the
// suggestion, and coming back to a spot shows what was suggested there. `GhostTextCache` does
// that for ghost text (an LRU of suggestions keyed by file, model, the code just before the
// cursor and the code after it); next-edit suggestions keep their answers in an `LruMap` keyed by
// the exact prompt (the same change in the same lines gets the same prediction: undo / redo,
// a change made, reverted and made again). DOM-free and tested.

/** A Map that forgets its least recently used entries past `max`, and entries older than `ttlMs`. */
export class LruMap<K, V> {
  private readonly map = new Map<K, { value: V; at: number }>();

  constructor(
    private readonly max: number,
    private readonly ttlMs = Number.POSITIVE_INFINITY,
  ) {}

  get size(): number {
    return this.map.size;
  }

  has(key: K, now = Date.now()): boolean {
    return this.get(key, now) !== undefined;
  }

  get(key: K, now = Date.now()): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.map.delete(key);
    if (now - entry.at > this.ttlMs) return undefined;
    // Used: it's the newest now (Map keeps insertion order).
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, now = Date.now()): void {
    this.map.delete(key);
    this.map.set(key, { value, at: now });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  /** Newest first. */
  values(now = Date.now()): V[] {
    const out: V[] = [];
    for (const [key, entry] of [...this.map].reverse()) {
      if (now - entry.at > this.ttlMs) this.map.delete(key);
      else out.push(entry.value);
    }
    return out;
  }

  clear(): void {
    this.map.clear();
  }
}

/** Where a suggestion was asked for. */
export interface GhostTextKey {
  path: string;
  /** The completion model ("provider/model"); another model's suggestions don't count. */
  model: string;
  /** Code before the cursor (the window the editor sends; only its end is kept). */
  prefix: string;
  /** Code after the cursor. */
  suffix: string;
}

interface GhostTextEntry {
  path: string;
  model: string;
  /** The last characters of the prefix when it was asked. */
  anchor: string;
  /** The anchor is the whole prefix (the cursor was near the file's start). */
  anchorIsStart: boolean;
  /** The first characters of the suffix. */
  suffix: string;
  /** The suggestion; "" when the model had none there. */
  text: string;
}

/** What the cache knows about a spot: the rest of a suggestion, or that there was none. */
export interface GhostTextHit {
  /** The suggestion from the cursor on; null: the model suggested nothing here. */
  text: string | null;
  /** How much of the suggestion the user had typed since it was asked. */
  typed: number;
}

/** Characters of the prefix that identify a spot (with the suffix's first ones). */
const ANCHOR_CHARS = 1000;
const SUFFIX_CHARS = 400;

/**
 * Ghost-text suggestions by where they were asked. `get` finds one the user is typing through:
 * the prefix now is the prefix then plus the start of the suggestion, and the code after the
 * cursor is the same. Then the rest is the suggestion, without asking the model again.
 */
export class GhostTextCache {
  private readonly entries: LruMap<string, GhostTextEntry>;
  hits = 0;
  misses = 0;

  constructor(max = 64, ttlMs = 10 * 60_000) {
    this.entries = new LruMap(max, ttlMs);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Remembers what the model suggested at `key` (null: nothing). */
  put(key: GhostTextKey, text: string | null, now = Date.now()): void {
    const anchor = key.prefix.slice(-ANCHOR_CHARS);
    const entry: GhostTextEntry = {
      path: key.path,
      model: key.model,
      anchor,
      anchorIsStart: anchor.length === key.prefix.length,
      suffix: key.suffix.slice(0, SUFFIX_CHARS),
      text: text ?? "",
    };
    this.entries.set(
      `${key.path}\u0000${key.model}\u0000${entry.anchor}\u0000${entry.suffix}`,
      entry,
      now,
    );
  }

  /** The suggestion that still applies at `key`, or undefined (ask the model). */
  get(key: GhostTextKey, now = Date.now()): GhostTextHit | undefined {
    const hit = this.find(key, now);
    if (hit) this.hits++;
    else this.misses++;
    return hit;
  }

  /** As `get`, without counting a hit or a miss (the editor checking whether to ask again). */
  peek(key: GhostTextKey, now = Date.now()): GhostTextHit | undefined {
    return this.find(key, now);
  }

  private find(key: GhostTextKey, now: number): GhostTextHit | undefined {
    const suffix = key.suffix.slice(0, SUFFIX_CHARS);
    for (const e of this.entries.values(now)) {
      if (e.path !== key.path || e.model !== key.model) continue;
      // The editor closed a bracket or quote the user typed (D229): the suffix has those in
      // front, and the suggestion's rest without its own copy of them.
      let closed = "";
      if (e.suffix !== suffix) {
        closed = /^[)\]}>"'`]+/.exec(suffix)?.[0] ?? "";
        if (!closed) continue;
        const after = suffix.slice(closed.length);
        if (after !== e.suffix.slice(0, after.length)) continue;
      }
      const at = e.anchorIsStart
        ? key.prefix.startsWith(e.anchor)
          ? 0
          : -1
        : key.prefix.lastIndexOf(e.anchor);
      if (at < 0) continue;
      const typed = key.prefix.slice(at + e.anchor.length);
      if (!typed) {
        if (closed) continue;
        return { text: e.text || null, typed: 0 };
      }
      // Typed into a suggestion: the rest of it, while there is a rest.
      if (e.text.length > typed.length && e.text.startsWith(typed)) {
        const rest = e.text.slice(typed.length);
        if (!closed) return { text: rest, typed: typed.length };
        // The closers the editor added end a one-line rest (`a, b)` after `(`): they're
        // already after the cursor. (Text after them would land inside them: asked again.)
        const end = rest.trimEnd();
        if (!rest.includes("\n") && end.length > closed.length && end.endsWith(closed))
          return { text: end.slice(0, -closed.length), typed: typed.length };
      }
    }
    return undefined;
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

/** One change of an edit, as the editor reports it. */
export interface TextChangeShape {
  /** Characters replaced. */
  rangeLength: number;
  /** Text inserted. */
  text: string;
}

/**
 * Whether an edit may have brought the cursor back to a spot with a known suggestion, so the
 * editor should ask its ghost-text provider again (m7.12). Monaco re-asks only after typing,
 * pasting, and Backspace / Delete run as commands in a focused editor; deleting a word
 * (Ctrl+Backspace), cutting, undo / redo, or a delete after the suggestion was dismissed (Esc,
 * an arrow key, a click) left the cached suggestion unshown. Pure deletions, undo and redo count.
 */
export function editMayReturnToSuggestion(
  changes: readonly TextChangeShape[],
  undoOrRedo: boolean,
): boolean {
  if (undoOrRedo) return changes.length > 0;
  return changes.length > 0 && changes.every((c) => c.text === "" && c.rangeLength > 0);
}
