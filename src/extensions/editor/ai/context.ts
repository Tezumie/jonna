// Context for suggestions as you type (D204): a few snippets from elsewhere that make the guess
// better, as Copilot's "neighboring tabs" — the parts of other open files most like the code
// before the cursor (identifier overlap, Jaccard similarity over windows of lines), and the user's
// recent edits (what they're working on). Ranked, then cut to the prompt's budget (fim.ts).
// DOM-free and tested.

import { samePath } from "../../../core/paths/index";
import type { Snippet } from "./fim";

/** Identifiers of `text` (2+ characters, keywords included: cheap and good enough). */
export function identifiers(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_$][\w$]{1,}/g) ?? []);
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

/** `text` as overlapping windows of `size` lines, every `step` lines. */
export function lineWindows(
  text: string,
  size = 20,
  step = 10,
): { startLine: number; text: string }[] {
  const lines = text.split("\n");
  const out: { startLine: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i += step) {
    out.push({ startLine: i + 1, text: lines.slice(i, i + size).join("\n") });
    if (i + size >= lines.length) break;
  }
  return out;
}

export interface ContextDocument {
  path: string;
  text: string;
}

export interface RecentEdit {
  path: string;
  /** The changed lines with a little around them. */
  text: string;
  /** First line of `text` (1-based). */
  line: number;
  at: number;
}

/** Files bigger than this aren't scanned (a minified bundle, a log). */
const MAX_SCAN_CHARS = 400_000;
/** Below this similarity a window isn't context, it's noise. */
const MIN_SCORE = 0.08;

/**
 * The best snippets for a completion in `current` at the end of `prefix`: per other open file,
 * its window most like the last lines before the cursor; recent edits elsewhere (not around the
 * cursor, the model sees those anyway), newest first; the imported declarations. At most `max`,
 * best first.
 */
export function rankSnippets(input: {
  current: { path: string; prefix: string; suffix?: string };
  documents: readonly ContextDocument[];
  edits: readonly RecentEdit[];
  /** Declarations from the files the current one imports (imports.ts, D224), already scored. */
  imports?: readonly Snippet[];
  /** The cursor's line in the current file (1-based), to skip edits the prompt has. */
  cursorLine?: number;
  max?: number;
  now?: number;
}): Snippet[] {
  const max = input.max ?? 6;
  const reference = identifiers(input.current.prefix.split("\n").slice(-30).join("\n"));
  const out: Snippet[] = [];
  for (const doc of input.documents) {
    if (doc.path === input.current.path || !doc.text.trim() || doc.text.length > MAX_SCAN_CHARS)
      continue;
    let best: Snippet | null = null;
    for (const w of lineWindows(doc.text)) {
      const score = jaccard(reference, identifiers(w.text));
      if (score >= MIN_SCORE && (!best || score > best.score))
        best = { path: doc.path, text: w.text, kind: "open", score };
    }
    if (best) out.push(best);
  }
  const now = input.now ?? Date.now();
  for (const e of input.edits) {
    if (!e.text.trim()) continue;
    const lines = e.text.split("\n").length;
    // The current file's edit near the cursor is already in the prompt's prefix or suffix.
    if (
      e.path === input.current.path &&
      input.cursorLine !== undefined &&
      e.line <= input.cursorLine + 60 &&
      e.line + lines >= input.cursorLine - 60
    )
      continue;
    const ageMinutes = Math.max(0, now - e.at) / 60_000;
    // Recent edits are good context: they outrank all but a very similar open-file window, and
    // fade over half an hour.
    const score =
      0.5 * Math.max(0.2, 1 - ageMinutes / 30) + jaccard(reference, identifiers(e.text)) / 2;
    out.push({ path: e.path, text: e.text, kind: "edit", score });
  }
  // An imported file's declarations, unless the open-file window of it already holds them.
  for (const s of input.imports ?? [])
    if (!out.some((o) => samePath(o.path, s.path) && o.text.includes(s.text))) out.push(s);
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}

/** The lines `after` changed from `before`, with `around` lines either side; null: none. */
export function changedRegion(
  before: string,
  after: string,
  around = 3,
): { line: number; text: string } | null {
  if (before === after) return null;
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  // Only deletions: show where they were.
  if (endB < start) endB = start;
  const from = Math.max(0, start - around);
  const to = Math.min(b.length - 1, endB + around);
  const text = b.slice(from, Math.min(to + 1, from + 40)).join("\n");
  return { line: from + 1, text };
}

/** The last edits, one per region of a file, newest first (D204). */
export class RecentEdits {
  private readonly list: RecentEdit[] = [];

  constructor(private readonly max = 8) {}

  record(path: string, before: string, after: string, at = Date.now()): void {
    const region = changedRegion(before, after);
    if (!region) return;
    const lines = region.text.split("\n").length;
    // The same place edited again replaces its older entry (typing a word is one edit).
    const i = this.list.findIndex(
      (e) =>
        e.path === path &&
        e.line <= region.line + lines &&
        region.line <= e.line + e.text.split("\n").length,
    );
    if (i >= 0) this.list.splice(i, 1);
    this.list.unshift({ path, ...region, at });
    if (this.list.length > this.max) this.list.length = this.max;
  }

  /** A file renamed: its edits follow; deleted (to null): they go. */
  moved(from: string, to: string | null): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i] as RecentEdit;
      if (e.path !== from) continue;
      if (to === null) this.list.splice(i, 1);
      else e.path = to;
    }
  }

  all(): readonly RecentEdit[] {
    return this.list;
  }

  clear(): void {
    this.list.length = 0;
  }
}
