// Language configurations (D128): comments, brackets, auto-closing pairs, indentation rules and
// folding markers per language. Syntax colors come from Shiki, so Monaco's own language
// definitions were never loaded — and with them went Ctrl+/ comments, bracket pair colors and
// auto-closing brackets. Each definition module is loaded the first time a file of that
// language opens (its own chunk); only its `conf` is used, never its tokenizer.
import * as monaco from "./core";

type Conf = monaco.languages.LanguageConfiguration;
type Loader = () => Promise<{ conf: Conf }>;

const def = {
  typescript: () => import("monaco-editor/languages/definitions/typescript/typescript.js"),
  javascript: () => import("monaco-editor/languages/definitions/javascript/javascript.js"),
  html: () => import("monaco-editor/languages/definitions/html/html.js"),
  css: () => import("monaco-editor/languages/definitions/css/css.js"),
  scss: () => import("monaco-editor/languages/definitions/scss/scss.js"),
  less: () => import("monaco-editor/languages/definitions/less/less.js"),
  markdown: () => import("monaco-editor/languages/definitions/markdown/markdown.js"),
  python: () => import("monaco-editor/languages/definitions/python/python.js"),
  r: () => import("monaco-editor/languages/definitions/r/r.js"),
  julia: () => import("monaco-editor/languages/definitions/julia/julia.js"),
  rust: () => import("monaco-editor/languages/definitions/rust/rust.js"),
  go: () => import("monaco-editor/languages/definitions/go/go.js"),
  java: () => import("monaco-editor/languages/definitions/java/java.js"),
  kotlin: () => import("monaco-editor/languages/definitions/kotlin/kotlin.js"),
  cpp: () => import("monaco-editor/languages/definitions/cpp/cpp.js"),
  csharp: () => import("monaco-editor/languages/definitions/csharp/csharp.js"),
  swift: () => import("monaco-editor/languages/definitions/swift/swift.js"),
  ruby: () => import("monaco-editor/languages/definitions/ruby/ruby.js"),
  php: () => import("monaco-editor/languages/definitions/php/php.js"),
  lua: () => import("monaco-editor/languages/definitions/lua/lua.js"),
  shell: () => import("monaco-editor/languages/definitions/shell/shell.js"),
  powershell: () => import("monaco-editor/languages/definitions/powershell/powershell.js"),
  bat: () => import("monaco-editor/languages/definitions/bat/bat.js"),
  yaml: () => import("monaco-editor/languages/definitions/yaml/yaml.js"),
  ini: () => import("monaco-editor/languages/definitions/ini/ini.js"),
  xml: () => import("monaco-editor/languages/definitions/xml/xml.js"),
  sql: () => import("monaco-editor/languages/definitions/sql/sql.js"),
  graphql: () => import("monaco-editor/languages/definitions/graphql/graphql.js"),
  dockerfile: () => import("monaco-editor/languages/definitions/dockerfile/dockerfile.js"),
} as Record<string, Loader>;

const brackets: [string, string][] = [
  ["{", "}"],
  ["[", "]"],
  ["(", ")"],
];
const pairs = (extra: { open: string; close: string; notIn?: string[] }[] = []) => [
  { open: "{", close: "}" },
  { open: "[", close: "]" },
  { open: "(", close: ")" },
  ...extra,
];
const quotes = [
  { open: '"', close: '"', notIn: ["string"] },
  { open: "'", close: "'", notIn: ["string", "comment"] },
];

/** Languages Monaco has no definition for: small configurations of our own. */
const OWN: Record<string, Conf> = {
  json: {
    brackets: [
      ["{", "}"],
      ["[", "]"],
    ],
    autoClosingPairs: pairs(quotes.slice(0, 1)),
  },
  jsonc: {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
    ],
    autoClosingPairs: pairs(quotes.slice(0, 1)),
  },
  toml: {
    comments: { lineComment: "#" },
    brackets: [
      ["{", "}"],
      ["[", "]"],
    ],
    autoClosingPairs: pairs(quotes),
  },
  zig: {
    comments: { lineComment: "//" },
    brackets,
    autoClosingPairs: pairs(quotes),
  },
  make: { comments: { lineComment: "#" }, brackets, autoClosingPairs: pairs(quotes) },
};

/** Our language id → the Monaco definition whose configuration it uses. */
const SHARED: Record<string, string> = {
  tsx: "typescript",
  jsx: "javascript",
  c: "cpp",
  shellscript: "shell",
  vue: "html",
  svelte: "html",
};

/** The editor's own configurations being loaded, by language (once a file of it opened). */
const builtinLoads = new Map<string, Promise<void>>();

/**
 * Resolves once the editor's own configuration of `id` is set (right away when it has none or
 * none is loading): an extension's configuration registered after it wins field by field, as
 * VS Code merges an extension's language-configuration.json over the language's.
 */
export function builtinConfigurationSet(id: string): Promise<void> {
  return builtinLoads.get(id) ?? Promise.resolve();
}

/** Sets each language's configuration the first time a file of it opens. */
export function registerLanguageConfigurations(ids: readonly string[]): void {
  for (const id of ids) {
    const own = OWN[id];
    if (own) {
      monaco.languages.setLanguageConfiguration(id, own);
      continue;
    }
    const load = def[SHARED[id] ?? id];
    if (!load) continue;
    monaco.languages.onLanguage(id, () => {
      builtinLoads.set(
        id,
        load()
          .then((m) => {
            monaco.languages.setLanguageConfiguration(id, m.conf);
          })
          .catch(() => {}),
      );
    });
  }
}
