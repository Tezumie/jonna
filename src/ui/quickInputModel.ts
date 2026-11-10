// The DOM-free part of a live quick input session (QuickInput.session, VS Code's QuickPick /
// InputBox): which items show for the typed text and in what order, which row is active after
// the items or the text change, and the validation message's effect on Enter. Unit-tested.
import { type FuzzyMatch, fuzzyMatch } from "./fuzzy";

export interface FilterableItem {
  label: string;
  description?: string;
  detail?: string;
  /** Shown whatever is typed (VS Code's QuickPickItem.alwaysShow). */
  alwaysShow?: boolean;
  /** Starts a group (VS Code's separator items): kept only while nothing is typed. */
  separator?: string;
}

export interface FilterOptions {
  matchOnDescription?: boolean;
  matchOnDetail?: boolean;
  /** Best matches first while text is typed (VS Code's default); false keeps the given order. */
  sortByLabel?: boolean;
}

export interface FilteredRow {
  /** The item's index in the session's items. */
  index: number;
  /** Highlights in the label and the description. */
  label: FuzzyMatch;
  description?: number[];
  /** The group line shows above this row. */
  separator?: string;
}

const NO_MATCH: FuzzyMatch = { score: 0, positions: [] };

/**
 * The rows for `query`: every item while nothing is typed (with its group lines), else the items
 * whose label (or description / detail when asked) matches, plus `alwaysShow` ones. A label match
 * ranks above a description or detail match, as VS Code's.
 */
export function filterItems(
  items: readonly FilterableItem[],
  query: string,
  options: FilterOptions = {},
): FilteredRow[] {
  const q = query.trim();
  if (!q)
    return items.map((item, index) => ({
      index,
      label: NO_MATCH,
      ...(item.separator !== undefined && { separator: item.separator }),
    }));
  const scored: (FilteredRow & { score: number })[] = [];
  items.forEach((item, index) => {
    const label = fuzzyMatch(q, item.label);
    const description =
      !label && options.matchOnDescription && item.description
        ? fuzzyMatch(q, item.description)
        : null;
    const detail =
      !label && !description && options.matchOnDetail && item.detail
        ? fuzzyMatch(q, item.detail)
        : null;
    if (label) scored.push({ index, label, score: label.score + 1_000_000 });
    else if (description)
      scored.push({
        index,
        label: NO_MATCH,
        description: description.positions,
        score: description.score,
      });
    else if (detail) scored.push({ index, label: NO_MATCH, score: detail.score - 1_000_000 });
    else if (item.alwaysShow)
      scored.push({ index, label: NO_MATCH, score: Number.NEGATIVE_INFINITY });
  });
  if (options.sortByLabel !== false) scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map(({ score: _score, ...row }) => row);
}

/**
 * The active row (a position in `rows`) after the rows changed: the first of `wanted` (item
 * indexes the extension made active) that shows, else the previous active item when asked to
 * keep it (keepScrollPosition), else the first row; -1 when there are none.
 */
export function activeRowAfter(
  rows: readonly { index: number }[],
  wanted: readonly number[] | undefined,
  previous: number | undefined,
  keep: boolean,
): number {
  if (!rows.length) return -1;
  for (const index of wanted ?? []) {
    const at = rows.findIndex((r) => r.index === index);
    if (at >= 0) return at;
  }
  if (keep && previous !== undefined) {
    const at = rows.findIndex((r) => r.index === previous);
    if (at >= 0) return at;
  }
  return 0;
}

export type ValidationSeverity = "info" | "warning" | "error";

/** Only an Error-severity message holds Enter back (VS Code's InputBoxValidationSeverity). */
export function blocksAccept(
  validation: { message: string; severity: ValidationSeverity } | null | undefined,
): boolean {
  return !!validation?.message && validation.severity === "error";
}

/** "Title (2/3)": VS Code's step counter after the title. */
export function titleText(title: string | undefined, step?: number, totalSteps?: number): string {
  const counter =
    typeof step === "number" && step > 0
      ? typeof totalSteps === "number" && totalSteps > 0
        ? `${step}/${totalSteps}`
        : `${step}`
      : "";
  if (title && counter) return `${title} (${counter})`;
  return title || counter;
}
