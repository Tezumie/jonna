// find_files' glob patterns (D307, after Claude Code's Glob): a query with glob characters
// matches paths (`**/*.ts`, `src/*.{js,ts}`); one without is a fuzzy name as before. A pattern
// without `/` matches a name at any depth, as the search tool's glob does. DOM-free.
import { globToRegExp } from "../paths/glob";

/** Files find_files returns by default, and at most. */
export const FIND_DEFAULT_LIMIT = 100;
export const FIND_MAX_LIMIT = 1000;

/** Whether `query` is a glob rather than a fuzzy name. */
export function isGlob(query: string): boolean {
  return /[*?[\]{}]/.test(query);
}

/**
 * A test for workspace-relative paths (`/` separators) against `pattern`, inside folder `base`
 * (relative; "" for the root): the pattern is relative to it.
 */
export function globMatcher(pattern: string, base = ""): (rel: string) => boolean {
  const clean = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  const anyDepth = !clean.includes("/") && !clean.startsWith("**");
  const dir = base
    .replace(/\\/g, "/")
    .replace(/^\.\/?/, "")
    .replace(/\/+$/, "");
  const re = fileOnly(globToRegExp(anyDepth ? `**/${clean}` : clean));
  return (rel) => {
    let p = rel.replace(/\\/g, "/");
    if (dir) {
      if (!p.startsWith(`${dir}/`)) return false;
      p = p.slice(dir.length + 1);
    }
    return re.test(p);
  };
}

/**
 * globToRegExp also matches everything inside a matching folder (an exclude's meaning); a file
 * pattern matches the path itself (`src/*` doesn't take `src/a/b.ts`).
 */
function fileOnly(re: RegExp): RegExp {
  const source = re.source.replace(/\(\?:\\?\/\.\*\)\?\$$/, "$");
  try {
    return new RegExp(source);
  } catch {
    return re;
  }
}

/** Paths newest first (files without a time last, then by path), for Glob's order. */
export function byNewest(files: readonly { rel: string; mtime: number | null }[]): string[] {
  return [...files]
    .sort(
      (a, b) => (b.mtime ?? -1) - (a.mtime ?? -1) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0),
    )
    .map((f) => f.rel);
}
