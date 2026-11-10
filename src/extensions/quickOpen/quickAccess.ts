// Quick access (D133), VS Code's model: one box whose first characters pick what it searches.
// No prefix: files (Ctrl/Cmd+P). ">": commands (Ctrl/Cmd+Shift+P, F1). "@": symbols in the active
// editor (Ctrl/Cmd+Shift+O), "@:" the same grouped by kind. "#": symbols in the workspace
// (Ctrl/Cmd+T). ":": go to line (Ctrl+G). "%": text in the files. "view ": open a view.
// "task ": run a task. "debug ": start a launch configuration. "term ": switch terminal.
// "edt ": open editors. "?": what the prefixes do. Typing or deleting the prefix switches modes in
// place, as in VS Code. DOM-free parts are tested.

export type QuickAccessMode =
  | "files"
  | "commands"
  | "symbols"
  | "workspaceSymbols"
  | "line"
  | "text"
  | "views"
  | "tasks"
  | "debug"
  | "terminals"
  | "editors"
  | "help";

export interface ParsedAccess {
  mode: QuickAccessMode;
  /** The text after the prefix (trimmed at the start). */
  query: string;
  /** "@:": symbols grouped by kind. */
  byKind?: boolean;
}

export const PREFIXES: { prefix: string; mode: QuickAccessMode; label: string }[] = [
  { prefix: ">", mode: "commands", label: "Show and run commands" },
  { prefix: "@", mode: "symbols", label: "Go to symbol in editor" },
  { prefix: "@:", mode: "symbols", label: "Go to symbol in editor by category" },
  { prefix: "#", mode: "workspaceSymbols", label: "Go to symbol in workspace" },
  { prefix: ":", mode: "line", label: "Go to line" },
  { prefix: "%", mode: "text", label: "Search for text" },
  { prefix: "edt ", mode: "editors", label: "Show open editors" },
  { prefix: "view ", mode: "views", label: "Open view" },
  { prefix: "task ", mode: "tasks", label: "Run task" },
  { prefix: "debug ", mode: "debug", label: "Start debugging" },
  { prefix: "term ", mode: "terminals", label: "Show all opened terminals" },
  { prefix: "?", mode: "help", label: "Help: what the prefixes do" },
];

/** Word prefixes ("view "), matched before single characters; the space is part of them. */
const WORD_PREFIXES = PREFIXES.filter((p) => p.prefix.length > 1 && p.prefix.endsWith(" "));

export function parseAccess(text: string): ParsedAccess {
  const word = WORD_PREFIXES.find((p) => text.startsWith(p.prefix));
  if (word) return { mode: word.mode, query: text.slice(word.prefix.length).replace(/^\s+/, "") };
  if (text.startsWith("@:"))
    return { mode: "symbols", query: text.slice(2).replace(/^\s+/, ""), byKind: true };
  const first = text.charAt(0);
  const hit = PREFIXES.find((p) => p.prefix === first);
  if (!hit) return { mode: "files", query: text };
  return { mode: hit.mode, query: text.slice(1).replace(/^\s+/, "") };
}

export const PLACEHOLDERS: Record<QuickAccessMode, string> = {
  files: "Search files by name (append :line to go to a line, > for commands, ? for help)",
  commands: "Type the name of a command to run",
  symbols: "Type the name of a symbol in the active editor",
  workspaceSymbols: "Type the name of a symbol in the workspace (functions, classes, types…)",
  line: "Type a line number (and :column) to go to",
  text: "Type text to search for in the files",
  views: "Type the name of a view to open",
  tasks: "Type the name of a task to run",
  debug: "Type the name of a launch configuration to start",
  terminals: "Type the name of a terminal to show",
  editors: "Type the name of an open editor",
  help: "Pick what to search",
};

/** ":12", ":12:5", ":12,5" → line / column (null when not a number yet). */
export function parseLine(query: string): { line: number; column?: number } | null {
  const m = /^(\d+)(?:[:,](\d+))?\s*$/.exec(query.trim());
  if (!m) return null;
  const line = Number(m[1]);
  if (!(line > 0)) return null;
  const column = m[2] ? Number(m[2]) : undefined;
  return column && column > 0 ? { line, column } : { line };
}

/** VS Code's names for symbol kinds in "@:" groups ("classes (2)"), in its order. */
const KIND_GROUPS: readonly [string, string][] = [
  ["module", "modules"],
  ["namespace", "namespaces"],
  ["package", "packages"],
  ["class", "classes"],
  ["interface", "interfaces"],
  ["struct", "structs"],
  ["enum", "enumerations"],
  ["enummember", "enumeration members"],
  ["constructor", "constructors"],
  ["method", "methods"],
  ["function", "functions"],
  ["property", "properties"],
  ["field", "fields"],
  ["variable", "variables"],
  ["constant", "constants"],
  ["typeparameter", "type parameters"],
  ["event", "events"],
  ["operator", "operators"],
  ["key", "keys"],
  ["heading", "headings"],
];

/**
 * Symbols sorted into VS Code's "@:" groups: by kind (in KIND_GROUPS' order, unknown kinds
 * last), keeping each group's own order; `separator` is set on each group's first item.
 */
export function groupByKind<T extends { kind: string }>(
  symbols: readonly T[],
): (T & { separator?: string })[] {
  const rank = (kind: string) => {
    const i = KIND_GROUPS.findIndex(([k]) => k === kind.toLowerCase().replace(/[\s_-]/g, ""));
    return i < 0 ? KIND_GROUPS.length : i;
  };
  const sorted = symbols
    .map((s, i) => ({ s, i, r: rank(s.kind) }))
    .sort(
      (a, b) =>
        a.r - b.r ||
        (a.r === KIND_GROUPS.length ? a.s.kind.localeCompare(b.s.kind) : 0) ||
        a.i - b.i,
    );
  const counts = new Map<string, number>();
  for (const { s } of sorted) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  let last: string | null = null;
  return sorted.map(({ s, r }) => {
    if (s.kind === last) return { ...s };
    last = s.kind;
    const name = KIND_GROUPS[r]?.[1] ?? s.kind.toLowerCase();
    return { ...s, separator: `${name} (${counts.get(s.kind) ?? 0})` };
  });
}
