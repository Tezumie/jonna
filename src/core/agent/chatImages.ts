// Images in a chat that the agent or a tool made (D381): a model's reply that draws (OpenRouter's
// image models), an MCP tool's image, generate_image, an external agent's message. Each has an id
// for the chat ("img3"): the model is told it, save_image puts it in the project by it, and the
// chat keeps the image whole in its media folder (a small preview in the transcript). DOM-free.
import type { Item } from "./conversation";

export interface ChatImage {
  /** "img1", "img2"… in the chat, never reused. */
  id: string;
  /** Its media type (image/png, image/jpeg, image/webp, image/svg+xml…). */
  mime: string;
  /** Base64 bytes, while in memory; gone from a saved chat (kept in its media folder). */
  data?: string;
  /** A small data: URL saved with the chat, for showing it (D156's previews). */
  preview?: string;
  /** Its bytes are in the chat's media folder. */
  stored?: boolean;
  /** A file name it suggests ("logo.png"), when its maker gave one. */
  name?: string;
  /** What made it ("generate_image", an MCP tool's name, a model). */
  source?: string;
}

const ID = /^img(\d+)$/;

/** Every chat image, oldest first. */
export function chatImages(items: readonly Item[]): ChatImage[] {
  const out: ChatImage[] = [];
  for (const it of items)
    if ((it.type === "assistant" || it.type === "tool") && it.media) out.push(...it.media);
  return out;
}

/** The next free id ("img4" after img3), whatever was removed in between. */
export function nextImageId(items: readonly Item[]): string {
  let max = 0;
  for (const img of chatImages(items)) {
    const n = Number(ID.exec(img.id)?.[1] ?? 0);
    if (n > max) max = n;
  }
  return `img${max + 1}`;
}

/** The image `id` names ("img3", or "3"), or undefined. */
export function findChatImage(items: readonly Item[], id: string): ChatImage | undefined {
  const want = /^\d+$/.test(id.trim()) ? `img${id.trim()}` : id.trim().toLowerCase();
  return chatImages(items).find((img) => img.id === want);
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

/** A file extension for `mime` ("png" when unknown). */
export function imageExt(mime: string): string {
  return EXT[mime.toLowerCase()] ?? "png";
}

/** The media type a file name asks for (by its extension), or null when it isn't an image. */
export function mimeForPath(path: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (!ext) return null;
  if (ext === "jpeg") return "image/jpeg";
  return Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? null;
}

/** A file name for the image: the one it came with, else `<id>.<ext>`. */
export function imageFileName(img: ChatImage): string {
  return img.name?.trim() || `${img.id}.${imageExt(img.mime)}`;
}

/** What the model reads about images in a message or a tool's result (it can't see them all). */
export function imageNote(images: readonly ChatImage[]): string {
  if (!images.length) return "";
  const list = images.map((i) => `${i.id} (${imageExt(i.mime)})`).join(", ");
  return `[Image${images.length === 1 ? "" : "s"} ${list} shown to the user. To put one in the project, call save_image with its id and a path.]`;
}
