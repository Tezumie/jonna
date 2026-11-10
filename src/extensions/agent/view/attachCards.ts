// Attachment cards (D131): images as thumbnails, files and big pastes as a text preview with a
// type badge and line count. Above the message box (removable) and above sent messages.
import { badgeOf, previewOf } from "../../../core/agent/attachments";
import { h } from "../../../core/dom/index";
import { type IconName, icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import { imageSrc, openViewer, type ViewerItem } from "./shots";

export interface CardData {
  kind: "image" | "text" | "file" | "mention";
  name: string;
  /** Text to preview (the start is shown). */
  preview?: string;
  lines?: number;
  pasted?: boolean;
  /** Base64 PNG for image cards. */
  image?: string;
  /** Mentions: their icon. */
  icon?: IconName;
}

/**
 * One card; `onRemove` adds the × (composer cards), `onOpen` makes it open the viewer (D158).
 * Mentions are small chips.
 */
export function attachmentCard(
  a: CardData,
  onRemove?: () => void,
  onOpen?: () => void,
  onSave?: () => void,
  onDownload?: () => void,
): HTMLElement {
  // Download (D211): a sent attachment saved anywhere through the system dialog.
  const download = onDownload
    ? (() => {
        const b = h(
          "button",
          {
            class: "agent-card-remove agent-card-save",
            type: "button",
            "aria-label": `Download ${a.name}`,
          },
          icon("download"),
        );
        setTooltip(b, "Download…");
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          onDownload();
        });
        return b;
      })()
    : null;
  // "Add to project" beside the × (D196): an image or an outside file saved into the folder.
  const save = onSave
    ? (() => {
        const b = h(
          "button",
          {
            class: "agent-card-remove agent-card-save",
            type: "button",
            "aria-label": `Add ${a.name} to the project`,
          },
          icon("file-down"),
        );
        setTooltip(b, "Add to project…");
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          onSave();
        });
        return b;
      })()
    : null;
  const remove = onRemove
    ? (() => {
        const b = h(
          "button",
          { class: "agent-card-remove", type: "button", "aria-label": `Remove ${a.name}` },
          icon("x"),
        );
        setTooltip(b, "Remove");
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          onRemove();
        });
        return b;
      })()
    : null;
  if (a.kind === "mention") {
    const chip = h(
      "span",
      { class: "agent-chip" },
      icon(a.icon ?? "at-sign"),
      h("span", null, a.name),
      remove,
    );
    setTooltip(chip, a.name);
    return chip;
  }
  const isImage = a.kind === "image";
  const lines = a.lines ?? 0;
  const meta = !isImage && !a.pasted && lines ? `${lines} line${lines === 1 ? "" : "s"}` : "";
  const preview = !isImage && a.preview ? previewOf(a.preview, 300) : "";
  const shortName = a.name.split(/[\\/]/).pop() ?? a.name;
  const card = h(
    "div",
    {
      class: {
        "agent-card": true,
        "is-pasted": !!a.pasted,
        "is-image": isImage,
        "is-openable": !!onOpen,
      },
      "data-kind": isImage ? "image" : "file",
      ...(onOpen && { role: "button", tabindex: "0" }),
    },
    isImage && a.image
      ? h("div", { class: "agent-card-thumb" }, h("img", { src: imageSrc(a.image), alt: "" }))
      : null,
    isImage && !a.image ? h("span", { class: "agent-card-gone" }, icon("image")) : null,
    save || remove || download
      ? h("div", { class: "agent-card-actions" }, download, save, remove)
      : null,
    preview ? h("div", { class: "agent-card-preview" }, preview) : null,
    h(
      "div",
      { class: "agent-card-foot" },
      a.pasted ? null : h("div", { class: "agent-card-name" }, shortName),
      h(
        "div",
        { class: "agent-card-row" },
        h("span", { class: "agent-card-badge" }, badgeOf(a)),
        meta ? h("span", { class: "agent-card-meta" }, meta) : null,
      ),
    ),
  );
  if (onOpen) {
    card.addEventListener("click", onOpen);
    card.addEventListener("keydown", (e) => {
      // Enter on its own buttons (Remove, Download…) is theirs: this used to cancel their click
      // and open the viewer instead.
      if (e.target !== card) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onOpen();
      }
    });
  }
  setTooltip(
    card,
    a.pasted
      ? `Pasted text${lines ? ` · ${lines} lines` : ""}`
      : isImage && !a.image
        ? `${a.name} (images aren't kept with saved chats)`
        : a.name,
  );
  return card;
}

/** What the viewer shows for an attachment (null: nothing to show, e.g. an image not kept). */
export function viewerItem(a: CardData & { text?: string }): ViewerItem | null {
  if (a.kind === "mention") return null;
  if (a.kind === "image")
    return a.image ? { kind: "image", image: a.image, caption: a.name, name: a.name } : null;
  const text = a.text ?? a.preview;
  if (!text) return null;
  const lines = a.lines ?? 0;
  return {
    kind: "text",
    text,
    caption: a.pasted ? "Pasted text" : a.name,
    name: a.pasted ? "pasted.txt" : a.name,
    ...(lines && { detail: `${lines} line${lines === 1 ? "" : "s"}` }),
  };
}

/** Cards for `list`, each opening the viewer on its own item and paging through the others. */
export function openableCards(
  list: readonly (CardData & { text?: string })[],
  onRemove?: (index: number) => void,
  open: (items: ViewerItem[], index: number) => void = openViewer,
  onSave?: (index: number) => void,
  onDownload?: (index: number) => void,
): HTMLElement[] {
  const items = list.map(viewerItem);
  const shown = items.filter((x): x is ViewerItem => x !== null);
  return list.map((a, i) => {
    const item = items[i];
    const at = item ? shown.indexOf(item) : -1;
    return attachmentCard(
      a,
      onRemove ? () => onRemove(i) : undefined,
      at >= 0 ? () => open(shown, at) : undefined,
      onSave ? () => onSave(i) : undefined,
      onDownload ? () => onDownload(i) : undefined,
    );
  });
}
