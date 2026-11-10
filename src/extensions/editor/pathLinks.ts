// File paths in text (D117): `./src/app.ts`, `docs/notes.md:12`, `"../assets/logo.png"`,
// `C:\work\a.ts(3,5)`. Ctrl+click opens them, like VS Code's links to files in text. This part
// finds candidates in a line; the editor checks they exist before underlining them. DOM-free.

export interface PathCandidate {
  /** As written (without the line/column suffix). */
  path: string;
  line?: number;
  column?: number;
  /** 0-based offsets in the line of the whole match (path and suffix). */
  start: number;
  end: number;
}

// A path: optional drive or ./ ../ ~/ /, then segments separated by / or \, ending in a name with
// an extension (so plain words and module names like "react" or "./util" aren't links). Then an
// optional :line[:col] or (line[,col]).
const PATH =
  /(?<![\w/\\.:@-])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|[\\/])?(?:[\w@.+-]+[\\/])*[\w@+-][\w@.+-]*\.[A-Za-z][\w]{0,9})(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))?(?![\w/\\])/g;

/** Extensions that look like files but are usually something else in prose and code. */
const NOT_FILES = /\.(?:com|org|net|io|dev|app|ai|co|uk|de|exe)$/i;

export function findPathCandidates(text: string, limit = 50): PathCandidate[] {
  const out: PathCandidate[] = [];
  for (const m of text.matchAll(PATH)) {
    if (out.length >= limit) break;
    const path = m[1] ?? "";
    const start = m.index ?? 0;
    // URLs are links already (the editor's own link detector), and version numbers / domains
    // aren't files.
    const before = text.slice(Math.max(0, start - 3), start);
    if (before.endsWith("//") || /^\d+(\.\d+)+$/.test(path) || NOT_FILES.test(path)) continue;
    // A bare "name.ext" needs a separator somewhere or a known file extension to count.
    if (
      !/[\\/]/.test(path) &&
      !/\.(?:[jt]sx?|mjs|cjs|json|jsonc|md|css|scss|less|html?|vue|svelte|py|rs|go|rb|php|java|kt|cs|cpp|cc|c|h|hpp|swift|lua|sh|ps1|ya?ml|toml|ini|txt|sql|xml|svg|png|jpe?g|gif|webp|lock|env)$/i.test(
        path,
      )
    )
      continue;
    const line = Number(m[2] ?? m[4]) || undefined;
    const column = Number(m[3] ?? m[5]) || undefined;
    out.push({
      path,
      ...(line && { line }),
      ...(column && { column }),
      start,
      end: start + m[0].length,
    });
  }
  return out;
}

/**
 * Absolute paths `candidate` may mean, most likely first: relative to the file's folder, then to
 * the workspace root. Absolute and home paths are taken as they are (home is resolved by the
 * caller, which knows it).
 */
export function resolveCandidate(
  candidate: string,
  fileDir: string,
  root: string | null,
): string[] {
  const sep = fileDir.includes("\\") && !fileDir.includes("/") ? "\\" : "/";
  const p = candidate.replace(/[\\/]/g, sep);
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\")) return [p];
  const join = (dir: string, rel: string) =>
    normalize(`${dir.replace(/[\\/]+$/, "")}${sep}${rel}`, sep);
  const out = [join(fileDir, p)];
  if (root && !p.startsWith(".")) out.push(join(root, p));
  return [...new Set(out)];
}

function normalize(path: string, sep: string): string {
  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? "";
  const lead = path.slice(drive.length).startsWith(sep) ? sep : "";
  const parts: string[] = [];
  for (const part of path.slice(drive.length).split(sep)) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${drive}${lead}${parts.join(sep)}`;
}
