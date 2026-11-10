// DevTools Console: the page's console (levels, groups, repeat counts, expandable objects,
// elements that reveal in Elements, stacks), failed requests, and an input line that evaluates
// in the page (Enter; Shift+Enter for a new line; ↑/↓ history).
import { h, on } from "../../../core/dom/index";
import { DisposableStore } from "../../../core/lifecycle/index";
import { effect } from "../../../core/reactive/index";
import { icon } from "../../../ui/Icon";
import { type ConsoleEntry, logDiff, type NetworkFailure } from "../page";
import { type DevtoolsHost, type DevtoolsPanel, filterInput, iconButton, toggle } from "./common";

type Level = "error" | "warn" | "info" | "verbose";
const levelOf = (e: ConsoleEntry): Level =>
  e.level === "error"
    ? "error"
    : e.level === "warn"
      ? "warn"
      : e.level === "debug"
        ? "verbose"
        : "info";

type Row = ConsoleEntry | NetworkFailure;
const NO_FAILURES: readonly NetworkFailure[] = [];
const isFailure = (row: Row): row is NetworkFailure => "method" in row;

export class ConsolePanel implements DevtoolsPanel {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly list: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private filter = "";
  private readonly levels = new Set<Level>(["error", "warn", "info", "verbose"]);
  private readonly history: string[] = [];
  private historyAt = -1;
  private stickToBottom = true;
  /** Expanded object args, by entry key + arg index (survives re-renders). */
  private readonly open = new Set<string>();
  /** Per-entry keys by identity, so trimming the front doesn't shift what's expanded. */
  private readonly keys = new WeakMap<Row, number>();
  private nextKey = 0;
  /** Messages come in storms: they're drawn at most once a frame, and not while hidden. */
  private shown = false;
  private frame = 0;
  /** What the list shows, row by row, so new messages append instead of rebuilding it all. */
  private view: {
    entries: readonly ConsoleEntry[];
    failures: readonly NetworkFailure[];
    /** Every merged row, with its element (null: filtered out or a group end) and depth. */
    rows: { row: Row; el: HTMLElement | null; depth: number }[];
    /** The depth after the last row. */
    depth: number;
  } | null = null;
  private emptyShown = false;

  constructor(private readonly host: DevtoolsHost) {
    const { page } = host;
    const s = this.store;
    const chips = new Map<Level, HTMLButtonElement>();
    const setLevel = (level: Level, on: boolean) => {
      if (on) this.levels.add(level);
      else this.levels.delete(level);
      chips.get(level)?.setAttribute("aria-pressed", String(on));
      syncLevels();
      this.render();
    };
    const levelChip = (level: Level, label: string) => {
      const chip = toggle(s, label, true, (on) => setLevel(level, on));
      chip.classList.add("dt-level-chip");
      chips.set(level, chip);
      return chip;
    };
    const LEVELS: [Level, string][] = [
      ["error", "Errors"],
      ["warn", "Warnings"],
      ["info", "Info"],
      ["verbose", "Verbose"],
    ];
    // Narrow DevTools: the levels in one menu, as Chrome's "Default levels".
    const levelsButton = h(
      "button",
      { class: "dt-chip dt-levels", type: "button", "aria-haspopup": "menu" },
      h("span", { class: "dt-label" }, "All levels"),
      icon("chevron-down"),
    );
    const syncLevels = () => {
      const label = levelsButton.querySelector(".dt-label");
      if (label)
        label.textContent =
          this.levels.size === LEVELS.length
            ? "All levels"
            : this.levels.size === 0
              ? "No levels"
              : "Custom levels";
    };
    s.add(
      on(levelsButton, "click", (e) =>
        host.menu(
          e,
          LEVELS.map(([level, label]) => ({
            label,
            checked: this.levels.has(level),
            run: () => setLevel(level, !this.levels.has(level)),
          })),
        ),
      ),
    );
    const preserve = toggle(
      s,
      "Preserve log",
      page.preserveLog,
      (on) => (page.preserveLog = on),
      "Keep messages when the page navigates",
    );
    const toolbar = h(
      "div",
      { class: "dt-toolbar" },
      iconButton(s, "ban", "Clear console", () => page.clearConsole()),
      filterInput(s, "Filter", (t) => {
        this.filter = t;
        this.render();
      }),
      ...LEVELS.map(([level, label]) => levelChip(level, label)),
      levelsButton,
      h("span", { class: "dt-spacer" }),
      preserve,
    );
    this.list = h("div", { class: "dt-console-list", tabindex: "-1" });
    s.add(
      on(this.list, "scroll", () => {
        this.stickToBottom =
          this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 24;
      }),
    );
    this.input = h("textarea", {
      class: "dt-console-input",
      rows: "1",
      spellcheck: "false",
      placeholder: "Run JavaScript in the page",
      "aria-label": "Console input",
    });
    s.add(on(this.input, "keydown", (e) => this.onKey(e)));
    s.add(
      on(this.input, "input", () => {
        this.input.style.height = "auto";
        this.input.style.height = `${Math.min(this.input.scrollHeight, 160)}px`;
      }),
    );
    const prompt = h("div", { class: "dt-console-prompt" }, icon("chevron-right"), this.input);
    this.element = h("div", { class: "dt-panel dt-console" }, toolbar, this.list, prompt);
    s.add(
      effect(() => {
        page.console.value;
        page.network.value;
        this.schedule();
        return undefined;
      }),
    );
    s.add({ dispose: () => cancelAnimationFrame(this.frame) });
  }

  onShow(): void {
    this.shown = true;
    this.update();
    requestAnimationFrame(() => this.input.focus());
  }

  onHide(): void {
    this.shown = false;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private schedule(): void {
    if (!this.shown || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  }

  private keyOf(row: Row): string {
    let key = this.keys.get(row);
    if (key === undefined) {
      key = this.nextKey++;
      this.keys.set(row, key);
    }
    return String(key);
  }

  private matches(text: string): boolean {
    return !this.filter || text.toLowerCase().includes(this.filter);
  }

  /** One merged row's element (null when filtered out) and the depth after it. */
  private buildRow(row: Row, depth: number): { el: HTMLElement | null; depth: number } {
    if (isFailure(row)) {
      const text = `${row.method} ${row.url} ${row.status || row.error || "failed"}`;
      if (!this.matches(text)) return { el: null, depth };
      return {
        el: h(
          "div",
          { class: "dt-log is-error", style: { "--depth": String(depth) } },
          icon("globe"),
          h("span", { class: "dt-log-text" }, `${row.method} ${row.url}`),
          h(
            "span",
            { class: "dt-log-source" },
            row.status ? String(row.status) : (row.error ?? "failed"),
          ),
        ),
        depth,
      };
    }
    if (row.group === "end") return { el: null, depth: Math.max(0, depth - 1) };
    const level = levelOf(row);
    const isInput = row.origin === "input";
    if (!isInput && row.origin !== "result" && !this.levels.has(level)) return { el: null, depth };
    if (!this.matches(row.text)) return { el: null, depth };
    return {
      el: this.renderEntry(row, this.keyOf(row), depth),
      depth: row.group === "start" ? depth + 1 : depth,
    };
  }

  private current(): { entries: readonly ConsoleEntry[]; failures: readonly NetworkFailure[] } {
    const { page } = this.host;
    return {
      entries: page.console.peek(),
      failures: this.levels.has("error") ? page.network.peek() : NO_FAILURES,
    };
  }

  /** Redraws everything (filters changed, or the log changed other than by appending). */
  private render(): void {
    const { entries, failures } = this.current();
    // Merge console lines and failed requests by time.
    const rows: Row[] = [...entries, ...failures].sort((a, b) => a.time - b.time);
    const out: HTMLElement[] = [];
    const shown: { row: Row; el: HTMLElement | null; depth: number }[] = [];
    let depth = 0;
    for (const row of rows) {
      const built = this.buildRow(row, depth);
      shown.push({ row, el: built.el, depth });
      if (built.el) out.push(built.el);
      depth = built.depth;
    }
    this.view = { entries, failures, rows: shown, depth };
    this.emptyShown = !out.length;
    const empty = h(
      "div",
      { class: "dt-empty" },
      entries.length ? "No messages match." : "No messages yet.",
    );
    this.list.replaceChildren(...(out.length ? out : [empty]));
    if (this.stickToBottom) this.list.scrollTop = this.list.scrollHeight;
  }

  /**
   * Brings the list up to date: when the log only gained lines at the end (and maybe lost some
   * at the front, or bumped its last line's repeat count), just those rows change; otherwise
   * it's redrawn. The result is the same as render()'s.
   */
  private update(): void {
    const v = this.view;
    // Nothing shown yet: the empty note's wording may change, and a redraw is cheap.
    if (!v || this.emptyShown) {
      this.render();
      return;
    }
    const { entries, failures } = this.current();
    if (entries === v.entries && failures === v.failures) return;
    const e = logDiff(v.entries, entries);
    const f = logDiff(v.failures, failures);
    if (!e || !f || f.replaced) {
      this.render();
      return;
    }
    // The rows that left must be the first ones shown, and not groups (depths would change).
    const dropped = e.dropped + f.dropped;
    const leaving = new Set<Row>([
      ...v.entries.slice(0, e.dropped),
      ...v.failures.slice(0, f.dropped),
    ]);
    for (let i = 0; i < dropped; i++) {
      const r = v.rows[i]?.row;
      if (!r || !leaving.has(r) || (!isFailure(r) && r.group)) {
        this.render();
        return;
      }
    }
    let lastRow = v.rows[v.rows.length - 1];
    let replacement: { el: HTMLElement | null; at: number } | null = null;
    if (e.replaced) {
      const old = v.entries[v.entries.length - 1];
      // Only the last row may change in place (its time moves on, so it must stay last).
      const at = v.rows.length - 1;
      if (
        !old ||
        lastRow?.row !== old ||
        dropped > at ||
        e.replaced.group ||
        old.group ||
        e.replaced.time < old.time
      ) {
        this.render();
        return;
      }
      replacement = { el: this.buildRow(e.replaced, lastRow.depth).el, at };
      lastRow = { row: e.replaced, el: replacement.el, depth: lastRow.depth };
    }
    // New rows must sort after everything shown, as render()'s stable sort puts them (at equal
    // times, console lines before failed requests).
    const added: Row[] = [...e.added, ...f.added].sort((a, b) => a.time - b.time);
    if (lastRow) {
      const t = lastRow.row.time;
      const lastIsFailure = isFailure(lastRow.row);
      for (const a of added)
        if (a.time < t || (a.time === t && lastIsFailure && !isFailure(a))) {
          this.render();
          return;
        }
    }
    // Apply.
    for (const gone of v.rows.splice(0, dropped)) gone.el?.remove();
    if (replacement) {
      const slot = v.rows[replacement.at - dropped];
      if (!slot) {
        this.render();
        return;
      }
      if (slot.el && replacement.el) slot.el.replaceWith(replacement.el);
      else if (slot.el) slot.el.remove();
      else if (replacement.el) {
        // Was filtered out, now shown: it's the last row, so it goes at the end.
        this.list.append(replacement.el);
      }
      slot.row = e.replaced as Row;
      slot.el = replacement.el;
    }
    let depth = v.depth;
    for (const row of added) {
      const built = this.buildRow(row, depth);
      v.rows.push({ row, el: built.el, depth });
      if (built.el) this.list.append(built.el);
      depth = built.depth;
    }
    v.depth = depth;
    v.entries = entries;
    v.failures = failures;
    // Nothing left to show: render() puts up the empty note.
    if (!v.rows.some((r) => r.el)) {
      this.render();
      return;
    }
    if (this.stickToBottom) this.list.scrollTop = this.list.scrollHeight;
  }

  private renderEntry(e: ConsoleEntry, key: string, depth: number): HTMLElement {
    const level = e.origin === "input" ? "input" : e.origin === "result" ? "result" : e.level;
    const glyph =
      e.origin === "input"
        ? icon("chevron-right")
        : e.origin === "result"
          ? icon("arrow-left")
          : e.level === "error"
            ? icon("circle-x")
            : e.level === "warn"
              ? icon("triangle-alert")
              : e.level === "info"
                ? icon("info")
                : h("span", { class: "dt-log-dot" });
    const body = h("span", { class: "dt-log-text" });
    if (e.args?.length) {
      e.args.forEach((a, i) => {
        if (i) body.append(" ");
        if (a.ref) {
          const link = h("button", { class: "dt-log-node", type: "button" }, a.text);
          const ref = a.ref;
          link.addEventListener("click", () => this.host.revealElement(ref));
          link.addEventListener("mouseenter", () => this.host.run("browser.highlight", { ref }));
          link.addEventListener("mouseleave", () => this.host.run("browser.highlight", {}));
          body.append(link);
        } else if (a.json) {
          const id = `${key}:${i}`;
          const opened = this.open.has(id);
          const head = h(
            "button",
            { class: "dt-log-object", type: "button", "aria-expanded": String(opened) },
            icon(opened ? "chevron-down" : "chevron-right"),
            a.text,
          );
          head.addEventListener("click", () => {
            if (this.open.has(id)) this.open.delete(id);
            else this.open.add(id);
            this.render();
          });
          body.append(head);
          if (opened) body.append(h("pre", { class: "dt-log-json" }, a.json));
        } else body.append(h("span", { class: `dt-val is-${a.kind}` }, a.text));
      });
    } else body.append(e.text);
    const row = h(
      "div",
      {
        class: `dt-log is-${level}${e.group === "start" ? " is-group" : ""}`,
        style: { "--depth": String(depth) },
      },
      glyph,
      body,
      e.count && e.count > 1 ? h("span", { class: "dt-log-count" }, String(e.count)) : null,
      e.source ? this.sourceLink(e.source) : null,
    );
    if (e.stack) {
      const id = `${key}:stack`;
      const opened = this.open.has(id);
      const more = h(
        "button",
        { class: "dt-log-more", type: "button" },
        opened ? "Hide stack" : "Stack",
      );
      more.addEventListener("click", () => {
        if (this.open.has(id)) this.open.delete(id);
        else this.open.add(id);
        this.render();
      });
      row.append(more);
      if (opened)
        return h(
          "div",
          { class: "dt-log-wrap" },
          row,
          h("pre", { class: "dt-log-stack" }, e.stack),
        );
    }
    return row;
  }

  /** "http://…/main.js:12:5" → opens it in Sources at that line. */
  private sourceLink(source: string): HTMLElement {
    const m = /^(.*?):(\d+)(?::\d+)?$/.exec(this.host.displayUrl(source));
    const label = (m?.[1] ?? source).split("/").pop() + (m ? `:${m[2]}` : "");
    const b = h("button", { class: "dt-log-source dt-link", type: "button" }, label);
    b.addEventListener("click", () =>
      this.host.revealSource(m?.[1] ?? source, m ? Number(m[2]) : undefined),
    );
    return b;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const code = this.input.value.trim();
      if (!code) return;
      this.history.push(code);
      this.historyAt = -1;
      this.input.value = "";
      this.input.style.height = "auto";
      void this.evaluate(code);
    } else if (e.key === "ArrowUp" && !this.input.value.includes("\n")) {
      if (!this.history.length) return;
      e.preventDefault();
      this.historyAt =
        this.historyAt < 0 ? this.history.length - 1 : Math.max(0, this.historyAt - 1);
      this.input.value = this.history[this.historyAt] ?? "";
    } else if (e.key === "ArrowDown" && this.historyAt >= 0) {
      e.preventDefault();
      this.historyAt++;
      if (this.historyAt >= this.history.length) {
        this.historyAt = -1;
        this.input.value = "";
      } else this.input.value = this.history[this.historyAt] ?? "";
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      this.host.page.clearConsole();
    }
  }

  private async evaluate(code: string): Promise<void> {
    const { page } = this.host;
    this.stickToBottom = true;
    page.addConsole({ level: "log", text: code, time: Date.now(), origin: "input" });
    try {
      const r = await page.call<{
        ok: boolean;
        text: string;
        kind?: string;
        json?: string;
        ref?: string;
      }>("evaluate", { code });
      page.addConsole({
        level: r.ok ? "log" : "error",
        text: r.text,
        time: Date.now(),
        origin: "result",
        args: [
          {
            text: r.text,
            kind: r.kind ?? "string",
            ...(r.json && { json: r.json }),
            ...(r.ref && { ref: r.ref }),
          },
        ],
      });
    } catch (err) {
      page.addConsole({
        level: "error",
        text: err instanceof Error ? err.message : String(err),
        time: Date.now(),
        origin: "result",
      });
    }
  }

  focusInput(): void {
    this.input.focus();
  }

  dispose(): void {
    this.store.dispose();
  }
}
