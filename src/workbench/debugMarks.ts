// What the debugger shows in editors (D143), between the debug extension (which owns breakpoints
// and sessions) and the editor (which draws them): breakpoint dots per file, the line a stopped
// session is on, clicks in the breakpoint margin, and breakpoints that moved because their lines
// were edited. DOM-free.
import { Emitter, type Event } from "../core/events/index";
import { pathKey } from "../core/paths/index";
import { type Signal, signal } from "../core/reactive/index";

export interface BreakpointGlyph {
  line: number;
  /**
   * "unverified": not bound (no session yet, or the debugger couldn't place it); "pending": a
   * triggered breakpoint waiting for its trigger to be hit (D279).
   */
  state: "verified" | "unverified" | "pending" | "disabled";
  conditional: boolean;
  /** A logpoint (prints instead of stopping): drawn as a diamond. */
  log?: boolean;
}

/** What the exception widget shows (debug/exceptionInfo.ts makes it). */
export interface ExceptionMark {
  path: string;
  line: number;
  /** "Exception has occurred: TypeError". */
  title: string;
  message: string;
  stack: readonly string[];
  /** Stack lines left out. */
  more: number;
}

/** Evaluates a hovered expression while paused (the editor's DebugHoverSource). */
export type DebugHover = (q: { path: string; expression: string }) => Promise<{
  value: string;
  children?: { name: string; value: string }[];
  more?: boolean;
} | null>;

export class DebugMarks {
  /** Set while the debugger is paused: editors show values on hover (D145). */
  readonly hover: Signal<DebugHover | null> = signal(null);
  /** Breakpoint dots by `pathKey(path)`. */
  readonly breakpoints: Signal<ReadonlyMap<string, readonly BreakpointGlyph[]>> = signal(new Map());
  /** Where the selected stack frame of a stopped session is (1-based line), or null. */
  readonly execution: Signal<{ path: string; line: number } | null> = signal(null);
  /**
   * The exception widget (D204): what was thrown, shown in a zone under `line` of `path` while
   * the program is stopped there on it.
   */
  readonly exception: Signal<ExceptionMark | null> = signal(null);

  private readonly clicks = new Emitter<{ path: string; line: number }>();
  /** A click in an editor's breakpoint margin. */
  readonly onGutterClick: Event<{ path: string; line: number }> = this.clicks.event;

  private readonly moves = new Emitter<{ path: string; lines: number[] }>();
  /**
   * Edits moved the breakpoints of `path`: `lines` holds each dot's line now, in the order of
   * `breakpoints.get(pathKey(path))`.
   */
  readonly onDidMove: Event<{ path: string; lines: number[] }> = this.moves.event;

  private readonly menus = new Emitter<{ path: string; line: number; x: number; y: number }>();
  /** A right-click in an editor's breakpoint margin (client coordinates). */
  readonly onGutterContextMenu: Event<{ path: string; line: number; x: number; y: number }> =
    this.menus.event;

  gutterContextMenu(path: string, line: number, x: number, y: number): void {
    this.menus.fire({ path, line, x, y });
  }

  glyphs(path: string): readonly BreakpointGlyph[] {
    return this.breakpoints.value.get(pathKey(path)) ?? [];
  }

  gutterClick(path: string, line: number): void {
    this.clicks.fire({ path, line });
  }

  moved(path: string, lines: number[]): void {
    this.moves.fire({ path, lines });
  }
}
