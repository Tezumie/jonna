// Startup and load timings (ms). Marks are relative to navigation start (performance.now());
// `processStartMs` lets us also report time since the native process started (cold start).
const marks = new Map<string, number>();
const waiting = new Map<string, (() => void)[]>();
let processStartMs: number | undefined;

/** Startup phases in order, with user-facing labels (`workbench.startupTimings`). */
export const STARTUP_PHASES: readonly [mark: string, label: string][] = [
  ["navigationStart", "Webview started"],
  ["shellPainted", "Shell visible"],
  ["extensionsActivated", "Extensions active"],
  ["workspaceRestored", "Folder restored"],
  ["editorReady", "Editor ready"],
];

export interface StartupPhase {
  mark: string;
  label: string;
  /** Since the native process started (null if unknown, e.g. in a browser). */
  sinceProcessStartMs: number | null;
  sinceNavigationMs: number;
}

export const perf = {
  mark(name: string): void {
    if (marks.has(name)) return;
    marks.set(name, performance.now());
    for (const resolve of waiting.get(name) ?? []) resolve();
    waiting.delete(name);
  },
  /** Resolves once `name` is marked (at once if it was): e.g. after the folder is restored. */
  whenMarked(name: string): Promise<void> {
    if (marks.has(name)) return Promise.resolve();
    return new Promise((resolve) => waiting.set(name, [...(waiting.get(name) ?? []), resolve]));
  },
  setProcessStart(epochMs: number): void {
    processStartMs = epochMs;
  },
  report(): Record<string, number | null> {
    const navigationStartEpoch = performance.timeOrigin;
    const out: Record<string, number | null> = {};
    for (const [name, t] of marks) {
      out[`${name}.sinceNavigationMs`] = Math.round(t);
      out[`${name}.sinceProcessStartMs`] =
        processStartMs === undefined ? null : Math.round(navigationStartEpoch + t - processStartMs);
    }
    return out;
  },
  /** The startup phases reached so far, in order. */
  phases(): StartupPhase[] {
    const out: StartupPhase[] = [];
    for (const [mark, label] of STARTUP_PHASES) {
      const t = mark === "navigationStart" ? 0 : marks.get(mark);
      if (t === undefined) continue;
      out.push({
        mark,
        label,
        sinceNavigationMs: Math.round(t),
        sinceProcessStartMs:
          processStartMs === undefined
            ? null
            : Math.round(performance.timeOrigin + t - processStartMs),
      });
    }
    return out;
  },
};
