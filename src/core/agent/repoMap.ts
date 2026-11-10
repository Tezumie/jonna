// Repository map (D174), Aider's idea: the agent starts each turn knowing the project's shape —
// the files that matter most and the symbols they define (functions, classes, types, with their
// signature lines) — so a small local model doesn't spend its context on list_dir / search
// calls to find its way, and edits the right place. Like Aider, files are ranked with PageRank
// over the reference graph (file A uses a name file B defines → an edge A → B), personalized
// toward the files the user is looking at, and the map is cut to a character budget.
// Symbols come from per-language patterns, not a parser (no dependency): good enough to name
// what each file holds. DOM-free and tested.

export interface MapSymbol {
  name: string;
  /** 1-based. */
  line: number;
  /** Indented in the source (a class member, a method in an impl). */
  member: boolean;
  /** The definition's line, trimmed and shortened (what the map shows). */
  signature: string;
}

export interface FileSymbols {
  /** Relative to the workspace, `/` separators. */
  path: string;
  defs: MapSymbol[];
  /** Identifiers used in the file (for references), each once. */
  refs: Set<string>;
}

type Pattern = RegExp;

const TS: Pattern[] = [
  /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/,
  /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
  /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  // Class members, two-space or tab indented, with their body's brace: `name(…) {`,
  // `async name(…): T {`. The brace tells a definition from a call (`  setup(app)` in code
  // without semicolons is a call).
  /^(?: {2}|\t)(?:(?:public|private|protected|static|readonly|async|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::[^{=;]*)?\{/,
];
const PY: Pattern[] = [
  /^(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^class\s+([A-Za-z_]\w*)/,
  /^ {4}(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^([A-Z][A-Z0-9_]+)\s*=/,
];
const RUST: Pattern[] = [
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union|type)\s+([A-Za-z_]\w*)/,
  // A module with a body (`mod x;` only declares a file, which the map lists anyway).
  /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*\{/,
  /^\s*impl(?:<[^>]*>)?\s+(?:[\w:]+(?:<[^>]*>)?\s+for\s+)?([A-Za-z_]\w*)/,
];
const GO: Pattern[] = [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, /^type\s+([A-Za-z_]\w*)\s+/];
const JAVA_LIKE: Pattern[] = [
  /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|partial)\s+)*(?:class|interface|enum|record|struct|object)\s+([A-Za-z_]\w*)/,
  /^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|suspend)\s+)+[\w<>[\],.?\s]*?\s([A-Za-z_]\w*)\s*\([^;]*$/,
  /^\s*(?:(?:public|private|internal|override|suspend)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/,
];
const RUBY_PHP: Pattern[] = [
  /^\s*(?:def|class|module)\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/,
  /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?([A-Za-z_]\w*)/,
  /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/,
];
const C_LIKE: Pattern[] = [
  /^(?:static\s+|inline\s+|extern\s+|virtual\s+)*[A-Za-z_][\w:<>,\s*&]*?[\s*&]([A-Za-z_][\w:]*)\s*\([^;]*$/,
  /^\s*(?:class|struct|enum|union|namespace)\s+([A-Za-z_]\w*)\s*(?::[^{]*)?\{?\s*$/,
  /^\s*typedef\s+.*?([A-Za-z_]\w*)\s*;\s*$/,
];

const BY_EXT: Record<string, Pattern[]> = {
  ts: TS,
  tsx: TS,
  mts: TS,
  cts: TS,
  js: TS,
  jsx: TS,
  mjs: TS,
  cjs: TS,
  vue: TS,
  svelte: TS,
  py: PY,
  rs: RUST,
  go: GO,
  java: JAVA_LIKE,
  kt: JAVA_LIKE,
  kts: JAVA_LIKE,
  cs: JAVA_LIKE,
  scala: JAVA_LIKE,
  swift: JAVA_LIKE,
  dart: JAVA_LIKE,
  rb: RUBY_PHP,
  php: RUBY_PHP,
  c: C_LIKE,
  h: C_LIKE,
  cc: C_LIKE,
  cpp: C_LIKE,
  cxx: C_LIKE,
  hpp: C_LIKE,
  hh: C_LIKE,
};

/** Files whose names can refer to each other (TypeScript and JavaScript are one; Rust another). */
function familyOf(path: string): Pattern[] | undefined {
  return BY_EXT[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
}

/** Files the map reads (code it can name symbols in). */
export function mapsLanguage(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ext in BY_EXT && !/\.(min|bundle)\.[cm]?js$|\.d\.ts$/.test(path);
}

/** Folders whose files never make the map (dependencies, builds, generated code). */
const SKIP_DIR =
  /(^|\/)(node_modules|dist|build|out|target|vendor|\.git|\.next|\.nuxt|coverage|__pycache__|\.venv|venv|bin|obj|Pods|DerivedData|\.gradle|generated|gen)(\/|$)/;

export function skippedPath(path: string): boolean {
  return SKIP_DIR.test(path);
}

/** Keywords and names too common to tell files apart (they'd connect everything). */
const COMMON = new Set(
  (
    "if else for while do return function const let var class new this self super true false null " +
    "undefined none nil import export from default async await yield try catch finally throw " +
    "switch case break continue typeof instanceof in of void delete static public private " +
    "protected readonly interface type enum extends implements fn pub mut impl struct trait use " +
    "mod crate where match def lambda pass with as is not and or elif except raise global func " +
    "package go defer chan map range string number boolean any unknown never object int float " +
    "bool char double long short byte str vec option result some ok err get set value data name " +
    "id key item items list index error args props options config init main run test len size " +
    "count text path file line type node next prev"
  ).split(" "),
);

const MAX_SIGNATURE = 110;

/**
 * A constant's line without its value: `export const API_KEY = "sk-…"` would put the value (a
 * secret, even) in every chat's prompt (D174). A function in a constant keeps its parameters.
 */
function valueless(signature: string): string {
  if (
    !/^(export\s+)?(declare\s+)?(const|let|var|static|pub(\([^)]*\))?\s+(const|static)|const|[A-Z][A-Z0-9_]*\s*(:[^=]*)?=)\b/.test(
      signature,
    ) &&
    !/^[A-Z][A-Z0-9_]*\s*=/.test(signature)
  )
    return signature;
  const arrow = /^(.*?=)\s*(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*(:[^=]*)?=>/.exec(signature);
  if (arrow) return `${arrow[1]} ${arrow[2] ?? ""}${arrow[3]} =>`;
  const at = signature.indexOf("=");
  return at > 0 ? signature.slice(0, at).trimEnd() : signature;
}

/** The definitions and identifier uses of one file. */
export function fileSymbols(path: string, text: string): FileSymbols {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const patterns = BY_EXT[ext] ?? [];
  const defs: MapSymbol[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && defs.length < 400; i++) {
    const line = lines[i] as string;
    if (line.length > 400 || !line.trim()) continue;
    const trimmed = line.trim();
    if (/^(\/\/|#(?!\[)|\*|\/\*|--)/.test(trimmed)) continue;
    for (const re of patterns) {
      const m = re.exec(line);
      const name = m?.[1];
      if (!name || COMMON.has(name) || /^(if|for|while|switch|catch)$/.test(name)) continue;
      const key = `${name}:${line.length - line.trimStart().length > 0 ? "m" : "t"}`;
      if (seen.has(key)) break;
      seen.add(key);
      // The definition, not a one-line body after it ("f() { return 1; }" → "f()").
      let signature = valueless(
        trimmed.replace(/\s*\{[^{}]*\}?\s*;?\s*$/, "").replace(/\s+/g, " "),
      );
      if (signature.length > MAX_SIGNATURE) signature = `${signature.slice(0, MAX_SIGNATURE - 1)}…`;
      const member = line.length - line.trimStart().length > 0;
      defs.push({ name, line: i + 1, member, signature });
      break;
    }
  }
  const refs = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z_$][\w$]{2,}/g)) {
    const word = m[0];
    if (!COMMON.has(word)) refs.add(word);
    if (refs.size > 20_000) break;
  }
  return { path, defs, refs };
}

export interface RankOptions {
  /** Files to rank higher (open in the editor, mentioned in the chat): PageRank's start. */
  focus?: readonly string[];
  iterations?: number;
}

/**
 * Files by importance: PageRank over "uses a name defined there" edges (a name defined in many
 * files counts less, like Aider's), personalized toward `focus`.
 */
export function rankFiles(files: readonly FileSymbols[], o: RankOptions = {}): Map<string, number> {
  const n = files.length;
  const rank = new Map<string, number>();
  if (!n) return rank;
  const index = new Map(files.map((f, i) => [f.path, i]));
  const definedIn = new Map<string, number[]>();
  files.forEach((f, i) => {
    for (const d of f.defs) {
      const list = definedIn.get(d.name) ?? [];
      if (!list.includes(i)) list.push(i);
      definedIn.set(d.name, list);
    }
  });
  // Weighted edges from each file to the files defining the names it uses.
  const out: Map<number, number>[] = files.map(() => new Map());
  const family = files.map((f) => familyOf(f.path));
  files.forEach((f, i) => {
    for (const name of f.refs) {
      // Only names defined in the same language (a Rust `Error` isn't what a TS file means).
      const targets = definedIn.get(name)?.filter((t) => family[t] === family[i]);
      if (!targets || targets.length > 8) continue;
      // Distinctive names (CamelCase, snake_case, long) say more than short common ones ("send").
      const w =
        (1 / targets.length) *
        (/^[A-Z]|_/.test(name) || name.length >= 8 ? 1 : name.length >= 6 ? 0.4 : 0.15);
      for (const t of targets) if (t !== i) out[i]?.set(t, (out[i]?.get(t) ?? 0) + w);
    }
  });
  const focus = (o.focus ?? [])
    .map((p) => index.get(p))
    .filter((i): i is number => i !== undefined);
  const start = new Array<number>(n).fill(focus.length ? 0 : 1 / n);
  for (const i of focus) start[i] = 1 / focus.length;
  // A little of everyone, so files the focus doesn't reach still get ordered.
  if (focus.length) for (let i = 0; i < n; i++) start[i] = 0.85 * (start[i] ?? 0) + 0.15 / n;
  let pr = [...start];
  const damping = 0.85;
  for (let iter = 0; iter < (o.iterations ?? 30); iter++) {
    const next = start.map((s) => (1 - damping) * s);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      const edges = out[i] as Map<number, number>;
      const total = [...edges.values()].reduce((a, b) => a + b, 0);
      if (!total) {
        dangling += pr[i] ?? 0;
        continue;
      }
      for (const [t, w] of edges) next[t] = (next[t] ?? 0) + damping * (pr[i] ?? 0) * (w / total);
    }
    for (let i = 0; i < n; i++) next[i] = (next[i] ?? 0) + damping * dangling * (start[i] ?? 0);
    pr = next;
  }
  for (const [i, f] of files.entries()) rank.set(f.path, pr[i] ?? 0);
  return rank;
}

const PLUMBING = new Set([
  "constructor",
  "dispose",
  "toString",
  "toJSON",
  "render",
  "update",
  "drop",
  "fmt",
  "default",
  "clone",
  "new",
  "__init__",
  "__repr__",
  "__str__",
]);

/** A symbol's weight in its file: used elsewhere, exported, top level; plumbing least. */
function weight(d: MapSymbol, uses: Map<string, number>): number {
  if (PLUMBING.has(d.name)) return -1;
  const exported = /^(export|pub\b|public\b)/.test(d.signature);
  return (uses.get(d.name) ?? 0) + (exported ? 0.5 : 0) + (d.member ? 0 : 1);
}

/** How many other files use each name a file defines (a symbol's own weight in its file). */
function useCounts(files: readonly FileSymbols[]): Map<string, number> {
  const counts = new Map<string, number>();
  const defined = new Set(files.flatMap((f) => f.defs.map((d) => d.name)));
  for (const f of files)
    for (const name of f.refs) if (defined.has(name)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

/**
 * The map as text, within `budget` characters: the highest-ranked files first, each with its most
 * used symbols in source order, as signature lines (Aider's format).
 */
export function renderRepoMap(
  files: readonly FileSymbols[],
  o: RankOptions & { budget: number; perFile?: number },
): string {
  const ranked = rankFiles(
    files.filter((f) => f.defs.length),
    o,
  );
  const uses = useCounts(files);
  const order = [...ranked.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const byPath = new Map(files.map((f) => [f.path, f]));
  const perFile = o.perFile ?? 8;
  const parts: string[] = [];
  let size = 0;
  for (const [path] of order) {
    const f = byPath.get(path);
    if (!f) continue;
    // A file's most used symbols, back in the order they appear; members indented under their
    // class (Aider's layout). Plumbing every class has says little.
    const picked = [...f.defs]
      .map((d, i) => ({ d, i, w: weight(d, uses) }))
      .sort((a, b) => b.w - a.w || a.i - b.i)
      .slice(0, perFile)
      .sort((a, b) => a.i - b.i)
      .map(({ d }) => `│${d.member ? "  " : ""}${d.signature}`);
    const more = f.defs.length - picked.length;
    const block = [`${path}:`, ...picked, ...(more > 0 ? [`│… ${more} more`] : [])].join("\n");
    if (size + block.length + 1 > o.budget) {
      // Room for the name alone tells the model the file exists.
      if (size + path.length + 2 <= o.budget) {
        parts.push(`${path}: …`);
        size += path.length + 4;
      }
      continue;
    }
    parts.push(block);
    size += block.length + 1;
  }
  return parts.join("\n");
}
