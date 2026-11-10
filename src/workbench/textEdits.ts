// Several edits applied to one text at once (VS Code's TextEdit[] against one document) (D248): what an
// extension's `workspace.applyEdit` and `onWillSaveTextDocument` hand back. Every range is read
// against the original text, so the edits are applied from the last to the first; overlapping
// edits are refused (VS Code refuses them too). DOM-free, unit-tested.
import type { TextRange } from "./extensionFeatures";

export type RangeEdit = TextRange & { text: string };

/** The [start, end) offsets of `range` in `text` (1-based lines and columns; no columns: whole lines). */
export function rangeOffsets(text: string, range: TextRange): [number, number] {
  const lines = text.split("\n");
  const last = lines.length;
  const startLine = Math.min(Math.max(1, Math.floor(range.startLine)), last);
  const endLine = Math.min(Math.max(startLine, Math.floor(range.endLine ?? startLine)), last);
  const content = (n: number) => (lines[n - 1] ?? "").replace(/\r$/, "");
  const offsetOf = (line: number, column: number) => {
    let at = 0;
    for (let i = 1; i < line; i++) at += (lines[i - 1] ?? "").length + 1;
    return at + Math.min(Math.max(1, Math.floor(column)), content(line).length + 1) - 1;
  };
  const wholeLines = range.startColumn === undefined && range.endColumn === undefined;
  // A position past the last line is the end of the text, as in VS Code (D261: replacing
  // `Range(0, 0, lineCount, 0)` kept the last line).
  const start =
    Math.floor(range.startLine) > last
      ? text.length
      : offsetOf(startLine, wholeLines ? 1 : (range.startColumn ?? 1));
  // Whole lines keep their last line break, as ide.editor.replace does (applyRangeEdit).
  const end =
    Math.floor(range.endLine ?? range.startLine) > last
      ? text.length
      : offsetOf(
          endLine,
          wholeLines || range.endColumn === undefined
            ? content(endLine).length + 1
            : range.endColumn,
        );
  return [start, Math.max(start, end)];
}

/**
 * `text` with every edit applied. Throws when two edits overlap (an insertion at the same place
 * as another is fine: they go in the order given).
 */
export function applyTextEdits(text: string, edits: readonly RangeEdit[]): string {
  const placed = edits
    .map((e, order) => {
      const [start, end] = rangeOffsets(text, e);
      return { start, end, text: e.text, order };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order);
  for (let i = 1; i < placed.length; i++) {
    const prev = placed[i - 1];
    const cur = placed[i];
    if (prev && cur && cur.start < prev.end) throw new Error("The edits overlap.");
  }
  let out = text;
  for (let i = placed.length - 1; i >= 0; i--) {
    const e = placed[i];
    if (e) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/** The number of lines of `text` (what a whole-file range ends at). */
export function lineCount(text: string): number {
  return text.split("\n").length;
}

/** One step of an extension's WorkspaceEdit, checked: consecutive text edits of a file are one. */
export type EditStep =
  | { kind: "text"; path: string; edits: RangeEdit[] }
  | { kind: "create"; path: string; contents: string; overwrite: boolean; ignoreIfExists: boolean }
  | { kind: "rename"; from: string; to: string; overwrite: boolean; ignoreIfExists: boolean }
  | { kind: "delete"; path: string; recursive: boolean; ignoreIfNotExists: boolean };

const MAX_EDIT_ENTRIES = 5000;
const MAX_CONTENTS = 10_000_000;

/**
 * An extension's WorkspaceEdit entries as steps, in order; `resolve` turns its paths into
 * workspace paths (throwing for anything outside). Throws for an entry it can't read, so nothing
 * is applied from a malformed edit.
 */
export function planWorkspaceEdit(raw: unknown, resolve: (path: unknown) => string): EditStep[] {
  const entries = Array.isArray(raw) ? raw : [];
  if (entries.length > MAX_EDIT_ENTRIES)
    throw new Error(`A workspace edit holds at most ${MAX_EDIT_ENTRIES} entries.`);
  const steps: EditStep[] = [];
  const int = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined;
  for (const item of entries) {
    const e = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    switch (e.kind) {
      case "text": {
        const path = resolve(e.path);
        const startLine = int(e.startLine);
        if (!startLine || startLine < 1 || typeof e.text !== "string")
          throw new Error("A text edit needs a startLine (1-based) and text.");
        const edit: RangeEdit = { startLine, text: e.text };
        for (const key of ["startColumn", "endLine", "endColumn"] as const) {
          const v = int(e[key]);
          if (v !== undefined && v >= 1) edit[key] = v;
        }
        const last = steps[steps.length - 1];
        if (last?.kind === "text" && last.path === path) last.edits.push(edit);
        else steps.push({ kind: "text", path, edits: [edit] });
        break;
      }
      case "create": {
        const contents = typeof e.contents === "string" ? e.contents : "";
        if (contents.length > MAX_CONTENTS) throw new Error("A created file's text is too large.");
        steps.push({
          kind: "create",
          path: resolve(e.path),
          contents,
          overwrite: e.overwrite === true,
          ignoreIfExists: e.ignoreIfExists === true,
        });
        break;
      }
      case "rename":
        steps.push({
          kind: "rename",
          from: resolve(e.from),
          to: resolve(e.to),
          overwrite: e.overwrite === true,
          ignoreIfExists: e.ignoreIfExists === true,
        });
        break;
      case "delete":
        steps.push({
          kind: "delete",
          path: resolve(e.path),
          recursive: e.recursive === true,
          ignoreIfNotExists: e.ignoreIfNotExists === true,
        });
        break;
      default:
        throw new Error(`Unknown workspace edit entry "${String(e.kind)}".`);
    }
  }
  return steps;
}
