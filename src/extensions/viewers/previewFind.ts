// Find in the Markdown preview (D210), the matching part: the preview's text as segments (its
// text nodes, in order, each tagged with the block it's in), searched as one string so a match
// may run across inline markup ("foo **bar**") but never from one block into the next. DOM-free
// and tested; previewFindBar.ts turns the matches into ranges and highlights.
import { type FindOptions, findPattern, matchesIn } from "../../core/notebook/find";

export type PreviewFindOptions = Pick<
  FindOptions,
  "query" | "caseSensitive" | "wholeWord" | "regex"
>;

export interface TextSegment {
  text: string;
  /** Segments of one block share this number. */
  block: number;
}

/** A match from (segment, offset) to (segment, offset), the end exclusive. */
export interface SegmentMatch {
  startSegment: number;
  startOffset: number;
  endSegment: number;
  endOffset: number;
}

/** Most matches found (a one-letter query in a long document). */
export const MAX_PREVIEW_MATCHES = 5000;

/** Every match of the query in the segments; a bad pattern's message instead. */
export function findInSegments(
  segments: readonly TextSegment[],
  options: PreviewFindOptions,
  limit = MAX_PREVIEW_MATCHES,
): SegmentMatch[] | string {
  const pattern = findPattern(options);
  if (typeof pattern === "string") return pattern;
  if (!pattern) return [];
  // One string, with a line break between blocks (so a match can't join two of them).
  const starts: number[] = [];
  let joined = "";
  for (const [i, s] of segments.entries()) {
    if (i > 0 && segments[i - 1]?.block !== s.block) joined += "\n";
    starts.push(joined.length);
    joined += s.text;
  }
  const locate = (offset: number, isEnd: boolean): { segment: number; offset: number } => {
    // The last segment starting at or before the offset (for an end, strictly before it).
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const start = starts[mid] as number;
      if (isEnd ? start < offset : start <= offset) lo = mid;
      else hi = mid - 1;
    }
    const start = starts[lo] ?? 0;
    const length = segments[lo]?.text.length ?? 0;
    return { segment: lo, offset: Math.max(0, Math.min(length, offset - start)) };
  };
  const out: SegmentMatch[] = [];
  for (const m of matchesIn(joined, pattern, limit)) {
    const a = locate(m.start, false);
    const b = locate(m.end, true);
    // A match that starts on a block break begins in the next segment.
    if (a.offset >= (segments[a.segment]?.text.length ?? 0) && a.segment + 1 < segments.length) {
      a.segment++;
      a.offset = 0;
    }
    if (b.segment < a.segment || (b.segment === a.segment && b.offset <= a.offset)) continue;
    out.push({
      startSegment: a.segment,
      startOffset: a.offset,
      endSegment: b.segment,
      endOffset: b.offset,
    });
  }
  return out;
}

/** The match index after `current` going `direction`, wrapping (none current: the first / last). */
export function stepMatch(current: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}

/** The first match at or after `segment` (the reading position), else the first. */
export function firstMatchFrom(matches: readonly SegmentMatch[], segment: number): number {
  if (!matches.length) return -1;
  const i = matches.findIndex((m) => m.startSegment >= segment);
  return i < 0 ? 0 : i;
}

/** "3 of 12", "No results", or "" with no query. */
export function matchCountLabel(
  query: string,
  current: number,
  count: number,
  error: string | null,
): string {
  if (!query) return "";
  if (error) return "Bad pattern";
  if (!count) return "No results";
  return `${current + 1} of ${count >= MAX_PREVIEW_MATCHES ? `${MAX_PREVIEW_MATCHES}+` : count}`;
}
