// Find and replace across a notebook's cells (D204), VS Code's notebook find widget: Ctrl+F (in a
// cell too) opens a bar over the cells' top right; the query searches every cell's source and,
// when asked, the outputs' text (core/notebook/find.ts); all matches are highlighted (cell
// editors through the engine, rendered Markdown and outputs through CSS highlights), Enter /
// Shift+Enter go to the next / previous one (a Markdown cell opens for editing, as in VS Code),
// and Replace / Replace all change the sources (one undo step). Its buttons run the
// notebook.find… commands.
import { h, on } from "../../../core/dom/index";
import { DisposableStore } from "../../../core/lifecycle/index";
import {
  type FindMatch,
  type FindOptions,
  findInCells,
  findPattern,
  matchesIn,
  nearestMatch,
  replaceAllIn,
  replacementFor,
} from "../../../core/notebook/find";
import { type IconName, icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import type { CellView } from "./cell";
import { outputText } from "./model";

const OWNER = "notebook-find";

/** What the bar needs from its notebook. */
export interface FindHost {
  cells(): readonly CellView[];
  /** The selected cell and the cursor offset in it (where "next" starts from). */
  from(): { cellIndex: number; offset: number };
  /** Shows a match: selects its cell, scrolls to it, selects its text (without taking focus). */
  reveal(match: FindMatch): void;
  /** Sets cells' sources as one undoable step. */
  setSources(changes: readonly { index: number; source: string }[]): void;
  /** The bar closed with Esc: focus goes back to the notebook. */
  closed(): void;
  run(command: string, input?: Record<string, unknown>): void;
}

type CSSHighlights = { set(name: string, value: unknown): void; delete(name: string): void };
const highlights = (): CSSHighlights | null =>
  (globalThis as unknown as { CSS?: { highlights?: CSSHighlights } }).CSS?.highlights ?? null;
const HighlightClass = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown })
  .Highlight;

export class NotebookFindBar {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly input: HTMLInputElement;
  private readonly replaceInput: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly replaceRow: HTMLElement;
  private readonly toggles = new Map<keyof FindOptions, HTMLElement>();
  options: FindOptions = { query: "" };
  matches: FindMatch[] = [];
  current = -1;
  /** A bad regular expression's message. */
  error: string | null = null;
  private frame = 0;
  /** Editors that have highlights (cleared when matches move away). */
  private decorated = new Set<CellView>();

  constructor(private readonly host: FindHost) {
    this.input = h("input", {
      class: "input nb-find-input",
      type: "text",
      placeholder: "Find",
      spellcheck: "false",
      "aria-label": "Find in notebook",
    }) as HTMLInputElement;
    this.replaceInput = h("input", {
      class: "input nb-find-input",
      type: "text",
      placeholder: "Replace",
      spellcheck: "false",
      "aria-label": "Replace with",
    }) as HTMLInputElement;
    this.count = h("span", { class: "nb-find-count", "aria-live": "polite" });
    const button = (
      glyph: IconName,
      label: string,
      command: string,
      input?: () => Record<string, unknown>,
    ) => {
      const b = h(
        "button",
        { class: "icon-button", type: "button", "aria-label": label },
        icon(glyph),
      );
      setTooltip(b, label);
      this.store.add(on(b, "click", () => host.run(command, input?.() ?? {})));
      return b;
    };
    const toggle = (key: keyof FindOptions, glyph: IconName, label: string) => {
      const b = h(
        "button",
        {
          class: "icon-button nb-find-toggle",
          type: "button",
          "aria-label": label,
          "aria-pressed": "false",
        },
        icon(glyph),
      );
      setTooltip(b, label);
      this.store.add(
        on(b, "click", () => {
          const on =
            key === "markdown" || key === "code" ? this.options[key] === false : !this.options[key];
          host.run("notebook.find", { [key]: on, focus: false });
        }),
      );
      this.toggles.set(key, b);
      return b;
    };
    const chevron = icon("chevron-right");
    chevron.classList.add("nb-find-chevron");
    const expand = h(
      "button",
      { class: "icon-button nb-find-expand", type: "button", "aria-label": "Toggle replace" },
      chevron,
    );
    setTooltip(expand, "Toggle replace (Ctrl+H)");
    this.store.add(
      on(expand, "click", () => {
        this.setReplaceVisible(!this.element.classList.contains("is-replacing"));
        if (this.element.classList.contains("is-replacing")) this.replaceInput.focus();
      }),
    );
    this.replaceRow = h(
      "div",
      { class: "nb-find-row", hidden: true },
      this.replaceInput,
      button("replace", "Replace (Enter)", "notebook.replace", () => ({
        replacement: this.replaceInput.value,
      })),
      button("replace-all", "Replace all (Ctrl+Alt+Enter)", "notebook.replaceAll", () => ({
        replacement: this.replaceInput.value,
      })),
    );
    this.element = h(
      "div",
      { class: "nb-find", role: "search", hidden: true },
      expand,
      h(
        "div",
        { class: "nb-find-rows" },
        h(
          "div",
          { class: "nb-find-row" },
          this.input,
          toggle("caseSensitive", "case-sensitive", "Match case"),
          toggle("wholeWord", "whole-word", "Match whole word"),
          toggle("regex", "regex", "Use regular expression"),
          toggle("outputs", "file-output", "Search outputs too"),
          this.count,
          button("arrow-up", "Previous match (Shift+Enter)", "notebook.findPrevious"),
          button("arrow-down", "Next match (Enter)", "notebook.findNext"),
          button("x", "Close (Escape)", "notebook.closeFind"),
        ),
        this.replaceRow,
      ),
    );
    this.store.add(
      on(this.input, "input", () => {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() =>
          host.run("notebook.find", { query: this.input.value, focus: false }),
        );
      }),
    );
    const keys = (e: KeyboardEvent, replace: boolean) => {
      // Keys typed here are the bar's, not the notebook's command mode.
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        host.run("notebook.closeFind");
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.altKey) {
        e.preventDefault();
        host.run("notebook.replaceAll", { replacement: this.replaceInput.value });
      } else if (e.key === "Enter" && replace) {
        e.preventDefault();
        host.run("notebook.replace", { replacement: this.replaceInput.value });
      } else if (e.key === "Enter") {
        e.preventDefault();
        host.run(e.shiftKey ? "notebook.findPrevious" : "notebook.findNext");
      }
    };
    this.store.add(on(this.input, "keydown", (e) => keys(e, false)));
    this.store.add(on(this.replaceInput, "keydown", (e) => keys(e, true)));
    this.store.add({
      dispose: () => {
        cancelAnimationFrame(this.frame);
        this.clearHighlights();
      },
    });
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  setReplaceVisible(visible: boolean): void {
    this.replaceRow.hidden = !visible;
    this.element.classList.toggle("is-replacing", visible);
  }

  /** Opens (or updates) the search; `focus` puts the cursor in the find field. */
  open(options: Partial<FindOptions> & { replace?: boolean; focus?: boolean }): void {
    const { replace, focus, ...rest } = options;
    this.options = { ...this.options, ...rest };
    if (rest.query !== undefined && this.input.value !== rest.query) this.input.value = rest.query;
    this.element.hidden = false;
    if (replace !== undefined) this.setReplaceVisible(replace);
    for (const [key, el] of this.toggles) {
      const on =
        key === "markdown" || key === "code" ? this.options[key] !== false : !!this.options[key];
      el.classList.toggle("is-on", on);
      el.setAttribute("aria-pressed", String(on));
    }
    this.search(true);
    if (focus !== false) {
      this.input.focus();
      this.input.select();
    }
  }

  close(): void {
    this.element.hidden = true;
    this.matches = [];
    this.current = -1;
    this.clearHighlights();
  }

  /** Finds again (the query, an option or the cells changed); `jump`: show the nearest match. */
  search(jump = false): void {
    const pattern = findPattern(this.options);
    this.error = typeof pattern === "string" ? pattern : null;
    const cells = this.host.cells();
    const before = this.matches[this.current];
    this.matches = findInCells(
      cells.map((c) => ({
        id: c.cell.id,
        kind: c.cell.kind,
        source: c.cell.source,
        ...(this.options.outputs &&
          c.cell.kind === "code" && {
            outputs: c.cell.outputs.map((o) => outputText([o], 100_000)),
          }),
      })),
      this.options,
    );
    if (!this.matches.length) this.current = -1;
    else if (jump || !before) this.current = nearestMatch(this.matches, this.host.from());
    else
      this.current = Math.max(
        0,
        nearestMatch(this.matches, { cellIndex: before.cellIndex, offset: before.start }),
      );
    this.render();
    if (jump && this.current >= 0) this.host.reveal(this.matches[this.current] as FindMatch);
  }

  /** Moves to the next (1) or previous (-1) match; returns it. */
  step(direction: 1 | -1): FindMatch | null {
    if (!this.matches.length) this.search();
    if (!this.matches.length) return null;
    const n = this.matches.length;
    this.current =
      this.current < 0 ? (direction === 1 ? 0 : n - 1) : (this.current + direction + n) % n;
    this.render();
    const m = this.matches[this.current] as FindMatch;
    this.host.reveal(m);
    return m;
  }

  /** Replaces the current match (sources only) and moves to the next; how many were replaced. */
  replace(replacement: string): number {
    const m = this.matches[this.current];
    if (m?.where !== "source") {
      // Outputs aren't the user's text: move on to the next match instead.
      this.step(1);
      return 0;
    }
    const cell = this.host.cells()[m.cellIndex];
    if (!cell) return 0;
    // The text the match was found in (search reads the source as it is): a CRLF source made
    // LF here would shift every offset after its first line break.
    const text = cell.cell.source;
    const value = replacementFor(text, m, replacement, this.options);
    this.host.setSources([
      { index: m.cellIndex, source: text.slice(0, m.start) + value + text.slice(m.end) },
    ]);
    const at = { cellIndex: m.cellIndex, offset: m.start + value.length };
    this.search();
    this.current = this.matches.length ? nearestMatch(this.matches, at) : -1;
    this.render();
    if (this.current >= 0) this.host.reveal(this.matches[this.current] as FindMatch);
    return 1;
  }

  /** Replaces every match in the sources (one undo step); how many. */
  replaceAll(replacement: string): number {
    const changes: { index: number; source: string }[] = [];
    let count = 0;
    for (const [index, cell] of this.host.cells().entries()) {
      const wanted =
        cell.cell.kind === "markdown"
          ? this.options.markdown !== false
          : this.options.code !== false;
      if (!wanted) continue;
      const r = replaceAllIn(cell.cell.source, this.options, replacement);
      if (!r.count) continue;
      count += r.count;
      changes.push({ index, source: r.text });
    }
    if (changes.length) this.host.setSources(changes);
    this.search();
    return count;
  }

  /** Highlights drawn again (a cell's editor was made, outputs redrawn). */
  redraw(): void {
    if (this.isOpen) this.render();
  }

  private render(): void {
    const n = this.matches.length;
    this.count.textContent = this.error
      ? "Bad pattern"
      : !this.options.query
        ? ""
        : n
          ? `${this.current + 1} of ${n >= 5000 ? "5000+" : n}`
          : "No results";
    this.element.classList.toggle("is-empty", !!this.options.query && (n === 0 || !!this.error));
    if (this.error) setTooltip(this.count, this.error);
    this.paint();
  }

  private clearHighlights(): void {
    for (const c of this.decorated) c.editor?.highlightRanges?.(OWNER, []);
    this.decorated.clear();
    highlights()?.delete("nb-find");
    highlights()?.delete("nb-find-current");
  }

  /** Draws the matches: in editors (sources), in rendered Markdown and outputs (CSS). */
  private paint(): void {
    const cells = this.host.cells();
    const current = this.matches[this.current];
    const bySource = new Map<number, FindMatch[]>();
    for (const m of this.matches)
      if (m.where === "source")
        bySource.set(m.cellIndex, [...(bySource.get(m.cellIndex) ?? []), m]);
    const now = new Set<CellView>();
    for (const [i, c] of cells.entries()) {
      const list = bySource.get(i);
      if (!c.editor || (!list && !this.decorated.has(c))) continue;
      c.editor.highlightRanges?.(
        OWNER,
        (list ?? []).map((m) => ({
          startLine: m.line,
          startColumn: m.column,
          endLine: m.endLine,
          endColumn: m.endColumn,
          current: m === current,
        })),
      );
      if (list) now.add(c);
    }
    this.decorated = now;
    this.paintDom(cells, current);
  }

  /** Rendered Markdown and outputs: the query's matches in their text, by CSS highlight. */
  private paintDom(cells: readonly CellView[], current: FindMatch | undefined): void {
    const registry = highlights();
    if (!registry || !HighlightClass) return;
    const pattern = findPattern(this.options);
    if (!(pattern instanceof RegExp)) {
      registry.delete("nb-find");
      registry.delete("nb-find-current");
      return;
    }
    const all: Range[] = [];
    const now: Range[] = [];
    for (const [i, c] of cells.entries()) {
      const roots: Element[] = [];
      if (c.cell.kind === "markdown" && !c.editingMarkdown && this.options.markdown !== false) {
        const md = c.element.querySelector(".nb-markdown");
        if (md) roots.push(md);
      }
      if (this.options.outputs) {
        const out = c.element.querySelector(".nb-outputs-body");
        if (out) roots.push(out);
      }
      // Output matches of this cell, in order: the current one is the k-th found in the DOM.
      const outputMatches = this.matches.filter((m) => m.cellIndex === i && m.where === "output");
      const k =
        current && current.cellIndex === i && current.where === "output"
          ? outputMatches.indexOf(current)
          : -1;
      let seen = 0;
      for (const root of roots) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent ?? "";
          for (const m of matchesIn(text, pattern, 1000)) {
            const range = document.createRange();
            range.setStart(node, m.start);
            range.setEnd(node, m.end);
            const isOutput = root.classList.contains("nb-outputs-body");
            if (isOutput && seen++ === k) now.push(range);
            else all.push(range);
          }
        }
      }
    }
    registry.set("nb-find", new HighlightClass(...all));
    registry.set("nb-find-current", new HighlightClass(...now));
  }

  dispose(): void {
    this.store.dispose();
  }
}
