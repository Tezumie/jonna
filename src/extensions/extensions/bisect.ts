// Extension bisect (VS Code's Help → Start extension bisect), DOM-free: finds the extension
// behind a problem by turning half of the suspects off, asking whether the problem is gone, and
// keeping the half that has it, until one is left. Only the round's half is ever off (the
// others run), and it's kept in the extensions registry (`bisect`), so it survives the restart
// between rounds without touching the user's own enabled / disabled choices.

export interface BisectState {
  /** The extensions that may still cause the problem. */
  candidates: string[];
  /** The half that's off this round (a subset of candidates). */
  off: string[];
  round: number;
  /** How many extensions it started with. */
  total: number;
}

export type BisectAnswer = "good" | "bad";

export type BisectStep =
  | { done: false; state: BisectState }
  /** `culprit` null: the problem happens with every suspect off (not an extension's). */
  | { done: true; culprit: string | null };

/** The first half (rounded up) is off first. */
const halve = (candidates: string[]): string[] =>
  candidates.slice(0, Math.ceil(candidates.length / 2));

export function startBisect(ids: readonly string[]): BisectState {
  const candidates = [...new Set(ids)];
  return { candidates, off: halve(candidates), round: 1, total: candidates.length };
}

/**
 * "good": the problem is gone with `off` off, so it's one of them. "bad": it's still there, so
 * it's one of those still running.
 */
export function nextBisect(state: BisectState, answer: BisectAnswer): BisectStep {
  const candidates =
    answer === "good" ? state.off : state.candidates.filter((id) => !state.off.includes(id));
  if (!candidates.length) return { done: true, culprit: null };
  // One left that was off while the problem was gone: found. One left that was running: its
  // own round with it off tells (the problem may not be an extension's at all).
  if (candidates.length === 1 && answer === "good")
    return { done: true, culprit: candidates[0] ?? null };
  return {
    done: false,
    state: { ...state, candidates, off: halve(candidates), round: state.round + 1 },
  };
}

/** Rounds still to go at most (each halves the suspects). */
export function roundsLeft(state: BisectState): number {
  // Halving, plus a last round when the one left was running.
  return Math.ceil(Math.log2(Math.max(1, state.candidates.length))) + 1;
}

/** The registry's `bisect` field, or null when it isn't a valid state. */
export function parseBisect(raw: unknown): BisectState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const candidates = strings(r.candidates);
  const off = strings(r.off).filter((id) => candidates.includes(id));
  if (!candidates.length || !off.length) return null;
  const round = typeof r.round === "number" && r.round >= 1 ? Math.floor(r.round) : 1;
  const total = typeof r.total === "number" ? Math.floor(r.total) : candidates.length;
  return { candidates, off, round, total: Math.max(total, candidates.length) };
}
