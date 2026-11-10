// A guard against degenerate output (D142): some models — free and small ones especially — get
// stuck repeating the same sentence in their reasoning or answer until the output limit, which
// can take minutes and burn tokens. The watch keeps the tail of each stream and stops it when the
// tail is one short passage repeated many times, or when reasoning runs far past any normal
// length. DOM-free and tested.

/** Shortest and longest repeating passage looked for (characters, whitespace collapsed). */
const MIN_PERIOD = 12;
const MAX_PERIOD = 800;
/** How much the tail must be pure repetition: at least this many characters… */
const MIN_RUN = { thinking: 900, text: 2000 };
/** …and at least this many copies of the passage. */
const MIN_COPIES = { thinking: 6, text: 8 };
/** Reasoning longer than this (characters) is stopped regardless. */
const MAX_THINKING = 120_000;
const TAIL = 6000;
const CHECK_EVERY = 400;

export type StreamKind = "thinking" | "text";

/** The length of the repetition at the end of `s` with period `p` (0 when none). */
function repeatedRun(s: string, p: number): number {
  let i = 0;
  const n = s.length;
  while (i + p < n && s.charCodeAt(n - 1 - i) === s.charCodeAt(n - 1 - i - p)) i++;
  return i + p;
}

/** Whether `text` ends in one passage repeated over and over (see MIN_RUN / MIN_COPIES). */
export function endsInLoop(text: string, kind: StreamKind): boolean {
  const s = text.replace(/\s+/g, " ");
  const need = MIN_RUN[kind];
  if (s.length < need) return false;
  for (let p = MIN_PERIOD; p <= MAX_PERIOD && p * MIN_COPIES[kind] <= s.length; p++) {
    // Quick reject: the last character must recur one period back.
    if (s.charCodeAt(s.length - 1) !== s.charCodeAt(s.length - 1 - p)) continue;
    const run = repeatedRun(s, p);
    if (run >= need && run >= p * MIN_COPIES[kind]) return true;
  }
  return false;
}

export class RepetitionWatch {
  private readonly tails: Record<StreamKind, string> = { thinking: "", text: "" };
  private readonly unchecked: Record<StreamKind, number> = { thinking: 0, text: 0 };
  private thinkingTotal = 0;

  /** Adds streamed text; returns why to stop, or null. */
  push(kind: StreamKind, chunk: string): string | null {
    if (kind === "thinking") {
      this.thinkingTotal += chunk.length;
      if (this.thinkingTotal > MAX_THINKING)
        return "The model kept reasoning far longer than normal without answering, so it was stopped.";
    }
    const tail = (this.tails[kind] + chunk).slice(-TAIL);
    this.tails[kind] = tail;
    this.unchecked[kind] += chunk.length;
    if (this.unchecked[kind] < CHECK_EVERY) return null;
    this.unchecked[kind] = 0;
    return endsInLoop(tail, kind)
      ? `The model got stuck repeating itself${kind === "thinking" ? " while reasoning" : ""}, so it was stopped. Try again, or pick another model (small and free ones do this more).`
      : null;
  }
}
