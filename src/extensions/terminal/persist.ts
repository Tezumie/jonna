// Output after a restart (VS Code's persistent sessions, `terminal.enablePersistentSessions`):
// each terminal's last lines are saved with the layout (serialized by xterm's serialize addon,
// colors included) and written back, dimmed, above the new shell's first prompt with a
// "Restored session" line between. After a restart the shell starts fresh; after a page reload
// the process is taken back instead (m7.12) and the text is drawn as it was, the output after its
// `offset` replayed by Rust. DOM-free and tested.

export interface SavedOutput {
  /** Serialized rows (escape sequences included). */
  text: string;
  /** When it was saved (ms since epoch). */
  time: number;
  /**
   * The terminal's output offset the text reflects (m7.12): a page that takes the process back
   * after a reload draws the text as is and gets the output after this offset replayed.
   */
  offset?: number;
  /**
   * The same session's lines as plain text, wrapped rows joined (D253): what a restart shows. The
   * serialized `text` moves the cursor to redraw wrapped rows at the width it was saved at, which
   * smeared a long line (a wrapped row of dashes) across a terminal of another width. Only this
   * session's own lines: earlier sessions' restored lines and separators aren't carried along.
   */
  lines?: string;
}

/** A terminal's saved output is capped so the workspace state stays small. */
export const MAX_SAVED_CHARS = 256 * 1024;
/** VS Code's default for terminal.integrated.persistentSessionScrollback. */
export const DEFAULT_RESTORED_LINES = 100;

const SGR = new RegExp(`${String.fromCharCode(27)}\\[([0-9;:]*)m`, "g");

/** Saved outputs by tab id, from the workspace state (anything malformed is dropped). */
export function parseSavedOutputs(data: unknown): Map<string, SavedOutput> {
  const out = new Map<string, SavedOutput>();
  if (!data || typeof data !== "object" || Array.isArray(data)) return out;
  for (const [tab, value] of Object.entries(data as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    if (typeof v.text !== "string" || !v.text || typeof v.time !== "number") continue;
    const offset =
      typeof v.offset === "number" && Number.isSafeInteger(v.offset) && v.offset >= 0
        ? v.offset
        : undefined;
    const text = v.text.slice(-MAX_SAVED_CHARS);
    const lines = typeof v.lines === "string" && v.lines ? v.lines.slice(-MAX_SAVED_CHARS) : null;
    // A text cut here no longer matches its offset.
    out.set(tab, {
      text,
      time: v.time,
      ...(offset !== undefined && text === v.text && { offset }),
      ...(lines && { lines }),
    });
  }
  return out;
}

/**
 * Makes every colored span of serialized output dim as well (SGR 2 added after each SGR's own
 * attributes, so a reset inside the output doesn't undo it), starting dim.
 */
export function dimmed(text: string): string {
  // CSI … m (SGR) only; the other sequences (cursor moves) stay as they are.
  const body = text.replace(SGR, (_m, params: string) =>
    params ? `\x1b[${params};2m` : "\x1b[0;2m",
  );
  return `\x1b[2m${body}\x1b[0m`;
}

/** What the restored terminal shows above the new shell: the old lines, dim, then a separator. */
export function restoredBanner(saved: SavedOutput, when: string): string {
  // The plain lines reflow at any width; the serialized screen (states saved before D253) only at
  // the width it was saved at. The saved text ends at the old prompt's cursor: a fresh line for
  // the separator.
  const lines = saved.lines
    ? `\x1b[2m${saved.lines.replace(/\s+$/, "").replace(/\r?\n/g, "\r\n")}\x1b[0m`
    : dimmed(saved.text.replace(/(\r?\n)+$/, ""));
  return `${lines}\r\n\x1b[2m──── Restored session · ${when} ────\x1b[0m\r\n`;
}

/**
 * Buffer rows as plain lines (D253): a row that continues the one before (`wrapped`) joins it,
 * trailing spaces go, and so do empty lines at the end. `fresh`: how many lines aren't empty.
 */
export function logicalLines(rows: readonly { text: string; wrapped: boolean }[]): {
  text: string;
  fresh: number;
} {
  const out: string[] = [];
  for (const row of rows) {
    if (row.wrapped && out.length) out[out.length - 1] += row.text;
    else out.push(row.text);
  }
  const lines = out.map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return { text: lines.join("\n"), fresh: lines.filter((l) => l.trim()).length };
}

/** The rows to save: the last `lines` up to the cursor's row (the end of the output). */
export function savedRange(
  cursorRow: number,
  lastContentRow: number,
  lines: number,
): { start: number; end: number } | null {
  const end = Math.max(cursorRow, lastContentRow);
  if (end < 0 || lines <= 0) return null;
  return { start: Math.max(0, end - lines + 1), end };
}
