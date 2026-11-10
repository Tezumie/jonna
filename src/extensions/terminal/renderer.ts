// The terminal renderer contract plus its @xterm/xterm implementation (loaded lazily as its own
// chunk). The terminal extension only talks to `TerminalRenderer`. M1.6 switched from ghostty-web
// to the documented fallback (D48): xterm reflows and recolors in place, so resizing and theme
// switches need no workarounds.

import { Emitter, type Event } from "../../core/events/index";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { setTooltip } from "../../ui/Tooltip";
import { correctedCommandLine } from "./commandLine";
import {
  type ClipboardHandlers,
  CommandTracker,
  installClipboardKeys,
  installLinks,
  type LinkHandlers,
  pasteChecked,
  type SyntaxColors,
  type TrackerTheme,
} from "./features";
import { logicalLines, savedRange } from "./persist";

/** ConPTY underneath (Windows): clearing and reflow behave differently. */
const WINDOWS = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalRenderer extends Disposable {
  open(container: HTMLElement): void;
  /** Renders output; `rendered` fires after it has been parsed (flow-control ack). */
  write(data: Uint8Array, rendered?: () => void): void;
  /**
   * Fits the grid to the container's content box. Returns the new size only if the column or row
   * count changed (callers resize the pty only then). Never returns fewer than 2×1.
   */
  fit(): TerminalSize | undefined;
  /** A grid of exactly this size (a terminal reattached while hidden draws at its console's). */
  resizeTo(cols: number, rows: number): void;
  readonly size: TerminalSize;
  focus(): void;
  /** Clears the scrollback and screen (the prompt line stays). */
  clear(): void;
  /** Keystrokes / paste from the user, to be sent to the pty. */
  readonly onInput: Event<string>;
  readonly onTitle: Event<string>;
  /** BEL (`\x07`) from the program; the IDE decides what to do (terminal.bell). */
  readonly onBell: Event<void>;
  /** Shell-integration marks (OSC 633 / 133): "A" prompt start, "D" with the exit code… */
  readonly onShellMark: Event<{ kind: string; arg: string }>;
  /** Marks the current prompt line with a gutter dot (after its command finished). */
  decoratePrompt(exitCode: number | undefined): void;
  hasSelection(): boolean;
  getSelection(): string;
  selectAll(): void;
  /**
   * Pastes text as if typed (bracketed paste when the program asks for it); several lines where
   * the program didn't ask for bracketed paste are confirmed first.
   */
  paste(text: string): Promise<void>;
  /** The size the container fits, without resizing (null while hidden). */
  propose(): TerminalSize | null;
  /** Lines in the buffer (scrollback + screen): big buffers resize their columns lazily. */
  readonly bufferLength: number;
  /** A full-screen program (vim, htop) has the alternate screen. */
  readonly inAltBuffer: boolean;
  /** The shell integration's secret for command-line marks (D192). */
  setShellNonce(nonce: string | null): void;
  /** Cursor, scrollback, font and line height (settings), applied live. */
  setOptions(options: TerminalLook): void;
  /** The command (shell integration) on the row at a client point: the sticky line too. */
  commandAtPoint(
    clientX: number,
    clientY: number,
  ): {
    seq: number;
    exitCode?: number;
    finished: boolean;
    rowTop: number;
    rowHeight: number;
  } | null;
  /** A command's text and output by its number (null once cleared). */
  command(
    seq: number,
  ): { command: string; output: string; exitCode?: number; finished: boolean } | null;
  /** Every command still in the buffer, oldest first (Run recent command). */
  commandList(): { seq: number; command: string; exitCode?: number }[];
  /** Scrolls to the previous / next command's line; false when there's none. */
  scrollToCommand(direction: -1 | 1): boolean;
  /** The command's dot was clicked: its number and where (for a menu). */
  readonly onCommandMenu: Event<{ seq: number; x: number; y: number }>;
  /** The last finished command and its output (shell integration). */
  lastCommand(): { command: string; output: string; exitCode?: number } | null;
  /** Live theme switch (DESIGN.md §15.4). */
  setTheme(theme: TerminalTheme): void;
  setFontSize(size: number): void;
  setScrollbarSize(px: number): void;
  /**
   * Finds `query` in the scrollback and selects the next (or previous) match. Returns the match
   * number and count (0 of 0: none).
   */
  find(
    query: string,
    options?: {
      previous?: boolean;
      caseSensitive?: boolean;
      regex?: boolean;
      incremental?: boolean;
    },
  ): Promise<{ index: number; count: number }>;
  clearFind(): void;
  /**
   * The last `lines` rows of the normal screen, serialized with their colors (output after a
   * restart, D204); null when there's nothing.
   */
  serializeOutput(lines: number): string | null;
  /**
   * This session's last `lines` as plain text, wrapped rows joined, and how many aren't empty
   * (D253): what the next restart shows. The lines restored above this session aren't included.
   */
  plainOutput(lines: number): { text: string; fresh: number } | null;
  /** Commands this session ran (shell integration), for "nothing ran here" (D253). */
  commandCount(): number;
  /**
   * The last `maxLines` lines the terminal shows (scrollback and screen of the active buffer) as
   * plain text, wrapped rows joined back into their lines and trailing blank rows dropped: what a
   * person would read, whatever ran there (D211).
   */
  readText(maxLines: number): {
    text: string;
    lines: number;
    truncated: boolean;
    altScreen: boolean;
  };
  /** Writes a restored session's banner (persist.ts) before the new shell's first output. */
  writeRestored(banner: string): void;
  /** "webgl" while the GPU renderer draws, else "dom" (terminal.gpuAcceleration). */
  readonly rendererType: "webgl" | "dom";
  /** Applies terminal.gpuAcceleration: WebGL ("on", "auto" unless it failed before) or DOM. */
  setGpuAcceleration(mode: GpuAcceleration): Promise<void>;
  /**
   * What's typed at the prompt (shell integration's prompt-end mark to the end of the input):
   * the text and the cursor's offset in it; null while a command runs or without integration.
   */
  promptInput(): { line: string; cursor: number } | null;
  /** The cursor's cell in client pixels (for the suggestions), null while hidden. */
  cursorBox(): { left: number; top: number; bottom: number; cellWidth: number } | null;
  readonly onCursorMove: Event<void>;
}

export type GpuAcceleration = "auto" | "on" | "off";

export interface TerminalTheme {
  foreground: string;
  background: string;
  cursor: string;
  selectionBackground: string;
  ansi: readonly string[]; // 16 colors: black, red, green, yellow, blue, magenta, cyan, white, then bright
}

/** What settings change about the terminal's look and memory. */
export interface TerminalLook {
  cursorStyle?: "block" | "bar" | "underline";
  cursorBlink?: boolean;
  scrollback?: number;
  lineHeight?: number;
  fontFamily?: string;
  /**
   * Text that would be hard to read on its background (PowerShell's yellow progress text on
   * cyan) is lightened or darkened to at least this contrast; 1 leaves colors alone (D173).
   */
  minimumContrastRatio?: number;
}

/** VS Code's default (terminal.integrated.minimumContrastRatio): WCAG AA for normal text. */
export const DEFAULT_MIN_CONTRAST = 4.5;
const clampContrast = (n: number | undefined) =>
  Math.min(21, Math.max(1, Number.isFinite(n) ? (n as number) : DEFAULT_MIN_CONTRAST));

export interface TerminalRendererOptions extends TerminalLook {
  fontFamily: string;
  fontSize: number;
  /** The scrollbar's width in px (xterm draws it as wide as its overview ruler). */
  scrollbarSize?: number;
  theme: TerminalTheme;
  /** Links (web addresses, file paths) and clipboard keys. */
  links?: LinkHandlers;
  clipboard?: ClipboardHandlers;
  /** Editor syntax colors for command highlighting (null: off). */
  syntaxColors?(): SyntaxColors | null;
  /** Windows build number (ConPTY behavior differs by build; same as VS Code passes). */
  windowsBuild?: number;
  /** terminal.gpuAcceleration (default "auto"). */
  gpuAcceleration?: GpuAcceleration;
}

/**
 * WebGL failed once (no context, or it was lost): "auto" stays on the DOM renderer for the rest
 * of the session, as VS Code does; "on" still tries.
 */
let webglFailed = false;

const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

function xtermTheme(t: TerminalTheme): Record<string, string> {
  const theme: Record<string, string> = {
    foreground: t.foreground,
    background: t.background,
    cursor: t.cursor,
    cursorAccent: t.background,
    selectionBackground: t.selectionBackground,
    overviewRulerBorder: t.background,
  };
  ANSI_KEYS.forEach((key, i) => {
    const color = t.ansi[i];
    if (color) theme[key] = color;
  });
  return theme;
}

/** Sticky line and overview ruler colors from the terminal theme. */
function trackerTheme(t: TerminalTheme): TrackerTheme {
  return {
    ansi: t.ansi,
    foreground: t.foreground,
    ruler: {
      command: t.ansi[12] ?? t.foreground,
      failed: t.ansi[9] ?? t.foreground,
      error: t.ansi[9] ?? t.foreground,
      warning: t.ansi[11] ?? t.foreground,
    },
  };
}

/** Loads xterm (lazy chunk) and creates a renderer. */
export async function createTerminalRenderer(
  options: TerminalRendererOptions,
): Promise<TerminalRenderer> {
  const [{ Terminal }, { FitAddon }, { SearchAddon }, { Unicode11Addon }, { SerializeAddon }] =
    await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-search"),
      import("@xterm/addon-unicode11"),
      import("@xterm/addon-serialize"),
    ]);
  const term = new Terminal({
    fontFamily: options.fontFamily,
    fontSize: options.fontSize,
    lineHeight: options.lineHeight ?? 1.25,
    cursorBlink: options.cursorBlink ?? true,
    cursorStyle: options.cursorStyle ?? "block",
    scrollback: clampScrollback(options.scrollback),
    // Markers and decorations (shell-integration gutter marks) are "proposed" API in xterm 6.
    allowProposedApi: true,
    // Windows: ConPTY's own reflow and clear behavior depend on the build (VS Code passes it too).
    ...(WINDOWS && {
      windowsPty: {
        backend: "conpty" as const,
        ...(options.windowsBuild && { buildNumber: options.windowsBuild }),
      },
    }),
    // Command and error marks beside the scrollbar (VS Code's overview ruler).
    overviewRuler: { width: options.scrollbarSize ?? 12 },
    minimumContrastRatio: clampContrast(options.minimumContrastRatio),
    theme: xtermTheme(options.theme),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);
  // Emoji and CJK at their real widths (Unicode 11, as VS Code and modern terminals do): without
  // it a prompt with an emoji (Starship, oh-my-posh) puts the cursor a cell off.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  const serialize = new SerializeAddon();
  term.loadAddon(serialize);
  const renderer = new XtermRenderer(
    term,
    fit,
    search,
    options.syntaxColors ?? (() => null),
    options.theme,
    serialize,
    options.gpuAcceleration ?? "auto",
  );
  if (options.links) installLinks(term, options.links, renderer.features);
  if (options.clipboard) {
    renderer.clipboard = options.clipboard;
    installClipboardKeys(term, options.clipboard, renderer.features);
  }
  return renderer;
}

/** Scrollback lines: at least 100, at most 100 000 (memory). */
function clampScrollback(n: number | undefined): number {
  return Math.min(100_000, Math.max(100, Math.round(n ?? 10_000)));
}

type XtermModule = typeof import("@xterm/xterm");
type FitModule = typeof import("@xterm/addon-fit");
type SearchModule = typeof import("@xterm/addon-search");
type SerializeModule = typeof import("@xterm/addon-serialize");

/** A command's dot: rendered element (xterm re-renders it on scroll), state and its decoration. */
interface DotState {
  el?: HTMLElement;
  state: string;
  tip: string;
  seq?: number;
  command?: string;
  decoration?: { dispose(): void } | undefined;
  /** The row the dot was moved to (relocateDot), if it was. */
  line?: number;
}

/** Output this soon after a key is the echo of typing (the cursor stays). */
const ECHO_MS = 400;
/** The cursor shows again once output has paused this long. */
const QUIET_MS = 200;
/**
 * A private OSC (no program sends it) put just before our own cursor hide / show, so the cursor
 * handlers tell ours from the program's in the order they're parsed (D244).
 */
const OWN_CURSOR_OSC = 7766;
const OWN_CURSOR_MARK = `\x1b]${OWN_CURSOR_OSC};\x07`;

class XtermRenderer implements TerminalRenderer {
  private readonly store = new DisposableStore();
  private readonly input = this.store.add(new Emitter<string>());
  private readonly title = this.store.add(new Emitter<string>());
  private readonly bell = this.store.add(new Emitter<void>());
  private readonly mark = this.store.add(new Emitter<{ kind: string; arg: string }>());
  readonly onShellMark = this.mark.event;
  private readonly menu = this.store.add(new Emitter<{ seq: number; x: number; y: number }>());
  readonly onCommandMenu = this.menu.event;
  private readonly cursorMoved = this.store.add(new Emitter<void>());
  readonly onCursorMove = this.cursorMoved.event;
  /** Where typing starts at the current prompt (shell integration's B mark), until it runs. */
  private inputStart:
    | { marker: { line: number; isDisposed: boolean; dispose(): void }; x: number }
    | undefined;
  clipboard: ClipboardHandlers | undefined;
  /** Marker on the line where the current prompt started. */
  private promptMarker: { line: number; dispose(): void; isDisposed: boolean } | undefined;
  readonly onInput = this.input.event;
  readonly onTitle = this.title.event;
  readonly onBell = this.bell.event;

  /** Links, sticky command and highlighting (features.ts), disposed with the renderer. */
  readonly features = new DisposableStore();
  private commands: CommandTracker | undefined;
  /** Every prompt's marker (the gutter dots hang on them), so a clear can remove them all. */
  private promptMarkers: { dispose(): void; isDisposed: boolean }[] = [];
  /** A clear asked the shell to redraw (Ctrl+L): wipe once its output settles. */
  private wipeTimer: ReturnType<typeof setTimeout> | undefined;
  private wipeDeadline = 0;

  constructor(
    private readonly term: InstanceType<XtermModule["Terminal"]>,
    private readonly fitAddon: InstanceType<FitModule["FitAddon"]>,
    private readonly searchAddon: InstanceType<SearchModule["SearchAddon"]>,
    private readonly syntaxColors: () => SyntaxColors | null,
    private theme: TerminalTheme,
    private readonly serializer: InstanceType<SerializeModule["SerializeAddon"]>,
    private gpuMode: GpuAcceleration,
  ) {
    this.store.add(this.features);
    this.store.add(toDisposable(() => this.disposeWebgl()));
    const subs = [
      term.onCursorMove(() => this.cursorMoved.fire()),
      term.onData((d) => {
        this.lastInput = Date.now();
        this.confirmInputStart();
        // Typing while output had hidden the cursor: it shows at once (the echo is the user's).
        if (this.quietHidden) this.showCursorAgain();
        this.input.fire(d);
      }),
      // The program's own cursor hiding (DECTCEM, `\x1b[?25l` / `h`), so ours never undoes it.
      term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) =>
        this.trackCursorMode(params, true),
      ),
      term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) =>
        this.trackCursorMode(params, false),
      ),
      term.parser.registerOscHandler(OWN_CURSOR_OSC, () => this.ownMarker()),
      term.onTitleChange((t) => this.title.fire(t)),
      term.onBell(() => this.bell.fire()),
      term.parser.registerOscHandler(633, (data) => {
        this.has633 = true;
        return this.onOsc(data);
      }),
      // Prompt themes (oh-my-posh, starship…) can send their own 133 marks beside our 633: once
      // ours are seen, theirs would only double every command.
      term.parser.registerOscHandler(133, (data) => (this.has633 ? true : this.onOsc(data))),
    ];
    this.store.add(
      toDisposable(() => {
        for (const sub of subs) sub.dispose();
        clearTimeout(this.wipeTimer);
      }),
    );
  }

  private has633 = false;
  /** The input start (B) wasn't checked against a keystroke yet (see confirmInputStart). */
  private inputStartFresh = false;

  /**
   * Windows 10's ConPTY can draw the prompt after its B mark, so the column recorded there was the
   * line's start and "the typed line" held the whole prompt (D253: no suggestions, a command
   * named after the prompt). At the user's first key after B the prompt is drawn and the cursor
   * stands where typing starts: that column is the one.
   */
  private confirmInputStart(): void {
    if (!this.inputStartFresh) return;
    this.inputStartFresh = false;
    const start = this.inputStart;
    const buf = this.term.buffer.active;
    if (!start || start.marker.isDisposed || this.inAltBuffer) return;
    const row = buf.baseY + buf.cursorY;
    // A prompt of several lines drawn after the mark: the cursor is a few rows below it.
    if (row < start.marker.line || row - start.marker.line > 5) return;
    if (row === start.marker.line) {
      if (buf.cursorX > start.x) start.x = buf.cursorX;
    } else {
      const moved = this.term.registerMarker(0);
      if (!moved) return;
      start.marker.dispose();
      this.inputStart = { marker: moved, x: buf.cursorX };
    }
    this.commands?.confirmInput(row, buf.cursorX);
  }

  private onOsc(data: string): boolean {
    const semi = data.indexOf(";");
    const kind = semi < 0 ? data : data.slice(0, semi);
    const arg = semi < 0 ? "" : data.slice(semi + 1);
    if (kind === "A") {
      this.promptMarker = this.term.registerMarker(0);
      if (this.promptMarker) {
        this.promptMarkers.push(this.promptMarker);
        if (this.promptMarkers.length > 600)
          this.promptMarkers = this.promptMarkers.filter((m) => !m.isDisposed);
      }
    }
    this.commands?.mark(kind, arg);
    // A command tracked only now (its line came with E or D, D253): its dot gets its number.
    if (kind === "E" || kind === "D") this.adoptCommand();
    // The prompt's end is where typing starts (VS Code's prompt input model); a command
    // running, or a new prompt starting, ends it.
    if (kind === "B") {
      this.inputStart?.marker.dispose();
      const marker = this.term.registerMarker(0);
      this.inputStart = marker ? { marker, x: this.term.buffer.active.cursorX } : undefined;
      this.inputStartFresh = !!marker;
    } else if (kind === "A" || kind === "C" || kind === "D") {
      this.inputStart?.marker.dispose();
      this.inputStart = undefined;
    }
    if (kind === "C") {
      // The prompt that started this command gets a "running" dot, finished on D. (After the
      // tracker saw the mark, so the dot knows its command's number.)
      this.commandMarker = this.promptMarker;
      this.commandStart = Date.now();
      this.decorate("running");
      // A long-running command (a dev server) never reaches D: its dot is put on the command's
      // row now and again while ConPTY redraws (D217).
      for (const t of this.relocateTimers.splice(0)) clearTimeout(t);
      const dot = this.dot;
      const marker = this.commandMarker;
      if (dot && marker)
        for (const ms of [0, 150, 600, 2000])
          this.relocateTimers.push(
            setTimeout(() => {
              if (this.dot === dot) this.relocateDot(dot, marker);
            }, ms),
          );
    }
    this.mark.fire({ kind, arg });
    return true;
  }
  private commandMarker: { line: number; dispose(): void; isDisposed: boolean } | undefined;

  private commandStart = 0;
  /** The current command's dot: rendered element (xterm re-renders it on scroll) and state. */
  private dot: DotState | undefined;

  /** DESIGN.md §15.4: 6px dot left of the prompt; running → success / error; hover = duration. */
  private decorate(state: "running" | "success" | "error", tip = "Running…"): void {
    const marker = this.commandMarker;
    if (!marker || marker.isDisposed) return;
    const last = this.commands?.commands.at(-1);
    const seq = last && last.prompt.line === marker.line ? last.seq : undefined;
    const dot: DotState = {
      state,
      tip,
      ...(seq !== undefined && { seq }),
      ...(last && seq !== undefined && { command: last.command }),
    };
    this.dot = dot;
    this.placeDot(dot, marker);
  }

  /** The running command's dot, made before the tracker knew the command: give it its number. */
  private adoptCommand(): void {
    const dot = this.dot;
    const marker = this.commandMarker;
    if (!dot || dot.seq !== undefined || !marker || marker.isDisposed) return;
    const last = this.commands?.commands.at(-1);
    if (!last || last.prompt.line !== marker.line) return;
    // Its number only: its menu works now. Where it's drawn stays as it was (a dot given its
    // command text moves to the row showing that text, D217, which the hover's row lookup
    // doesn't follow on Windows 10's ConPTY).
    dot.seq = last.seq;
    const seq = last.seq;
    if (dot.el)
      dot.el.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.menu.fire({ seq, x: e.clientX, y: e.clientY });
      };
  }

  /** Draws `dot` left of `marker`'s row (again, after a move: xterm re-renders the element). */
  private placeDot(dot: DotState, marker: { line: number; isDisposed: boolean }): void {
    dot.decoration?.dispose();
    const decoration = this.term.registerDecoration({ marker: marker as never, x: 0, width: 1 });
    dot.decoration = decoration;
    decoration?.onRender((el) => {
      dot.el = el;
      paint(el, dot.state, dot.tip);
      // xterm re-renders and replaces the element: a property, not a listener that piles up.
      el.onclick =
        dot.seq === undefined
          ? null
          : (e) => {
              e.preventDefault();
              e.stopPropagation();
              this.menu.fire({ seq: dot.seq ?? 0, x: e.clientX, y: e.clientY });
            };
    });
  }

  decoratePrompt(exitCode: number | undefined): void {
    const dot = this.dot;
    const marker = this.commandMarker;
    this.commandMarker = undefined;
    this.dot = undefined;
    if (!dot) return;
    const seconds = (Date.now() - this.commandStart) / 1000;
    const took = seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds)} s`;
    dot.state = exitCode === undefined || exitCode === 0 ? "success" : "error";
    dot.tip = `${exitCode === undefined ? "Finished" : `Exit code ${exitCode}`} · ${took}${dot.seq !== undefined ? " · Click for actions" : ""}`;
    if (dot.el) paint(dot.el, dot.state, dot.tip);
    if (marker) this.relocateDot(dot, marker);
  }

  /**
   * ConPTY may have left the mark off the command's row (D211, D217: a blank row next to the
   * prompt, or one the output filled since): the dot moves to the row that holds the command.
   * Run when the command starts (a few times, as ConPTY redraws) and when it finishes.
   */
  private relocateDot(dot: DotState, marker: { line: number; isDisposed: boolean }): void {
    if (marker.isDisposed || !dot.command) return;
    const buf = this.term.buffer.active;
    const to = correctedCommandLine(
      (y) => buf.getLine(y)?.translateToString(true),
      marker.line,
      dot.command,
    );
    if (to === (dot.line ?? marker.line)) return;
    const moved = this.term.registerMarker(to - (buf.baseY + buf.cursorY));
    if (moved) {
      this.promptMarkers.push(moved);
      this.placeDot(dot, moved);
      dot.line = to;
    }
  }

  private relocateTimers: ReturnType<typeof setTimeout>[] = [];

  get size(): TerminalSize {
    return { cols: this.term.cols, rows: this.term.rows };
  }

  open(container: HTMLElement): void {
    this.term.open(container);
    this.commands = this.features.add(
      new CommandTracker(this.term, this.syntaxColors, container, () => trackerTheme(this.theme), {
        requested: () => {
          this.pendingStale = this.snapshot();
        },
        done: () => {
          // After the shell's output that carried this mark has been parsed.
          const stale = this.pendingStale ?? this.snapshot();
          this.pendingStale = undefined;
          this.later(() => this.wipe(stale));
        },
      }),
    );
    this.commands.nonce = this.shellNonce;
    void this.setGpuAcceleration(this.gpuMode);
  }

  // ---- Renderer: WebGL with the DOM renderer as the fallback (D204) ----------------------------

  private webgl: { dispose(): void } | undefined;
  private webglRetried = false;

  get rendererType(): "webgl" | "dom" {
    return this.webgl ? "webgl" : "dom";
  }

  async setGpuAcceleration(mode: GpuAcceleration): Promise<void> {
    this.gpuMode = mode;
    const want = mode === "on" || (mode === "auto" && !webglFailed);
    if (!want) {
      this.disposeWebgl();
      return;
    }
    if (this.webgl || !this.term.element) return;
    try {
      const { WebglAddon } = await import("@xterm/addon-webgl");
      if (this.store.isDisposed || this.webgl || this.gpuMode !== mode) return;
      const addon = new WebglAddon();
      // A lost context (GPU reset, driver update, too many contexts): back to the DOM renderer
      // at once. "on" tries once more; "auto" stays on the DOM renderer from now on.
      const lost = addon.onContextLoss(() => {
        lost.dispose();
        this.disposeWebgl();
        if (this.gpuMode === "on" && !this.webglRetried) {
          this.webglRetried = true;
          const retry = setTimeout(() => {
            if (!this.store.isDisposed) void this.setGpuAcceleration("on");
          }, 1000);
          this.store.add(toDisposable(() => clearTimeout(retry)));
        } else webglFailed = true;
      });
      this.term.loadAddon(addon);
      this.webgl = addon;
    } catch (err) {
      // No WebGL2 here (an old GPU, a VM, a blocklisted driver): the DOM renderer it is.
      webglFailed = true;
      console.warn("Terminal: WebGL renderer unavailable, using the DOM renderer.", err);
    }
  }

  private disposeWebgl(): void {
    const addon = this.webgl;
    this.webgl = undefined;
    try {
      addon?.dispose();
    } catch {
      // A context already gone can throw while it's released.
    }
  }

  // ---- Output after a restart (D204) -----------------------------------------------------------

  readText(maxLines: number): {
    text: string;
    lines: number;
    truncated: boolean;
    altScreen: boolean;
  } {
    const buf = this.term.buffer.active;
    let last = buf.length - 1;
    while (last > 0 && !buf.getLine(last)?.translateToString(true).trim()) last--;
    // Walk back from the end, joining wrapped rows into the line they continue.
    const out: string[] = [];
    let row = last;
    let current = "";
    while (row >= 0 && out.length < maxLines) {
      const line = buf.getLine(row);
      if (!line) break;
      current = line.translateToString(true) + current;
      if (!line.isWrapped) {
        out.push(current);
        current = "";
      }
      row--;
    }
    if (current) out.push(current);
    out.reverse();
    return {
      text: out.join("\n"),
      lines: out.length,
      truncated: row >= 0,
      altScreen: buf.type === "alternate",
    };
  }

  serializeOutput(lines: number): string | null {
    if (lines <= 0) return null;
    const buf = this.term.buffer.normal;
    let last = buf.length - 1;
    while (last > 0 && !buf.getLine(last)?.translateToString(true).trim()) last--;
    const cursorRow = buf.baseY + buf.cursorY;
    const range = savedRange(
      this.term.buffer.active.type === "normal" ? cursorRow : -1,
      last,
      lines,
    );
    if (!range || (range.end === 0 && !buf.getLine(0)?.translateToString(true).trim())) return null;
    try {
      return this.serializer.serialize({
        range: { start: range.start, end: range.end },
        excludeAltBuffer: true,
        excludeModes: true,
      });
    } catch {
      return null;
    }
  }

  writeRestored(banner: string): void {
    // Where this session's own output starts, once the banner is in (plainOutput saves from there).
    const mark = () => {
      this.sessionStart?.dispose();
      this.sessionStart = this.term.registerMarker(0);
    };
    // ConPTY believes it starts on an empty screen and repaints it as such (a resize, a clear):
    // the restored lines go into the scrollback, the new prompt starts at the top (Windows).
    if (WINDOWS) {
      this.term.write(banner);
      this.term.write(`${"\r\n".repeat(this.term.rows)}\x1b[H`, mark);
    } else this.term.write(banner, mark);
  }

  /** The first row of this session's own output, below a restored session's lines. */
  private sessionStart: { line: number; isDisposed: boolean; dispose(): void } | undefined;

  plainOutput(lines: number): { text: string; fresh: number } | null {
    if (lines <= 0) return null;
    const buf = this.term.buffer.normal;
    let last = buf.length - 1;
    while (last > 0 && !buf.getLine(last)?.translateToString(true).trim()) last--;
    const cursorRow = buf.baseY + buf.cursorY;
    const range = savedRange(
      this.term.buffer.active.type === "normal" ? cursorRow : -1,
      last,
      lines,
    );
    if (!range) return null;
    const start = this.sessionStart;
    const from = start && !start.isDisposed ? Math.max(range.start, start.line) : range.start;
    const rows: { text: string; wrapped: boolean }[] = [];
    for (let y = from; y <= range.end; y++) {
      const line = buf.getLine(y);
      if (line) rows.push({ text: line.translateToString(true), wrapped: line.isWrapped });
    }
    return logicalLines(rows);
  }

  commandCount(): number {
    return this.commands?.commands.length ?? 0;
  }

  // ---- The prompt's input, for command suggestions (D204) ---------------------------------------

  promptInput(): { line: string; cursor: number } | null {
    const start = this.inputStart;
    if (!start || start.marker.isDisposed || this.inAltBuffer) return null;
    const buf = this.term.buffer.active;
    const cursorRow = buf.baseY + buf.cursorY;
    const first = start.marker.line;
    // The input is a few lines at most; a cursor far away is a program's own screen.
    if (first < 0 || first > cursorRow || cursorRow - first > 40) return null;
    let before = "";
    let after = "";
    for (let row = first; row < buf.length; row++) {
      const line = buf.getLine(row);
      if (!line) break;
      const from = row === first ? start.x : 0;
      if (row < cursorRow) before += line.translateToString(false, from);
      else if (row === cursorRow) {
        const x = Math.max(from, buf.cursorX);
        before += line.translateToString(false, from, x);
        after += line.translateToString(false, x);
      } else if (line.isWrapped) after += line.translateToString(false);
      else break;
    }
    return { line: before + after.trimEnd(), cursor: before.length };
  }

  cursorBox(): { left: number; top: number; bottom: number; cellWidth: number } | null {
    const screen = this.term.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return null;
    const r = screen.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const cellWidth = r.width / this.term.cols;
    const cellHeight = r.height / this.term.rows;
    const buf = this.term.buffer.active;
    const row = buf.baseY + buf.cursorY - buf.viewportY;
    if (row < 0 || row >= this.term.rows) return null;
    const top = r.top + row * cellHeight;
    return { left: r.left + buf.cursorX * cellWidth, top, bottom: top + cellHeight, cellWidth };
  }

  hasSelection(): boolean {
    return this.term.hasSelection();
  }

  getSelection(): string {
    return this.term.getSelection();
  }

  selectAll(): void {
    this.term.selectAll();
  }

  paste(text: string): Promise<void> {
    return this.clipboard
      ? pasteChecked(this.term, text, this.clipboard)
      : Promise.resolve(this.term.paste(text));
  }

  propose(): TerminalSize | null {
    const p = this.fitAddon.proposeDimensions();
    if (!p || !Number.isFinite(p.cols) || !Number.isFinite(p.rows)) return null;
    return { cols: Math.max(2, p.cols), rows: Math.max(1, p.rows) };
  }

  get bufferLength(): number {
    return this.term.buffer.active.length;
  }

  private shellNonce: string | null = null;

  setShellNonce(nonce: string | null): void {
    this.shellNonce = nonce;
    if (this.commands) this.commands.nonce = nonce;
  }

  get inAltBuffer(): boolean {
    return this.term.buffer.active.type === "alternate";
  }

  setOptions(look: TerminalLook): void {
    const o = this.term.options;
    if (look.cursorStyle && o.cursorStyle !== look.cursorStyle) o.cursorStyle = look.cursorStyle;
    if (look.cursorBlink !== undefined && o.cursorBlink !== look.cursorBlink)
      o.cursorBlink = look.cursorBlink;
    if (look.scrollback !== undefined) {
      const n = clampScrollback(look.scrollback);
      if (o.scrollback !== n) o.scrollback = n;
    }
    if (look.lineHeight !== undefined && o.lineHeight !== look.lineHeight)
      o.lineHeight = Math.min(2, Math.max(1, look.lineHeight));
    if (look.fontFamily && o.fontFamily !== look.fontFamily) o.fontFamily = look.fontFamily;
    if (look.minimumContrastRatio !== undefined) {
      const n = clampContrast(look.minimumContrastRatio);
      if (o.minimumContrastRatio !== n) o.minimumContrastRatio = n;
    }
    this.commands?.refresh();
  }

  commandAtPoint(
    clientX: number,
    clientY: number,
  ): {
    seq: number;
    exitCode?: number;
    finished: boolean;
    rowTop: number;
    rowHeight: number;
  } | null {
    const screen = this.term.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!screen || !this.commands) return null;
    const r = screen.getBoundingClientRect();
    if (clientY < r.top || clientY >= r.bottom || clientX < r.left - 16 || clientX > r.right + 40)
      return null;
    const rowHeight = r.height / this.term.rows;
    const row = Math.floor((clientY - r.top) / rowHeight);
    // The sticky line covers the first row.
    const entry =
      row === 0 && this.commands.shownSticky
        ? this.commands.shownSticky
        : this.commands.commandAtLine(this.term.buffer.active.viewportY + row);
    if (!entry) return null;
    return {
      seq: entry.seq,
      ...(entry.exitCode !== undefined && { exitCode: entry.exitCode }),
      finished: !!entry.end,
      rowTop: r.top + row * rowHeight,
      rowHeight,
    };
  }

  command(
    seq: number,
  ): { command: string; output: string; exitCode?: number; finished: boolean } | null {
    const entry = this.commands?.bySeq(seq);
    return entry && this.commands ? this.commands.details(entry) : null;
  }

  commandList(): { seq: number; command: string; exitCode?: number }[] {
    return (this.commands?.commands ?? [])
      .filter((c) => !c.prompt.isDisposed)
      .map((c) => ({
        seq: c.seq,
        command: c.command,
        ...(c.exitCode !== undefined && { exitCode: c.exitCode }),
      }));
  }

  scrollToCommand(direction: -1 | 1): boolean {
    const line = this.commands?.neighbour(direction);
    if (line === null || line === undefined) {
      if (direction > 0) this.term.scrollToBottom();
      return false;
    }
    this.term.scrollToLine(Math.max(0, line));
    return true;
  }

  lastCommand(): { command: string; output: string; exitCode?: number } | null {
    return this.commands?.last() ?? null;
  }

  write(data: Uint8Array, rendered?: () => void): void {
    // A program printing on its own (a spinner, a progress bar): the cursor is hidden until the
    // output pauses, so it doesn't jump back and forth over what's drawn (VS Code shows it there).
    // Not right after a key (that's the echo of typing), in a full-screen app, or when the program
    // hid it itself.
    const echo = Date.now() - this.lastInput < ECHO_MS;
    if (!echo && !this.quietHidden && !this.appHidesCursor && !this.inAltBuffer) {
      this.quietHidden = true;
      this.term.write(`${OWN_CURSOR_MARK}\x1b[?25l`);
    }
    this.term.write(data, rendered);
    if (this.quietHidden) {
      clearTimeout(this.quietTimer);
      this.quietTimer = setTimeout(() => this.showCursorAgain(), QUIET_MS);
    }
    // Waiting for the shell's redraw after Ctrl+L: wipe once it has been quiet a moment.
    if (this.awaitingRedraw) this.scheduleWipe();
  }

  resizeTo(cols: number, rows: number): void {
    const c = Math.max(2, Math.round(cols));
    const r = Math.max(1, Math.round(rows));
    if (c !== this.term.cols || r !== this.term.rows) this.term.resize(c, r);
  }

  fit(): TerminalSize | undefined {
    const proposed = this.fitAddon.proposeDimensions();
    if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows))
      return undefined;
    const cols = Math.max(2, proposed.cols);
    const rows = Math.max(1, proposed.rows);
    if (cols === this.term.cols && rows === this.term.rows) return undefined;
    this.term.resize(cols, rows);
    return { cols, rows };
  }

  focus(): void {
    this.term.focus();
  }

  /**
   * The Clear button (D118, D120). At a prompt (shell integration), the shell clears: Ctrl+L,
   * "clear screen" in PSReadLine, bash, zsh and fish, which keeps what's typed and redraws the
   * whole prompt (a two-line prompt stays whole). On Windows that keeps ConPTY's screen in step
   * with ours — clearing only xterm left ConPTY drawing at its old cursor row (a pasted line
   * showed twice) and repainting old lines on the next Enter. Once the redraw has settled,
   * scrollback and the old marks go. While a command runs (or without integration), xterm's own
   * clear: everything but the cursor's line.
   */
  clear(): void {
    const stale = this.snapshot();
    const atPrompt = this.promptMarker !== undefined && this.commandMarker === undefined;
    if (atPrompt) {
      this.pendingStale = stale;
      this.awaitingRedraw = true;
      this.input.fire("\x0c");
      this.wipeDeadline = Date.now() + 1000;
      this.scheduleWipe();
      return;
    }
    // Windows: ConPTY keeps its own copy of the screen and doesn't know xterm moved the cursor
    // line to the top, so its next repaint put old lines back around a misplaced prompt. There,
    // a running command keeps its screen and only the scrollback goes (its marks with it).
    if (WINDOWS) {
      this.term.write("\x1b[3J");
      return;
    }
    this.term.clear();
    this.forget(stale, false);
  }

  private pendingStale: ReturnType<XtermRenderer["snapshot"]> | undefined;
  /** Ctrl+L was sent: each chunk of output pushes the wipe back until the redraw settles. */
  private awaitingRedraw = false;
  /** When the user last typed (output just after is the echo). */
  private lastInput = 0;
  /** The cursor is hidden by us while output streams. */
  private quietHidden = false;
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  /** The program hid the cursor itself (DECTCEM). */
  private appHidesCursor = false;
  /** The next DECTCEM parsed is ours: our writes carry a marker just before it (D244). */
  private ownCursorNext = false;

  /** Our marker (a private OSC no program sends), parsed in order with what follows it. */
  private ownMarker(): boolean {
    this.ownCursorNext = true;
    return true;
  }

  private trackCursorMode(params: (number | number[])[], hide: boolean): boolean {
    if (!params.includes(25)) return false;
    if (this.ownCursorNext) {
      this.ownCursorNext = false;
      return false;
    }
    this.appHidesCursor = hide;
    // The program shows the cursor while we hide it for streaming output (ConPTY wraps each of
    // its repaints in hide … show): it shows once the output pauses (showCursorAgain). Only a
    // sequence that's exactly ?25h: one setting other modes too goes through as it is.
    if (!hide && this.quietHidden && params.length === 1) return true;
    // Otherwise xterm applies the mode as usual.
    return false;
  }

  private showCursorAgain(): void {
    clearTimeout(this.quietTimer);
    if (!this.quietHidden) return;
    this.quietHidden = false;
    if (this.appHidesCursor) return;
    this.term.write(`${OWN_CURSOR_MARK}\x1b[?25h`);
  }

  private snapshot(): {
    prompts: { dispose(): void; isDisposed: boolean }[];
    tracker: ReturnType<CommandTracker["snapshot"]> | undefined;
  } {
    return { prompts: [...this.promptMarkers], tracker: this.commands?.snapshot() };
  }

  /** A timer owned by this renderer (cleared on dispose). */
  private later(fn: () => void, ms = 0): void {
    clearTimeout(this.wipeTimer);
    this.wipeTimer = setTimeout(() => {
      this.wipeTimer = undefined;
      if (!this.store.isDisposed) fn();
    }, ms);
  }

  private scheduleWipe(): void {
    const stale = this.pendingStale ?? this.snapshot();
    this.later(
      () => {
        this.pendingStale = undefined;
        this.awaitingRedraw = false;
        this.wipe(stale);
      },
      Date.now() > this.wipeDeadline ? 0 : 120,
    );
  }

  /** The shell has cleared its screen: erase scrollback (in order with its output) and old marks. */
  private wipe(stale: ReturnType<XtermRenderer["snapshot"]>): void {
    this.term.write("\x1b[3J");
    this.forget(stale, true);
  }

  /** Disposes the marks made before a clear (dots, command marks); the prompt is marked again. */
  private forget(stale: ReturnType<XtermRenderer["snapshot"]>, rebase: boolean): void {
    for (const m of stale.prompts) m.dispose();
    this.promptMarkers = this.promptMarkers.filter((m) => !m.isDisposed);
    this.dot = undefined;
    if (this.promptMarker?.isDisposed) {
      this.promptMarker = rebase ? this.term.registerMarker(0) : undefined;
      if (this.promptMarker) this.promptMarkers.push(this.promptMarker);
    }
    if (stale.tracker) this.commands?.forget(stale.tracker, rebase);
  }

  setTheme(theme: TerminalTheme): void {
    this.theme = theme;
    this.term.options.theme = xtermTheme(theme);
    this.commands?.refresh();
  }

  setFontSize(size: number): void {
    if (this.term.options.fontSize !== size) this.term.options.fontSize = size;
    this.commands?.refresh();
  }

  setScrollbarSize(px: number): void {
    if (this.term.options.overviewRuler?.width !== px)
      this.term.options.overviewRuler = { width: px };
  }

  find(
    query: string,
    options: {
      previous?: boolean;
      caseSensitive?: boolean;
      regex?: boolean;
      incremental?: boolean;
    } = {},
  ): Promise<{ index: number; count: number }> {
    if (!query) {
      this.clearFind();
      return Promise.resolve({ index: 0, count: 0 });
    }
    const t = this.theme;
    // Results (index/count) are reported only with decorations on; xterm wants #RRGGBB.
    const hex = (...colors: (string | undefined)[]) =>
      colors.map((c) => /^#[0-9a-f]{6}/i.exec(c ?? "")?.[0]).find(Boolean) ?? t.foreground;
    const match = hex(t.ansi[3], t.ansi[11]);
    const decorations = {
      matchBackground: hex(t.ansi[8], t.selectionBackground),
      matchOverviewRuler: match,
      activeMatchBackground: match,
      activeMatchColorOverviewRuler: match,
    };
    return new Promise((resolve) => {
      let done = false;
      const sub = this.searchAddon.onDidChangeResults((r) => {
        if (done) return;
        done = true;
        sub.dispose();
        resolve({ index: r.resultIndex + 1, count: r.resultCount });
      });
      const search = {
        caseSensitive: options.caseSensitive ?? false,
        regex: options.regex ?? false,
        incremental: options.incremental ?? false,
        decorations,
      };
      let found = false;
      try {
        found = options.previous
          ? this.searchAddon.findPrevious(query, search)
          : this.searchAddon.findNext(query, search);
      } catch {
        found = false; // an invalid regex
      }
      // No results event (nothing changed): answer from the return value.
      setTimeout(() => {
        if (done) return;
        done = true;
        sub.dispose();
        resolve(found ? { index: 1, count: 1 } : { index: 0, count: 0 });
      }, 200);
    });
  }

  clearFind(): void {
    this.searchAddon.clearDecorations();
    this.term.clearSelection();
  }

  dispose(): void {
    clearTimeout(this.quietTimer);
    for (const t of this.relocateTimers.splice(0)) clearTimeout(t);
    this.store.dispose();
    this.term.dispose();
  }
}

function paint(el: HTMLElement, state: string, tip: string): void {
  el.classList.add("terminal-command-mark");
  el.classList.toggle("is-running", state === "running");
  el.classList.toggle("is-error", state === "error");
  el.classList.toggle("is-success", state === "success");
  setTooltip(el, tip);
}
