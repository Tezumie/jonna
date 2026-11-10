// Fuzzy matching for the palette (and later quick open). DOM-free and unit-tested.
// Every query character must appear in order; the score rewards consecutive runs, matches at
// word starts (after space . - _ / : or a lower→Upper change) and an early first match.

export interface FuzzyMatch {
  score: number;
  /** Indices into the target string that matched, for highlighting. */
  positions: number[];
}

const SEPARATORS = new Set([" ", ".", "-", "_", "/", "\\", ":", "(", ")"]);

function isWordStart(target: string, i: number): boolean {
  if (i === 0) return true;
  const prev = target.charAt(i - 1);
  const cur = target.charAt(i);
  return SEPARATORS.has(prev) || (prev === prev.toLowerCase() && cur !== cur.toLowerCase());
}

/** Returns a match or null. An empty query matches everything with score 0. */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (q.length === 0) return { score: 0, positions: [] };
  const t = target.toLowerCase();
  // Several alignments, best score wins: word-start-preferring greedy (good for "tgl sb" →
  // "Toggle sidebar"), plain greedy (always finds a subsequence if one exists), and the query as a
  // contiguous run of the space-less target ("startup" in "Show startup timings").
  const candidates = [align(q, t, target, true), align(q, t, target, false), contiguous(q, target)];
  let best: FuzzyMatch | null = null;
  for (const positions of candidates) {
    if (!positions) continue;
    const match = { score: scoreOf(positions, target, q), positions };
    if (!best || match.score > best.score) best = match;
  }
  return best;
}

function align(q: string, t: string, target: string, preferWordStarts: boolean): number[] | null {
  const positions: number[] = [];
  let from = 0;
  for (const ch of q) {
    let found = -1;
    if (preferWordStarts) {
      for (let i = from; i < t.length; i++) {
        if (t.charAt(i) === ch && isWordStart(target, i)) {
          found = i;
          break;
        }
      }
    }
    const plain = t.indexOf(ch, from);
    // Use the word start only if it doesn't skip a contiguous continuation.
    if (found < 0 || (plain >= 0 && plain === from && positions.length > 0)) found = plain;
    if (found < 0) return null;
    positions.push(found);
    from = found + 1;
  }
  return positions;
}

/** Positions of `q` as a substring of `target` with spaces ignored, preferring a word start. */
function contiguous(q: string, target: string): number[] | null {
  const index: number[] = [];
  let compact = "";
  for (let i = 0; i < target.length; i++) {
    if (/\s/.test(target.charAt(i))) continue;
    index.push(i);
    compact += target.charAt(i).toLowerCase();
  }
  const first = compact.indexOf(q);
  if (first < 0) return null;
  let at = first;
  while (at >= 0 && !isWordStart(target, index[at] as number)) at = compact.indexOf(q, at + 1);
  const start = at >= 0 ? at : first;
  return index.slice(start, start + q.length);
}

function scoreOf(positions: readonly number[], target: string, q: string): number {
  let score = 0;
  for (let k = 0; k < positions.length; k++) {
    const pos = positions[k] as number;
    score += 1;
    if (isWordStart(target, pos)) score += 8;
    if (k > 0 && pos === (positions[k - 1] as number) + 1) score += 5;
  }
  score -= (positions[0] ?? 0) * 0.1;
  score -= (target.length - q.length) * 0.01;
  return score;
}

/** Filters and sorts items by best match; ties keep the original order. */
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  text: (item: T) => string,
): { item: T; match: FuzzyMatch }[] {
  const out: { item: T; match: FuzzyMatch; index: number }[] = [];
  items.forEach((item, index) => {
    const match = fuzzyMatch(query, text(item));
    if (match) out.push({ item, match, index });
  });
  out.sort((a, b) => b.match.score - a.match.score || a.index - b.index);
  return out.map(({ item, match }) => ({ item, match }));
}
