// Browser previews (Rust `browser`): the proxy that serves a local dev server or a workspace
// folder to the in-dock frame with the bridge injected, external windows with the bridge, sites
// shown inside a tab (embed) and downloads.
import { Channel, call } from "./invoke";

export interface ProxyInfo {
  /** The proxy's origin ("http://127.0.0.1:53211"): what the frame loads. */
  origin: string;
  /** What it serves: the dev server's origin, or the folder path. */
  target: string;
}

/** A message from the bridge (page data: untrusted). */
export interface BridgeMessage {
  ns: "ide-bridge";
  type: string;
  [key: string]: unknown;
}

/** One request the preview proxy forwarded (the DevTools Network panel). */
export interface NetEvent {
  id: number;
  /** The proxy's origin: which preview made it. */
  origin: string;
  method: string;
  /** Path and query. */
  url: string;
  status: number;
  mime: string;
  size: number;
  startMs: number;
  ttfbMs: number;
  durationMs: number;
  reqHeaders: [string, string][];
  resHeaders: [string, string][];
  error: string | null;
  phase: "response" | "done";
  protocol: "http" | "websocket";
  truncated: boolean;
  hasRequestBody: boolean;
}

/** A download from a preview, a site's window or a site inside a tab (Rust `downloads.rs`). */
export interface Download {
  id: number;
  url: string;
  fileName: string;
  /** Where it is saved (not always known before it finishes). */
  path: string | null;
  received: number;
  /** The size the server announced, if any. */
  total: number | null;
  state: "progress" | "done" | "failed" | "cancelled";
  error: string | null;
  startedMs: number;
  /** Whether the IDE can cancel it on this platform. */
  canCancel: boolean;
  /** The webview it came from ("main" for a tab's frame). */
  webview: string;
}

/** A site webview's area: physical pixels, relative to its window's client area. */
export interface EmbedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

type BrowserEvent =
  | ({ kind: "network" } & NetEvent)
  | { kind: "bridge"; label: string; message: BridgeMessage }
  | { kind: "windowClosed"; label: string }
  | ({ kind: "download" } & Download);

export interface BrowserHandlers {
  network(event: NetEvent): void;
  bridge(label: string, message: BridgeMessage): void;
  windowClosed(label: string): void;
  download(download: Download): void;
}

export const browserIpc = {
  /** PNG of a window as shown on screen: the IDE (default) or a browser window by label. */
  screenshot: async (label?: string): Promise<Uint8Array> =>
    new Uint8Array(await call<ArrayBuffer>("screenshot_window", label ? { label } : {})),
  /** The proxy for a local http URL (its origin) or a workspace folder (absolute path). */
  proxy: (target: string): Promise<ProxyInfo> => call<ProxyInfo>("browser_proxy", { target }),
  stopAll: (): Promise<void> => call<void>("browser_proxy_stop_all"),
  /**
   * Opens an http(s) page in its own window with the bridge; returns the window label. `popup`:
   * another tab's `window.open` asked for it (the bridge gives it a relaying `window.opener`).
   */
  openWindow: (url: string, title: string, popup = false, name?: string): Promise<string> =>
    call<string>("browser_window_open", { url, title, popup, ...(name && { name }) }),
  /**
   * Shows an http(s) page in a webview over a tab's page area (`host`: the IDE window showing the
   * tab, "main" or an auxiliary window's label). Returns its label, used like a window's.
   */
  embedOpen: (
    host: string,
    url: string,
    bounds: EmbedBounds,
    popup = false,
    name?: string,
  ): Promise<string> =>
    call<string>("browser_embed_open", { host, url, bounds, popup, ...(name && { name }) }),
  /** Places a tab's site webview: bounds, shown or hidden, and its zoom (device mode). */
  embedPlace: (
    label: string,
    host: string,
    bounds: EmbedBounds,
    visible: boolean,
    zoom = 1,
  ): Promise<void> => call<void>("browser_embed_place", { label, host, bounds, visible, zoom }),
  embedFocus: (label: string): Promise<void> => call<void>("browser_embed_focus", { label }),
  downloads: (): Promise<Download[]> => call<Download[]>("browser_downloads"),
  /** Cancels a running download (Windows; an error elsewhere). */
  cancelDownload: (id: number): Promise<void> => call<void>("browser_download_cancel", { id }),
  /** Opens a finished download with the system's program for it. */
  openDownload: (id: number): Promise<void> => call<void>("browser_download_open", { id }),
  /** Shows a finished download in the system's file manager. */
  revealDownload: (id: number): Promise<void> => call<void>("browser_download_reveal", { id }),
  /** Forgets finished downloads (the files stay). */
  clearDownloads: (): Promise<void> => call<void>("browser_downloads_clear"),
  send: (label: string, message: unknown): Promise<void> =>
    call<void>("browser_window_send", { label, message }),
  closeWindow: (label: string): Promise<void> => call<void>("browser_window_close", { label }),
  /**
   * The browser event stream (one Channel): network log entries from the preview proxies,
   * external windows' bridge reports, external windows closing. A new subscription replaces the old.
   */
  subscribe: async (handlers: BrowserHandlers): Promise<void> => {
    const channel = new Channel<BrowserEvent>();
    channel.onmessage = (e) => {
      if (e.kind === "network") handlers.network(e);
      else if (e.kind === "bridge") handlers.bridge(e.label, e.message);
      else if (e.kind === "windowClosed") handlers.windowClosed(e.label);
      else if (e.kind === "download") handlers.download(e);
    };
    await call<void>("browser_subscribe", { channel });
  },
  /** A logged request's body (raw bytes). */
  networkBody: async (id: number, which: "request" | "response"): Promise<Uint8Array> =>
    new Uint8Array(await call<ArrayBuffer>("browser_network_body", { id, which })),
  setNoCache: (on: boolean): Promise<void> => call<void>("browser_set_no_cache", { on }),
  /** The bridge's script, for a page of the user's own browser (D341). */
  bridgeSource: (): Promise<string> => call<string>("browser_bridge_source"),
  /**
   * One `Input.*` DevTools protocol call into webview `label`, in process (D346: trusted input
   * for a tab's page; WebView2 only, it fails elsewhere).
   */
  trustedInput: (
    label: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => call<unknown>("browser_trusted_input", { label, method, params }),
  /** Whether a local port accepts connections (127.0.0.1 or ::1). */
  portOpen: (port: number): Promise<boolean> => call<boolean>("net_port_open", { port }),
  /** Unsaved text static previews serve instead of the file (null: back to the file). */
  overlay: (path: string, text: string | null): Promise<void> =>
    call<void>("browser_overlay", { path, text }),
};
