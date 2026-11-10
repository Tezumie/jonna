// Search/replace edits for the agent's edit_file tool. Exact matches first; if an `old` string isn't
// found verbatim, a whitespace-tolerant line match is tried (models often get indentation or
// trailing spaces slightly wrong). Ambiguous or missing matches fail with a message the model can
// act on. Line endings follow the file. DOM-free.

export interface Edit {
  old: string;
  new: string;
  /** Replace every occurrence (default: exactly one must exist). */
  all?: boolean;
}

export type EditResult =
  | {
      ok: true;
      text: string;
      replacements: number;
      /** Lines (1-based) where an old_string only matched approximately (D163). */
      approximate?: number[];
    }
  | {
      ok: false;
      error: string;
      notFound?: boolean;
      /** Which of the edits failed (0-based). */
      index?: number;
    };

function eolOf(text: string): "\r\n" | "\n" {
  const crlf = text.indexOf("\r\n");
  const lf = text.indexOf("\n");
  return crlf >= 0 && crlf === lf - 1 ? "\r\n" : "\n";
}

/**
 * `text` with the line endings of the file it replaces (write_file): models write `\n`, and a
 * whole CRLF file (Windows) turned into LF showed every line as changed. A new file, or text that
 * has its own CRLFs, is kept as given.
 */
export function withLineEndingsOf(current: string | null, text: string): string {
  if (!current || text.includes("\r\n") || eolOf(current) === "\n") return text;
  return text.replace(/\r?\n/g, "\r\n");
}

function count(hay: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

type Norm = (line: string) => string;
/** Tier 2: ignore leading/trailing whitespace. Tier 3: also collapse inner whitespace runs. */
const TRIM: Norm = (l) => l.trim();
const LOOSE: Norm = (l) =>
  l
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*([(){}[\];,:=<>+])\s*/g, "$1");

/**
 * Finds `old` line by line under `norm`; returns [start, end) offsets. With `skipBlank`, blank
 * lines on either side don't count (models often add or drop empty lines).
 */
function fuzzyFind(text: string, old: string, norm: Norm, skipBlank = false): [number, number][] {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  let want = old.replace(/\r\n/g, "\n").split("\n").map(norm);
  if (skipBlank) want = want.filter((l) => l !== "");
  while (want.length && want[0] === "") want.shift();
  while (want.length && want[want.length - 1] === "") want.pop();
  if (want.length === 0) return [];
  const starts: number[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    starts.push(offset);
    offset += line.length + 1;
  }
  // Candidate lines (indexes into `lines`) after normalising and, maybe, dropping blank ones.
  const idx: number[] = [];
  const have: string[] = [];
  for (const [i, line] of lines.entries()) {
    const n = norm(line);
    if (skipBlank && n === "") continue;
    idx.push(i);
    have.push(n);
  }
  const hits: [number, number][] = [];
  for (let i = 0; i + want.length <= have.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length && ok; j++) ok = have[i + j] === want[j];
    if (!ok) continue;
    const first = idx[i] ?? 0;
    const last = idx[i + want.length - 1] ?? 0;
    hits.push([starts[first] ?? 0, (starts[last] ?? 0) + (lines[last] ?? "").length]);
  }
  return hits;
}

/**
 * The part of `text` most like `old` (by shared normalised lines), with a few lines around it —
 * for "not found" errors, so the model can copy the real lines instead of guessing again.
 */
export function nearestRegion(text: string, old: string, context = 4): string | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const want = new Set(
    old
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map(LOOSE)
      .filter((l) => l.length > 2),
  );
  if (want.size === 0) return null;
  const span = Math.max(1, old.split("\n").length);
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!want.has(LOOSE(lines[i] ?? ""))) continue; // windows start on a matching line
    let score = 0;
    for (let j = i; j < Math.min(lines.length, i + span); j++)
      if (want.has(LOOSE(lines[j] ?? ""))) score++;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0) return null;
  return lines.slice(Math.max(0, best - context), best + span + context).join("\n");
}

/** Re-indents `replacement` by the difference between the matched text's and `old`'s indentation. */
function reindent(matched: string, old: string, replacement: string): string {
  const indent = (s: string) =>
    /^[ \t]*/.exec(s.split("\n").find((l) => l.trim()) ?? "")?.[0] ?? "";
  const have = indent(matched);
  const was = indent(old);
  if (have === was) return replacement;
  return replacement
    .split("\n")
    .map((l) => (l.startsWith(was) ? have + l.slice(was.length) : l))
    .join("\n");
}

const LINE_PREFIX = /^\s*\d+\| ?/;

/**
 * Undoes what models copy by mistake: read_file's "   12| " line-number prefixes (on every
 * non-empty line of `old`), and "\\n" written as two characters when there is no real newline.
 */
export function cleanEdit(edit: Edit): Edit {
  let { old, new: replacement } = edit;
  if (!old.includes("\n") && old.includes("\\n")) {
    const unescaped = (t: string) => t.replace(/\\r\\n|\\n/g, "\n").replace(/\\t/g, "\t");
    old = unescaped(old);
    replacement = unescaped(replacement);
  }
  const lines = old.split("\n").filter((l) => l.trim() !== "");
  if (lines.length > 0 && lines.every((l) => LINE_PREFIX.test(l))) {
    const strip = (t: string) =>
      t
        .split("\n")
        .map((l) => l.replace(LINE_PREFIX, ""))
        .join("\n");
    old = strip(old);
    if (replacement.split("\n").every((l) => l.trim() === "" || LINE_PREFIX.test(l)))
      replacement = strip(replacement);
  }
  return { ...edit, old, new: replacement };
}

const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/**
 * Other readings of an edit that models get wrong in transit: line-number prefixes and literal
 * "\\n" (cleanEdit), backslash-escaped quotes (\\' \\"), HTML entities (&lt;div&gt; for an HTML
 * file) and typographic quotes. Each applies to old and new alike.
 */
function variants(edit: Edit): Edit[] {
  const out: Edit[] = [edit];
  const map = (f: (t: string) => string): Edit => ({ ...edit, old: f(edit.old), new: f(edit.new) });
  out.push(cleanEdit(edit));
  if (/\\["'\\`]/.test(edit.old)) out.push(map((t) => t.replace(/\\(["'\\`])/g, "$1")));
  if (/&(lt|gt|amp|quot|#39|apos);/.test(edit.old))
    out.push(map((t) => t.replace(/&(lt|gt|amp|quot|#39|apos);/g, (e) => ENTITIES[e] ?? e)));
  if (/[\u2018\u2019\u201C\u201D]/.test(edit.old))
    out.push(map((t) => t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')));
  return out.filter((v, i) => v.old !== "" && out.findIndex((w) => w.old === v.old) === i);
}

/**
 * Levenshtein similarity in [0, 1] (1 = equal), computed only as far as it can still reach
 * `minScore`: the edit distance is banded (Ukkonen) to the most edits that score allows, so a
 * 1500-char block costs O(n·band) instead of O(n²). Anything below `minScore` returns 0 — callers
 * only rank blocks that could pass. Strings are capped to keep it cheap.
 */
function similarity(a: string, b: string, minScore = 0): number {
  if (a === b) return 1;
  const x = a.slice(0, 1500);
  const y = b.slice(0, 1500);
  if (!x.length || !y.length) return 0;
  const longest = Math.max(x.length, y.length);
  const band = Math.floor((1 - minScore) * longest);
  // The distance is at least the length difference; skip the matrix when that alone fails.
  if (Math.abs(x.length - y.length) > band) return 0;
  const far = longest + 1; // "outside the band": larger than any real distance
  let prev = new Int32Array(y.length + 1);
  let cur = new Int32Array(y.length + 1);
  for (let j = 0; j <= y.length; j++) prev[j] = j <= band ? j : far;
  for (let i = 1; i <= x.length; i++) {
    const from = Math.max(1, i - band);
    const to = Math.min(y.length, i + band);
    cur.fill(far);
    cur[0] = i <= band ? i : far;
    let rowMin = cur[0] ?? far;
    for (let j = from; j <= to; j++) {
      const v = Math.min(
        (prev[j] ?? far) + 1,
        (cur[j - 1] ?? far) + 1,
        (prev[j - 1] ?? far) + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > band) return 0; // every path already needs more edits than allowed
    [prev, cur] = [cur, prev];
  }
  const distance = prev[y.length] ?? far;
  if (distance > band) return 0;
  return 1 - distance / longest;
}

/** Lines shorter than this ("}", "});", "end") are in nearly every block, so they don't count
 * as evidence that a block is the one meant. */
const DISTINCTIVE = 6;
/** Most blocks given the (comparatively costly) similarity score, best line overlap first. */
const MAX_SCORED = 50;
/** Minimum similarity for a near match; a runner-up within 0.04 of it makes the match ambiguous. */
const NEAR_MIN = 0.9;
const NEAR_MARGIN = 0.04;

/**
 * Last resort (Aider / Cline style): the block of the same number of lines most similar to `old`,
 * if it is ≥ 90% similar and clearly better than any other block. Returns [start, end) offsets.
 * Candidates must share a distinctive line with `old` in the same position; only the blocks with
 * the most such lines are scored, so a big file can't stall the main thread.
 */
function nearMatch(text: string, old: string): [number, number] | null {
  const want = old.replace(/\r\n/g, "\n").split("\n").map(LOOSE);
  while (want.length && want[want.length - 1] === "") want.pop();
  while (want.length && want[0] === "") want.shift();
  if (want.length === 0 || want.join("").length < 12) return null;
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const starts: number[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const loose = lines.map(LOOSE);
  // Where each distinctive line of `old` sits in it, so each matching file line votes for the
  // one block start that would put it in the same place.
  const positions = new Map<string, number[]>();
  for (const [j, l] of want.entries()) {
    if (l.length < DISTINCTIVE) continue;
    const list = positions.get(l);
    if (list) list.push(j);
    else positions.set(l, [j]);
  }
  if (positions.size === 0) return null;
  const overlap = new Map<number, number>();
  for (const [t, l] of loose.entries()) {
    for (const j of positions.get(l) ?? []) {
      const at = t - j;
      if (at < 0 || at + want.length > lines.length) continue;
      overlap.set(at, (overlap.get(at) ?? 0) + 1);
    }
  }
  const candidates = [...overlap.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, MAX_SCORED);
  const target = want.join("\n");
  // Blocks below NEAR_MIN - NEAR_MARGIN can neither win nor make the winner ambiguous.
  const floor = NEAR_MIN - NEAR_MARGIN;
  const scored = candidates.map(([at]) => ({
    at,
    score: similarity(loose.slice(at, at + want.length).join("\n"), target, floor),
  }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  if (!best || best.score < NEAR_MIN) return null;
  if (
    second &&
    second.score > best.score - NEAR_MARGIN &&
    Math.abs(second.at - best.at) >= want.length
  )
    return null;
  const last = best.at + want.length - 1;
  return [starts[best.at] ?? 0, (starts[last] ?? 0) + (lines[last] ?? "").length];
}

type Located = { hits: [number, number][]; exact: boolean } | { error: string };

/** Where `oldText` is in `text`: exact, then indentation / whitespace-tolerant, then near. */
function locate(text: string, oldText: string, all: boolean, near: boolean): Located {
  const exact = count(text, oldText);
  if (exact === 1 || (exact > 1 && all)) {
    const hits: [number, number][] = [];
    for (let at = text.indexOf(oldText); at >= 0; at = text.indexOf(oldText, at + oldText.length)) {
      hits.push([at, at + oldText.length]);
      if (!all) break;
    }
    return { hits, exact: true };
  }
  if (exact > 1)
    return {
      error: `old_string occurs ${exact} times; include more surrounding lines to make it unique, or set replace_all.`,
    };
  let hits = fuzzyFind(text, oldText, TRIM);
  if (hits.length === 0) hits = fuzzyFind(text, oldText, LOOSE, true);
  if (hits.length === 1 || (hits.length > 1 && all)) return { hits, exact: false };
  if (hits.length > 1)
    return {
      error: `old_string matches ${hits.length} places (ignoring indentation); include more context.`,
    };
  const close = near ? nearMatch(text, oldText) : null;
  return { hits: close ? [close] : [], exact: false };
}

export function applyEdits(original: string, edits: readonly Edit[]): EditResult {
  const eol = eolOf(original);
  let text = original;
  let replacements = 0;
  const approximate: number[] = [];
  for (const [i, raw] of edits.entries()) {
    const label = edits.length > 1 ? `Edit ${i + 1}: ` : "";
    if (raw.old === "") {
      if (text !== "")
        return {
          ok: false,
          error: `${label}old_string is empty; to create or overwrite a whole file use write_file.`,
          index: i,
        };
      text = raw.new.replace(/\r?\n/g, eol);
      replacements++;
      continue;
    }
    // Try the edit as sent, then the readings of common transit mistakes; the fuzzy "near" match
    // only once nothing else matched.
    let applied = false;
    let error: string | null = null;
    for (const near of [false, true]) {
      for (const edit of variants(raw)) {
        const oldText = edit.old.replace(/\r?\n/g, eol);
        const newText = edit.new.replace(/\r?\n/g, eol);
        const found = locate(text, oldText, edit.all === true, near);
        if ("error" in found) {
          error ??= found.error;
          continue;
        }
        if (found.hits.length === 0) continue;
        // The near match replaces a block that only resembles old_string: the model is told
        // where, so it can check nothing else in that block was overwritten.
        if (near)
          for (const [start] of found.hits)
            approximate.push(text.slice(0, start).split("\n").length);
        for (const [start, end] of [...found.hits].reverse()) {
          const replacement = found.exact
            ? newText
            : reindent(text.slice(start, end), oldText, newText.replace(/\r?\n$/, ""));
          text = text.slice(0, start) + replacement + text.slice(end);
        }
        replacements += found.hits.length;
        applied = true;
        break;
      }
      if (applied) break;
    }
    if (applied) continue;
    if (error) return { ok: false, error: `${label}${error}`, index: i };
    return { ok: false, error: `${label}old_string was not found.`, notFound: true, index: i };
  }
  return { ok: true, text, replacements, ...(approximate.length && { approximate }) };
}
