// "Apply" on a code block in a chat answer (D122, like Cursor's): where the block's text goes in
// its file, without asking a model. DOM-free.
// - A fence that names a file: ```ts:src/a.ts, ```ts src/a.ts, ```ts title="src/a.ts", ```src/a.ts
// - The block replaces the whole file when it is new, or when the block is most of the file;
//   otherwise it replaces the lines between the block's first and last lines, found once each
//   in the file (ignoring indentation). Anything else isn't applied (null).

const LANG_ONLY = /^[\w+#-]+$/;

/** The file a fence's info string names, or null. */
export function fencePath(info: string): string | null {
  const text = info.trim();
  if (!text) return null;
  const titled = /(?:title|file|filename|path)=["']?([^"'\s]+)["']?/.exec(text);
  if (titled?.[1]) return clean(titled[1]);
  const colon = /^[\w+#-]+:(\S+)$/.exec(text);
  if (colon?.[1]) return clean(colon[1]);
  const words = text.split(/\s+/);
  const candidate = words.length > 1 ? words[1] : words[0];
  if (!candidate || (words.length === 1 && LANG_ONLY.test(candidate))) return null;
  return clean(candidate);
}

function clean(path: string): string | null {
  const p = path.replace(/^["'`]|["'`]$/g, "");
  // A path: has a folder or an extension, no URL scheme, nothing odd.
  if (/^[a-z]+:\/\//i.test(p) || /[<>|*?]/.test(p)) return null;
  return /[\\/]/.test(p) || /\.\w{1,10}$/.test(p) ? p : null;
}

export interface ApplyResult {
  text: string;
  /** "file": the whole file; "range": lines `from`–`to` (1-based) of the original. */
  how: "file" | "range";
  from?: number;
  to?: number;
}

export function applySnippet(original: string | null, snippet: string): ApplyResult | null {
  const block = snippet.replace(/\n$/, "");
  if (original === null || !original.trim()) return { text: `${block}\n`, how: "file" };
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const trailing = lines[lines.length - 1] === "";
  if (trailing) lines.pop();
  const bl = block.split(/\r?\n/);
  if (bl.length >= lines.length * 0.6)
    return { text: bl.join(eol) + (trailing ? eol : ""), how: "file" };
  const nonEmpty = bl.map((l, i) => [l.trim(), i] as const).filter(([t]) => t.length > 0);
  const first = nonEmpty[0];
  const last = nonEmpty[nonEmpty.length - 1];
  if (!first || !last || first === last) return null;
  const firstHits = lines.flatMap((l, i) => (l.trim() === first[0] ? [i] : []));
  if (firstHits.length !== 1) return null;
  const start = firstHits[0] as number;
  const end = lines.findIndex((l, i) => i > start && l.trim() === last[0]);
  // The range shouldn't be much longer than the block (it would swallow unrelated code).
  if (end < 0 || end - start + 1 > Math.max(bl.length * 3, bl.length + 20)) return null;
  const replacement = bl.slice(first[1], last[1] + 1);
  const next = [...lines.slice(0, start), ...replacement, ...lines.slice(end + 1)];
  return {
    text: next.join(eol) + (trailing ? eol : ""),
    how: "range",
    from: start + 1,
    to: end + 1,
  };
}
