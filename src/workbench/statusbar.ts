// Status bar: reactive items contributed by the workbench and extensions. Clicking an item runs
// its command through the dispatcher; right-clicking the bar lists every item to hide or show
// (D383, workbench.statusBar.hidden).
import type { Dispatcher } from "../core/dispatcher/index";
import { h, on } from "../core/dom/index";
import { type Disposable, DisposableStore, toDisposable } from "../core/lifecycle/index";
import { effect, type ReadonlySignal, signal } from "../core/reactive/index";
import { icon, knownIcon } from "../ui/Icon";
import { type MenuItem, showContextMenu } from "../ui/Menu";
import { setTooltip } from "../ui/Tooltip";
import { statusMenuEntries } from "./statusItems";

export interface StatusItem {
  id: string;
  alignment: "left" | "right";
  /** Higher priority = closer to the edge. */
  priority: number;
  /**
   * Reactive text; return "" to hide the item. Read signals inside to update automatically.
   * `$(icon-name)` inserts an icon (e.g. "$(circle-x) 2 $(triangle-alert) 0").
   */
  text(): string;
  /**
   * The item's content built from `text`, instead of reading `$(icon)` in it: colored text (the
   * agent's status line command, D357). Text nodes and spans only; a span with `data-command`
   * (and `data-input`, JSON) runs that command when clicked (a status line link, D373).
   */
  nodes?(text: string): Node[];
  tooltip?(): string;
  /**
   * A status that needs attention (VS Code's statusBarItem.warningBackground / errorBackground,
   * the only backgrounds it lets extensions use), or a foreground tone alone.
   */
  tone?(): StatusTone | undefined;
  /**
   * What the item is (VS Code's StatusBarItem.name): announced before its text, and its label in
   * the bar's right-click menu.
   */
  name?: string;
  /** False keeps the item out of the right-click menu, so it can't be hidden (D383). */
  hideable?: boolean;
  command?: string;
  /** Input for `command`. */
  input?: unknown;
}

export type StatusTone = "warning" | "error" | "warning-text" | "error-text";

export class StatusBar implements Disposable {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly left: HTMLElement;
  private readonly right: HTMLElement;
  /** Ids of the items the user hid (workbench.statusBar.hidden, set by the workbench). */
  readonly hidden = signal<ReadonlySet<string>>(new Set());
  private readonly itemList = signal<readonly StatusItem[]>([]);
  /** Every item added, in registration order (the menu and `ide://statusbar`). */
  readonly items: ReadonlySignal<readonly StatusItem[]> = this.itemList;

  constructor(
    host: HTMLElement,
    private readonly dispatcher: Dispatcher,
  ) {
    this.left = h("div", { class: "statusbar-left" });
    this.right = h("div", { class: "statusbar-right" });
    this.element = h(
      "footer",
      { class: "statusbar", role: "status", "data-part": "statusbar" },
      this.left,
      this.right,
    );
    host.appendChild(this.element);
    this.store.add(toDisposable(() => this.element.remove()));
    this.store.add(
      on(this.element, "contextmenu", (e) => {
        e.preventDefault();
        const id = (e.target as Element | null)?.closest<HTMLElement>(".statusbar-item")?.dataset
          .id;
        this.showMenu(e.clientX, e.clientY, id ?? null);
      }),
    );
  }

  /**
   * VS Code's menu: "Hide <item>" for the item right-clicked, then every item with a check, then
   * hiding the whole bar. Each entry runs a command.
   */
  private showMenu(x: number, y: number, itemId: string | null): void {
    const exec = (command: string, input: unknown = {}) =>
      void this.dispatcher.execute(command, input).catch(() => {});
    const hidden = this.hidden.peek();
    const entries = statusMenuEntries(
      this.itemList.peek().map((item) => ({ ...item, showing: item.text() !== "" })),
      hidden,
    );
    const items: MenuItem[] = [];
    const clicked = entries.find((e) => e.id === itemId);
    if (clicked)
      items.push({
        label: `Hide "${clicked.label}"`,
        icon: "eye-off",
        run: () => exec("statusBar.setItemHidden", { id: clicked.id, hidden: true }),
      });
    for (const [i, entry] of entries.entries())
      items.push({
        label: entry.label,
        checked: !hidden.has(entry.id),
        // A line between the bar's left and right sides.
        separatorBefore:
          (i === 0 && items.length > 0) ||
          (entry.alignment === "right" && entries[i - 1]?.alignment === "left"),
        run: () => exec("statusBar.setItemHidden", { id: entry.id, hidden: !hidden.has(entry.id) }),
      });
    if (hidden.size)
      items.push({
        label: "Show all",
        icon: "eye",
        separatorBefore: true,
        run: () => exec("statusBar.setItemHidden", { all: true, hidden: false }),
      });
    items.push({
      label: "Hide status bar",
      separatorBefore: true,
      run: () => exec("workbench.toggleStatusBar"),
    });
    showContextMenu(x, y, items);
  }

  /** Each item's priority, to keep them in order as they come and go. */
  private readonly priorities = new WeakMap<HTMLElement, number>();

  /**
   * Puts an item among its side's items by priority, higher nearer the edge (equal ones in the
   * order they came). DOM order rather than CSS `order`, which takes whole numbers only: VS Code
   * priorities (and extensions') are often fractional.
   */
  private place(el: HTMLElement, item: StatusItem): void {
    const side = item.alignment === "left" ? this.left : this.right;
    this.priorities.set(el, item.priority);
    // Left: highest first. Right: lowest first (the highest ends at the right edge).
    const before = [...side.children].find((other) => {
      const p = this.priorities.get(other as HTMLElement);
      if (p === undefined) return false;
      return item.alignment === "left" ? p < item.priority : p > item.priority;
    });
    side.insertBefore(el, before ?? null);
  }

  add(item: StatusItem): Disposable {
    const store = new DisposableStore();
    const el = item.command
      ? h("button", { class: "statusbar-item", type: "button", "data-id": item.id })
      : h("span", { class: "statusbar-item", "data-id": item.id });
    this.place(el, item);
    store.add(toDisposable(() => el.remove()));
    this.itemList.value = [...this.itemList.peek(), item];
    store.add(
      toDisposable(() => {
        this.itemList.value = this.itemList.peek().filter((i) => i !== item);
      }),
    );
    store.add(
      effect(() => {
        const text = item.text();
        el.replaceChildren(
          ...(item.nodes
            ? item.nodes(text)
            : text
                // VS Code's `$(sync~spin)`: the icon (D284; it doesn't spin here).
                .split(/\$\(([a-z0-9-]+)(?:~spin)?\)/)
                .map((part, i) => (i % 2 ? icon(knownIcon(part)) : part))),
        );
        el.hidden = text === "" || (item.hideable !== false && this.hidden.value.has(item.id));
        const tip = item.tooltip?.();
        if (tip) setTooltip(el, tip);
        const tone = item.tone?.();
        for (const t of ["warning", "error", "warning-text", "error-text"] as const)
          el.classList.toggle(`is-${t}`, tone === t);
        // Icons are read as nothing: "Problems: 2 0", not "$(circle-x) 2". An item showing
        // nothing has no label (it's hidden anyway).
        if (item.name && text)
          el.setAttribute(
            "aria-label",
            `${item.name}: ${text.replace(/\$\([a-z0-9-]+(?:~spin)?\)\s*/g, "").trim()}`,
          );
        else el.removeAttribute("aria-label");
        return undefined;
      }),
    );
    const command = item.command;
    if (command)
      store.add(
        on(el, "click", () => void this.dispatcher.execute(command, item.input).catch(() => {})),
      );
    // A part of the item that's a link of its own (D373).
    else if (item.nodes)
      store.add(
        on(el, "click", (e) => {
          const link = (e.target as Element | null)?.closest<HTMLElement>("[data-command]");
          const id = link?.dataset.command;
          if (!link || !id) return;
          let input: unknown;
          try {
            input = link.dataset.input ? JSON.parse(link.dataset.input) : undefined;
          } catch {
            return;
          }
          void this.dispatcher.execute(id, input).catch(() => {});
        }),
      );
    this.store.add(store);
    return toDisposable(() => this.store.delete(store));
  }

  dispose(): void {
    this.store.dispose();
  }
}
