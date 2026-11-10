// Terminal behavior on top of xterm, VS Code style and a bit beyond:
//  - links: web addresses and file paths (`src/app.ts:12:5`, `./x.py(3,1)`) — pointer, underline,
//    a tooltip naming the action, Ctrl/Cmd+click to follow;
//  - clipboard keys: Ctrl/Cmd+C copies when text is selected (else it interrupts, as always),
//    Ctrl/Cmd+V pastes, Ctrl+Shift+C/V too;
//  - commands (shell integration): each command line colored with the editor theme's syntax
//    colors (program, flags, strings, variables, paths), a sticky line at the top with the command
//    whose output is on screen, and "copy last command / output".
// `tokenizeCommand` and `pathLinksIn` are DOM-free and tested.
import { h, on } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { correctedCommandLine, stickyApplies } from "./commandLine";
import { unescapeMark } from "./title";

type Xterm = import("@xterm/xterm").Terminal;
type Marker = import("@xterm/xterm").IMarker;

// ---- Command tokens -------------------------------------------------------------------------

export type TokenKind = "program" | "flag" | "string" | "variable" | "path" | "operator" | "number";

export interface Token {
  start: number;
  end: number;
  kind: TokenKind;
}

/** Splits a shell command line into colored tokens (a light tokenizer, not a parser). */
export function tokenizeCommand(line: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let expectProgram = true;
  while (i < line.length) {
    const c = line[i] ?? "";
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (c === '"' || c === "'") {
      const close = line.indexOf(c, i + 1);
      i = close < 0 ? line.length : close + 1;
      out.push({ start, end: i, kind: "string" });
      expectProgram = false;
      continue;
    }
    if (/[|&;<>()]/.test(c)) {
      while (i < line.length && /[|&;<>()]/.test(line[i] ?? "")) i++;
      out.push({ start, end: i, kind: "operator" });
      // After a pipe or `&&`, a new command starts.
      expectProgram = /[|&;(]/.test(line.slice(start, i));
      continue;
    }
    while (i < line.length && !/[\s|&;<>()"']/.test(line[i] ?? "")) i++;
    const word = line.slice(start, i);
    if (/^[A-Za-z_][\w]*=/.test(word) && expectProgram) {
      out.push({ start, end: i, kind: "variable" });
      continue;
    }
    const kind: TokenKind = expectProgram
      ? "program"
      : word.startsWith("-")
        ? "flag"
        : word.startsWith("$")
          ? "variable"
          : /^\d+(\.\d+)?$/.test(word)
            ? "number"
            : /[/\\]|^\.|^~/.test(word)
              ? "path"
              : "path";
    if (kind === "path" && !/[/\\.~]/.test(word)) {
      expectProgram = false;
      continue; // plain words stay uncolored
    }
    out.push({ start, end: i, kind });
    expectProgram = false;
  }
  return out;
}

// ---- Links ----------------------------------------------------------------------------------

const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>`)\]}]+/g;
/** `path/to/file.ext`, optionally `:line(:col)` or `(line,col)`. */
const PATH_IN_TEXT =
  /(?:^|[\s"'`(=[])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|[\\/])?(?:[\w@.+-]+[\\/])*[\w@+-]+\.[A-Za-z][\w]{0,9})(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))?/g;

/**
 * A printed `~/path` (and `~\path` on Windows) in the home folder, as shells read it; other paths,
 * `~user/…`, and any path when the home folder is unknown come back unchanged.
 */
export function expandHomePath(path: string, home: string | null, windows: boolean): string {
  if (!home || !(path.startsWith("~/") || (windows && path.startsWith("~\\")))) return path;
  const sep = windows ? "\\" : "/";
  const base = home.replace(/[\\/]+$/, "");
  const rest = path.slice(2).replace(/^[\\/]+/, "");
  return `${base}${sep}${windows ? rest.replace(/\//g, "\\") : rest}`;
}

/**
 * A path a shell inside WSL printed (D229), as Windows sees it: `~/x` in the distribution's home
 * (`wslHome`, `\\wsl.localhost\<distro>\home\me`), `/etc/x` under `\\wsl.localhost\<distro>`.
 * Relative paths and `~user/…` come back unchanged.
 */
export function wslPathToWindows(path: string, distro: string, wslHome: string | null): string {
  if (path.startsWith("~/")) return wslHome ? expandHomePath(path, wslHome, true) : path;
  if (!path.startsWith("/") || path.startsWith("//")) return path;
  return `\\\\wsl.localhost\\${distro}${path.replace(/\/+$/, "").replace(/\//g, "\\")}`;
}

/** File-path candidates in a terminal line: [column, length, path, line?, col?]. */
export function pathLinksIn(
  text: string,
): { x: number; length: number; path: string; line?: number; col?: number }[] {
  const out: { x: number; length: number; path: string; line?: number; col?: number }[] = [];
  for (const m of text.matchAll(PATH_IN_TEXT)) {
    const path = m[1] ?? "";
    if (!path || /^https?:/.test(path) || /^\d+(\.\d+)+$/.test(path)) continue;
    const whole = m[0];
    const lead = whole.indexOf(path);
    const x = (m.index ?? 0) + lead;
    const tail = whole.slice(lead + path.length);
    const line = Number(m[2] ?? m[4]) || undefined;
    const col = Number(m[3] ?? m[5]) || undefined;
    out.push({
      x,
      length: path.length + tail.length,
      path,
      ...(line && { line }),
      ...(col && { col }),
    });
  }
  return out;
}

export interface LinkHandlers {
  isMac: boolean;
  openUrl(url: string): void;
  /** Absolute path of a file the terminal printed (relative to its cwd), or null. */
  resolveFile(path: string): Promise<string | null>;
  openFile(path: string, line?: number, col?: number): void;
  isLocalUrl(url: string): boolean;
  /** Extensions' links in a line (D264): 0-based start, length, what a click does. */
  extensionLinks?(
    line: string,
  ): Promise<{ startIndex: number; length: number; tooltip?: string; activate(): void }[]>;
}

/** A small hover label near the pointer (xterm links can't carry our data-tooltip). */
class HoverTip {
  private el: HTMLElement | null = null;
  private timer = 0;
  show(e: MouseEvent, text: string): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.hide();
      this.el = h("div", { class: "tooltip terminal-link-tip", role: "tooltip" }, text);
      document.body.append(this.el);
      const r = this.el.getBoundingClientRect();
      const left = Math.min(e.clientX + 8, window.innerWidth - r.width - 4);
      const top =
        e.clientY + 18 + r.height > window.innerHeight ? e.clientY - r.height - 8 : e.clientY + 18;
      this.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    }, 350);
  }
  hide(): void {
    clearTimeout(this.timer);
    this.el?.remove();
    this.el = null;
  }
}

/**
 * The URLs of the wrapped line row `y` (1-based) belongs to, with their ranges across rows:
 * a URL wider than the terminal continues on the next rows (isWrapped).
 */
function wrappedUrls(
  term: Xterm,
  y: number,
): { url: string; range: import("@xterm/xterm").IBufferRange }[] {
  const buffer = term.buffer.active;
  let first = y - 1;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let last = y - 1;
  while (last + 1 < buffer.length && buffer.getLine(last + 1)?.isWrapped) last++;
  if (last - first > 40) return []; // a pathological line: not worth scanning on hover
  const cols = term.cols;
  let text = "";
  for (let row = first; row <= last; row++)
    text += buffer.getLine(row)?.translateToString(row === last) ?? "";
  const at = (i: number) => ({ x: (i % cols) + 1, y: first + Math.floor(i / cols) + 1 });
  const out: { url: string; range: import("@xterm/xterm").IBufferRange }[] = [];
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    const start = m.index ?? 0;
    const range = { start: at(start), end: at(start + url.length - 1) };
    if (range.start.y <= y && range.end.y >= y) out.push({ url, range });
  }
  return out;
}

export function installLinks(term: Xterm, handlers: LinkHandlers, store: DisposableStore): void {
  const tip = new HoverTip();
  store.add({ dispose: () => tip.hide() });
  const mod = handlers.isMac ? "Cmd" : "Ctrl";
  const follow = (e: MouseEvent, run: () => void) => {
    if (e.ctrlKey || e.metaKey) {
      tip.hide();
      run();
    }
  };
  const lineText = (y: number) => term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
  // Links a program prints with OSC 8 (Claude Code's sign-in link, ls --hyperlink): followed with
  // Ctrl+click like the others. Without a handler xterm used window.open, which the IDE refuses
  // (D192).
  term.options.linkHandler = {
    activate: (e, uri) => follow(e, () => handlers.openUrl(uri)),
    hover: (e) => tip.show(e, `${mod} + click to follow link`),
    leave: () => tip.hide(),
    allowNonHttpProtocols: false,
  };
  store.add({
    dispose: () => {
      term.options.linkHandler = null;
    },
  });
  store.add(
    term.registerLinkProvider({
      provideLinks(y, callback) {
        const text = lineText(y);
        const links: import("@xterm/xterm").ILink[] = [];
        // Web links over the whole wrapped line: a long sign-in URL spans several rows, and a
        // link of its first row alone led to an error page (D192).
        for (const w of wrappedUrls(term, y)) {
          const url = w.url;
          const label = handlers.isLocalUrl(url)
            ? `${mod} + click to open in the IDE browser`
            : `${mod} + click to follow link`;
          links.push({
            range: w.range,
            text: url,
            decorations: { pointerCursor: true, underline: true },
            activate: (e) => follow(e, () => handlers.openUrl(url)),
            hover: (e) => tip.show(e, label),
            leave: () => tip.hide(),
          });
        }
        const candidates = pathLinksIn(text).filter(
          (p) => !links.some((l) => l.range.start.x - 1 <= p.x && p.x < l.range.end.x),
        );
        // Extensions' links in the line (VS Code's TerminalLinkProvider, D264), where no other
        // link is.
        const fromExtensions = handlers.extensionLinks?.(text) ?? Promise.resolve([]);
        const addExtensionLinks = (
          found: Awaited<ReturnType<NonNullable<LinkHandlers["extensionLinks"]>>>,
        ) => {
          for (const l of found) {
            const x = l.startIndex;
            if (links.some((o) => o.range.start.x - 1 < x + l.length && x < o.range.end.x))
              continue;
            const label = l.tooltip
              ? `${l.tooltip} (${mod} + click)`
              : `${mod} + click to follow link`;
            links.push({
              range: { start: { x: x + 1, y }, end: { x: x + l.length, y } },
              text: text.slice(x, x + l.length),
              decorations: { pointerCursor: true, underline: true },
              activate: (e) => follow(e, () => l.activate()),
              hover: (e) => tip.show(e, label),
              leave: () => tip.hide(),
            });
          }
        };
        if (!candidates.length) {
          void fromExtensions
            .catch(() => [])
            .then((found) => {
              addExtensionLinks(found);
              callback(links.length ? links : undefined);
            });
          return;
        }
        // Only paths that exist become links (checked when the line is hovered).
        void Promise.all(
          candidates.map((c) => handlers.resolveFile(c.path).catch(() => null)),
        ).then((found) => {
          candidates.forEach((c, i) => {
            const abs = found[i];
            if (!abs) return;
            const where = c.line ? `:${c.line}${c.col ? `:${c.col}` : ""}` : "";
            links.push({
              range: { start: { x: c.x + 1, y }, end: { x: c.x + c.length, y } },
              text: `${c.path}${where}`,
              decorations: { pointerCursor: true, underline: true },
              activate: (e) => follow(e, () => handlers.openFile(abs, c.line, c.col)),
              hover: (e) => tip.show(e, `${mod} + click to open file`),
              leave: () => tip.hide(),
            });
          });
          void fromExtensions
            .catch(() => [])
            .then((more) => {
              addExtensionLinks(more);
              callback(links.length ? links : undefined);
            });
        });
      },
    }),
  );
}

// ---- Clipboard keys -------------------------------------------------------------------------

export interface ClipboardHandlers {
  isMac: boolean;
  /** Windows: ConPTY already turns Ctrl+Backspace into word deletion for the shell. */
  isWindows?: boolean;
  read(): Promise<string>;
  write(text: string): Promise<void>;
  /** `terminal.copyOnSelection`: a finished selection goes to the clipboard. */
  copyOnSelection?(): boolean;
  /**
   * Text with line breaks is about to be pasted where the program didn't ask for bracketed
   * paste (each line would run as typed): true to go ahead (`terminal.multiLinePasteWarning`).
   */
  confirmPaste?(text: string): Promise<boolean>;
}

/** Pastes `text`, after asking when several lines would run one by one (VS Code's warning). */
export async function pasteChecked(
  term: Xterm,
  text: string,
  handlers: ClipboardHandlers,
): Promise<void> {
  if (!text) return;
  const lines = text.replace(/\r?\n$/, "").includes("\n");
  if (lines && !term.modes.bracketedPasteMode && handlers.confirmPaste) {
    if (!(await handlers.confirmPaste(text))) return;
  }
  term.paste(text);
}

/**
 * Ctrl/Cmd+C copies a selection (and clears it) instead of interrupting; without a selection
 * Ctrl+C still sends ^C. Ctrl/Cmd+V (Ctrl+Shift+V on Linux) pastes; Ctrl+Shift+C copies. Outside
 * Windows, Ctrl+Backspace / Ctrl+Delete delete a word (^W, Alt+D), as VS Code sends them; xterm
 * alone sends ^H, which deletes one character.
 */
export function installClipboardKeys(
  term: Xterm,
  handlers: ClipboardHandlers,
  store?: DisposableStore,
): void {
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const mod = handlers.isMac ? e.metaKey : e.ctrlKey;
    // By physical key, so Ctrl+C copies on Cyrillic, Greek… layouts too (e.key is "с" there).
    const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
    if (mod && !e.altKey && key === "c" && (e.shiftKey || term.hasSelection() || handlers.isMac)) {
      if (term.hasSelection()) {
        void handlers.write(term.getSelection());
        term.clearSelection();
      }
      e.preventDefault();
      return false;
    }
    // Linux: Ctrl+Shift+V pastes and Ctrl+V reaches the program (vim's visual block, the shell's
    // quoted insert), as in VS Code and Linux terminals; Windows and macOS paste on Ctrl/Cmd+V.
    const linux = !handlers.isMac && !handlers.isWindows;
    if (mod && !e.altKey && key === "v" && (!linux || e.shiftKey)) {
      e.preventDefault();
      void handlers.read().then((text) => pasteChecked(term, text, handlers));
      return false;
    }
    if (!handlers.isWindows && !handlers.isMac && e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (e.key === "Backspace") {
        e.preventDefault();
        term.input("\x17");
        return false;
      }
      if (e.key === "Delete") {
        e.preventDefault();
        term.input("\x1bd");
        return false;
      }
    }
    return true;
  });
  if (store && handlers.copyOnSelection) {
    // After the mouse is released (not on every drag step).
    let timer = 0;
    store.add(
      term.onSelectionChange(() => {
        clearTimeout(timer);
        timer = window.setTimeout(() => {
          if (handlers.copyOnSelection?.() && term.hasSelection())
            void handlers.write(term.getSelection());
        }, 150);
      }),
    );
    store.add({ dispose: () => clearTimeout(timer) });
  }
}

// ---- Commands: highlighting, sticky line, last command --------------------------------------

export interface CommandEntry {
  /** Numbered from 1 per terminal (actions on a command name it). */
  seq: number;
  prompt: Marker;
  /** The line the command was typed on (the prompt may span several lines). */
  input?: Marker;
  command: string;
  /** Output end (the next prompt), once finished. */
  end?: Marker;
  exitCode?: number;
  /** Where the command's colored tokens sit on the input line (for the sticky copy). */
  colored?: { x: number; width: number; color: string }[];
  /** Overview-ruler mark of the command (recolored when it finishes). */
  rulerMark?: import("@xterm/xterm").IDecoration;
  /** The marked line and where the command really is (correctedCommandLine), cached. */
  fixed?: { from: number; to: number };
}

const MAX_COMMANDS = 500;

/** Room left of the sticky line for the command's dot (the terminal's gutter). */
const STICKY_GUTTER = 14;

export interface SyntaxColors {
  program: string;
  flag: string;
  string: string;
  variable: string;
  path: string;
  operator: string;
  number: string;
}

/** Colors the sticky line and the overview ruler need from the terminal theme. */
export interface TrackerTheme {
  /** 16 ANSI colors (palette 0–15). */
  ansi: readonly string[];
  foreground: string;
  /** Overview ruler marks: commands, failed commands, error and warning lines. */
  ruler: { command: string; failed: string; error: string; warning: string };
}

const ERROR_LINE = /\b(error|failed|fatal|exception|ERR!)\b|✖|✗/i;
const WARNING_LINE = /\bwarn(ing)?\b/i;
/** Overview-ruler marks per command output (the ruler is a summary, not a log). */
const MAX_LINE_MARKS = 40;

let measured: { font: string; width: number } | undefined;
/** Advance width of a monospace glyph in `font` (cached). */
function glyphWidth(font: string): number {
  if (measured?.font === font) return measured.width;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return 0;
  ctx.font = font;
  measured = { font, width: ctx.measureText("W").width };
  return measured.width;
}

const CUBE = [0, 95, 135, 175, 215, 255];
const hex2 = (n: number) => n.toString(16).padStart(2, "0");

/** xterm 256-color palette entry (0–15 from the theme). */
export function paletteColor(i: number, ansi: readonly string[]): string | undefined {
  if (i < 16) return ansi[i];
  if (i < 232) {
    const n = i - 16;
    return `#${hex2(CUBE[Math.floor(n / 36)] ?? 0)}${hex2(CUBE[Math.floor((n % 36) / 6)] ?? 0)}${hex2(CUBE[n % 6] ?? 0)}`;
  }
  return `#${hex2(8 + (i - 232) * 10).repeat(3)}`;
}

/**
 * Follows shell-integration marks: A prompt, B input start, E command line, C executed, D done.
 * Colors each command line, keeps a sticky line, and answers "last command / output".
 */
/** Commands that clear the terminal (bash/zsh/fish, PowerShell, cmd). */
const CLEAR_COMMAND = /^(clear|cls|clear-host|reset|tput\s+(clear|reset))$/i;

export class CommandTracker {
  readonly commands: CommandEntry[] = [];
  private prompt: Marker | undefined;
  /** Where typing starts; `confirmed` once a keystroke showed the column (confirmInput). */
  private input: { marker: Marker; x: number; confirmed?: boolean } | undefined;
  private commandLine = "";
  /** The shell integration's secret (D192): command lines (E) without it are ignored. */
  nonce: string | null = null;
  private readonly sticky: HTMLElement;
  private readonly store = new DisposableStore();
  private stickyKey = "";
  private seq = 0;
  /** The entry the sticky line shows, if any. */
  shownSticky: CommandEntry | undefined;

  constructor(
    private readonly term: Xterm,
    private readonly colors: () => SyntaxColors | null,
    private readonly host: HTMLElement,
    private readonly theme: () => TrackerTheme,
    /** A typed `clear` ran: `requested` at its start, `done` once the next prompt began. */
    private readonly clears: { requested(): void; done(): void } = {
      requested: () => {},
      done: () => term.clear(),
    },
  ) {
    this.sticky = h("div", { class: "terminal-sticky", hidden: true, role: "button" });
    host.append(this.sticky);
    this.store.add({ dispose: () => this.sticky.remove() });
    this.store.add(on(this.sticky, "mousedown", (e) => e.preventDefault()));
    this.store.add(
      on(this.sticky, "click", () => {
        const entry = this.stickyEntry();
        if (!entry) return;
        const line = entry.input && !entry.input.isDisposed ? entry.input.line : entry.prompt.line;
        this.term.scrollToLine(Math.max(0, line));
        this.term.focus();
      }),
    );
    // Output at the bottom scrolls once per line; the sticky line follows once per frame. Per
    // line, a full scrollback moved the command's row on every line and each one read layout and
    // rebuilt the copy: a flood of output drew at a few dozen lines a second (D254).
    this.store.add(term.onScroll(() => this.scheduleSticky()));
    this.store.add(term.onRender(() => this.scheduleSticky()));
    this.store.add({ dispose: () => cancelAnimationFrame(this.stickyFrame) });
    this.store.add(term.onResize(() => this.updateSticky(true)));
  }

  private stickyFrame = 0;

  private scheduleSticky(): void {
    if (this.stickyFrame) return;
    this.stickyFrame = requestAnimationFrame(() => {
      this.stickyFrame = 0;
      this.updateSticky();
    });
  }

  /** The theme or font changed: redraw the sticky copy. */
  refresh(): void {
    this.updateSticky(true);
  }

  /** A `clear` / `cls` ran: once its prompt is back, clear like the Clear button (D116). */
  private clearPending = false;
  /**
   * A command started (C) before its line was known (D253): bash and PowerShell send the line (E)
   * when the command is done, and Windows 10's ConPTY can draw the typed text after the marks, so
   * the line read off the screen at C was empty and the command was never tracked (no sticky
   * line, no Fix with agent, no Rerun). E completes it.
   */
  private pending: { prompt: Marker; input?: Marker } | null = null;

  mark(kind: string, arg: string): void {
    const buf = this.term.buffer.active;
    if (kind === "A" && this.clearPending) {
      // The shell cleared its screen (Windows' ConPTY by scrolling it up, which left the old
      // lines, the sticky copy and the marks around): drop scrollback and the old marks now
      // that the new prompt has started; the prompt itself stays as drawn (D118, D120).
      this.clearPending = false;
      this.clears.done();
    }
    if (kind === "A") {
      this.pending = null;
      this.prompt = this.term.registerMarker(0);
      // A command line (E) belongs to the command before this prompt: PowerShell reports it
      // from history at the next prompt, which made the *next* command inherit it (a typed
      // `cls` cleared after the following command) (D118).
      this.commandLine = "";
    } else if (kind === "B") {
      const marker = this.term.registerMarker(0);
      if (marker) this.input = { marker, x: buf.cursorX };
    } else if (kind === "E") {
      // "E;<command line>[;<nonce>]": `;` inside the command arrives escaped as \x3b. Without
      // the session's nonce it was printed by something else: not a command line.
      const [line, nonce] = arg.split(";");
      if (this.nonce && nonce !== this.nonce) return;
      this.commandLine = unescapeMark(line ?? "");
      const pending = this.pending;
      const last = this.commands[this.commands.length - 1];
      if (pending) {
        // The command that started without a line (see `pending`): tracked now, with it.
        this.pending = null;
        const command = this.commandLine;
        this.commandLine = "";
        if (CLEAR_COMMAND.test(command.trim())) {
          this.clearPending = true;
          this.clears.requested();
        } else if (command.trim()) this.add(pending.prompt, command, pending.input);
      } else if (last && !last.end && this.commandLine.trim()) {
        // Still running (bash reports its line just before D): the shell's own line is truer
        // than what was read off the screen (a suggestion's grey text, a wrapped line).
        last.command = this.commandLine;
      }
    } else if (kind === "C") {
      const prompt = this.prompt;
      const command = this.commandLine || this.typedLine();
      if (CLEAR_COMMAND.test(command.trim())) {
        // Not a command worth a sticky line, colors or ruler marks.
        this.clearPending = true;
        this.clears.requested();
        this.commandLine = "";
        return;
      }
      const input = this.input && !this.input.marker.isDisposed ? this.input.marker : undefined;
      if (prompt && command.trim()) this.add(prompt, command, input);
      else if (prompt) {
        // No line yet: E brings it (`pending`).
        const previous = this.commands[this.commands.length - 1];
        if (previous && !previous.end) previous.end = prompt;
        this.pending = { prompt, ...(input && { input }) };
      }
      this.commandLine = "";
    } else if (kind === "D") {
      // Still no line (Windows 10's ConPTY can cut a long E mark into plain text): the typed
      // line, drawn by now.
      const pending = this.pending;
      if (pending) {
        this.pending = null;
        // Only a line the user typed: before a keystroke the column may be the prompt's start
        // (renderer.confirmInputStart), and the "command" would be the prompt.
        const typed = this.input?.confirmed ? this.typedLine() : "";
        if (typed.trim() && !CLEAR_COMMAND.test(typed.trim()))
          this.add(pending.prompt, typed, pending.input);
      }
      const last = this.commands[this.commands.length - 1];
      if (last && !last.end) {
        last.end = this.term.registerMarker(0);
        const code = Number.parseInt(arg, 10);
        if (Number.isFinite(code)) last.exitCode = code;
        if (last.rulerMark && code)
          last.rulerMark.options.overviewRulerOptions = {
            color: this.theme().ruler.failed,
            position: "left",
          };
        this.markOutput(last);
      }
    }
  }

  /** The user's first key at this prompt: typing starts at column `x` of `line`. */
  confirmInput(line: number, x: number): void {
    const input = this.input;
    if (!input || input.marker.isDisposed || line < input.marker.line) return;
    if (line === input.marker.line) {
      if (x > input.x) input.x = x;
      input.confirmed = true;
      return;
    }
    // The prompt was drawn after its mark, over several lines: typing starts at the cursor.
    const moved = this.term.registerMarker(0);
    if (!moved) return;
    input.marker.dispose();
    this.input = { marker: moved, x, confirmed: true };
  }

  /** A command that started at `prompt`: tracked, colored and marked beside the scrollbar. */
  private add(prompt: Marker, command: string, input: Marker | undefined): void {
    const previous = this.commands[this.commands.length - 1];
    if (previous && !previous.end) previous.end = prompt;
    const entry: CommandEntry = {
      seq: ++this.seq,
      prompt,
      command,
      ...(input && { input }),
    };
    this.commands.push(entry);
    if (this.commands.length > MAX_COMMANDS) this.commands.shift()?.rulerMark?.dispose();
    this.highlight(entry);
    this.rulerMark(entry);
  }

  /** The current prompt's marks, to tell them from ones a redraw adds later (see forget). */
  snapshot(): { prompt: Marker | undefined; input: Marker | undefined } {
    return { prompt: this.prompt, input: this.input?.marker };
  }

  /**
   * Forgets every command and its marks (gutter, colors, ruler) — the terminal was cleared. The
   * prompt's own marks go too only when they're from before the clear (`stale`); a prompt the
   * shell redrew since keeps its fresh ones. With `rebase`, a forgotten prompt is marked again at
   * the cursor's line, so the next command is still tracked.
   */
  forget(stale: { prompt: Marker | undefined; input: Marker | undefined }, rebase: boolean): void {
    for (const c of this.commands) {
      c.prompt.dispose();
      c.input?.dispose();
      c.end?.dispose();
      c.rulerMark?.dispose();
    }
    this.commands.length = 0;
    this.pending = null;
    const inputX = this.input?.x;
    if (this.prompt && (this.prompt === stale.prompt || this.prompt.isDisposed)) {
      this.prompt.dispose();
      this.prompt = rebase ? this.term.registerMarker(0) : undefined;
    }
    if (this.input && (this.input.marker === stale.input || this.input.marker.isDisposed)) {
      this.input.marker.dispose();
      const marker = rebase && inputX !== undefined ? this.term.registerMarker(0) : undefined;
      this.input = marker && inputX !== undefined ? { marker, x: inputX } : undefined;
    }
    this.updateSticky(true);
  }

  /** What the user typed on the input line (when the shell sent no E mark). */
  private typedLine(): string {
    const input = this.input;
    if (!input || input.marker.isDisposed) return "";
    const line = this.term.buffer.active.getLine(input.marker.line);
    return line?.translateToString(true, input.x).trim() ?? "";
  }

  /** Colors the command where it was typed (single-line commands). */
  private highlight(entry: CommandEntry): void {
    const command = entry.command;
    const colors = this.colors();
    const input = this.input;
    if (!colors || !input || input.marker.isDisposed) return;
    const line = this.term.buffer.active.getLine(input.marker.line);
    const typed = line?.translateToString(true, input.x) ?? "";
    // Only when the screen shows exactly this command on one line (no wrap, no multi-line).
    const offset = typed.indexOf(command.trimStart());
    if (offset < 0 || input.x + offset + command.length > this.term.cols || command.includes("\n"))
      return;
    const base = input.x + offset;
    entry.colored = [];
    for (const t of tokenizeCommand(command.trimStart()).slice(0, 40)) {
      entry.colored.push({ x: base + t.start, width: t.end - t.start, color: colors[t.kind] });
      this.term.registerDecoration({
        marker: input.marker,
        x: base + t.start,
        width: t.end - t.start,
        foregroundColor: colors[t.kind],
        layer: "top",
      });
    }
  }

  /** A mark in the overview ruler (the scrollbar) for each command, like VS Code's. */
  private rulerMark(entry: CommandEntry): void {
    const marker = entry.input && !entry.input.isDisposed ? entry.input : entry.prompt;
    const mark = this.term.registerDecoration({
      marker,
      width: 1,
      layer: "bottom",
      overviewRulerOptions: { color: this.theme().ruler.command, position: "left" },
    });
    if (mark) {
      entry.rulerMark = mark;
      mark.onRender((el) => el.classList.add("terminal-ruler-only"));
    }
  }

  /** Error and warning lines of a finished command's output, marked in the overview ruler. */
  private markOutput(entry: CommandEntry): void {
    const end = entry.end;
    if (!end || end.isDisposed) return;
    const start = this.outputStart(entry, end.line);
    const buf = this.term.buffer.active;
    const { error, warning } = this.theme().ruler;
    let marks = 0;
    for (let y = start; y < end.line && marks < MAX_LINE_MARKS; y++) {
      const text = buf.getLine(y)?.translateToString(true) ?? "";
      const color = ERROR_LINE.test(text) ? error : WARNING_LINE.test(text) ? warning : null;
      if (!color) continue;
      const marker = this.term.registerMarker(y - (buf.baseY + buf.cursorY));
      if (!marker) continue;
      const mark = this.term.registerDecoration({
        marker,
        width: 1,
        layer: "bottom",
        overviewRulerOptions: { color, position: "right" },
      });
      mark?.onRender((el) => el.classList.add("terminal-ruler-only"));
      marks++;
    }
  }

  /**
   * The line a command was typed on, or -1 once it was trimmed off the top of the scrollback
   * (a long output: its end may still be there), or null when the command is gone altogether.
   */
  private lineOf(c: CommandEntry): number | null {
    const marked =
      c.input && !c.input.isDisposed
        ? c.input.line
        : !c.prompt.isDisposed
          ? c.prompt.line
          : c.end?.isDisposed
            ? null
            : -1;
    if (marked === null || marked < 0) return marked;
    const buf = this.term.buffer.active;
    const correct = () =>
      correctedCommandLine((y) => buf.getLine(y)?.translateToString(true), marked, c.command);
    // A running command's rows may still be redrawn (ConPTY), so it's checked each time (a few
    // rows read; a dev server runs for hours, D217). A finished one's rows only move when the
    // scrollback trims: once per marked line.
    if (!c.end) return correct();
    if (c.fixed?.from !== marked) c.fixed = { from: marked, to: correct() };
    return c.fixed?.to ?? marked;
  }

  /** The command whose output is at the top of the screen (its command line scrolled away). */
  private stickyEntry(): CommandEntry | undefined {
    const buffer = this.term.buffer.active;
    const top = buffer.viewportY;
    for (let i = this.commands.length - 1; i >= 0; i--) {
      const c = this.commands[i];
      if (!c) continue;
      const line = this.lineOf(c);
      if (line === null) return undefined;
      const end = !c.end || c.end.isDisposed ? undefined : c.end.line;
      if (stickyApplies({ line, top, end, alternateBuffer: buffer.type === "alternate" })) return c;
      if (line < top) return undefined;
    }
    return undefined;
  }

  /**
   * The sticky line is a copy of the command's own line — prompt, typed command, colors — drawn
   * on the terminal's background at the exact row position, so it reads as that line staying
   * put (VS Code's terminal sticky scroll).
   */
  private updateSticky(force = false): void {
    // VS Code's sticky scroll (D217): the running command's line stays at the top while its
    // output fills the screen, at the bottom too (D192 hid it there); a full-screen program in
    // the alternate buffer (vim, less) owns the screen (stickyApplies).
    const entry = this.stickyEntry();
    this.shownSticky = entry;
    if (!entry) {
      this.sticky.hidden = true;
      this.stickyKey = "";
      return;
    }
    const line = this.lineOf(entry) ?? -1;
    // Layout is read only when something it depends on changed (this runs on every render).
    const key = `${line}|${entry.exitCode ?? ""}|${entry.end ? 1 : 0}|${this.term.cols}|${this.term.rows}|${this.term.options.fontSize}|${this.term.options.lineHeight}`;
    if (force || key !== this.stickyKey) {
      const screen = this.term.element?.querySelector<HTMLElement>(".xterm-screen");
      // The DOM renderer's first row; the WebGL renderer (D204) has no rows: the screen's share.
      const row = this.term.element?.querySelector<HTMLElement>(".xterm-rows > div");
      if (!screen) return;
      const cellHeight =
        row?.getBoundingClientRect().height ??
        screen.getBoundingClientRect().height / this.term.rows;
      if (!cellHeight) return;
      const cellWidth = screen.getBoundingClientRect().width / this.term.cols;
      this.stickyKey = key;
      const host = this.host.getBoundingClientRect();
      const at = screen.getBoundingClientRect();
      // The sticky line starts in the gutter, so the command's dot shows there too.
      this.sticky.style.left = `${at.left - host.left - STICKY_GUTTER}px`;
      this.sticky.style.paddingLeft = `${STICKY_GUTTER}px`;
      this.sticky.style.top = `${at.top - host.top}px`;
      this.sticky.style.width = `${at.width}px`;
      this.sticky.style.height = `${cellHeight}px`;
      this.sticky.style.lineHeight = `${cellHeight}px`;
      const font = this.term.options;
      this.sticky.style.fontFamily = font.fontFamily ?? "monospace";
      this.sticky.style.fontSize = `${font.fontSize ?? 13}px`;
      this.sticky.classList.toggle("is-error", !!entry.exitCode);
      this.sticky.classList.toggle("is-success", !!entry.end && !entry.exitCode);
      const dot = h("span", {
        class: `terminal-sticky-dot ${entry.end ? (entry.exitCode ? "is-error" : "is-success") : "is-running"}`,
      });
      // A command line trimmed off the scrollback, or one the shell redrew blank since
      // (PowerShell's prompt redraw, a program that cleared it — D190: an empty sticky row with
      // just a dot covered the line under it): its text alone.
      const blank =
        line >= 0 && !this.term.buffer.active.getLine(line)?.translateToString(true).trim();
      this.sticky.replaceChildren(
        dot,
        ...(line < 0 || blank
          ? [h("span", null, entry.command)]
          : this.renderLine(line, cellWidth, entry.colored ?? [])),
      );
    }
    this.sticky.hidden = false;
  }

  /** One buffer line as spans with its colors, each cell exactly `cellWidth` wide. */
  private renderLine(
    y: number,
    cellWidth: number,
    colored: readonly { x: number; width: number; color: string }[],
  ): HTMLElement[] {
    const line = this.term.buffer.active.getLine(y);
    if (!line) return [];
    const theme = this.theme();
    const cell = this.term.buffer.active.getNullCell();
    const text = line.translateToString(true);
    const out: HTMLElement[] = [];
    let run: { style: string; chars: string; cells: number } | null = null;
    const font = `${this.term.options.fontSize ?? 13}px ${this.term.options.fontFamily ?? "monospace"}`;
    const spacing = cellWidth - glyphWidth(font);
    const flush = () => {
      if (!run) return;
      const span = h("span", null, run.chars);
      span.style.cssText = run.style;
      span.style.display = "inline-block";
      span.style.width = `${run.cells * cellWidth}px`;
      span.style.letterSpacing = `${spacing}px`;
      span.style.overflow = "hidden";
      out.push(span);
      run = null;
    };
    for (let x = 0; x < Math.min(this.term.cols, Math.max(text.length, 1)); x++) {
      const c = line.getCell(x, cell);
      if (!c) break;
      const width = c.getWidth();
      if (width === 0) continue;
      const fgIndex = c.isFgDefault() ? -1 : c.getFgColor();
      let fg = c.isFgRGB()
        ? `#${(fgIndex & 0xffffff).toString(16).padStart(6, "0")}`
        : fgIndex < 0
          ? ""
          : (paletteColor(c.isBold() && fgIndex < 8 ? fgIndex + 8 : fgIndex, theme.ansi) ?? "");
      const token = colored.find((t) => x >= t.x && x < t.x + t.width);
      if (token) fg = token.color;
      const bgIndex = c.isBgDefault() ? -1 : c.getBgColor();
      const bg = c.isBgRGB()
        ? `#${(bgIndex & 0xffffff).toString(16).padStart(6, "0")}`
        : bgIndex < 0
          ? ""
          : (paletteColor(bgIndex, theme.ansi) ?? "");
      let style = "";
      if (fg) style += `color:${fg};`;
      if (bg) style += `background:${bg};`;
      if (c.isBold()) style += "font-weight:600;";
      if (c.isItalic()) style += "font-style:italic;";
      if (c.isDim()) style += "opacity:.6;";
      if (c.isUnderline()) style += "text-decoration:underline;";
      const chars = c.getChars() || " ";
      if (!run || run.style !== style || width === 2) {
        flush();
        run = { style, chars: "", cells: 0 };
      }
      run.chars += chars;
      run.cells += width;
      if (width === 2) flush();
    }
    flush();
    return out;
  }

  /** The command typed on buffer line `y` (its input or prompt line), if any. */
  commandAtLine(y: number): CommandEntry | undefined {
    for (let i = this.commands.length - 1; i >= 0; i--) {
      const c = this.commands[i];
      if (!c || c.prompt.isDisposed) continue;
      const line = c.input && !c.input.isDisposed ? c.input.line : c.prompt.line;
      if (line === y || (c.prompt.line <= y && y < line)) return c;
      if (line < y) return undefined;
    }
    return undefined;
  }

  bySeq(seq: number): CommandEntry | undefined {
    return this.commands.find((c) => c.seq === seq && this.lineOf(c) !== null);
  }

  /** A command's text and output (plain), finished or still running. */
  details(c: CommandEntry): {
    command: string;
    output: string;
    exitCode?: number;
    finished: boolean;
    /** Its first lines were trimmed off the scrollback (or past the 20 000-line cap). */
    truncated?: boolean;
  } {
    const buf = this.term.buffer.active;
    const to = c.end && !c.end.isDisposed ? c.end.line : buf.baseY + buf.cursorY;
    const from = this.outputStart(c, to);
    // The end of a long output matters most (the error, the summary): keep the last lines.
    const start = Math.max(from, to - 20_000);
    const lines: string[] = [];
    for (let y = start; y < to; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? "");
    return {
      command: c.command,
      output: lines.join("\n").replace(/\s+$/, ""),
      ...(c.exitCode !== undefined && { exitCode: c.exitCode }),
      finished: !!c.end,
      ...((from === 0 || start > from) && { truncated: true }),
    };
  }

  /**
   * The first row of a command's output: after its line, and after the rows a command wider than
   * the terminal wrapped onto (they were counted as output, D254).
   */
  private outputStart(c: CommandEntry, to: number): number {
    const buf = this.term.buffer.active;
    let from = (this.lineOf(c) ?? -1) + 1;
    while (from > 0 && from < to && buf.getLine(from)?.isWrapped) from++;
    return from;
  }

  /** The line of the command before / after the viewport's top (Ctrl+Up / Down), or null. */
  neighbour(direction: -1 | 1): number | null {
    const top = this.term.buffer.active.viewportY;
    // A command line trimmed off the scrollback counts as the top (its output starts there).
    const lines = this.commands
      .map((c) => (c.prompt.isDisposed ? this.lineOf(c) : c.prompt.line))
      .filter((l): l is number => l !== null)
      .map((l) => Math.max(0, l))
      .sort((a, b) => a - b);
    if (direction < 0) {
      for (let i = lines.length - 1; i >= 0; i--)
        if ((lines[i] ?? 0) < top) return lines[i] ?? null;
      return null;
    }
    for (const l of lines) if (l > top) return l;
    return null;
  }

  /** The last finished command and its output (plain text). */
  last(): { command: string; output: string; exitCode?: number; truncated?: boolean } | null {
    for (let i = this.commands.length - 1; i >= 0; i--) {
      const c = this.commands[i];
      if (!c?.end || c.end.isDisposed || this.lineOf(c) === null) continue;
      const { finished: _, ...rest } = this.details(c);
      return rest;
    }
    return null;
  }

  dispose(): void {
    this.store.dispose();
  }
}
