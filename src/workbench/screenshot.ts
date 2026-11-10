// Screenshots of the running IDE and its browser pages (D96): the native side renders a window's
// webview to a PNG (screenshot_window); here it is cropped to an element (a browser tab's page),
// scaled down for models, and saved under the workspace's IDE folder when asked.
import { browserIpc } from "../core/ipc/browser";
import { fsIpc } from "../core/ipc/fs";
import { workspaceFolderName } from "./workspaceFolder";

export interface Shot {
  png: Uint8Array;
  width: number;
  height: number;
}

/** Long side for images sent to models: enough to read UI text, a fraction of the tokens. */
export const MODEL_MAX_SIDE = 1568;

async function bitmapOf(png: Uint8Array): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
}

async function encode(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Couldn't encode the screenshot.");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Draws `source` (a region of it, in its pixels) into a new PNG no larger than `maxSide`. */
async function render(
  source: ImageBitmap,
  region: { x: number; y: number; w: number; h: number },
  maxSide?: number,
): Promise<Shot> {
  const scale = maxSide ? Math.min(1, maxSide / Math.max(region.w, region.h)) : 1;
  return renderSized(source, region, region.w * scale, region.h * scale);
}

/** `region` of a screenshot (in its pixels) drawn at `width`×`height` (a zoom, or scaled down). */
export async function cropShot(
  shot: Shot,
  region: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
): Promise<Shot> {
  const bitmap = await bitmapOf(shot.png);
  try {
    return await renderSized(bitmap, region, width, height);
  } finally {
    bitmap.close();
  }
}

async function renderSized(
  source: ImageBitmap,
  region: { x: number; y: number; w: number; h: number },
  w: number,
  h: number,
): Promise<Shot> {
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't draw the screenshot.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, width, height);
  return { png: await encode(canvas), width, height };
}

/** A whole window: the IDE (default) or a browser window by label. */
export async function captureWindow(label?: string, maxSide?: number): Promise<Shot> {
  const bitmap = await bitmapOf(await browserIpc.screenshot(label));
  try {
    return await render(bitmap, { x: 0, y: 0, w: bitmap.width, h: bitmap.height }, maxSide);
  } finally {
    bitmap.close();
  }
}

/**
 * Part of a window: `rect` in CSS pixels (e.g. an iframe's bounding rect) of the IDE window, or
 * of an auxiliary window (`win` + its native `label`).
 */
export async function captureRect(
  rect: DOMRect,
  maxSide?: number,
  target: { win: Window; label: string } | null = null,
): Promise<Shot> {
  const bitmap = await bitmapOf(await browserIpc.screenshot(target?.label));
  const win = target?.win ?? window;
  try {
    // The snapshot is the viewport in device pixels.
    const sx = bitmap.width / win.innerWidth;
    const sy = bitmap.height / win.innerHeight;
    const x = Math.max(0, Math.round(rect.left * sx));
    const y = Math.max(0, Math.round(rect.top * sy));
    const w = Math.min(bitmap.width - x, Math.round(rect.width * sx));
    const h = Math.min(bitmap.height - y, Math.round(rect.height * sy));
    if (w <= 0 || h <= 0) throw new Error("Nothing to capture: the element isn't on screen.");
    return await render(bitmap, { x, y, w, h }, maxSide);
  } finally {
    bitmap.close();
  }
}

/** Waits for layout and paint after showing something (two frames). */
export const nextPaint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

export function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/** Saves under `<folder>/<workspace folder name>/screenshots/` and returns the path. */
export async function saveShot(root: string, name: string, shot: Shot): Promise<string> {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const path = [
    root.replace(/[\\/]+$/, ""),
    workspaceFolderName(),
    "screenshots",
    `${name}-${stamp}.png`,
  ].join(sep);
  await fsIpc.write(path, shot.png, "screenshot");
  // Kept out of git, as the debug browser's profile is: screenshots of the IDE aren't the
  // project's changes (they showed up in Source control and its counts).
  const ignore = `${path.slice(0, path.lastIndexOf(sep))}${sep}.gitignore`;
  const ignored = await fsIpc.stat(ignore).then(
    () => true,
    () => false,
  );
  if (!ignored)
    await fsIpc.write(ignore, new TextEncoder().encode("*\n"), "screenshot").catch(() => {});
  return path;
}
