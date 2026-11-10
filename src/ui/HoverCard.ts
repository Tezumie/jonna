// Hover cards (D148): a richer, interactive cousin of the tooltip, like VS Code's hovers on the
// source control graph. Resting the pointer on a target (by selector, delegated from `host`)
// shows a card built for it beside the target, toward the editors. The pointer can move into
// the card to use its links and buttons; leaving both hides it after a moment. Escape, a press
// outside, scrolling or a menu hide it. One card per HoverCards instance.
import { h, on } from "../core/dom/index";
import {
  type Disposable,
  DisposableStore,
  MutableDisposable,
  toDisposable,
} from "../core/lifecycle/index";

export interface HoverCardOptions {
  /** Before the first card (ms). */
  delay?: number;
  /** Accessible name of the card. */
  label?: string;
}

/**
 * Builds a card's content for a target, or null for none. `store` lives as long as the card
 * (listeners of its buttons). Async content shows when ready, if the pointer is still there.
 */
export type HoverCardRender = (
  target: HTMLElement,
  store: DisposableStore,
) => HTMLElement | null | Promise<HTMLElement | null>;

const HIDE_MS = 300;
/** A card shown within this long of the last one shows without the delay. */
const WARM_MS = 400;

export class HoverCards implements Disposable {
  private readonly store = new DisposableStore();
  private readonly card: HTMLElement;
  private readonly content = new MutableDisposable<DisposableStore>();
  private target: HTMLElement | null = null;
  private showTimer = 0;
  private hideTimer = 0;
  private hiddenAt = 0;
  /** Bumped on each show / hide, so a slow render for an old target is dropped. */
  private generation = 0;

  constructor(
    private readonly host: HTMLElement,
    selector: string,
    private readonly render: HoverCardRender,
    private readonly options: HoverCardOptions = {},
  ) {
    const doc = host.ownerDocument;
    const win = doc.defaultView ?? window;
    this.card = h("div", {
      class: "hover-card",
      role: "dialog",
      "aria-label": options.label ?? "Details",
      hidden: true,
    });
    doc.body.append(this.card);
    this.store.add(toDisposable(() => this.card.remove()));
    this.store.add(this.content);
    this.store.add(
      toDisposable(() => {
        clearTimeout(this.showTimer);
        clearTimeout(this.hideTimer);
      }),
    );
    this.store.add(
      on(host, "pointerover", (e) => {
        const el = (e.target as Element | null)?.closest?.<HTMLElement>(selector) ?? null;
        if (!el || !host.contains(el)) return;
        clearTimeout(this.hideTimer);
        if (el === this.target) return;
        this.schedule(el);
      }),
    );
    this.store.add(
      on(host, "pointerout", (e) => {
        const to = e.relatedTarget as Node | null;
        if (to && (this.card.contains(to) || this.target?.contains(to))) return;
        this.scheduleHide();
      }),
    );
    this.store.add(on(this.card, "pointerenter", () => clearTimeout(this.hideTimer)));
    this.store.add(
      on(this.card, "pointerleave", (e) => {
        const to = e.relatedTarget as Node | null;
        if (to && this.target?.contains(to)) return;
        this.scheduleHide();
      }),
    );
    this.store.add(
      on(win, "keydown", (e) => {
        if (e.key === "Escape" && !this.card.hidden) this.hide();
      }),
    );
    // A press outside the card (a click on the row opens it), the wheel or a menu: hide.
    this.store.add(
      on(
        win,
        "pointerdown",
        (e) => {
          if (!this.card.contains(e.target as Node)) this.hide();
        },
        { capture: true },
      ),
    );
    this.store.add(
      on(
        win,
        "wheel",
        (e) => {
          if (!this.card.contains(e.target as Node)) this.hide();
        },
        { capture: true, passive: true },
      ),
    );
  }

  /** Whether a card is showing (tests, keyboard). */
  get visible(): boolean {
    return !this.card.hidden;
  }

  private schedule(el: HTMLElement): void {
    clearTimeout(this.showTimer);
    this.target = el;
    const warm = !this.card.hidden || performance.now() - this.hiddenAt < WARM_MS;
    const win = this.host.ownerDocument.defaultView ?? window;
    this.showTimer = win.setTimeout(
      () => void this.show(el),
      warm ? 120 : (this.options.delay ?? 600),
    );
  }

  private scheduleHide(): void {
    clearTimeout(this.showTimer);
    clearTimeout(this.hideTimer);
    const win = this.host.ownerDocument.defaultView ?? window;
    this.hideTimer = win.setTimeout(() => this.hide(), HIDE_MS);
  }

  /** Shows the card for `el` now (also for keyboard use). */
  async show(el: HTMLElement): Promise<void> {
    if (!el.isConnected || el.ownerDocument.body.classList.contains("is-dragging")) return;
    if (el.ownerDocument.querySelector(".menu")) return;
    const generation = ++this.generation;
    const store = new DisposableStore();
    let body: HTMLElement | null;
    try {
      body = await this.render(el, store);
    } catch {
      body = null;
    }
    if (generation !== this.generation || this.target !== el || !el.isConnected || !body) {
      store.dispose();
      return;
    }
    this.content.value = store;
    this.card.replaceChildren(body);
    this.card.hidden = false;
    this.place(el);
  }

  hide(): void {
    clearTimeout(this.showTimer);
    clearTimeout(this.hideTimer);
    this.generation++;
    if (!this.card.hidden) this.hiddenAt = performance.now();
    this.card.hidden = true;
    this.card.replaceChildren();
    this.content.clear();
    this.target = null;
  }

  /** Beside the target, toward the editors (left of a sidebar on the right), kept on screen. */
  private place(el: HTMLElement): void {
    const win = el.ownerDocument.defaultView ?? window;
    const r = el.getBoundingClientRect();
    const c = this.card.getBoundingClientRect();
    const toLeft = !!el.closest('.workbench[data-sidebar="right"] .sidebar');
    let left = toLeft ? r.left - 6 - c.width : r.right + 6;
    if (left + c.width > win.innerWidth - 4) left = r.left - 6 - c.width;
    if (left < 4) left = Math.min(win.innerWidth - c.width - 4, Math.max(4, r.left + 24));
    const top = Math.max(4, Math.min(r.top - 6, win.innerHeight - c.height - 4));
    this.card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  dispose(): void {
    this.store.dispose();
  }
}
