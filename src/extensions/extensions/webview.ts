// Webview panels (PLAN §9.3, D102): an extension's own HTML page in a frame, served from the
// extension's folder on a local origin of its own (never the IDE's), with a Content-Security-Policy
// that only lets it load its own files: the page can't reach the network or the IDE except by
// messages, which go to the extension's worker. Messages in both directions are
// `{ ns: "ide-webview", message }`; the IDE also sends `{ ns: "ide-webview", theme }` with the
// current colors so the page can match the editor (docs/extensions.md shows the page side).
// A file viewer's page (D176) also gets `{ ns, file: { path, name, text } }` after it loads, and
// saves with `{ ns, save: text }` (answered by `{ ns, saved: true }` or `{ ns, saved: false,
// error }`). In a window of its own the frame lives in the view's element (the iframe layer
// belongs to the main window) and messages come from that window.
import { h } from "../../core/dom/index";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { parseCssColor } from "../../core/themes/color";
import {
  INITIAL_STATE_SLOT,
  INITIAL_THEME_SLOT,
  STATE_KEY_SLOT,
  vscodeThemeClass,
  vscodeWebviewVars,
} from "../../core/themes/webviewVars";
import type { WorkbenchServices } from "../../workbench/services";

const NS = "ide-webview";
/** Theme tokens sent to pages (read from the IDE's computed styles). */
export const THEME_TOKENS = [
  "--bg-app",
  "--bg-surface",
  "--bg-surface-raised",
  "--bg-hover",
  "--bg-selected",
  "--bg-input-raised",
  "--fg-default",
  "--fg-muted",
  "--fg-subtle",
  "--accent",
  "--accent-hover",
  "--fg-on-accent",
  "--border-default",
  "--border-subtle",
  "--status-danger-fg",
  "--status-warning-fg",
  "--status-success-fg",
  "--font-ui",
  "--font-mono",
  "--text-md",
  // D181: enough of the design system for a page to look native (the canvas).
  "--bg-active",
  "--bg-surface-sunken",
  "--bg-overlay",
  "--border-strong",
  "--accent-text",
  "--text-xs",
  "--text-sm",
  "--text-lg",
  "--radius-sm",
  "--radius-md",
  "--shadow-1",
  "--shadow-2",
  "--label-1",
  "--label-2",
  "--label-3",
  "--label-4",
  "--label-5",
  "--label-6",
  // The scrollbar width (workbench.scrollbarSize): the page's scrollbars match the IDE's (D189).
  "--size-scrollbar",
];

/**
 * The theme a page gets: the kind, the IDE's tokens above, and VS Code's `--vscode-*` variables
 * with its body class for VS Code extensions' pages (D260).
 */
export function webviewTheme(
  services: WorkbenchServices,
  /** The page is in the side bar: it fills with the side bar's color (D269). */
  inSidebar = false,
): {
  kind: string;
  vars: Record<string, string>;
  vscode: Record<string, string>;
  vscodeClass: string;
} {
  const style = getComputedStyle(document.documentElement);
  const read = (token: string) => style.getPropertyValue(token).trim();
  const vars = Object.fromEntries(THEME_TOKENS.map((t) => [t, read(t)]).filter(([, v]) => v));
  const kind = services.theme.theme.peek();
  const vscode = vscodeWebviewVars(read);
  // Pages paint themselves with the editor or side bar background (a chat view does): in the
  // side bar both are what the side bar paints there, or the page shows another shade under the
  // IDE's side bar header. Read from the page: which token the side bar uses depends on the
  // theme and the panel style.
  const surface = inSidebar ? paintedBackground(document.querySelector(".sidebar")) : null;
  if (surface) {
    vscode["--vscode-editor-background"] = surface;
    vscode["--vscode-sideBar-background"] = surface;
  }
  return { kind, vars, vscode, vscodeClass: vscodeThemeClass(kind) };
}

/** The color an element shows behind it: its own background, else its nearest painted parent's. */
function paintedBackground(el: Element | null): string | null {
  for (let node = el; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    const parsed = parseCssColor(bg);
    if (parsed && parsed.a > 0) return bg;
  }
  return null;
}

/**
 * A VS Code page's HTML as served: the theme of the moment in its bridge, for its first paint
 * (D260), and `stateKey`, the webview's own key for its saved state (a view's id, a viewer tab's,
 * a panel's: D263).
 */
export function withPageSetup(
  html: string,
  services: WorkbenchServices,
  stateKey: string,
  inSidebar = false,
  /** The state its page saved before a restart (a restored panel's), for getState(). */
  initialState?: unknown,
): string {
  let out = html;
  if (initialState !== undefined && out.includes(INITIAL_STATE_SLOT)) {
    // Inside a <script>: no "</script>" can end it early.
    const json = (JSON.stringify(initialState) ?? "undefined").replace(/</g, "\\u003c");
    out = out.replace(INITIAL_STATE_SLOT, () => json);
  }
  if (out.includes(INITIAL_THEME_SLOT)) {
    const json = JSON.stringify(webviewTheme(services, inSidebar)).replace(/</g, "\\u003c");
    out = out.replace(INITIAL_THEME_SLOT, () => json);
  }
  if (out.includes(STATE_KEY_SLOT)) {
    const key = JSON.stringify(`vscode-state:${stateKey}`).replace(/</g, "\\u003c");
    out = out.replace(STATE_KEY_SLOT, () => key);
  }
  return out;
}

export interface WebviewTarget {
  /** The extension folder's served origin, e.g. http://127.0.0.1:53211. */
  origin(): Promise<string>;
  /** The page, relative to the extension folder. */
  path: string;
  /** A message from the page. */
  receive(message: unknown): void;
  /** The state a VS Code page saved (`acquireVsCodeApi().setState`). */
  state?(state: unknown): void;
  /** The file a viewer page shows (D176). */
  file?: {
    path: string;
    read(): Promise<string>;
    /** Absent: the page can't save (the extension lacks fs.write). */
    save?(text: string): Promise<void>;
  };
}

/** One live page: a frame, its messages, and a queue for messages sent before it loaded. */
export class WebviewFrame implements Disposable {
  readonly element: HTMLElement;
  private readonly frame: HTMLIFrameElement;
  private readonly store = new DisposableStore();
  private origin = "";
  private loaded = false;
  private readonly queue: unknown[] = [];
  /** The iframe layer's hold on the frame (main window only). */
  private readonly placement = new DisposableStore();
  private readonly windowListener = new DisposableStore();

  constructor(
    private readonly services: WorkbenchServices,
    private readonly target: WebviewTarget,
    title: string,
  ) {
    this.frame = h("iframe", {
      class: "ext-webview-frame",
      // Its own origin (allow-same-origin keeps it, so the page can load its own scripts); no
      // top navigation, popups or downloads.
      sandbox: "allow-scripts allow-same-origin allow-forms",
      "aria-label": title,
    });
    this.element = h("div", { class: "ext-webview" });
    this.store.add(this.placement);
    this.store.add(this.windowListener);
    this.placement.add(services.iframes.attach(this.element, this.frame));
    this.listenTo(window);
    this.frame.addEventListener("load", () => {
      this.loaded = true;
      this.sendTheme();
      void this.sendFile();
      this.flush();
    });
    // A theme's colors are read once they're in effect (onDidChange): an imported theme's
    // overrides land after its kind changed, and a page read then got the previous theme (D260).
    this.store.add(
      services.theme.onDidChange(() => {
        if (this.loaded) this.sendTheme();
      }),
    );
    this.store.add(
      effect(() => {
        services.theme.theme.value;
        services.settings.version.value;
        if (this.loaded) queueMicrotask(() => this.sendTheme());
        return undefined;
      }),
    );
    void target.origin().then(
      (origin) => {
        if (this.store.isDisposed) return;
        this.origin = origin;
        this.frame.src = this.pageUrl();
      },
      (err: unknown) => {
        this.element.replaceChildren(
          h(
            "div",
            { class: "empty-state" },
            `Couldn't open the page: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      },
    );
  }

  private listenTo(win: Window): void {
    this.windowListener.clear();
    const onMessage = (e: MessageEvent) => {
      if (e.source !== this.frame.contentWindow || e.origin !== this.origin) return;
      const data = e.data as {
        ns?: unknown;
        message?: unknown;
        ready?: unknown;
        save?: unknown;
        state?: unknown;
      };
      if (!data || typeof data !== "object" || data.ns !== NS) return;
      if (data.ready) {
        this.flush();
        return;
      }
      if (typeof data.save === "string") {
        void this.save(data.save);
        return;
      }
      if ("state" in data) {
        this.target.state?.(data.state);
        return;
      }
      if ("message" in data) this.target.receive(data.message);
    };
    win.addEventListener("message", onMessage);
    this.windowListener.add(toDisposable(() => win.removeEventListener("message", onMessage)));
  }

  /**
   * The view moved into an auxiliary window (or back): the frame reloads there. Outside the main
   * window it sits in the element itself, since the iframe layer only covers the main window.
   */
  onWindowChanged(win: Window): void {
    this.placement.clear();
    this.loaded = false;
    if (win === window) this.placement.add(this.services.iframes.attach(this.element, this.frame));
    else {
      this.frame.classList.remove("iframe-layer-frame");
      this.frame.removeAttribute("style");
      this.frame.classList.add("ext-webview-frame-inline");
      this.element.append(this.frame);
      this.placement.add(
        toDisposable(() => {
          this.frame.classList.remove("ext-webview-frame-inline");
          this.frame.remove();
        }),
      );
    }
    this.listenTo(win);
  }

  /** Sends the viewer's file (after load, and when it changed on disk). */
  /** File deliveries, one after another: a slow read can't land after a newer one (D181). */
  private fileQueue: Promise<void> = Promise.resolve();

  sendFile(): Promise<void> {
    this.fileQueue = this.fileQueue.then(() => this.sendFileNow());
    return this.fileQueue;
  }

  private async sendFileNow(): Promise<void> {
    const file = this.target.file;
    if (!file || !this.loaded) return;
    try {
      const text = await file.read();
      this.frame.contentWindow?.postMessage(
        {
          ns: NS,
          file: {
            path: file.path,
            name: file.path.split(/[\\/]/).pop() ?? file.path,
            text,
            canSave: !!file.save,
          },
        },
        this.origin,
      );
    } catch (err) {
      this.frame.contentWindow?.postMessage(
        {
          ns: NS,
          file: { path: file.path, error: err instanceof Error ? err.message : String(err) },
        },
        this.origin,
      );
    }
  }

  private async save(text: string): Promise<void> {
    const reply = (m: Record<string, unknown>) =>
      this.frame.contentWindow?.postMessage({ ns: NS, ...m }, this.origin);
    const save = this.target.file?.save;
    if (!save) {
      reply({
        saved: false,
        error: "This page can't save files (it needs the fs.write permission).",
      });
      return;
    }
    try {
      await save(text);
      reply({ saved: true });
    } catch (err) {
      reply({ saved: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Loads another page of the extension's origin in place (a run-time panel's new HTML): messages
   * sent until it has loaded wait for it.
   */
  navigate(path: string): void {
    this.target.path = path;
    this.loaded = false;
    if (this.origin) this.frame.src = this.pageUrl();
  }

  private pageUrl(): string {
    return `${this.origin}/${this.target.path.split("/").map(encodeURIComponent).join("/")}`;
  }

  /** The page it shows (or is loading) and whether it has loaded, for the extension's state. */
  get shown(): { path: string; loaded: boolean } {
    return { path: this.target.path, loaded: this.loaded };
  }

  post(message: unknown): void {
    if (!this.loaded) {
      this.queue.push(message);
      if (this.queue.length > 200) this.queue.shift();
      return;
    }
    this.frame.contentWindow?.postMessage({ ns: NS, message }, this.origin);
  }

  private flush(): void {
    for (const m of this.queue.splice(0))
      this.frame.contentWindow?.postMessage({ ns: NS, message: m }, this.origin);
  }

  private sendTheme(): void {
    this.frame.contentWindow?.postMessage(
      { ns: NS, theme: webviewTheme(this.services, !!this.element.closest(".sidebar")) },
      this.origin,
    );
  }

  dispose(): void {
    this.store.dispose();
  }
}
