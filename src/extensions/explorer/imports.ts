// Updating imports when files move (D141), like VS Code's "Update imports for 'x.ts'?": after a
// rename or move, relative import specifiers that pointed at a moved file (or into a moved
// folder) are rewritten to the new place, and the moved files' own relative imports are fixed
// for their new folder. Keeps each specifier's style: no extension, an explicit extension, the
// `.js` that TypeScript ESM writes for a `.ts` file, or a folder's `index`. DOM-free and tested;
// paths here use `/` (callers convert).
//
// Handled forms: `import … from "…"`, `export … from "…"`, `import "…"`, `import("…")`,
// `require("…")`, `jest.mock` / `vi.mock("…")`. Not handled: path aliases (tsconfig `paths`),
// bare package names, template strings.

export const CODE_EXTENSIONS = [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "vue",
  "svelte",
  "astro",
];

/** Tried in this order when a specifier has no extension. */
const RESOLVE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".d.ts",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".vue",
  ".svelte",
];
const JS_FOR_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

const SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\b(?:jest|vi)\.mock\s*\(\s*)(["'])(\.\.?(?:\/[^"'\n\r]*)?)\2/g;

export interface Move {
  from: string;
  to: string;
}

type Style = "exact" | "noExt" | "jsForTs" | "dirIndex";

export function isCodeFile(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return path.includes(".") && CODE_EXTENSIONS.includes(ext);
}

/** "/a/b/../c/./d" → "/a/c/d". */
export function normalize(path: string): string {
  const drive = /^[a-zA-Z]:/.exec(path)?.[0] ?? "";
  const rest = path.slice(drive.length);
  const out: string[] = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `${drive}/${out.join("/")}`;
}

const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

/** The specifier from folder `fromDir` to `to` ("./x", "../a/b"). */
export function relativeSpecifier(fromDir: string, to: string): string {
  const a = normalize(fromDir).split("/").filter(Boolean);
  const b = normalize(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const up = a.length - i;
  const rest = b.slice(i).join("/");
  if (up === 0) return rest ? `./${rest}` : ".";
  return `${"../".repeat(up)}${rest}`.replace(/\/$/, "");
}

/** Where a path is after the moves (unchanged when none applies). */
export function movedPath(path: string, moves: readonly Move[], same = defaultSame): string {
  for (const m of moves) {
    if (same(path, m.from)) return m.to;
    if (startsWithDir(path, m.from, same)) return m.to + path.slice(m.from.length);
  }
  return path;
}

/** Where a path was before the moves. */
export function originalPath(path: string, moves: readonly Move[], same = defaultSame): string {
  return movedPath(
    path,
    moves.map((m) => ({ from: m.to, to: m.from })),
    same,
  );
}

function defaultSame(a: string, b: string): boolean {
  return a === b;
}

function startsWithDir(
  path: string,
  dir: string,
  same: (a: string, b: string) => boolean,
): boolean {
  return (
    path.length > dir.length && path[dir.length] === "/" && same(path.slice(0, dir.length), dir)
  );
}

/** What a specifier points at, given which files existed. */
export async function resolveSpecifier(
  spec: string,
  fromDir: string,
  exists: (path: string) => Promise<boolean>,
): Promise<{ target: string; style: Style; jsExt?: string } | null> {
  const base = normalize(`${fromDir}/${spec}`);
  const ext = /\.[a-z]+$/i.exec(spec)?.[0]?.toLowerCase();
  if (ext && (await exists(base))) return { target: base, style: "exact" };
  if (ext && JS_FOR_TS[ext])
    for (const tsExt of JS_FOR_TS[ext] ?? []) {
      const ts = base.slice(0, -ext.length) + tsExt;
      if (await exists(ts)) return { target: ts, style: "jsForTs", jsExt: ext };
    }
  for (const e of RESOLVE_EXTENSIONS)
    if (await exists(base + e)) return { target: base + e, style: "noExt" };
  for (const e of RESOLVE_EXTENSIONS)
    if (await exists(`${base}/index${e}`))
      return { target: `${base}/index${e}`, style: "dirIndex" };
  return null;
}

function specifierFor(
  fromDir: string,
  target: string,
  style: Style,
  jsExt: string | undefined,
): string {
  const stripExt = (p: string) => p.replace(/(\.d)?\.[a-z]+$/i, "");
  switch (style) {
    case "exact":
      return relativeSpecifier(fromDir, target);
    case "jsForTs":
      return relativeSpecifier(fromDir, stripExt(target)) + (jsExt ?? ".js");
    case "noExt":
      return relativeSpecifier(fromDir, stripExt(target));
    case "dirIndex":
      // Still an index file after the move: name its folder; otherwise the file itself.
      return /\/index\.[a-z.]+$/i.test(target)
        ? relativeSpecifier(fromDir, dirOf(target))
        : relativeSpecifier(fromDir, stripExt(target));
  }
}

/**
 * The text of file `path` (where it is now) with its relative imports updated for `moves`, or
 * null when nothing changes. `existedBefore` answers for paths as they were before the moves.
 */
export async function rewriteImports(
  text: string,
  path: string,
  moves: readonly Move[],
  existedBefore: (path: string) => Promise<boolean>,
  same = defaultSame,
): Promise<{ text: string; count: number } | null> {
  const oldPath = originalPath(path, moves, same);
  const oldDir = dirOf(oldPath);
  const newDir = dirOf(path);
  const replacements: { start: number; end: number; spec: string }[] = [];
  for (const m of text.matchAll(SPECIFIER)) {
    const spec = m[3] ?? "";
    // Commented-out code isn't an import: a line comment before it on its line, or a line of
    // a block comment.
    const lineStart = text.lastIndexOf("\n", m.index ?? 0) + 1;
    const before = text.slice(lineStart, m.index ?? 0);
    if (/^\s*(\*|\/\*)/.test(before) || before.includes("//")) continue;
    const resolved = await resolveSpecifier(spec, oldDir, existedBefore);
    if (!resolved) continue;
    const newTarget = movedPath(resolved.target, moves, same);
    if (newTarget === resolved.target && newDir === oldDir) continue;
    const next = specifierFor(newDir, newTarget, resolved.style, resolved.jsExt);
    if (next === spec) continue;
    const start = (m.index ?? 0) + (m[1]?.length ?? 0) + 1;
    replacements.push({ start, end: start + spec.length, spec: next });
  }
  if (!replacements.length) return null;
  let out = text;
  for (const r of replacements.reverse()) out = out.slice(0, r.start) + r.spec + out.slice(r.end);
  return { text: out, count: replacements.length };
}
