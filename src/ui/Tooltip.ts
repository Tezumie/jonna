// Tooltips (DESIGN.md §12.8, §8.5): one shared floating label for every element with
// `data-tooltip` (and optionally `data-tooltip-command`, whose keybinding is shown as a kbd chip).
// 500 ms before the first show, instant while moving between targets within 300 ms. Never
// interactive. Use `setTooltip()` instead of the native `title` attribute on icon buttons.
import { h, on } from "../core/dom/index";
import { type Disposable, DisposableStore, toDisposable } from "../core/lifecycle/index";

const SHOW_DELAY_MS = 500;
const WARM_MS = 300;

/**
 * A link's tooltip as a small card (D190): where it goes (the site, or "File"), then the address.
 */
export function setLinkTooltip(el: HTMLElement, href: string): void {
  setTooltip(el, href);
  el.dataset.tooltipLink = "1";
}

/** The card's lines for `href`. */
function linkCard(href: string): HTMLElement[] {
  let title = "Link";
  let rest = href;
  try {
    const u = new URL(href);
    if (u.protocol === "http:" || u.protocol === "https:") {
      title = u.host.replace(/^www\./, "");
      rest = `${u.pathname === "/" ? "" : u.pathname}${u.search}${u.hash}` || href;
    } else if (u.protocol === "mailto:") {
      title = "Email";
      rest = u.pathname;
    }
  } catch {
    title = href.startsWith("#") ? "In this document" : "File";
  }
  return [
    h("span", { class: "tooltip-link-title" }, title),
    h("span", { class: "tooltip-link-url" }, rest),
  ];
}

/**
 * Gives `el` a tooltip. `placement: "right"` shows it beside the element instead of below (tree
 * rows: a tooltip below would cover the next rows). An element without text (an icon button) also gets the label as its
 * aria-label; one this function set is replaced on the next call, so a reused element doesn't
 * keep an old name. Rows that are recycled and filled after this call (VirtualList / Tree
 * renderers) pass `ariaLabel: false`: their text is their accessible name (D203).
 */
export function setTooltip(
  el: HTMLElement,
  label: string,
  command?: string,
  options: { placement?: "below" | "right"; ariaLabel?: boolean } = {},
): void {
  el.dataset.tooltip = label;
  if (options.placement === "right") el.dataset.tooltipPlacement = "right";
  else delete el.dataset.tooltipPlacement;
  if (command) el.dataset.tooltipCommand = command;
  else delete el.dataset.tooltipCommand;
  if (el.dataset.tooltipAria !== undefined) {
    el.removeAttribute("aria-label");
    delete el.dataset.tooltipAria;
  }
  if (options.ariaLabel !== false && !el.hasAttribute("aria-label") && !el.textContent?.trim()) {
    el.setAttribute("aria-label", label);
    el.dataset.tooltipAria = "";
  }
  el.removeAttribute("title");
}

export class Tooltips implements Disposable {
  private readonly store = new DisposableStore();
  private readonly element: HTMLElement;
  private target: HTMLElement | null = null;
  private timer = 0;
  private hiddenAt = 0;

  /** `keybinding(command)` returns a label like "Ctrl+B" (or undefined). */
  private readonly win: Window;

  /** One per window: the main one, and each auxiliary window (D101). */
  constructor(
    private readonly keybinding: (command: string) => string | undefined,
    private readonly doc: Document = document,
  ) {
    this.win = doc.defaultView ?? globalThis.window;
    const document = doc;
    const window = this.win;
    this.element = h("div", { class: "tooltip", role: "tooltip", hidden: true });
    document.body.appendChild(this.element);
    this.store.add(toDisposable(() => this.element.remove()));
    this.store.add(toDisposable(() => clearTimeout(this.timer)));
    this.store.add(
      on(document, "pointerover", (e) => {
        // Monaco's and xterm's widgets use native title tooltips: take them over, so every
        // tooltip in the IDE looks and is placed the same.
        const titled = (e.target as Element | null)?.closest?.<HTMLElement>(
          ".monaco-editor [title], .xterm [title], .monaco-diff-editor [title], .devtools [title], .browser-view [title]",
        );
        if (titled?.title) {
          titled.dataset.tooltip = titled.title;
          titled.removeAttribute("title");
        }
        const el = (e.target as Element | null)?.closest?.<HTMLElement>("[data-tooltip]") ?? null;
        if (el === this.target) return;
        this.leave();
        if (!el || document.body.classList.contains("is-dragging")) return;
        this.target = el;
        const warm = performance.now() - this.hiddenAt < WARM_MS;
        this.timer = window.setTimeout(() => this.show(el), warm ? 0 : SHOW_DELAY_MS);
      }),
    );
    // Any press, key or scroll hides it (feedback to a click is never delayed).
    for (const type of ["pointerdown", "keydown", "wheel", "contextmenu"] as const) {
      this.store.add(on(window, type, () => this.leave(), { capture: true, passive: true }));
    }
  }

  private show(el: HTMLElement): void {
    if (!el.isConnected || el !== this.target) return;
    // An open menu owns the pointer area; a tooltip over it would cover its items.
    const document = this.doc;
    const window = this.win;
    if (document.querySelector(".menu")) return;
    const label = el.dataset.tooltip ?? "";
    const command = el.dataset.tooltipCommand;
    const key = command ? this.keybinding(command) : undefined;
    const card = el.dataset.tooltipLink === "1";
    this.element.classList.toggle("is-link", card);
    if (card) this.element.replaceChildren(...linkCard(label));
    else
      this.element.replaceChildren(h("span", null, label), ...(key ? [h("kbd", null, key)] : []));
    this.element.hidden = false;
    const r = el.getBoundingClientRect();
    const t = this.element.getBoundingClientRect();
    let top = r.bottom + 6;
    if (top + t.height > window.innerHeight - 4) top = r.top - t.height - 6;
    let left = Math.max(
      4,
      Math.min(r.left + r.width / 2 - t.width / 2, window.innerWidth - t.width - 4),
    );
    // "Beside" means toward the editors: to the left when the sidebar is on the right.
    const mirrored =
      el.dataset.tooltipPlacement === "right" &&
      !!el.closest('.workbench[data-sidebar="right"] .sidebar');
    if (mirrored && r.left - 8 - t.width > 4) {
      left = r.left - 8 - t.width;
      top = Math.max(
        4,
        Math.min(r.top + r.height / 2 - t.height / 2, window.innerHeight - t.height - 4),
      );
    } else if (
      el.dataset.tooltipPlacement === "right" &&
      r.right + 8 + t.width < window.innerWidth - 4
    ) {
      left = r.right + 8;
      top = Math.max(
        4,
        Math.min(r.top + r.height / 2 - t.height / 2, window.innerHeight - t.height - 4),
      );
    }
    this.element.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  private leave(): void {
    clearTimeout(this.timer);
    if (!this.element.hidden) this.hiddenAt = performance.now();
    this.element.hidden = true;
    this.target = null;
  }

  dispose(): void {
    this.store.dispose();
  }
}
