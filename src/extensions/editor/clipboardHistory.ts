// Paste from history (IntelliJ's Ctrl+Shift+V): the last texts copied or cut in the editor, newest
// first, plus what's on the system clipboard when the list opens (a copy from another program).
// Kept in memory only: what people copy includes passwords and keys, so it's never written to
// disk, shown to agents or kept past the window. DOM-free, tested.

/** How many entries are kept. */
export const HISTORY_SIZE = 30;
/** Longer copies aren't kept (a whole generated file): the list is for snippets (D407: 30 of a
 * million characters each was 60 MB held for a list of snippets). */
export const MAX_ENTRY_CHARS = 100_000;

export interface ClipboardEntry {
  readonly text: string;
  /** When it was copied (ms since the epoch). */
  readonly at: number;
  /** Copied from a file whose values are hidden: the list doesn't show it (D407). */
  readonly secret?: boolean;
}

export class ClipboardHistory {
  private items: ClipboardEntry[] = [];

  constructor(private readonly size = HISTORY_SIZE) {}

  /** Adds a copy at the top; the same text copied again moves up instead of repeating. */
  add(text: string, at = Date.now(), secret = false): void {
    if (!text.trim() || text.length > MAX_ENTRY_CHARS) return;
    // Hidden once is hidden again: the same text copied (or pasted) later keeps the flag.
    const hidden = secret || this.items.some((e) => e.text === text && e.secret);
    this.items = [
      { text, at, ...(hidden && { secret: true }) },
      ...this.items.filter((e) => e.text !== text),
    ].slice(0, this.size);
  }

  /** Newest first. */
  entries(): readonly ClipboardEntry[] {
    return this.items;
  }

  remove(text: string): void {
    this.items = this.items.filter((e) => e.text !== text);
  }

  clear(): void {
    this.items = [];
  }
}

/** What the editor's copies go to (one per window: every editor shares it). */
export const editorClipboard = new ClipboardHistory();

export interface HistoryRow {
  /** The first line with text, trimmed and shortened. */
  label: string;
  /** "3 lines · 2 min ago" */
  description: string;
  /** The next lines, joined with ⏎, shortened: a preview of the rest. */
  detail: string;
}

const LABEL_CHARS = 80;
const DETAIL_CHARS = 160;

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** The picker's row for an entry. */
export function historyRow(entry: ClipboardEntry, now = Date.now()): HistoryRow {
  if (entry.secret)
    return {
      label: "Hidden value",
      description: `from a secrets file · ${ago(now - entry.at)}`,
      detail: "",
    };
  const lines = entry.text.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() !== "");
  const label = shorten((lines[first] ?? "").trim(), LABEL_CHARS);
  const rest = lines
    .slice(first + 1)
    .map((l) => l.trim())
    .filter(Boolean);
  const count = lines.length - (lines.at(-1) === "" ? 1 : 0);
  const size = count > 1 ? `${count} lines` : `${entry.text.length} characters`;
  return {
    label,
    description: `${size} · ${ago(now - entry.at)}`,
    detail: shorten(rest.join(" ⏎ "), DETAIL_CHARS),
  };
}
