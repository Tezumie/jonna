// One terminal of a terminal tab (D209: a tab holds one or more, side by side — VS Code's
// terminal group). The pty starts when the pane is created (a restored pane starts a fresh shell
// in its saved cwd); moving the tab moves the canvas and the pty keeps running. Its own find bar,
// "Fix" button, context menu and command suggestions.
import type { Json } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { ptyIpc, type RunSpec } from "../../core/ipc/process";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { icon } from "../../ui/Icon";
import { showContextMenu } from "../../ui/Menu";
import { setTooltip } from "../../ui/Tooltip";
import { stateField } from "../../workbench/dock/views";
import { extensionTerminalStart } from "./extensionTerminals";
import type { SavedOutput } from "./persist";
import type { TerminalInstance, TerminalStart } from "./service";
import { parsePtyRef } from "./split";
import { TerminalSuggest } from "./suggestWidget";
import {
  TERMINAL_COLORS,
  TERMINAL_ICONS,
  type TerminalColor,
  type TerminalIcon,
  type TerminalViewHost,
} from "./viewHost";

/** What a pane asks of the tab it's in (view.ts). */
export interface PaneOwner {
  readonly tabId: string;
  /** The pane's title, state, color or icon changed: the tab saves and redraws. */
  paneChanged(pane: TerminalPane): void;
  /** The pane took the keyboard focus: it's the tab's active one now. */
  paneFocused(pane: TerminalPane): void;
  /** Visual bell: flash the tab. */
  flash(): void;
  /** Panes in the tab (the menu offers "Unsplit" when there are several). */
  paneCount(): number;
  /** The tab is on screen. */
  isVisible(): boolean;
}

/** The longest a terminal tab shows its starting spinner. */
const STARTING_MAX_MS = 10_000;

const colorOf = (state: Json): TerminalColor | undefined => {
  const c = stateField(state, "color");
  return TERMINAL_COLORS.find((x) => x === c);
};
const iconOf = (state: Json): TerminalIcon | undefined => {
  const i = stateField(state, "icon");
  return TERMINAL_ICONS.find((x) => x === i);
};

let nextPane = 1;

export class TerminalPane {
  /** Unique for the session (the key in the host's `views`). */
  readonly uid = `pane-${nextPane++}`;
  readonly element: HTMLElement;
  readonly store = new DisposableStore();
  private readonly fix: HTMLButtonElement;
  /** Resolves when the shell is running (rejects if it couldn't start). */
  readonly ready: Promise<TerminalInstance>;
  instance: TerminalInstance | undefined;
  private readonly cwd: string | null;
  /** The task this terminal runs (D134); null for an interactive shell. */
  readonly task: string | null;
  /**
   * The task whose process this pane took back after a window reload (its tab's `task` with a
   * running `pty`): the tasks extension links it to the task again (taskTerminals.ts).
   */
  readonly restoredTask: string | null;
  color: TerminalColor | undefined;
  icon: TerminalIcon | undefined;
  /** The terminal profile this pane starts (D204); kept for the restored tab. */
  private profile: string | undefined;
  /**
   * Not saved with the folder (D388): an extension's terminal made with hideFromUser or
   * isTransient. Its tab, or its place among the hidden ones, is gone after a restart.
   */
  readonly transient: boolean;
  /** Command suggestions while typing (D204), once the shell runs with integration. */
  suggest: TerminalSuggest | undefined;

  /** Tab color and icon (D120); kept with the tab across restarts. Null resets. */
  setAppearance(change: { color?: TerminalColor | null; icon?: TerminalIcon | null }): void {
    if (change.color !== undefined) this.color = change.color ?? undefined;
    if (change.icon !== undefined) this.icon = change.icon ?? undefined;
    this.owner.paneChanged(this);
  }

  constructor(
    state: Json,
    private owner: PaneOwner,
    private readonly host: TerminalViewHost,
    /** The key its last session's output was saved under (split.ts paneRestoreKey). */
    restoreKey: string,
  ) {
    const cwd = stateField(state, "cwd");
    const name = stateField(state, "name");
    const task = stateField(state, "task");
    const run = stateField(state, "run") as RunSpec | undefined;
    // A JavaScript debug terminal's variables (D204): for this shell only, never saved with the tab.
    const envField = stateField(state, "env");
    const env =
      envField && typeof envField === "object" && !Array.isArray(envField)
        ? Object.fromEntries(
            Object.entries(envField).filter((e): e is [string, string] => typeof e[1] === "string"),
          )
        : undefined;
    // A task terminal restored from the last session is an ordinary shell (the task isn't rerun).
    this.task = typeof task === "string" && run && typeof run === "object" ? task : null;
    this.color = colorOf(state);
    this.icon = iconOf(state);
    const profile = stateField(state, "profile");
    this.profile = typeof profile === "string" && profile ? profile : undefined;
    this.transient = stateField(state, "transient") === true;
    this.cwd = typeof cwd === "string" ? cwd : host.defaultCwd();
    // The process the page before a reload had (m7.12): taken back if it's still running.
    const reattach = this.task ? null : parsePtyRef(stateField(state, "pty"));
    this.restoredTask = !this.task && reattach && typeof task === "string" ? task : null;
    const surface = h("div", { class: "terminal-surface" });
    // "Fix with agent" on a failed command: only while the pointer is on that command's line
    // (or on the sticky line showing it), at the line's right end (D150).
    this.fix = h(
      "button",
      { class: "terminal-fix", type: "button", hidden: true },
      icon("agent"),
      h("span", null, "Fix"),
    );
    setTooltip(this.fix, "Fix with agent: send the command and its output to the chat");
    this.store.add(on(this.fix, "mousedown", (e) => e.preventDefault()));
    this.store.add(
      on(this.fix, "click", () => {
        this.fix.hidden = true;
        this.host.run("terminal.fixWithAgent", {
          id: this.instance?.id,
          ...(this.fixSeq !== undefined && { command: this.fixSeq }),
        });
      }),
    );
    this.element = h("div", { class: "terminal-pane", "data-os-drop": "" }, surface, this.fix);
    host.views.set(this.uid, this);
    this.store.add({
      dispose: () => {
        if (host.views.get(this.uid) === this) host.views.delete(this.uid);
      },
    });
    this.store.add(
      on(this.element, "focusin", () => {
        host.context.set("terminalFocus", true);
        this.owner.paneFocused(this);
      }),
    );
    this.store.add(on(this.element, "focusout", () => host.context.set("terminalFocus", false)));
    this.store.add({ dispose: () => host.context.set("terminalFocus", false) });
    this.store.add(
      on(this.element, "contextmenu", (e) => {
        e.preventDefault();
        const t = this.instance;
        // Windows Terminal's right click: copy the selection, or paste.
        if (t && this.host.rightClickBehavior() === "copyPaste") {
          if (t.renderer.hasSelection()) this.host.run("terminal.copySelection", { id: t.id });
          else this.host.run("terminal.paste", { id: t.id });
          return;
        }
        this.contextMenu(e.clientX, e.clientY);
      }),
    );
    // The fix button follows the pointer over failed commands' lines (one check per frame).
    let hoverFrame = 0;
    this.store.add({ dispose: () => cancelAnimationFrame(hoverFrame) });
    this.store.add(
      on(this.element, "mousemove", (e) => {
        if (e.buttons) return; // selecting
        cancelAnimationFrame(hoverFrame);
        const { clientX, clientY, target } = e;
        hoverFrame = requestAnimationFrame(() => this.hoverFix(clientX, clientY, target));
      }),
    );
    this.store.add(
      on(this.element, "mouseleave", () => {
        cancelAnimationFrame(hoverFrame);
        this.fix.hidden = true;
      }),
    );
    this.stage = "choosing the shell";
    // An extension's terminal (D233): its pseudoterminal, or the shell it chose.
    const fromExtension = this.task ? null : extensionTerminalStart(state);
    this.ready = (
      this.task
        ? Promise.resolve<TerminalStart>({})
        : fromExtension
          ? Promise.resolve(fromExtension)
          : host.startFor(restoreKey, this.profile, reattach)
    )
      .then((start) => {
        if (this.store.isDisposed) throw new Error("Terminal tab closed before its shell started");
        if (start.profileName) this.profile = start.profileName;
        this.restoredFrom = start.restoredFrom;
        // A profile's color and icon, unless the tab has its own.
        this.color ??= TERMINAL_COLORS.find((c) => c === start.color);
        this.icon ??= TERMINAL_ICONS.find((i) => i === start.icon);
        if (start.color || start.icon) this.owner.paneChanged(this);
        return host.terminals.create(
          this.cwd,
          surface,
          host.appearance(),
          host.shellIntegration(),
          typeof name === "string" ? name : (start.title ?? null),
          (stage) => {
            this.stage = stage;
          },
          this.task ? run : undefined,
          start,
          env,
        );
      })
      .then(
        (instance) => {
          if (this.store.isDisposed) {
            // A view dropped while a reload restores the layout: the process it took back stays
            // for the view that is shown (it can take it again).
            if (instance.reattached) host.terminals.release(instance.id);
            else host.terminals.kill(instance.id);
            throw new Error("Terminal tab closed before its shell started");
          }
          this.instance = instance;
          const suggestHost = host.suggestHost();
          if (suggestHost && instance.info.integration && !this.task) {
            this.suggest = new TerminalSuggest(
              instance,
              this.element,
              suggestHost,
              (dir, hidden) => ptyIpc.listDir(instance.id, dir, hidden),
              (data) => void ptyIpc.write(instance.id, data).catch(() => {}),
            );
            this.store.add(this.suggest);
          }
          this.store.add(
            instance.onBell(() => {
              const mode = host.bellMode();
              if (mode === "visual") this.owner.flash();
              else if (mode === "sound") playBell();
            }),
          );
          this.store.add({ dispose: () => host.terminals.kill(instance.id) });
          // A finished task's terminal: any key closes it (VS Code's "press any key").
          if (this.task)
            this.store.add(
              instance.renderer.onInput(() => {
                if (instance.exitCode.peek() === null) return;
                if (this.owner.paneCount() > 1) host.run("terminal.kill", { id: instance.id });
                else host.run("layout.closeTab", { tabId: this.owner.tabId });
              }),
            );
          // A command's dot: its actions (VS Code's command decoration menu).
          this.store.add(
            instance.renderer.onCommandMenu(({ seq, x, y }) => this.commandMenu(seq, x, y)),
          );
          this.store.add(instance.onDidStartCommand(() => (this.fix.hidden = true)));
          this.store.add(
            effect(() => {
              instance.title.value;
              instance.exitCode.value;
              if (
                instance.promptReady.value ||
                !instance.info.integration ||
                instance.exitCode.value !== null
              )
                this.starting = false;
              // Keep the folder and name for restore (a restored tab starts in the last folder).
              this.owner.paneChanged(this);
              return undefined;
            }),
          );
          if (this.owner.isVisible()) this.onResize();
          return instance;
        },
        (err: unknown) => {
          this.failed = true;
          this.starting = false;
          this.owner.paneChanged(this);
          if (!this.store.isDisposed)
            this.showError(err instanceof Error ? err.message : String(err));
          throw err;
        },
      );
    this.ready.catch(() => {});
    // A start that never finishes would otherwise leave an empty tab with no explanation.
    const watchdog = setTimeout(() => {
      if (!this.instance && !this.store.isDisposed && !this.failed)
        this.showError(
          `Still waiting after 25 s while ${this.stage}. Check that your shell starts on its own; "Kill terminal" and a new terminal retries.`,
        );
    }, 25_000);
    this.store.add({ dispose: () => clearTimeout(watchdog) });
    // A prompt that never marks itself (a theme without our marks): the spinner stops anyway.
    const stopSpinner = setTimeout(() => {
      if (!this.starting || this.store.isDisposed) return;
      this.starting = false;
      this.owner.paneChanged(this);
    }, STARTING_MAX_MS);
    this.store.add({ dispose: () => clearTimeout(stopSpinner) });
  }

  get tabId(): string {
    return this.owner.tabId;
  }

  /** Moved into another tab ("Unsplit"): the shell keeps running there. */
  rehome(owner: PaneOwner): void {
    this.owner = owner;
  }

  /** VS Code's terminal menu: clipboard, last command, clear, split / new, rename, kill. */
  private contextMenu(x: number, y: number): void {
    const t = this.instance;
    const id = t?.id;
    const run =
      (command: string, input: unknown = { id }) =>
      () =>
        this.host.run(command, input);
    const key = (command: string) => this.host.keybinding(command);
    const hasSelection = t?.renderer.hasSelection() ?? false;
    const last = t?.renderer.lastCommand() ?? null;
    const split = this.owner.paneCount() > 1;
    showContextMenu(x, y, [
      {
        label: "Copy",
        icon: "copy",
        disabled: !hasSelection,
        keybinding: this.host.isMac ? "⌘C" : "Ctrl+C",
        run: run("terminal.copySelection"),
      },
      {
        label: "Paste",
        icon: "clipboard-paste",
        keybinding: this.host.isMac ? "⌘V" : "Ctrl+V",
        run: run("terminal.paste"),
      },
      { label: "Select all", run: run("terminal.selectAll") },
      {
        label: "Copy last command",
        icon: "copy",
        separatorBefore: true,
        disabled: !last,
        run: run("terminal.copyLastCommand"),
      },
      {
        label: "Copy last command output",
        icon: "copy",
        disabled: !last,
        run: run("terminal.copyLastOutput"),
      },
      {
        label: "Run recent command…",
        icon: "history",
        keybinding: key("terminal.runRecentCommand"),
        run: run("terminal.runRecentCommand"),
      },
      ...(this.host.canFix()
        ? [
            {
              label: "Fix last command with agent",
              icon: "agent" as const,
              disabled: !last?.exitCode,
              run: run("terminal.fixWithAgent"),
            },
          ]
        : []),
      {
        label: "Clear terminal",
        icon: "ban",
        separatorBefore: true,
        keybinding: key("terminal.clear"),
        run: run("terminal.clear"),
      },
      {
        label: "Split terminal",
        icon: "terminal-split",
        separatorBefore: true,
        keybinding: key("terminal.split"),
        run: run("terminal.split"),
      },
      ...(split
        ? [{ label: "Unsplit terminal", run: run("terminal.unsplit") }]
        : [{ label: "Split into a new group", run: run("terminal.splitToNewGroup") }]),
      { label: "Change color…", icon: "palette", run: run("terminal.setColor") },
      { label: "Change icon…", run: run("terminal.setIcon") },
      {
        label: "New terminal",
        icon: "square-terminal",
        keybinding: key("terminal.create"),
        run: run("terminal.create", {}),
      },
      { label: "Rename…", icon: "pencil", run: run("terminal.rename") },
      { label: "Hide terminal", icon: "eye-off", run: run("terminal.hide") },
      ...(split
        ? [{ label: "Hide only this terminal", run: run("terminal.hide", { id, onlyThis: true }) }]
        : []),
      { label: "Join terminals…", run: run("terminal.join", { into: id }) },
      {
        label: "Kill terminal",
        icon: "trash-2",
        destructive: true,
        separatorBefore: true,
        run: run("terminal.kill"),
      },
    ]);
  }

  /** The command the fix button is for (its number in this terminal). */
  private fixSeq: number | undefined;

  private hoverFix(x: number, y: number, target: EventTarget | null): void {
    const t = this.instance;
    if (!t || (target instanceof Node && this.fix.contains(target))) return;
    const hit = this.host.canFix() ? t.renderer.commandAtPoint(x, y) : null;
    if (!hit?.finished || !hit.exitCode) {
      this.fix.hidden = true;
      return;
    }
    const box = this.element.getBoundingClientRect();
    this.fixSeq = hit.seq;
    this.fix.style.top = `${hit.rowTop - box.top + (hit.rowHeight - 20) / 2}px`;
    // At the end of the text area, clear of the scrollbar and overview ruler.
    const screen = this.element.querySelector(".xterm-screen")?.getBoundingClientRect();
    if (screen) this.fix.style.right = `${Math.max(4, box.right - screen.right + 4)}px`;
    this.fix.hidden = false;
  }

  /** Clicking a command's dot: rerun, copy, select its output, fix (VS Code's menu). */
  private commandMenu(seq: number, x: number, y: number): void {
    const t = this.instance;
    const c = t?.renderer.command(seq);
    if (!t || !c) return;
    const run = (command: string, input: unknown) => () => this.host.run(command, input);
    const failed = c.finished && !!c.exitCode;
    showContextMenu(x, y, [
      {
        label: "Rerun command",
        icon: "rotate-cw",
        run: run("terminal.sendText", { id: t.id, text: c.command }),
      },
      {
        label: "Copy command",
        icon: "copy",
        run: run("terminal.copyLastCommand", { id: t.id, command: seq }),
      },
      {
        label: "Copy output",
        icon: "copy",
        run: run("terminal.copyLastOutput", { id: t.id, command: seq }),
      },
      ...(failed && this.host.canFix()
        ? [
            {
              label: "Fix with agent",
              icon: "agent" as const,
              separatorBefore: true,
              run: run("terminal.fixWithAgent", { id: t.id, command: seq }),
            },
          ]
        : []),
    ]);
  }

  private stage = "starting";
  private failed = false;
  /**
   * The shell hasn't drawn its first prompt yet (its tab shows a spinner): until the prompt mark,
   * at once for a shell without integration (or a task), at most STARTING_MAX_MS.
   */
  starting = true;

  private showError(message: string): void {
    this.element.replaceChildren(
      h(
        "div",
        { class: "empty-state" },
        h("div", { class: "empty-state-title" }, "Couldn't start a terminal"),
        h("div", { class: "empty-state-text" }, message),
      ),
    );
  }

  title(): string {
    const t = this.instance;
    if (!t) return "Terminal";
    const name = t.title.peek() || "Terminal";
    return t.exitCode.peek() !== null ? `${name} (exited)` : name;
  }

  onResize(): void {
    const t = this.instance;
    if (!t || !this.owner.isVisible()) return;
    t.refit();
  }

  private findBar: { el: HTMLElement; input: HTMLInputElement; count: HTMLElement } | undefined;

  /** Find in the terminal (Ctrl+F): a small bar over the top right; Enter / Shift+Enter, Esc. */
  async find(
    query?: string,
    previous = false,
  ): Promise<{ query: string; index: number; count: number }> {
    const t = await this.ready;
    const bar = this.findBar ?? this.createFindBar();
    bar.el.hidden = false;
    if (query !== undefined) bar.input.value = query;
    else if (t.renderer.hasSelection() && !t.renderer.getSelection().includes("\n"))
      bar.input.value = t.renderer.getSelection();
    bar.input.focus();
    bar.input.select();
    return this.findStep(previous);
  }

  private async findStep(
    previous: boolean,
    incremental = false,
  ): Promise<{ query: string; index: number; count: number }> {
    const t = this.instance;
    const bar = this.findBar;
    if (!t || !bar) return { query: "", index: 0, count: 0 };
    const query = bar.input.value;
    const r = await t.renderer.find(query, { previous, incremental });
    bar.count.textContent = query ? (r.count ? `${r.index} of ${r.count}` : "No results") : "";
    bar.el.classList.toggle("is-empty", !!query && r.count === 0);
    return { query, ...r };
  }

  private closeFind(): void {
    if (!this.findBar) return;
    this.findBar.el.hidden = true;
    this.instance?.renderer.clearFind();
    this.focus();
  }

  private createFindBar(): NonNullable<TerminalPane["findBar"]> {
    const input = h("input", {
      class: "input terminal-find-input",
      type: "text",
      placeholder: "Find",
      spellcheck: "false",
      "aria-label": "Find in terminal",
    }) as HTMLInputElement;
    const count = h("span", { class: "terminal-find-count", "aria-live": "polite" });
    const button = (glyph: "arrow-up" | "arrow-down" | "x", label: string, run: () => void) => {
      const b = h(
        "button",
        { class: "icon-button", type: "button", "aria-label": label },
        icon(glyph),
      );
      setTooltip(b, label);
      this.store.add(on(b, "click", run));
      return b;
    };
    const el = h(
      "div",
      { class: "terminal-find", role: "search" },
      input,
      count,
      button("arrow-up", "Previous match (Shift+Enter)", () => void this.findStep(true)),
      button("arrow-down", "Next match (Enter)", () => void this.findStep(false)),
      button("x", "Close (Escape)", () => this.closeFind()),
    );
    this.store.add(on(input, "input", () => void this.findStep(false, true)));
    this.store.add(
      on(input, "keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void this.findStep(e.shiftKey);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.closeFind();
        }
      }),
    );
    this.element.append(el);
    this.findBar = { el, input, count };
    return this.findBar;
  }

  focus(): void {
    if (this.instance) {
      this.instance.renderer.focus();
      return;
    }
    // Asked before the shell runs: focused once it does, unless the focus went somewhere else
    // meanwhile (the startup terminal took it from the editor seconds later, mid-typing, and the
    // editor's ghost text went with the blur).
    const before = document.activeElement;
    void this.ready
      .then((t) => {
        const now = document.activeElement;
        if (now === before || now === document.body || this.element.contains(now))
          t.renderer.focus();
      })
      .catch(() => {});
  }

  /** This pane's part of the tab's state (split.ts serializeGroup puts them together). */
  serialize(): Json {
    const cwd = this.instance?.cwd.peek() || this.cwd;
    const name = this.instance?.name.peek();
    const pty = this.ptyRef();
    // A task's process taken back keeps its task's name for the next reload too.
    const task = this.task ?? (pty ? this.restoredTask : null);
    if (!cwd && !name && !this.color && !this.icon && !task && !this.profile && !pty) return null;
    return {
      // Its running process, for a page reload to take back (m7.12; useless after a restart).
      ...(pty && { pty }),
      ...(cwd && { cwd }),
      ...(this.profile && { profile: this.profile }),
      // The task's name only: a restored task terminal doesn't run the task again.
      ...(task && { task }),
      ...(name && { name }),
      ...(this.color && { color: this.color }),
      ...(this.icon && { icon: this.icon }),
    };
  }

  /** The folder a split from this pane starts in. */
  currentCwd(): string | null {
    return this.instance?.cwd.peek() || this.cwd;
  }

  /** The last `lines` of output for the next session (D204); null while starting or empty. */
  savedOutput(lines: number): string | null {
    return this.instance?.renderer.serializeOutput(lines) ?? null;
  }

  /**
   * The screen to save with the output offset it reflects (a reattach replays from there), this
   * session's plain lines (what a restart shows, D253), and whether nothing ran in it yet.
   */
  savedScreen(
    lines: number,
  ): { text: string; offset?: number; lines?: string; idle: boolean } | null {
    const t = this.instance;
    const text = t?.renderer.serializeOutput(lines);
    if (!t || !text) return null;
    const offset = this.host.terminals.outputOffset(t.id);
    const plain = t.renderer.plainOutput(lines);
    // Only a prompt (one or two lines) and no command: nothing happened here.
    const idle = (plain?.fresh ?? 0) <= 2 && t.renderer.commandCount() === 0;
    return {
      text,
      ...(offset !== null && { offset }),
      ...(plain?.text && { lines: plain.text }),
      idle,
    };
  }

  /** The last session's output this pane was restored with (outputs.ts keeps it when idle). */
  restoredFrom: SavedOutput | undefined;

  /** The running process's id and reattach key (Rust terminals only; none once it exited). */
  private ptyRef(): { id: number; key: string } | null {
    const t = this.instance;
    if (!t?.info.key || t.exitCode.peek() !== null) return null;
    return { id: t.id, key: t.info.key };
  }

  dispose(): void {
    this.store.dispose();
    this.element.remove();
  }
}

/** A short, quiet tone for `terminal.bell: "sound"` (the IDE handles BEL itself; no system beep). */
function playBell(): void {
  try {
    const audio = new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.06, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.12);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.12);
    osc.onended = () => void audio.close();
  } catch {
    // No audio device: stay silent.
  }
}
