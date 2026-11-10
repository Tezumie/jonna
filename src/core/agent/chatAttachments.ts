// What the user attached earlier in a chat (D211), for the chat_attachments tool. Images are kept
// in memory only (full PNGs) and saved as small previews, so after a restart the model has no
// copy of them; text attachments keep their text for the viewer. DOM-free; tested.
import type { Item } from "./conversation";

export interface ChatAttachment {
  /** "m<message>-<n>": the user message's number in the chat (from 1) and the attachment's. */
  id: string;
  message: number;
  name: string;
  kind: "image" | "text" | "file" | "mention";
  /** What can be returned: the full image, its saved preview, the text, or nothing. */
  content: "image" | "preview" | "text" | "none";
  /** The full PNG (base64), a preview data: URL, or the text. */
  data?: string;
}

/** Every attachment of the chat's user messages, oldest first. */
export function listChatAttachments(items: readonly Item[]): ChatAttachment[] {
  const out: ChatAttachment[] = [];
  let message = 0;
  for (const it of items) {
    if (it.type !== "user" || it.auto) continue;
    message++;
    let image = 0;
    (it.attachments ?? []).forEach((a, n) => {
      const id = `m${message}-${n + 1}`;
      if (a.kind === "image") {
        const full = it.images?.[image];
        const preview = it.previews?.[image];
        image++;
        out.push({
          id,
          message,
          name: a.name,
          kind: "image",
          content: full ? "image" : preview ? "preview" : "none",
          ...((full ?? preview) && { data: full ?? preview }),
        });
      } else {
        out.push({
          id,
          message,
          name: a.name,
          kind: a.kind,
          content: a.text ? "text" : "none",
          ...(a.text && { data: a.text }),
        });
      }
    });
    // Pasted images without attachment cards (older chats): one entry each.
    const listed = (it.attachments ?? []).filter((a) => a.kind === "image").length;
    const images = Math.max(it.images?.length ?? 0, it.previews?.length ?? 0);
    for (let i = listed; i < images; i++) {
      const full = it.images?.[i];
      const preview = it.previews?.[i];
      out.push({
        id: `m${message}-img${i + 1}`,
        message,
        name: `Image ${i + 1}`,
        kind: "image",
        content: full ? "image" : preview ? "preview" : "none",
        ...((full ?? preview) && { data: full ?? preview }),
      });
    }
  }
  return out;
}

/**
 * A note for a user message whose images the model no longer has (after a restart): what was
 * attached, and how to look.
 */
export function missingImagesNote(it: Item): string | null {
  if (it.type !== "user" || it.images?.length) return null;
  const names = (it.attachments ?? []).filter((a) => a.kind === "image").map((a) => a.name);
  const count = Math.max(names.length, it.previews?.length ?? 0);
  if (!count) return null;
  const list = names.length ? `: ${names.join(", ")}` : "";
  return `(The user attached ${count} image${count === 1 ? "" : "s"} here${list}. You don't have ${count === 1 ? "it" : "them"} in this context any more; use the chat_attachments tool to look.)`;
}
