// Go to symbol in workspace (Ctrl/Cmd+T, "#" in quick access; D133). Two sources, merged (and
// extensions' workspace symbol providers, D234):
// running language servers that answer `workspace/symbol`, and a declaration search over the
// whole folder (the Rust search, one regex for the common languages' `function` / `class` / `def`
// / `fn` / `struct` … lines). The search needs no server, so it works for every folder; a server
// adds what a line regex can't see (methods, exported consts in other forms). DOM-free parts are
// tested; `findWorkspaceSymbols` runs both. D251: a multi-root workspace's every folder (the search
// covers them all; symbols are named by workspace paths, the folder's name first).
import { searchIpc } from "../../core/ipc/fs";
import type { LanguageClient } from "../../core/lsp/client";
import type * as lsp from "../../core/lsp/types";
import { uriToPath } from "../../core/lsp/uri";
import { isWithin, relativePath } from "../../core/paths/index";
import { fuzzyMatch } from "../../ui/fuzzy";

const KEYWORDS: Record<string, string> = {
  function: "function",
  "function*": "function",
  def: "function",
  fn: "function",
  func: "function",
  class: "class",
  interface: "interface",
  trait: "interface",
  type: "class",
  enum: "enum",
  struct: "struct",
  module: "module",
  mod: "module",
  namespace: "namespace",
  const: "constant",
  let: "variable",
  var: "variable",
};

/** Query characters a name must contain, in order ("" when nothing usable was typed). */
function namePattern(query: string): string {
  const chars = [...query].filter((c) => /[\w$]/.test(c));
  if (!chars.length) return "";
  return `[\\w$]*${chars.map((c) => (c === "$" ? "\\$" : c)).join("[\\w$]*")}[\\w$]*`;
}

const MODIFIERS =
  "(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:pub(?:\\([^)]*\\))?\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:unsafe\\s+)?";
const BLOCK_KEYWORDS =
  "function\\*?|class|interface|type|enum|struct|trait|def|fn|func|module|mod|namespace";

/**
 * The search regex (Rust and JS syntax alike) for declarations whose name contains the query's
 * characters in order. Top-level `const` / `let` / `var` only (column 0), so locals stay out.
 */
export function declarationRegex(query: string): string | null {
  const name = namePattern(query);
  if (!name) return null;
  return (
    `^(?:export\\s+)?(?:const|let|var)\\s+(${name})\\b` +
    `|^\\s*${MODIFIERS}(?:${BLOCK_KEYWORDS})\\s+(?:\\([^)]*\\)\\s*)?(${name})\\b`
  );
}

const PARSE = new RegExp(
  `^(?:export\\s+)?(const|let|var)\\s+([A-Za-z_$][\\w$]*)` +
    `|^\\s*${MODIFIERS}(${BLOCK_KEYWORDS})\\s+(?:\\([^)]*\\)\\s*)?([A-Za-z_$][\\w$]*)`,
);

/** The declared name, its kind (the outline's kind names) and 1-based column, or null. */
export function parseDeclaration(
  text: string,
): { name: string; kind: string; column: number } | null {
  const m = PARSE.exec(text);
  if (!m) return null;
  const keyword = m[1] ?? m[3] ?? "";
  const name = m[2] ?? m[4];
  if (!name) return null;
  return { name, kind: KEYWORDS[keyword] ?? "variable", column: text.indexOf(name, m.index) + 1 };
}

/** LSP SymbolKind (1-based) → the outline's kind names (icons). */
const LSP_KINDS = [
  "",
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enumMember",
  "struct",
  "event",
  "operator",
  "typeParameter",
];

export function lspKindName(kind: number): string {
  return LSP_KINDS[kind] || "variable";
}

/**
 * Which files are the workspace's and how they're named: one folder (its root), or a multi-root
 * workspace's folders (`WorkspaceService.contains` / `relative`, the folder's name first).
 */
export interface SymbolScope {
  contains(path: string): boolean;
  relative(path: string): string;
  /** Several folders: a search result's path is renamed (its `rel` is its own folder's). */
  multi: boolean;
}

/** The scope of one folder. */
export function rootScope(root: string): SymbolScope {
  return {
    contains: (path) => isWithin(root, path),
    relative: (path) => relativePath(root, path),
    multi: false,
  };
}

const scopeOf = (scope: string | SymbolScope): SymbolScope =>
  typeof scope === "string" ? rootScope(scope) : scope;

export interface WorkspaceSymbol {
  name: string;
  kind: string;
  /** Workspace-relative path. */
  rel: string;
  /** The file, absolute (what opens it). */
  path: string;
  line: number;
  column: number;
  /** The containing symbol, when the language server says. */
  container?: string;
  score: number;
  positions: readonly number[];
}

/** Matches from the declaration search (fuzzy-scored against `query`). */
async function searchDeclarations(query: string, scope: SymbolScope): Promise<WorkspaceSymbol[]> {
  const regex = declarationRegex(query);
  if (!regex) return [];
  const found: WorkspaceSymbol[] = [];
  await new Promise<void>((resolve, reject) => {
    searchIpc
      .start(
        {
          query: regex,
          isRegex: true,
          matchCase: false,
          wholeWord: false,
          include: [],
          exclude: ["**/*.min.js", "**/*.map", "**/*.lock", "**/*.d.ts"],
          maxResults: 2000,
        },
        (e) => {
          if (e.kind !== "file") return resolve();
          for (const m of e.matches) {
            const decl = parseDeclaration(m.text);
            const match = decl && fuzzyMatch(query, decl.name);
            if (decl && match)
              found.push({
                ...decl,
                rel: scope.multi ? scope.relative(e.path) : e.rel,
                path: e.path,
                line: m.line,
                score: match.score,
                positions: match.positions,
              });
          }
        },
        true,
      )
      .catch(reject);
  });
  return found;
}

/** `workspace/symbol` from each running server that offers it (failures: none from it). */
async function serverSymbols(
  query: string,
  scope: SymbolScope,
  clients: readonly LanguageClient[],
): Promise<WorkspaceSymbol[]> {
  const asking = clients.filter((c) => c.capabilities.workspaceSymbolProvider);
  const answers = await Promise.all(
    asking.map((c) =>
      c.request<lsp.SymbolInformation[] | null>("workspace/symbol", { query }).catch(() => null),
    ),
  );
  return answers.flatMap((list) =>
    (list ?? []).flatMap((sym) => {
      const path = sym.location?.uri ? uriToPath(sym.location.uri) : null;
      const match = fuzzyMatch(query, sym.name);
      if (!path || !match || !scope.contains(path)) return [];
      const start = sym.location.range?.start ?? { line: 0, character: 0 };
      return [
        {
          name: sym.name,
          kind: lspKindName(sym.kind),
          rel: scope.relative(path),
          path,
          line: start.line + 1,
          column: start.character + 1,
          ...(sym.containerName && { container: sym.containerName }),
          score: match.score,
          positions: match.positions,
        },
      ];
    }),
  );
}

/** A symbol an extension's workspace symbol provider answered (D234; absolute path). */
export interface ExtensionSymbol {
  name: string;
  kind: string;
  path: string;
  line: number;
  column: number;
  container?: string;
}

/**
 * Extensions' symbols that match `query`, in the workspace (`scope`: a folder's root, or every
 * folder of a multi-root workspace), as quick open lists them.
 */
export function extensionSymbols(
  query: string,
  scope: string | SymbolScope,
  list: readonly ExtensionSymbol[],
): WorkspaceSymbol[] {
  const within = scopeOf(scope);
  return list.flatMap((sym) => {
    const match = fuzzyMatch(query, sym.name);
    if (!match || !within.contains(sym.path)) return [];
    return [
      {
        name: sym.name,
        kind: sym.kind,
        rel: within.relative(sym.path),
        path: sym.path,
        line: sym.line,
        column: sym.column,
        ...(sym.container && { container: sym.container }),
        score: match.score,
        positions: match.positions,
      },
    ];
  });
}

/**
 * The sources, one entry per place (servers, then extensions), best match first. `scope`: the
 * folder's root, or a multi-root workspace's folders.
 */
export async function findWorkspaceSymbols(
  query: string,
  scope: string | SymbolScope,
  clients: readonly LanguageClient[],
  limit: number,
  fromExtensions?: (query: string) => Promise<ExtensionSymbol[]>,
): Promise<WorkspaceSymbol[]> {
  if (!query.trim()) return [];
  const within = scopeOf(scope);
  const [fromServers, fromSearch, extensions] = await Promise.all([
    serverSymbols(query, within, clients),
    searchDeclarations(query, within),
    fromExtensions?.(query).catch(() => []) ?? Promise.resolve([]),
  ]);
  const seen = new Set<string>();
  const all: WorkspaceSymbol[] = [];
  for (const sym of [
    ...fromServers,
    ...extensionSymbols(query, within, extensions),
    ...fromSearch,
  ]) {
    const key = `${sym.rel}:${sym.line}:${sym.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(sym);
  }
  all.sort(
    (a, b) => b.score - a.score || a.name.length - b.name.length || a.rel.localeCompare(b.rel),
  );
  return all.slice(0, limit);
}
