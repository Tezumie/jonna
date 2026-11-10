// Terminal instances: a pty (Rust) wired to a renderer (xterm.js) with flow control.
// The view shows the active instance; `ide://terminals` lists them all.
import { on } from "../../core/dom/index";
import { Emitter, type Event } from "../../core/events/index";
import { browserIpc } from "../../core/ipc/browser";
import { isTauri } from "../../core/ipc/invoke";
import {
  type ProfileSpec,
  type PtyAttached,
  type PtyHandlers,
  type PtyInfo,
  ptyIpc,
  type RunSpec,
} from "../../core/ipc/process";
import { appIpc } from "../../core/ipc/system";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { batch, type Signal, signal } from "../../core/reactive/index";
import { toHex, withAlpha } from "../../core/themes/color";
import { terminalSelection } from "../../core/themes/vscodeColors";
import type { ThemeService } from "../../workbench/theme";
import type { ClipboardHandlers, SyntaxColors } from "./features";
import type { SavedOutput } from "./persist";
import { msysToWindows } from "./profiles";
import {
  createTerminalRenderer,
  type GpuAcceleration,
  type TerminalLook,
  type TerminalRenderer,
  type TerminalTheme,
} from "./renderer";
import { type DetectedServer, ServerScanner } from "./servers";
import { terminalTitle, unescapeMark } from "./title";
import { commandInput } from "./typing";

/**
 * A size squeezed to almost nothing (a sash dragged shut, a minimized window, a panel not laid
 * out yet): not one to tell the shell, which would rewrap its screen to it.
 */
function tinySize(size: { cols: number; rows: number }): boolean {
  return size.cols < 10 || size.rows < 3;
}
export interface TerminalInstance {
  readonly id: number;
  readonly info: PtyInfo;
  /** The terminal profile it started with (D204); null for the default shell. */
  readonly profile: string | null;
  /** It showed the last session's output when it started (D204). */
  readonly restored: boolean;
  /** Its process came back after a page reload (process revival, m7.12): not a new shell. */
  readonly reattached: boolean;
  /** "pwsh · folder", or the name given with terminal.rename. */
  readonly title: Signal<string>;
  /** Name set by terminal.rename (null = automatic title). */
  readonly name: Signal<string | null>;
  /** Current folder as reported by shell integration (else the start folder). */
  readonly cwd: Signal<string>;
  /** A command finished (shell integration); the exit code if known. */
  readonly onDidFinishCommand: Event<number | undefined>;
  /** A typed command started running (shell integration's "executed" mark). */
  readonly onDidStartCommand: Event<void>;
  /** The shell drew its first prompt (shell integration); stays false without integration. */
  readonly promptReady: Signal<boolean>;
  /** What the program set with OSC 0/2 (for state; not shown as the tab title). */
  readonly processTitle: Signal<string>;
  readonly onBell: Event<void>;
  /** Its output as it arrives, decoded (escape codes included): extensions' execution read(). */
  readonly onDidWrite: Event<string>;
  readonly exitCode: Signal<number | null>;
  readonly element: HTMLElement;
  readonly renderer: TerminalRenderer;
  readonly store: DisposableStore;
  /** Fits the grid to its container and tells the pty (coalesced; see `refit` in create). */
  refit(): void;
  /** A program is running (a command started and hasn't ended, or the alternate screen). */
  busy(): boolean;
  /**
   * Types a command line and Enter for the user (D270: an Escape bash still holds is cancelled
   * first, or it ate the first letter).
   */
  typeCommand(command: string): Promise<void>;
}

/** Terminal colors and font from the design tokens (DESIGN.md §15.4). */
export function terminalThemeFromTokens(theme: ThemeService): TerminalTheme {
  const hex = (name: string, alpha?: number) => {
    const c = theme.color(name);
    // A missing token (broken imported theme) falls back to opaque black rather than failing.
    return toHex(c ? (alpha === undefined ? c : withAlpha(c, alpha)) : { r: 0, g: 0, b: 0, a: 1 });
  };
  const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
  return {
    foreground: hex("--fg-default"),
    background: hex("--bg-surface"),
    cursor: hex("--fg-default"),
    // As the editor's (D361): a picked color theme's own selection, else the accent's.
    selectionBackground:
      (theme.syntaxTheme && terminalSelection(theme.syntaxTheme.json)) ?? hex("--accent", 0.35),
    ansi: [
      ...names.map((n) => hex(`--terminal-ansi-${n}`)),
      ...names.map((n) => hex(`--terminal-ansi-bright-${n}`)),
    ],
  };
}

let build: Promise<number | null> | undefined;
/** The Windows build (ConPTY behavior differs by build), asked once; null elsewhere. */
function windowsBuild(): Promise<number | null> {
  if (!navigator.userAgent.includes("Windows") || !isTauri()) return Promise.resolve(null);
  build ??= appIpc
    .info()
    .then((i) => i.osBuild)
    .catch(() => null);
  return build;
}

export interface TerminalHooks {
  isMac: boolean;
  /** Extensions' links in a line of the terminal named `terminal` (D264). */
  extensionLinks?(
    line: string,
    terminal: string,
  ): Promise<{ startIndex: number; length: number; tooltip?: string; activate(): void }[]>;
  /** Variables extensions set for new terminals (D264); a terminal's own win over them. */
  extensionEnv?(): Record<string, string>;
  openUrl(url: string): void;
  isLocalUrl(url: string): boolean;
  /** An existing file for a path printed in a terminal whose folder is `cwd`, or null. */
  resolveFile(path: string, cwd: string): Promise<string | null>;
  openFile(path: string, line?: number, col?: number): void;
  clipboard: ClipboardHandlers;
  syntaxColors(): SyntaxColors | null;
  /** A command finished (shell integration): its text, exit code and how long it ran. */
  commandFinished?(
    terminal: number,
    command: string,
    exitCode: number | undefined,
    ms: number,
  ): void;
}

export interface TerminalAppearance extends TerminalLook {
  theme: TerminalTheme;
  fontFamily: string;
  fontSize: number;
  scrollbarSize: number;
  /** terminal.gpuAcceleration (D204). */
  gpuAcceleration?: GpuAcceleration;
}

/** How a new terminal starts besides its folder (D204). */
export interface TerminalStart {
  /** A terminal profile to start instead of the default shell. */
  profile?: ProfileSpec;
  /** The profile's name, kept for the state and the restored tab. */
  profileName?: string;
  /** The profile's tab color and icon (the tab's own win). */
  color?: string;
  icon?: string;
  /** The profile's name as a fixed tab title (VS Code's overrideName). */
  title?: string;
  /** Output of the last session, written (dim) before the shell starts (persist.ts). */
  restored?: string;
  /** What that output was saved as: kept when nothing runs in the new session (D253). */
  restoredFrom?: SavedOutput;
  /**
   * The process the previous page had (a reload, m7.12): taken back instead of starting a shell.
   * `snapshot` is its saved screen at output offset `since`, drawn as it was when the replay
   * starts there. Falls back to a new shell (with `restored`) when it's gone.
   */
  reattach?: { id: number; key: string; since?: number; snapshot?: string };
}

/** How long a reattach waits for the page's previous view of the terminal to let it go. */
const REATTACH_RETRIES = 8;
const REATTACH_RETRY_MS = 250;
/** Acks go out per this many parsed bytes (Rust pauses at 512 KiB unacknowledged)… */
const ACK_BATCH = 64 * 1024;
/** …or this long after the first unacknowledged write. */
const ACK_DELAY_MS = 15;

/** Takes a terminal back, retrying while a view about to be dropped still has it. */
async function attachWithRetry(attach: () => Promise<PtyAttached>): Promise<PtyAttached> {
  for (let i = 0; ; i++) {
    try {
      return await attach();
    } catch (err) {
      const busy = String(err instanceof Error ? err.message : err).includes("AlreadyAttached");
      if (!busy || i >= REATTACH_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, REATTACH_RETRY_MS));
    }
  }
}

export class TerminalService implements Disposable {
  readonly instances: Signal<readonly TerminalInstance[]> = signal<readonly TerminalInstance[]>([]);
  readonly activeId: Signal<number | null> = signal<number | null>(null);
  private readonly store = new DisposableStore();
  private readonly created = this.store.add(new Emitter<TerminalInstance>());
  readonly onDidCreate = this.created.event;
  private readonly written = this.store.add(new Emitter<{ id: number; text: string }>());
  /** Decoded output of every terminal as it arrives (escape codes included). */
  readonly onDidWrite = this.written.event;
  private readonly decoders = new Map<number, TextDecoder>();
  /**
   * Output offsets per terminal: bytes received, and bytes the renderer has parsed (what its
   * screen shows; saved with the screen so a reattach replays exactly what came after).
   */
  private readonly offsets = new Map<number, { received: number; parsed: number }>();
  /**
   * Parsed bytes not yet acknowledged, per terminal (D254): sent in batches, since each ack is an
   * IPC round trip (slow on WebView2) and a flood arrives in many writes. VS Code acks every
   * 5000 characters.
   */
  private readonly unacked = new Map<
    number,
    { bytes: number; timer: ReturnType<typeof setTimeout> | undefined }
  >();
  /** Terminals let go without being killed (`release`): a page may take them back. */
  private readonly released = new Set<number>();
  private readonly scanner = new ServerScanner();
  /** Local servers terminals printed (a dev server's URL, "listening on port …"), newest last. */
  readonly servers = signal<readonly DetectedServer[]>([]);
  private readonly serverFound = this.store.add(new Emitter<DetectedServer>());
  /** A terminal printed a local server address not seen before. */
  readonly onDidDetectServer = this.serverFound.event;

  get active(): TerminalInstance | undefined {
    const id = this.activeId.peek();
    return this.instances.peek().find((t) => t.id === id);
  }

  get(id: number): TerminalInstance | undefined {
    return this.instances.peek().find((t) => t.id === id);
  }

  /** Links, clipboard and colors for new terminals (set by the extension). */
  hooks: TerminalHooks | null = null;

  /** Spawns a shell in `cwd` (default: workspace root) rendered into a new element in `host`. */
  async create(
    cwd: string | null,
    host: HTMLElement,
    appearance: TerminalAppearance,
    shellIntegration = true,
    name: string | null = null,
    /** Progress for the "still starting" notice: which step a stuck start is waiting on. */
    onStage: (stage: string) => void = () => {},
    /** A task to run instead of an interactive shell (D134); the terminal ends with it. */
    run?: RunSpec,
    start: TerminalStart = {},
    /** Extra variables for the shell (a JavaScript debug terminal, D204). */
    env?: Record<string, string>,
  ): Promise<TerminalInstance> {
    const element = document.createElement("div");
    element.className = "terminal-instance";
    host.appendChild(element);
    const store = new DisposableStore();
    store.add(toDisposable(() => element.remove()));
    let cwdOf = () => cwd ?? "";
    // Its tab's title (extensions' link providers get it, as VS Code's terminal name).
    let nameOf = () => name ?? "";
    let startedId = 0;
    // A process taken back after a reload is let go, not killed, when this start fails.
    let reattachedId = 0;
    try {
      onStage("loading the terminal renderer");
      const renderer = store.add(
        await createTerminalRenderer({
          windowsBuild: (await windowsBuild()) ?? undefined,
          fontFamily: appearance.fontFamily,
          fontSize: appearance.fontSize,
          scrollbarSize: appearance.scrollbarSize,
          theme: appearance.theme,
          ...(appearance.cursorStyle && { cursorStyle: appearance.cursorStyle }),
          ...(appearance.cursorBlink !== undefined && { cursorBlink: appearance.cursorBlink }),
          ...(appearance.scrollback !== undefined && { scrollback: appearance.scrollback }),
          ...(appearance.lineHeight !== undefined && { lineHeight: appearance.lineHeight }),
          ...(appearance.gpuAcceleration && { gpuAcceleration: appearance.gpuAcceleration }),
          ...(this.hooks && {
            links: {
              isMac: this.hooks.isMac,
              openUrl: (url) => this.hooks?.openUrl(url),
              isLocalUrl: (url) => this.hooks?.isLocalUrl(url) ?? false,
              openFile: (path, line, col) => this.hooks?.openFile(path, line, col),
              // Relative to this terminal's current folder (shell integration keeps it).
              resolveFile: (path) =>
                this.hooks?.resolveFile(path, cwdOf()) ?? Promise.resolve(null),
              extensionLinks: (line) =>
                this.hooks?.extensionLinks?.(line, nameOf()) ?? Promise.resolve([]),
            },
            clipboard: this.hooks.clipboard,
            syntaxColors: () => this.hooks?.syntaxColors() ?? null,
          }),
        }),
      );
      renderer.open(element);
      // The shell starts at the size it will be shown at: a terminal created in a hidden tab
      // (restored, or opened behind another) waits a little for its first layout, instead of
      // starting at 80×24 and being resized at once — a resize makes ConPTY and full-screen
      // programs redraw, which drew Claude Code's banner twice (D192).
      await whenLaidOut(element, 1500);
      // Not yet laid out at a real size (a panel opening, a window mid-layout): it starts at the
      // default 80×24 rather than at the 2 columns it measures then — the shell would hard-wrap
      // everything it prints to 2 columns, which no later resize can undo.
      const first = renderer.propose();
      if (first && !tinySize(first)) renderer.fit();
      const title = signal("");
      const processTitle = signal("");
      const bell = store.add(new Emitter<void>());
      const finished = store.add(new Emitter<number | undefined>());
      const started = store.add(new Emitter<void>());
      const promptReady = signal(false);
      const nameSignal = signal<string | null>(name);
      const cwdSignal = signal("");
      cwdOf = () => cwdSignal.peek() || cwd || "";
      nameOf = () => nameSignal.peek() ?? title.peek();
      const exitCode = signal<number | null>(null);
      let id = 0;
      // Output that arrives before spawn() resolves (fast prompts) is buffered, not lost.
      const early: Uint8Array[] = [];
      onStage(`starting the shell (${renderer.size.cols}×${renderer.size.rows})`);
      // VS Code's task terminals say what runs, and how it ended.
      const dim = (text: string) => new TextEncoder().encode(`\x1b[2m${text}\x1b[0m\r\n`);
      // Each start attempt has its own handlers, and only the current one's events count: a
      // first start that timed out and then came up late is killed by Rust, and its output and
      // exit must not land in (or end) the terminal of the retry.
      let attempt = 0;
      let spawnedAt = { ...renderer.size };
      const handlersFor = (mine: number): PtyHandlers => ({
        onData: (bytes) => {
          if (mine !== attempt) return;
          if (id === 0) early.push(bytes);
          else this.write(id, renderer, bytes);
        },
        onExit: (code) => {
          if (mine !== attempt) return;
          exitCode.value = code;
          this.forgetServers(id);
          if (run) {
            renderer.write(
              dim(
                `\r\n *  The terminal process terminated with exit code: ${code}.\r\n *  Terminal will be reused by tasks, press any key to close it.`,
              ),
            );
            return;
          }
          const notice = `\r\n\x1b[2m[Process exited with code ${code}]\x1b[0m\r\n`;
          renderer.write(new TextEncoder().encode(notice));
        },
      });
      const spawn = () => {
        const mine = ++attempt;
        spawnedAt = { ...renderer.size };
        // Extensions' variables for new terminals (VS Code's environment collections, D264),
        // under the terminal's own.
        const fromExtensions = this.hooks?.extensionEnv?.() ?? {};
        const allEnv = Object.keys(fromExtensions).length ? { ...fromExtensions, ...env } : env;
        return ptyIpc.spawn(
          cwd,
          renderer.size.cols,
          renderer.size.rows,
          handlersFor(mine),
          run ? false : shellIntegration,
          run,
          run ? undefined : start.profile,
          allEnv,
        );
      };
      // After a page reload: the process the previous page had, if it's still there (VS Code's
      // process revival); else a new shell below the saved output, as after a restart.
      const revived =
        start.reattach && !run
          ? await this.reattach(start.reattach, renderer, element, handlersFor(++attempt), store)
          : null;
      if (start.reattach && !revived) attempt++; // a late reply of the failed attach is ignored
      let firstOffset = 0;
      let info: PtyInfo;
      if (revived) {
        info = revived.info;
        firstOffset = revived.from;
        spawnedAt = { ...renderer.size };
      } else {
        // The last session's output, dim, above the new shell (VS Code's persistent sessions).
        if (start.restored) renderer.writeRestored(start.restored);
        if (run)
          renderer.write(
            dim(` *  Executing task: ${[run.command, ...(run.args ?? [])].join(" ")}\r\n`),
          );
        // A start that timed out (seen now and then on Windows) usually works the second time.
        info = await spawn().catch((err: unknown) => {
          if (!String(err instanceof Error ? err.message : err).includes("StartTimeout")) throw err;
          onStage("retrying the shell start");
          return spawn();
        });
      }
      id = info.id;
      startedId = id;
      reattachedId = revived ? id : 0;
      this.offsets.set(id, { received: firstOffset, parsed: firstOffset });
      renderer.setShellNonce(info.nonce ?? null);
      for (const chunk of early.splice(0)) this.write(id, renderer, chunk);
      // The view may have been resized while the shell started: the pty gets today's size.
      const sized = renderer.size;
      if (sized.cols !== spawnedAt.cols || sized.rows !== spawnedAt.rows)
        void ptyIpc.resize(id, sized.cols, sized.rows).catch(() => {});
      // Tab title: shell and folder ("pwsh · ide"), never a raw executable path (DESIGN.md §12.3).
      cwdSignal.value = info.cwd;
      const retitle = () =>
        (title.value = nameSignal.peek() ?? terminalTitle(info.shell, cwdSignal.peek()));
      retitle();
      // A command already running when the terminal came back (a dev server): it's busy.
      let commandStarted = revived?.running ? Date.now() : 0;
      store.add(
        renderer.onShellMark(({ kind, arg }) => {
          if (kind === "A" || kind === "B") promptReady.value = true;
          if (kind === "C") {
            commandStarted = Date.now();
            started.fire();
          }
          if (kind === "D") {
            const code = Number.parseInt(arg, 10);
            const exit = Number.isFinite(code) ? code : undefined;
            renderer.decoratePrompt(exit);
            if (commandStarted) {
              const ms = Date.now() - commandStarted;
              commandStarted = 0;
              this.hooks?.commandFinished?.(id, renderer.lastCommand()?.command ?? "", exit, ms);
            }
            this.forgetServers(id);
            finished.fire(exit);
          } else if (kind === "P" && arg.startsWith("Cwd=")) {
            const dir = unescapeMark(arg.slice(4));
            // Git Bash says `/c/Users/me`; the IDE works with `C:\Users\me`.
            cwdSignal.value = info.msys ? msysToWindows(dir) : dir;
            retitle();
          }
        }),
      );
      // The last keys sent, for typeCommand (a lone Escape bash still holds).
      let lastInput = "";
      store.add(
        renderer.onInput((data) => {
          lastInput = data;
          void ptyIpc.write(id, data).catch(() => {});
        }),
      );
      store.add(renderer.onTitle((t) => (processTitle.value = t)));
      store.add(renderer.onBell(() => bell.fire()));
      store.add(
        toDisposable(() => {
          // Let go (`release`): it waits for a page to take it back; otherwise it ends.
          if (this.released.delete(id)) void ptyIpc.detach(id).catch(() => {});
          else if (exitCode.peek() === null) void ptyIpc.kill(id).catch(() => {});
          this.forgetServers(id);
          this.decoders.delete(id);
          this.offsets.delete(id);
          clearTimeout(this.unacked.get(id)?.timer);
          this.unacked.delete(id);
        }),
      );
      // Fit to the container on resize (coalesced per frame) and tell the pty. VS Code's rule:
      // a column change reflows the whole buffer (and ConPTY repaints its screen, which drew
      // lines twice when it happened on every step of a drag), so with a big buffer columns
      // apply once the resize pauses; rows apply at once. A hidden terminal waits until shown.
      let frame = 0;
      let columns: ReturnType<typeof setTimeout> | undefined;
      // A container squeezed to almost nothing (a sash dragged shut, a minimized window) is
      // not a size to tell the shell: ConPTY would rewrap its copy of the screen to it and
      // redraw it mangled once restored. The last real size stays.
      const tiny = tinySize;
      const apply = () => {
        if (element.offsetParent === null) return;
        const proposed = renderer.propose();
        if (!proposed || tiny(proposed)) return;
        const size = renderer.fit();
        if (size) void ptyIpc.resize(id, size.cols, size.rows).catch(() => {});
      };
      const refit = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (element.offsetParent === null) return; // hidden
          const next = renderer.propose();
          const now = renderer.size;
          if (!next || tiny(next) || (next.cols === now.cols && next.rows === now.rows)) return;
          clearTimeout(columns);
          // A program running (Claude Code, vim, a dev server's live screen) redraws on every
          // resize: rows and columns both apply once the resize settles, not on each frame of a
          // drag (D192). At the prompt, rows apply at once.
          const busy = commandStarted > 0 || renderer.inAltBuffer;
          if (busy || (next.cols !== now.cols && renderer.bufferLength > 200))
            columns = setTimeout(apply, busy ? 120 : 100);
          else apply();
        });
      };
      const observer = new ResizeObserver(refit);
      observer.observe(element);
      store.add(
        toDisposable(() => {
          observer.disconnect();
          cancelAnimationFrame(frame);
          clearTimeout(columns);
        }),
      );

      const instance: TerminalInstance = {
        id,
        info,
        profile: start.profileName ?? null,
        restored: !revived && !!start.restored,
        reattached: !!revived,
        title,
        name: nameSignal,
        cwd: cwdSignal,
        onDidFinishCommand: finished.event,
        onDidStartCommand: started.event,
        promptReady,
        processTitle,
        onBell: bell.event,
        onDidWrite: (listener) =>
          this.onDidWrite((written) => {
            if (written.id === id) listener(written.text);
          }),
        exitCode,
        element,
        renderer,
        store,
        refit,
        // Without shell integration (WSL, cmd.exe) there are no command marks: whatever runs
        // there is treated as a program.
        busy: () => !info.integration || commandStarted > 0 || renderer.inAltBuffer,
        typeCommand: (command) => {
          const text = commandInput(command, lastInput, info.shell);
          lastInput = "";
          return ptyIpc.write(id, text);
        },
      };
      // Shift+Enter in a running program (Claude Code, Codex): a new line, not "send" — the
      // ESC + CR sequence those CLIs read as Alt+Enter (D192). At the prompt it stays Enter.
      store.add(
        on(
          element,
          "keydown",
          (e) => {
            if (e.key !== "Enter" || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
            if (!instance.busy()) return;
            e.preventDefault();
            e.stopPropagation();
            void ptyIpc.write(id, "\x1b\r").catch(() => {});
          },
          { capture: true },
        ),
      );
      // The theme changed while this terminal started (a color theme applied at startup).
      if (this.theme && this.themeKey !== JSON.stringify(appearance.theme))
        renderer.setTheme(this.theme);
      // terminal.gpuAcceleration changed while it started: it wasn't in the list to be told.
      if (this.gpu && this.gpu !== (appearance.gpuAcceleration ?? "auto"))
        void renderer.setGpuAcceleration(this.gpu);
      batch(() => {
        this.instances.value = [...this.instances.peek(), instance];
        this.activeId.value = id;
      });
      this.created.fire(instance);
      return instance;
    } catch (err) {
      store.dispose();
      // Started but not wired up: its shell mustn't live on unseen. One taken back after a
      // reload is let go instead: the view that does show it can still take it.
      if (reattachedId) void ptyIpc.detach(reattachedId).catch(() => {});
      else if (startedId) void ptyIpc.kill(startedId).catch(() => {});
      throw err;
    }
  }

  /** Writes output and acknowledges it once painted (pty flow control). */
  private write(id: number, renderer: TerminalRenderer, bytes: Uint8Array): void {
    const offset = this.offsets.get(id);
    if (offset) offset.received += bytes.length;
    const end = offset?.received ?? 0;
    renderer.write(bytes, () => {
      if (offset) offset.parsed = end;
      this.ack(id, bytes.length);
    });
    let decoder = this.decoders.get(id);
    if (!decoder) {
      decoder = new TextDecoder();
      this.decoders.set(id, decoder);
    }
    const text = decoder.decode(bytes, { stream: true });
    if (!text) return;
    this.written.fire({ id, text });
    const found = this.scanner.scan(id, text);
    for (const f of found) void this.confirmServer(id, f.url, f.port);
  }

  /** At once past ACK_BATCH bytes, else a moment later (what's left of a flood, a keystroke). */
  private ack(id: number, bytes: number): void {
    let entry = this.unacked.get(id);
    if (!entry) {
      entry = { bytes: 0, timer: undefined };
      this.unacked.set(id, entry);
    }
    entry.bytes += bytes;
    const flush = () => {
      const e = this.unacked.get(id);
      if (!e?.bytes) return;
      clearTimeout(e.timer);
      e.timer = undefined;
      const n = e.bytes;
      e.bytes = 0;
      void ptyIpc.ack(id, n).catch(() => {});
    };
    if (entry.bytes >= ACK_BATCH) flush();
    else entry.timer ??= setTimeout(flush, ACK_DELAY_MS);
  }

  private readonly probing = new Set<number>();
  /** Ports that weren't listening when printed (an echoed URL): not probed again for a while. */
  private readonly rejected = new Map<number, number>();

  /**
   * A printed address counts once something listens on its port (a server prints before it
   * listens, so it's tried for a few seconds); an echoed URL never becomes a server.
   */
  private async confirmServer(id: number, url: string, port: number): Promise<void> {
    const known = this.servers.peek();
    if (known.some((k) => k.terminalId === id && k.port === port) || this.probing.has(port)) return;
    if ((this.rejected.get(port) ?? 0) > Date.now()) return;
    this.probing.add(port);
    try {
      for (const wait of [0, 400, 1000, 2000, 4000]) {
        if (wait) await new Promise((r) => setTimeout(r, wait));
        if (!(await browserIpc.portOpen(port).catch(() => false))) continue;
        const entry: DetectedServer = { url, port, terminalId: id, time: Date.now() };
        this.servers.value = [...this.servers.peek().filter((k) => k.port !== port), entry];
        this.serverFound.fire(entry);
        this.watchServers();
        return;
      }
      this.rejected.set(port, Date.now() + 15000);
    } finally {
      this.probing.delete(port);
    }
  }

  private sweepTimer = 0;
  private sweeping = false;

  /** Every few seconds while servers are listed: drop the ones that stopped listening. */
  private watchServers(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = window.setInterval(async () => {
      const list = this.servers.peek();
      if (!list.length) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = 0;
        return;
      }
      if (this.sweeping) return;
      this.sweeping = true;
      try {
        const open = await Promise.all(
          list.map((s) => browserIpc.portOpen(s.port).catch(() => true)),
        );
        const dead = new Set(list.filter((_, i) => !open[i]).map((s) => s.port));
        // Servers found while probing stay (only the ones probed dead go).
        if (dead.size) this.servers.value = this.servers.peek().filter((s) => !dead.has(s.port));
      } finally {
        this.sweeping = false;
      }
    }, 5000);
  }

  /** The terminal's command ended or the shell exited: its servers are gone. */
  private forgetServers(id: number): void {
    this.scanner.forget(id);
    const left = this.servers.peek().filter((srv) => srv.terminalId !== id);
    if (left.length !== this.servers.peek().length) this.servers.value = left;
  }

  /** Gives a terminal a fixed name (null = back to "shell · folder"). */
  rename(id: number, name: string | null): void {
    const t = this.get(id);
    if (!t) return;
    t.name.value = name?.trim() || null;
    t.title.value = t.name.peek() ?? terminalTitle(t.info.shell, t.cwd.peek());
  }

  activate(id: number): void {
    if (this.get(id)) this.activeId.value = id;
  }

  /** Re-themes every terminal when the colors actually changed (not on density/panel changes). */
  setTheme(theme: TerminalTheme): void {
    const key = JSON.stringify(theme);
    if (key === this.themeKey) return;
    this.themeKey = key;
    this.theme = theme;
    for (const t of this.instances.peek()) t.renderer.setTheme(theme);
  }
  private themeKey = "";
  /** The latest theme (a terminal still starting when it changed takes it once it's up). */
  private theme: TerminalTheme | null = null;

  /** Live font size change (terminal.fontSize): refits each terminal and resizes its pty. */
  setScrollbarSize(px: number): void {
    for (const t of this.instances.peek()) t.renderer.setScrollbarSize(px);
  }

  setFontSize(size: number): void {
    for (const t of this.instances.peek()) {
      t.renderer.setFontSize(size);
      t.refit();
    }
  }

  /** terminal.gpuAcceleration, live: WebGL or the DOM renderer for every terminal. */
  setGpuAcceleration(mode: GpuAcceleration): void {
    this.gpu = mode;
    for (const t of this.instances.peek()) void t.renderer.setGpuAcceleration(mode);
  }
  /** The last terminal.gpuAcceleration applied (terminals still starting catch up to it). */
  private gpu: GpuAcceleration | null = null;

  /** Cursor, scrollback, font family and line height from settings, live. */
  setLook(look: TerminalLook): void {
    for (const t of this.instances.peek()) {
      t.renderer.setOptions(look);
      t.refit();
    }
  }

  /** Kills the process and removes the instance. */
  kill(id: number): void {
    const instance = this.get(id);
    if (!instance) return;
    const remaining = this.instances.peek().filter((t) => t !== instance);
    batch(() => {
      this.instances.value = remaining;
      if (this.activeId.peek() === id)
        this.activeId.value = remaining[remaining.length - 1]?.id ?? null;
    });
    instance.store.dispose();
  }

  killAll(): void {
    for (const t of [...this.instances.peek()]) this.kill(t.id);
  }

  /**
   * Removes the instance without ending its process (m7.12): a view dropped before it was shown
   * while a reload restores the layout. Rust keeps it for a page to take back, then ends it.
   */
  release(id: number): void {
    if (!this.get(id)) return;
    this.released.add(id);
    this.kill(id);
  }

  /** The output offset terminal `id`'s screen reflects (saved with it for a reattach). */
  outputOffset(id: number): number | null {
    return this.offsets.get(id)?.parsed ?? null;
  }

  /**
   * Takes back the process a reloaded page's previous view had: its saved screen, then what it
   * printed since (Rust's replay), then the live output. Null when it's gone (a new shell then).
   */
  private async reattach(
    target: NonNullable<TerminalStart["reattach"]>,
    renderer: TerminalRenderer,
    element: HTMLElement,
    handlers: PtyHandlers,
    store: DisposableStore,
  ): Promise<PtyAttached | null> {
    // A tab that isn't on screen keeps the console's size (and draws at it) until it's shown.
    const shown = element.offsetParent !== null && element.clientWidth > 0;
    let attached: PtyAttached;
    try {
      attached = await attachWithRetry(() =>
        ptyIpc.attach(
          target.id,
          target.key,
          target.since ?? null,
          shown ? renderer.size : null,
          handlers,
        ),
      );
    } catch {
      return null;
    }
    if (!shown) renderer.resizeTo(attached.cols, attached.rows);
    // The saved screen goes first when the replay continues exactly from it.
    if (attached.complete && target.snapshot)
      renderer.write(new TextEncoder().encode(target.snapshot));
    // A program drawing its own screen (or a replay that starts mid-way) is redrawn: a size
    // change makes ConPTY repaint and full-screen programs redraw (rows - 1, then back).
    if (shown && (attached.running || !attached.complete) && attached.rows > 3) {
      const { cols, rows } = renderer.size;
      void ptyIpc.resize(target.id, cols, rows - 1).catch(() => {});
      const back = setTimeout(() => void ptyIpc.resize(target.id, cols, rows).catch(() => {}), 150);
      store.add(toDisposable(() => clearTimeout(back)));
    }
    return attached;
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    this.killAll();
    this.store.dispose();
  }
}

/** Resolves once `element` has a size on screen, or after `maxMs` (a tab that stays hidden). */
function whenLaidOut(element: HTMLElement, maxMs: number): Promise<void> {
  const shown = () => element.offsetParent !== null && element.clientWidth > 0;
  if (shown()) return Promise.resolve();
  return new Promise((done) => {
    const started = Date.now();
    const check = () => {
      if (shown() || Date.now() - started > maxMs) done();
      else setTimeout(check, 50);
    };
    setTimeout(check, 50);
  });
}
