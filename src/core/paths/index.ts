// Path helpers for absolute OS paths coming from Rust (either separator). DOM-free.
// Windows paths (drive letters "C:\\x", UNC "\\\\server\\share\\x") compare case-insensitively
// and treat "/" and "\\" alike; POSIX paths compare exactly.

/** True for "C:\\x", "C:/x" and UNC "\\\\server\\share". */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:([\\/]|$)/.test(path) || path.startsWith("\\\\");
}

function separatorOf(path: string): "/" | "\\" {
  if (isWindowsPath(path)) return "\\";
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** Length of the root that must never be trimmed: "C:\\", "\\\\server\\share", "/". */
function rootLength(path: string): number {
  const drive = /^[A-Za-z]:[\\/]?/.exec(path);
  if (drive) return drive[0].length;
  const unc = /^\\\\[^\\/]+[\\/][^\\/]+/.exec(path);
  if (unc) return unc[0].length;
  return path.startsWith("/") ? 1 : 0;
}

function trimTrailing(path: string): string {
  let p = path;
  while (p.length > rootLength(p) && /[\\/]$/.test(p)) p = p.slice(0, -1);
  return p;
}

/**
 * Comparison key: Windows paths lowercased with "\\" separators and no trailing separator;
 * POSIX paths unchanged. Use for maps and equality, never for display.
 */
export function pathKey(path: string): string {
  if (!isWindowsPath(path)) return trimTrailing(path);
  return trimTrailing(path.replaceAll("/", "\\")).toLowerCase();
}

/**
 * A drive letter in capitals, as Rust and the workspace write it: Monaco's `Uri.fsPath` gives
 * `c:\x` for `C:\x`, which breaks lookups keyed by the exact path.
 */
export function upperDrive(path: string): string {
  return /^[a-z]:/.test(path) ? `${path[0]?.toUpperCase()}${path.slice(1)}` : path;
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** Last segment: "/a/b.ts" → "b.ts". */
export function basename(path: string): string {
  const p = trimTrailing(path);
  if (p.length <= rootLength(p) && isWindowsPath(p)) return p;
  return p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
}

/** Parent directory: "/a/b.ts" → "/a"; "C:\\x" → "C:\\"; "\\\\srv\\share\\x" → "\\\\srv\\share". */
export function dirname(path: string): string {
  const p = trimTrailing(path);
  const root = rootLength(p);
  if (p.length <= root) return p;
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (i < 0) return p;
  if (i < root) return p.slice(0, root);
  if (i === 0) return p.charAt(0);
  return p.slice(0, i);
}

/** Joins a child name onto a directory using the directory's separator style. */
export function joinPath(dir: string, name: string): string {
  const d = trimTrailing(dir);
  const sep = separatorOf(d);
  return /[\\/]$/.test(d) ? `${d}${name}` : `${d}${sep}${name}`;
}

/** True if `path` is `root` or inside it (case-insensitive for Windows paths). */
export function isWithin(root: string, path: string): boolean {
  const r = pathKey(root);
  // "root/../x" is outside: judge the path its ".." segments name (resolveInRoot collapses them).
  const named =
    isAbsolute(path) && /(^|[\\/])\.\.([\\/]|$)/.test(path) ? resolveInRoot(root, path) : path;
  const p = pathKey(named);
  if (p === r) return true;
  const sep = isWindowsPath(root) ? "\\" : "/";
  return p.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

/** Path relative to `root` with "/" separators ("" for root itself); the input if outside. */
export function relativePath(root: string, path: string): string {
  if (!isWithin(root, path)) return path;
  return path
    .slice(trimTrailing(root).length)
    .replace(/^[\\/]/, "")
    .replaceAll("\\", "/");
}

/** Like relativePath, but with the OS's separator (for labels and tooltips). */
export function displayPath(root: string, path: string): string {
  const rel = relativePath(root, path);
  return isWindowsPath(root) || isWindowsPath(path) ? rel.replaceAll("/", "\\") : rel;
}

/** True for "/x", "C:\\x", "C:/x" and UNC "\\\\server\\share". */
export function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** Resolves a path given by a user or agent: absolute as-is, otherwise relative to `root`. */
export function resolveInRoot(root: string, path: string): string {
  if (isAbsolute(path)) {
    // "C:/x/y" from an agent becomes "C:\\x\\y"; "." and ".." are collapsed (so "root\\..\\x"
    // is judged as the path it is), and inside the root it's spelled with the root's own case
    // ("c:/PROJ/a" in "C:\\proj" → "C:\\proj\\a"): one file, one key (D161).
    const win = isWindowsPath(path);
    const sep = win ? "\\" : "/";
    const flat = win ? path.replaceAll("/", "\\") : path;
    const head = flat.slice(0, rootLength(flat));
    const parts: string[] = [];
    for (const part of flat.slice(head.length).split(/[\\/]+/)) {
      if (part === "" || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    const glue = parts.length && head && !/[\\/]$/.test(head) ? sep : "";
    const full = `${head}${glue}${parts.join(sep)}`;
    const r = trimTrailing(root);
    if (win && isWithin(r, full)) return `${r}${full.slice(r.length)}`;
    return full;
  }
  const sep = separatorOf(trimTrailing(root));
  const parts = path.split(/[\\/]+/).filter((p) => p !== "" && p !== ".");
  // ".." steps up (so "../x" is the real sibling path, which isWithin then judges correctly).
  return parts
    .reduce((dir, part) => (part === ".." ? dirname(dir) : joinPath(dir, part)), root)
    .replaceAll(sep === "\\" ? "/" : "\\", sep);
}

/** Re-roots `path` from `from` to `to` (rename of a file or one of its parent folders). */
export function rebase(from: string, to: string, path: string): string {
  if (!isWithin(from, path)) return path;
  const rest = path.slice(trimTrailing(from).length);
  return `${trimTrailing(to)}${rest}`;
}
