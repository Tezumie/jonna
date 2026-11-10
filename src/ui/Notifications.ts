// Toast notifications (DESIGN.md §12.11): bottom-right stack, status icon, optional title and
// actions. Every toast hides itself (paused while hovered): info and success after 4s, warnings
// after 6s, errors after 8s, and ones with buttons after 20s — the bell's list keeps them all.
// Every notification is also kept in `history` (the status bar bell lists them); with "do not
// disturb" on, only errors show as toasts — the rest go straight to the history. The same notice
// again while it shows (or as the newest in the list) is one, with a count (D345).
import { h, on } from "../core/dom/index";
import { type Disposable, DisposableStore, toDisposable } from "../core/lifecycle/index";
import { type Signal, signal } from "../core/reactive/index";
import { type IconName, icon } from "./Icon";

export type NotificationKind = "info" | "success" | "warning" | "error";

export interface NotificationOptions {
  title?: string;
  actions?: { label: string; run(): void }[];
  /**
   * The user closed it without choosing (its × button), or it was a repeat shown as the first:
   * an extension's `await showInformationMessage(…, "A", "B")` resolves undefined then (VS Code's).
   */
  onClose?(): void;
}

const ICONS: Record<NotificationKind, IconName> = {
  info: "info",
  success: "circle-check",
  warning: "triangle-alert",
  error: "circle-alert",
};
/** How long a toast stays (ms); ones with actions get ACTIONS_MS so there's time to click. */
const DISMISS_MS: Record<NotificationKind, number> = {
  info: 4_000,
  success: 4_000,
  warning: 6_000,
  error: 8_000,
};
const ACTIONS_MS = 20_000;
const MAX_VISIBLE = 4;
const MAX_HISTORY = 50;

export interface NotificationRecord {
  id: number;
  kind: NotificationKind;
  message: string;
  title?: string;
  time: number;
  actions: { label: string; run(): void }[];
  /** How many times it came (the same kind, title and message in a row); 1 when absent. */
  count?: number;
}

/** What makes two notices the same (D345). */
const sameKey = (kind: NotificationKind, message: string, title?: string) =>
  `${kind}\u0000${title ?? ""}\u0000${message}`;

export class Notifications implements Disposable {
  private readonly store = new DisposableStore();
  private readonly root: HTMLElement;
  /** The visible toasts, separate from `store` so dismissing them all doesn't also run the cleanup
   * that detaches `root` (after which no toast would ever show again). */
  private readonly toasts = this.store.add(new DisposableStore());
  /** Newest first. */
  readonly history: Signal<readonly NotificationRecord[]> = signal([]);
  /** Notifications not yet seen in the list (the bell's dot). */
  readonly unread: Signal<number> = signal(0);
  /** Only errors show as toasts. */
  readonly doNotDisturb: Signal<boolean> = signal(false);
  private nextId = 1;
  /** The toasts showing now, by sameKey: a repeat adds to its count instead of a new toast. */
  private readonly showing = new Map<string, { again(): void }>();

  constructor(host: HTMLElement) {
    this.root = h("div", { class: "notifications", role: "log", "aria-live": "polite" });
    host.appendChild(this.root);
    this.store.add(toDisposable(() => this.root.remove()));
  }

  /** Marks everything as seen (the list was opened). */
  markRead(): void {
    this.unread.value = 0;
  }

  clearHistory(): void {
    this.history.value = [];
    this.unread.value = 0;
  }

  /** Dismisses the visible toasts (they stay in the history). */
  dismissAll(): void {
    this.toasts.clear();
  }

  show(kind: NotificationKind, message: string, options: NotificationOptions = {}): Disposable {
    // The same message again within a second (a failing command run by another command) is one.
    const last = this.history.peek()[0];
    if (last && last.kind === kind && last.message === message && Date.now() - last.time < 1000) {
      options.onClose?.();
      return toDisposable(() => {});
    }
    const key = sameKey(kind, message, options.title);
    // The newest in the list again: one entry with a count, moved to now.
    const repeat =
      last && sameKey(last.kind, last.message, last.title) === key
        ? { ...last, time: Date.now(), count: (last.count ?? 1) + 1 }
        : null;
    const record: NotificationRecord = repeat ?? {
      id: this.nextId++,
      kind,
      message,
      ...(options.title && { title: options.title }),
      time: Date.now(),
      actions: options.actions ?? [],
    };
    this.history.value = [record, ...this.history.peek().slice(repeat ? 1 : 0)].slice(
      0,
      MAX_HISTORY,
    );
    // Showing already: its count goes up and it stays longer; this call's own buttons aren't
    // added (an extension's promise resolves undefined, as for a repeat within a second).
    const shown = this.showing.get(key);
    if (shown && !(this.doNotDisturb.peek() && kind !== "error")) {
      shown.again();
      options.onClose?.();
      return toDisposable(() => {});
    }
    if (this.doNotDisturb.peek() && kind !== "error") {
      this.unread.value = this.unread.peek() + 1;
      return toDisposable(() => {});
    }
    if (kind === "warning" || kind === "error") this.unread.value = this.unread.peek() + 1;
    const item = new DisposableStore();
    const remove = () => this.toasts.delete(item);
    const close = h(
      "button",
      {
        class: "icon-button notification-close",
        type: "button",
        title: "Dismiss",
        "aria-label": "Dismiss",
      },
      icon("x"),
    );
    const badge = h("span", { class: "notification-count", hidden: true });
    let count = 1;
    // Three, as VS Code shows (an extension's "Install", "Not now", "More info").
    const actions = (options.actions ?? []).slice(0, 3).map((action) => {
      const button = h(
        "button",
        { class: "button button-secondary button-sm", type: "button" },
        action.label,
      );
      item.add(
        on(button, "click", () => {
          remove();
          action.run();
        }),
      );
      return button;
    });
    const toast = h(
      "div",
      { class: `notification is-${kind}`, role: kind === "error" ? "alert" : "status" },
      h("span", { class: "notification-icon" }, icon(ICONS[kind])),
      h(
        "div",
        { class: "notification-content" },
        options.title ? h("div", { class: "notification-title" }, options.title) : null,
        h("div", { class: "notification-message" }, message, badge),
        actions.length > 0 ? h("div", { class: "notification-actions" }, actions) : null,
      ),
      close,
    );
    this.root.appendChild(toast);
    item.add(toDisposable(() => toast.remove()));
    item.add(
      on(close, "click", () => {
        remove();
        options.onClose?.();
      }),
    );
    const after = actions.length ? ACTIONS_MS : DISMISS_MS[kind];
    let timer = setTimeout(remove, after);
    const entry = {
      again: () => {
        count++;
        badge.hidden = false;
        badge.textContent = `×${count}`;
        badge.setAttribute("aria-label", `${count} times`);
        // It's news again: shown the full time from now, at the bottom of the stack.
        clearTimeout(timer);
        timer = setTimeout(remove, after);
        this.root.appendChild(toast);
      },
    };
    this.showing.set(key, entry);
    item.add(
      toDisposable(() => {
        if (this.showing.get(key) === entry) this.showing.delete(key);
      }),
    );
    item.add(on(toast, "pointerenter", () => clearTimeout(timer)));
    item.add(on(toast, "pointerleave", () => (timer = setTimeout(remove, after / 2))));
    item.add(toDisposable(() => clearTimeout(timer)));
    this.toasts.add(item);
    while (this.root.childElementCount > MAX_VISIBLE) this.root.firstElementChild?.remove();
    return toDisposable(remove);
  }

  /**
   * A toast for work under way (VS Code's progress notification): it stays until `close()`, with
   * an indeterminate line, or a determinate one once `update` gives a percentage, and a Cancel
   * button when `onCancel` is given. Closing it (×) only hides it; the work goes on. Not kept in
   * the history (it isn't news; what it ends with is).
   */
  progress(
    message: string,
    options: { title?: string; onCancel?: () => void } = {},
  ): { update(message: string, percent?: number): void; close(): void } {
    const item = new DisposableStore();
    const remove = () => this.toasts.delete(item);
    const text = h("div", { class: "notification-message" }, message);
    const line = h("div", {
      class: "progress-line notification-progress",
      role: "progressbar",
      "aria-label": options.title ?? message,
    });
    const close = h(
      "button",
      {
        class: "icon-button notification-close",
        type: "button",
        title: "Hide",
        "aria-label": "Hide",
      },
      icon("x"),
    );
    let cancel: HTMLElement | null = null;
    const onCancel = options.onCancel;
    if (onCancel) {
      cancel = h(
        "button",
        { class: "button button-secondary button-sm", type: "button" },
        "Cancel",
      );
      item.add(
        on(cancel, "click", () => {
          if (cancel) (cancel as HTMLButtonElement).disabled = true;
          onCancel();
        }),
      );
    }
    const toast = h(
      "div",
      { class: "notification is-info is-progress", role: "status" },
      h("span", { class: "notification-icon" }, icon("info")),
      h(
        "div",
        { class: "notification-content" },
        options.title ? h("div", { class: "notification-title" }, options.title) : null,
        text,
        line,
        cancel ? h("div", { class: "notification-actions" }, cancel) : null,
      ),
      close,
    );
    // With "do not disturb" on, work under way doesn't show (only errors do).
    if (!this.doNotDisturb.peek()) {
      this.root.appendChild(toast);
      while (this.root.childElementCount > MAX_VISIBLE) this.root.firstElementChild?.remove();
    }
    item.add(toDisposable(() => toast.remove()));
    item.add(on(close, "click", remove));
    this.toasts.add(item);
    return {
      update: (next, percent) => {
        if (next) text.textContent = next;
        if (percent !== undefined) {
          const p = Math.max(0, Math.min(100, percent));
          line.classList.add("is-determinate");
          line.style.setProperty("--progress", `${p}%`);
          line.setAttribute("aria-valuenow", String(Math.round(p)));
        }
      },
      close: remove,
    };
  }

  dispose(): void {
    this.store.dispose();
  }
}
