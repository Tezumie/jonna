// Semantic token deltas (D204, `textDocument/semanticTokens/full/delta`): the server sends edits
// to the token array it last sent (by result id) instead of the whole array; they're applied here
// to the copy the client kept. DOM-free and tested.

/** One edit of a SemanticTokensDelta: replace `deleteCount` numbers at `start` with `data`. */
export interface SemanticTokensEdit {
  start: number;
  deleteCount: number;
  data?: readonly number[];
}

/** The server's answer to a delta request: a delta, or the full tokens again. */
export type SemanticTokensDeltaResult =
  | { resultId?: string; edits: readonly SemanticTokensEdit[] }
  | { resultId?: string; data: readonly number[] };

/**
 * Applies a delta's edits to the previous token data. The edits refer to positions in the
 * previous array and don't overlap (LSP 3.16); they may come in any order. Throws on edits that
 * don't fit, so the caller can ask for the full tokens instead.
 */
export function applySemanticTokensEdits(
  previous: ArrayLike<number>,
  edits: readonly SemanticTokensEdit[],
): number[] {
  const out = Array.from(previous);
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let limit = out.length;
  for (const edit of sorted) {
    const { start, deleteCount } = edit;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(deleteCount) ||
      start < 0 ||
      deleteCount < 0 ||
      start + deleteCount > limit
    )
      throw new Error("A semantic token edit doesn't fit the previous tokens.");
    out.splice(start, deleteCount, ...(edit.data ?? []));
    // Edits are applied from the end; the next one must end at or before this one's start.
    limit = start;
  }
  return out;
}

/** The new token data from a delta request's answer, given the data the client kept. */
export function resolveSemanticTokensDelta(
  previous: ArrayLike<number>,
  result: SemanticTokensDeltaResult,
): { data: number[]; resultId?: string } {
  const data =
    "edits" in result ? applySemanticTokensEdits(previous, result.edits) : [...result.data];
  return { data, ...(result.resultId !== undefined && { resultId: result.resultId }) };
}
