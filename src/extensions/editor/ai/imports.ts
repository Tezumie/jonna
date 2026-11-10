// Import-graph context for suggestions as you type (D224), as Copilot and Cursor Tab add the
// definitions a file uses from its imports: the current file's local imports (relative ES / TS
// imports and requires, Python's `from .x import y` and project modules, Rust's `mod x;`,
// C / C++ `#include "x.h"`) are resolved to files of the folder, and the declarations of the
// imported names (a function's signature and first lines, a type, a class head) become snippets
// beside the open-file and recent-edit ones, inside the same budget. D229: TypeScript's path
// aliases (the root tsconfig.json / jsconfig.json `paths`, from its `baseUrl`), a package's
// typings (node_modules/<pkg>/package.json `types`), and re-exports (`export * from`, a barrel
// index.ts) up to three files deep are followed too. Python's site-packages and Rust crates
// aren't. m7.12: when a language server runs for the file, it's asked where the imported names
// are declared (`textDocument/definition` on each name in the import, or on `ns.member` where
// the file uses it), so aliases, re-exports, packages and site-packages resolve as the server
// sees them; the regex resolution stays for what the server doesn't answer. DOM-free and tested;
// reading files and asking the server are the caller's (`ImportGraph` gets a reader, `snippets`
// a lookup).

import type { Location, LocationLink } from "../../../core/lsp/types";
import { uriToPath } from "../../../core/lsp/uri";
import { dirname, joinPath, pathKey, resolveInRoot } from "../../../core/paths/index";
import { parseJsonc } from "../../../core/settings/jsonc";
import type { Snippet } from "./fim";

export interface ImportRef {
  /** As written: "./util", ".models", "foo", "x.h". */
  spec: string;
  /** Names it brings in ("default" for a default import); empty: the module itself. */
  names: string[];
  /** `import * as ns` / `import x.y as ns`: what the file calls it (members used are looked up). */
  namespace?: string;
  /** `export … from "x"`: a re-export (followed for names the file doesn't declare). */
  reexport?: boolean;
}

/** A tsconfig `paths` entry: `@/*` → absolute targets (`/w/src/*`). */
export interface PathAlias {
  pattern: string;
  targets: string[];
}

/** The `paths` of a tsconfig.json / jsconfig.json in `dir` (from its `baseUrl`, else `dir`). */
export function tsconfigAliases(text: string, dir: string): PathAlias[] {
  const parsed = parseJsonc(text);
  if (!parsed.ok) return [];
  const options = (parsed.value as { compilerOptions?: unknown } | null)?.compilerOptions;
  if (!options || typeof options !== "object") return [];
  const { baseUrl, paths } = options as { baseUrl?: unknown; paths?: unknown };
  if (!paths || typeof paths !== "object") return [];
  const base = resolveInRoot(dir, typeof baseUrl === "string" ? baseUrl : ".");
  const out: PathAlias[] = [];
  for (const [pattern, list] of Object.entries(paths as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const targets = list
      .filter((t): t is string => typeof t === "string")
      .map((t) => resolveInRoot(base, t));
    if (targets.length) out.push({ pattern, targets });
  }
  return out;
}

/** Where an aliased import may be: each matching alias's targets with its `*` filled in. */
export function aliasBases(spec: string, aliases: readonly PathAlias[]): string[] {
  const out: string[] = [];
  for (const a of aliases) {
    const star = a.pattern.indexOf("*");
    if (star < 0) {
      if (spec === a.pattern) out.push(...a.targets);
      continue;
    }
    const head = a.pattern.slice(0, star);
    const tail = a.pattern.slice(star + 1);
    if (spec.length < head.length + tail.length || !spec.startsWith(head) || !spec.endsWith(tail))
      continue;
    const middle = spec.slice(head.length, spec.length - tail.length);
    out.push(...a.targets.map((t) => t.replace("*", middle)));
  }
  return out;
}

/** A package import's name and the path inside it (`@scope/pkg/sub` → @scope/pkg, sub). */
export function packageSpec(spec: string): { name: string; subpath: string } | null {
  const m = /^((?:@[\w.-]+\/)?[\w.-]+)(?:\/(.+))?$/.exec(spec);
  if (!m?.[1] || spec.startsWith(".")) return null;
  return { name: m[1], subpath: m[2] ?? "" };
}

/** A package's typings from its package.json (`types`, `typings`), relative to its folder. */
export function packageTypings(packageJson: string): string | null {
  try {
    const pkg = JSON.parse(packageJson) as { types?: unknown; typings?: unknown };
    const t = pkg.types ?? pkg.typings;
    return typeof t === "string" && t.trim() ? t.trim() : null;
  } catch {
    return null;
  }
}

/** Lines looked at for imports (they're at the top; a file of thousands of lines isn't scanned). */
const IMPORT_SCAN_LINES = 400;

const JS_LANGUAGES = new Set([
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "vue",
  "svelte",
]);
const C_LANGUAGES = new Set(["c", "cpp", "objective-c", "objective-cpp", "cuda-cpp"]);

/** Names in `{ a, b as c, type d }` (their exported names). */
function braceNames(list: string): string[] {
  return list
    .split(",")
    .map((part) =>
      part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        ?.trim(),
    )
    .filter((n): n is string => !!n && /^[\w$]+$/.test(n));
}

/** The local imports of a file (packages too: `resolveImport` leaves out what it can't find). */
export function parseImports(text: string, languageId: string): ImportRef[] {
  const head = text.split("\n").slice(0, IMPORT_SCAN_LINES).join("\n");
  const out: ImportRef[] = [];
  if (JS_LANGUAGES.has(languageId)) {
    // import a, { b, c as d } from "x"; import * as ns from "x"; import type { T } from "x";
    // export { a } from "x"; export * from "x"; import "x"
    const re =
      /(?:^|[;\n])\s*(?:import|export)\s+(?:type\s+)?((?:(?!\b(?:import|export)\b)[^;])*?)\s*from\s*["']([^"'\n]+)["']|(?:^|[;\n])\s*import\s*["']([^"'\n]+)["']|\brequire\(\s*["']([^"'\n]+)["']\s*\)/g;
    for (const m of head.matchAll(re)) {
      const spec = m[2] ?? m[3] ?? m[4];
      if (!spec) continue;
      const clause = m[1] ?? "";
      const ref: ImportRef = { spec, names: [] };
      if (/^[;\n]?\s*export\b/.test(m[0])) ref.reexport = true;
      const ns = /\*\s+as\s+([\w$]+)/.exec(clause);
      if (ns?.[1]) ref.namespace = ns[1];
      const braces = /\{([^}]*)\}/.exec(clause);
      if (braces?.[1]) ref.names.push(...braceNames(braces[1]));
      const def = /^([\w$]+)\s*(?:,|$)/.exec(clause.trim());
      if (def?.[1] && def[1] !== "type") ref.names.push("default");
      out.push(ref);
    }
  } else if (languageId === "python") {
    for (const m of head.matchAll(/^[ \t]*from\s+(\.*[\w.]*)\s+import\s+(\([^)]*\)|[^\n#]+)/gm)) {
      const spec = m[1] ?? "";
      const list = (m[2] ?? "").replace(/[()]/g, "");
      if (!spec || list.trim() === "*") {
        if (spec) out.push({ spec, names: [] });
        continue;
      }
      out.push({ spec, names: braceNames(list.replace(/\\\n/g, " ")) });
    }
    for (const m of head.matchAll(/^[ \t]*import\s+([\w.]+)(?:\s+as\s+(\w+))?\s*$/gm)) {
      const spec = m[1] ?? "";
      const ns = m[2] ?? spec;
      out.push({ spec, names: [], namespace: ns });
    }
  } else if (languageId === "rust") {
    for (const m of head.matchAll(/^[ \t]*(?:pub(?:\([\w:]+\))?\s+)?mod\s+(\w+)\s*;/gm))
      if (m[1]) out.push({ spec: m[1], names: [], namespace: m[1] });
  } else if (C_LANGUAGES.has(languageId)) {
    for (const m of head.matchAll(/^[ \t]*#\s*include\s+"([^"\n]+)"/gm))
      if (m[1]) out.push({ spec: m[1], names: [] });
  }
  return out;
}

const JS_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

/** The files a JavaScript / TypeScript module at `base` (absolute, as written) may be. */
function jsCandidates(base: string): string[] {
  const out: string[] = [];
  // TypeScript's ESM style imports "./x.js" for x.ts.
  const js = /\.(m|c)?jsx?$/.exec(base);
  if (js) {
    const stem = base.slice(0, base.length - js[0].length);
    out.push(...[".ts", ".tsx", ".mts", ".cts"].map((e) => stem + e), base);
  } else if (/\.\w+$/.test(base.slice(Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\")))))
    out.push(base);
  out.push(...JS_EXTENSIONS.map((e) => base + e));
  out.push(
    ...["index.ts", "index.tsx", "index.d.ts", "index.js", "index.jsx"].map((n) =>
      joinPath(base, n),
    ),
  );
  return out;
}

/**
 * Files `ref` may be, most likely first (absolute paths); for JavaScript / TypeScript, a path
 * alias (`aliases`, D229) too. [] for a package (ImportGraph looks at its typings).
 */
export function resolveImport(
  fromPath: string,
  ref: ImportRef,
  languageId: string,
  root: string | null,
  aliases: readonly PathAlias[] = [],
): string[] {
  const dir = dirname(fromPath);
  const spec = ref.spec;
  if (JS_LANGUAGES.has(languageId)) {
    const bases = spec.startsWith(".") ? [resolveInRoot(dir, spec)] : aliasBases(spec, aliases);
    return [...new Set(bases.flatMap(jsCandidates))];
  }
  if (languageId === "python") {
    const dots = /^\.*/.exec(spec)?.[0].length ?? 0;
    const parts = spec.slice(dots).split(".").filter(Boolean);
    const bases: string[] = [];
    if (dots > 0) {
      let d = dir;
      for (let i = 1; i < dots; i++) d = dirname(d);
      bases.push(d);
    } else {
      // A project module: next to the file, or from the folder's root (or its src/).
      bases.push(dir);
      if (root) bases.push(root, joinPath(root, "src"));
    }
    const out: string[] = [];
    for (const b of bases) {
      if (!parts.length) {
        out.push(joinPath(b, "__init__.py"));
        continue;
      }
      const p = resolveInRoot(b, parts.join("/"));
      out.push(`${p}.py`, joinPath(p, "__init__.py"));
    }
    return [...new Set(out)];
  }
  if (languageId === "rust") {
    const file = fromPath.slice(
      Math.max(fromPath.lastIndexOf("/"), fromPath.lastIndexOf("\\")) + 1,
    );
    // mod.rs / lib.rs / main.rs own their folder; foo.rs owns foo/.
    const owner = /^(mod|lib|main)\.rs$/.test(file)
      ? dir
      : joinPath(dir, file.replace(/\.rs$/, ""));
    return [joinPath(owner, `${spec}.rs`), joinPath(joinPath(owner, spec), "mod.rs")];
  }
  if (C_LANGUAGES.has(languageId)) return [resolveInRoot(dir, spec)];
  return [];
}

/** Lines a declaration snippet takes at most. */
const MAX_DECLARATION_LINES = 12;
/** Characters of one file's import snippet at most. */
const MAX_IMPORT_SNIPPET_CHARS = 1500;
const DECLARATION =
  /^[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:pub(?:\([\w:]+\))?\s+)?(?:static\s+)?(?:function\*?|class|interface|type|enum|const|let|var|def|struct|fn|trait|namespace|union|typedef)\s+([\w$]+)/;

function indentOf(line: string): number {
  return /^[ \t]*/.exec(line)?.[0].length ?? 0;
}

/** The declaration at `start` and the lines of its body, up to where it ends (or 12 lines). */
function declarationAt(lines: readonly string[], start: number): string {
  const first = lines[start] ?? "";
  const indent = indentOf(first);
  const out = [first];
  // One-line declarations (a type alias, a const) end on their line.
  if (/;\s*$/.test(first) && !/[{(]\s*$/.test(first)) return first;
  for (let i = start + 1; i < lines.length && out.length < MAX_DECLARATION_LINES; i++) {
    const line = lines[i] ?? "";
    if (line.trim() && indentOf(line) <= indent) {
      // The closing bracket belongs to it; the next statement doesn't.
      if (/^[ \t]*[}\])]/.test(line)) out.push(line);
      break;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n+$/, "");
}

/**
 * What a file brings in for `names`: their declarations; without names (or none found), its
 * top-level declarations' first lines (an outline). Null: nothing worth sending.
 */
export function importSnippetText(text: string, names: readonly string[]): string | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const parts: string[] = [];
  const wanted = new Set(names);
  if (wanted.size) {
    for (const [i, line] of lines.entries()) {
      const m = DECLARATION.exec(line);
      const isDefault = /^[ \t]*export\s+default\b/.test(line);
      if ((m?.[1] && wanted.has(m[1])) || (isDefault && wanted.has("default"))) {
        parts.push(declarationAt(lines, i));
        if (m?.[1]) wanted.delete(m[1]);
        if (isDefault) wanted.delete("default");
        if (!wanted.size) break;
      }
    }
  }
  if (!parts.length) {
    for (const line of lines) {
      if (indentOf(line) === 0 && DECLARATION.test(line))
        parts.push(line.replace(/\s*\{?\s*$/, ""));
      if (parts.length >= 20) break;
    }
  }
  if (!parts.length) return null;
  let out = "";
  for (const p of parts) {
    if (out.length + p.length + 1 > MAX_IMPORT_SNIPPET_CHARS) break;
    out += `${out ? "\n" : ""}${p}`;
  }
  return out || null;
}

/** Members of `namespace` the text uses (`ns.foo(…)` → foo). */
export function namespaceMembers(text: string, namespace: string): string[] {
  const escaped = namespace.replace(/[$]/g, "\\$");
  const found = new Set<string>();
  for (const m of text.matchAll(new RegExp(`(?<![\\w$.])${escaped}(?:\\.|::)([\\w$]+)`, "g")))
    if (m[1]) found.add(m[1]);
  return [...found];
}

/** A place in the file to ask a language server about: an imported name (0-based, UTF-16). */
export interface ImportSite {
  name: string;
  line: number;
  character: number;
}

/** Where a name is declared, as a language server answers (0-based line of its name). */
export interface DeclarationLocation {
  path: string;
  line: number;
}

/**
 * Asks the file's language server where each site's name is declared (m7.12), answers in the
 * same order (null: no answer). Null as a whole: no server for the file.
 */
export type DefinitionLookup = (
  sites: readonly ImportSite[],
) => Promise<(DeclarationLocation | null)[] | null>;

/**
 * The first place a `textDocument/definition` answer points to (a Location, a list of them, or
 * LocationLinks: the line of the name, `targetSelectionRange`). Null: none, or not a file.
 */
export function declarationFromDefinition(answer: unknown): DeclarationLocation | null {
  const first = (Array.isArray(answer) ? answer[0] : answer) as
    | Partial<Location & LocationLink>
    | null
    | undefined;
  if (!first || typeof first !== "object") return null;
  const uri = first.targetUri ?? first.uri;
  const range = first.targetSelectionRange ?? first.targetRange ?? first.range;
  const line = range?.start?.line;
  if (typeof uri !== "string" || typeof line !== "number") return null;
  const path = uriToPath(uri);
  return path ? { path, line } : null;
}

/** Sites asked about per request at most (one definition request each). */
const MAX_SERVER_SITES = 16;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A whole identifier `name` (not part of a longer one). */
function identifier(name: string): RegExp {
  return new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
}

/** The 0-based line and UTF-16 character of `offset` in `text`. */
export function positionAt(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { line, character: offset - lineStart };
}

/**
 * The import statement of `ref` in `head`: where it starts and its text (for JavaScript, up to
 * the module's name; for Python, the whole `from x import …`).
 */
function importStatement(
  head: string,
  ref: ImportRef,
  languageId: string,
): { start: number; text: string } | null {
  if (JS_LANGUAGES.has(languageId)) {
    for (const q of head.matchAll(new RegExp(`["']${escapeRegExp(ref.spec)}["']`, "g"))) {
      const before = head.slice(0, q.index);
      let start = -1;
      for (const k of before.matchAll(/(?<![\w$.])(?:import|export)\b/g)) start = k.index;
      if (start < 0) continue;
      const text = before.slice(start);
      // Another statement's module comes between (`import "a"; … "a"`): not this one.
      if (/["'`]/.test(text)) continue;
      return { start, text };
    }
    return null;
  }
  if (languageId === "python") {
    const re = new RegExp(
      `^[ \\t]*from\\s+${escapeRegExp(ref.spec)}\\s+import\\s+(?:\\([^)]*\\)|[^\\n#]+)`,
      "m",
    );
    const m = re.exec(head);
    return m ? { start: m.index, text: m[0] } : null;
  }
  return null;
}

/**
 * Where to ask a language server about each of `names` from `ref` (m7.12): the name in the import
 * statement (the default import's local name for "default"), or, for a namespace's members, the
 * first `ns.member` in the file. Names it can't place are left out.
 */
export function importSites(
  text: string,
  languageId: string,
  ref: ImportRef,
  names: readonly string[],
): ImportSite[] {
  const head = text.split("\n").slice(0, IMPORT_SCAN_LINES).join("\n");
  const statement = importStatement(head, ref, languageId);
  const out: ImportSite[] = [];
  for (const name of names) {
    let offset = -1;
    if (statement && ref.names.includes(name)) {
      if (name === "default") {
        const d = /^import\s+(?:type\s+)?([\w$]+)\s*(?:,|from\b)/.exec(statement.text);
        if (d?.[1]) offset = statement.start + d[0].indexOf(d[1]);
      } else {
        // Python's `from a.b import b`: the name after `import`, not the module's part.
        const from = languageId === "python" ? statement.text.search(/\simport\s/) + 1 : 0;
        const i = statement.text.slice(from).search(identifier(name));
        if (i >= 0) offset = statement.start + from + i;
      }
    } else if (ref.namespace) {
      const m = new RegExp(
        `(?<![\\w$.])${escapeRegExp(ref.namespace)}(\\.|::)${escapeRegExp(name)}(?![\\w$])`,
      ).exec(text);
      if (m?.[1]) offset = m.index + ref.namespace.length + m[1].length;
    }
    if (offset >= 0) out.push({ name, ...positionAt(text, offset) });
  }
  return out;
}

/** The declarations at `at` (0-based lines) of a file's text, as one snippet. Null: none. */
export function declarationsAt(text: string, at: readonly number[]): string | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let out = "";
  for (const line of [...new Set(at)].sort((a, b) => a - b)) {
    if (line < 0 || line >= lines.length) continue;
    const part = declarationAt(lines, line);
    if (!part.trim()) continue;
    if (out.length + part.length + 1 > MAX_IMPORT_SNIPPET_CHARS) break;
    out += `${out ? "\n" : ""}${part}`;
  }
  return out || null;
}

/** Reads a file of the folder: its text, or null (missing, too big, not text). */
export type FileReader = (path: string) => Promise<string | null>;

const IMPORT_LINE =
  /^\s*(?:import\b|from\s+\S+\s+import\b|export\s.*\bfrom\b|#\s*include\b|(?:pub\s+)?mod\s+\w+\s*;|.*\brequire\(\s*["'])/;

/** Files followed per request at most. */
const MAX_IMPORTED_FILES = 8;
/** Files deep a re-export is followed (the file imported, a barrel, what it re-exports…). */
const MAX_IMPORT_DEPTH = 3;

/** The names of `names` that `text` declares (export default counts for "default"). */
export function declaredNames(text: string, names: readonly string[]): Set<string> {
  const wanted = new Set(names);
  const found = new Set<string>();
  for (const line of text.split("\n")) {
    const m = DECLARATION.exec(line);
    if (m?.[1] && wanted.has(m[1])) found.add(m[1]);
    if (wanted.has("default") && /^[ \t]*export\s+default\b/.test(line)) found.add("default");
  }
  return found;
}

/**
 * The import graph's snippets for one file, with the files it reads cached (by path, until
 * `invalidate`, or a minute: edits outside the IDE).
 */
export class ImportGraph {
  private readonly files = new Map<string, { text: string | null; at: number }>();

  constructor(
    private readonly read: FileReader,
    /** An open editor's text of a file (unsaved changes count), not cached: it's at hand. */
    private readonly openText: (path: string) => string | undefined = () => undefined,
    private readonly ttlMs = 60_000,
  ) {}

  /** A file changed, was created, renamed or deleted: read it again next time. */
  invalidate(path?: string): void {
    if (path === undefined) this.files.clear();
    else this.files.delete(pathKey(path));
  }

  /** Missing files are remembered too: a new file may be one of them. */
  forgetMissing(): void {
    for (const [p, f] of this.files) if (f.text === null) this.files.delete(p);
  }

  private async load(path: string, now: number): Promise<string | null> {
    const open = this.openText(path);
    if (open !== undefined) return open;
    const key = pathKey(path);
    const cached = this.files.get(key);
    if (cached && now - cached.at <= this.ttlMs) return cached.text;
    const text = await this.read(path).catch(() => null);
    this.files.delete(key);
    this.files.set(key, { text, at: now });
    // Bounded: a long session visits many files.
    if (this.files.size > 500) {
      const oldest = this.files.keys().next();
      if (!oldest.done) this.files.delete(oldest.value);
    }
    return text;
  }

  /**
   * Snippets of what `text` (the file at `path`) imports, for a completion after `prefix`:
   * the declarations of imported names the code near the cursor uses score highest.
   */
  async snippets(input: {
    path: string;
    languageId: string;
    text: string;
    prefix: string;
    root: string | null;
    /** Files kept from AI (agent ignore rules): neither read nor sent. */
    skip?: (path: string) => boolean;
    /** The file's language server, when one runs for it (m7.12): asked first. */
    definitions?: DefinitionLookup;
    now?: number;
  }): Promise<Snippet[]> {
    const now = input.now ?? Date.now();
    // Names the code near the cursor uses (the import lines themselves don't count).
    const near = new Set(
      input.prefix
        .split("\n")
        .slice(-30)
        .filter((line) => !IMPORT_LINE.test(line))
        .join("\n")
        .match(/[\w$]+/g) ?? [],
    );
    const out: Snippet[] = [];
    const seen = new Set<string>([pathKey(input.path)]);
    const js = JS_LANGUAGES.has(input.languageId);
    const aliases = js ? await this.aliases(input.root, now) : [];
    // Breadth first: the file's own imports, then what the files they lead to re-export.
    const queue: { from: string; ref: ImportRef; names: string[]; depth: number }[] = [];
    for (const ref of parseImports(input.text, input.languageId)) {
      const names = [...ref.names];
      if (ref.namespace) names.push(...namespaceMembers(input.text, ref.namespace));
      queue.push({ from: input.path, ref, names, depth: 1 });
    }
    // The language server first (m7.12): the names it places come from where it says.
    if (input.definitions) {
      const placed = await this.serverSnippets(input, queue, near, seen, out, now);
      for (let i = queue.length - 1; i >= 0; i--) {
        const item = queue[i];
        const done = item && placed.get(item);
        if (!item || !done?.size) continue;
        item.names = item.names.filter((n) => !done.has(n));
        // Every name it brings in was placed: the regex has nothing to add.
        if (!item.names.length) queue.splice(i, 1);
      }
    }
    let steps = 0;
    for (let item = queue.shift(); item; item = queue.shift()) {
      // Files read per request stay bounded, whatever a barrel re-exports.
      if (out.length >= MAX_IMPORTED_FILES || ++steps > MAX_IMPORTED_FILES * 4) break;
      const { from, ref, names, depth } = item;
      let candidates = resolveImport(from, ref, input.languageId, input.root, aliases);
      if (!candidates.length && js) candidates = await this.packageFiles(ref.spec, input.root, now);
      for (const candidate of candidates) {
        if (seen.has(pathKey(candidate)) || input.skip?.(candidate)) continue;
        const text = await this.load(candidate, now);
        if (text === null) continue;
        seen.add(pathKey(candidate));
        const declared = names.length ? declaredNames(text, names) : new Set<string>();
        // A barrel that only re-exports: its own outline says nothing; what it leads to does.
        const missing = names.filter((n) => !declared.has(n));
        const reexports =
          depth < MAX_IMPORT_DEPTH && (missing.length || !names.length)
            ? parseImports(text, input.languageId).filter((r) => r.reexport)
            : [];
        const snippet =
          declared.size || !reexports.length
            ? importSnippetText(text, [...declared].length ? [...declared] : names)
            : null;
        if (snippet) {
          const used = names.some((n) => near.has(n));
          out.push({
            path: candidate,
            text: snippet,
            kind: "import",
            score: (used ? 0.6 : 0.3) / depth,
          });
        }
        for (const r of reexports) {
          // `export * from`: any missing name may be there; `export { a } from`: its own.
          const want = r.names.length ? missing.filter((n) => r.names.includes(n)) : missing;
          if (r.names.length && !want.length) continue;
          queue.push({ from: candidate, ref: r, names: want, depth: depth + 1 });
        }
        break;
      }
    }
    return out;
  }

  /**
   * Snippets for the imports in `items` from the language server's definitions (m7.12), added to
   * `out` (their files to `seen`). Returns, per item, the names the server placed.
   */
  private async serverSnippets(
    input: {
      path: string;
      languageId: string;
      text: string;
      skip?: (path: string) => boolean;
      definitions?: DefinitionLookup;
    },
    items: readonly { ref: ImportRef; names: string[] }[],
    near: ReadonlySet<string>,
    seen: Set<string>,
    out: Snippet[],
    now: number,
  ): Promise<Map<object, Set<string>>> {
    const placed = new Map<object, Set<string>>();
    const sites: { item: object; site: ImportSite }[] = [];
    for (const item of items) {
      if (!item.names.length) continue;
      for (const site of importSites(input.text, input.languageId, item.ref, item.names)) {
        if (sites.length >= MAX_SERVER_SITES) break;
        sites.push({ item, site });
      }
    }
    if (!sites.length || !input.definitions) return placed;
    const answers = await input.definitions(sites.map((s) => s.site)).catch(() => null);
    if (!answers) return placed;
    // Grouped by the file the names are declared in, in the order first seen.
    const files = new Map<
      string,
      { path: string; lines: number[]; hits: { item: object; name: string }[] }
    >();
    for (const [i, answer] of answers.entries()) {
      const entry = sites[i];
      if (!answer || !entry) continue;
      const key = pathKey(answer.path);
      // The file itself (a server that stops at the local binding) says nothing new.
      if (key === pathKey(input.path) || input.skip?.(answer.path)) continue;
      let file = files.get(key);
      if (!file) {
        file = { path: answer.path, lines: [], hits: [] };
        files.set(key, file);
      }
      file.lines.push(answer.line);
      file.hits.push({ item: entry.item, name: entry.site.name });
    }
    for (const [key, file] of files) {
      if (out.length >= MAX_IMPORTED_FILES) break;
      const text = await this.load(file.path, now);
      const snippet = text === null ? null : declarationsAt(text, file.lines);
      if (!snippet) continue;
      seen.add(key);
      const used = file.hits.some((h) => near.has(h.name));
      out.push({ path: file.path, text: snippet, kind: "import", score: used ? 0.6 : 0.3 });
      for (const hit of file.hits) {
        const names = placed.get(hit.item) ?? new Set<string>();
        names.add(hit.name);
        placed.set(hit.item, names);
      }
    }
    return placed;
  }

  /** The open folder's tsconfig.json (else jsconfig.json) `paths` (D229). */
  private async aliases(root: string | null, now: number): Promise<PathAlias[]> {
    if (!root) return [];
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const text = await this.load(joinPath(root, name), now);
      if (text !== null) return tsconfigAliases(text, root);
    }
    return [];
  }

  /**
   * A package's typings in the folder's node_modules (D229): its `types`, else its index.d.ts,
   * else DefinitelyTyped's (`@types/scope__name`).
   */
  private async packageFiles(spec: string, root: string | null, now: number): Promise<string[]> {
    const pkg = packageSpec(spec);
    if (!pkg || !root) return [];
    const modules = joinPath(root, "node_modules");
    const dir = joinPath(modules, pkg.name);
    if (pkg.subpath) {
      const base = resolveInRoot(dir, pkg.subpath);
      return [`${base}.d.ts`, joinPath(base, "index.d.ts")];
    }
    const json = await this.load(joinPath(dir, "package.json"), now);
    const typings = json === null ? null : packageTypings(json);
    const typesName = pkg.name.replace(/^@([^/]+)\//, "$1__");
    return [
      ...(typings ? [resolveInRoot(dir, typings)] : []),
      joinPath(dir, "index.d.ts"),
      joinPath(joinPath(joinPath(modules, "@types"), typesName), "index.d.ts"),
    ];
  }
}
