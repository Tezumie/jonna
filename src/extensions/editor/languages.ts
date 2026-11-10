import { globToRegExp } from "../../core/paths/glob";
import { basename } from "../../core/paths/index";
import { normalizeLanguageId } from "../../core/settings/languageOverrides";

// Language detection by file name. DOM-free so the state tree and tests can use it.
// Grammars are only loaded (lazily, one chunk each) for languages listed here — a curated set
// keeps the bundle small. Unknown files open as plaintext.

export interface LanguageInfo {
  id: string;
  /** Lowercase extensions including the dot. */
  extensions: readonly string[];
  /** Exact file names (case doesn't matter, as in VS Code). */
  filenames?: readonly string[];
  /** VS Code's `filenamePatterns`: globs on the name (or on the path when they hold a `/`). */
  filenamePatterns?: readonly string[];
  /** VS Code's `firstLine`: a RegExp source tried on the first line when the name decides nothing. */
  firstLine?: string;
}

export const LANGUAGES: readonly LanguageInfo[] = [
  { id: "typescript", extensions: [".ts", ".mts", ".cts"] },
  { id: "tsx", extensions: [".tsx"] },
  { id: "javascript", extensions: [".js", ".mjs", ".cjs"], firstLine: "^#!.*\\bnode" },
  { id: "jsx", extensions: [".jsx"] },
  { id: "json", extensions: [".json", ".webmanifest"] },
  {
    id: "jsonc",
    // A multi-root workspace file is JSON with comments, as in VS Code (D251).
    extensions: [".jsonc", ".code-workspace"],
    filenames: [
      "tsconfig.json",
      "jsconfig.json",
      "settings.json",
      "keybindings.json",
      "biome.json",
    ],
  },
  { id: "html", extensions: [".html", ".htm"] },
  { id: "css", extensions: [".css"] },
  { id: "scss", extensions: [".scss"] },
  { id: "less", extensions: [".less"] },
  { id: "markdown", extensions: [".md", ".markdown"] },
  // firstLine: VS Code's own (a shebang decides a file without an extension).
  { id: "python", extensions: [".py", ".pyi"], firstLine: "^#!\\s*/?.*\\bpython[0-9.-]*\\b" },
  // Jupyter kernels beyond Python (D204): IRkernel and IJulia notebooks color their cells.
  { id: "r", extensions: [".r"] },
  { id: "julia", extensions: [".jl"] },
  { id: "rust", extensions: [".rs"] },
  { id: "go", extensions: [".go"] },
  { id: "java", extensions: [".java"] },
  { id: "kotlin", extensions: [".kt", ".kts"] },
  { id: "c", extensions: [".c", ".h"] },
  { id: "cpp", extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"] },
  { id: "csharp", extensions: [".cs"] },
  { id: "swift", extensions: [".swift"] },
  {
    id: "ruby",
    extensions: [".rb"],
    filenames: ["Gemfile", "Rakefile"],
    firstLine: "^#!\\s*/.*\\bruby\\b",
  },
  { id: "php", extensions: [".php"] },
  { id: "lua", extensions: [".lua"] },
  { id: "zig", extensions: [".zig"] },
  {
    id: "shellscript",
    extensions: [".sh", ".bash", ".zsh"],
    filenames: [".bashrc", ".zshrc", ".profile"],
    firstLine:
      "^#!.*\\b(bash|fish|zsh|sh|ksh|dtksh|pdksh|mksh|ash|dash|yash|sh|csh|jcsh|tcsh|itcsh).*|^#\\s*-\\*-[^*]*mode:\\s*shell-script[^*]*-\\*-",
  },
  { id: "powershell", extensions: [".ps1", ".psm1"] },
  { id: "bat", extensions: [".bat", ".cmd"] },
  { id: "yaml", extensions: [".yaml", ".yml"] },
  { id: "toml", extensions: [".toml"], filenames: ["Cargo.lock"] },
  { id: "ini", extensions: [".ini", ".cfg", ".conf"], filenames: [".editorconfig"] },
  { id: "xml", extensions: [".xml", ".svg", ".plist"] },
  { id: "sql", extensions: [".sql"] },
  { id: "graphql", extensions: [".graphql", ".gql"] },
  { id: "dockerfile", extensions: [".dockerfile"], filenames: ["Dockerfile", "Containerfile"] },
  { id: "make", extensions: [".mk"], filenames: ["Makefile", "makefile", "GNUmakefile"] },
  { id: "diff", extensions: [".diff", ".patch"] },
  { id: "vue", extensions: [".vue"] },
  { id: "svelte", extensions: [".svelte"] },
];

export const PLAINTEXT = "plaintext";

/** Languages installed extensions add (D102); checked before the built-in list. */
let contributed: readonly LanguageInfo[] = [];

export function setContributedLanguages(languages: readonly LanguageInfo[]): void {
  contributed = languages;
}

/** Every language the editor knows, its own and extensions' (VS Code's getLanguages). */
export function allLanguageIds(): string[] {
  return [...new Set([PLAINTEXT, ...LANGUAGES.map((l) => l.id), ...contributed.map((l) => l.id)])];
}

export interface FileAssociation {
  pattern: string;
  language: string;
}

/** files.associations (D201): pattern → language id, checked before everything else. */
let associations: readonly FileAssociation[] = [];

/**
 * Sets `files.associations` (VS Code's, e.g. `{ "*.mdx": "markdown", "Dockerfile.*":
 * "dockerfile" }`). Entries without a language are left out.
 */
export function setFileAssociations(value: unknown): void {
  associations = parseFileAssociations(value);
}

export function parseFileAssociations(value: unknown): FileAssociation[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter((e): e is [string, string] => !!e[0] && typeof e[1] === "string" && !!e[1].trim())
    .map(([pattern, language]) => ({ pattern, language: normalizeLanguageId(language) }));
}

/**
 * The language files.associations gives `path`, matched as VS Code does: a pattern with a `/`
 * against the whole path (any folders before it), else against the file name, ignoring case; a
 * name without wildcards beats a pattern, then the longer pattern wins.
 */
export function associatedLanguage(
  path: string,
  list: readonly FileAssociation[] = associations,
): string | undefined {
  if (!list.length) return undefined;
  const full = path.replace(/\\/g, "/").toLowerCase();
  const name = basename(path).toLowerCase();
  let best: { language: string; exact: boolean; length: number } | undefined;
  for (const { pattern, language } of list) {
    const p = pattern.replace(/\\/g, "/").toLowerCase();
    const exact = !/[*?[{]/.test(p);
    let hit: boolean;
    if (!p.includes("/")) hit = exact ? name === p : globToRegExp(p).test(name);
    else if (exact) hit = full === p || full.endsWith(p.startsWith("/") ? p : `/${p}`);
    else {
      // Absolute patterns as they are; relative ones may start in any folder.
      const anchored = p.startsWith("/") || /^[a-z]:\//.test(p) || p.startsWith("**");
      hit = globToRegExp(anchored ? p : `**/${p}`).test(full);
    }
    if (!hit) continue;
    if (!best || (exact && !best.exact) || (exact === best.exact && p.length > best.length))
      best = { language, exact, length: p.length };
  }
  return best?.language;
}

/**
 * Detects the language id from a path (either separator) as VS Code does: files.associations
 * first, then a file name, then the longest `filenamePatterns` match, then the longest extension
 * (extensions' languages beat the built-in list on a tie: registered later, as in VS Code), and
 * last, when none of those decides, `firstLine` (the file's first line, when known: a shebang).
 */
export function languageForPath(path: string, firstLine?: string): string {
  const associated = associatedLanguage(path);
  if (associated) return associated;
  return detectLanguage(path, [...LANGUAGES, ...contributed], firstLine);
}

/** VS Code's detection over `languages` in registration order (later wins a tie). DOM-free. */
export function detectLanguage(
  path: string,
  languages: readonly LanguageInfo[],
  firstLine?: string,
): string {
  const name = basename(path);
  const lowerName = name.toLowerCase();
  const latestFirst = [...languages].reverse();
  for (const lang of latestFirst)
    if (lang.filenames?.some((f) => f.toLowerCase() === lowerName)) return lang.id;
  const patterns = latestFirst.flatMap((lang) =>
    (lang.filenamePatterns ?? []).map((pattern) => ({ pattern, language: lang.id })),
  );
  const byPattern = associatedLanguage(path, patterns);
  if (byPattern) return byPattern;
  let best: { id: string; length: number } | undefined;
  for (const lang of latestFirst)
    for (const e of lang.extensions) {
      const ext = e.toLowerCase();
      if (ext && lowerName.endsWith(ext) && (!best || ext.length > best.length))
        best = { id: lang.id, length: ext.length };
    }
  if (best) return best.id;
  // `.txt` is plain text's own extension in VS Code: its first line doesn't decide.
  if (firstLine && !lowerName.endsWith(".txt")) {
    const line = firstLine.replace(/^﻿/, "").slice(0, 1000);
    for (const lang of latestFirst) {
      const re = lang.firstLine ? firstLineRegExp(lang.firstLine) : null;
      if (re?.test(line)) return lang.id;
    }
  }
  return PLAINTEXT;
}

const firstLineCache = new Map<string, RegExp | null>();

/** A `firstLine` source compiled once (null when it isn't a valid RegExp). */
function firstLineRegExp(source: string): RegExp | null {
  let re = firstLineCache.get(source);
  if (re === undefined) {
    try {
      re = new RegExp(source);
    } catch {
      re = null;
    }
    firstLineCache.set(source, re);
  }
  return re;
}

/** A text's first line (for languageForPath's `firstLine`). */
export function firstLineOf(text: string): string {
  const head = text.slice(0, 1001);
  const end = head.search(/\r?\n/);
  return (end < 0 ? head : head.slice(0, end)).slice(0, 1000);
}
