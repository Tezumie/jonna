// The composer's "/" list (D389): while the message starts with "/" and its first word is being
// typed, the commands matching it show over the box, as wide as the box (Claude Code's and other
// harnesses' inline list, in place of the command palette). ↑/↓ choose, Tab fills in "/name ",
// Enter fills it in and sends a command that takes no argument, Esc closes it; the caret stays
// in the box. The ranking is core/agent/slash.ts (rankSlashCommands).
import { rankSlashCommands } from "../../../core/agent/slash";
import { h, on } from "../../../core/dom/index";
import { type Disposable, DisposableStore } from "../../../core/lifecycle/index";

export interface SlashItem {
  name: string;
  description: string;
  source: string;
  argumentHint?: string;
  aliases?: readonly string[];
}

export interface SlashListHost {
  input: HTMLTextAreaElement;
  /** Where the list opens (above the box). */
  anchor: HTMLElement;
  /** Every command this chat has (built-ins, prompt files, skills, MCP prompts…). */
  commands(): Promise<readonly SlashItem[]>;
  /** The text changed (the composer resizes). */
  changed(): void;
  /** Sends what's in the box. */
  submit(): void;
}

/** How long a loaded list is reused while typing (files come and go rarely). */
const FRESH_MS = 5000;
/** Rows shown at most (the list scrolls past a few). */
const MAX_ROWS = 60;

export class SlashList implements Disposable {
  private readonly store = new DisposableStore();
  private readonly list = h("div", {
    class: "agent-suggest-list agent-slash-list",
    role: "listbox",
    "aria-label": "Commands",
    hidden: true,
  });
  private rows: { item: SlashItem; el: HTMLElement }[] = [];
  private active = 0;
  /** The query Esc closed the list on (it stays closed until the text changes). */
  private dismissed: string | null = null;
  private loaded: { at: number; items: readonly SlashItem[] } | null = null;
  private loading: Promise<readonly SlashItem[]> | null = null;
  private generation = 0;

  constructor(private readonly host: SlashListHost) {
    host.anchor.append(this.list);
    this.store.add(on(host.input, "input", () => void this.refresh()));
    this.store.add(on(host.input, "click", () => void this.refresh()));
    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    this.store.add(
      on(host.input, "blur", () => {
        clearTimeout(blurTimer);
        blurTimer = setTimeout(() => this.close(), 120);
      }),
    );
    this.store.add({ dispose: () => clearTimeout(blurTimer) });
    // Capture phase: before the composer's own Enter (send) and ↑ (the last message).
    this.store.add(
      on(
        host.input,
        "keydown",
        (e) => {
          if (this.list.hidden) return;
          const ev = e as KeyboardEvent;
          if (ev.key === "ArrowDown" || ev.key === "ArrowUp")
            this.move(ev.key === "ArrowDown" ? 1 : -1);
          else if (ev.key === "Tab" && !ev.isComposing) this.pick(false);
          else if (ev.key === "Enter" && !ev.isComposing && !ev.shiftKey) this.pick(true);
          else if (ev.key === "Escape") {
            this.dismissed = this.query();
            this.close();
          } else return;
          e.preventDefault();
          e.stopImmediatePropagation();
        },
        { capture: true },
      ),
    );
  }

  /** Whether the list is showing (the composer leaves "/" alone then). */
  get open(): boolean {
    return !this.list.hidden;
  }

  /**
   * The command name being typed: the whole message is "/" and one word so far (a space ends it,
   * as in Claude Code: what follows is the command's argument).
   */
  private query(): string | null {
    const m = /^\/([\w:.-]*)$/.exec(this.host.input.value);
    return m ? (m[1] ?? "") : null;
  }

  private async commands(): Promise<readonly SlashItem[]> {
    if (this.loaded && Date.now() - this.loaded.at < FRESH_MS) return this.loaded.items;
    this.loading ??= this.host
      .commands()
      .catch(() => [] as readonly SlashItem[])
      .finally(() => {
        this.loading = null;
      });
    const items = await this.loading;
    this.loaded = { at: Date.now(), items };
    return items;
  }

  /** The list for what's typed now, or closed. */
  async refresh(): Promise<void> {
    const q = this.query();
    if (q === null) {
      this.dismissed = null;
      this.close();
      return;
    }
    if (q === this.dismissed) return;
    const generation = ++this.generation;
    const items = await this.commands();
    if (generation !== this.generation || this.query() !== q) return;
    const ranked = rankSlashCommands(q, items).slice(0, MAX_ROWS);
    if (!ranked.length) {
      this.close();
      return;
    }
    const before = this.rows[this.active]?.item.name;
    this.rows = ranked.map((item) => ({ item, el: this.row(item) }));
    const keep = this.rows.findIndex((r) => r.item.name === before);
    this.active = q && keep < 0 ? 0 : Math.max(0, keep);
    this.list.replaceChildren(...this.rows.map((r) => r.el));
    this.rows.forEach((r, i) => {
      r.el.addEventListener("mousedown", (e) => {
        // Keeps the caret in the box.
        e.preventDefault();
        this.active = i;
        this.pick(true);
      });
      r.el.addEventListener("mousemove", () => {
        if (this.active !== i) {
          this.active = i;
          this.paint();
        }
      });
    });
    this.list.hidden = false;
    this.paint();
  }

  private row(item: SlashItem): HTMLElement {
    return h(
      "div",
      { class: "agent-suggest-row agent-slash-row", role: "option", "data-command": item.name },
      h("span", { class: "agent-slash-name" }, `/${item.name}`),
      item.argumentHint ? h("span", { class: "agent-slash-hint" }, item.argumentHint) : null,
      h("span", { class: "agent-slash-desc" }, item.description),
      item.source !== "built-in" ? h("span", { class: "agent-slash-source" }, item.source) : null,
    );
  }

  /** Fills in the chosen command; `send` sends one that takes no argument (Claude Code's Enter). */
  private pick(send: boolean): void {
    const item = this.rows[this.active]?.item;
    if (!item) return;
    const { input } = this.host;
    const rest = input.value.slice(input.selectionStart ?? input.value.length).replace(/^\S*/, "");
    const takesArgs = !!item.argumentHint;
    const text = `/${item.name}${takesArgs || rest.trim() ? " " : ""}`;
    input.value = text + rest.replace(/^\s+/, "");
    input.setSelectionRange(text.length, text.length);
    this.dismissed = item.name;
    this.close();
    this.host.changed();
    input.focus();
    if (send && !takesArgs && !rest.trim()) this.host.submit();
  }

  private move(delta: number): void {
    if (!this.rows.length) return;
    this.active = (this.active + delta + this.rows.length) % this.rows.length;
    this.paint();
  }

  private paint(): void {
    this.rows.forEach((r, i) => {
      const on = i === this.active;
      r.el.classList.toggle("is-active", on);
      r.el.setAttribute("aria-selected", String(on));
      if (on) r.el.scrollIntoView({ block: "nearest" });
    });
  }

  private close(): void {
    this.generation++;
    this.list.hidden = true;
    this.list.replaceChildren();
    this.rows = [];
  }

  dispose(): void {
    this.close();
    this.list.remove();
    this.store.dispose();
  }
}
