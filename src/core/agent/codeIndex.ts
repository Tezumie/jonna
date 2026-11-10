// The codebase index (D227, Cursor's codebase_search): the folder's source files cut into chunks,
// each embedded by the user's embedding model and kept as an int8 vector; a question is embedded
// the same way and the closest chunks come back. Next to the repo map and literal search, it finds
// code by meaning ("where do we retry failed uploads?"). DOM-free.

/** Files worth indexing: source and docs by extension. */
const SOURCE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|rb|php|scala|lua|dart|ex|exs|erl|clj|hs|ml|fs|vue|svelte|astro|sql|sh|bash|ps1|md|mdx|rst|toml|ya?ml|gradle|zig|nim|r|jl|pl|css|scss|less|html)$/i;
const SKIP_DIRS =
  /(^|\/)(node_modules|\.git|dist|build|out|target|vendor|\.next|\.nuxt|coverage|__pycache__|\.venv|venv|\.cache|bin|obj|\.idea|\.vscode)\//;
const SKIP_FILES =
  /(\.min\.(js|css)$|\.map$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock)$)/i;

/** The most bytes a file may have to be indexed (bigger ones are generated or data). */
export const MAX_FILE_BYTES = 256 * 1024;

/** Whether a folder-relative path (`/` separated) is indexed. */
export function indexable(rel: string): boolean {
  return SOURCE_EXT.test(rel) && !SKIP_DIRS.test(`${rel}`) && !SKIP_FILES.test(rel);
}

export interface Chunk {
  /** 1-based lines, inclusive. */
  start: number;
  end: number;
  text: string;
}

const CHUNK_LINES = 60;
const OVERLAP = 10;
const MAX_CHUNK_CHARS = 4000;

/**
 * Overlapping windows of about 60 lines, ending at a blank line when one is near (a function's
 * end), each cut to 4000 characters. Blank-only windows are skipped.
 */
export function chunkText(text: string): Chunk[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Chunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = Math.min(lines.length, start + CHUNK_LINES);
    // Prefer to stop after a blank line in the last 15 lines of the window.
    if (end < lines.length)
      for (let i = end - 1; i > end - 15 && i > start + 20; i--)
        if (!lines[i]?.trim()) {
          end = i + 1;
          break;
        }
    const body = lines.slice(start, end).join("\n");
    if (body.trim()) out.push({ start: start + 1, end, text: body.slice(0, MAX_CHUNK_CHARS) });
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - OVERLAP);
  }
  return out;
}

/** What's embedded for a chunk: its path first, so names in the path count too. */
export const embedText = (rel: string, chunk: Chunk): string =>
  `${rel}:${chunk.start}-${chunk.end}\n${chunk.text}`;

/** A cheap content hash (FNV-1a, 32 bits): a file is embedded again only when it changed. */
export function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length.toString(36)}.${(h >>> 0).toString(36)}`;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** A vector, normalized, as int8 (−127…127) in base64: a quarter of float32's size. */
export function quantize(vector: readonly number[]): string {
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  let max = 0;
  for (const v of vector) max = Math.max(max, Math.abs(v / norm));
  const scale = max ? 127 / max : 1;
  const bytes = vector.map((v) => Math.round((v / norm) * scale) & 0xff);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

/** quantize's text back as a unit vector. */
export function dequantize(text: string): Float32Array {
  const clean = text.replace(/=+$/, "");
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i] ?? "A") << 18) |
      (B64.indexOf(clean[i + 1] ?? "A") << 12) |
      (B64.indexOf(clean[i + 2] ?? "A") << 6) |
      B64.indexOf(clean[i + 3] ?? "A");
    bytes.push((n >> 16) & 0xff);
    if (i + 2 < clean.length) bytes.push((n >> 8) & 0xff);
    if (i + 3 < clean.length) bytes.push(n & 0xff);
  }
  const v = new Float32Array(bytes.length);
  let norm = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    const x = b > 127 ? b - 256 : b;
    v[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

/** The stored index: per file, its hash and chunks (lines and vector). */
export interface StoredIndex {
  version: 1;
  model: string;
  root: string;
  files: Record<string, { hash: string; chunks: { start: number; end: number; v: string }[] }>;
}

export interface SearchHit {
  path: string;
  start: number;
  end: number;
  score: number;
}

/** The `limit` chunks closest to `query` (a unit vector), at most `perFile` from one file. */
export function searchIndex(
  index: StoredIndex,
  vectors: ReadonlyMap<string, Float32Array>,
  query: Float32Array,
  limit = 10,
  perFile = 3,
): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const [path, file] of Object.entries(index.files))
    for (const c of file.chunks) {
      const v = vectors.get(c.v) ?? dequantize(c.v);
      let dot = 0;
      for (let i = 0; i < Math.min(v.length, query.length); i++)
        dot += (v[i] ?? 0) * (query[i] ?? 0);
      hits.push({ path, start: c.start, end: c.end, score: dot });
    }
  hits.sort((a, b) => b.score - a.score);
  const per = new Map<string, number>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    const n = per.get(h.path) ?? 0;
    if (n >= perFile) continue;
    per.set(h.path, n + 1);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

/** What changed since the stored index: files to (re)embed and files gone. */
export function planUpdate(
  index: StoredIndex | null,
  current: ReadonlyMap<string, string>,
): { embed: string[]; drop: string[] } {
  const files = index?.files ?? {};
  return {
    embed: [...current].filter(([p, hash]) => files[p]?.hash !== hash).map(([p]) => p),
    drop: Object.keys(files).filter((p) => !current.has(p)),
  };
}
