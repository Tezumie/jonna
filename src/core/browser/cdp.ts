// The user's own Chrome or Edge as a target of the browser tools (D341), over the Chrome DevTools
// Protocol: the IDE starts the browser with a debugging port and a profile of its own (or the
// user starts it so), connects to a page's WebSocket (Rust's local-only debug socket, D143) and
// installs the same bridge its tabs have. The bridge reports through a protocol binding and takes
// calls through Runtime.evaluate, so snapshots, actions and finds work as in a tab; screenshots
// are Page.captureScreenshot. The messages, the target picking and the launch arguments are here.
// DOM-free and tested.

/** The tab id the browser tools use for the user's own browser. */
export const EXTERNAL_TAB = "external";

/** A debugging port the user would start a browser with (Chrome's own example). */
export const DEFAULT_DEBUG_PORT = 9222;

export interface CdpTarget {
  id?: string;
  type?: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

/**
 * The page to work on in `/json/list`: the one whose address starts with `url`, else the first
 * ordinary page (not DevTools, an extension or a new tab page when another exists).
 */
export function pickExternalPage(targets: readonly CdpTarget[], url?: string): CdpTarget | null {
  const pages = targets.filter(
    (t) =>
      t.type === "page" &&
      t.webSocketDebuggerUrl &&
      !/^(devtools|chrome-extension|edge-extension):/i.test(t.url ?? ""),
  );
  if (url) {
    const hit = pages.find((t) => t.url?.startsWith(url));
    if (hit) return hit;
  }
  const blank = (t: CdpTarget) =>
    !t.url ||
    /^(about:blank|chrome:\/\/newtab|edge:\/\/newtab|chrome:\/\/new-tab-page)/i.test(t.url);
  return pages.find((t) => !blank(t)) ?? pages[0] ?? null;
}

/** Parses `/json/list` text; [] when it isn't a list. */
export function parseTargets(text: string): CdpTarget[] {
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? v.filter((t): t is CdpTarget => !!t && typeof t === "object") : [];
  } catch {
    return [];
  }
}

/** Command-line arguments for Chrome or Edge: the port, a separate profile, no first-run pages. */
export function launchArgs(port: number, profile: string, url?: string): string[] {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    url || "about:blank",
  ];
}

/** A port as typed ("9222", ":9222", "localhost:9222"), or null. */
export function parsePort(value: unknown): number | null {
  const text = String(value ?? "").trim();
  const m = /^(?:(?:https?:\/\/)?(?:localhost|127\.0\.0\.1))?:?(\d{2,5})\/?$/i.exec(text);
  const port = m ? Number(m[1]) : Number.NaN;
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

/** An address as the user's browser takes it: `localhost:5173` → http, `example.com` → https. */
export function externalUrl(address: string): string {
  const a = address.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(a) && !/^(localhost|127\.0\.0\.1|\[::1\]):\d/i.test(a)) return a;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(a)) return `http://${a}`;
  return `https://${a}`;
}

/** The binding the bridge posts to: a name a page can't guess ahead. */
export function bindingName(random: () => number = Math.random): string {
  return `__ideBridgePost${Math.floor(random() * 2 ** 40).toString(36)}`;
}

/** What runs in each document: the bridge in "external" mode, posting to the binding. */
export function bridgeInstall(source: string, binding: string): string {
  return `window.__IDE_BRIDGE_MODE__="external";window.__IDE_BRIDGE_POST__=${JSON.stringify(binding)};\n${source}`;
}

/** The expression that hands the bridge one of the host's messages (a call). */
export function bridgeCall(message: unknown): string {
  return `void (window.__ideBridge && window.__ideBridge.receive(${JSON.stringify(message)}))`;
}

/** A bridge message from a Runtime.bindingCalled event of our binding, or null. */
export function bindingMessage(params: unknown, binding: string): Record<string, unknown> | null {
  const p = (params ?? {}) as { name?: unknown; payload?: unknown };
  if (p.name !== binding || typeof p.payload !== "string") return null;
  try {
    const v = JSON.parse(p.payload) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Width and height of a PNG from its header (IHDR), or null. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const u32 = (at: number) =>
    (((bytes[at] ?? 0) << 24) |
      ((bytes[at + 1] ?? 0) << 16) |
      ((bytes[at + 2] ?? 0) << 8) |
      (bytes[at + 3] ?? 0)) >>>
    0;
  return { width: u32(16), height: u32(20) };
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Requests and events over one DevTools protocol socket: `send` writes text, `handle` takes what
 * arrives. Each request answers once (its result or error) or times out.
 */
export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed: string | null = null;

  constructor(
    private readonly send: (text: string) => void,
    private readonly onEvent: (method: string, params: unknown) => void,
    private readonly timeoutMs = 15000,
  ) {}

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error(this.closed));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser didn't answer ${method} in time.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** A message from the browser (untrusted: only the fields used are read). */
  handle(text: string): void {
    let msg: {
      id?: unknown;
      result?: unknown;
      error?: { message?: unknown };
      method?: unknown;
      params?: unknown;
    };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    // Valid JSON that isn't an object ("null") would throw on the reads below.
    if (typeof msg !== "object" || msg === null) return;
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(String(msg.error.message ?? "The browser refused.")));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method === "string") this.onEvent(msg.method, msg.params);
  }

  /** The socket closed: waiting requests fail with `reason`, later ones too. */
  close(reason: string): void {
    this.closed = reason;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}
