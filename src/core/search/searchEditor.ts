// Search editors (D196, VS Code's): search results as a document in an editor tab, saved as
// `.code-search` files in VS Code's format so the two read each other's:
//
//   # Query: foo
//   # Flags: RegExp CaseSensitive WordMatch
//   # Including: src
//   # Excluding: dist
//   # ContextLines: 1
//
//   3 results - 2 files
//
//   src/a.ts:
//     9    a context line
//    10:   the matching line
//
// Match lines have "N:", context lines "N " (no colon). DOM-free and tested.

export interface SearchEditorQuery {
  query: string;
  isRegex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  include: string[];
  exclude: string[];
  contextLines: number;
}

export interface SearchEditorLine {
  /** 1-based. */
  line: number;
  text: string;
  /** Match ranges [start, end) in `text`; empty for a context line. */
  ranges: [number, number][];
}

export interface SearchEditorFile {
  /** Path relative to the folder, with / separators. */
  rel: string;
  lines: SearchEditorLine[];
}

export const EMPTY_QUERY: SearchEditorQuery = {
  query: "",
  isRegex: false,
  matchCase: false,
  wholeWord: false,
  include: [],
  exclude: [],
  contextLines: 0,
};

const list = (v: string) =>
  v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** The query a `.code-search` file's header describes (missing fields: defaults). */
export function parseSearchEditor(text: string): SearchEditorQuery {
  const q: SearchEditorQuery = { ...EMPTY_QUERY, include: [], exclude: [] };
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.startsWith("# ")) {
      if (raw.trim() === "") continue;
      break;
    }
    const m = /^# ([A-Za-z]+): ?(.*)$/.exec(raw);
    if (!m) continue;
    const value = m[2] ?? "";
    switch (m[1]) {
      case "Query":
        // VS Code escapes newlines and backslashes in the query.
        q.query = value.replace(/\\(\\|n)/g, (_, c: string) => (c === "n" ? "\n" : "\\"));
        break;
      case "Flags":
        q.isRegex = /\bRegExp\b/.test(value);
        q.matchCase = /\bCaseSensitive\b/.test(value);
        q.wholeWord = /\bWordMatch\b/.test(value);
        break;
      case "Including":
        q.include = list(value);
        break;
      case "Excluding":
        q.exclude = list(value);
        break;
      case "ContextLines": {
        const n = Number(value);
        q.contextLines = Number.isFinite(n) && n > 0 ? Math.min(10, Math.floor(n)) : 0;
        break;
      }
    }
  }
  return q;
}

/** The whole document: header, summary and results. */
export function serializeSearchEditor(
  q: SearchEditorQuery,
  files: readonly SearchEditorFile[],
): string {
  const flags = [
    q.isRegex ? "RegExp" : "",
    q.matchCase ? "CaseSensitive" : "",
    q.wholeWord ? "WordMatch" : "",
  ].filter(Boolean);
  const header = [
    `# Query: ${q.query.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}`,
    ...(flags.length ? [`# Flags: ${flags.join(" ")}`] : []),
    ...(q.include.length ? [`# Including: ${q.include.join(", ")}`] : []),
    ...(q.exclude.length ? [`# Excluding: ${q.exclude.join(", ")}`] : []),
    ...(q.contextLines ? [`# ContextLines: ${q.contextLines}`] : []),
  ];
  const results = files.reduce((n, f) => n + f.lines.filter((l) => l.ranges.length).length, 0);
  const out = [...header, "", summary(results, files.length)];
  for (const f of files) {
    out.push("", `${f.rel}:`);
    const width = String(Math.max(...f.lines.map((l) => l.line), 1)).length;
    let prev = -1;
    for (const l of f.lines) {
      if (prev !== -1 && l.line > prev + 1) out.push(`  ${" ".repeat(width)}  …`);
      const num = String(l.line).padStart(width);
      out.push(`  ${num}${l.ranges.length ? ":" : " "} ${l.text}`);
      prev = l.line;
    }
  }
  return `${out.join("\n")}\n`;
}

export function summary(results: number, files: number): string {
  if (!results) return "No results";
  return `${results} result${results === 1 ? "" : "s"} - ${files} file${files === 1 ? "" : "s"}`;
}

/**
 * Matches with `context` lines around them from the file's text (lines that touch or overlap are
 * merged, as VS Code does).
 */
export function withContext(
  matches: readonly SearchEditorLine[],
  fileLines: readonly string[] | null,
  context: number,
): SearchEditorLine[] {
  if (!context || !fileLines) return [...matches];
  const byLine = new Map(matches.map((m) => [m.line, m]));
  const wanted = new Set<number>();
  for (const m of matches)
    for (
      let l = Math.max(1, m.line - context);
      l <= Math.min(fileLines.length, m.line + context);
      l++
    )
      wanted.add(l);
  return [...wanted]
    .sort((a, b) => a - b)
    .map((l) => byLine.get(l) ?? { line: l, text: fileLines[l - 1] ?? "", ranges: [] });
}
