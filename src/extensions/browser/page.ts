// One browser tab's page as the IDE knows it: where it is, what the bridge reported (console,
// errors, failed requests) and calls into the bridge with their pending results. The transport is
// either the tab's frame (postMessage) or an external window (Tauri, browserIpc) — `Page` only
// sees `send`. DOM-free, tested.
import { Emitter } from "../../core/events/index";
import { signal } from "../../core/reactive/index";
import { type PageRequest, parseRequest } from "./links";

/** One argument of a console call: its preview, and how to expand it. */
export interface ConsoleArg {
  text: string;
  kind: string;
  /** Pretty JSON of an object (expand). */
  json?: string;
  /** An element's ref (reveal in Elements). */
  ref?: string;
}

export interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  time: number;
  /** "file.js:10:4" for uncaught errors. */
  source?: string;
  args?: ConsoleArg[];
  stack?: string;
  /** console.group / groupEnd. */
  group?: "start" | "end";
  /** "input" / "result" for lines typed in the console. */
  origin?: "page" | "input" | "result";
  /** Identical consecutive messages are counted, not repeated. */
  count?: number;
}

/** One request, from the preview proxy's log (frame) or the bridge (external window). */
export interface NetRequest {
  id: string;
  /** The proxy's id for fetching bodies (frame previews only). */
  logId?: number;
  method: string;
  /** As the user knows it (dev server URL or workspace path). */
  url: string;
  status: number;
  mime: string;
  size: number;
  startMs: number;
  ttfbMs: number;
  durationMs: number;
  reqHeaders: [string, string][];
  resHeaders: [string, string][];
  error?: string;
  protocol: "http" | "websocket";
  done: boolean;
  truncated?: boolean;
  hasRequestBody?: boolean;
  /** script, img, fetch… (bridge-reported). */
  initiator?: string;
}

export interface NetworkFailure {
  method: string;
  url: string;
  status: number;
  error?: string;
  time: number;
}

const MAX_CONSOLE = 1000;
const MAX_NETWORK = 100;
const MAX_REQUESTS = 1500;
const CALL_TIMEOUT_MS = 15000;

/** How the page is shown: in the tab's frame (local previews) or in its own window. */
export type PageKind = "frame" | "window";

export class Page {
  /** Address as the user sees it (dev server URL, workspace file, or the external URL). */
  readonly url = signal("");
  readonly title = signal("");
  /** The bridge answered on the current document (calls work). */
  readonly connected = signal(false);
  /**
   * Counts documents whose bridge said it's ready: a new document even when the old one's
   * "leave" never arrived (WebView2 can drop it), so the connection never looked dropped.
   */
  readonly documents = signal(0);
  private lastDoc: number | null = null;
  readonly loading = signal(false);
  readonly console = signal<readonly ConsoleEntry[]>([]);
  readonly network = signal<readonly NetworkFailure[]>([]);
  readonly requests = signal<readonly NetRequest[]>([]);
  /** Keep console and requests across navigations. */
  preserveLog = false;
  /** prefers-color-scheme emulated in this tab (browser.resize colorScheme), or null. */
  colorScheme: "light" | "dark" | null = null;
  /** The page is served by the preview proxy, which logs its requests (bridge reports are skipped). */
  proxied = false;
  private readonly domChanged = new Emitter<void>();
  /** The DOM changed (while the Elements panel watches). */
  readonly onDomChanged = this.domChanged.event;
  private readonly keyed = new Emitter<"devtools" | "inspect" | "address" | "reload">();
  /** An IDE shortcut pressed inside the page. */
  readonly onKey = this.keyed.event;
  private readonly picked = new Emitter<{ id: string | null; path: string[] }>();
  /** The element picker chose an element (or was cancelled: id null). */
  readonly onPicked = this.picked.event;
  private readonly pending = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private nextId = 1;
  private readonly navigated = new Emitter<string>();
  /** The bridge reported a (new) location, already mapped back to the user's address. */
  readonly onDidNavigate = this.navigated.event;
  private readonly requested = new Emitter<PageRequest>();
  /** The page wants to open a page (a link, form, popup or redirect) or relay a popup message. */
  readonly onRequest = this.requested.event;
  private readonly readyWaiters: (() => void)[] = [];

  constructor(
    readonly id: string,
    /** Changes when the tab moves between its frame and an external window. */
    public kind: PageKind,
    /** Sends a message to the bridge. */
    private readonly send: (message: unknown) => void,
    /** Maps a bridge-reported URL (proxy origin) to the user's address. */
    private readonly mapUrl: (url: string) => string = (u) => u,
  ) {}

  /** The frame started loading a new document: calls wait for its bridge. */
  beginLoad(): void {
    this.connected.value = false;
    this.loading.value = true;
    this.newDocument();
    // The old document can't answer any more (a click on a link that navigated).
    this.endPending();
  }

  /**
   * Calls the document that left was answering: done, as navigations. Its "leave" message says
   * so, but WebView2 doesn't always deliver one from an unloading page, so a load or a new
   * document's hello ends them too (else a click on a link waited out the timeout).
   */
  private endPending(): void {
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.resolve({ navigating: true, note: "The page navigated; take a new snapshot." });
      this.pending.delete(id);
    }
  }

  /** A new document starts (navigation, reload): logs start over unless "preserve log" is on. */
  newDocument(): void {
    if (this.preserveLog) return;
    this.console.value = [];
    this.network.value = [];
    this.requests.value = [];
  }

  /** A message from the bridge (untrusted page data: only known fields are used). */
  handle(message: Record<string, unknown>): void {
    const str = (v: unknown, max = 4000) => (typeof v === "string" ? v.slice(0, max) : "");
    switch (message.type) {
      case "ready":
      case "nav": {
        const url = this.mapUrl(str(message.url));
        const changed = url !== this.url.peek();
        this.url.value = url;
        this.title.value = str(message.title, 300);
        // The first "ready" (before the host said hello) only opens the channel.
        if (message.type === "ready" && message.loaded !== false) {
          this.connected.value = true;
          // A new document (its time origin), not a repeated hello to the same one.
          const doc = typeof message.doc === "number" ? message.doc : null;
          if (doc === null || doc !== this.lastDoc) {
            // A new document: the old one's calls end (their answers can't come).
            if (this.lastDoc !== null && doc !== null) this.endPending();
            this.lastDoc = doc;
            this.documents.value = this.documents.peek() + 1;
            // The tab's emulated color scheme holds for every document it shows (D318).
            if (this.colorScheme)
              void this.call("emulate.colorScheme", { scheme: this.colorScheme }).catch(() => {});
          }
          this.loading.value = false;
          for (const w of this.readyWaiters.splice(0)) w();
        }
        if (changed) this.navigated.fire(url);
        break;
      }
      case "console": {
        const level = (["log", "info", "warn", "error", "debug"] as const).find(
          (l) => l === message.level,
        );
        if (!level) return;
        const args = Array.isArray(message.args)
          ? (message.args as unknown[]).slice(0, 20).flatMap((a): ConsoleArg[] => {
              if (!a || typeof a !== "object") return [];
              const o = a as Record<string, unknown>;
              const json = str(o.json, 20000);
              const ref = str(o.ref, 20);
              return [
                {
                  text: str(o.text),
                  kind: str(o.kind, 20),
                  ...(json && { json }),
                  ...(ref && { ref }),
                },
              ];
            })
          : undefined;
        const stack = str(message.stack);
        const group =
          message.group === "start" || message.group === "end" ? message.group : undefined;
        this.addConsole({
          level,
          text: str(message.text),
          time: Date.now(),
          ...(args && { args }),
          ...(stack && { stack }),
          ...(group && { group }),
        });
        break;
      }
      case "key": {
        const chord = (["devtools", "inspect", "address", "reload"] as const).find(
          (c) => c === message.chord,
        );
        if (chord) this.keyed.fire(chord);
        break;
      }
      case "consoleClear":
        this.console.value = [];
        break;
      case "dom":
        this.domChanged.fire();
        break;
      case "picked": {
        const path = Array.isArray(message.path)
          ? (message.path as unknown[]).filter((p): p is string => typeof p === "string")
          : [];
        this.picked.fire({ id: typeof message.id === "string" ? message.id : null, path });
        break;
      }
      case "request": {
        // External windows: the bridge reports what loaded (pages through the proxy are logged
        // by the proxy; the IDE's own IPC is never page traffic).
        const url = str(message.url, 2000);
        if (!url || this.proxied || /^ipc:|\/\/ipc\.localhost\b|^tauri:/.test(url)) return;
        const status = typeof message.status === "number" ? message.status : 0;
        const duration = typeof message.durationMs === "number" ? message.durationMs : 0;
        this.addRequest({
          id: `b${this.requests.peek().length}-${Date.now()}`,
          method: "GET",
          url,
          status,
          mime: "",
          size: typeof message.size === "number" ? message.size : 0,
          startMs: Date.now() - duration,
          ttfbMs: 0,
          durationMs: duration,
          reqHeaders: [],
          resHeaders: [],
          protocol: "http",
          done: true,
          initiator: str(message.initiator, 30),
        });
        break;
      }
      case "error": {
        const source = str(message.source, 500);
        const stack = str(message.stack);
        this.addConsole({
          level: "error",
          text:
            stack && !stack.includes(str(message.text))
              ? `${str(message.text)}\n${stack}`
              : stack || str(message.text),
          time: Date.now(),
          ...(source && { source }),
        });
        break;
      }
      case "network": {
        const status = typeof message.status === "number" ? message.status : 0;
        const error = str(message.error, 500);
        const entry: NetworkFailure = {
          method: str(message.method, 16) || "GET",
          url: this.mapUrl(str(message.url, 2000)),
          status,
          ...(error && { error }),
          time: Date.now(),
        };
        this.network.value = [...this.network.peek(), entry].slice(-MAX_NETWORK);
        break;
      }
      case "leave": {
        // The document is unloading (navigation, reload): calls it was answering end here.
        this.connected.value = false;
        this.loading.value = true;
        this.newDocument();
        this.endPending();
        break;
      }
      case "open":
      case "toOpener":
      case "close":
      case "toPopup":
      case "closePopup":
      case "focusPopup":
      case "popupNavigate":
      case "openerNavigate": {
        const request = parseRequest(message);
        if (request) this.requested.fire(request);
        break;
      }
      case "result": {
        const id = typeof message.id === "number" ? message.id : -1;
        const call = this.pending.get(id);
        if (!call) return;
        this.pending.delete(id);
        clearTimeout(call.timer);
        if (typeof message.error === "string") call.reject(new Error(message.error));
        else call.resolve(message.result);
        break;
      }
    }
  }

  /** Adds a console line (identical consecutive lines count up instead). */
  addConsole(entry: ConsoleEntry): void {
    const list = this.console.peek();
    const last = list[list.length - 1];
    if (
      last &&
      !entry.group &&
      last.level === entry.level &&
      last.text === entry.text &&
      last.origin === entry.origin &&
      last.source === entry.source
    ) {
      this.console.value = [
        ...list.slice(0, -1),
        { ...last, count: (last.count ?? 1) + 1, time: entry.time },
      ];
      return;
    }
    this.console.value = [...list, entry].slice(-MAX_CONSOLE);
  }

  /** A request started, finished, or changed (same id replaces). */
  addRequest(request: NetRequest): void {
    const list = this.requests.peek();
    const at = list.findIndex((r) => r.id === request.id);
    if (at >= 0) {
      const next = list.slice();
      next[at] = request;
      this.requests.value = next;
    } else this.requests.value = [...list, request].slice(-MAX_REQUESTS);
  }

  clearConsole(): void {
    this.console.value = [];
    this.network.value = [];
  }

  clearRequests(): void {
    this.requests.value = [];
  }

  /** Resolves once the bridge is connected (or rejects after `timeoutMs`). */
  whenReady(timeoutMs = CALL_TIMEOUT_MS): Promise<void> {
    if (this.connected.peek()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.readyWaiters.indexOf(done);
        if (i >= 0) this.readyWaiters.splice(i, 1);
        reject(
          new Error(
            "The page isn't connected (still loading, or it left the preview for another site).",
          ),
        );
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.readyWaiters.push(done);
    });
  }

  /** Calls a bridge method (snapshot, click, type…) once the page is connected. */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.whenReady();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The page didn't answer ${method} in time.`));
      }, CALL_TIMEOUT_MS + 2000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ ns: "ide-host", type: "call", id, method, params });
    });
  }

  /** Emulates prefers-color-scheme now and in the documents the tab shows next (null: ends it). */
  emulateColorScheme(scheme: "light" | "dark" | null): Promise<unknown> {
    this.colorScheme = scheme;
    return this.call("emulate.colorScheme", { scheme });
  }

  /** Fails pending calls (navigation away, tab closed). */
  abort(reason: string): void {
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  dispose(): void {
    this.abort("The browser tab closed.");
    this.navigated.dispose();
    this.requested.dispose();
    this.domChanged.dispose();
    this.picked.dispose();
    this.keyed.dispose();
  }
}

/** Counts for the toolbar badge and state: errors are console errors plus failed requests. */
export function problemCounts(page: Page): { errors: number; warnings: number } {
  let errors = page.network.peek().length;
  let warnings = 0;
  for (const e of page.console.peek()) {
    if (e.level === "error") errors++;
    else if (e.level === "warn") warnings++;
  }
  return { errors, warnings };
}

/**
 * How `next` follows `old` for an append-only log that trims its front: `dropped` items left
 * the front, `added` were appended, and `replaced` is the new version of `old`'s last item when
 * it was swapped in place (a repeat count going up). `null`: changed some other way.
 */
export function logDiff<T>(
  old: readonly T[],
  next: readonly T[],
): { dropped: number; added: T[]; replaced: T | null } | null {
  if (!old.length) return { dropped: 0, added: next.slice(), replaced: null };
  const last = old[old.length - 1] as T;
  const at = next.lastIndexOf(last);
  if (at >= 0) {
    const dropped = old.length - 1 - at;
    if (dropped < 0 || next[0] !== old[dropped]) return null;
    return { dropped, added: next.slice(at + 1), replaced: null };
  }
  // The last item was replaced: anchor on the one before it (or the start).
  const before = old.length >= 2 ? next.lastIndexOf(old[old.length - 2] as T) : -1;
  if (old.length >= 2 && before < 0) return null;
  const dropped = old.length - 2 - before;
  if (dropped < 0) return null;
  if (before >= 0 && next[0] !== old[dropped]) return null;
  const replaced = next[before + 1];
  if (replaced === undefined) return null;
  return { dropped, added: next.slice(before + 2), replaced };
}
