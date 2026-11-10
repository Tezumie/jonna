// Recordings of what the agent does in the browser (D340), Claude in Chrome's gif_creator as
// browser_act start_recording / stop_recording: while a chat records, a frame is taken after each
// of its browser actions (a marker where it pointed, its action_summary as a caption) and every
// second; frames are the page screenshots the IDE takes anyway (browser.screenshot, only while
// the page is on screen: a recording never brings a tab forward). Each frame is encoded as it
// comes (core/image/gif.ts), so only the last one's pixels are kept. Stop shows the GIF in the
// chat as a card with Save; it's written into the workspace only when the user saves it
// (agent.saveRecording). Recordings live in memory until the IDE closes (the last 10).
// D354: the whole IDE window too (target "ide": the screenshot tool's record start / stop, or the
// user's workbench.recordGif for bug reports), with a marker and caption where the user clicked;
// a status bar item shows while the IDE is recorded and stops it.
import {
  captionOf,
  type Marker,
  RECORDING_LIMITS,
  recordingFileName,
  recordingLimit,
  recordingSize,
  recordingSummary,
  scaleMarker,
} from "../../core/agent/browserRecording";
import type { ToolOutcome } from "../../core/agent/loop";
import { GifWriter } from "../../core/image/gif";
import { attachIpc } from "../../core/ipc/agent";
import { fsIpc } from "../../core/ipc/fs";
import { openerIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { captureWindow, MODEL_MAX_SIDE } from "../../workbench/screenshot";
import type { WorkbenchServices } from "../../workbench/services";
import type { ToolHost } from "./tools";

/** What a recording shows: the browser tab, or the whole IDE window (D354). */
export type RecordingTarget = "browser" | "ide";
/** The user's own recordings (workbench.recordGif) are kept under this instead of a chat. */
export const USER_RECORDING = "user";

/** What starting a recording needs (a tool call's host, or the user's command). */
interface RecorderHost {
  session: string;
  services: WorkbenchServices;
}

interface Active {
  id: string;
  session: string;
  target: RecordingTarget;
  services: WorkbenchServices;
  started: number;
  writer: GifWriter | null;
  frame: { width: number; height: number } | null;
  timer: ReturnType<typeof setInterval>;
  /** Frames are taken one at a time, in order. */
  queue: Promise<void>;
  /** An interval frame is skipped while another is being taken. */
  busy: boolean;
  /** Frames the page wasn't on screen for (none taken). */
  missed: number;
}

export interface Recording {
  id: string;
  session: string;
  target: RecordingTarget;
  gif: Uint8Array;
  /** An object URL of the GIF for the chat's card. */
  url: string;
  width: number;
  height: number;
  frames: number;
  durationMs: number;
  created: number;
  /** Ended by a limit, not by stop_recording. */
  endedBy?: string;
}

const active = new Map<string, Active>();
const recordings = new Map<string, Recording>();
/** A recording a limit ended, by session, until stop_recording reports it. */
const endedAlone = new Map<string, string>();
/** The tool call that showed a recording, by its item id (its card). */
const byItem = new Map<string, string>();
let nextId = 1;
const KEEP = 10;
/** Bumped with every IDE frame and when a recording ends: the status bar item's time. */
const ideTick = signal(0);

export function isRecording(session: string): boolean {
  return active.has(session);
}

/** The recording a tool call (its item) showed, if it's still kept. */
export function recordingForItem(item: string): Recording | null {
  const id = byItem.get(item);
  return id ? (recordings.get(id) ?? null) : null;
}

export async function startRecording(
  host: RecorderHost,
  target: RecordingTarget = "browser",
): Promise<ToolOutcome> {
  const running = active.get(host.session);
  if (running)
    return {
      result: `Already recording ${running.target === "ide" ? "the IDE" : "the browser tab"} (${running.writer?.frameCount ?? 0} frames so far). ${stopHint(running.target)} ends it.`,
      summary: "already recording",
    };
  const a: Active = {
    id: `rec${nextId++}`,
    session: host.session,
    target,
    services: host.services,
    started: Date.now(),
    writer: null,
    frame: null,
    timer: setInterval(() => {
      if (!a.busy) void frame(a, null, "");
    }, RECORDING_LIMITS.intervalMs),
    queue: Promise.resolve(),
    busy: false,
    missed: 0,
  };
  active.set(host.session, a);
  endedAlone.delete(host.session);
  if (target === "ide") watchClicks();
  await frame(a, null, "");
  return {
    result:
      target === "ide"
        ? "Recording the IDE window: a frame every second, after each of your browser actions and where the user clicks. screenshot with record: stop ends it and shows the GIF to the user."
        : "Recording the browser tab: a frame after each browser action (set action_summary: it's the caption) and every second. browser_act stop_recording ends it and shows the GIF to the user.",
    summary: "recording",
  };
}

const stopHint = (target: RecordingTarget) =>
  target === "ide" ? "screenshot with record: stop" : "browser_act stop_recording";

/** The IDE window's recordings now (by a chat or the user). */
function ideRecordings(): Active[] {
  return [...active.values()].filter((a) => a.target === "ide");
}

let clickWatch: (() => void) | null = null;

/**
 * The user's clicks in the IDE while it's recorded (D354): a frame shortly after each, with a
 * marker where it was and what was clicked as the caption.
 */
function watchClicks(): void {
  if (clickWatch) return;
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.button !== 2) return;
    const at = { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight };
    const caption = clickCaption(e.target);
    // After the click has done what it does.
    setTimeout(() => {
      for (const a of ideRecordings()) {
        const f = a.frame ?? { width: 1, height: 1 };
        void frame(a, { kind: "click", x: at.x * f.width, y: at.y * f.height }, caption);
      }
    }, 150);
  };
  window.addEventListener("pointerdown", onDown, true);
  clickWatch = () => window.removeEventListener("pointerdown", onDown, true);
}

function stopWatchingClicks(): void {
  if (ideRecordings().length || !clickWatch) return;
  clickWatch();
  clickWatch = null;
}

/** "Clicked Run" from the element's label, title or text. */
function clickCaption(target: EventTarget | null): string {
  const el =
    target instanceof Element
      ? (target.closest("[aria-label], [title], button, a, [role]") ?? target)
      : null;
  const label =
    el?.getAttribute("aria-label") ||
    el?.getAttribute("title") ||
    (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const short = label.length > 50 ? `${label.slice(0, 49)}…` : label;
  return short ? `Clicked ${short}` : "Clicked";
}

/** A frame after a browser action of this chat, if it's recording. */
export async function recordAction(
  host: ToolHost,
  args: Record<string, unknown>,
  marker: Marker | null,
): Promise<void> {
  const a = active.get(host.session);
  // An IDE recording's frames aren't the page's coordinate frame: the caption only.
  if (a) await frame(a, a.target === "ide" ? null : marker, captionOf(args));
}

function frame(a: Active, marker: Marker | null, caption: string): Promise<void> {
  a.busy = true;
  a.queue = a.queue
    .then(() => (active.get(a.session) === a ? takeFrame(a, marker, caption) : undefined))
    .catch(() => {
      a.missed++;
    })
    .finally(() => {
      a.busy = false;
    });
  return a.queue;
}

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** A frame's picture: the page (only while it's on screen), or the IDE window. */
async function shotOf(a: Active): Promise<{
  png: Uint8Array;
  width: number;
  height: number;
  frame?: { width: number; height: number };
}> {
  if (a.target === "ide") {
    const shot = await captureWindow(undefined, MODEL_MAX_SIDE);
    ideTick.value++;
    return shot;
  }
  const shot = (await a.services.dispatcher.execute("browser.screenshot", {
    inline: true,
    save: false,
    ifShown: true,
  })) as { png: string; width: number; height: number; frame?: { width: number; height: number } };
  const bin = atob(shot.png);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { ...shot, png: bytes };
}

async function takeFrame(a: Active, marker: Marker | null, caption: string): Promise<void> {
  const shot = await shotOf(a);
  const at = Date.now() - a.started;
  const bitmap = await createImageBitmap(new Blob([shot.png as BlobPart], { type: "image/png" }));
  try {
    const frameSize = shot.frame ?? { width: shot.width, height: shot.height };
    if (!a.writer || !a.frame) {
      const size = recordingSize(frameSize);
      a.writer = new GifWriter(size.width, size.height);
      a.frame = frameSize;
    }
    const { width, height } = a.writer;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    // A page resized meanwhile (device mode) is fitted into the recording's size.
    const k = Math.min(width / bitmap.width, height / bitmap.height);
    const w = bitmap.width * k;
    const h = bitmap.height * k;
    ctx.fillStyle = token("--bg-surface");
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h);
    if (marker) drawMarker(ctx, scaleMarker(marker, frameSize, { width, height }));
    if (caption) drawCaption(ctx, caption, width, height);
    a.writer.add(ctx.getImageData(0, 0, width, height).data, at);
  } finally {
    bitmap.close();
  }
  const limit = recordingLimit({
    frames: a.writer.frameCount,
    elapsedMs: at,
    bytes: a.writer.size,
  });
  if (limit) {
    endedAlone.set(a.session, finish(a, limit).id);
  }
}

function drawMarker(ctx: CanvasRenderingContext2D, m: Marker): void {
  const accent = token("--accent");
  const ring = token("--fg-on-media");
  const dot = (x: number, y: number, r: number) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3;
    ctx.strokeStyle = ring;
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = accent;
    ctx.stroke();
  };
  if (m.kind === "drag") {
    ctx.beginPath();
    ctx.moveTo(m.fromX, m.fromY);
    ctx.lineTo(m.x, m.y);
    ctx.lineWidth = 3;
    ctx.strokeStyle = accent;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    dot(m.fromX, m.fromY, 7);
  }
  dot(m.x, m.y, m.kind === "hover" ? 8 : 12);
}

function drawCaption(ctx: CanvasRenderingContext2D, text: string, width: number, height: number) {
  const size = Math.max(11, Math.round(Math.min(width, height) / 32));
  const family = getComputedStyle(document.body).fontFamily || "sans-serif";
  ctx.font = `600 ${size}px ${family}`;
  const pad = Math.round(size * 0.6);
  const band = size + pad * 2;
  ctx.fillStyle = token("--media-scrim");
  ctx.fillRect(0, height - band, width, band);
  ctx.fillStyle = token("--fg-on-media");
  ctx.textBaseline = "middle";
  let shown = text;
  while (shown.length > 4 && ctx.measureText(shown).width > width - pad * 2)
    shown = `${shown.slice(0, -2)}…`;
  ctx.fillText(shown, pad, height - band / 2);
}

/** Ends a recording into a kept GIF. */
function finish(a: Active, endedBy?: string): Recording {
  clearInterval(a.timer);
  active.delete(a.session);
  stopWatchingClicks();
  ideTick.value++;
  if (!a.writer || a.writer.frameCount === 0)
    throw new Error(
      a.target === "ide"
        ? "No frames were captured: the IDE window couldn't be captured."
        : "No frames were captured: the page wasn't on screen while recording (keep its browser tab visible).",
    );
  const durationMs = Date.now() - a.started;
  const gif = a.writer.finish(durationMs + RECORDING_LIMITS.holdLastMs);
  const rec: Recording = {
    id: a.id,
    session: a.session,
    target: a.target,
    gif,
    url: URL.createObjectURL(new Blob([gif as BlobPart], { type: "image/gif" })),
    width: a.writer.width,
    height: a.writer.height,
    frames: a.writer.frameCount,
    durationMs,
    created: Date.now(),
    ...(endedBy && { endedBy }),
  };
  recordings.set(rec.id, rec);
  // Only the last few are kept.
  for (const old of [...recordings.values()].slice(0, -KEEP)) {
    URL.revokeObjectURL(old.url);
    recordings.delete(old.id);
  }
  return rec;
}

/** Ends a session's recording into its GIF (or returns the one a limit ended), else null. */
async function endRecording(session: string): Promise<Recording | null> {
  const a = active.get(session);
  let rec: Recording | null = null;
  if (a) {
    await a.queue;
    // The page as it ends.
    if (active.get(session) === a) await frame(a, null, "");
    const again = active.get(session);
    if (again === a) rec = finish(a);
  }
  const alone = endedAlone.get(session);
  if (!rec && alone) rec = recordings.get(alone) ?? null;
  endedAlone.delete(session);
  return rec;
}

export async function stopRecording(host: RecorderHost, itemId: string): Promise<ToolOutcome> {
  const rec = await endRecording(host.session);
  if (!rec)
    return {
      result:
        "Not recording: browser_act start_recording (the browser tab) or screenshot with record: start (the IDE window) starts one.",
      isError: true,
      summary: "not recording",
    };
  byItem.set(itemId, rec.id);
  const summary = recordingSummary({ ...rec, bytes: rec.gif.length });
  return {
    result: `Recorded ${summary}${rec.endedBy ? ` (it ended by itself at ${rec.endedBy})` : ""}. The GIF is shown to the user in the chat with Save; it isn't saved anywhere until they save it.`,
    summary,
  };
}

/** Stops every recording (the extension ends). */
export function disposeRecordings(): void {
  for (const a of active.values()) clearInterval(a.timer);
  active.clear();
  stopWatchingClicks();
  for (const r of recordings.values()) URL.revokeObjectURL(r.url);
  recordings.clear();
  byItem.clear();
  endedAlone.clear();
}

/** agent.saveRecording and ide://agent/recordings. */
export function registerRecordingCommands(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, workspace, notifications, state } = services;
  sub.add({ dispose: disposeRecordings });
  // D354: the user's own recording of the IDE (for a bug report), and Stop for any IDE recording.
  sub.add(
    dispatcher.register({
      id: "workbench.recordGif",
      title: "Record the IDE as a GIF",
      category: "Window",
      description:
        "Starts recording the IDE window as an animated GIF (a frame every second and after each click, with a marker and what was clicked), or stops it (`stop`, or run again): the GIF is offered to save into the project or download. Stopping also ends an agent's recording of the IDE.",
      input: s.object({
        stop: s.boolean().describe("Stop instead of toggling").optional(),
      }),
      effects: [],
      run: async ({ stop }) => {
        const running = ideRecordings();
        if (!running.length) {
          if (stop) return { recording: false };
          await startRecording({ session: USER_RECORDING, services }, "ide");
          return { recording: true };
        }
        let mine: Recording | null = null;
        for (const a of running) {
          const rec = await endRecording(a.session).catch(() => null);
          if (a.session === USER_RECORDING) mine = rec;
          // An agent's recording ended by the user: its stop_recording reports it.
          else if (rec) endedAlone.set(a.session, rec.id);
        }
        if (mine) {
          const id = mine.id;
          notifications.show(
            "info",
            `Recorded the IDE: ${recordingSummary({ ...mine, bytes: mine.gif.length })}.`,
            {
              actions: [
                {
                  label: "Save to project…",
                  run: () => void dispatcher.execute("agent.saveRecording", { id }).catch(() => {}),
                },
                {
                  label: "Download…",
                  run: () =>
                    void dispatcher
                      .execute("agent.saveRecording", { id, to: "file" })
                      .catch(() => {}),
                },
              ],
            },
          );
        }
        return {
          recording: false,
          ...(mine && { id: mine.id, frames: mine.frames, durationMs: mine.durationMs }),
        };
      },
    }),
  );
  const started = () => Math.min(...ideRecordings().map((a) => a.started));
  sub.add(
    services.statusBar.add({
      id: "workbench.recordGif",
      name: "Screen recording",
      alignment: "left",
      priority: 80,
      text: () => {
        ideTick.value;
        if (!ideRecordings().length) return "";
        const sec = Math.max(0, Math.round((Date.now() - started()) / 1000));
        return `$(circle-dot) Recording ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
      },
      tooltip: () => "The IDE window is being recorded as a GIF. Click to stop.",
      command: "workbench.recordGif",
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.saveRecording",
      title: "Save recording…",
      category: "Agent",
      description:
        "Saves a browser recording the agent made (an animated GIF, ide://agent/recordings) into the workspace at `path` (relative to the folder; asked when omitted), or anywhere through the system's save dialog with `to: file`. Refuses to overwrite a file.",
      input: s.object({
        id: s.string().describe("The recording's id (ide://agent/recordings)"),
        to: s
          .enum(["project", "file"] as const)
          .describe("Default: project")
          .optional(),
        path: s.string().describe("Where, relative to the open folder").optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ id, to, path }) => {
        const rec = recordings.get(id);
        if (!rec) throw new Error(`No recording ${id}: recordings are kept until the IDE closes.`);
        const name = recordingFileName(new Date(rec.created));
        if (to === "file") {
          const saved = await attachIpc.saveAs(name, rec.gif);
          if (!saved) return null;
          notifications.show("info", `Saved ${name}.`, {
            actions: [{ label: "Show in folder", run: () => void openerIpc.revealInOs(saved) }],
          });
          return { path: saved };
        }
        if (!workspace.root.peek()) throw new Error("Open a folder first, or save it as a file.");
        let rel = path?.trim();
        if (!rel) {
          const typed = await services.quickInput.prompt({
            prompt: "Save the recording in the project as (relative to the folder)",
            value: name,
            selection: [0, name.length - 4],
          });
          if (!typed?.trim()) return null;
          rel = typed.trim();
        }
        const full = workspace.resolve(rel);
        if (!workspace.contains(full)) throw new Error("The file must be inside the workspace.");
        const exists = await fsIpc.stat(full).then(
          () => true,
          () => false,
        );
        if (exists) throw new Error(`${rel} already exists.`);
        await fsIpc.write(full, rec.gif, "agent");
        notifications.show("info", `Saved ${workspace.relative(full)}.`);
        return { path: full };
      },
    }),
  );
  sub.add(
    state.register("ide://agent/recordings", {
      description:
        "Browser recordings the agent made (animated GIFs, D340), kept until the IDE closes: id, chat, frames, duration, size; and the chats recording now. agent.saveRecording saves one.",
      get: () => ({
        recording: [...active.values()].map((a) => ({
          session: a.session,
          target: a.target,
          frames: a.writer?.frameCount ?? 0,
          ms: Date.now() - a.started,
        })),
        recordings: [...recordings.values()].map((r) => ({
          id: r.id,
          session: r.session,
          target: r.target,
          frames: r.frames,
          durationMs: r.durationMs,
          width: r.width,
          height: r.height,
          bytes: r.gif.length,
          ...(r.endedBy && { endedBy: r.endedBy }),
        })),
      }),
    }),
  );
}
