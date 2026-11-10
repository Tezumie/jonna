// The "Keyboard shortcuts" dock tab: every command with its keys, when clause and source (the
// editor's own keys too, D204), a ⚠ on keys that two commands share, search (by key in quotes),
// and recording a new key (double-click or Enter on a row: press the keys, Enter to save, Escape
// to cancel). The row menu changes, adds, removes or resets one binding and edits its when
// clause in the row (D209: Enter saves, Escape cancels), VS Code's way. A key the IDE and the
// editor share shows how it's settled (an info mark, D209); ⚠ is for real conflicts. Changes go
// through keybindings.* commands.
import type { CommandInfo } from "../../core/dispatcher/index";
import type { Json } from "../../core/dock/index";
import { h, on, replaceChildren } from "../../core/dom/index";
import { clipboardIpc } from "../../core/ipc/system";
import { chordFromEvent, effectiveBindings, keybindingLabel } from "../../core/keybindings/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { icon } from "../../ui/Icon";
import { type MenuItem, showContextMenu } from "../../ui/Menu";
import { setTooltip } from "../../ui/Tooltip";
import { VirtualList } from "../../ui/VirtualList";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import type { KeybindingsState } from "./index";
import { type ShortcutCommand, type ShortcutRow, shortcutRows } from "./rows";

type Row = ShortcutRow;

/** What a recording does when Enter is pressed. */
type RecordMode = "change" | "add";

export function keybindingsViewDescriptor(
  services: WorkbenchServices,
  status: KeybindingsState,
): DockViewDescriptor {
  return {
    type: "keybindings",
    title: () => "Keyboard shortcuts",
    icon: () => "keyboard",
    singleton: true,
    defaultPlacement: "main",
    editorLike: true,
    create: (state) => new KeybindingsView(services, status, stateField(state, "query")),
  };
}

class KeybindingsView implements DockView {
  readonly element: HTMLElement;
  private recordingSearch = false;
  private readonly store = new DisposableStore();
  private readonly list: VirtualList<Row>;
  private readonly search: HTMLInputElement;
  private readonly note: HTMLElement;
  private readonly recording = this.store.add(new DisposableStore());
  /** The binding whose when clause is being edited in its row (D209). */
  private whenEdit: {
    command: string;
    key: string;
    when: string;
    input: HTMLInputElement;
  } | null = null;
  /** Rows are being drawn again: the when input moving between them isn't a blur. */
  private rendering = false;

  constructor(
    private readonly services: WorkbenchServices,
    private readonly status: KeybindingsState,
    query: unknown,
  ) {
    this.search = h("input", {
      class: "input keybindings-search",
      type: "search",
      placeholder: 'Search commands or keys ("ctrl+d" in quotes: that key)',
      "aria-label": "Search keybindings",
      value: typeof query === "string" ? query : "",
    });
    // VS Code's "Record keys": while on, pressing keys in the search box searches for them.
    const recordKeys = h(
      "button",
      { class: "icon-button keybindings-record", type: "button", "aria-pressed": "false" },
      icon("keyboard"),
    );
    setTooltip(recordKeys, "Record keys (search by pressing them)");
    this.store.add(
      on(recordKeys, "click", () => {
        this.recordingSearch = !this.recordingSearch;
        recordKeys.setAttribute("aria-pressed", String(this.recordingSearch));
        recordKeys.classList.toggle("is-active", this.recordingSearch);
        this.search.focus();
      }),
    );
    this.store.add(
      on(this.search, "keydown", (e) => {
        if (!this.recordingSearch || e.key === "Escape" || e.key === "Tab") return;
        const chord = chordFromEvent(e);
        if (!chord) return;
        e.preventDefault();
        e.stopPropagation();
        this.showSameKeys(keybindingLabel([chord], this.services.keyboard.platformName));
      }),
    );
    const openJson = h("button", { class: "icon-button", type: "button" }, icon("braces"));
    setTooltip(openJson, "Open keybindings.json", "keybindings.openJson");
    this.store.add(on(openJson, "click", () => this.run("keybindings.openJson")));
    this.note = h("div", { class: "keybindings-note" });
    const listHost = h("div", { class: "keybindings-list" });
    this.element = h(
      "div",
      { class: "keybindings-view", tabindex: "-1" },
      h("div", { class: "keybindings-header" }, this.search, recordKeys, openJson),
      h(
        "div",
        { class: "keybindings-columns", "aria-hidden": "true" },
        h("span", null, "Command"),
        h("span", null, "Keybinding"),
        h("span", null, "When"),
        h("span", null, "Source"),
      ),
      this.note,
      listHost,
    );
    this.list = this.store.add(
      new VirtualList<Row>(listHost, {
        rowHeight: 26,
        role: "listbox",
        rowRole: "option",
        ariaLabel: "Keybindings",
        renderRow: (row, el) => this.renderRow(row, el),
      }),
    );
    this.store.add(on(this.search, "input", () => this.refresh()));
    this.store.add(
      on(listHost, "contextmenu", (e) => {
        const rowEl = (e.target as Element | null)?.closest?.<HTMLElement>(".vlist-row");
        const index = rowEl ? Number(rowEl.dataset.index) : -1;
        const row = this.list.items[index];
        if (!row) return;
        e.preventDefault();
        this.list.setActive(index);
        this.store.add(showContextMenu(e.clientX, e.clientY, this.rowMenu(row, index)));
      }),
    );
    this.store.add(
      this.list.onDidClickRow(({ index, event }) => {
        this.list.setActive(index);
        if (event.detail >= 2) this.record(index);
      }),
    );
    this.store.add(
      on(listHost, "keydown", (e) => {
        const n = this.list.items.length;
        const a = this.list.active;
        if (e.key === "ArrowDown") this.list.setActive(Math.min(n - 1, a + 1));
        else if (e.key === "ArrowUp") this.list.setActive(Math.max(0, a - 1));
        else if (e.key === "Enter") this.record(a);
        else return;
        e.preventDefault();
      }),
    );
    this.store.add(
      effect(() => {
        services.keyboard.rulesVersion.value;
        this.refresh();
        return undefined;
      }),
    );
    status.editWhenInline = (ref) => this.editWhen(ref);
    status.editingWhen = () => this.editingWhen;
    this.store.add({
      dispose: () => {
        delete status.editWhenInline;
        delete status.editingWhen;
      },
    });
  }

  /** Puts an input in the row's when column (D209); false when the row isn't listed. */
  /** The when clause being edited in a row (ide://keybindings). */
  get editingWhen(): { command: string; key: string; value: string } | null {
    const e = this.whenEdit;
    return e ? { command: e.command, key: e.key, value: e.input.value } : null;
  }

  private editWhen(ref: { command: string; key: string; when: string }): boolean {
    const index = this.list.items.findIndex(
      (r) =>
        r.command.id === ref.command &&
        r.binding?.chords.join(" ") === ref.key &&
        (r.binding.when ?? "") === ref.when,
    );
    if (index < 0) return false;
    const input = h("input", {
      class: "input keybindings-when-input",
      type: "text",
      value: ref.when,
      placeholder: "e.g. editorTextFocus && !editorReadonly (empty: always)",
      "aria-label": `When expression for ${ref.command}`,
      spellcheck: "false",
    });
    const edit = { ...ref, input };
    const finish = (save: boolean) => {
      if (this.whenEdit !== edit) return;
      this.whenEdit = null;
      const value = input.value.trim();
      if (save && value !== ref.when.trim())
        this.run("keybindings.changeWhen", {
          command: ref.command,
          key: ref.key,
          currentWhen: ref.when,
          when: value,
        });
      this.list.refresh();
      this.list.focus();
    };
    on(input, "keydown", (e) => {
      // The row list's keys (arrows, Enter to record) stay out of the input.
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    on(input, "mousedown", (e) => e.stopPropagation());
    on(input, "dblclick", (e) => e.stopPropagation());
    // Clicking elsewhere keeps what was typed (as leaving a settings field does).
    on(input, "blur", () => {
      if (!this.rendering) finish(true);
    });
    this.whenEdit = edit;
    this.list.setActive(index);
    // After the row menu has closed and given the focus back.
    requestAnimationFrame(() => {
      if (this.whenEdit !== edit) return;
      input.focus();
      input.select();
    });
    return true;
  }

  private rows(): Row[] {
    const { keyboard, dispatcher } = this.services;
    const table = effectiveBindings(keyboard.allRules, keyboard.platformName);
    // The IDE's palette commands and the editor's own (Monaco's actions; its other bound
    // commands are added from the table). "ctrl+d" in quotes: exactly that key.
    const commands: ShortcutCommand[] = [
      ...dispatcher
        .list()
        .filter((c: CommandInfo) => c.palette)
        .map((c: CommandInfo) => ({ id: c.id, title: c.title, category: c.category })),
      ...keyboard
        .engineActions()
        .filter((a) => keyboard.engineOwns(a.id))
        .map((a) => ({ id: a.id, title: a.title, engine: true })),
    ];
    return shortcutRows(commands, table, this.search.value, (id) => keyboard.engineTitle(id));
  }

  private refresh(): void {
    const rows = this.rows();
    const conflicts = rows.filter((r) => r.binding?.conflicts.length).length;
    this.note.textContent = [
      ...this.status.problems,
      conflicts
        ? `${conflicts} keybinding${conflicts === 1 ? "" : "s"} shared by more than one command (⚠).`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    this.list.setItems(rows);
  }

  /** A key shared with the editor where it's settled which runs (D209): how, on hover. */
  private resolvedMark(binding: Row["binding"]): HTMLElement | null {
    if (!binding?.resolved.length || binding.conflicts.length) return null;
    const mark = h("span", { class: "keybindings-resolved" }, icon("info"));
    setTooltip(
      mark,
      `${binding.resolved.map((r) => r.note).join(" ")} (click to list the commands on this key)`,
    );
    mark.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showSameKeys(binding.label);
    });
    return mark;
  }

  private renderRow({ command, binding }: Row, el: HTMLElement): void {
    const e = this.whenEdit;
    const editing =
      e &&
      binding &&
      e.command === command.id &&
      e.key === binding.chords.join(" ") &&
      e.when === (binding.when ?? "")
        ? e
        : null;
    const hadFocus = editing && document.activeElement === editing.input;
    this.rendering = true;
    const warn = binding?.conflicts.length
      ? h("span", { class: "keybindings-conflict" }, icon("triangle-alert"))
      : null;
    if (warn && binding) {
      setTooltip(warn, `Also bound to: ${binding.conflicts.join(", ")} (click to list them)`);
      warn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.showSameKeys(binding.label);
      });
    }
    replaceChildren(
      el,
      h(
        "span",
        { class: "keybindings-command" },
        h("span", null, command.category ? `${command.category}: ${command.title}` : command.title),
        h("span", { class: "keybindings-id" }, command.id),
      ),
      h(
        "span",
        { class: "keybindings-key" },
        binding ? h("kbd", null, binding.label) : "—",
        warn,
        this.resolvedMark(binding),
      ),
      editing
        ? h("span", { class: "keybindings-when is-editing" }, editing.input)
        : h("span", { class: "keybindings-when" }, binding?.when ?? ""),
      h(
        "span",
        { class: "keybindings-source" },
        binding?.source === "user"
          ? "User"
          : binding
            ? command.engine || binding.engine
              ? "Editor"
              : "Default"
            : "",
      ),
    );
    el.classList.add("keybindings-row");
    this.rendering = false;
    if (hadFocus) editing.input.focus({ preventScroll: true });
  }

  /**
   * Records keys for the row's command: chords accumulate until Enter (save) or Escape. "change"
   * moves the row's binding (or adds one to an unbound command); "add" keeps it.
   */
  private record(index: number, mode: RecordMode = "change"): void {
    const row = this.list.items[index];
    if (!row) return;
    this.recording.clear();
    const chords: string[] = [];
    const label = h("kbd", null, "…");
    const dialog = h(
      "div",
      { class: "keybindings-recorder", role: "dialog", "aria-label": "Record keybinding" },
      h("div", null, `Press the keys for "${row.command.title}", then Enter.`),
      label,
      h("div", { class: "keybindings-recorder-hint" }, "Escape cancels · Backspace clears"),
    );
    this.element.append(dialog);
    this.recording.add({ dispose: () => dialog.remove() });
    this.recording.add(this.services.keyboard.suspend());
    // A click elsewhere (another tab, an editor) cancels, as VS Code's recorder does: it takes
    // every key in the window, so left running behind another tab nothing could be typed.
    this.recording.add(
      on(
        window,
        "pointerdown",
        (e) => {
          if (!(e.target instanceof Node && dialog.contains(e.target))) this.recording.clear();
        },
        { capture: true },
      ),
    );
    this.recording.add(
      on(
        window,
        "keydown",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Escape") return this.recording.clear();
          if (e.key === "Enter" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
            this.recording.clear();
            if (chords.length === 0) return;
            const key = chords.join(" ");
            const { binding } = row;
            if (mode === "change" && binding)
              this.run("keybindings.changeKey", {
                command: row.command.id,
                key: binding.chords.join(" "),
                newKey: key,
                ...(binding.when && { when: binding.when }),
              });
            else this.run("keybindings.add", { command: row.command.id, key });
            return;
          }
          if (e.key === "Backspace" && chords.length > 0 && !e.ctrlKey) {
            chords.length = 0;
            label.textContent = "…";
            return;
          }
          const chord = chordFromEvent(e);
          if (!chord || chords.length >= 2) return;
          chords.push(chord);
          label.textContent = keybindingLabel(chords, this.services.keyboard.platformName);
        },
        { capture: true },
      ),
    );
  }

  /** Lists every command bound to `label` (VS Code's "Show same keybindings"). */
  private showSameKeys(label: string): void {
    this.search.value = `"${label}"`;
    this.refresh();
  }

  private rowMenu(row: Row, index: number): MenuItem[] {
    const { command, binding } = row;
    const copy = (text: string) =>
      void clipboardIpc.writeText(text).then(
        () => this.services.notifications.show("info", "Copied."),
        () => {},
      );
    const ref = binding && {
      command: command.id,
      key: binding.chords.join(" "),
      ...(binding.when && { when: binding.when }),
    };
    return [
      {
        label: binding ? "Change keybinding…" : "Add keybinding…",
        icon: "keyboard",
        run: () => this.record(index),
      },
      ...(binding && ref
        ? [
            {
              label: "Add keybinding…",
              icon: "plus" as const,
              run: () => this.record(index, "add"),
            },
            {
              label: "Change when expression…",
              icon: "pencil" as const,
              run: () =>
                this.run("keybindings.changeWhen", {
                  command: ref.command,
                  key: ref.key,
                  currentWhen: binding.when ?? "",
                }),
            },
            {
              label: "Show same keybindings",
              icon: "search" as const,
              run: () => this.showSameKeys(binding.label),
            },
            {
              label: "Remove keybinding",
              icon: "x" as const,
              separatorBefore: true,
              run: () => this.run("keybindings.remove", ref),
            },
          ]
        : []),
      ...(binding?.source === "user"
        ? [
            {
              label: "Reset keybinding",
              icon: "undo-2" as const,
              run: () => this.run("keybindings.reset", { command: command.id }),
            },
          ]
        : []),
      {
        label: "Copy command ID",
        icon: "copy",
        separatorBefore: true,
        run: () => copy(command.id),
      },
      { label: "Copy command title", icon: "copy", run: () => copy(command.title) },
      ...(binding
        ? [{ label: "Copy keybinding", icon: "copy" as const, run: () => copy(binding.label) }]
        : []),
    ];
  }

  private run(command: string, input: unknown = {}): void {
    void this.services.dispatcher.execute(command, input).catch(() => {});
  }

  focus(): void {
    this.search.focus();
  }

  serialize(): Json {
    return this.search.value ? { query: this.search.value } : null;
  }

  dispose(): void {
    this.store.dispose();
  }
}
