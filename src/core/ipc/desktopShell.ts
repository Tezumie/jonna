// The desktop framework's shell: the app's own window, the native dialog, clipboard and opener
// plugins, and the webview's drag-and-drop events. The only file that imports the framework's
// window and plugin APIs (importing them is safe anywhere; calling them needs the window's
// globals, so `shell.ts` only uses this one when they exist).
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readImage, readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ask, confirm, message, open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { toDisposable } from "../lifecycle/index";
import { call } from "./invoke";
import type { Shell } from "./shell";

// Window controls for the custom title bar.
const win = () => getCurrentWindow();
/** Full screen began from a maximized window: maximize it again on the way out. */
let fullscreenFromMaximized = false;

/**
 * Before a native file dialog (D210): Clone repository opened the folder picker straight from
 * the Enter that confirmed the URL, and on Windows the pointer stayed hidden over the dialog
 * ("hide pointer while typing" hides it in the webview, which then never sees the mouse move
 * that shows it again). So: leave the text field, let the key's events finish, and have the
 * native side show the arrow pointer. Nothing in the page sets a busy cursor or an overlay here.
 */
async function beforeNativeDialog(): Promise<void> {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.blur();
  // A timer, not a frame: a window in the background may not paint.
  await new Promise<void>((resolve) => setTimeout(resolve, 16));
  await call<void>("app_show_cursor").catch(() => {});
}

export const desktopShell: Shell = {
  window: {
    requestAttention: () => call<void>("app_request_attention"),
    /** Brings the window to the front with keyboard focus (the OS may refuse a background app). */
    focus: () => win().setFocus(),
    minimize: () => win().minimize(),
    toggleMaximize: () => win().toggleMaximize(),
    isMaximized: () => win().isMaximized(),
    /** Closes without running close-requested handlers (use after the user confirmed). */
    destroy: () => win().destroy(),
    innerSize: async () => {
      const size = await win().innerSize();
      const scale = await win().scaleFactor();
      return { width: Math.round(size.width / scale), height: Math.round(size.height / scale) };
    },
    setSize: (width, height) => win().setSize(new LogicalSize(width, height)),
    unmaximize: () => win().unmaximize(),
    isFullscreen: () => win().isFullscreen(),
    setZoom: (scale) => getCurrentWebview().setZoom(scale),
    /**
     * Full screen on or off (D387). A maximized window is restored first and maximized again
     * afterwards: on Windows, going full screen from maximized left the page at its maximized
     * height (a taskbar-high gap at the bottom).
     */
    toggleFullscreen: async () => {
      const w = win();
      const next = !(await w.isFullscreen());
      if (next) {
        fullscreenFromMaximized = await w.isMaximized();
        if (fullscreenFromMaximized) await w.unmaximize();
        await w.setFullscreen(true);
      } else {
        await w.setFullscreen(false);
        if (fullscreenFromMaximized && !(await w.isMaximized())) await w.toggleMaximize();
        fullscreenFromMaximized = false;
      }
      return next;
    },
    onResized: async (handler) => toDisposable(await win().onResized(handler)),
    onCloseRequested: async (handler) => {
      const unlisten = await win().onCloseRequested(async (event) => {
        if (!(await handler())) event.preventDefault();
      });
      return toDisposable(unlisten);
    },
  },

  // Native dialogs (the framework's dialog plugin).
  dialog: {
    pickFolder: async (title, defaultPath) => {
      await beforeNativeDialog();
      const picked = await open({ directory: true, multiple: false, title, defaultPath });
      return typeof picked === "string" ? picked : null;
    },
    pickFile: async (title, defaultPath, filters) => {
      await beforeNativeDialog();
      const picked = await open({
        directory: false,
        multiple: false,
        title,
        defaultPath,
        ...(filters && { filters }),
      });
      return typeof picked === "string" ? picked : null;
    },
    pickPaths: async (options) => {
      await beforeNativeDialog();
      const picked = await open({
        directory: options.directory,
        multiple: options.multiple,
        ...(options.title && { title: options.title }),
        ...(options.defaultPath && { defaultPath: options.defaultPath }),
        ...(options.filters?.length && { filters: options.filters }),
      });
      if (picked === null) return null;
      return Array.isArray(picked) ? picked : [picked];
    },
    pickSavePath: async (title, defaultPath) => {
      await beforeNativeDialog();
      return (await save({ title, defaultPath })) ?? null;
    },
    confirm: (text, title, okLabel = "OK") =>
      confirm(text, { title, kind: "warning", okLabel, cancelLabel: "Cancel" }),
    ask: (text, title) => ask(text, { title, kind: "info" }),
    error: async (text, title) => {
      await message(text, { title, kind: "error" });
    },
  },

  // System clipboard through the framework's clipboard plugin. Works from any code path (menus,
  // async commands), unlike `navigator.clipboard`/`execCommand`, which WebView2 and WebKitGTK
  // only allow inside a fresh user gesture and sometimes block with a permission prompt.
  clipboard: {
    writeText: (text) => writeText(text),
    readText: async () => (await readText()) ?? "",
    readImagePng: async () => {
      try {
        const image = await readImage();
        const { width, height } = await image.size();
        // RGBA bytes (looked up by name: the color checker would read the call as a CSS color).
        const pixels: Uint8Array = await image["rgba" as "rgba"]();
        if (!width || !height || pixels.length < width * height * 4) return null;
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
        const blob = await canvas.convertToBlob({ type: "image/png" });
        return new Uint8Array(await blob.arrayBuffer());
      } catch {
        return null; // no picture (text, nothing)
      }
    },
  },

  // The framework's opener plugin (http, https and mailto only for links).
  opener: {
    revealInOs: (path) => revealItemInDir(path),
    openUrl: (url) => openUrl(url),
  },

  // Files dragged onto the window from the OS (the webview's drag-drop events). Positions arrive
  // in physical pixels; the handler gets CSS pixels.
  dragDrop: {
    listen: async (handler) => {
      let paths: string[] = [];
      const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        const p = event.payload;
        const scale = window.devicePixelRatio || 1;
        if (p.type === "enter") paths = p.paths;
        if (p.type === "leave") handler({ kind: "leave" });
        else if (p.type === "over" || p.type === "enter" || p.type === "drop") {
          const x = p.position.x / scale;
          const y = p.position.y / scale;
          handler({
            kind: p.type === "drop" ? "drop" : "over",
            x,
            y,
            paths: p.type === "drop" ? p.paths : paths,
          });
        }
      });
      return toDisposable(unlisten);
    },
  },
};
