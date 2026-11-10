// What the Performance timeline computes (D147): the recording's shape, time ruler steps, which
// frames dropped, request rows, the value under the pointer and statistics for a selected range
// (Chrome's Summary). DOM-free and tested.

export interface PerfRequest {
  url: string;
  type: string;
  start: number;
  end: number;
  size: number;
}

export interface PerfInteraction {
  name: string;
  start: number;
  duration: number;
  processing?: number;
  target?: string;
}

export interface PerfRecording {
  duration: number;
  /** Started at the document's start (reload and record). */
  fromNavigation?: boolean;
  url?: string;
  samples: { t: number; fps: number; heap?: number; nodes?: number }[];
  /** When each frame started (ms from the recording's start). */
  frames?: number[];
  longTasks: { start: number; duration: number }[];
  interactions?: PerfInteraction[];
  shifts?: { t: number; value: number }[];
  markers?: { name: string; label: string; t: number }[];
  requests?: PerfRequest[];
  timings?: { name: string; start: number; duration: number }[];
  supported: { longTasks?: boolean; interactions?: boolean; memory?: boolean };
}

/** A tick step for `span` ms that gives about `target` ticks (1, 2, 5 × 10ⁿ). */
export function tickStep(span: number, target: number): number {
  const raw = Math.max(span, 0.001) / Math.max(1, target);
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

/** Ruler ticks in [start, end]. */
export function ticks(start: number, end: number, target: number): number[] {
  const step = tickStep(end - start, target);
  const out: number[] = [];
  for (let t = Math.ceil(start / step) * step; t <= end + 1e-6; t += step)
    out.push(Math.round(t * 1000) / 1000);
  return out;
}

/** A ruler label: "0", "250 ms", "1.5 s". */
export function tickLabel(t: number, step: number): string {
  if (t === 0) return "0";
  if (step >= 1000 || t >= 1000) {
    const decimals = step >= 1000 ? 0 : step >= 100 ? 1 : 2;
    return `${Number.parseFloat((t / 1000).toFixed(decimals))} s`;
  }
  return `${Number.parseFloat(t.toFixed(step < 1 ? 1 : 0))} ms`;
}

export type FrameRating = "good" | "ok" | "poor";

/** Frames as [start, duration, rating]: on time (≤ 1.5 vsyncs), late, or dropped (≥ 3). */
export function frameSpans(frames: readonly number[]): [number, number, FrameRating][] {
  const out: [number, number, FrameRating][] = [];
  for (let i = 0; i + 1 < frames.length; i++) {
    const start = frames[i] ?? 0;
    const d = (frames[i + 1] ?? start) - start;
    out.push([start, d, d <= 25 ? "good" : d < 50 ? "ok" : "poor"]);
  }
  return out;
}

/** Requests in rows that don't overlap (at most `max` rows; the rest share the last). */
export function packRows<T extends { start: number; end: number }>(
  items: readonly T[],
  max: number,
): { item: T; row: number }[] {
  const ends: number[] = [];
  const out: { item: T; row: number }[] = [];
  for (const item of [...items].sort((a, b) => a.start - b.start)) {
    let row = ends.findIndex((e) => e <= item.start);
    if (row < 0) row = ends.length < max ? ends.length : max - 1;
    ends[row] = Math.max(ends[row] ?? 0, item.end);
    out.push({ item, row });
  }
  return out;
}

/** The last sample at or before `t` (binary search; samples are sorted by time). */
export function sampleAt<T extends { t: number }>(samples: readonly T[], t: number): T | null {
  let lo = 0;
  let hi = samples.length - 1;
  let best: T | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = samples[mid];
    if (!s) break;
    if (s.t <= t) {
      best = s;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best ?? samples[0] ?? null;
}

/** The frame that was on screen at `t`: [start, duration]. */
export function frameAt(frames: readonly number[], t: number): [number, number] | null {
  let lo = 0;
  let hi = frames.length - 2;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const a = frames[mid] ?? 0;
    const b = frames[mid + 1] ?? a;
    if (t < a) hi = mid - 1;
    else if (t >= b) lo = mid + 1;
    else return [a, b - a];
  }
  return null;
}

export interface RangeStats {
  duration: number;
  frames: number;
  averageFps: number | null;
  dropped: number;
  longTasks: number;
  blocking: number;
  requests: number;
  bytes: number;
  interactions: number;
  slowestInteraction: PerfInteraction | null;
  layoutShift: number;
  heap: { min: number; max: number } | null;
}

const overlaps = (s: number, e: number, a: number, b: number) => s < b && e > a;

/** Chrome's Summary for the selected range [a, b]. */
export function rangeStats(r: PerfRecording, a: number, b: number): RangeStats {
  const frames = (r.frames ?? []).filter((t) => t >= a && t <= b);
  const spans = frameSpans(r.frames ?? []).filter(([s]) => s >= a && s < b);
  const tasks = r.longTasks.filter((t) => overlaps(t.start, t.start + t.duration, a, b));
  const requests = (r.requests ?? []).filter((q) =>
    overlaps(q.start, Math.max(q.end, q.start + 1), a, b),
  );
  const interactions = (r.interactions ?? []).filter((e) =>
    overlaps(e.start, e.start + e.duration, a, b),
  );
  const heaps = r.samples.filter((s) => s.t >= a && s.t <= b && s.heap !== undefined);
  const span = Math.max(0, b - a);
  // Frames per second from the frames themselves when there are any, else from the samples.
  const sampled = r.samples.filter((s) => s.t >= a && s.t <= b);
  const fpsFromFrames =
    frames.length > 1
      ? ((frames.length - 1) * 1000) / ((frames.at(-1) ?? 0) - (frames[0] ?? 0) || 1)
      : null;
  const fpsFromSamples = sampled.length
    ? sampled.reduce((sum, s) => sum + s.fps, 0) / sampled.length
    : null;
  const fps = fpsFromFrames ?? fpsFromSamples;
  return {
    duration: span,
    frames: Math.max(0, frames.length - 1),
    averageFps: fps === null ? null : Math.round(Math.min(fps, 240)),
    dropped: spans.filter(([, , rating]) => rating === "poor").length,
    longTasks: tasks.length,
    blocking: tasks.reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0),
    requests: requests.length,
    bytes: requests.reduce((sum, q) => sum + q.size, 0),
    interactions: interactions.length,
    slowestInteraction: interactions.reduce<PerfInteraction | null>(
      (worst, e) => (!worst || e.duration > worst.duration ? e : worst),
      null,
    ),
    layoutShift:
      Math.round(
        (r.shifts ?? []).filter((s) => s.t >= a && s.t <= b).reduce((sum, s) => sum + s.value, 0) *
          1000,
      ) / 1000,
    heap: heaps.length
      ? {
          min: Math.min(...heaps.map((s) => s.heap ?? 0)),
          max: Math.max(...heaps.map((s) => s.heap ?? 0)),
        }
      : null,
  };
}

/** Interaction to Next Paint, as Chrome rates it (good ≤ 200 ms, poor > 500 ms). */
export function rateInteraction(ms: number): "good" | "ok" | "poor" {
  return ms <= 200 ? "good" : ms <= 500 ? "ok" : "poor";
}
