// Step into target (VS Code's "Step into target"): which of the debugger's targets the editor's
// cursor is on, so the command steps into it without asking. DOM-free and tested.
import type { StepInTarget } from "./session";

/** 1-based positions compared: negative when a is before b. */
const compare = (aLine: number, aCol: number, bLine: number, bCol: number): number =>
  aLine === bLine ? aCol - bCol : aLine - bLine;

/**
 * The target at the cursor (1-based `line`, `column`): one whose range holds it, the narrowest
 * when several do (a call inside another's arguments); a target the debugger gave only a start
 * for counts on its own line, from its start to the next target's. Undefined: none (ask).
 */
export function stepTargetAt(
  targets: readonly StepInTarget[],
  line: number,
  column: number,
): StepInTarget | undefined {
  const placed = targets.filter((t) => t.line !== undefined);
  const holding = placed.filter((t) => {
    const startLine = t.line ?? 0;
    const startCol = t.column ?? 1;
    if (compare(startLine, startCol, line, column) > 0) return false;
    if (t.endLine !== undefined)
      return compare(line, column, t.endLine, t.endColumn ?? Number.MAX_SAFE_INTEGER) <= 0;
    if (startLine !== line) return false;
    // Up to where the next target on the line starts.
    const next = placed
      .filter((o) => o !== t && o.line === line && (o.column ?? 1) > startCol)
      .reduce((min, o) => Math.min(min, o.column ?? 1), Number.MAX_SAFE_INTEGER);
    return column < next;
  });
  const size = (t: StepInTarget) =>
    t.endLine === undefined
      ? Number.MAX_SAFE_INTEGER
      : (t.endLine - (t.line ?? 0)) * 100_000 + (t.endColumn ?? 0) - (t.column ?? 0);
  return holding.sort((a, b) => size(a) - size(b))[0];
}
