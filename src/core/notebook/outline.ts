// A notebook's outline (D204), as VS Code's notebook outline: the Markdown cells' headings,
// nested by level, and the code cells (by their first line) under the heading above them. Each
// entry's line is its cell's position (1-based), so "the cell the selection is in" works like a
// cursor line, and `endLine` is the last cell under it. DOM-free and tested.

export interface OutlineCell {
  id: string;
  kind: "code" | "markdown" | "raw";
  source: string;
}

export interface NotebookOutlineEntry {
  name: string;
  /** "string" for a heading (the Markdown outline's kind), "cell" for a code cell. */
  kind: "string" | "cell";
  /** The cell's position (1-based) — what the outline calls a line. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  cellId: string;
  /** The heading's line inside its cell (1-based), for revealing it. */
  cellLine: number;
  children: NotebookOutlineEntry[];
}

/** ATX headings (`# Title`) of Markdown text, skipping fenced code; setext (`===`) too. */
export function markdownHeadings(source: string): { level: number; text: string; line: number }[] {
  const out: { level: number; text: string; line: number }[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let fence: string | null = null;
  for (const [i, raw] of lines.entries()) {
    const fenceMark = /^\s{0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
    if (fenceMark) {
      if (!fence) fence = fenceMark[0] as string;
      else if (fenceMark[0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const atx = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (atx?.[1] && atx[2]) {
      out.push({ level: atx[1].length, text: plain(atx[2]), line: i + 1 });
      continue;
    }
    const next = lines[i + 1] ?? "";
    if (raw.trim() && /^\s{0,3}(=+|-+)\s*$/.test(next) && !/^\s{0,3}[-*+>]/.test(raw))
      out.push({
        level: next.trim().startsWith("=") ? 1 : 2,
        text: plain(raw.trim()),
        line: i + 1,
      });
  }
  return out;
}

/** Heading text without emphasis, code and link syntax. */
function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .trim();
}

/** A code cell's label: its first line with text (comments allowed), cut to 60 characters. */
export function codeCellLabel(source: string, index: number): string {
  const first = source
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return `Code cell ${index + 1}`;
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

export function notebookOutline(
  cells: readonly OutlineCell[],
  options: { codeCells?: boolean } = {},
): NotebookOutlineEntry[] {
  const withCode = options.codeCells !== false;
  const root: NotebookOutlineEntry[] = [];
  /** Open headings, outermost first, with their level. */
  const stack: { level: number; entry: NotebookOutlineEntry }[] = [];
  const close = (level: number, lastCell: number) => {
    while (stack.length && (stack[stack.length - 1] as { level: number }).level >= level) {
      const done = stack.pop() as { entry: NotebookOutlineEntry };
      done.entry.endLine = Math.max(done.entry.line, lastCell);
    }
  };
  const add = (entry: NotebookOutlineEntry) =>
    (stack.length
      ? (stack[stack.length - 1] as { entry: NotebookOutlineEntry }).entry.children
      : root
    ).push(entry);
  for (const [i, cell] of cells.entries()) {
    const at = i + 1;
    if (cell.kind === "markdown") {
      for (const h of markdownHeadings(cell.source)) {
        close(h.level, h.line === 1 ? at - 1 : at);
        const entry: NotebookOutlineEntry = {
          name: h.text,
          kind: "string",
          line: at,
          column: 1,
          endLine: at,
          endColumn: 1,
          cellId: cell.id,
          cellLine: h.line,
          children: [],
        };
        add(entry);
        stack.push({ level: h.level, entry });
      }
    } else if (cell.kind === "code" && withCode) {
      add({
        name: codeCellLabel(cell.source, i),
        kind: "cell",
        line: at,
        column: 1,
        endLine: at,
        endColumn: 1,
        cellId: cell.id,
        cellLine: 1,
        children: [],
      });
    }
  }
  close(0, cells.length);
  return root;
}
