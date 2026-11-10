// The debug console's input history, one per console (VS Code keeps one per debug session's
// REPL): Up / Down walk the expressions typed in the console shown, not every console's. A
// console's history is kept under its session's name (the configuration's), so restarting a
// session keeps it. Walking up from a half-typed line keeps that line: Down past the newest
// brings it back. DOM-free and tested.

const MAX_ENTRIES = 100;
const MAX_CONSOLES = 50;

interface Walk {
  entries: string[];
  /** Where Up / Down are: `entries.length` = the line being typed. */
  at: number;
  /** The line being typed when Up first left it. */
  draft: string;
}

export class ConsoleHistory {
  /** By console key, the least recently used first. */
  private readonly walks = new Map<string, Walk>();

  private walk(key: string): Walk {
    let w = this.walks.get(key);
    if (w) this.walks.delete(key);
    else w = { entries: [], at: 0, draft: "" };
    this.walks.set(key, w);
    for (const old of this.walks.keys()) {
      if (this.walks.size <= MAX_CONSOLES) break;
      this.walks.delete(old);
    }
    return w;
  }

  /** An expression was run in console `key`: it's the newest (a repeat of the last isn't added). */
  add(key: string, expression: string): void {
    const w = this.walk(key);
    if (expression && w.entries[w.entries.length - 1] !== expression) {
      w.entries.push(expression);
      if (w.entries.length > MAX_ENTRIES) w.entries.splice(0, w.entries.length - MAX_ENTRIES);
    }
    w.at = w.entries.length;
    w.draft = "";
  }

  /**
   * Up (`-1`) or Down (`1`) in console `key`'s history from the line `current`: the line to show,
   * or null when there's nothing to move to (no history, or already at the end it moves past).
   */
  move(key: string, by: -1 | 1, current: string): string | null {
    const w = this.walk(key);
    if (!w.entries.length) return null;
    const to = Math.max(0, Math.min(w.entries.length, w.at + by));
    if (to === w.at) return null;
    if (w.at === w.entries.length) w.draft = current;
    w.at = to;
    return to === w.entries.length ? w.draft : (w.entries[to] ?? "");
  }

  /** Console `key`'s expressions, oldest first. */
  entries(key: string): readonly string[] {
    return this.walks.get(key)?.entries ?? [];
  }
}
