// The command palette's order (D269, VS Code's): with a query, how well a command's label matches
// comes first — the query as consecutive letters starting a word, then anywhere as consecutive
// letters, then scattered letters — then, within that, recently used commands first (most recent
// first), then the fuzzy score. A few commands own a word: while the query is a start of it
// ("t", "th" … "theme"), that command comes first. DOM-free and unit-tested.

import type { FuzzyMatch } from "../../ui/fuzzy";

/** Words a command owns at the top of the palette while the query is a start of them. */
export const PALETTE_WORDS: Readonly<Record<string, string>> = {
  theme: "ui.selectColorTheme",
};

/**
 * How a match reads: 0 the query's letters consecutive and starting a word, 1 consecutive
 * elsewhere, 2 scattered. Spaces between matched letters don't break a run ("colortheme").
 */
export function matchTier(match: FuzzyMatch, target: string): 0 | 1 | 2 {
  const p = match.positions;
  if (!p.length) return 0;
  for (let k = 1; k < p.length; k++) {
    const gap = target.slice((p[k - 1] as number) + 1, p[k]);
    if (gap.trim() !== "") return 2;
  }
  const first = p[0] as number;
  const prev = first > 0 ? target.charAt(first - 1) : " ";
  const startsWord =
    first === 0 ||
    /[\s.\-_/\\:()]/.test(prev) ||
    (prev === prev.toLowerCase() && target.charAt(first) !== target.charAt(first).toLowerCase());
  return startsWord ? 0 : 1;
}

export interface RankedCommand {
  id: string;
  text: string;
  match: FuzzyMatch;
}

/** Sorts matches for `query` (`recent`: command ids, newest first). */
export function rankCommands<T extends RankedCommand>(
  query: string,
  items: readonly T[],
  recent: readonly string[],
): T[] {
  const q = query.replace(/\s+/g, "").toLowerCase();
  const owner = q
    ? Object.entries(PALETTE_WORDS).find(([word]) => word.startsWith(q))?.[1]
    : undefined;
  const recency = (id: string) => {
    const i = recent.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const keyed = items.map((item) => ({
    item,
    owned: item.id === owner ? 0 : 1,
    tier: q ? matchTier(item.match, item.text) : 0,
    recent: recency(item.id),
  }));
  keyed.sort(
    (a, b) =>
      a.owned - b.owned ||
      a.tier - b.tier ||
      a.recent - b.recent ||
      (q ? b.item.match.score - a.item.match.score : a.item.text.localeCompare(b.item.text)),
  );
  return keyed.map((k) => k.item);
}
