// The Output tab (D209, VS Code's Output panel): one channel at a time — Window, Extension host,
// Git, Tasks, Agent, each language server — picked in its header, with its records as they come
// (kept scrolled to the end while it's at the end), a filter box (`text, !exclude`), the
// channel's log level (its own, or the default), word wrap, and Clear / Open logs folder.
// Every action is a command (output.show, output.setFilter, output.toggleWordWrap,
// output.clear, log.setLevel, help.openLogsFolder).

import { formatRecord, OUTPUT_LEVELS, output, WINDOW_CHANNEL } from "../../core/diagnostics/output";
import { filterLines, isEmptyFilter, parseOutputFilter } from "../../core/diagnostics/outputText";
import type { Json } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";

/** The open Output tab (output.show picks its channel). */
let openOutput: OutputView | null = null;

/** Typing in the filter box: the command runs once the typing pauses. */
const FILTER_DELAY_MS = 150;

/** The channel the open Output tab shows, or null. */
export function shownChannel(): string | null {
  return openOutput?.channel ?? null;
}

/** Shows `channel` in the open Output tab; false without one. */
export function showChannel(channel: string): boolean {
  if (!openOutput) return false;
  openOutput.show(channel);
  return true;
}

/** The open Output tab's filter and word wrap, or null without one. */
export function outputViewOptions(): { filter: string; wordWrap: boolean } | null {
  return openOutput ? { filter: openOutput.filter, wordWrap: openOutput.wordWrap } : null;
}

/** Sets the open Output tab's filter; false without one. */
export function setOutputFilter(text: string): boolean {
  if (!openOutput) return false;
  openOutput.setFilter(text);
  return true;
}

/** Turns the open Output tab's word wrap on or off; false without one. */
export function setOutputWordWrap(on: boolean): boolean {
  if (!openOutput) return false;
  openOutput.setWordWrap(on);
  return true;
}

const capitalized = (s: string) => (s[0]?.toUpperCase() ?? "") + s.slice(1);

export function outputViewDescriptor(services: WorkbenchServices): DockViewDescriptor {
  return {
    type: "output",
    title: () => "Output",
    icon: () => "scroll-text",
    singleton: true,
    defaultPlacement: "bottom",
    create: (state) =>
      new OutputView(services, {
        channel: stateField(state, "channel"),
        filter: stateField(state, "filter"),
        wordWrap: stateField(state, "wordWrap"),
      }),
  };
}

class OutputView implements DockView {
  readonly element: HTMLElement;
  channel: string;
  filter: string;
  wordWrap: boolean;
  private readonly store = new DisposableStore();
  private readonly picker: HTMLSelectElement;
  private readonly filterBox: HTMLInputElement;
  private readonly levelPicker: HTMLSelectElement;
  private readonly wrapButton: HTMLButtonElement;
  private readonly body: HTMLElement;
  private frame = 0;
  private filterTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly services: WorkbenchServices,
    initial: { channel: unknown; filter: unknown; wordWrap: unknown },
  ) {
    this.channel =
      typeof initial.channel === "string" && initial.channel ? initial.channel : WINDOW_CHANNEL;
    this.filter = typeof initial.filter === "string" ? initial.filter : "";
    // On unless turned off (VS Code's Output wraps by default).
    this.wordWrap = initial.wordWrap !== false;
    this.picker = h("select", {
      class: "input setting-select output-channel",
      "aria-label": "Output channel",
    }) as HTMLSelectElement;
    this.store.add(
      on(this.picker, "change", () => this.run("output.show", { channel: this.picker.value })),
    );
    this.filterBox = h("input", {
      class: "input output-filter",
      type: "search",
      placeholder: "Filter (e.g. text, !exclude)",
      "aria-label": "Filter output",
      spellcheck: "false",
    }) as HTMLInputElement;
    this.filterBox.value = this.filter;
    this.store.add(
      on(this.filterBox, "input", () => {
        clearTimeout(this.filterTimer);
        this.filterTimer = setTimeout(
          () => this.run("output.setFilter", { text: this.filterBox.value }),
          FILTER_DELAY_MS,
        );
      }),
    );
    this.store.add(
      on(this.filterBox, "keydown", (e) => {
        if (e.key !== "Escape" || !this.filterBox.value) return;
        e.stopPropagation();
        this.filterBox.value = "";
        clearTimeout(this.filterTimer);
        this.run("output.setFilter", { text: "" });
      }),
    );
    this.store.add({ dispose: () => clearTimeout(this.filterTimer) });
    this.levelPicker = h("select", {
      class: "input setting-select output-level",
      "aria-label": "Log level of this channel",
    }) as HTMLSelectElement;
    setTooltip(this.levelPicker, "Log level of this channel: what it keeps here and in its file");
    this.store.add(
      on(this.levelPicker, "change", () =>
        this.run("log.setLevel", { channel: this.channel, level: this.levelPicker.value }),
      ),
    );
    const button = (
      name: Parameters<typeof icon>[0],
      title: string,
      command: string,
      input: () => unknown = () => ({}),
    ) => {
      const b = h(
        "button",
        { class: "icon-button", type: "button", "aria-label": title },
        icon(name),
      ) as HTMLButtonElement;
      setTooltip(b, title, command);
      this.store.add(on(b, "click", () => this.run(command, input())));
      return b;
    };
    this.wrapButton = button("text-wrap", "Toggle word wrap", "output.toggleWordWrap");
    this.wrapButton.classList.add("output-wrap");
    this.body = h("pre", {
      class: "output-body",
      tabindex: "0",
      role: "log",
      "aria-live": "off",
    });
    this.element = h(
      "div",
      { class: "output-view", tabindex: "-1" },
      h(
        "div",
        { class: "output-header" },
        this.picker,
        this.filterBox,
        h("span", { class: "output-spacer" }),
        this.levelPicker,
        this.wrapButton,
        button("trash-2", "Clear output", "output.clear", () => ({ channel: this.channel })),
        button("folder-open", "Open logs folder", "help.openLogsFolder"),
      ),
      this.body,
    );
    this.store.add(
      output.onDidChange((id) => {
        if (id === "" || id === this.channel) this.schedule(id === "");
      }),
    );
    this.store.add({ dispose: () => cancelAnimationFrame(this.frame) });
    openOutput = this;
    this.store.add({
      dispose: () => {
        if (openOutput === this) openOutput = null;
      },
    });
    this.renderPicker();
    this.renderLevelPicker();
    this.renderWrap();
    this.render();
  }

  private run(command: string, input: unknown = {}): void {
    void this.services.dispatcher.execute(command, input).catch((err: unknown) => {
      this.services.notifications.show("error", err instanceof Error ? err.message : String(err));
    });
  }

  show(channel: string): void {
    this.channel = channel;
    this.renderPicker();
    this.renderLevelPicker();
    this.render();
  }

  setFilter(text: string): void {
    this.filter = text;
    // Not while it's being typed (the caret would jump): only when set from elsewhere.
    if (this.filterBox.value !== text) this.filterBox.value = text;
    this.render();
  }

  setWordWrap(on: boolean): void {
    this.wordWrap = on;
    this.renderWrap();
  }

  private renderWrap(): void {
    this.body.classList.toggle("is-nowrap", !this.wordWrap);
    this.wrapButton.setAttribute("aria-pressed", String(this.wordWrap));
  }

  private renderPicker(): void {
    const channels = output.list();
    if (!channels.some((c) => c.id === this.channel))
      channels.push({
        id: this.channel,
        label: this.channel,
        records: 0,
        level: output.levelOf(this.channel),
        ownLevel: false,
      });
    this.picker.replaceChildren(...channels.map((c) => h("option", { value: c.id }, c.label)));
    this.picker.value = this.channel;
  }

  private renderLevelPicker(): void {
    this.levelPicker.replaceChildren(
      h("option", { value: "default" }, `Default (${capitalized(output.level)})`),
      ...OUTPUT_LEVELS.map((l) => h("option", { value: l }, capitalized(l))),
    );
    this.levelPicker.value = output.ownLevel(this.channel) ?? "default";
  }

  private schedule(channels: boolean): void {
    // "" (the list or the levels changed): the pickers too; the level picker follows log.level
    // (its "Default" entry) and log.channelLevels.
    if (channels) {
      this.renderPicker();
      this.renderLevelPicker();
    }
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    const el = this.body;
    // Kept at the end while it's at the end (VS Code's Output follows new lines the same way).
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    const records = output.records(this.channel);
    const filter = parseOutputFilter(this.filter);
    const lines = filterLines(records.map(formatRecord), filter);
    const level = output.levelOf(this.channel);
    el.textContent = lines.length
      ? lines.join("\n")
      : records.length && !isEmptyFilter(filter)
        ? "No lines match the filter."
        : `Nothing in ${output.label(this.channel) ?? this.channel} yet${level === "info" ? "" : ` (log level: ${level})`}.`;
    el.classList.toggle("is-empty", !lines.length);
    if (atEnd) el.scrollTop = el.scrollHeight;
  }

  focus(): void {
    this.body.focus({ preventScroll: true });
  }

  serialize(): Json {
    return { channel: this.channel, filter: this.filter, wordWrap: this.wordWrap };
  }

  dispose(): void {
    this.store.dispose();
  }
}
