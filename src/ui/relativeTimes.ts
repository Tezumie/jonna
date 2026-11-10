// Relative times that stay current ("2 min ago" still right a minute later): an element shows its
// time with `data-time` (ms since the epoch), and one shared minute timer rewrites the text of those
// under the roots that asked for it. Only while the window is visible and the root is on screen; a
// root coming back on screen (its size changes from nothing) is brought up to date at once. Text
// only: nothing is redrawn.

import { type Disposable, toDisposable } from "../core/lifecycle/index";

/** The text for `time` seen at `now` (`relativeAge`, `shortAge`). */
export type TimeFormat = (time: number, now: number) => string;

const TICK_MS = 60_000;

const roots = new Map<HTMLElement, { format: TimeFormat; resize: ResizeObserver }>();
let timer: ReturnType<typeof setInterval> | undefined;

/** The attribute that makes an element's text a relative time kept current. */
export function timeAttrs(time: number): { "data-time": string } {
  return { "data-time": String(time) };
}

const onScreen = (root: HTMLElement) => root.isConnected && root.getClientRects().length > 0;

/** Rewrites the relative times under `root` now (a view shown again); unchanged text isn't touched. */
export function refreshTimes(root: HTMLElement, now = Date.now()): void {
  const entry = roots.get(root);
  if (!entry) return;
  for (const el of root.querySelectorAll<HTMLElement>("[data-time]")) {
    const time = Number(el.dataset.time);
    if (!Number.isFinite(time)) continue;
    const text = entry.format(time, now);
    if (el.textContent !== text) el.textContent = text;
  }
}

function tick(): void {
  if (document.visibilityState !== "visible") return;
  const now = Date.now();
  for (const root of roots.keys()) if (onScreen(root)) refreshTimes(root, now);
}

/**
 * Keeps the relative times under `root` current until disposed. One timer serves every root, and
 * runs only while some root is registered.
 */
export function keepTimesCurrent(root: HTMLElement, format: TimeFormat): Disposable {
  roots.get(root)?.resize.disconnect();
  // A hidden root (a background tab, a closed sidebar) is skipped by the timer: it's brought up to
  // date when it's laid out again.
  const resize = new ResizeObserver(() => {
    if (onScreen(root)) refreshTimes(root);
  });
  resize.observe(root);
  roots.set(root, { format, resize });
  if (timer === undefined) {
    timer = setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", tick);
  }
  return toDisposable(() => {
    const entry = roots.get(root);
    if (entry?.resize !== resize) return;
    resize.disconnect();
    roots.delete(root);
    if (roots.size || timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
    document.removeEventListener("visibilitychange", tick);
  });
}
