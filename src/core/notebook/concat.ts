// A notebook's code cells as one document for a language server (D204), VS Code's approach for
// Python notebooks: the cells are joined in order, the server sees one module (names defined in
// one cell are known in the next), and positions map between the joined text and each cell.
// Jupyter's magics (`%matplotlib`, `!pip`, a `%%bash` cell) aren't the cell's language: in Python
// they're turned into comments of the same length, so no column moves. DOM-free and tested.

/** A code cell as the joined document takes it. */
export interface ConcatCellInput {
  id: string;
  text: string;
}

/** A position inside one cell (0-based, as LSP counts). */
export interface CellPosition {
  cellId: string;
  line: number;
  character: number;
}

export interface LspLikeRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface CellSpan {
  id: string;
  /** First line of the cell in the joined text. */
  startLine: number;
  lineCount: number;
  /** Each line's length, for clipping. */
  lengths: number[];
}

/**
 * `text` with Jupyter's IPython syntax neutralized for Python: a cell magic (`%%time`, `%%bash`)
 * comments out the whole cell; a line magic or shell line (`%pip`, `!ls`) is commented out; a
 * shell command or magic assigned (`x = !ls`, `t = %time f()`) becomes a stand-in value (`[]`,
 * as IPython's SList is a list; `...`); a help line (`obj?`, `??obj`, `np.*load*?`) is commented
 * out (D229, as Pylance's IPython mode does). Characters change, never their count, so every
 * column stays where it was.
 */
export function maskMagics(text: string, languageId: string): string {
  if (languageId !== "python") return text;
  const lines = text.split("\n");
  const comment = (line: string) => line.replace(/^(\s*)\S/, "$1#");
  if (/^\s*%%/.test(lines[0] ?? "")) return lines.map(comment).join("\n");
  return lines.map((line) => maskLine(line, comment)).join("\n");
}

/** `name = !cmd`, `a, b = %magic …`: simple assignment targets, then the IPython part. */
const ASSIGNED = /^(\s*[A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*\s*=\s*)([!%].*)$/;
/** `obj?`, `obj.attr??`, `?obj`, `np.*load*?`: Python has no `?`, so this is IPython's help. */
const HELP = /^\s*(?:\?{1,2}[\w.*]+|[\w.*]+\?{1,2})\s*$/;

function maskLine(line: string, comment: (line: string) => string): string {
  if (/^\s*[%!]/.test(line) || HELP.test(line)) return comment(line);
  const assigned = ASSIGNED.exec(line);
  if (!assigned) return line;
  const [, target = "", rest = ""] = assigned;
  const value = rest.startsWith("!") ? "[]" : "...";
  const masked = value.length <= rest.length ? value : "0";
  return target + masked + " ".repeat(rest.length - masked.length);
}

/** An edit in one cell (0-based positions within the cell). */
export interface CellEdit {
  cellId: string;
  range: LspLikeRange;
  text: string;
}

/** Lines × lines a cross-cell edit's line diff compares at most (beyond: not divided). */
const MAX_DIFF_CELLS = 2_000_000;

/** A line as the diff compares it: formatters change spacing, so spacing doesn't count. */
const lineKey = (line: string) => line.replace(/\s+/g, "");

/**
 * `next` divided into one piece per old part (the parts were joined with "\n"; the pieces are
 * taken at "\n"s of `next`, which go away as the separators did). Each boundary goes where the
 * lines around it went: a line diff (longest common subsequence) where lines that differ only
 * in spacing are the same line, as a formatter leaves them. Null when a boundary has no line to
 * follow or the text is too big to compare.
 */
export function divideAtBoundaries(parts: readonly string[], next: string): string[] | null {
  if (parts.length < 2) return [next];
  const oldKeys = parts.join("\n").split("\n").map(lineKey);
  const newLines = next.split("\n");
  const newKeys = newLines.map(lineKey);
  const n = oldKeys.length;
  const m = newKeys.length;
  // Old line → its new line, for the lines that match.
  const match = new Array<number>(n).fill(-1);
  // The same lines at both ends are matched as they are; the diff compares the middle.
  let head = 0;
  while (head < n && head < m && oldKeys[head] === newKeys[head]) {
    match[head] = head;
    head++;
  }
  let tail = 0;
  while (tail < n - head && tail < m - head && oldKeys[n - 1 - tail] === newKeys[m - 1 - tail]) {
    match[n - 1 - tail] = m - 1 - tail;
    tail++;
  }
  const rows = n - head - tail;
  const cols = m - head - tail;
  if (rows > 0 && cols > 0) {
    if (rows * cols > MAX_DIFF_CELLS) return null;
    // LCS lengths from the end: table[i][j] for the middle's old lines i.., new lines j...
    const width = cols + 1;
    const table = new Uint32Array((rows + 1) * width);
    const same = (i: number, j: number) => oldKeys[head + i] === newKeys[head + j];
    for (let i = rows - 1; i >= 0; i--)
      for (let j = cols - 1; j >= 0; j--)
        table[i * width + j] = same(i, j)
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    for (let i = 0, j = 0; i < rows && j < cols; ) {
      if (same(i, j)) {
        match[head + i] = head + j;
        i++;
        j++;
      } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) i++;
      else j++;
    }
  }
  const breaks: number[] = [];
  let line = -1;
  for (let k = 0; k < parts.length - 1; k++) {
    // `line`: the last old line of part k; the boundary follows it.
    line += (parts[k] as string).split("\n").length;
    const after = match[line + 1] ?? -1;
    // The new break follows new line j: just before where the next part's first line went (the
    // changed lines in between stay with the earlier part), else after the nearest earlier
    // line that matched.
    let j = after >= 0 ? after - 1 : -1;
    if (after < 0)
      for (let i = line; i >= 0 && j < 0; i--) if ((match[i] ?? -1) >= 0) j = match[i] ?? -1;
    const previous = breaks[breaks.length - 1] ?? -1;
    if (j < 0 || j > m - 2 || j <= previous) return null;
    breaks.push(j);
  }
  const out: string[] = [];
  let from = 0;
  for (const j of breaks) {
    out.push(newLines.slice(from, j + 1).join("\n"));
    from = j + 1;
  }
  out.push(newLines.slice(from).join("\n"));
  return out;
}

/**
 * What changes from `old` to `next`: the common start's and end's lengths and the new text in
 * between (never splitting a surrogate pair).
 */
function narrow(old: string, next: string): [number, number, string] {
  const max = Math.min(old.length, next.length);
  let p = 0;
  while (p < max && old.charCodeAt(p) === next.charCodeAt(p)) p++;
  while (p > 0 && /[\uD800-\uDBFF]/.test(old.charAt(p - 1))) p--;
  let q = 0;
  while (q < max - p && old.charCodeAt(old.length - 1 - q) === next.charCodeAt(next.length - 1 - q))
    q++;
  while (q > 0 && /[\uDC00-\uDFFF]/.test(old.charAt(old.length - q))) q--;
  return [p, q, next.slice(p, next.length - q)];
}

export class ConcatDocument {
  readonly text: string;
  private readonly spans: CellSpan[] = [];
  private readonly byId = new Map<string, CellSpan>();
  /** Each joined line's offset in `text`. */
  private readonly lineStarts: number[] = [];

  constructor(cells: readonly ConcatCellInput[], languageId = "") {
    const parts: string[] = [];
    let line = 0;
    for (const cell of cells) {
      // Cells are joined with one newline; a cell's own CR (a CRLF notebook) would count as a
      // character at the line's end, so it goes.
      const text = maskMagics(cell.text.replace(/\r\n?/g, "\n"), languageId);
      const lines = text.split("\n");
      const span: CellSpan = {
        id: cell.id,
        startLine: line,
        lineCount: lines.length,
        lengths: lines.map((l) => l.length),
      };
      this.spans.push(span);
      this.byId.set(cell.id, span);
      parts.push(text);
      line += lines.length;
    }
    this.text = parts.join("\n");
    let offset = 0;
    for (const span of this.spans)
      for (const length of span.lengths) {
        this.lineStarts.push(offset);
        offset += length + 1;
      }
  }

  get cellIds(): string[] {
    return this.spans.map((s) => s.id);
  }

  has(cellId: string): boolean {
    return this.byId.has(cellId);
  }

  /** The joined document's position for a cell position (null: no such cell). */
  toConcat(
    cellId: string,
    line: number,
    character: number,
  ): { line: number; character: number } | null {
    const span = this.byId.get(cellId);
    if (!span) return null;
    const l = Math.max(0, Math.min(line, span.lineCount - 1));
    return { line: span.startLine + l, character: Math.max(0, character) };
  }

  /** The cell holding a joined-document position (null: past the end). */
  fromConcat(line: number, character: number): CellPosition | null {
    const span = this.spanAt(line);
    if (!span) return null;
    return { cellId: span.id, line: line - span.startLine, character };
  }

  /**
   * A joined-document range as a range in one cell: the cell of its start; an end in a later
   * cell is clipped to the end of the start's cell (a range never spans cells in the editor).
   */
  rangeFromConcat(range: LspLikeRange): { cellId: string; range: LspLikeRange } | null {
    const span = this.spanAt(range.start.line);
    if (!span) return null;
    const startLine = range.start.line - span.startLine;
    let endLine = range.end.line - span.startLine;
    let endChar = range.end.character;
    if (endLine >= span.lineCount) {
      endLine = span.lineCount - 1;
      endChar = span.lengths[endLine] ?? 0;
    }
    if (endLine < startLine) endLine = startLine;
    return {
      cellId: span.id,
      range: {
        start: { line: startLine, character: range.start.character },
        end: { line: endLine, character: endChar },
      },
    };
  }

  /** A cell's whole text as a joined-document range (null: no such cell). */
  cellRange(cellId: string): LspLikeRange | null {
    const span = this.byId.get(cellId);
    if (!span) return null;
    const last = span.lineCount - 1;
    return {
      start: { line: span.startLine, character: 0 },
      end: { line: span.startLine + last, character: span.lengths[last] ?? 0 },
    };
  }

  /**
   * An edit's joined-document range in its cell, only when both ends are in the same cell (an
   * edit across cells is null here; `splitEdit` clips it to each cell's part).
   */
  editFromConcat(range: LspLikeRange): { cellId: string; range: LspLikeRange } | null {
    const start = this.spanAt(range.start.line);
    if (!start || this.spanAt(range.end.line) !== start) return null;
    return {
      cellId: start.id,
      range: {
        start: { line: range.start.line - start.startLine, character: range.start.character },
        end: { line: range.end.line - start.startLine, character: range.end.character },
      },
    };
  }

  /**
   * A server's edit on the joined document as edits in cells (m7.12). Inside one cell it's that
   * cell's edit. Across cells it's clipped to each cell's part, as VS Code does with notebook
   * edits: the change is first narrowed to the text that really differs (a formatter often
   * replaces a large range), and the new text is divided at the cell boundaries by matching
   * unchanged lines on both sides (a line diff). When the boundaries can't be placed that way,
   * the new text goes to the first cell and the later cells' parts are deleted, so the joined
   * text still comes out as the server meant. [] when the range isn't in the document.
   */
  splitEdit(range: LspLikeRange, newText: string): CellEdit[] {
    const one = this.editFromConcat(range);
    if (one) return [{ ...one, text: newText }];
    const s0 = this.offsetOf(range.start.line, range.start.character);
    const e0 = this.offsetOf(range.end.line, range.end.character);
    if (s0 === null || e0 === null || e0 < s0) return [];
    // The part that differs.
    const [p, q, text] = narrow(this.text.slice(s0, e0), newText);
    const s = s0 + p;
    const e = e0 - q;
    const first = this.spanAt(this.positionOf(s).line);
    const last = this.spanAt(this.positionOf(e).line);
    if (!first || !last) return [];
    const firstIndex = this.spans.indexOf(first);
    const lastIndex = this.spans.indexOf(last);
    const at = (offset: number) => {
      const pos = this.positionOf(offset);
      const span = this.spanAt(pos.line) as CellSpan;
      return { line: pos.line - span.startLine, character: pos.character };
    };
    if (first === last) return [{ cellId: first.id, range: { start: at(s), end: at(e) }, text }];
    // Whole lines on both sides (the line diff compares lines): the text before `s` on its line
    // and after `e` on its line is the same in the old and the new.
    const sLine = this.positionOf(s).line;
    const eLine = this.positionOf(e).line;
    const from = this.lineStarts[sLine] ?? 0;
    const next = this.lineStarts[eLine + 1];
    const to = next === undefined ? this.text.length : next - 1;
    const whole = this.text.slice(from, s) + text + this.text.slice(e, to);
    // Each touched cell's part of the old text: [from, to) offsets, separators excluded.
    const parts: { span: CellSpan; from: number; to: number }[] = [];
    for (let k = firstIndex; k <= lastIndex; k++) {
      const span = this.spans[k] as CellSpan;
      const start = this.lineStarts[span.startLine] ?? 0;
      const lastLine = span.startLine + span.lineCount - 1;
      const end = (this.lineStarts[lastLine] ?? 0) + (span.lengths[span.lineCount - 1] ?? 0);
      parts.push({ span, from: Math.max(from, start), to: Math.min(to, end) });
    }
    const pieces = divideAtBoundaries(
      parts.map((x) => this.text.slice(x.from, x.to)),
      whole,
    );
    if (!pieces)
      // Not divided: the first cell's part takes the new text, the others' parts go.
      return parts.map((x, k) => ({
        cellId: x.span.id,
        range: { start: at(Math.max(x.from, s)), end: at(Math.min(x.to, e)) },
        text: k === 0 ? text : "",
      }));
    const out: CellEdit[] = [];
    for (const [k, x] of parts.entries()) {
      // Each cell's edit narrowed to what changed in it (its cursor and markers stay put).
      const [a, b, piece] = narrow(this.text.slice(x.from, x.to), pieces[k] ?? "");
      if (a === x.to - x.from - b && !piece) continue;
      out.push({
        cellId: x.span.id,
        range: { start: at(x.from + a), end: at(x.to - b) },
        text: piece,
      });
    }
    return out;
  }

  /** Offset in the joined text of a position (the character clamped to its line); null: no line. */
  private offsetOf(line: number, character: number): number | null {
    const start = this.lineStarts[line];
    if (start === undefined) return null;
    const next = this.lineStarts[line + 1];
    const length = (next === undefined ? this.text.length : next - 1) - start;
    return start + Math.max(0, Math.min(character, length));
  }

  private positionOf(offset: number): { line: number; character: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: offset - (this.lineStarts[lo] ?? 0) };
  }

  /** A cell's last line that has text (0-based within the cell), or -1 for an empty cell. */
  lastTextLine(cellId: string): number {
    const span = this.byId.get(cellId);
    if (!span) return -1;
    for (let i = span.lineCount - 1; i >= 0; i--) if ((span.lengths[i] ?? 0) > 0) return i;
    return -1;
  }

  private spanAt(line: number): CellSpan | undefined {
    if (line < 0) return undefined;
    // Binary search: notebooks can have hundreds of cells and diagnostics come in batches.
    let lo = 0;
    let hi = this.spans.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = this.spans[mid] as CellSpan;
      if (line < s.startLine) hi = mid - 1;
      else if (line >= s.startLine + s.lineCount) lo = mid + 1;
      else return s;
    }
    return undefined;
  }
}

/**
 * The joined document's semantic tokens (LSP's relative 5-number encoding) that are in one cell,
 * encoded again from the cell's first line (D229). Tokens are on one line each, so a line decides.
 */
export function cellSemanticTokens(
  doc: ConcatDocument,
  cellId: string,
  data: ArrayLike<number>,
): number[] {
  const range = doc.cellRange(cellId);
  if (!range) return [];
  const first = range.start.line;
  const last = range.end.line;
  const out: number[] = [];
  let line = 0;
  let char = 0;
  let outLine = first;
  let outChar = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i] ?? 0;
    line += deltaLine;
    char = deltaLine ? (data[i + 1] ?? 0) : char + (data[i + 1] ?? 0);
    if (line < first) continue;
    if (line > last) break;
    const dl = line - outLine;
    out.push(dl, dl ? char : char - outChar, data[i + 2] ?? 0, data[i + 3] ?? 0, data[i + 4] ?? 0);
    outLine = line;
    outChar = char;
  }
  return out;
}

/**
 * The change from one token array to the next as semantic-token edits (LSP's / Monaco's delta:
 * at most one edit, the part between the common start and end; [] when they're the same), so an
 * editor given `before` gets only what changed (m7.12).
 */
export function semanticTokensDiff(
  before: readonly number[],
  after: readonly number[],
): { start: number; deleteCount: number; data: number[] }[] {
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before[p] === after[p]) p++;
  let q = 0;
  while (q < max - p && before[before.length - 1 - q] === after[after.length - 1 - q]) q++;
  if (p === before.length && p === after.length) return [];
  return [{ start: p, deleteCount: before.length - p - q, data: after.slice(p, after.length - q) }];
}

/** A diagnostic from the joined document, as the notebook shows it. */
export interface CellDiagnostic<T> {
  cellId: string;
  range: LspLikeRange;
  diagnostic: T;
}

/**
 * The server's diagnostics on the joined document, per cell. Left out: ones on a masked magic
 * line, and Pyright's "expression value is unused" on a cell's last line (the line a notebook
 * shows as the cell's result, as Pylance does).
 */
export function cellDiagnostics<T extends { range: LspLikeRange; code?: unknown }>(
  doc: ConcatDocument,
  diagnostics: readonly T[],
  cells: readonly ConcatCellInput[],
  languageId = "python",
): CellDiagnostic<T>[] {
  const sources = new Map(cells.map((c) => [c.id, c.text.replace(/\r\n?/g, "\n").split("\n")]));
  const out: CellDiagnostic<T>[] = [];
  for (const d of diagnostics) {
    const mapped = doc.rangeFromConcat(d.range);
    if (!mapped) continue;
    const at = mapped.range.start;
    const line = sources.get(mapped.cellId)?.[at.line] ?? "";
    if (/^\s*[%!]/.test(line) || /^\s*%%/.test(sources.get(mapped.cellId)?.[0] ?? "")) continue;
    // On a line's masked part (`!ls` in `x = !ls`, a help line) the server saw a stand-in.
    const stand = maskMagics(line, languageId);
    if (stand !== line) {
      let from = 0;
      while (from < line.length && line[from] === stand[from]) from++;
      const end = mapped.range.end;
      if (at.character >= from || (end.line === at.line && end.character > from)) continue;
    }
    if (
      String(d.code ?? "") === "reportUnusedExpression" &&
      mapped.range.start.line === doc.lastTextLine(mapped.cellId)
    )
      continue;
    out.push({ cellId: mapped.cellId, range: mapped.range, diagnostic: d });
  }
  return out;
}

const EXTENSIONS: Record<string, string> = {
  python: "py",
  r: "r",
  julia: "jl",
  javascript: "js",
  typescript: "ts",
  scala: "scala",
  java: "java",
  "c++": "cpp",
  cpp: "cpp",
  csharp: "cs",
  "c#": "cs",
  fsharp: "fs",
  go: "go",
  rust: "rs",
  bash: "sh",
  ruby: "rb",
  sql: "sql",
};

/** The file extension of a kernel language's code ("python" → "py"), null when unknown. */
export function languageExtension(language: string): string | null {
  return EXTENSIONS[language.toLowerCase()] ?? null;
}

/** Where the joined document lives: beside the notebook, a name no real file has. */
export function concatPath(notebookPath: string, extension: string): string {
  return `${notebookPath}.concat.${extension}`;
}
