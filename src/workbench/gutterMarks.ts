// Marks in editors' margins from extensions other than the debugger (bookmarks, D143): per owner
// and file, a CSS class on a line, drawn in the glyph margin's right lane (breakpoints keep the
// center one). The editor reports marks that moved because their lines were edited. DOM-free.
import { Emitter, type Event } from "../core/events/index";
import { pathKey } from "../core/paths/index";
import { type Signal, signal } from "../core/reactive/index";

export interface GutterMark {
  line: number;
  className: string;
  hover?: string;
  /**
   * Places inside the line to mark as well, by 1-based column (D233: test coverage's branches
   * not taken, where they start), each a class drawn before that character and a hover.
   */
  columns?: readonly { column: number; className: string; hover?: string }[];
}

/**
 * Text before a line's code (D204: the file blame's "author · age"), all of one file's lines the
 * same width so the code stays aligned; `hover` shows on the annotation.
 */
export interface LineAnnotation {
  line: number;
  text: string;
  className: string;
  hover?: string;
}

export class GutterMarks {
  /** pathKey(path) → the annotations drawn before its lines (one owner per file). */
  readonly annotations: Signal<ReadonlyMap<string, readonly LineAnnotation[]>> = signal(new Map());

  /** Replaces `path`'s annotations (empty or null: none). */
  annotate(path: string, list: readonly LineAnnotation[] | null): void {
    const next = new Map(this.annotations.peek());
    if (list?.length) next.set(pathKey(path), list);
    else if (!next.delete(pathKey(path))) return;
    this.annotations.value = next;
  }

  /** owner → pathKey(path) → marks. */
  readonly marks: Signal<ReadonlyMap<string, ReadonlyMap<string, readonly GutterMark[]>>> = signal(
    new Map(),
  );

  private readonly moves = new Emitter<{ owner: string; path: string; lines: number[] }>();
  /** Edits moved `owner`'s marks in `path`: each one's line now, in the order they were set. */
  readonly onDidMove: Event<{ owner: string; path: string; lines: number[] }> = this.moves.event;

  set(owner: string, byPath: ReadonlyMap<string, readonly GutterMark[]>): void {
    const next = new Map(this.marks.peek());
    next.set(owner, byPath);
    this.marks.value = next;
  }

  of(owner: string, path: string): readonly GutterMark[] {
    return this.marks.peek().get(owner)?.get(pathKey(path)) ?? [];
  }

  moved(owner: string, path: string, lines: number[]): void {
    this.moves.fire({ owner, path, lines });
  }
}

/** `path` after `from` was renamed to `to` (itself, or inside a renamed folder); else null. */
export function renamedPath(path: string, from: string, to: string): string | null {
  const p = pathKey(path);
  const f = pathKey(from);
  if (p === f) return to;
  for (const sep of ["/", "\\"]) if (p.startsWith(f + sep)) return to + path.slice(from.length);
  return null;
}
