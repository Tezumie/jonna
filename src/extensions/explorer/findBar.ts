// The explorer's find bar (D200; VS Code's Ctrl+Alt+F in a tree): matching names among the shown
// rows are highlighted (or, with the filter toggle, the only rows shown), Enter / ↓ go to the next
// match, Shift+Enter / ↑ to the previous one, Escape closes it. Only loaded rows are searched, as
// in VS Code: the quick open (Ctrl+P) finds files anywhere.
import { h, on } from "../../core/dom/index";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import type { Tree } from "../../ui/Tree";

export class ExplorerFindBar implements Disposable {
  private readonly store = new DisposableStore();
  readonly element: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly filterButton: HTMLButtonElement;
  private filter = false;

  constructor(private readonly tree: () => Tree<unknown> | undefined) {
    this.input = h("input", {
      class: "input explorer-find-input",
      type: "text",
      placeholder: "Find in the tree",
      "aria-label": "Find in the explorer",
      spellcheck: "false",
    });
    this.count = h("span", { class: "explorer-find-count" });
    this.filterButton = h(
      "button",
      { class: "icon-button", type: "button", "aria-pressed": "false" },
      icon("list-filter"),
    );
    setTooltip(this.filterButton, "Show only matching rows");
    const close = h(
      "button",
      { class: "icon-button", type: "button", "aria-label": "Close" },
      icon("x"),
    );
    setTooltip(close, "Close (Escape)");
    this.element = h(
      "div",
      { class: "explorer-find", hidden: true },
      this.input,
      this.count,
      this.filterButton,
      close,
    );
    this.store.add(on(this.input, "input", () => this.apply()));
    this.store.add(
      on(this.filterButton, "click", () => {
        this.filter = !this.filter;
        this.filterButton.setAttribute("aria-pressed", String(this.filter));
        this.filterButton.classList.toggle("is-active", this.filter);
        this.apply();
      }),
    );
    this.store.add(on(close, "click", () => this.close()));
    this.store.add(
      on(this.input, "keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.close();
        } else if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          this.tree()?.findNext(e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey));
        }
      }),
    );
  }

  get open(): boolean {
    return !this.element.hidden;
  }

  /** Opens it (with `query`, from a command), focused; returns how many rows match. */
  show(query?: string, filter?: boolean): number {
    this.element.hidden = false;
    if (query !== undefined) this.input.value = query;
    if (filter !== undefined) {
      this.filter = filter;
      this.filterButton.setAttribute("aria-pressed", String(filter));
      this.filterButton.classList.toggle("is-active", filter);
    }
    this.input.focus();
    this.input.select();
    return this.apply();
  }

  close(): void {
    if (this.element.hidden) return;
    this.element.hidden = true;
    const tree = this.tree();
    tree?.setFind(null);
    tree?.element.focus();
  }

  private apply(): number {
    const tree = this.tree();
    const query = this.input.value;
    tree?.setFind(query, this.filter);
    const n = tree?.findCount() ?? 0;
    this.count.textContent = query ? (n ? `${n} found` : "No results") : "";
    this.element.classList.toggle("is-empty", !!query && !n);
    // The first match is selected as you type, like VS Code.
    if (query && n) tree?.findNext(false, true);
    return n;
  }

  dispose(): void {
    this.store.dispose();
    this.element.remove();
  }
}
