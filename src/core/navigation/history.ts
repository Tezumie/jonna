// Editor navigation history (VS Code's Go back / Go forward, D279): the places the cursor was,
// across files. A move far from the current place (another file, or more than a screenful of
// lines away) starts a new entry; a move nearby updates the current one, so typing and arrowing
// around don't fill the history. Going back or forward moves the index; the next move made from
// there drops the entries ahead of it, as a browser's history does. DOM-free.

export interface NavLocation {
  /** Absolute path of the file. */
  path: string;
  /** 1-based line and column. */
  line: number;
  column: number;
}

/** Lines apart that count as a new place (VS Code's threshold). */
export const NEW_ENTRY_LINES = 10;
/** Entries kept (VS Code keeps 50). */
export const MAX_ENTRIES = 50;

export class NavigationHistory {
  private entries: NavLocation[] = [];
  private index = -1;
  /** The place a back / forward step is going to: its arrival isn't a new move. */
  private arriving: NavLocation | null = null;

  /** Where the cursor is now (an editor's cursor moved or an editor became active). */
  record(at: NavLocation): void {
    const current = this.entries[this.index];
    if (this.arriving) {
      // Until the step lands, late events from where it left (another file, or the same file's
      // old place) are ignored.
      if (!samePlace(this.arriving, at)) return;
      this.arriving = null;
      // The step landed: the entry takes the exact place the editor shows.
      if (current) {
        this.entries[this.index] = { ...at };
        return;
      }
    }
    if (current && current.path === at.path && Math.abs(current.line - at.line) < NEW_ENTRY_LINES) {
      this.entries[this.index] = { ...at };
      return;
    }
    this.entries = [...this.entries.slice(0, this.index + 1), { ...at }];
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this.index = this.entries.length - 1;
  }

  get canGoBack(): boolean {
    return this.index > 0;
  }

  get canGoForward(): boolean {
    return this.index < this.entries.length - 1;
  }

  /** The place one step back (the index moves there), or null at the start. */
  back(): NavLocation | null {
    if (!this.canGoBack) return null;
    return this.step(this.index - 1);
  }

  /** The place one step forward, or null at the end. */
  forward(): NavLocation | null {
    if (!this.canGoForward) return null;
    return this.step(this.index + 1);
  }

  /** Drops a place that can't be opened any more (a deleted file); the index stays on its neighbor. */
  remove(path: string): void {
    // One pass, so the index follows its entry through the merge too (counting before the merge
    // left it one entry ahead).
    const kept: NavLocation[] = [];
    let index = -1;
    this.entries.forEach((e, i) => {
      if (e.path !== path) {
        // Neighbors left together (A, B, A after removing B) merge into one.
        const last = kept[kept.length - 1];
        if (!last || !samePlace(e, last)) kept.push(e);
      }
      if (i === this.index) index = kept.length - 1;
    });
    this.entries = kept;
    this.index = kept.length ? Math.max(index, 0) : -1;
    this.arriving = null;
  }

  /** A step's arrival was seen, or never will be (the editor was already there): moves count again. */
  landed(): void {
    this.arriving = null;
  }

  /** The entries and where the index is (for `ide://navigation`). */
  snapshot(): { entries: NavLocation[]; index: number } {
    return { entries: this.entries.map((e) => ({ ...e })), index: this.index };
  }

  clear(): void {
    this.entries = [];
    this.index = -1;
    this.arriving = null;
  }

  private step(to: number): NavLocation | null {
    const target = this.entries[to];
    if (!target) return null;
    this.index = to;
    this.arriving = target;
    return { ...target };
  }
}

function samePlace(a: NavLocation, b: NavLocation): boolean {
  return a.path === b.path && Math.abs(a.line - b.line) < NEW_ENTRY_LINES;
}
