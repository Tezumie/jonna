// Images a model or a tool made in the chat (D381): shown large under the reply or the work line
// (they're the result, not a step's detail), with rounded corners and their actions floating on
// them on hover: the id (what the agent calls it) top left, Add to project bottom left, Download
// bottom right; a click opens the viewer. While generate_image works, a placeholder of the
// image's shape says "Creating image" over a field of dots that shimmers. After a restart the
// transcript has a preview; the actions and the viewer use the whole image from the chat's media
// folder.
import { type ChatImage, imageFileName } from "../../../core/agent/chatImages";
import { h, on } from "../../../core/dom/index";
import { type IconName, icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import { chatImageBytes } from "../chatImageTools";
import { type AttachmentData, attachmentActions, openViewer, type ViewerItem } from "./shots";

/** An image being made: the size it was asked for ("1536x1024"), when given. */
export interface PendingImage {
  size?: string;
}

/** What the chat shows for `img`: the whole image while in memory, else its preview. */
function shownSrc(img: ChatImage): string | null {
  if (img.data) return `data:${img.mime};base64,${img.data}`;
  return img.preview ?? null;
}

/** The whole image as a data: URL (the preview if that's all there is). */
async function fullSrc(chat: string, img: ChatImage): Promise<string | null> {
  const bytes = await chatImageBytes(chat, img);
  return bytes && `data:${bytes.mime};base64,${bytes.data}`;
}

/** A key that changes when the gallery would look different. */
export function galleryKey(
  images: readonly ChatImage[] | undefined,
  pending: readonly PendingImage[] = [],
): string {
  const shown = (images ?? []).map((i) => `${i.id}:${i.data ? "d" : i.preview ? "p" : "-"}`);
  return `${shown.join(",")}|${pending.map((p) => p.size ?? "").join(",")}`;
}

/** "1536x1024" → "1536 / 1024" for aspect-ratio (square when it isn't a size). */
export function aspectOf(size: string | undefined): string {
  const m = /^\s*(\d{2,5})\s*[x×:]\s*(\d{2,5})\s*$/i.exec(size ?? "");
  return m ? `${m[1]} / ${m[2]}` : "1 / 1";
}

/** The placeholder while an image is made. */
function pendingCard(p: PendingImage): HTMLElement {
  return h(
    "div",
    { class: "agent-image-pending", role: "status" },
    h("span", { class: "agent-image-pending-label" }, "Creating image"),
    h("div", {
      class: "agent-image-dots",
      style: { "aspect-ratio": aspectOf(p.size) },
      "aria-hidden": "true",
    }),
  );
}

/** The gallery for `images` of chat `chat` (and placeholders for `pending`), or null if empty. */
export function chatImageGallery(
  chat: string,
  images: readonly ChatImage[],
  pending: readonly PendingImage[] = [],
): HTMLElement | null {
  const shown = images
    .map((img) => ({ img, src: shownSrc(img) }))
    .filter((x): x is { img: ChatImage; src: string } => x.src !== null);
  if (!shown.length && !pending.length) return null;
  const items: ViewerItem[] = shown.map(({ img, src }) => ({
    kind: "image",
    image: src,
    caption: img.source ? `${img.id} · ${img.source}` : img.id,
    name: imageFileName(img),
    full: () => fullSrc(chat, img),
  }));
  /** Runs an action on the whole image. */
  const act = (img: ChatImage, run: (a: AttachmentData) => void) => {
    void fullSrc(chat, img).then((data) => {
      if (data) run({ name: imageFileName(img), kind: "image", data });
    });
  };
  const floating = (
    cls: string,
    glyph: IconName,
    label: string,
    run: () => void,
    text?: string,
  ): HTMLElement => {
    const b = h(
      "button",
      { class: `agent-image-float ${cls}`, type: "button", "aria-label": label },
      icon(glyph),
      text ? h("span", null, text) : null,
    );
    if (!text) setTooltip(b, label);
    on(b, "click", (e) => {
      e.stopPropagation();
      run();
    });
    return b;
  };
  return h(
    "div",
    { class: "agent-images" },
    ...shown.map(({ img, src }, i) => {
      const actions = attachmentActions();
      const open = h(
        "button",
        { class: "agent-image-open", type: "button", "aria-label": `Show ${img.id}` },
        h("img", { src, alt: img.name ?? img.id, draggable: "false" }),
      );
      on(open, "click", () => openViewer(items, i));
      return h(
        "figure",
        { class: "agent-image", "data-image": img.id },
        open,
        h("span", { class: "agent-image-id" }, img.id),
        actions
          ? floating(
              "agent-image-add",
              "file-down",
              "Add to project…",
              () => act(img, (a) => actions.addToProject(a)),
              "Add to project",
            )
          : null,
        actions
          ? floating("agent-image-save", "download", "Download…", () =>
              act(img, (a) => actions.save(a)),
            )
          : null,
      );
    }),
    ...pending.map(pendingCard),
  );
}

/** A running generate_image call's placeholder (none for anything else). */
export function pendingImages(item: {
  type: string;
  name?: string;
  status?: string;
  args?: unknown;
}): PendingImage[] {
  if (item.type !== "tool" || item.name !== "generate_image" || item.status !== "running")
    return [];
  const size = (item.args as { size?: unknown } | undefined)?.size;
  return [typeof size === "string" ? { size } : {}];
}
