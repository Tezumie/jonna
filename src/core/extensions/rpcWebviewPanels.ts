// The worker side of `ide.ui.createWebviewPanel` (VS Code's `window.createWebviewPanel`, D247): a page
// the extension's code writes at run time (`webview.html`), shown in a dock tab like a declared
// `"type": "webview"` view (its own origin, the same CSP, the theme message), with messages both
// ways, `reveal`, `title`, view state changes and disposal. Changes made in one turn (create, then
// html and title) reach the host as one request. The host calls back through "provider" calls on
// `webviewPanel.<id>`. Panels of a view type with a serializer (VS Code's
// registerWebviewPanelSerializer) come back after a restart: the host opens their tab and calls
// `webviewPanelSerializer.<viewType>` with the page's saved state. DOM-free, unit-tested.
import type { Disposable } from "./rpc";
import type { OnCall, Request } from "./rpcTerminals";

/** Where a panel opens: VS Code's ViewColumn numbers (-2 Beside, -1 Active, 1…9) or a place. */
export type PanelColumn = number | "main" | "beside" | "bottom" | "right";

export type PanelShowOptions = PanelColumn | { viewColumn?: PanelColumn; preserveFocus?: boolean };

export interface WebviewPanelOptions {
  /** Accepted for VS Code's sake: scripts always run (the CSP keeps the page to its own files). */
  enableScripts?: boolean;
  /** Accepted for VS Code's sake: a hidden tab keeps its page loaded anyway. */
  retainContextWhenHidden?: boolean;
  enableFindWidget?: boolean;
  /**
   * Folders the page may load files from besides the extension's (absolute paths; VS Code's
   * localResourceRoots). The workspace's folders are allowed anyway (VS Code's default); a folder
   * outside the workspace isn't served.
   */
  localResourceRoots?: unknown[];
}

export interface Webview {
  /** The page. Setting it loads it again (messages sent meanwhile wait for the new page). */
  html: string;
  readonly options: WebviewPanelOptions;
  /** Resolves false when the panel is gone. Messages wait until the page has loaded. */
  postMessage(message: unknown): Promise<boolean>;
  onDidReceiveMessage(listener: (message: unknown) => void): Disposable;
  /**
   * The address a page uses for a file of the extension (relative to its folder, or absolute
   * inside it): the page is served from the folder's root, so relative URLs work as they are. A
   * file of a workspace folder or of a declared local resource root gets an address of its own.
   */
  asWebviewUri(path: string): string;
  /** For a page's own `<meta http-equiv="Content-Security-Policy">` (VS Code's cspSource). */
  readonly cspSource: string;
}

export interface WebviewPanelViewState {
  webviewPanel: WebviewPanel;
}

export interface WebviewPanel {
  readonly viewType: string;
  /** The tab's title. */
  title: string;
  /** An icon of the IDE's set for the tab. */
  iconPath: string | undefined;
  readonly webview: Webview;
  readonly options: WebviewPanelOptions;
  /** Its tab is the one shown in its group. */
  readonly visible: boolean;
  /** …and that group has the focus. */
  readonly active: boolean;
  /** Its editor group, counted in layout order from 1 (VS Code's viewColumn); undefined at first. */
  readonly viewColumn: number | undefined;
  /** Brings its tab forward (focusing it unless `preserveFocus`). */
  reveal(viewColumn?: PanelColumn, preserveFocus?: boolean): void;
  onDidChangeViewState(listener: (e: WebviewPanelViewState) => void): Disposable;
  onDidDispose(listener: () => void): Disposable;
  /** Closes the tab. */
  dispose(): void;
}

/** VS Code's WebviewPanelSerializer: brings a panel of its view type back after a restart. */
export interface WebviewPanelSerializer {
  /** `state`: what the page last gave `setState` (undefined if nothing). */
  deserialize(panel: WebviewPanel, state: unknown): unknown;
}

export interface WebviewPanelsApi {
  createWebviewPanel(
    viewType: string,
    title: string,
    showOptions?: PanelShowOptions,
    options?: WebviewPanelOptions,
  ): WebviewPanel;
  /**
   * Its panels of `viewType` come back after a restart (VS Code's registerWebviewPanelSerializer):
   * the tab is reopened with an empty page and `serializer.deserialize` fills it. Declare
   * `onWebviewPanel:<viewType>` in the manifest's activation events so the extension starts for it.
   */
  registerWebviewPanelSerializer(viewType: string, serializer: WebviewPanelSerializer): Disposable;
}

/** Where a panel goes and whether it takes the focus, from VS Code-style show options. */
export function panelPlacement(show: PanelShowOptions | undefined): {
  placement: "main" | "beside" | "bottom" | "right";
  preserveFocus: boolean;
} {
  const column =
    show !== null && typeof show === "object" ? show.viewColumn : (show as PanelColumn | undefined);
  const preserveFocus =
    show !== null && typeof show === "object" ? show.preserveFocus === true : false;
  const placement =
    column === "beside" || column === "bottom" || column === "right"
      ? column
      : // ViewColumn.Beside (-2), or a column after the first: beside the active editor.
        typeof column === "number" && (column === -2 || column >= 2)
        ? "beside"
        : "main";
  return { placement, preserveFocus };
}

/** The URL path under which a page reads a file of a local resource root (`/__fs/<abs path>`). */
export const ROOT_FILES_PREFIX = "/__fs/";

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const inside = (root: string, p: string) =>
  !!root &&
  (p.toLowerCase() === root.toLowerCase() || p.toLowerCase().startsWith(`${root.toLowerCase()}/`));

/**
 * A path of the extension as its page addresses it (the page is at the folder's root); a file of
 * one of `roots` (the workspace's folders, declared localResourceRoots: VS Code's
 * localResourceRoots) as `/__fs/<its absolute path>`, which the folder's proxy serves from those
 * roots only. Anything else isn't served: it throws.
 */
export function webviewUri(
  extensionPath: string,
  path: string,
  roots: readonly string[] = [],
): string {
  const root = norm(extensionPath);
  let p = norm(String(path ?? ""));
  // The folder itself (a page's base address, Jupyter's): the root.
  if (root && p.toLowerCase() === root.toLowerCase()) return ".";
  if (inside(root, p)) p = p.slice(root.length + 1);
  // An absolute path elsewhere: a file of a local resource root, or not served.
  else if (p.startsWith("/") || /^[a-z]:\//i.test(p)) {
    const parts = p.split("/");
    if (parts.includes("..") || parts.includes(".") || !roots.some((r) => inside(norm(r), p)))
      throw new Error(`${path} isn't a file of the extension or of its local resource roots.`);
    return ROOT_FILES_PREFIX + parts.filter(Boolean).map(encodeURIComponent).join("/");
  }
  p = p.replace(/^\.?\//, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.split("/").includes(".."))
    throw new Error(`${path} isn't a file of the extension.`);
  return p;
}

/** Declared localResourceRoots as absolute paths (Uris, `{ fsPath }` or strings). */
export function rootPaths(roots: unknown): string[] {
  if (!Array.isArray(roots)) return [];
  return roots
    .map((r) =>
      typeof r === "string"
        ? r
        : r && typeof r === "object" && typeof (r as { fsPath?: unknown }).fsPath === "string"
          ? (r as { fsPath: string }).fsPath
          : "",
    )
    .filter((r) => r.startsWith("/") || /^[a-z]:[\\/]/i.test(r))
    .slice(0, 20);
}

/** What the host sends a panel ("provider" calls on `webviewPanel.<id>`). */
type PanelEvent =
  | { kind: "message"; message?: unknown }
  | { kind: "state"; visible?: unknown; active?: unknown; viewColumn?: unknown }
  | { kind: "disposed" };

/** How the host brings a panel back (`webviewPanelSerializer.<viewType>`). */
interface RestoreArgs {
  id?: unknown;
  title?: unknown;
  state?: unknown;
  visible?: unknown;
  active?: unknown;
  viewColumn?: unknown;
}

export function createWebviewPanelsApi(
  request: Request,
  onCall: OnCall,
  extensionPath: string,
  /** The workspace's folders now (VS Code's default localResourceRoots). */
  workspaceRoots: () => readonly string[] = () => [],
): WebviewPanelsApi {
  let seq = 0;

  /** A panel: a new one (`restored` absent: created in a microtask) or one the host reopened. */
  const makePanel = (
    id: string,
    viewType: string,
    title: string,
    showOptions: PanelShowOptions | undefined,
    options: WebviewPanelOptions,
    restored?: { visible: boolean; active: boolean; viewColumn: number | undefined },
  ): WebviewPanel => {
    const { placement, preserveFocus } = panelPlacement(showOptions);
    let html = "";
    let currentTitle = String(title ?? "");
    let icon: string | undefined;
    let visible = restored ? restored.visible : true;
    let viewColumn: number | undefined = restored?.viewColumn;
    const declaredRoots = rootPaths(options.localResourceRoots);
    // A column by number (VS Code's ViewColumn.One…Nine): that editor group, made if missing.
    const column = (() => {
      const c =
        showOptions !== null && typeof showOptions === "object"
          ? showOptions.viewColumn
          : showOptions;
      return typeof c === "number" && c >= 1 && c <= 9 ? Math.floor(c) : undefined;
    })();
    let active = restored ? restored.active : !preserveFocus;
    let disposed = false;
    let created = !!restored;
    /** Changes not yet sent (one request per turn). */
    let dirty: { html?: boolean; title?: boolean; icon?: boolean } | null = null;
    const messageListeners = new Set<(m: unknown) => void>();
    const stateListeners = new Set<(e: WebviewPanelViewState) => void>();
    const disposeListeners = new Set<() => void>();

    const listen = <L>(set: Set<L>, listener: L): Disposable => {
      set.add(listener);
      return { dispose: () => set.delete(listener) };
    };
    const ended = () => {
      if (disposed) return;
      disposed = true;
      off();
      for (const l of [...disposeListeners]) l();
      messageListeners.clear();
      stateListeners.clear();
      disposeListeners.clear();
    };
    // Created in a microtask: `html` and `title` set right after creating it go with it.
    const flush = () => {
      const changes = dirty;
      dirty = null;
      if (disposed) return;
      if (!created) {
        created = true;
        void request("webviewPanel.create", {
          id,
          viewType: String(viewType ?? ""),
          title: currentTitle,
          html,
          placement,
          ...(column !== undefined && { column }),
          preserveFocus,
          ...(icon && { icon }),
          ...(declaredRoots.length && { roots: declaredRoots }),
        }).catch((err: unknown) => {
          console.error(err instanceof Error ? err.message : String(err));
          ended();
        });
        return;
      }
      if (!changes) return;
      void request("webviewPanel.update", {
        id,
        ...(changes.html && { html }),
        ...(changes.title && { title: currentTitle }),
        ...(changes.icon && { icon: icon ?? "" }),
      }).catch(() => {});
    };
    const change = (what: "html" | "title" | "icon") => {
      if (disposed) return;
      const first = dirty === null;
      dirty = { ...dirty, [what]: true };
      if (first && created) queueMicrotask(flush);
    };
    if (!restored) queueMicrotask(flush);
    // A restored panel's roots reach the host with its first page.
    else if (declaredRoots.length)
      void request("webviewPanel.update", { id, roots: declaredRoots }).catch(() => {});

    const webview: Webview = {
      get html() {
        return html;
      },
      set html(value: string) {
        html = String(value ?? "");
        change("html");
      },
      options,
      postMessage: (message) => {
        if (disposed) return Promise.resolve(false);
        return request<boolean>("webviewPanel.post", { id, message }).then(
          (ok) => ok !== false,
          () => false,
        );
      },
      onDidReceiveMessage: (listener) => listen(messageListeners, listener),
      asWebviewUri: (path) =>
        webviewUri(extensionPath, path, [...workspaceRoots(), ...declaredRoots]),
      cspSource: "'self'",
    };
    const panel: WebviewPanel = {
      viewType: String(viewType ?? ""),
      get title() {
        return currentTitle;
      },
      set title(value: string) {
        currentTitle = String(value ?? "");
        change("title");
      },
      get iconPath() {
        return icon;
      },
      set iconPath(value: string | undefined) {
        icon = typeof value === "string" ? value : undefined;
        change("icon");
      },
      webview,
      options,
      get visible() {
        return visible;
      },
      get viewColumn() {
        return viewColumn;
      },
      get active() {
        return active;
      },
      reveal(viewColumn, preserve) {
        if (disposed) return;
        const where = viewColumn === undefined ? null : panelPlacement(viewColumn).placement;
        // After the create request: a reveal in the same turn must not overtake it.
        queueMicrotask(
          () =>
            void request("webviewPanel.reveal", {
              id,
              preserveFocus: preserve === true,
              ...(where && { placement: where }),
            }).catch(() => {}),
        );
      },
      onDidChangeViewState: (listener) => listen(stateListeners, listener),
      onDidDispose: (listener) => listen(disposeListeners, listener),
      dispose() {
        if (disposed) return;
        const wasCreated = created;
        ended();
        if (wasCreated) void request("webviewPanel.dispose", { id }).catch(() => {});
      },
    };
    const off = onCall(`webviewPanel.${id}`, (e: PanelEvent) => {
      if (disposed || !e || typeof e !== "object") return null;
      if (e.kind === "message") for (const l of [...messageListeners]) l(e.message);
      else if (e.kind === "state") {
        const nextVisible = e.visible === true;
        const nextActive = e.active === true;
        const nextColumn =
          typeof e.viewColumn === "number" && e.viewColumn >= 1 ? e.viewColumn : viewColumn;
        if (nextVisible === visible && nextActive === active && nextColumn === viewColumn)
          return null;
        visible = nextVisible;
        active = nextActive;
        viewColumn = nextColumn;
        for (const l of [...stateListeners]) l({ webviewPanel: panel });
      } else if (e.kind === "disposed") ended();
      return null;
    });
    return panel;
  };

  return {
    createWebviewPanel(viewType, title, showOptions, options = {}) {
      return makePanel(`panel${++seq}`, viewType, title, showOptions, options);
    },
    registerWebviewPanelSerializer(viewType, serializer) {
      const type = String(viewType ?? "");
      const off = onCall(`webviewPanelSerializer.${type}`, async (args: RestoreArgs) => {
        const id = String(args?.id ?? "");
        if (!/^[\w-]{1,40}$/.test(id)) throw new Error("Bad panel id.");
        const panel = makePanel(
          id,
          type,
          typeof args.title === "string" ? args.title : "",
          undefined,
          // VS Code restores a panel with scripts on (its serializer's page needs them).
          { enableScripts: true },
          {
            visible: args.visible === true,
            active: args.active === true,
            viewColumn:
              typeof args.viewColumn === "number" && args.viewColumn >= 1
                ? args.viewColumn
                : undefined,
          },
        );
        await serializer.deserialize(panel, args.state ?? undefined);
        return null;
      });
      void request("webviewPanel.serializer", { viewType: type, register: true }).catch(() => {});
      return {
        dispose: () => {
          off();
          void request("webviewPanel.serializer", { viewType: type, register: false }).catch(
            () => {},
          );
        },
      };
    },
  };
}
