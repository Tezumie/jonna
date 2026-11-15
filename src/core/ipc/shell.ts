// What the app's own window gives and no backend command does: window controls, native dialogs,
// the system clipboard, opening links and folders in the OS, files dragged in from the OS.
// `windowIpc`, `dialogIpc`, `clipboardIpc`, `openerIpc` (system.ts) and `dragDropIpc.listen`
// (fs.ts) go through the `Shell` in use: the desktop framework's in the app's window
// (`desktopShell.ts`), one a program registers with `setShell`, or else the windowless one below,
// which answers what has a natural empty answer and refuses the rest with a typed error.
import { type Disposable, toDisposable } from "../lifecycle/index";
import { desktopShell } from "./desktopShell";
import type { DropEvent } from "./fs";
import { IpcError, isDesktopShell } from "./invoke";

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface PickPathsOptions {
  title?: string;
  defaultPath?: string;
  directory: boolean;
  multiple: boolean;
  filters?: FileFilter[];
}

export interface ShellWindow {
  /** Flashes the taskbar button (bounces the Dock icon) without taking focus. */
  requestAttention(): Promise<void>;
  focus(): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  isMaximized(): Promise<boolean>;
  /** Closes without running close-requested handlers. */
  destroy(): Promise<void>;
  /** Inner size in logical (CSS) pixels. */
  innerSize(): Promise<{ width: number; height: number }>;
  setSize(width: number, height: number): Promise<void>;
  unmaximize(): Promise<void>;
  isFullscreen(): Promise<boolean>;
  /** Zooms the whole UI (1 = 100 %). */
  setZoom(scale: number): Promise<void>;
  /** Full screen on or off; resolves with the new state. */
  toggleFullscreen(): Promise<boolean>;
  onResized(handler: () => void): Promise<Disposable>;
  /** `handler` returns true to allow an OS-initiated close. */
  onCloseRequested(handler: () => Promise<boolean>): Promise<Disposable>;
}

export interface ShellDialogs {
  pickFolder(title: string, defaultPath?: string): Promise<string | null>;
  pickFile(title: string, defaultPath?: string, filters?: FileFilter[]): Promise<string | null>;
  pickPaths(options: PickPathsOptions): Promise<string[] | null>;
  pickSavePath(title: string, defaultPath?: string): Promise<string | null>;
  confirm(text: string, title: string, okLabel?: string): Promise<boolean>;
  ask(text: string, title: string): Promise<boolean>;
  error(text: string, title: string): Promise<void>;
}

export interface ShellClipboard {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
  /** A picture on the clipboard as PNG bytes, or null when there's none. */
  readImagePng(): Promise<Uint8Array | null>;
}

export interface ShellOpener {
  /** Shows a file or folder in the OS file manager, selected. */
  revealInOs(path: string): Promise<void>;
  /** Opens a web link (http, https, mailto: checked by the caller) in the system browser. */
  openUrl(url: string): Promise<void>;
}

export interface ShellDragDrop {
  /** Files dragged onto the window from the OS; positions in CSS pixels. */
  listen(handler: (event: DropEvent) => void): Promise<Disposable>;
}

export interface Shell {
  window: ShellWindow;
  dialog: ShellDialogs;
  clipboard: ShellClipboard;
  opener: ShellOpener;
  dragDrop: ShellDragDrop;
}

/** The refusal of something only a window can do: an `IpcError` with code `Invalid`. */
export function noWindowError(what: string): IpcError {
  return new IpcError("Invalid", `There is no window here: can't ${what}.`, `shell.${what}`);
}

/** The window's inner size reported where there is none (callers size layouts from it). */
const NO_WINDOW_SIZE = { width: 1280, height: 800 };

/**
 * A shell for where there is no window (a windowless run, a unit test), and the base to build
 * another on (`setShell({ ...createWindowlessShell(), dialog: mine })`).
 *
 * - Window controls do nothing; the window is never maximized or full screen; nothing is heard.
 * - Pickers answer "nothing chosen" (null): every caller already handles a cancelled dialog.
 * - `confirm` and `ask` refuse (`noWindowError`): answering for the user either way would be a
 *   guess. `error` goes to the console.
 * - The clipboard is a text buffer of its own: what was copied here can be pasted here.
 * - `revealInOs` does nothing; `openUrl` refuses.
 *
 * In a plain browser tab (the page served without the app) the clipboard and links use the
 * browser's own, as they always have.
 */
export function createWindowlessShell(): Shell {
  let copied = "";
  const nothing = (): Promise<void> => Promise.resolve();
  const browserClipboard = (): Clipboard | undefined =>
    typeof navigator === "undefined" ? undefined : navigator.clipboard;
  return {
    window: {
      requestAttention: nothing,
      focus: nothing,
      minimize: nothing,
      toggleMaximize: nothing,
      isMaximized: () => Promise.resolve(false),
      destroy: nothing,
      innerSize: () =>
        Promise.resolve(
          typeof window === "undefined"
            ? { ...NO_WINDOW_SIZE }
            : { width: window.innerWidth, height: window.innerHeight },
        ),
      setSize: nothing,
      unmaximize: nothing,
      isFullscreen: () => Promise.resolve(false),
      setZoom: nothing,
      toggleFullscreen: () => Promise.resolve(false),
      onResized: () => Promise.resolve(toDisposable(() => {})),
      onCloseRequested: () => Promise.resolve(toDisposable(() => {})),
    },
    dialog: {
      pickFolder: () => Promise.resolve(null),
      pickFile: () => Promise.resolve(null),
      pickPaths: () => Promise.resolve(null),
      pickSavePath: () => Promise.resolve(null),
      confirm: () => Promise.reject(noWindowError("confirm")),
      ask: () => Promise.reject(noWindowError("ask")),
      error: (text, title) => {
        console.error(`${title}: ${text}`);
        return Promise.resolve();
      },
    },
    clipboard: {
      writeText: async (text) => {
        const clipboard = browserClipboard();
        if (clipboard) await clipboard.writeText(text);
        else copied = text;
      },
      readText: async () => {
        const clipboard = browserClipboard();
        return clipboard ? clipboard.readText() : copied;
      },
      readImagePng: () => Promise.resolve(null),
    },
    opener: {
      revealInOs: nothing,
      openUrl: async (url) => {
        if (typeof window === "undefined") throw noWindowError("openUrl");
        window.open(url, "_blank", "noopener");
      },
    },
    dragDrop: {
      listen: () => Promise.resolve(toDisposable(() => {})),
    },
  };
}

/** Set by `setShell`; null leaves the choice to the surroundings. */
let registered: Shell | null = null;
/** The windowless one, made once (its clipboard buffer lives as long as the program). */
let windowless: Shell | null = null;

/**
 * Registers the shell the wrappers use where the desktop framework's window isn't (null: back to
 * the default). Inside the app's window the desktop shell is always the one used.
 */
export function setShell(shell: Shell | null): void {
  registered = shell;
}

/** The shell in use now. */
export function currentShell(): Shell {
  if (isDesktopShell()) return desktopShell;
  if (registered) return registered;
  windowless ??= createWindowlessShell();
  return windowless;
}
