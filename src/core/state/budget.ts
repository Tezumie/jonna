// Fitting JSON values into a size budget (characters of JSON), so agents with small context
// windows still get a useful, honest view. Truncation is reported, never silent.

export interface BudgetResult {
  value: unknown;
  /** JSON length after truncation. */
  size: number;
  truncated: boolean;
  /** Human/model-readable notes on what was cut, e.g. "/editors: showing 10 of 40 items". */
  notes: string[];
}

const jsonSize = (value: unknown): number => JSON.stringify(value)?.length ?? 0;

/**
 * Shrinks `value` until its JSON fits `budget` characters: long strings are cut and long arrays
 * keep their first items (providers should put the most important items first). Limits are
 * halved step by step, so small overruns lose little.
 */
export function fitToBudget(value: unknown, budget: number): BudgetResult {
  const size = jsonSize(value);
  if (size <= budget) return { value, size, truncated: false, notes: [] };
  let maxItems = 200;
  let maxString = 4000;
  for (;;) {
    const notes: string[] = [];
    const shrunk = shrink(value, "", maxItems, maxString, notes);
    const shrunkSize = jsonSize(shrunk);
    if (shrunkSize <= budget || (maxItems <= 1 && maxString <= 16)) {
      return { value: shrunk, size: shrunkSize, truncated: true, notes };
    }
    maxItems = Math.max(1, Math.floor(maxItems / 2));
    maxString = Math.max(16, Math.floor(maxString / 2));
  }
}

function shrink(
  value: unknown,
  path: string,
  maxItems: number,
  maxString: number,
  notes: string[],
): unknown {
  if (typeof value === "string") {
    if (value.length <= maxString) return value;
    notes.push(`${path || "/"}: string cut to ${maxString} of ${value.length} chars`);
    return `${value.slice(0, maxString)}…`;
  }
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, maxItems)
      .map((v, i) => shrink(v, `${path}/${i}`, maxItems, maxString, notes));
    if (value.length > maxItems) {
      notes.push(`${path || "/"}: showing ${maxItems} of ${value.length} items`);
    }
    return kept;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        shrink(v, `${path}/${k}`, maxItems, maxString, notes),
      ]),
    );
  }
  return value;
}
