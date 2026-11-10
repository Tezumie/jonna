// QuickInput: the palette-style overlay used for picking (command palette) and for prompting a
// single value (new file name, rename, command arguments). One instance, reused.
import { h, on, replaceChildren } from "../core/dom/index";
import {
  type Disposable,
  DisposableStore,
  MutableDisposable,
  toDisposable,
} from "../core/lifecycle/index";
import { type Signal, signal } from "../core/reactive/index";
import { type FuzzyMatch, fuzzyFilter } from "./fuzzy";
import { type IconName, icon } from "./Icon";
import {
  activeRowAfter,
  blocksAccept,
  type FilterableItem,
  filterItems,
  titleText,
  type ValidationSeverity,
} from "./quickInputModel";
import { VirtualList } from "./VirtualList";

export interface QuickPickItem {
  id: string;
  label: string;
  /** Dimmed text after the label (e.g. the command id). */
  description?: string;
  /** Right-aligned keybinding label. */
  keybinding?: string;
  /** More about the row, shown as its tooltip (an extension's `detail`, D202). */
  detail?: string;
  disabled?: boolean;
  /** Leading icon (e.g. a file icon) and its color (a CSS value such as a token). */
  icon?: IconName;
  iconColor?: string;
  /** A picture (data: or blob: URL) in the icon's place: an MCP server's own icon. */
  image?: string;
  /** Pre-computed highlights (dynamic sources); otherwise the fuzzy filter's. */
  labelHighlights?: readonly number[];
  descriptionHighlights?: readonly number[];
  /** Starts a group: a line above the row and this name at its right (VS Code's separators). */
  separator?: string;
  /** A checkbox before the row (a multi-select session, VS Code's canSelectMany). */
  checked?: boolean;
  /** Icon buttons at the row's end (VS Code's QuickPickItem.buttons). */
  buttons?: readonly SessionButton[];
}

/** A title bar or row button of a session (VS Code's QuickInputButton). */
export interface SessionButton {
  icon: IconName;
  tooltip?: string;
  /** VS Code's QuickInputButtons.Back: drawn first, at the title's left. */
  back?: boolean;
}

/** An item of a live session: a row, by its index in `items`. */
export interface SessionItem extends FilterableItem {
  icon?: IconName;
  iconColor?: string;
  image?: string;
  buttons?: readonly SessionButton[];
}

/**
 * What a live session shows (VS Code's QuickPick / InputBox properties); `update` changes any of
 * them while it's open.
 */
export interface SessionProps {
  title?: string;
  step?: number;
  totalSteps?: number;
  buttons?: readonly SessionButton[];
  placeholder?: string;
  /** An input box's question, shown under the box while no validation message shows. */
  prompt?: string;
  value?: string;
  /** Part of the value selected (VS Code's valueSelection). */
  valueSelection?: [number, number];
  password?: boolean;
  items?: readonly SessionItem[];
  /** Item indexes the extension made active / selected (checked, with canSelectMany). */
  activeIndexes?: readonly number[];
  selectedIndexes?: readonly number[];
  canSelectMany?: boolean;
  matchOnDescription?: boolean;
  matchOnDetail?: boolean;
  sortByLabel?: boolean;
  keepScrollPosition?: boolean;
  busy?: boolean;
  enabled?: boolean;
  ignoreFocusOut?: boolean;
  validation?: { message: string; severity: ValidationSeverity } | null;
}

/** What a session reports, by item index; `hide` comes exactly once. */
export interface SessionHandlers {
  value(value: string): void;
  active(indexes: number[]): void;
  selection(indexes: number[]): void;
  accept(): void;
  button(index: number): void;
  itemButton(item: number, button: number): void;
  hide(): void;
}

export interface QuickInputSession {
  update(props: Partial<SessionProps>): void;
  /** Closes it if it's still the one shown (another session may have taken over). */
  hide(): void;
}

/**
 * Other ways to accept a row (VS Code's quick open): Ctrl/Cmd+Enter opens it to the side (the
 * picker closes), → at the end of the text opens it in the background (the picker stays).
 * Return false when the row has no such action, and the key does what it normally does.
 */
export type AlternateAccept<T> = (item: T, how: "side" | "background") => boolean;

/** Items for a query, computed elsewhere (e.g. the Rust file index). */
export interface DynamicPickOptions<T extends QuickPickItem> {
  placeholder: string;
  /** The placeholder for the current text (quick access modes change it as you type). */
  placeholderFor?(query: string): string;
  value?: string;
  load(query: string): Promise<{ items: readonly T[]; message?: string }>;
  alternate?: AlternateAccept<T>;
}

export interface PickOptions {
  placeholder: string;
  /** Text matched by the fuzzy filter (default: label). */
  matchOn?: (item: QuickPickItem) => string;
  /** The row active at first (default 0), e.g. 1 for "the previous editor". */
  activeIndex?: number;
  /** Releasing one of these keys accepts the active row (Ctrl+Tab's editor switcher). */
  acceptOnKeyUp?: readonly string[];
  /** The active row changed (undefined: none), to preview it (Paste from history). */
  onActive?: (item: QuickPickItem | undefined) => void;
}

export interface InputOptions {
  prompt: string;
  value?: string;
  placeholder?: string;
  /** Select part of the initial value, e.g. the file name without its extension. */
  selection?: [number, number];
  /** Returns an error message to show, or undefined when valid. */
  validate?: (value: string) => string | undefined;
  /** Mask what is typed (a password or token). */
  password?: boolean;
  /** A problem shown at first (an extension's validation message), until the text changes. */
  error?: string;
}

type Row = { item: QuickPickItem; match: FuzzyMatch };
type SourceResult = { rows: Row[]; message?: string };
const ROW_HEIGHT = 26; // DESIGN.md §12.6
const MAX_VISIBLE_ROWS = 10;

export class QuickInput implements Disposable {
  private readonly store = new DisposableStore();
  private readonly session = this.store.add(new MutableDisposable());
  private readonly root: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly message: HTMLElement;
  /** A session's title, step and buttons (VS Code's title bar), and its busy line. */
  private readonly titleBar: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly listHost: HTMLElement;
  private readonly list: VirtualList<Row>;
  /** True while open (mirrored into the `quickInputVisible` context key). */
  readonly visible: Signal<boolean> = signal(false);
  private returnFocus: HTMLElement | null = null;
  /** Rect to center under (the title bar's command field); set by the workbench. */
  anchor: (() => DOMRect | undefined) | undefined;

  constructor(host: HTMLElement) {
    this.input = h("input", {
      class: "quick-input-box",
      type: "text",
      spellcheck: "false",
      autocomplete: "off",
      // A combobox whose focus stays in the box: screen readers follow the active row through
      // aria-activedescendant here (VS Code's quick input).
      role: "combobox",
      "aria-expanded": "true",
      "aria-autocomplete": "list",
    });
    this.message = h("div", { class: "quick-input-message", role: "status" });
    this.listHost = h("div", { class: "quick-input-list" });
    this.titleBar = h("div", { class: "quick-input-title", hidden: true });
    this.progress = h("div", { class: "progress-line quick-input-progress", hidden: true });
    this.root = h(
      "div",
      { class: "quick-input", role: "dialog", hidden: true },
      this.titleBar,
      this.input,
      this.progress,
      this.message,
      this.listHost,
    );
    host.appendChild(this.root);
    this.store.add(toDisposable(() => this.root.remove()));
    this.list = this.store.add(
      new VirtualList<Row>(this.listHost, {
        rowHeight: ROW_HEIGHT,
        role: "listbox",
        rowRole: "option",
        ariaLabel: "Results",
        activeDescendantHost: this.input,
        renderRow: (row, el) => renderPickRow(row, el),
      }),
    );
    this.list.element.tabIndex = -1;
    this.list.element.id = "quick-input-results";
    this.input.setAttribute("aria-controls", this.list.element.id);
  }

  /** Shows a filterable list; resolves with the chosen item or undefined if cancelled. */
  pick<T extends QuickPickItem>(items: readonly T[], options: PickOptions): Promise<T | undefined> {
    const matchOn = options.matchOn ?? ((i: QuickPickItem) => i.label);
    return this.run<T>(
      options.placeholder,
      "",
      (query) => ({ rows: fuzzyFilter(query, items, matchOn) }),
      options,
    );
  }

  /** Like pick, but items come from `load` for each query (latest query wins). */
  pickDynamic<T extends QuickPickItem>(options: DynamicPickOptions<T>): Promise<T | undefined> {
    return this.run<T>(
      options.placeholder,
      options.value ?? "",
      async (query) => {
        if (options.placeholderFor) this.input.placeholder = options.placeholderFor(query);
        const { items, message } = await options.load(query);
        return {
          rows: items.map((item) => ({ item, match: { score: 0, positions: [] } })),
          message,
        };
      },
      options.alternate ? { alternate: options.alternate } : {},
    );
  }

  private run<T extends QuickPickItem>(
    placeholder: string,
    value: string,
    source: (query: string) => SourceResult | Promise<SourceResult>,
    extra: Pick<PickOptions, "activeIndex" | "acceptOnKeyUp" | "onActive"> & {
      alternate?: AlternateAccept<T>;
    } = {},
  ): Promise<T | undefined> {
    return new Promise((resolve) => {
      const session = new DisposableStore();
      let done = false;
      const finish = (value: T | undefined) => {
        if (done) return;
        done = true;
        this.close();
        resolve(value);
      };
      session.add(toDisposable(() => finish(undefined)));
      this.open(session, placeholder, value);
      let request = 0;
      let first = true;
      const setActive = (index: number) => {
        this.list.setActive(index);
        extra.onActive?.(this.list.items[index]?.item);
      };
      const show = ({ rows, message }: SourceResult) => {
        // Size the list before filling it so scrolling to the active row uses the real height.
        // Plus the list's own padding (D190: a single row had a scrollbar, its height 8px short).
        this.listHost.style.height = `calc(${Math.min(rows.length, MAX_VISIBLE_ROWS) * ROW_HEIGHT}px + var(--space-2) * 2)`;
        this.list.element.scrollTop = 0;
        this.list.setItems(rows);
        const start = first && extra.activeIndex ? Math.min(extra.activeIndex, rows.length - 1) : 0;
        first = false;
        setActive(rows.length > 0 ? start : -1);
        this.message.textContent = message ?? (rows.length === 0 ? "No matching results" : "");
      };
      const update = () => {
        const id = ++request;
        const result = source(this.input.value);
        if (!(result instanceof Promise)) return show(result);
        void result.then(
          (r) => !done && id === request && show(r),
          (err: unknown) =>
            !done &&
            id === request &&
            show({ rows: [], message: err instanceof Error ? err.message : String(err) }),
        );
      };
      const accept = (index: number) => {
        const row = this.list.items[index];
        if (row && !row.item.disabled) finish(row.item as T);
      };
      /** Ctrl/Cmd+Enter (to the side) and → at the end (in the background); true when used. */
      const alternate = (index: number, how: "side" | "background"): boolean => {
        const row = this.list.items[index];
        if (!extra.alternate || !row || row.item.disabled) return false;
        if (!extra.alternate(row.item as T, how)) return false;
        if (how === "side") finish(undefined);
        return true;
      };
      session.add(on(this.input, "input", update));
      const releaseKeys = extra.acceptOnKeyUp;
      if (releaseKeys?.length)
        session.add(
          on(this.input, "keyup", (e) => {
            if (releaseKeys.includes(e.key)) accept(this.list.active);
          }),
        );
      this.moveSession = (delta) => {
        const n = this.list.items.length;
        if (n > 0) setActive((((this.list.active + delta) % n) + n) % n);
      };
      session.add(toDisposable(() => (this.moveSession = null)));
      session.add(
        on(this.input, "keydown", (e) => {
          const n = this.list.items.length;
          const active = this.list.active;
          if (e.key === "ArrowDown") setActive(n === 0 ? -1 : (active + 1) % n);
          else if (e.key === "ArrowUp") setActive(n === 0 ? -1 : (active - 1 + n) % n);
          else if (e.key === "PageDown") setActive(Math.min(n - 1, active + this.list.pageSize));
          else if (e.key === "PageUp") setActive(Math.max(0, active - this.list.pageSize));
          else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && alternate(active, "side")) {
            // Opened to the side.
          } else if (e.key === "Enter") accept(active);
          else if (e.key === "Escape") finish(undefined);
          else if (
            e.key === "ArrowRight" &&
            !e.shiftKey &&
            !e.ctrlKey &&
            !e.altKey &&
            !e.metaKey &&
            this.input.selectionStart === this.input.value.length &&
            this.input.selectionEnd === this.input.value.length &&
            alternate(active, "background")
          ) {
            // Opened in the background; the picker stays.
          } else return;
          e.preventDefault();
          e.stopPropagation();
        }),
      );
      session.add(
        this.list.onDidClickRow(({ index, event }) => {
          event.preventDefault();
          accept(index);
        }),
      );
      update();
    });
  }

  /** Prompts for one line of text; resolves with the value or undefined if cancelled. */
  prompt(options: InputOptions): Promise<string | undefined> {
    return new Promise((resolve) => {
      const session = new DisposableStore();
      let done = false;
      const finish = (value: string | undefined) => {
        if (done) return;
        done = true;
        this.close();
        resolve(value);
      };
      session.add(toDisposable(() => finish(undefined)));
      this.open(session, options.placeholder ?? "", options.value ?? "");
      if (options.password) {
        this.input.type = "password";
        session.add(toDisposable(() => (this.input.type = "text")));
      }
      this.list.setItems([]);
      this.listHost.style.height = "0px";
      // The question shows until you type or press Enter: an empty required field doesn't open
      // with its error instead of what's asked.
      let touched = false;
      const validate = () => {
        const error = options.validate?.(this.input.value);
        const shown = touched ? error : options.error;
        this.message.textContent =
          shown ?? `${options.prompt} (Enter to confirm, Escape to cancel)`;
        this.message.classList.toggle("is-error", !!shown);
        return !error;
      };
      if (options.selection) this.input.setSelectionRange(...options.selection);
      else this.input.select();
      session.add(
        on(this.input, "input", () => {
          touched = true;
          validate();
        }),
      );
      session.add(
        on(this.input, "keydown", (e) => {
          if (e.key === "Enter") {
            touched = true;
            if (validate()) finish(this.input.value);
          } else if (e.key === "Escape") finish(undefined);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }),
      );
      validate();
    });
  }

  /**
   * A live session (VS Code's createQuickPick / createInputBox): Enter reports `accept` and the
   * session stays open until its owner hides it; items, busy, title, buttons, the value and the
   * validation message change while it's open. Opening another session (or any pick or prompt)
   * hides this one: `hide` is reported exactly once.
   */
  openSession(
    kind: "pick" | "input",
    initial: SessionProps,
    handlers: SessionHandlers,
  ): QuickInputSession {
    const store = new DisposableStore();
    const props: SessionProps = { ...initial };
    let hidden = false;
    store.add(
      toDisposable(() => {
        if (hidden) return;
        hidden = true;
        this.close();
        handlers.hide();
      }),
    );
    this.open(
      store,
      props.placeholder ?? "",
      props.value ?? "",
      () => props.ignoreFocusOut === true,
    );
    if (props.password) {
      this.input.type = "password";
      store.add(toDisposable(() => (this.input.type = "text")));
    }
    /** The rows shown: item indexes in order, for the typed text. */
    let rows: { index: number }[] = [];
    /** Checked items (canSelectMany). */
    let checked = new Set<number>(props.selectedIndexes ?? []);
    let reportedActive: number | undefined;
    const reportActive = () => {
      if (kind !== "pick") return;
      const row = rows[this.list.active];
      if (row?.index === reportedActive) return;
      reportedActive = row?.index;
      handlers.active(row ? [row.index] : []);
    };
    const renderTitle = () => {
      const text = titleText(props.title, props.step, props.totalSteps);
      const buttons = props.buttons ?? [];
      this.titleBar.hidden = !text && !buttons.length;
      const button = (b: SessionButton, index: number) => {
        const el = h(
          "button",
          {
            class: "icon-button",
            type: "button",
            title: b.tooltip ?? (b.back ? "Back" : ""),
            "aria-label": b.tooltip ?? (b.back ? "Back" : b.icon),
          },
          icon(b.icon),
        );
        // Keeps the focus in the box (a press elsewhere would close the session).
        el.addEventListener("mousedown", (e) => e.preventDefault());
        el.addEventListener("click", () => handlers.button(index));
        return el;
      };
      replaceChildren(
        this.titleBar,
        ...buttons.flatMap((b, i) => (b.back ? [button(b, i)] : [])),
        h("span", { class: "quick-input-title-text" }, text),
        ...buttons.flatMap((b, i) => (b.back ? [] : [button(b, i)])),
      );
    };
    const renderMessage = () => {
      const v = props.validation;
      const severity = v?.message ? v.severity : null;
      this.message.classList.toggle("is-error", severity === "error");
      this.message.classList.toggle("is-warning", severity === "warning");
      this.message.classList.toggle("is-info", severity === "info");
      if (v?.message) this.message.textContent = v.message;
      else if (kind === "input")
        this.message.textContent = props.prompt
          ? `${props.prompt} (Enter to confirm, Escape to cancel)`
          : "Press Enter to confirm your input or Escape to cancel";
      else
        this.message.textContent =
          !rows.length && this.input.value.trim() && !props.busy ? "No matching results" : "";
    };
    /** Fills the list for the typed text; `keep` holds the active row and scroll (items changed). */
    const renderRows = (keep: boolean, wanted?: readonly number[]) => {
      if (kind !== "pick") {
        this.list.setItems([]);
        this.listHost.style.height = "0px";
        return;
      }
      const items = props.items ?? [];
      const previous = rows[this.list.active]?.index;
      const scroll = this.list.element.scrollTop;
      const filtered = filterItems(items, this.input.value, {
        ...(props.matchOnDescription && { matchOnDescription: true }),
        ...(props.matchOnDetail && { matchOnDetail: true }),
        ...(props.sortByLabel === false && { sortByLabel: false }),
      });
      rows = filtered;
      const many = props.canSelectMany === true;
      const list: Row[] = filtered.flatMap((row) => {
        const item = items[row.index];
        if (!item) return [];
        const pickItem: QuickPickItem = {
          id: String(row.index),
          label: item.label,
          ...(item.description !== undefined && { description: item.description }),
          ...(item.detail !== undefined && { detail: item.detail }),
          ...(item.icon && { icon: item.icon }),
          ...(item.iconColor && { iconColor: item.iconColor }),
          ...(item.image && { image: item.image }),
          ...(row.separator !== undefined && { separator: row.separator }),
          ...(row.description && { descriptionHighlights: row.description }),
          ...(many && { checked: checked.has(row.index) }),
          ...(item.buttons?.length && { buttons: item.buttons }),
        };
        return [{ item: pickItem, match: row.label }];
      });
      this.listHost.style.height = `calc(${Math.min(list.length, MAX_VISIBLE_ROWS) * ROW_HEIGHT}px + var(--space-2) * 2)`;
      if (!keep) this.list.element.scrollTop = 0;
      this.list.setItems(list);
      const active = activeRowAfter(filtered, wanted, previous, keep);
      this.list.setActive(active);
      // setActive scrolls to the active row; keepScrollPosition keeps where the user was.
      if (keep) this.list.element.scrollTop = scroll;
      reportActive();
      renderMessage();
    };
    const apply = (changes: Partial<SessionProps>, first: boolean) => {
      Object.assign(props, changes);
      if (changes.value !== undefined && changes.value !== this.input.value)
        this.input.value = changes.value;
      if (changes.valueSelection) this.input.setSelectionRange(...changes.valueSelection);
      if (changes.placeholder !== undefined) this.input.placeholder = changes.placeholder;
      if (changes.selectedIndexes) checked = new Set(changes.selectedIndexes);
      this.progress.hidden = props.busy !== true;
      this.input.readOnly = props.enabled === false;
      if (
        first ||
        "title" in changes ||
        "step" in changes ||
        "totalSteps" in changes ||
        "buttons" in changes
      )
        renderTitle();
      if (
        first ||
        changes.items ||
        changes.value !== undefined ||
        changes.selectedIndexes ||
        changes.activeIndexes ||
        "canSelectMany" in changes ||
        "matchOnDescription" in changes ||
        "matchOnDetail" in changes ||
        "sortByLabel" in changes
      )
        renderRows(
          !first && !!changes.items && props.keepScrollPosition === true,
          changes.activeIndexes,
        );
      renderMessage();
    };
    apply(props, true);
    if (!props.valueSelection) this.input.select();

    const acceptActive = () => {
      if (props.enabled === false) return;
      if (kind === "input") {
        if (blocksAccept(props.validation)) return;
        handlers.accept();
        return;
      }
      if (props.canSelectMany !== true) {
        const row = rows[this.list.active];
        // VS Code's: Enter selects the active item, then accepts (even with nothing showing).
        if (row) handlers.selection([row.index]);
      }
      handlers.accept();
    };
    const toggle = (position: number) => {
      const row = rows[position];
      if (!row) return;
      if (checked.has(row.index)) checked.delete(row.index);
      else checked.add(row.index);
      const at = this.list.items[position];
      if (at) at.item.checked = checked.has(row.index);
      this.list.refresh();
      handlers.selection([...checked].sort((a, b) => a - b));
    };
    store.add(
      on(this.input, "input", () => {
        handlers.value(this.input.value);
        if (kind === "pick") renderRows(false);
        else renderMessage();
      }),
    );
    this.moveSession = (delta) => {
      const n = this.list.items.length;
      if (n > 0) this.list.setActive((((this.list.active + delta) % n) + n) % n);
      reportActive();
    };
    store.add(toDisposable(() => (this.moveSession = null)));
    store.add(
      on(this.input, "keydown", (e) => {
        const n = this.list.items.length;
        const active = this.list.active;
        if (kind === "pick" && e.key === "ArrowDown")
          this.list.setActive(n === 0 ? -1 : (active + 1) % n);
        else if (kind === "pick" && e.key === "ArrowUp")
          this.list.setActive(n === 0 ? -1 : (active - 1 + n) % n);
        else if (kind === "pick" && e.key === "PageDown")
          this.list.setActive(Math.min(n - 1, active + this.list.pageSize));
        else if (kind === "pick" && e.key === "PageUp")
          this.list.setActive(Math.max(0, active - this.list.pageSize));
        // Space checks the active row while nothing is typed (the filter has no leading spaces).
        else if (
          kind === "pick" &&
          props.canSelectMany &&
          e.key === " " &&
          !this.input.value &&
          active >= 0
        )
          toggle(active);
        else if (e.key === "Enter") acceptActive();
        else if (e.key === "Escape") store.dispose();
        else return;
        e.preventDefault();
        e.stopPropagation();
        reportActive();
      }),
    );
    store.add(
      this.list.onDidClickRow(({ index, event }) => {
        event.preventDefault();
        const row = rows[index];
        if (!row) return;
        const target = event.target instanceof Element ? event.target : null;
        const button = target?.closest<HTMLElement>("[data-item-button]");
        if (button) {
          handlers.itemButton(row.index, Number(button.dataset.itemButton));
          return;
        }
        this.list.setActive(index);
        reportActive();
        if (props.canSelectMany) toggle(index);
        else acceptActive();
      }),
    );
    return {
      update: (changes) => {
        if (!hidden) apply(changes, false);
      },
      hide: () => store.dispose(),
    };
  }

  private moveSession: ((delta: number) => void) | null = null;

  /** Moves the active row of the open pick by `delta` (wraps); false when no pick is open. */
  moveActive(delta: number): boolean {
    if (!this.visible.peek() || !this.moveSession) return false;
    this.moveSession(delta);
    return true;
  }

  /** Cancels whatever is open. */
  cancel(): void {
    this.session.clear();
  }

  private open(
    session: DisposableStore,
    placeholder: string,
    value: string,
    /** A session with ignoreFocusOut stays open when the focus or a click goes elsewhere. */
    keepOnFocusOut: () => boolean = () => false,
  ): void {
    // Anchor under the title bar's command field (DESIGN.md §12.6).
    const anchor = this.anchor?.();
    if (anchor)
      this.root.style.setProperty(
        "--quick-input-x",
        `${Math.round(anchor.left + anchor.width / 2)}px`,
      );
    this.session.value = session; // cancels a previous session
    if (!this.visible.peek()) {
      const active = document.activeElement;
      this.returnFocus = active instanceof HTMLElement ? active : null;
    }
    this.input.value = value;
    this.input.placeholder = placeholder;
    this.message.textContent = "";
    this.message.classList.remove("is-error", "is-warning", "is-info");
    this.titleBar.hidden = true;
    this.titleBar.replaceChildren();
    this.progress.hidden = true;
    this.input.readOnly = false;
    this.root.hidden = false;
    this.visible.value = true;
    session.add(
      on(this.input, "blur", (e) => {
        // Clicking inside the widget (the list) must not close it.
        if (keepOnFocusOut()) return;
        if (!(e.relatedTarget instanceof Node && this.root.contains(e.relatedTarget))) {
          setTimeout(() => {
            if (!keepOnFocusOut() && !this.root.contains(document.activeElement)) this.cancel();
          }, 0);
        }
      }),
    );
    // A press anywhere else closes it too (VS Code's), even on what doesn't take focus (the
    // editor's margins, tab strips, buttons that keep focus where it was).
    session.add(
      on(
        this.root.ownerDocument,
        "pointerdown",
        (e) => {
          if (keepOnFocusOut()) return;
          if (!(e.target instanceof Node && this.root.contains(e.target))) this.cancel();
        },
        { capture: true },
      ),
    );
    this.input.focus();
  }

  private close(): void {
    this.root.hidden = true;
    this.visible.value = false;
    const target = this.returnFocus;
    this.returnFocus = null;
    if (target?.isConnected) target.focus();
    // Detach the session without re-entering finish().
    queueMicrotask(() => {
      if (this.root.hidden) this.session.clear();
    });
  }

  dispose(): void {
    this.store.dispose();
  }
}

function renderPickRow({ item, match }: Row, el: HTMLElement): void {
  const label = h(
    "span",
    { class: "quick-pick-label" },
    ...highlight(item.label, item.labelHighlights ?? match.positions),
  );
  const glyph = item.image
    ? h("img", { class: "quick-pick-image", src: item.image, alt: "", draggable: "false" })
    : item.icon
      ? icon(item.icon)
      : null;
  if (glyph && item.iconColor) glyph.style.color = item.iconColor;
  let check: HTMLInputElement | null = null;
  if (item.checked !== undefined) {
    check = h("input", {
      class: "checkbox quick-pick-check",
      type: "checkbox",
      tabindex: "-1",
      "aria-hidden": "true",
    });
    check.checked = item.checked;
  }
  const buttons = item.buttons?.length
    ? h(
        "span",
        { class: "quick-pick-buttons" },
        ...item.buttons.map((b, i) =>
          h(
            "span",
            {
              class: "icon-button",
              role: "button",
              title: b.tooltip ?? "",
              "aria-label": b.tooltip ?? b.icon,
              dataset: { itemButton: String(i) },
            },
            icon(b.icon),
          ),
        ),
      )
    : null;
  if (item.checked === undefined) el.removeAttribute("aria-checked");
  else el.setAttribute("aria-checked", String(item.checked));
  replaceChildren(
    el,
    check,
    glyph,
    label,
    item.description
      ? h(
          "span",
          { class: "quick-pick-description" },
          ...highlight(item.description, item.descriptionHighlights ?? []),
        )
      : null,
    item.separator ? h("span", { class: "quick-pick-separator" }, item.separator) : null,
    item.keybinding ? h("kbd", { class: "quick-pick-keybinding" }, item.keybinding) : null,
    buttons,
  );
  if (item.detail) el.title = item.detail;
  else el.removeAttribute("title");
  el.classList.toggle("is-disabled", !!item.disabled);
  el.classList.toggle("has-separator", item.separator !== undefined);
}

/** Splits text into plain/highlighted spans for fuzzy-match positions. */
function highlight(text: string, positions: readonly number[]): (string | HTMLElement)[] {
  if (positions.length === 0) return [text];
  const set = new Set(positions);
  const out: (string | HTMLElement)[] = [];
  let run = "";
  let runHighlighted = false;
  for (let i = 0; i <= text.length; i++) {
    const isHit = set.has(i);
    if (i === text.length || isHit !== runHighlighted) {
      if (run) out.push(runHighlighted ? h("mark", null, run) : run);
      run = "";
      runHighlighted = isHit;
    }
    if (i < text.length) run += text.charAt(i);
  }
  return out;
}
