// The merge editor's layout (D209), DOM-free and tested: the input panes' shares of the width
// and the inputs' share of the height (the sash above the result), read back from a tab's saved
// state so each merge tab keeps its own, and the size a sash drag gives.

export type InputPaneKind = "incoming" | "base" | "current";

export interface MergeLayout {
  weights: Record<InputPaneKind, number>;
  /** The inputs' share of the height, 0..1 (the result has the rest). */
  split: number;
}

export const DEFAULT_SPLIT = 0.5;
const MIN_SPLIT = 0.1;
const MAX_SPLIT = 0.9;

const clampSplit = (v: number) => Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, v));

/** The layout a merge tab saved (anything missing or odd: the default). */
export function readMergeLayout(state: unknown): MergeLayout {
  const s = (state ?? {}) as { weights?: unknown; split?: unknown };
  const w = (s.weights ?? {}) as Record<string, unknown>;
  const weight = (k: InputPaneKind) => {
    const v = w[k];
    return typeof v === "number" && Number.isFinite(v) && v > 0 && v < 100 ? v : 1;
  };
  const split =
    typeof s.split === "number" && Number.isFinite(s.split) ? clampSplit(s.split) : DEFAULT_SPLIT;
  return {
    weights: { incoming: weight("incoming"), base: weight("base"), current: weight("current") },
    split,
  };
}

/** The layout as a tab saves it: only what differs from the default. */
export function saveMergeLayout(layout: MergeLayout): {
  weights?: Record<InputPaneKind, number>;
  split?: number;
} {
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const even = Object.values(layout.weights).every((v) => Math.abs(v - 1) < 1e-6);
  return {
    ...(!even && {
      weights: {
        incoming: round(layout.weights.incoming),
        base: round(layout.weights.base),
        current: round(layout.weights.current),
      },
    }),
    ...(Math.abs(layout.split - DEFAULT_SPLIT) > 1e-3 && { split: round(layout.split) }),
  };
}

/**
 * The inputs' share after dragging the sash above the result by `delta` px, from heights at the
 * drag's start; each part keeps at least `min` px (less when there isn't room).
 */
export function splitAfterDrag(inputs: number, result: number, delta: number, min = 80): number {
  const total = inputs + result;
  if (total <= 0) return DEFAULT_SPLIT;
  const floor = Math.min(min, total / 2);
  const height = Math.max(floor, Math.min(total - floor, inputs + delta));
  return clampSplit(height / total);
}

/** Whether a tab's saved state has a layout of its own (sizes dragged in that tab). */
export function hasSavedLayout(state: unknown): boolean {
  const s = (state ?? {}) as { weights?: unknown; split?: unknown };
  return s.weights !== undefined || s.split !== undefined;
}

/** How many files' layouts are kept (the most recently used). */
const MAX_REMEMBERED = 100;

/**
 * The last layout of each file's merge editor (D219, kept in the folder's state): a new merge
 * tab for a file opens with the sizes it had last time, as the tab that had them would.
 */
export class MergeLayoutMemory {
  /** Path key → layout as a tab saves it; insertion order is use order (oldest first). */
  private readonly layouts = new Map<string, ReturnType<typeof saveMergeLayout>>();

  constructor(private readonly key: (path: string) => string = (p) => p) {}

  remember(path: string, layout: MergeLayout): void {
    const k = this.key(path);
    this.layouts.delete(k);
    const saved = saveMergeLayout(layout);
    // The default layout needs no entry.
    if (hasSavedLayout(saved)) this.layouts.set(k, saved);
    while (this.layouts.size > MAX_REMEMBERED) {
      const oldest = this.layouts.keys().next().value;
      if (oldest === undefined) break;
      this.layouts.delete(oldest);
    }
  }

  /** The file's last layout (the default when there's none). */
  recall(path: string): MergeLayout {
    return readMergeLayout(this.layouts.get(this.key(path)));
  }

  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.layouts);
  }

  /** Reads what toJSON wrote (anything odd is dropped). */
  restore(data: unknown): void {
    this.layouts.clear();
    if (!data || typeof data !== "object") return;
    const entries = Object.entries(data as Record<string, unknown>).filter(
      ([, v]) => v && typeof v === "object" && hasSavedLayout(v),
    );
    for (const [k, v] of entries.slice(-MAX_REMEMBERED))
      this.layouts.set(k, saveMergeLayout(readMergeLayout(v)));
  }
}
