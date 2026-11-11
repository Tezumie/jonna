// Screenshots the agent took during a turn (D155): a strip of thumbnails on the work line (the
// newest few, "+N" for the rest) and a viewer to look at them full size, one by one (← / →, Esc
// or a click outside closes). Like Slack's (D196), the viewer leaves the chat it was opened from
// visible and usable beside the picture, when there's room; otherwise it covers the window.
import { h, on } from "../../../core/dom/index";
import { DisposableStore } from "../../../core/lifecycle/index";
import { icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";

/** Thumbnails shown on the line; older ones are behind "+N" (the viewer pages through all). */
const STRIP = 3;

/** A screenshot to show: its image and what took it ("Took screenshot · page"). */
export interface Shot {
  /** Base64 PNG (this session) or a data: URL (a saved, compressed preview, D156). */
  image: string;
  caption: string;
}

/** An `<img>` source for a shot's image (raw base64 PNG or already a data: URL). */
export function imageSrc(image: string): string {
  return image.startsWith("data:") ? image : `data:image/png;base64,${image}`;
}

/** The strip for `shots` (oldest first), or null with none. */
export function shotStrip(shots: readonly Shot[]): HTMLElement | null {
  if (!shots.length) return null;
  const shown = shots.slice(-STRIP);
  const first = shots.length - shown.length;
  return h(
    "div",
    { class: "agent-shots" },
    first > 0
      ? (() => {
          const more = h(
            "button",
            {
              class: "agent-shots-more",
              type: "button",
              "aria-label": `${first} earlier screenshots`,
            },
            `+${first}`,
          );
          on(more, "click", () => openShots(shots, 0));
          return more;
        })()
      : null,
    ...shown.map((shot, i) => {
      const b = h(
        "button",
        {
          class: "agent-shots-thumb",
          type: "button",
          "aria-label": "Show the screenshot",
          // For the hover preview (view.ts).
          "data-caption": shot.caption,
          "data-position": `${first + i + 1} of ${shots.length}`,
        },
        h("img", { src: imageSrc(shot.image), alt: "", draggable: "false" }),
      );
      on(b, "click", () => openShots(shots, first + i));
      return b;
    }),
  );
}

let current: DisposableStore | null = null;

/** Where the last click was: the chat a viewer opens from stays beside it. */
let lastPointer: Element | null = null;
let tracking = false;
function trackPointer(): void {
  if (tracking) return;
  tracking = true;
  const remember = (e: Event) => {
    lastPointer = e.target instanceof Element ? e.target : null;
  };
  // Click too: keyboard activation and scripted clicks have no pointerdown.
  document.addEventListener("pointerdown", remember, { capture: true });
  document.addEventListener("click", remember, { capture: true });
}
if (typeof document !== "undefined") trackPointer();

/** Narrower than this beside the chat, the viewer covers the whole window. */
const MIN_BESIDE = 360;

/** The part of the window beside `chat` (the larger side), or null when there's no room. */
/** Room left for the splitter beside the chat: its grab area is 3 px each side of the edge. */
const SPLITTER_ROOM = 6;

function besideChat(chat: Element | null): { left: number; right: number } | null {
  if (!chat) return null;
  const r = chat.getBoundingClientRect();
  if (r.width === 0) return null;
  const leftRoom = r.left;
  const rightRoom = window.innerWidth - r.right;
  if (Math.max(leftRoom, rightRoom) < MIN_BESIDE) return null;
  // A few pixels short of the chat: the splitter between the chat and the editors stays free to
  // drag (it straddles that edge) while the viewer is open (D201).
  return leftRoom >= rightRoom
    ? { left: 0, right: window.innerWidth - r.left + SPLITTER_ROOM }
    : { left: r.right + SPLITTER_ROOM, right: 0 };
}

/** Something the viewer shows (D158): an image, or a text (a pasted text, a file). */
export type ViewerItem =
  | {
      kind: "image";
      image: string;
      caption: string;
      name?: string;
      /** The whole image as a data: URL, when `image` may be a reduced preview (D381). */
      full?: () => Promise<string | null>;
    }
  | { kind: "text"; text: string; caption: string; detail?: string; name?: string };

/** An attachment as the download and "add to project" actions take it (D211). */
export interface AttachmentData {
  name: string;
  kind: "image" | "text";
  /** Base64 PNG, an image data: URL, or the text. */
  data: string;
}

/**
 * Download and "Add to project" for attachments (D211), set by the agent extension (they run its
 * commands): the viewer's bar and the sent cards' hover buttons use them.
 */
export interface AttachmentActions {
  save(a: AttachmentData): void;
  addToProject(a: AttachmentData): void;
}
let actions: AttachmentActions | null = null;
export function setAttachmentActions(a: AttachmentActions | null): void {
  actions = a;
}
export function attachmentActions(): AttachmentActions | null {
  return actions;
}

/** A viewer item as an attachment for the actions. */
function itemData(item: ViewerItem | undefined): AttachmentData | null {
  if (!item) return null;
  const name = item.name ?? item.caption;
  return item.kind === "image"
    ? { name, kind: "image", data: item.image }
    : { name, kind: "text", data: item.text };
}

/** Shows `shots[index]` full size over the window; arrows page through them. */
export function openShots(shots: readonly Shot[], index: number): void {
  trackPointer();
  openViewer(
    shots.map((s) => ({ kind: "image" as const, image: s.image, caption: s.caption })),
    index,
  );
}

/** Shows `items[index]` over the window; ← / → page through them in order. */
export function openViewer(items: readonly ViewerItem[], index: number): void {
  const shots = items;
  if (!shots.length) return;
  trackPointer();
  // The chat it was opened from (a card or thumbnail in it was clicked).
  const chat = lastPointer?.closest(".agent-view") ?? null;
  current?.dispose();
  const store = new DisposableStore();
  current = store;
  let at = Math.max(0, Math.min(index, shots.length - 1));
  const img = h("img", { class: "agent-viewer-image", alt: "" }) as HTMLImageElement;
  const textBody = h("pre", { class: "agent-viewer-text-body" });
  const textHead = h("div", { class: "agent-viewer-text-head" });
  const text = h("div", { class: "agent-viewer-text" }, textHead, textBody);
  const count = h("span", { class: "agent-viewer-count" });
  const nav = (glyph: "arrow-left" | "arrow-right", label: string, step: number) => {
    const b = h(
      "button",
      { class: "icon-button agent-viewer-nav", type: "button", "aria-label": label },
      icon(glyph),
    );
    store.add(
      on(b, "click", (e) => {
        e.stopPropagation();
        go(step);
      }),
    );
    return b;
  };
  const prev = nav("arrow-left", "Previous screenshot", -1);
  const next = nav("arrow-right", "Next screenshot", 1);
  const close = h(
    "button",
    { class: "icon-button agent-viewer-close", type: "button", "aria-label": "Close" },
    icon("x"),
  );
  // Download and "Add to project" for the item shown (D211).
  const action = (
    glyph: "download" | "file-down",
    label: string,
    run: (a: AttachmentData) => void,
  ) => {
    const b = h(
      "button",
      { class: "icon-button agent-viewer-action", type: "button", "aria-label": label },
      icon(glyph),
    );
    setTooltip(b, label);
    store.add(
      on(b, "click", (e) => {
        e.stopPropagation();
        const item = shots[at];
        const data = itemData(item);
        if (!data) return;
        // A chat image's preview: the actions take the whole image (D381).
        if (item?.kind === "image" && item.full)
          void item.full().then(
            (full) => run(full ? { ...data, data: full } : data),
            () => run(data),
          );
        else run(data);
      }),
    );
    return b;
  };
  const tools = actions
    ? [
        action("download", "Download…", (a) => actions?.save(a)),
        action("file-down", "Add to project…", (a) => actions?.addToProject(a)),
      ]
    : [];
  const viewer = h(
    "div",
    { class: "agent-viewer", role: "dialog", "aria-label": "Image viewer", tabindex: "-1" },
    h(
      "div",
      { class: "agent-viewer-bar" },
      count,
      h("div", { class: "agent-viewer-tools" }, ...tools, close),
    ),
    h("div", { class: "agent-viewer-stage" }, prev, img, text, next),
  );
  const show = () => {
    const shot = shots[at];
    const isText = shot?.kind === "text";
    img.hidden = isText;
    text.hidden = !isText;
    if (shot?.kind === "image") {
      img.src = imageSrc(shot.image);
      // The whole image replaces a preview when it comes (still on the same one).
      const shownAt = at;
      void shot
        .full?.()
        .then((full) => {
          if (full && at === shownAt && full !== img.src) img.src = full;
        })
        .catch(() => {});
    }
    if (shot?.kind === "text") {
      textHead.replaceChildren(
        h("span", { class: "agent-viewer-text-name" }, shot.caption),
        ...(shot.detail ? [h("span", { class: "agent-viewer-text-detail" }, shot.detail)] : []),
      );
      textBody.textContent = shot.text;
      textBody.scrollTop = 0;
    }
    count.textContent = [shot?.caption, shots.length > 1 ? `${at + 1} of ${shots.length}` : ""]
      .filter(Boolean)
      .join(" · ");
    prev.toggleAttribute("disabled", at === 0);
    next.toggleAttribute("disabled", at === shots.length - 1);
  };
  const go = (step: number) => {
    at = Math.max(0, Math.min(at + step, shots.length - 1));
    show();
  };
  store.add(on(close, "click", () => store.dispose()));
  store.add(
    on(viewer, "click", (e) => {
      if (e.target === viewer || (e.target as Element).classList.contains("agent-viewer-stage"))
        store.dispose();
    }),
  );
  // Beside the chat: the viewer takes the rest of the window and follows its size.
  const place = () => {
    const side = besideChat(chat?.isConnected ? chat : null);
    viewer.classList.toggle("is-beside", !!side);
    // The scrim fades toward the chat, so the viewer knows which side it's on.
    viewer.classList.toggle("is-chat-left", !!side && side.left > 0);
    viewer.style.left = side ? `${side.left}px` : "";
    viewer.style.right = side ? `${side.right}px` : "";
  };
  place();
  store.add(on(window, "resize", place));
  // The chat's own size changes too (a splitter dragged, the chat moved or closed).
  if (chat && typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => place());
    observer.observe(chat);
    store.add({ dispose: () => observer.disconnect() });
  }
  /** Keys typed in the chat beside it are the chat's (the arrows move in its text). */
  const inChat = (e: Event) => !!chat && e.target instanceof Node && chat.contains(e.target);
  store.add(
    on(
      document,
      "keydown",
      (e) => {
        // Keys typed in the chat stay the chat's, Escape too (it stops a turn, closes menus).
        if (inChat(e)) return;
        if (e.key === "Escape") store.dispose();
        else if (e.key === "ArrowLeft") go(-1);
        else if (e.key === "ArrowRight") go(1);
        else return;
        e.preventDefault();
        e.stopPropagation();
      },
      { capture: true },
    ),
  );
  store.add({
    dispose: () => {
      viewer.remove();
      if (current === store) current = null;
    },
  });
  show();
  document.body.append(viewer);
  viewer.focus();
}

/** The hover preview of a thumbnail: the image large, what took it, and which one it is. */
export function shotPreview(thumb: HTMLElement): HTMLElement | null {
  const src = thumb.querySelector("img")?.getAttribute("src");
  if (!src) return null;
  return h(
    "div",
    { class: "agent-shot-card" },
    h("img", { src, alt: "" }),
    h(
      "div",
      { class: "agent-shot-card-foot" },
      h("span", { class: "agent-shot-card-caption" }, thumb.dataset.caption ?? "Screenshot"),
      h("span", { class: "agent-shot-card-position" }, thumb.dataset.position ?? ""),
    ),
  );
}
