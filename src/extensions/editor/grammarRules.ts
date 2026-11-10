// Which TextMate grammars tokenize a language, as VS Code decides it (its TMGrammarFactory): an
// extension's grammar for a language replaces the editor's own for it, the last one registered
// winning; injection grammars join the grammars whose scope they name (`injectTo`, a scope or a
// dot-prefix of one, as the TextMate registry matches them). DOM-free, tested; the Monaco engine
// (monaco/entry.ts) loads what these pick.

import { normalizeLanguageId } from "../../core/settings/languageOverrides";

export interface GrammarRef {
  scopeName: string;
  language?: string;
  injectTo?: readonly string[];
}

/** The grammar an extension gives `languageId` (the last registered), or undefined (the editor's). */
export function languageGrammar<T extends GrammarRef>(
  grammars: readonly T[],
  languageId: string,
): T | undefined {
  for (let i = grammars.length - 1; i >= 0; i--) {
    const g = grammars[i];
    if (g?.language === languageId) return g;
  }
  return undefined;
}

/** Whether `scope` is `target` or inside it ("text.html.markdown" is inside "text.html"). */
function scopeWithin(scope: string, target: string): boolean {
  return scope === target || scope.startsWith(`${target}.`);
}

/** The injection grammars that apply to any of `scopes` (each once, in registration order). */
export function injectionsFor<T extends GrammarRef>(
  grammars: readonly T[],
  scopes: readonly string[],
): T[] {
  return grammars.filter(
    (g) => g.injectTo?.some((target) => scopes.some((s) => scopeWithin(s, target))) ?? false,
  );
}

/** The grammar of each scope name (the last registered wins, as VS Code's scope registry). */
export function grammarsByScope<T extends GrammarRef>(grammars: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const g of grammars) out.set(g.scopeName, g);
  return out;
}

/**
 * The scopes a grammar includes from other grammars (`"include": "source.js"` or
 * `"source.js#expression"`), so they can be loaded first. Its own scope, `$self`, `$base` and
 * `#repository` references aren't counted.
 */
export function includedScopes(json: unknown, ownScope: string): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 200 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const [key, x] of Object.entries(v as Record<string, unknown>)) {
      if (key === "include" && typeof x === "string") {
        const scope = x.split("#")[0] ?? "";
        if (scope && !scope.startsWith("$") && scope !== ownScope) out.add(scope);
      } else walk(x, depth + 1);
    }
  };
  walk(json, 0);
  return [...out];
}

/**
 * `json` with its scope name `from` renamed `to`, and its own `include`s of `from` following it.
 * A grammar replacing one the highlighter already compiled under that scope (an extension
 * installed after the editor's own grammar loaded) is registered this way: the registry keeps a
 * compiled grammar per scope name for good.
 */
export function renameGrammarScope(json: unknown, from: string, to: string): unknown {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 200 || !v || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([key, x]) => {
        if (key === "include" && typeof x === "string") {
          if (x === from) return [key, to];
          if (x.startsWith(`${from}#`)) return [key, to + x.slice(from.length)];
          return [key, x];
        }
        return [key, walk(x, depth + 1)];
      }),
    );
  };
  const out = walk(json, 0) as Record<string, unknown>;
  return { ...out, scopeName: to };
}

/** The root scopes of the editor's own grammars, for includes of them from an extension's. */
export const BUILTIN_SCOPES: Readonly<Record<string, string>> = {
  "source.ts": "typescript",
  "source.tsx": "tsx",
  "source.js": "javascript",
  "source.js.jsx": "jsx",
  "source.json": "json",
  "source.json.comments": "jsonc",
  "text.html.basic": "html",
  "source.css": "css",
  "source.css.scss": "scss",
  "source.css.less": "less",
  "text.html.markdown": "markdown",
  "source.python": "python",
  "source.r": "r",
  "source.julia": "julia",
  "source.rust": "rust",
  "source.go": "go",
  "source.java": "java",
  "source.kotlin": "kotlin",
  "source.c": "c",
  "source.cpp": "cpp",
  "source.cs": "csharp",
  "source.swift": "swift",
  "source.ruby": "ruby",
  "source.php": "php",
  "source.lua": "lua",
  "source.zig": "zig",
  "source.shell": "shellscript",
  "source.powershell": "powershell",
  "source.batchfile": "bat",
  "source.yaml": "yaml",
  "source.toml": "toml",
  "source.ini": "ini",
  "text.xml": "xml",
  "source.sql": "sql",
  "source.graphql": "graphql",
  "source.dockerfile": "dockerfile",
  "source.makefile": "make",
  "source.diff": "diff",
};

/**
 * What a grammar says about its scopes beyond colors (VS Code's `embeddedLanguages` and
 * `tokenTypes` of a grammar contribution): which language code in a scope is (its comments,
 * brackets and auto-closing pairs then follow that language, as CSS inside HTML's style tags),
 * and which scopes count as strings, comments or neither (brackets in "other" pair up).
 */
export interface GrammarScopeRules {
  embeddedLanguages?: Readonly<Record<string, string>>;
  tokenTypes?: Readonly<Record<string, string>>;
}

/** TextMate's StandardTokenType for a `tokenTypes` value (VS Code's TMGrammarFactory). */
const STANDARD_TOKEN_TYPES: Readonly<Record<string, number>> = { other: 0, comment: 1, string: 2 };

/**
 * The rules as the TextMate registry takes them: languages as the engine's numeric ids (`encode`
 * answers 0 for a language it doesn't know, which is left out, as VS Code warns and skips) and
 * token types as numbers. Undefined when nothing applies, so the plain grammar is used.
 */
export function grammarConfiguration(
  rules: GrammarScopeRules,
  encode: (languageId: string) => number,
): { embeddedLanguages: Record<string, number>; tokenTypes: Record<string, number> } | undefined {
  const embeddedLanguages: Record<string, number> = {};
  for (const [scope, language] of Object.entries(rules.embeddedLanguages ?? {})) {
    const id = encode(normalizeLanguageId(language));
    if (id > 0) embeddedLanguages[scope] = id;
  }
  const tokenTypes: Record<string, number> = {};
  for (const [scope, type] of Object.entries(rules.tokenTypes ?? {})) {
    const value = STANDARD_TOKEN_TYPES[type];
    if (value !== undefined) tokenTypes[scope] = value;
  }
  if (!Object.keys(embeddedLanguages).length && !Object.keys(tokenTypes).length) return undefined;
  return { embeddedLanguages, tokenTypes };
}

/** Markdown's fenced code blocks (`meta.embedded.block.<language>`), as VS Code's markdown lists. */
const MARKDOWN_BLOCKS = [
  "c",
  "clojure",
  "coffee",
  "cpp",
  "csharp",
  "css",
  "dart",
  "diff",
  "dockerfile",
  "fsharp",
  "go",
  "groovy",
  "html",
  "ini",
  "java",
  "javascript",
  "json",
  "jsonc",
  "julia",
  "latex",
  "less",
  "lua",
  "makefile",
  "objc",
  "perl",
  "php",
  "powershell",
  "python",
  "r",
  "ruby",
  "rust",
  "scala",
  "scss",
  "shellscript",
  "sql",
  "swift",
  "typescript",
  "typescriptreact",
  "xml",
  "yaml",
];

/**
 * The scope rules of the editor's own grammars, as VS Code's built-in extensions declare them
 * (html, markdown-basics, php): an extension's grammar for these languages brings its own.
 */
export const BUILTIN_SCOPE_RULES: Readonly<Record<string, GrammarScopeRules>> = {
  html: {
    embeddedLanguages: {
      "text.html": "html",
      "source.css": "css",
      "source.js": "javascript",
      "source.python": "python",
    },
    tokenTypes: { "meta.tag string.quoted": "other" },
  },
  markdown: {
    embeddedLanguages: {
      "meta.embedded.block.frontmatter": "yaml",
      "source.js": "javascript",
      "source.css": "css",
      ...Object.fromEntries(MARKDOWN_BLOCKS.map((id) => [`meta.embedded.block.${id}`, id])),
    },
  },
  php: {
    embeddedLanguages: {
      "text.html": "html",
      "source.php": "php",
      "source.sql": "sql",
      "text.xml": "xml",
      "source.js": "javascript",
      "source.json": "json",
      "source.css": "css",
    },
  },
};
