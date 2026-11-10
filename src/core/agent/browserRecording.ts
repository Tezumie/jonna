// Recordings of the agent in the browser tab (D340), after Claude in Chrome's gif_creator:
// browser_act start_recording / stop_recording. Frames are the page screenshots the IDE already
// takes, one after each browser action (with a marker where it pointed and its action_summary as
// a caption) and one a second while nothing happens; stop makes an animated GIF (core/image/gif.ts)
// shown in the chat with Save. What a frame shows and the limits are decided here. DOM-free and
// tested.
import { actLabel } from "./browserInput";

export const RECORDING_LIMITS = {
  /** A frame this often while recording, besides one after each action. */
  intervalMs: 1000,
  /** The GIF's long side: enough to read a page, a fraction of the bytes. */
  maxSide: 960,
  maxFrames: 300,
  /** A recording ends by itself after this long (a turn that forgot to stop it). */
  maxMs: 5 * 60_000,
  /** And when the GIF reaches this size. */
  maxBytes: 30 * 1024 * 1024,
  /** The last frame stays on screen this long before the loop starts again. */
  holdLastMs: 1500,
} as const;

/** The GIF's size for a page frame: scaled down to `maxSide`, never up. */
export function recordingSize(
  frame: { width: number; height: number },
  maxSide: number = RECORDING_LIMITS.maxSide,
): { width: number; height: number } {
  const k = Math.min(1, maxSide / Math.max(1, frame.width, frame.height));
  return {
    width: Math.max(1, Math.round(frame.width * k)),
    height: Math.max(1, Math.round(frame.height * k)),
  };
}

/** Where an action pointed, in the screenshot's coordinate frame. */
export type Marker =
  | { kind: "click" | "hover" | "scroll" | "upload"; x: number; y: number }
  | { kind: "drag"; x: number; y: number; fromX: number; fromY: number };

const POINTER_KIND: Record<string, Marker["kind"]> = {
  click: "click",
  left_click: "click",
  right_click: "click",
  double_click: "click",
  triple_click: "click",
  hover: "hover",
  mouse_move: "hover",
  scroll: "scroll",
  drag: "drag",
  left_click_drag: "drag",
  upload: "upload",
};

const pointOf = (v: unknown): [number, number] | null =>
  Array.isArray(v) &&
  v.length === 2 &&
  typeof v[0] === "number" &&
  typeof v[1] === "number" &&
  Number.isFinite(v[0]) &&
  Number.isFinite(v[1])
    ? [v[0], v[1]]
    : null;

/** The marker a browser_act call's own arguments give (a coordinate), or null. */
export function markerOf(args: Record<string, unknown>): Marker | null {
  const kind = POINTER_KIND[String(args.action ?? "")];
  const at = pointOf(args.coordinate);
  if (!kind || !at) return null;
  if (kind === "drag") {
    const from = pointOf(args.start_coordinate);
    return from ? { kind, x: at[0], y: at[1], fromX: from[0], fromY: from[1] } : null;
  }
  return { kind, x: at[0], y: at[1] };
}

/**
 * Whether the marker has to be looked up on the page first: a pointer action on an element (a
 * ref, selector or name), whose place only the page knows.
 */
export function needsLocate(args: Record<string, unknown>): boolean {
  const kind = POINTER_KIND[String(args.action ?? "")];
  return (
    !!kind &&
    kind !== "drag" &&
    !pointOf(args.coordinate) &&
    (typeof args.ref === "string" ||
      typeof args.selector === "string" ||
      typeof args.name === "string")
  );
}

/** A marker in the GIF's pixels (the frame is drawn scaled to the recording's size). */
export function scaleMarker(
  m: Marker,
  frame: { width: number; height: number },
  out: { width: number; height: number },
): Marker {
  const sx = out.width / Math.max(1, frame.width);
  const sy = out.height / Math.max(1, frame.height);
  return m.kind === "drag"
    ? { ...m, x: m.x * sx, y: m.y * sy, fromX: m.fromX * sx, fromY: m.fromY * sy }
    : { ...m, x: m.x * sx, y: m.y * sy };
}

/** The caption under a frame after an action: its action_summary, else what it did. */
export function captionOf(args: Record<string, unknown>): string {
  const label = actLabel(args);
  const text = label.charAt(0).toUpperCase() + label.slice(1);
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}

/** Why a recording has to end now, or null. */
export function recordingLimit(r: {
  frames: number;
  elapsedMs: number;
  bytes: number;
}): string | null {
  if (r.frames >= RECORDING_LIMITS.maxFrames) return `${RECORDING_LIMITS.maxFrames} frames`;
  if (r.elapsedMs >= RECORDING_LIMITS.maxMs) return `${RECORDING_LIMITS.maxMs / 60_000} minutes`;
  if (r.bytes >= RECORDING_LIMITS.maxBytes) return `${RECORDING_LIMITS.maxBytes / 1024 / 1024} MB`;
  return null;
}

/** "12 frames · 8.4 s · 640×400 · 1.2 MB" */
export function recordingSummary(r: {
  frames: number;
  durationMs: number;
  width: number;
  height: number;
  bytes: number;
}): string {
  const size =
    r.bytes >= 1024 * 1024
      ? `${(r.bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(r.bytes / 1024))} KB`;
  return `${r.frames} frame${r.frames === 1 ? "" : "s"} · ${(r.durationMs / 1000).toFixed(1)} s · ${r.width}×${r.height} · ${size}`;
}

/** A file name for a recording made at `date`: recording-2026-11-06-14-05-09.gif */
export function recordingFileName(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `recording-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}.gif`;
}

/**
 * The call that ended a recording, drawn in the chat with the recording's card: a browser_act
 * stop_recording, or a browser_batch with one among its steps.
 */
export function isRecordingStop(name: string, args: unknown): boolean {
  const a = (args && typeof args === "object" ? args : {}) as {
    action?: unknown;
    actions?: unknown;
  };
  if (name === "browser_act") return a.action === "stop_recording";
  // D354: the screenshot tool's record: stop (the IDE window or the tab).
  if (name === "screenshot") return (a as { record?: unknown }).record === "stop";
  return (
    name === "browser_batch" &&
    Array.isArray(a.actions) &&
    a.actions.some((step: unknown) => {
      const s = (step && typeof step === "object" ? step : {}) as {
        name?: unknown;
        input?: { action?: unknown } | null;
      };
      return s.name === "browser_act" && s.input?.action === "stop_recording";
    })
  );
}
