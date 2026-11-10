// Find in the Markdown preview (D210), like VS Code's preview find widget: Ctrl/Cmd+F in the
// preview opens a small bar at its top right (the query, match case / whole word / regex, "n of
// m", previous / next, close); every match is highlighted (CSS highlights) with the current one
// distinct and scrolled into view; Enter / Shift+Enter (and F3 / Shift+F3) step, Escape closes.
// Its buttons and keys run the markdown.find… commands (index.ts); the matching is
// previewFind.ts.
import { h, on } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { type IconName, icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import {
  findInSegments,
  firstMatchFrom,
  matchCountLabel,
  type PreviewFindOptions,
  type SegmentMatch,
  stepMatch,
  type TextSegment,
} from "./previewFind";

export interface PreviewFindHost {
  /** The rendered document (what's searched). */
  readonly body: HTMLElement;
  /** What scrolls. */
  readonly scroller: HTMLElement;
  run(command: string, input?: Record<string, unknown>): void;
}

/** What the commands and `ide://markdownPreview` report. */
export interface PreviewFindInfo {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  matches: number;
  /** 0-based; -1 with no match. */
  current: number;
  error?: string;
  /** The current match's text. */
  text?: string;
}

type CSSHighlights = { set(name: string, value: unknown): void; delete(name: string): void };
const highlights = (): CSSHighlights | null =>
  (globalThis as unknown as { CSS?: { highlights?: CSSHighlights } }).CSS?.highlights ?? null;
const HighlightClass = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown })
  .Highlight;
/** The bar whose matches the (window-wide) highlights show: only it clears them. */
let painter: MarkdownFindBar | null = null;

/** Text that isn't the document's own: code blocks' headers (language, Copy), buttons, TeX. */
const SKIP = ".md-pre-header, button, annotation, style, script, .md-diagram-toolbar";
/** Elements whose text is a block of its own (a match never runs from one into the next). */
const BLOCK =
  "p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, dt, dd, summary, figcaption, caption, tr, div, section, details, table, ul, ol, dl";

export class MarkdownFindBar {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly input: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly toggles = new Map<"caseSensitive" | "wholeWord" | "regex", HTMLElement>();
  options: PreviewFindOptions = { query: "" };
  private ranges: Range[] = [];
  current = -1;
  error: string | null = null;
  private frame = 0;

  constructor(private readonly host: PreviewFindHost) {
    this.input = h("input", {
      class: "input md-find-input",
      type: "text",
      placeholder: "Find",
      spellcheck: "false",
      "aria-label": "Find in preview",
    }) as HTMLInputElement;
    this.count = h("span", { class: "md-find-count", "aria-live": "polite" });
    const button = (glyph: IconName, label: string, command: string) => {
      const b = h(
        "button",
        { class: "icon-button", type: "button", "aria-label": label },
        icon(glyph),
      );
      setTooltip(b, label);
      this.store.add(on(b, "click", () => host.run(command)));
      return b;
    };
    const toggle = (
      key: "caseSensitive" | "wholeWord" | "regex",
      glyph: IconName,
      label: string,
    ) => {
      const b = h(
        "button",
        {
          class: "icon-button md-find-toggle",
          type: "button",
          "aria-label": label,
          "aria-pressed": "false",
        },
        icon(glyph),
      );
      setTooltip(b, label);
      this.store.add(
        on(b, "click", () =>
          host.run("markdown.find", { [key]: !this.options[key], focus: false }),
        ),
      );
      this.toggles.set(key, b);
      return b;
    };
    this.element = h(
      "div",
      { class: "md-find", role: "search", hidden: true },
      this.input,
      toggle("caseSensitive", "case-sensitive", "Match case"),
      toggle("wholeWord", "whole-word", "Match whole word"),
      toggle("regex", "regex", "Use regular expression"),
      this.count,
      button("arrow-up", "Previous match (Shift+Enter)", "markdown.findPrevious"),
      button("arrow-down", "Next match (Enter)", "markdown.findNext"),
      button("x", "Close (Escape)", "markdown.closeFind"),
    );
    this.store.add(
      on(this.input, "input", () => {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() =>
          host.run("markdown.find", { query: this.input.value, focus: false }),
        );
      }),
    );
    // Normally the keybindings (Enter, Shift+Enter, Escape in the field) run these first; this
    // is for a user who unbound them.
    this.store.add(
      on(this.input, "keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          host.run("markdown.closeFind");
        } else if (e.key === "Enter") {
          e.preventDefault();
          host.run(e.shiftKey ? "markdown.findPrevious" : "markdown.findNext");
        }
      }),
    );
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

  /** Whether `target` is the bar's find field. */
  holds(target: EventTarget | null): boolean {
    return target === this.input;
  }

  /** The preview's tab was hidden: its highlights go (another preview may show its own). */
  hideHighlights(): void {
    this.clearHighlights();
  }

  /** Opens (or updates) the search; `focus` puts the cursor in the field, its text selected. */
  open(options: Partial<PreviewFindOptions> & { focus?: boolean }): void {
    const { focus, ...rest } = options;
    // Ctrl+F with text selected in the preview searches for it (VS Code's seeding).
    if (rest.query === undefined && focus !== false && !this.isOpen) {
      const selected = window.getSelection()?.toString() ?? "";
      if (selected && !selected.includes("\n") && selected.length <= 200) rest.query = selected;
    }
    this.options = { ...this.options, ...rest };
    if (rest.query !== undefined && this.input.value !== rest.query) this.input.value = rest.query;
    this.element.hidden = false;
    for (const [key, el] of this.toggles) {
      const on = !!this.options[key];
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
    this.ranges = [];
    this.current = -1;
    this.error = null;
    this.clearHighlights();
  }

  /** Finds again; `jump`: make the first match from the reading position current, and show it. */
  search(jump = false): void {
    const { segments, nodes } = this.collect();
    const found = findInSegments(segments, this.options);
    this.error = typeof found === "string" ? found : null;
    const matches = typeof found === "string" ? [] : found;
    const before = this.current;
    this.ranges = matches.map((m) => this.rangeOf(m, nodes));
    if (!this.ranges.length) this.current = -1;
    else if (jump || before < 0) this.current = firstMatchFrom(matches, this.firstVisible(nodes));
    else this.current = Math.min(before, this.ranges.length - 1);
    this.paint();
    if (jump) this.reveal();
  }

  /** Moves to the next (1) or previous (-1) match, wrapping, and shows it. */
  step(direction: 1 | -1): void {
    if (!this.ranges.length) this.search();
    this.current = stepMatch(this.current, this.ranges.length, direction);
    this.paint();
    this.reveal();
  }

  /** The preview drew again (typing in its file): the matches are found in the new text. */
  refresh(): void {
    if (this.isOpen) this.search(false);
  }

  info(): PreviewFindInfo {
    const range = this.ranges[this.current];
    return {
      open: this.isOpen,
      query: this.options.query,
      caseSensitive: !!this.options.caseSensitive,
      wholeWord: !!this.options.wholeWord,
      regex: !!this.options.regex,
      matches: this.ranges.length,
      current: this.current,
      ...(this.error && { error: this.error }),
      ...(range && { text: range.toString() }),
    };
  }

  focusInput(): void {
    this.input.focus();
  }

  private collect(): { segments: TextSegment[]; nodes: Text[] } {
    const segments: TextSegment[] = [];
    const nodes: Text[] = [];
    const blocks = new Map<Element, number>();
    const walker = document.createTreeWalker(this.host.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n as Text;
      const blockEl = text.parentElement?.closest(BLOCK) ?? this.host.body;
      let block = blocks.get(blockEl);
      if (block === undefined) {
        block = blocks.size;
        blocks.set(blockEl, block);
      }
      segments.push({ text: text.data, block });
      nodes.push(text);
    }
    return { segments, nodes };
  }

  private rangeOf(m: SegmentMatch, nodes: readonly Text[]): Range {
    const range = document.createRange();
    const start = nodes[m.startSegment];
    const end = nodes[m.endSegment];
    if (start && end) {
      range.setStart(start, Math.min(m.startOffset, start.length));
      range.setEnd(end, Math.min(m.endOffset, end.length));
    }
    return range;
  }

  /** The first text node at or below the top of the view (where "find" starts, like VS Code). */
  private firstVisible(nodes: readonly Text[]): number {
    const top = this.host.scroller.getBoundingClientRect().top;
    if (this.host.scroller.scrollTop <= 0) return 0;
    const probe = document.createRange();
    for (const [i, n] of nodes.entries()) {
      probe.selectNodeContents(n);
      const rect = probe.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom >= top) return i;
    }
    return 0;
  }

  /** Scrolls the current match into view (opening a closed <details> around it). */
  private reveal(): void {
    const range = this.ranges[this.current];
    if (!range) return;
    let el: Element | null | undefined = range.startContainer.parentElement;
    for (; el && el !== this.host.body; el = el.parentElement)
      if (el instanceof HTMLDetailsElement && !el.open) el.open = true;
    const rect = range.getBoundingClientRect();
    const box = this.host.scroller.getBoundingClientRect();
    const margin = 48;
    if (rect.top < box.top + margin || rect.bottom > box.bottom - margin)
      this.host.scroller.scrollTop += rect.top - box.top - box.height / 3;
  }

  private paint(): void {
    this.count.textContent = matchCountLabel(
      this.options.query,
      this.current,
      this.ranges.length,
      this.error,
    );
    if (this.error) setTooltip(this.count, this.error);
    else delete this.count.dataset.tooltip;
    this.element.classList.toggle(
      "is-empty",
      !!this.options.query && (!this.ranges.length || !!this.error),
    );
    const registry = highlights();
    if (!registry || !HighlightClass) return;
    const current = this.ranges[this.current];
    painter = this;
    registry.set("md-find", new HighlightClass(...this.ranges.filter((r) => r !== current)));
    registry.set("md-find-current", new HighlightClass(...(current ? [current] : [])));
  }

  private clearHighlights(): void {
    // Another preview's (a hidden or closing one mustn't wipe the visible one's).
    if (painter !== this) return;
    painter = null;
    highlights()?.delete("md-find");
    highlights()?.delete("md-find-current");
  }

  dispose(): void {
    this.store.dispose();
  }
}
