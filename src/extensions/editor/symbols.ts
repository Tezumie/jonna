// Document symbols for languages without a language service (D114): what breadcrumbs and the
// Outline show when no language server is running. Markdown headings (VS Code has these built in),
// and declarations found line by line for common languages (Python, Rust, Go, shell, Ruby, PHP,
// Java/Kotlin/C#/Swift, C/C++, Lua, YAML/TOML/INI sections, Dockerfile stages, Makefile targets).
// Nesting follows indentation (or heading level), which is what formatted code has. A language
// server, when one runs, replaces these (the engine only asks here when it isn't there). DOM-free.

export interface FoundSymbol {
  name: string;
  /** Lower-case kind, as OutlineSymbol: "class", "function", "method", "string", "key"… */
  kind: string;
  /** 1-based. */
  line: number;
  column: number;
  endLine: number;
  children: FoundSymbol[];
}

interface Rule {
  re: RegExp;
  kind: string;
  /** Capture group with the name (default 1). */
  name?: number;
}

const ID = "[A-Za-z_$][\\w$]*";
const rule = (re: string, kind: string, name = 1): Rule => ({ re: new RegExp(re), kind, name });

const RULES: Record<string, Rule[]> = {
  python: [
    rule(`^\\s*(?:async\\s+)?def\\s+(${ID})`, "function"),
    rule(`^\\s*class\\s+(${ID})`, "class"),
  ],
  rust: [
    rule(
      `^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:const\\s+)?(?:unsafe\\s+)?fn\\s+(${ID})`,
      "function",
    ),
    rule(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?struct\\s+(${ID})`, "struct"),
    rule(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?enum\\s+(${ID})`, "enum"),
    rule(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?trait\\s+(${ID})`, "interface"),
    rule(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?mod\\s+(${ID})`, "module"),
    rule(`^\\s*impl(?:<[^>]*>)?\\s+([^{]+?)\\s*(?:\\{|$)`, "class"),
  ],
  go: [
    rule(`^func\\s+(?:\\([^)]*\\)\\s*)?(${ID})`, "function"),
    rule(`^type\\s+(${ID})\\s+struct`, "struct"),
    rule(`^type\\s+(${ID})\\s+interface`, "interface"),
    rule(`^type\\s+(${ID})`, "class"),
  ],
  shellscript: [
    rule(`^\\s*function\\s+([\\w.:-]+)`, "function"),
    rule(`^\\s*([\\w.:-]+)\\s*\\(\\)\\s*\\{?`, "function"),
  ],
  ruby: [
    rule(`^\\s*def\\s+((?:self\\.)?[\\w?!=]+)`, "method"),
    rule(`^\\s*class\\s+([\\w:]+)`, "class"),
    rule(`^\\s*module\\s+([\\w:]+)`, "module"),
  ],
  php: [
    rule(
      `^\\s*(?:(?:public|private|protected|static|abstract|final)\\s+)*function\\s+(${ID})`,
      "function",
    ),
    rule(`^\\s*(?:abstract\\s+|final\\s+)?(?:class|interface|trait|enum)\\s+(${ID})`, "class"),
  ],
  lua: [rule(`^\\s*(?:local\\s+)?function\\s+([\\w.:]+)`, "function")],
  // C-like, by declaration shape (a line ending in "{" or ")" after a name and parameters).
  java: [
    rule(
      `^\\s*(?:(?:public|private|protected|static|abstract|final|sealed)\\s+)*(?:class|interface|enum|record)\\s+(${ID})`,
      "class",
    ),
    rule(
      `^\\s*(?:(?:public|private|protected|static|abstract|final|synchronized|native|default)\\s+)+[\\w<>\\[\\],.? ]+\\s+(${ID})\\s*\\([^;]*$`,
      "method",
    ),
  ],
  kotlin: [
    rule(`^\\s*(?:[a-z]+\\s+)*(?:class|interface|object|enum class)\\s+(${ID})`, "class"),
    rule(`^\\s*(?:[a-z]+\\s+)*fun\\s+(?:<[^>]*>\\s*)?(?:${ID}\\.)?(${ID})`, "function"),
  ],
  csharp: [
    rule(
      `^\\s*(?:(?:public|private|protected|internal|static|abstract|sealed|partial)\\s+)*(?:class|interface|struct|enum|record)\\s+(${ID})`,
      "class",
    ),
    rule(
      `^\\s*(?:(?:public|private|protected|internal|static|virtual|override|async|abstract)\\s+)+[\\w<>\\[\\],.? ]+\\s+(${ID})\\s*\\([^;]*$`,
      "method",
    ),
  ],
  swift: [
    rule(`^\\s*(?:[a-z]+\\s+)*(?:class|struct|enum|protocol|extension)\\s+(${ID})`, "class"),
    rule(`^\\s*(?:[a-z]+\\s+)*func\\s+(${ID})`, "function"),
  ],
  c: [
    rule(`^(?:struct|enum|union)\\s+(${ID})\\s*\\{`, "struct"),
    rule(`^[A-Za-z_][\\w\\s\\*]*?\\b(${ID})\\s*\\([^;]*\\)\\s*\\{?\\s*$`, "function"),
  ],
  cpp: [
    rule(`^\\s*(?:class|struct|enum(?:\\s+class)?|union|namespace)\\s+(${ID})`, "class"),
    rule(
      `^[A-Za-z_][\\w\\s\\*&:<>,]*?\\b((?:${ID}::)*~?${ID})\\s*\\([^;]*\\)\\s*(?:const\\s*)?(?:override\\s*)?\\{?\\s*$`,
      "function",
    ),
  ],
  dockerfile: [rule(`^FROM\\s+\\S+(?:\\s+AS\\s+(\\S+))?`, "module")],
  make: [rule(`^([\\w./%-]+)\\s*:(?!=)`, "function")],
  powershell: [rule(`^\\s*function\\s+([\\w-]+)`, "function")],
  zig: [
    rule(`^\\s*(?:pub\\s+)?fn\\s+(${ID})`, "function"),
    rule(`^\\s*(?:pub\\s+)?const\\s+(${ID})\\s*=\\s*(?:struct|enum|union)`, "struct"),
  ],
  sql: [
    rule(
      `^\\s*create\\s+(?:or\\s+replace\\s+)?(?:table|view|function|procedure|index)\\s+(?:if\\s+not\\s+exists\\s+)?([\\w."]+)`,
      "class",
    ),
  ],
  ini: [rule(`^\\s*\\[([^\\]]+)\\]`, "namespace")],
  toml: [rule(`^\\s*\\[\\[?([^\\]]+)\\]\\]?`, "namespace")],
};
/** Languages this file can give symbols for. */
export const HEURISTIC_LANGUAGES = [...Object.keys(RULES), "markdown", "yaml"];

const KEYWORDS = new Set(["if", "for", "while", "switch", "return", "else", "catch", "sizeof"]);

/** Symbols in `text` of language `languageId` (empty for languages it doesn't know). */
export function findSymbols(languageId: string, text: string): FoundSymbol[] {
  const lines = text.split(/\r?\n/);
  if (languageId === "markdown") return markdownSymbols(lines);
  if (languageId === "yaml") return yamlSymbols(lines);
  const rules = RULES[languageId];
  if (!rules?.length) return [];
  const flat: (FoundSymbol & { indent: number })[] = [];
  // "#" starts a comment except in C-like languages (preprocessor lines just don't match there).
  const hashComments = !["c", "cpp", "csharp"].includes(languageId);
  let docstring = false;
  lines.forEach((line, i) => {
    const trimmed = line.trimStart();
    // Python docstrings spanning lines: skip what's inside.
    if (languageId === "python") {
      const q = /^[rRbBuU]?("""|''')/.exec(trimmed)?.[1];
      if (q && !trimmed.slice(trimmed.indexOf(q) + 3).includes(q)) {
        docstring = !docstring;
        return;
      }
      if (docstring) return;
    }
    if (!trimmed || /^(\/\/|\/\*|\*|--)/.test(trimmed)) return;
    if (hashComments && trimmed.startsWith("#")) return;
    for (const r of rules) {
      const m = r.re.exec(line);
      const name = m?.[r.name ?? 1]?.trim();
      if (!m || !name || KEYWORDS.has(name)) continue;
      flat.push({
        name: name.replace(/\s+/g, " ").slice(0, 120),
        kind: r.kind,
        line: i + 1,
        column: line.length - trimmed.length + 1,
        endLine: i + 1,
        children: [],
        indent: line.length - trimmed.length,
      });
      break;
    }
  });
  return nest(flat, lines.length, (s) => s.indent);
}

/** Builds the tree: a symbol holds the following ones with a bigger level, up to the next peer. */
function nest<T extends FoundSymbol>(
  flat: T[],
  lineCount: number,
  level: (s: T) => number,
): FoundSymbol[] {
  const roots: FoundSymbol[] = [];
  const stack: T[] = [];
  for (const s of flat) {
    while (stack.length && level(stack[stack.length - 1] as T) >= level(s)) {
      const done = stack.pop() as T;
      done.endLine = Math.max(done.line, s.line - 1);
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(s);
    else roots.push(s);
    stack.push(s);
  }
  for (const s of stack) s.endLine = lineCount;
  const strip = (list: FoundSymbol[]): FoundSymbol[] =>
    list.map(({ name, kind, line, column, endLine, children }) => ({
      name,
      kind,
      line,
      column,
      endLine,
      children: strip(children),
    }));
  return strip(roots);
}

function markdownSymbols(lines: string[]): FoundSymbol[] {
  const flat: (FoundSymbol & { depth: number })[] = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (f) {
      if (!fence) fence = f;
      else if (f.startsWith(fence)) fence = null;
      return;
    }
    if (fence) return;
    const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    // Setext headings: a line followed by === or ---.
    const next = lines[i + 1] ?? "";
    const setext =
      !m &&
      line.trim() &&
      /^\s{0,3}(=+|-+)\s*$/.test(next) &&
      !/^\s{0,3}([-*+]|\d+\.)\s/.test(line);
    if (!m && !setext) return;
    const depth = m ? (m[1] as string).length : next.trim().startsWith("=") ? 1 : 2;
    flat.push({
      name: (m ? (m[2] as string) : line.trim()).replace(/[*_`]/g, ""),
      kind: "string",
      line: i + 1,
      column: 1,
      endLine: i + 1,
      children: [],
      depth,
    });
  });
  return nest(flat, lines.length, (s) => s.depth);
}

/** Top-level and second-level keys (the shape of most config files). */
function yamlSymbols(lines: string[]): FoundSymbol[] {
  const flat: (FoundSymbol & { indent: number })[] = [];
  let firstIndent: number | null = null;
  lines.forEach((line, i) => {
    const m = /^(\s*)(?:-\s+)?([\w.$/"'-][^:#]*?)\s*:(?:\s|$)/.exec(line);
    if (!m || /^\s*#/.test(line)) return;
    const indent = (m[1] as string).length;
    if (indent > 0 && firstIndent === null) firstIndent = indent;
    // Only the first two levels: deeper keys make the outline noisy.
    if (indent > (firstIndent ?? 2)) return;
    flat.push({
      name: (m[2] as string).replace(/^["']|["']$/g, ""),
      kind: "key",
      line: i + 1,
      column: indent + 1,
      endLine: i + 1,
      children: [],
      indent,
    });
  });
  return nest(flat, lines.length, (s) => s.indent);
}
