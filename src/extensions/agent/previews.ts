// Saved previews of a chat's images (D156). Screenshots and pasted images are kept in memory as
// full PNGs (vision models get the newest ones) and dropped on save, so a chat opened the next
// day showed none. Each now gets a small compressed copy (WebP, at most 1280 px wide) saved with
// the chat, for the person only: the model never sees previews. A chat keeps the newest
// MAX_PREVIEWS of them.
import type { Item } from "../../core/agent/conversation";
import { agentStoreIpc } from "../../core/ipc/agent";

/** Previews kept per chat (the oldest go first). */
export const MAX_PREVIEWS = 40;
const MAX_WIDTH = 1280;
const QUALITY = 0.72;

/** A compressed data: URL of a base64 image (itself as a data: URL if that fails). */
export async function compressImage(png: string, mime = "image/png"): Promise<string> {
  const fallback = `data:${mime};base64,${png}`;
  // A drawing stays a drawing (small, and a bitmap would blur it).
  if (mime === "image/svg+xml" && png.length < 400_000) return fallback;
  try {
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    const scale = Math.min(1, MAX_WIDTH / bitmap.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const webp = canvas.toDataURL("image/webp", QUALITY);
    // An engine without WebP encoding returns PNG: JPEG then (screenshots compress well).
    const out = webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", QUALITY);
    return out.length < fallback.length ? out : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Chat images made by models and tools (D381): kept whole in the chat's media folder (once),
 * and a preview each for the transcript. `chat` is the chat's id.
 */
export async function keepChatImages(chat: string, items: readonly Item[]): Promise<boolean> {
  let changed = false;
  for (const it of items) {
    if ((it.type !== "assistant" && it.type !== "tool") || !it.media) continue;
    for (const img of it.media) {
      if (!img.data) continue;
      if (!img.stored) {
        const ok = await agentStoreIpc.mediaPut(chat, img.id, img.data).then(
          () => true,
          () => false,
        );
        if (ok) {
          img.stored = true;
          changed = true;
        }
      }
      if (!img.preview) {
        img.preview = await compressImage(img.data, img.mime);
        changed = true;
      }
    }
  }
  return changed;
}

/** Items with images and no previews yet get them (newest first, within the limit). */
export async function addPreviews(items: readonly Item[]): Promise<boolean> {
  let changed = false;
  let budget = MAX_PREVIEWS;
  for (let i = items.length - 1; i >= 0 && budget > 0; i--) {
    const it = items[i];
    if (!it || (it.type !== "user" && it.type !== "tool")) continue;
    const images = it.images ?? [];
    if (images.length && (it.previews?.length ?? 0) !== images.length) {
      it.previews = await Promise.all(images.map((png) => compressImage(png)));
      changed = true;
    }
    budget -= it.previews?.length ?? 0;
  }
  return changed;
}

/**
 * The items as saved: full images dropped, previews kept for the newest MAX_PREVIEWS images
 * (older ones dropped too).
 */
export function itemsForSaving(items: readonly Item[]): Item[] {
  let budget = MAX_PREVIEWS;
  // Before the newest summary the model never sees the items again (only the chat shows them):
  // what only the model used is trimmed, so long chats don't save megabytes each time (D163).
  const summarized = items.findLastIndex((it) => it.type === "summary");
  const out: Item[] = new Array(items.length);
  for (let i = items.length - 1; i >= 0; i--) {
    let it = trimmed(items[i] as Item, i < summarized);
    // Chat images (D381): the bytes are in the media folder once stored; the preview stays.
    if (
      (it.type === "assistant" || it.type === "tool") &&
      it.media?.some((m) => m.data && m.stored)
    )
      it = {
        ...it,
        media: it.media.map((m) => {
          if (!m.stored) return m;
          const { data: _data, ...rest } = m;
          return rest;
        }),
      };
    if (it.type !== "user" && it.type !== "tool") {
      // A tool call still being written isn't kept (a widget's code so far can be large, D355).
      if (it.type === "assistant" && it.toolDraft) {
        const { toolDraft: _draft, ...rest } = it;
        out[i] = rest;
      } else out[i] = it;
      continue;
    }
    const { images: _images, previews, ...rest } = it;
    const keep = previews?.length && budget >= previews.length ? previews : undefined;
    if (keep) budget -= keep.length;
    out[i] = { ...rest, ...(keep && { previews: keep }) } as Item;
  }
  return out;
}

/** Kept of a tool's result before the newest summary (the row shows `detail`). */
const SUMMARIZED_RESULT_CHARS = 2000;

function trimmed(it: Item, summarized: boolean): Item {
  if (!summarized) return it;
  if (it.type === "user") {
    const { context: _context, state: _state, ...rest } = it;
    return {
      ...rest,
      ...(it.attachments && {
        attachments: it.attachments.map(({ text: _text, ...a }) => a),
      }),
    };
  }
  if (it.type === "tool" && it.result && it.result.length > SUMMARIZED_RESULT_CHARS)
    return { ...it, result: `${it.result.slice(0, SUMMARIZED_RESULT_CHARS)}\n… (trimmed)` };
  if (it.type === "assistant" && it.reasoning) {
    const { reasoning: _reasoning, ...rest } = it;
    return rest;
  }
  return it;
}

/**
 * A saved preview as a PNG (base64), for sending again (D159): retrying or editing a message
 * after a restart, when its full images are gone. Every provider takes PNG; the preview is
 * WebP / JPEG, so it's re-encoded. Null if it can't be decoded.
 */
export async function previewAsPng(preview: string): Promise<string | null> {
  if (!preview.startsWith("data:")) return preview;
  try {
    const blob = await (await fetch(preview)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    bitmap.close();
    const url = canvas.toDataURL("image/png");
    const comma = url.indexOf(",");
    return comma > 0 ? url.slice(comma + 1) : null;
  } catch {
    return null;
  }
}

/** A message's images to send again: the full ones, else PNGs of its saved previews. */
export async function imagesToResend(item: {
  images?: string[];
  previews?: string[];
}): Promise<string[]> {
  if (item.images?.length) return item.images;
  if (!item.previews?.length) return [];
  const pngs = await Promise.all(item.previews.map(previewAsPng));
  return pngs.filter((p): p is string => p !== null);
}
