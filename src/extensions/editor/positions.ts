// Where each file was scrolled to and where its cursor was (D190), per workspace: a file opened
// again — after its tab closed, or after a restart — comes back to that spot, like VS Code.
// The most recent EDITOR_POSITION_CAP files are kept.
import { pathKey } from "../../core/paths/index";

export interface EditorPosition {
  /** The top of the viewport, a fractional 0-based line (EngineEditor.scrollLine). */
  top: number;
  line: number;
  column: number;
}

export const EDITOR_POSITION_CAP = 500;

export class EditorPositions {
  private map = new Map<string, EditorPosition & { path: string }>();
  onChange: () => void = () => {};

  get(path: string): EditorPosition | undefined {
    return this.map.get(pathKey(path));
  }

  set(path: string, at: EditorPosition): void {
    const key = pathKey(path);
    const old = this.map.get(key);
    if (old && old.top === at.top && old.line === at.line && old.column === at.column) return;
    this.map.delete(key);
    this.map.set(key, { path, top: at.top, line: at.line, column: at.column });
    while (this.map.size > EDITOR_POSITION_CAP) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    this.onChange();
  }

  /** A renamed file keeps its spot; so do the files of a renamed or moved folder. */
  rename(from: string, to: string): void {
    const base = pathKey(from);
    for (const [key, at] of [...this.map]) {
      if (key !== base && !key.startsWith(`${base}/`) && !key.startsWith(`${base}\\`)) continue;
      this.map.delete(key);
      this.set(to + at.path.slice(from.length), at);
    }
  }

  save(): (EditorPosition & { path: string })[] {
    return [...this.map.values()];
  }

  load(data: unknown): void {
    this.map = new Map();
    if (!Array.isArray(data)) return;
    for (const d of data.slice(-EDITOR_POSITION_CAP)) {
      if (
        d &&
        typeof d.path === "string" &&
        Number.isFinite(d.top) &&
        Number.isInteger(d.line) &&
        Number.isInteger(d.column) &&
        d.line >= 1 &&
        d.column >= 1
      )
        this.map.set(pathKey(d.path), {
          path: d.path,
          top: Math.max(0, d.top),
          line: d.line,
          column: d.column,
        });
    }
  }
}
