// Bookmarks (D143): marked lines, optionally labeled, kept per workspace; they follow their lines
// as text is edited and their files when renamed. Next / previous go through every file's
// bookmarks in order (path, then line), wrapping around. DOM-free and tested.
import { pathKey } from "../../core/paths/index";
import { type Signal, signal } from "../../core/reactive/index";
import { renamedPath } from "../../workbench/gutterMarks";

export interface Bookmark {
  id: number;
  /** Absolute path. */
  path: string;
  /** 1-based. */
  line: number;
  label?: string;
}

const order = (a: Bookmark, b: Bookmark) =>
  pathKey(a.path) < pathKey(b.path) ? -1 : pathKey(a.path) > pathKey(b.path) ? 1 : a.line - b.line;

export class BookmarkStore {
  /** Sorted by path, then line. */
  readonly list: Signal<readonly Bookmark[]> = signal([]);
  private nextId = 1;

  private set(list: Bookmark[]): void {
    this.list.value = list.sort(order);
  }

  forPath(path: string): Bookmark[] {
    const key = pathKey(path);
    return this.list.peek().filter((b) => pathKey(b.path) === key);
  }

  at(path: string, line: number): Bookmark | undefined {
    return this.forPath(path).find((b) => b.line === line);
  }

  /** Adds a bookmark (or relabels the one there). */
  add(path: string, line: number, label?: string): Bookmark {
    const existing = this.at(path, line);
    if (existing) {
      const next = { ...existing, ...(label ? { label } : {}) };
      if (!label) delete next.label;
      this.set(this.list.peek().map((b) => (b.id === existing.id ? next : b)));
      return next;
    }
    const b: Bookmark = { id: this.nextId++, path, line, ...(label ? { label } : {}) };
    this.set([...this.list.peek(), b]);
    return b;
  }

  /** Adds one on the line, or removes the one there. Returns it when added. */
  toggle(path: string, line: number): Bookmark | null {
    const existing = this.at(path, line);
    if (existing) {
      this.remove(existing.id);
      return null;
    }
    return this.add(path, line);
  }

  remove(id: number): void {
    this.list.value = this.list.peek().filter((b) => b.id !== id);
  }

  clear(path?: string): number {
    const before = this.list.peek().length;
    const key = path === undefined ? null : pathKey(path);
    this.list.value = key === null ? [] : this.list.peek().filter((b) => pathKey(b.path) !== key);
    return before - this.list.peek().length;
  }

  /** The bookmark after (or before) `line` of `path`, across files, wrapping; null if none. */
  next(path: string, line: number, direction: 1 | -1): Bookmark | null {
    const list = this.list.peek();
    if (!list.length) return null;
    const here: Bookmark = { id: 0, path, line };
    if (direction === 1) return list.find((b) => order(b, here) > 0) ?? list[0] ?? null;
    return [...list].reverse().find((b) => order(b, here) < 0) ?? list.at(-1) ?? null;
  }

  /** Edits moved `path`'s bookmarks to `lines` (in `forPath` order); two on one line merge. */
  moveLines(path: string, lines: readonly number[]): void {
    const own = this.forPath(path);
    if (own.length !== lines.length) return;
    const seen = new Set<number>();
    const moved = new Map<number, number | null>();
    own.forEach((b, i) => {
      const line = lines[i] ?? b.line;
      if (seen.has(line)) moved.set(b.id, null);
      else if (line !== b.line) moved.set(b.id, line);
      seen.add(line);
    });
    if (!moved.size) return;
    this.set(
      this.list.peek().flatMap((b) => {
        if (!moved.has(b.id)) return [b];
        const line = moved.get(b.id);
        return line === null || line === undefined ? [] : [{ ...b, line }];
      }),
    );
  }

  /** A file or folder was renamed: its bookmarks go with it. */
  renamed(from: string, to: string): void {
    let changed = false;
    const next = this.list.peek().map((b) => {
      const p = renamedPath(b.path, from, to);
      if (p === null) return b;
      changed = true;
      return { ...b, path: p };
    });
    if (changed) this.set(next);
  }

  save(): { path: string; line: number; label?: string }[] {
    return this.list
      .peek()
      .map(({ path, line, label }) => ({ path, line, ...(label ? { label } : {}) }));
  }

  restore(data: unknown): void {
    const out: Bookmark[] = [];
    for (const raw of Array.isArray(data) ? data : []) {
      const b = raw as Partial<Bookmark>;
      if (typeof b.path !== "string" || typeof b.line !== "number" || b.line < 1) continue;
      if (out.some((x) => pathKey(x.path) === pathKey(b.path ?? "") && x.line === b.line)) continue;
      out.push({
        id: this.nextId++,
        path: b.path,
        line: Math.floor(b.line),
        ...(typeof b.label === "string" && b.label ? { label: b.label } : {}),
      });
    }
    this.set(out);
  }
}
