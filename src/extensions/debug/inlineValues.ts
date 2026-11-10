// Inline values while paused (VS Code's `debug.inlineValues`): `name = value` after the lines of
// the stopped frame's file, from the start of each scope down to the stopped line, the way VS
// Code's generic matcher does (debugEditorContribution.ts, when no language registers an
// InlineValuesProvider): the variables of the frame's most specific scopes, matched by name
// against the words of each line's code (not its comments or strings), the narrowest scope's
// value first, at most 100 names, ordered as they appear in the line, cut at 150 characters.
// DOM-free and tested; inlineValuesView.ts draws them.
import type { Scope } from "./session";

/** VS Code's limits. */
export const MAX_NUM_INLINE_VALUES = 100;
export const MAX_INLINE_DECORATOR_LENGTH = 150;
export const MAX_TOKENIZATION_LINE_LEN = 500;
/**
 * Lines above the stopped one that get values. VS Code limits them to the editor's viewport;
 * values are decorations of the file here, so a long scope stops at this many instead.
 */
export const MAX_LINES_ABOVE = 2000;

/** How a language writes comments and strings (enough to skip them). */
export interface Syntax {
  lineComments: readonly string[];
  blockComments: boolean;
  /** String quotes. */
  quotes: string;
  /** Quotes whose strings may span lines (JS templates, Go raw strings, Rust strings). */
  multiLineQuotes: string;
  /** Python's ''' and """ strings. */
  tripleQuotes: boolean;
  /** `'x'` is a character (C-like languages, Rust); a lone `'` (a Rust lifetime) is skipped. */
  charLiterals: boolean;
}

const C_LIKE: Syntax = {
  lineComments: ["//"],
  blockComments: true,
  quotes: '"',
  multiLineQuotes: "",
  tripleQuotes: false,
  charLiterals: true,
};

const SYNTAX: Record<string, Syntax> = {
  javascript: { ...C_LIKE, quotes: "'\"`", multiLineQuotes: "`", charLiterals: false },
  python: {
    lineComments: ["#"],
    blockComments: false,
    quotes: "'\"",
    multiLineQuotes: "",
    tripleQuotes: true,
    charLiterals: false,
  },
  go: { ...C_LIKE, quotes: '"`', multiLineQuotes: "`" },
  rust: { ...C_LIKE, multiLineQuotes: '"' },
  c: C_LIKE,
  csharp: C_LIKE,
};

/** The languages the built-in debuggers debug, by file extension. */
const LANGUAGES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "javascript",
  mts: "javascript",
  cts: "javascript",
  tsx: "javascript",
  py: "python",
  pyw: "python",
  go: "go",
  rs: "rust",
  c: "c",
  h: "c",
  cc: "c",
  cpp: "c",
  cxx: "c",
  hpp: "c",
  hh: "c",
  hxx: "c",
  m: "c",
  mm: "c",
  cs: "csharp",
};

/** The language of `path` among those the built-in debuggers debug, or null. */
export function debuggedLanguage(path: string): string | null {
  const ext = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  return LANGUAGES[ext] ?? null;
}

/** How to read `path`'s comments and strings (C-like for a language not listed). */
export function syntaxFor(path: string): Syntax {
  return SYNTAX[debuggedLanguage(path) ?? ""] ?? { ...C_LIKE, quotes: "'\"`", charLiterals: false };
}

/**
 * Whether values show for `path` with setting `debug.inlineValues` = `setting`: "on" (or true)
 * always, "off" (or false) never, "auto" for the languages the built-in debuggers debug. (VS
 * Code's "auto" shows them only where an extension registers an InlineValuesProvider; none does
 * here, so "auto" uses the generic matcher for those languages instead.)
 */
export function inlineValuesOn(setting: unknown, path: string): boolean {
  if (setting === true || setting === "on") return true;
  if (setting === "auto" || setting === undefined) return debuggedLanguage(path) !== null;
  return false;
}

const WORD_START = /[A-Za-z_$]/;
const WORD = /[\w$]/;
const CHAR_LITERAL = /^'(?:\\.[^']{0,8}|[^\\'])'/;

/**
 * The words of the code (not comments or strings) on lines `from`..`to` (1-based) of `lines`:
 * word → its lines. Lines longer than MAX_TOKENIZATION_LINE_LEN are left out, as in VS Code.
 * Comments and strings are followed from the first line so one opened above `from` counts.
 */
export function wordsByLine(
  lines: readonly string[],
  from: number,
  to: number,
  syntax: Syntax,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  /** Inside a block comment, or a string that goes on to the next line (its closing quote). */
  let open: { kind: "block" } | { kind: "string"; close: string } | null = null;
  const last = Math.min(to, lines.length);
  for (let n = 1; n <= last; n++) {
    const text = lines[n - 1] ?? "";
    const collect = n >= from && text.length <= MAX_TOKENIZATION_LINE_LEN;
    const seen = new Set<string>();
    let i = 0;
    while (i < text.length) {
      if (open?.kind === "block") {
        const end = text.indexOf("*/", i);
        if (end < 0) break;
        i = end + 2;
        open = null;
        continue;
      }
      if (open?.kind === "string") {
        const end = closingQuote(text, i, open.close);
        if (end < 0) break;
        i = end + open.close.length;
        open = null;
        continue;
      }
      const ch = text[i] ?? "";
      if (syntax.lineComments.some((c) => text.startsWith(c, i))) break;
      if (syntax.blockComments && text.startsWith("/*", i)) {
        open = { kind: "block" };
        i += 2;
        continue;
      }
      if (syntax.tripleQuotes && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
        open = { kind: "string", close: text.slice(i, i + 3) };
        i += 3;
        continue;
      }
      if (ch === "'" && syntax.charLiterals) {
        i += CHAR_LITERAL.exec(text.slice(i))?.[0].length ?? 1;
        continue;
      }
      if (syntax.quotes.includes(ch)) {
        const end = closingQuote(text, i + 1, ch);
        if (end >= 0) i = end + 1;
        else {
          // Unclosed: it goes on below where the language allows, else it ends with the line.
          if (syntax.multiLineQuotes.includes(ch)) open = { kind: "string", close: ch };
          break;
        }
        continue;
      }
      if (/[0-9]/.test(ch)) {
        i++;
        while (i < text.length && /[\w.]/.test(text[i] ?? "")) i++;
        continue;
      }
      if (WORD_START.test(ch)) {
        const start = i;
        while (i < text.length && WORD.test(text[i] ?? "")) i++;
        const word = text.slice(start, i);
        if (collect && !seen.has(word)) {
          seen.add(word);
          const list = out.get(word);
          if (list) list.push(n);
          else out.set(word, [n]);
        }
        continue;
      }
      i++;
    }
    // A line comment or an unclosed one-line string ends with its line.
  }
  return out;
}

/** Where `quote` closes from `i` on (backslash escapes skipped), or -1. */
function closingQuote(text: string, i: number, quote: string): number {
  for (let k = i; k < text.length; k++) {
    if (text[k] === "\\" && quote.length === 1) {
      k++;
      continue;
    }
    if (text.startsWith(quote, k)) return k;
  }
  return -1;
}

/**
 * VS Code's `getMostSpecificScopes`: the cheap scopes; when the debugger gave their lines, those
 * that hold `line`, narrowest first (all cheap ones when none does).
 */
export function mostSpecificScopes(scopes: readonly Scope[], line: number): Scope[] {
  const cheap = scopes.filter((s) => !s.expensive);
  if (!cheap.some((s) => s.line !== undefined)) return cheap;
  const size = (s: Scope) => (s.endLine ?? Number.MAX_SAFE_INTEGER) - (s.line ?? 0);
  const holding = cheap
    .filter((s) => s.line !== undefined && s.line <= line && (s.endLine ?? line) >= line)
    .sort((a, b) => size(a) - size(b));
  return holding.length ? holding : cheap;
}

/** One scope's values: from its first line (1 when the debugger didn't say). */
export interface ScopeValues {
  startLine: number;
  variables: readonly { name: string; value: string }[];
}

export interface InlineValueLine {
  line: number;
  /** "a = 1, b = 2" (cut with "..." past the limit). */
  text: string;
}

/**
 * The values to show per line: each scope's (narrowest first; the first value of a name on a
 * line wins, so a shadowed outer one doesn't show) from its first line to `stopLine`.
 */
export function inlineValueLines(input: {
  lines: readonly string[];
  syntax: Syntax;
  stopLine: number;
  scopes: readonly ScopeValues[];
  maxLength?: number;
}): InlineValueLine[] {
  const { lines, stopLine } = input;
  const lowest = Math.max(1, stopLine - MAX_LINES_ABOVE + 1);
  const starts = input.scopes.map((s) => Math.max(lowest, Math.min(s.startLine, stopLine)));
  if (!starts.length) return [];
  const words = wordsByLine(lines, Math.min(...starts), stopLine, input.syntax);
  const perLine = new Map<number, Map<string, string>>();
  input.scopes.forEach((scope, i) => {
    const from = starts[i] ?? lowest;
    const values = new Map<string, string>();
    for (const v of scope.variables) {
      if (values.size >= MAX_NUM_INLINE_VALUES) break;
      if (!values.has(v.name)) values.set(v.name, v.value);
    }
    for (const [name, value] of values)
      for (const line of words.get(name) ?? []) {
        if (line < from || line > stopLine) continue;
        const map = perLine.get(line) ?? new Map<string, string>();
        if (!map.has(name)) map.set(name, value);
        perLine.set(line, map);
      }
  });
  return [...perLine.keys()]
    .sort((a, b) => a - b)
    .map((line) => {
      const text = lines[line - 1] ?? "";
      const names = [...(perLine.get(line)?.keys() ?? [])].sort(
        (a, b) => text.indexOf(a) - text.indexOf(b),
      );
      const values = perLine.get(line);
      const joined = names.map((n) => `${n} = ${values?.get(n) ?? ""}`).join(", ");
      return { line, text: formatInlineValue(joined, input.maxLength) };
    });
}

/** One line's text: on one line (breaks and tabs as spaces), cut with "..." past `max`. */
export function formatInlineValue(text: string, max = MAX_INLINE_DECORATOR_LENGTH): string {
  const flat = text.replace(/[\t\r\n]+/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}
