// chat_attachments (D211): the images and files the user attached earlier in this chat. After a
// restart the model has no copy of earlier images (only previews are saved), and older text may
// have left the context; the user asking "what was in that screenshot?" no longer works blind.

import { listChatAttachments } from "../../core/agent/chatAttachments";
import type { Item } from "../../core/agent/conversation";
import type { AgentTool } from "./tools";
import { pngBase64 } from "./uploads";

const MAX_TEXT = 20_000;

/** A data: URL's image as base64 PNG (what the model takes), or null. Decoded here: the
 * window's CSP doesn't allow fetching data: URLs. */
async function previewPng(dataUrl: string): Promise<string | null> {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  try {
    const bytes = Uint8Array.from(atob(m[2] ?? ""), (c) => c.charCodeAt(0));
    return await pngBase64(new Blob([bytes], { type: m[1] }));
  } catch {
    return null;
  }
}

export function chatAttachmentsTool(items: () => readonly Item[]): AgentTool {
  return {
    spec: {
      name: "chat_attachments",
      description:
        "The images and files the user attached earlier in this chat. Earlier images may not be in your context (after a restart only small previews are kept), so when the user refers to an attachment you can't see, look here. {} lists them (id, message number, name, kind, what's available); { id } returns one: an image as an image, a text file or paste as text.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "An id from the list (m3-1: message 3, attachment 1)",
          },
        },
        required: [],
      },
    },
    readOnly: true,
    verb: "Looked at",
    target: (a) => (typeof a.id === "string" && a.id ? a.id : "attachments"),
    async run(args) {
      const all = listChatAttachments(items());
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) {
        if (!all.length) return { result: "No attachments in this chat.", summary: "none" };
        const lines = all.map(
          (a) =>
            `${a.id} — message ${a.message}, ${a.kind}: ${a.name}${a.content === "none" ? " (not kept)" : a.content === "preview" ? " (preview copy)" : ""}`,
        );
        return { result: lines.join("\n"), summary: `${all.length} attachment(s)` };
      }
      const a = all.find((x) => x.id === id);
      if (!a)
        return { result: `No attachment ${id}. Call with {} for the list.`, summary: "not found" };
      if (a.content === "none" || !a.data)
        return { result: `${a.name} wasn't kept with the chat.`, summary: a.name };
      if (a.content === "text") {
        const cut = a.data.length > MAX_TEXT;
        return {
          result: `${a.name}:\n${cut ? `${a.data.slice(0, MAX_TEXT)}\n… (cut)` : a.data}`,
          summary: a.name,
        };
      }
      const png = a.content === "image" ? a.data : await previewPng(a.data);
      if (!png) return { result: `${a.name} couldn't be read.`, summary: a.name };
      return {
        result: `${a.name} (message ${a.message})${a.content === "preview" ? ", a reduced copy saved with the chat" : ""}. The image is attached; if you can't see images, say so.`,
        summary: a.name,
        images: [png],
      };
    },
  };
}
