// Next-edit suggestions (D193, like Cursor Tab and Copilot's next edit suggestions): after the
// user changes some lines and pauses, the model predicts the edit that should follow — usually
// the same change somewhere else (a renamed parameter's other uses, the next case of a pattern).
// DOM-free and tested: the prompt, and the reply parsed into lines to replace.

export const NEXT_EDIT_SYSTEM = [
  "You predict a programmer's next edit.",
  "You get part of a file with line numbers and the change they just made.",
  "If the change implies another edit nearby (the same rename elsewhere, a matching change, an",
  "updated call or test), reply with exactly one block:",
  "<<<LINES start-end",
  "the new text for those lines",
  ">>>",
  "where start-end are the line numbers to replace (inclusive). Otherwise reply NONE.",
  "Never repeat the change they already made. No explanation.",
].join(" ");

export interface NextEditContext {
  path: string;
  languageId: string;
  /** The file now (LF). */
  text: string;
  /** The file before the user's recent change (LF). */
  before: string;
  /** The cursor's line (1-based). */
  cursorLine: number;
}

export interface NextEdit {
  startLine: number;
  endLine: number;
  /** Replacement for those lines (LF, no trailing newline). */
  text: string;
}

const WINDOW = 40;

/** The user's change as -/+ lines (first 40 changed lines), from `before` to `after`. */
export function recentChange(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out = [
    `@@ line ${start + 1} @@`,
    ...a.slice(start, endA).map((l) => `-${l}`),
    ...b.slice(start, endB).map((l) => `+${l}`),
  ];
  return out.slice(0, 41).join("\n");
}

/** The window of lines the model sees, with their numbers. */
export function excerptBounds(lineCount: number, cursorLine: number): [number, number] {
  const start = Math.max(1, cursorLine - WINDOW);
  const end = Math.min(lineCount, cursorLine + WINDOW);
  return [start, end];
}

export function nextEditPrompt(c: NextEditContext): string {
  const lines = c.text.split("\n");
  const [start, end] = excerptBounds(lines.length, c.cursorLine);
  const width = String(end).length;
  const numbered = lines
    .slice(start - 1, end)
    .map((l, i) => `${String(start + i).padStart(width)}| ${l}`)
    .join("\n");
  return [
    `File: ${c.path} (${c.languageId}), lines ${start}-${end}; the cursor is on line ${c.cursorLine}.`,
    "",
    numbered,
    "",
    "Their change just now:",
    recentChange(c.before, c.text),
    "",
    "Predict the next edit (or NONE).",
  ].join("\n");
}

/**
 * The model's reply → the edit, or null: NONE, a malformed block, lines outside the window the
 * model saw, or a "change" that leaves the lines as they are.
 */
export function parseNextEdit(reply: string, text: string, cursorLine: number): NextEdit | null {
  const clean = reply.replace(/\r\n/g, "\n").replace(/<think>[\s\S]*?<\/think>/g, "");
  // The block ends at a line that is only ">>>" (code itself may hold ">>>": doctests, x >>> 0).
  const m = /<<<LINES\s+(\d+)\s*-\s*(\d+)[ \t]*\n([\s\S]*?)\n>>>[ \t]*(?:\n|$)/.exec(`${clean}\n`);
  if (!m) return null;
  const startLine = Number(m[1]);
  const endLine = Number(m[2]);
  const lines = text.split("\n");
  const [lo, hi] = excerptBounds(lines.length, cursorLine);
  if (!(startLine >= lo && endLine >= startLine && endLine <= hi)) return null;
  // Line numbers the model copied along ("12| foo") come off.
  let body = m[3] ?? "";
  if (/^\s*\d+\| /m.test(body) && body.split("\n").every((l) => /^\s*\d+\| /.test(l) || !l))
    body = body.replace(/^\s*\d+\| /gm, "");
  const current = lines.slice(startLine - 1, endLine).join("\n");
  if (body === current) return null;
  return { startLine, endLine, text: body };
}
