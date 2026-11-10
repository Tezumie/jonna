// The terminal's suggest widget (VS Code's terminal IntelliSense, `terminal.suggest.enabled`):
// while typing at a prompt (shell integration tells where the input starts), a list under the
// cursor of programs, builtins, history, files and folders, git subcommands and branches
// (suggest.ts ranks them). Tab accepts; Enter accepts once the list was navigated (VS Code's
// "partial" selection mode, so Enter alone still runs the line); Up / Down move; Escape closes.
// The keys are commands bound while `terminalSuggestWidgetVisible` (index.ts).
import { h, on } from "../../core/dom/index";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { type IconName, icon } from "../../ui/Icon";
import { msysToWindows } from "./profiles";
import type { TerminalInstance } from "./service";
import {
  acceptKeys,
  completionContext,
  isTriggerCharacter,
  rankSuggestions,
  type ShellFamily,
  type ShellGlobal,
  type Suggestion,
  type SuggestSources,
  shellBuiltins,
  shellFamily,
  suggestNeeds,
} from "./suggest";

export interface SuggestHost {
  /** terminal.suggest.enabled. */
  enabled(): boolean;
  /** Program names on PATH (cached by Rust). */
  commands(): Promise<readonly string[]>;
  /** The aliases and functions of this terminal's shell (D229; asked once per shell). */
  globals(t: TerminalInstance, family: ShellFamily): Promise<readonly ShellGlobal[]>;
  /** Command lines run before, oldest first. */
  history(): readonly string[];
  /** Branch names of the repository the terminal's folder is in. */
  branches(): Promise<readonly string[]>;
  /** The user's home folder (`~`). */
  home(): string | null;
  /** The widget opened or closed in this terminal (the context keys). */
  visibilityChanged(widget: TerminalSuggest, visible: boolean, navigated: boolean): void;
}

const KIND_ICON: Record<Suggestion["kind"], IconName> = {
  command: "square-terminal",
  builtin: "braces",
  alias: "square-terminal",
  function: "braces",
  history: "history",
  folder: "folder",
  file: "file",
  "git-command": "git-branch",
  "git-branch": "git-branch",
};
const KIND_LABEL: Record<Suggestion["kind"], string> = {
  command: "Command",
  builtin: "Builtin",
  alias: "Alias",
  function: "Function",
  history: "History",
  folder: "Folder",
  file: "File",
  "git-command": "Git command",
  "git-branch": "Branch",
};

/** Listing a folder again within this long reuses the last listing (each keystroke asks). */
const DIR_TTL = 3000;
const BRANCH_TTL = 10_000;
/** Cursor moves this long after a keystroke are the shell's echo of it. */
const ECHO_MS = 500;
/** The list is never squeezed below about two rows. */
const MIN_LIST_PX = 48;

export class TerminalSuggest implements Disposable {
  private readonly store = new DisposableStore();
  private readonly el: HTMLElement;
  private readonly list: HTMLElement;
  /** The selected suggestion's details (VS Code's details pane): an alias's command… */
  private readonly details: HTMLElement;
  /** The shell's aliases and functions once they've come (D229), and whether they were asked. */
  private globals: readonly ShellGlobal[] | null = null;
  private globalsAsked = false;
  private items: Suggestion[] = [];
  private selected = 0;
  /** The user moved through the list (Enter accepts only then). */
  private navigated = false;
  private input: { line: string; cursor: number } | null = null;
  private typedAt = 0;
  private lastTyped = "";
  /** Each refresh's number: a slow listing for an older keystroke is dropped. */
  private version = 0;
  private frame = 0;
  private readonly family: ShellFamily;
  private readonly dirs = new Map<
    string,
    { at: number; entries: { name: string; dir: boolean }[] }
  >();
  private branchCache: { at: number; names: readonly string[] } | null = null;
  visible = false;

  constructor(
    private readonly t: TerminalInstance,
    private readonly view: HTMLElement,
    private readonly host: SuggestHost,
    private readonly listDir: (
      dir: string,
      hidden: boolean,
    ) => Promise<{ name: string; dir: boolean }[]>,
    private readonly send: (data: string) => void,
  ) {
    this.family = t.info.msys ? "posix" : shellFamily(t.info.shell);
    this.list = h("div", { class: "terminal-suggest-list", role: "listbox" });
    this.details = h("div", { class: "terminal-suggest-details", hidden: true });
    this.el = h(
      "div",
      { class: "terminal-suggest", hidden: true, "aria-label": "Suggestions" },
      this.list,
      this.details,
    );
    view.append(this.el);
    this.store.add(toDisposable(() => this.el.remove()));
    this.store.add(toDisposable(() => cancelAnimationFrame(this.frame)));
    // Keep the terminal focused when a row is clicked.
    this.store.add(on(this.el, "mousedown", (e) => e.preventDefault()));
    this.store.add(
      t.renderer.onInput((data) => {
        if (data === "\r" || data === "\x03" || data === "\x1b" || data === "\t") {
          this.hide();
          return;
        }
        // Typed text (a key or a paste of one word) and Backspace refresh the list.
        if (data === "\x7f" || data === "\b") {
          this.typedAt = Date.now();
          this.lastTyped = "";
          return;
        }
        if (data.length <= 32 && [...data].every((c) => c >= " " && c !== "\x7f")) {
          this.typedAt = Date.now();
          this.lastTyped = data.slice(-1);
          return;
        }
        // Arrows, Home / End, Ctrl+letters: the line changes in ways the list doesn't follow.
        this.hide();
      }),
    );
    this.store.add(
      t.renderer.onCursorMove(() => {
        if (Date.now() - this.typedAt > ECHO_MS) return;
        this.schedule(false);
      }),
    );
    this.store.add(t.onDidStartCommand(() => this.hide()));
    this.store.add(
      on(view, "focusout", (e) => {
        if (!view.contains(e.relatedTarget as Node | null)) this.hide();
      }),
    );
  }

  /** What the widget shows, for `ide://terminals`. */
  state(): {
    visible: boolean;
    line: string | null;
    selected: number;
    items: { label: string; kind: string }[];
  } {
    return {
      visible: this.visible,
      // What's typed at the prompt now (null while a command runs).
      line: this.t.renderer.promptInput()?.line ?? null,
      selected: this.selected,
      items: this.items.slice(0, 20).map((s) => ({ label: s.label, kind: s.kind })),
    };
  }

  private schedule(explicit: boolean): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => void this.refresh(explicit));
  }

  /** Opens (Ctrl+Space) or updates the list for what's typed now. */
  async refresh(explicit: boolean): Promise<void> {
    const mine = ++this.version;
    if (!this.host.enabled() || !this.t.info.integration || this.t.exitCode.peek() !== null) {
      this.hide();
      return;
    }
    const input = this.t.renderer.promptInput();
    if (!input) {
      this.hide();
      return;
    }
    const ctx = completionContext(input.line, input.cursor, this.family);
    const typedChar = this.lastTyped;
    // Opens by itself on a word character or a path separator; once open it follows typing.
    if (!explicit && !this.visible) {
      const opens =
        (ctx.token.length > 0 && /[\w.\-~]/.test(typedChar)) ||
        isTriggerCharacter(typedChar, this.family);
      if (!opens) return;
    }
    if (!explicit && this.visible && !ctx.token && !isTriggerCharacter(typedChar, this.family)) {
      this.hide();
      return;
    }
    const needs = suggestNeeds(ctx, this.family);
    const sources: SuggestSources = { line: input.line, history: this.host.history() };
    const jobs: Promise<unknown>[] = [];
    if (needs.commands) {
      sources.builtins = shellBuiltins(this.family);
      jobs.push(
        this.host
          .commands()
          .then((c) => (sources.commands = c))
          .catch(() => {}),
      );
      // The shell's aliases and functions come from starting that shell, which takes seconds
      // (an interactive Git Bash): asked in the background, used once they're there, never
      // waited for (the list must open as fast as without them).
      if (this.globals) sources.globals = this.globals;
      else if (!this.globalsAsked) {
        this.globalsAsked = true;
        void this.host
          .globals(this.t, this.family)
          .then((g) => {
            this.globals = g;
          })
          .catch(() => {});
      }
    }
    if (needs.git === "branch")
      jobs.push(
        this.branches()
          .then((b) => (sources.branches = b))
          .catch(() => {}),
      );
    if (needs.paths) {
      const { dir, base } = needs.paths;
      jobs.push(
        this.entries(dir, base.startsWith("."))
          .then((e) => (sources.entries = e))
          .catch(() => {}),
      );
    }
    await Promise.all(jobs);
    if (mine !== this.version || this.store.isDisposed) return;
    const items = rankSuggestions(ctx, needs, sources, this.family);
    // Nothing to add: just what's typed, alone, isn't a suggestion.
    if (!items.length || (items.length === 1 && items[0]?.insert === ctx.raw)) {
      this.hide();
      return;
    }
    const sameList =
      this.visible &&
      items.length === this.items.length &&
      items.every((s, i) => s.label === this.items[i]?.label);
    this.items = items;
    this.input = input;
    if (!sameList) {
      this.selected = 0;
      this.navigated = false;
    }
    this.render(ctx.tokenStart);
  }

  private async entries(typedDir: string, hidden: boolean) {
    let dir = typedDir;
    const home = this.host.home();
    if ((dir === "~" || dir.startsWith("~/") || dir.startsWith("~\\")) && home)
      dir = `${home}${dir.slice(1)}`;
    if (this.t.info.msys) dir = msysToWindows(dir.replace(/\/$/, "")) || dir;
    const key = `${hidden ? 1 : 0}\u0000${dir}`;
    const cached = this.dirs.get(key);
    if (cached && Date.now() - cached.at < DIR_TTL) return cached.entries;
    const entries = await this.listDir(dir || ".", hidden);
    this.dirs.set(key, { at: Date.now(), entries });
    if (this.dirs.size > 50) this.dirs.delete(this.dirs.keys().next().value ?? "");
    return entries;
  }

  private async branches(): Promise<readonly string[]> {
    if (this.branchCache && Date.now() - this.branchCache.at < BRANCH_TTL)
      return this.branchCache.names;
    const names = await this.host.branches();
    this.branchCache = { at: Date.now(), names };
    return names;
  }

  private render(tokenStart: number): void {
    const rows = this.items.map((s, i) => {
      const row = h(
        "div",
        {
          class: `terminal-suggest-item${i === this.selected ? " is-selected" : ""}`,
          role: "option",
          "aria-selected": String(i === this.selected),
        },
        icon(KIND_ICON[s.kind]),
        h("span", { class: "terminal-suggest-label" }, s.label),
        h("span", { class: "terminal-suggest-kind" }, KIND_LABEL[s.kind]),
      );
      row.addEventListener("click", () => {
        this.selected = i;
        this.accept();
      });
      return row;
    });
    this.list.replaceChildren(...rows);
    this.showDetails();
    this.el.hidden = false;
    this.place(tokenStart);
    this.list.children[this.selected]?.scrollIntoView({ block: "nearest" });
    if (!this.visible) {
      this.visible = true;
      this.host.visibilityChanged(this, true, this.navigated);
    }
  }

  /** Under the token being completed (above it when there's no room below). */
  private place(tokenStart: number): void {
    const box = this.t.renderer.cursorBox();
    const input = this.input;
    if (!box || !input) return;
    const area = this.view.getBoundingClientRect();
    const back = [...input.line.slice(tokenStart, input.cursor)].length;
    const left = Math.max(0, box.left - back * box.cellWidth - area.left);
    this.el.style.left = `${Math.min(left, Math.max(0, area.width - this.el.offsetWidth - 4))}px`;
    // Below the line when it fits, else on the roomier side, the list shortened to the room
    // there (a low panel shows a few rows rather than rows cut off by its edge).
    this.list.style.maxHeight = "";
    const natural = this.el.offsetHeight;
    const below = area.bottom - box.bottom - 4;
    const above = box.top - area.top - 4;
    const down = natural <= below || below >= above;
    const room = Math.max(MIN_LIST_PX, down ? below : above);
    if (natural > room)
      this.list.style.maxHeight = `${room - (natural - this.list.offsetHeight)}px`;
    const height = this.el.offsetHeight;
    this.el.style.top = `${down ? box.bottom - area.top : box.top - area.top - height}px`;
  }

  move(delta: number): void {
    if (!this.visible || !this.items.length) return;
    const n = this.items.length;
    this.selected = (((this.selected + delta) % n) + n) % n;
    if (!this.navigated) {
      this.navigated = true;
      this.host.visibilityChanged(this, true, true);
    }
    [...this.list.children].forEach((row, i) => {
      row.classList.toggle("is-selected", i === this.selected);
      row.setAttribute("aria-selected", String(i === this.selected));
    });
    this.list.children[this.selected]?.scrollIntoView({ block: "nearest" });
    this.showDetails();
  }

  /** The selected suggestion's detail under the list, when it has one. */
  private showDetails(): void {
    const detail = this.items[this.selected]?.detail;
    this.details.hidden = !detail;
    this.details.textContent = detail ?? "";
  }

  /** Types the selected suggestion (only what's missing when the typed text starts it). */
  accept(): { accepted: string | null } {
    const s = this.items[this.selected];
    const input = this.t.renderer.promptInput() ?? this.input;
    if (!this.visible || !s || !input) {
      this.hide();
      return { accepted: null };
    }
    const keys = acceptKeys(input.line, input.cursor, s);
    this.hide();
    if (keys) this.send(keys);
    // A folder: its entries next (VS Code goes on suggesting inside it).
    if (s.kind === "folder") {
      this.typedAt = Date.now();
      this.lastTyped = "/";
    }
    return { accepted: s.label };
  }

  hide(): void {
    this.version++;
    cancelAnimationFrame(this.frame);
    if (!this.visible && this.el.hidden) return;
    this.el.hidden = true;
    this.items = [];
    this.navigated = false;
    if (this.visible) {
      this.visible = false;
      this.host.visibilityChanged(this, false, false);
    }
  }

  dispose(): void {
    this.hide();
    this.store.dispose();
  }
}
