// VS Code-style glob patterns (files.exclude, search.exclude, tasks): `**` any folders, `*` any
// characters but `/`, `?` one character, `{a,b}` alternatives, `[abc]` character classes. Paths
// are workspace-relative with `/`. DOM-free, tested.

const cache = new Map<string, RegExp>();
/** Patterns can come from a model (search, tools): the cache starts over past this many. */
const CACHE_LIMIT = 500;
/** What a pattern that still isn't a valid RegExp compiles to: it excludes nothing, rather than
 * throwing and taking the whole explorer listing down with it. */
const MATCH_NOTHING = /(?!)/;

/**
 * Indexes of the `{` and `}` that pair up (nesting allowed), skipping `[...]` classes the same way
 * the compiler does. An unclosed `{` or stray `}` isn't in the set and is matched literally.
 */
function pairedBraces(p: string): Set<number> {
  const paired = new Set<number>();
  const open: number[] = [];
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "[") {
      const close = p.indexOf("]", i);
      if (close > i) i = close;
    } else if (c === "{") open.push(i);
    else if (c === "}") {
      const at = open.pop();
      if (at === undefined) continue;
      paired.add(at);
      paired.add(i);
    }
  }
  return paired;
}

export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;
  let re = "";
  let i = 0;
  // Nesting depth of paired `{…}` groups; `,` separates alternatives only inside one.
  let depth = 0;
  const p = pattern
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    // `**/**/` is `**/` (and a trailing `**/**` is `**`): repeated, each compiles to a nested
    // star that backtracks exponentially on a long path that doesn't match.
    .replace(/(?:\*\*\/){2,}/g, "**/")
    .replace(/\*\*(?:\/\*\*)+$/, "**");
  const paired = pairedBraces(p);
  while (i < p.length) {
    const c = p[i] ?? "";
    if (c === "*") {
      if (p[i + 1] === "*") {
        // `**/` = zero or more folders; a trailing `**` = anything.
        const slash = p[i + 2] === "/";
        re += slash ? "(?:[^/]*/)*" : ".*";
        i += slash ? 3 : 2;
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{" && paired.has(i)) {
      depth++;
      re += "(?:";
    } else if (c === "}" && paired.has(i)) {
      depth--;
      re += ")";
    } else if (c === "," && depth > 0) re += "|";
    else if (c === "[") {
      const close = p.indexOf("]", i);
      if (close > i) {
        re += `[${p
          .slice(i + 1, close)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\")}]`;
        i = close + 1;
        continue;
      }
      re += "\\[";
    } else re += c.replace(/[.+^$()|\\{}]/g, "\\$&");
    i++;
  }
  // A pattern also matches everything inside a matched folder.
  let out: RegExp;
  try {
    out = new RegExp(`^${re}(?:/.*)?$`);
  } catch {
    out = MATCH_NOTHING; // e.g. a reversed class range like `[z-a]`
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(pattern, out);
  return out;
}

/** True if a workspace-relative path is excluded by `patterns` (VS Code's `{ glob: true }` map). */
export function isExcluded(relative: string, patterns: Readonly<Record<string, unknown>>): boolean {
  const path = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  for (const [glob, on] of Object.entries(patterns)) {
    if (on !== true) continue;
    if (globToRegExp(glob).test(path)) return true;
  }
  return false;
}
