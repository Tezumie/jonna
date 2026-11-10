// Webview panels an extension's code opens at run time (`ide.ui.createWebviewPanel`, D247, VS Code's
// `window.createWebviewPanel`; worker side core/extensions/rpcWebviewPanels.ts). Each is a dock
// tab of the view type `extpanel:<extension id>` showing a WebviewFrame (webview.ts): the same
// frame, origin, CSP and theme message as a declared `"type": "webview"` view. The page is the
// HTML the code set, served by the extension folder's proxy at `/__webview-<name>.html`
// (`ext_webview_page`): a new name per change, so the frame loads it fresh and relative URLs
// reach the extension's files. The worker hears the page's messages, the tab's view state
// (visible / active) and its closing through "provider" calls on `webviewPanel.<id>`.
// A panel whose view type the extension can restore (a serializer its code registered, or
// `onWebviewPanel:<viewType>` in its activation events) is saved with the folder's state, with the
// state its page last saved; after a restart its tab opens again, the extension starts and its
// serializer fills the page (`webviewPanelSerializer.<viewType>`, VS Code's
// deserializeWebviewPanel).
import { allGroups, type Json } from "../../core/dock/index";
import { h } from "../../core/dom/index";
import { Emitter } from "../../core/events/index";
import type { ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { extIpc } from "../../core/ipc/extensions";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { effect, untracked } from "../../core/reactive/index";
import { imageIcon } from "../../ui/Icon";
import type { OpenPlacement } from "../../workbench/dock/service";
import { type DockView, stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { MAX_PANEL_STATE, type SavedPanel } from "../../workbench/webviewPanelRestore";
import { UNHANDLED } from "./runtimeApi";
import { safeIcon } from "./treeView";
import { WebviewFrame, withPageSetup } from "./webview";
import type { ExtensionWorker } from "./workerHost";

/** At most this many panels open per extension. */
const MAX_PANELS = 50;
/** A panel's HTML (the proxy refuses more than 8 MB). */
const MAX_HTML = 8 * 1024 * 1024;

export interface WebviewPanelsDeps {
  manifest: ThirdPartyManifest;
  services: WorkbenchServices;
  /** The extension's folder (what its proxy serves). */
  root: string;
  origin(): Promise<string>;
  /** The worker if it runs (panels never start it, except a restored one: its serializer). */
  running(): ExtensionWorker | null;
  /** Starts the worker (a restored panel's serializer is in its code). */
  worker(): Promise<ExtensionWorker>;
  /** Folders its pages may read files from (declared localResourceRoots). */
  allowRoots?(roots: readonly string[]): void;
  /** A file of the extension as an image URL (a panel's own icon, D263), or null. */
  image?(path: string): Promise<string | null>;
}

/** A panel icon that is an image file of the extension rather than an icon name. */
const ICON_FILE = /\.(svg|png|jpe?g|gif|webp)$/i;

interface Panel {
  id: string;
  viewType: string;
  title: string;
  icon: ReturnType<typeof safeIcon>;
  /** The page's current name on the proxy (empty until the first one is served). */
  page: string;
  version: number;
  tabId: string | null;
  frame: WebviewFrame | null;
  changed: Emitter<void>;
  /** Closed by the code (no "disposed" back to it). */
  closing: boolean;
  /** Its entry in `extensionFeatures.webviewPanels` (state), removed when it closes. */
  listed: Disposable | null;
  /** What the worker last heard. */
  state: { visible: boolean; active: boolean; viewColumn?: number | undefined };
  /** Its own icon file as an image URL (VS Code's `iconPath`), once read. */
  iconImage: string | null;
  /** Its HTML being served: messages sent meanwhile wait for the new page (D261). */
  settling: Promise<void>;
  /** What its page last gave `setState` (saved to bring it back after a restart). */
  pageState?: unknown;
}

/** A restored panel's page until its serializer sets one. */
const BLANK_PAGE = "<!doctype html><html><head></head><body></body></html>";
/** How long a restored panel waits for its extension to register the serializer. */
const SERIALIZER_WAIT_MS = 10_000;

export class ExtensionWebviewPanels implements Disposable {
  private readonly store = new DisposableStore();
  private readonly panels = new Map<string, Panel>();
  /** Registered on the first panel. */
  private viewType: string | null = null;
  /** Page names of this run (an extension reload doesn't meet its old ones). */
  private readonly stamp = Date.now().toString(36);
  private disposed = false;

  /** View types its code registered a serializer for (VS Code's registerWebviewPanelSerializer). */
  private readonly serializers = new Set<string>();
  private restoredSeq = 0;

  constructor(private readonly deps: WebviewPanelsDeps) {}

  /**
   * Its panels of the folder's last session come back (once its contributions are in): those
   * waiting now, and those of a folder opened later.
   */
  contribute(): void {
    if (!this.deps.manifest.main) return;
    this.store.add(
      effect(() => {
        this.deps.services.extensionFeatures.restorablePanels.pending.value;
        untracked(() => this.restorePending());
        return undefined;
      }),
    );
  }

  /** It can bring a panel of `viewType` back: a serializer, or the activation event for one. */
  private canRestore(viewType: string): boolean {
    return (
      this.serializers.has(viewType) ||
      this.deps.manifest.activation.includes(`onWebviewPanel:${viewType}`)
    );
  }

  private restorePending(): void {
    if (this.disposed) return;
    const { manifest, services } = this.deps;
    const saved = services.extensionFeatures.restorablePanels.take(manifest.id, (viewType) =>
      this.canRestore(viewType),
    );
    for (const panel of saved) void this.restore(panel);
  }

  /** Opens a saved panel's tab, starts the code and hands the panel to its serializer. */
  private async restore(saved: SavedPanel): Promise<void> {
    const { manifest, services } = this.deps;
    if (this.panels.size >= MAX_PANELS) return;
    const id = `restored${++this.restoredSeq}`;
    const panel: Panel = {
      id,
      viewType: saved.viewType,
      title: saved.title || manifest.displayName,
      icon: safeIcon(undefined, "globe"),
      iconImage: null,
      page: "",
      version: 0,
      tabId: null,
      frame: null,
      changed: new Emitter<void>(),
      listed: null,
      settling: Promise.resolve(),
      closing: false,
      state: { visible: false, active: false },
      ...(saved.state !== undefined && { pageState: saved.state }),
    };
    this.panels.set(id, panel);
    try {
      panel.settling = this.setHtml(panel, BLANK_PAGE);
      await panel.settling;
    } catch {
      this.forget(panel);
      return;
    }
    if (panel.closing || this.disposed) return;
    const type = this.ensureViewType();
    // Its group if it's still there (the layout came back with the folder), else the editors.
    const inGroup =
      !!saved.groupId && allGroups(services.dock.root.peek()).some((g) => g.id === saved.groupId);
    panel.tabId = services.dock.openView(
      type,
      { panel: id },
      inGroup && saved.groupId ? { groupId: saved.groupId } : "main",
      false,
      saved.shown ? {} : { background: true },
    );
    this.list(panel);
    try {
      const worker = await this.deps.worker();
      const deadline = Date.now() + SERIALIZER_WAIT_MS;
      while (!this.serializers.has(panel.viewType) && Date.now() < deadline && !panel.closing)
        await new Promise((r) => setTimeout(r, 100));
      if (panel.closing) return;
      if (!this.serializers.has(panel.viewType))
        throw new Error(`No serializer for ${panel.viewType}.`);
      await worker.call("provider", `webviewPanelSerializer.${panel.viewType}`, {
        id,
        title: panel.title,
        state: panel.pageState ?? null,
        visible: panel.state.visible,
        active: panel.state.active,
        ...(panel.state.viewColumn !== undefined && { viewColumn: panel.state.viewColumn }),
      });
    } catch {
      // Nothing to show it with (VS Code drops such a panel too).
      this.close(panel);
    }
  }

  /** Its entry in the open panels (state, and what's saved for a restart). */
  private list(panel: Panel): void {
    const { manifest, services } = this.deps;
    panel.listed = services.extensionFeatures.webviewPanels.add({
      owner: manifest.id,
      id: panel.id,
      viewType: panel.viewType,
      title: () => panel.title,
      tabId: () => panel.tabId,
      saved: () => this.savedOf(panel),
    });
  }

  /** What brings it back after a restart; null when it can't come back. */
  private savedOf(panel: Panel): SavedPanel | null {
    if (panel.closing || !panel.tabId || !this.canRestore(panel.viewType)) return null;
    const group = this.deps.services.dock.findTab(panel.tabId)?.group;
    return {
      owner: this.deps.manifest.id,
      viewType: panel.viewType,
      title: panel.title,
      ...(panel.pageState !== undefined && { state: panel.pageState }),
      ...(group && { groupId: group.id }),
      ...(group?.activeTabId === panel.tabId && { shown: true }),
    };
  }

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    switch (method) {
      case "webviewPanel.create":
        return this.create(p);
      case "webviewPanel.update":
        return this.update(p);
      case "webviewPanel.post": {
        const panel = this.panels.get(String(p.id));
        if (!panel || panel.closing) return Promise.resolve(false);
        // After a page still being served (D261: VS Code delivers it to the new content).
        return panel.settling
          .catch(() => {})
          .then(() => {
            if (panel.closing) return false;
            panel.frame?.post(p.message);
            // A tab not shown yet (opened in the background) has no frame: the page gets it on load.
            if (!panel.frame) this.early(panel).push(p.message);
            return true;
          });
      }
      case "webviewPanel.reveal": {
        const panel = this.panels.get(String(p.id));
        if (panel?.tabId) this.reveal(panel.tabId, p.preserveFocus !== true);
        return Promise.resolve(undefined);
      }
      case "webviewPanel.dispose": {
        const panel = this.panels.get(String(p.id));
        if (panel) this.close(panel);
        return Promise.resolve(undefined);
      }
      case "webviewPanel.serializer": {
        // Its code registered (or dropped) a serializer: panels of that type can come back.
        const viewType = String(p.viewType ?? "").slice(0, 100);
        if (!viewType) return Promise.resolve(undefined);
        if (p.register === false) this.serializers.delete(viewType);
        else if (this.serializers.size < 50) {
          this.serializers.add(viewType);
          this.restorePending();
        }
        return Promise.resolve(undefined);
      }
      default:
        return UNHANDLED;
    }
  }

  /** Messages for a panel whose tab hasn't been created yet. */
  private readonly pending = new Map<string, unknown[]>();
  private early(panel: Panel): unknown[] {
    let list = this.pending.get(panel.id);
    if (!list) {
      list = [];
      this.pending.set(panel.id, list);
    }
    if (list.length > 200) list.shift();
    return list;
  }

  private async create(p: Record<string, unknown>): Promise<unknown> {
    const { manifest, services } = this.deps;
    if (this.disposed) throw new Error(`${manifest.displayName} has stopped.`);
    const id = String(p.id ?? "");
    if (!/^[\w-]{1,40}$/.test(id) || this.panels.has(id)) throw new Error("Bad panel id.");
    if (this.panels.size >= MAX_PANELS)
      throw new Error(`${manifest.displayName} has ${MAX_PANELS} panels open already.`);
    const panel: Panel = {
      id,
      viewType: String(p.viewType ?? "").slice(0, 100),
      title: String(p.title ?? "").slice(0, 200) || manifest.displayName,
      icon: safeIcon(typeof p.icon === "string" ? p.icon : undefined, "globe"),
      iconImage: null,
      page: "",
      version: 0,
      tabId: null,
      frame: null,
      changed: new Emitter<void>(),
      listed: null,
      settling: Promise.resolve(),
      closing: false,
      state: { visible: false, active: false },
    };
    this.panels.set(id, panel);
    this.allowRoots(p.roots);
    if (typeof p.icon === "string") this.setIconImage(panel, p.icon);
    try {
      panel.settling = this.setHtml(panel, typeof p.html === "string" ? p.html : "");
      await panel.settling;
    } catch (err) {
      this.forget(panel);
      throw err;
    }
    if (panel.closing || this.disposed) return undefined;
    const type = this.ensureViewType();
    const placement =
      typeof p.column === "number"
        ? this.columnPlacement(p.column)
        : this.placement(String(p.placement ?? "main"));
    panel.tabId = services.dock.openView(type, { panel: id }, placement, p.preserveFocus !== true);
    this.list(panel);
    return { tabId: panel.tabId };
  }

  private async update(p: Record<string, unknown>): Promise<unknown> {
    const panel = this.panels.get(String(p.id));
    if (!panel || panel.closing) return undefined;
    this.allowRoots(p.roots);
    if (typeof p.title === "string" || typeof p.icon === "string") {
      if (typeof p.title === "string")
        panel.title = p.title.slice(0, 200) || this.deps.manifest.displayName;
      if (typeof p.icon === "string") {
        panel.icon = safeIcon(p.icon || undefined, "globe");
        this.setIconImage(panel, p.icon);
      }
      panel.changed.fire();
    }
    if (typeof p.html === "string") {
      panel.settling = this.setHtml(panel, p.html);
      await panel.settling;
    }
    return undefined;
  }

  /** A panel's icon file, read as an image; an icon name or nothing clears it. */
  private setIconImage(panel: Panel, icon: string): void {
    if (!ICON_FILE.test(icon) || !this.deps.image) {
      panel.iconImage = null;
      return;
    }
    void this.deps.image(icon).then((url) => {
      if (panel.closing) return;
      panel.iconImage = url;
      panel.changed.fire();
    });
  }

  /** Serves `html` under a new name, shows it, then drops the old page. */
  private async setHtml(panel: Panel, html: string): Promise<void> {
    if (html.length > MAX_HTML) throw new Error("A panel's HTML is limited to 8 MB.");
    const version = ++panel.version;
    const name = `${this.stamp}-${panel.id}-${version}`;
    await extIpc.webviewPage(
      this.deps.root,
      name,
      withPageSetup(
        html,
        this.deps.services,
        `panel:${this.stamp}-${panel.id}`,
        false,
        // The state its page saved before a restart: getState() returns it.
        panel.pageState,
      ),
    );
    // A newer one (or the panel's closing) overtook this one: it isn't shown.
    if (version !== panel.version || panel.closing) {
      void extIpc.webviewPage(this.deps.root, name, null).catch(() => {});
      return;
    }
    const old = panel.page;
    panel.page = name;
    panel.frame?.navigate(pagePath(name));
    if (old) void extIpc.webviewPage(this.deps.root, old, null).catch(() => {});
  }

  private placement(where: string): OpenPlacement | undefined {
    const { dock } = this.deps.services;
    if (where === "bottom" || where === "right") return where;
    if (where === "beside") {
      // Beside the editor group in use (VS Code's ViewColumn.Beside).
      const group = dock.focusedGroup() ?? dock.findTab(dock.activeTab()?.id ?? "")?.group;
      return group ? { groupId: group.id, split: "right" } : "main";
    }
    return undefined;
  }

  /**
   * VS Code's ViewColumn.One…Nine: that editor group (in layout order); one past the last is a
   * new group to the right of it, as VS Code makes it.
   */
  private columnPlacement(column: number): OpenPlacement | undefined {
    const { dock } = this.deps.services;
    const panels = new Set(
      [...dock.regionGroups("bottom"), ...dock.regionGroups("right")].map((g) => g.id),
    );
    const groups = allGroups(dock.root.peek()).filter((g) => !panels.has(g.id));
    const at = groups[Math.max(0, Math.floor(column) - 1)];
    if (at) return { groupId: at.id };
    const last = groups.at(-1);
    return last ? { groupId: last.id, split: "right" } : "main";
  }

  private reveal(tabId: string, focus: boolean): void {
    const { dock } = this.deps.services;
    const group = dock.findTab(tabId)?.group;
    if (group?.hidden) dock.setGroupsHidden([group.id], false);
    dock.activateTab(tabId, focus);
  }

  /** The code closed it: the tab goes, the worker already knows. */
  private close(panel: Panel): void {
    if (panel.closing) return;
    panel.closing = true;
    this.forget(panel);
    if (panel.tabId) void this.deps.services.dock.closeTab(panel.tabId, true);
  }

  /** Drops what the panel holds (its page on the proxy, its pending messages). */
  private forget(panel: Panel): void {
    this.panels.delete(panel.id);
    this.pending.delete(panel.id);
    panel.version++;
    if (panel.page) void extIpc.webviewPage(this.deps.root, panel.page, null).catch(() => {});
    panel.page = "";
    panel.changed.dispose();
    panel.listed?.dispose();
    panel.listed = null;
  }

  private notify(panel: Panel, event: Record<string, unknown>): void {
    this.deps.running()?.notify("provider", `webviewPanel.${panel.id}`, event);
  }

  private ensureViewType(): string {
    if (this.viewType) return this.viewType;
    const { manifest, services } = this.deps;
    const type = `extpanel:${manifest.id}`;
    this.viewType = type;
    const panelOf = (state: Json) => this.panels.get(String(stateField(state, "panel") ?? ""));
    this.store.add(
      services.dock.views.register({
        type,
        title: (state) => panelOf(state)?.title ?? manifest.displayName,
        icon: (state) => panelOf(state)?.icon ?? safeIcon(undefined, "globe"),
        // Its own icon file (VS Code's `iconPath`, D263).
        iconElement: (state) => {
          const url = panelOf(state)?.iconImage;
          return url ? imageIcon(url) : undefined;
        },
        tooltip: (state) => `${panelOf(state)?.title ?? ""} (${manifest.displayName})`,
        editorLike: true,
        defaultPlacement: "main",
        detachable: true,
        create: (state, ctx): DockView => {
          const panel = panelOf(state);
          if (!panel || panel.closing) {
            // A tab whose panel is gone (its extension reloaded): it closes.
            queueMicrotask(() => ctx.close());
            return {
              element: h("div", { class: "empty-state" }, "This panel has closed."),
              serialize: () => null,
              persist: () => false,
              dispose: () => {},
            };
          }
          const views = new DisposableStore();
          const frame = new WebviewFrame(
            services,
            {
              path: panel.page ? pagePath(panel.page) : "",
              origin: () => this.deps.origin(),
              receive: (message) => {
                if (!panel.closing) this.notify(panel, { kind: "message", message });
              },
              // Kept to bring the panel back after a restart (saved with the folder's state).
              state: (state) => {
                if (panel.closing) return;
                const json = safeJson(state);
                if (json !== undefined && json.length > MAX_PANEL_STATE) return;
                panel.pageState = json === undefined ? undefined : JSON.parse(json);
                services.persistence.scheduleSave();
              },
            },
            panel.title,
          );
          views.add(frame);
          panel.frame = frame;
          for (const m of this.pending.get(panel.id)?.splice(0) ?? []) frame.post(m);
          views.add(
            toDisposable(() => {
              if (panel.frame === frame) panel.frame = null;
              // The user closed the tab (not the code): the panel ends, and the code hears it.
              if (!panel.closing) {
                panel.closing = true;
                this.forget(panel);
                this.notify(panel, { kind: "disposed" });
              }
            }),
          );
          return {
            element: frame.element,
            title: () => panel.title,
            onDidChange: panel.changed.event,
            onWindowChanged: (win) => frame.onWindowChanged(win),
            serialize: () => ({ panel: panel.id }),
            // A panel lives as long as the code that made it: not after a restart.
            persist: () => false,
            dispose: () => views.dispose(),
          };
        },
      }),
    );
    // Visible (its tab shown in its group) and active (that group focused): the code hears
    // changes, as VS Code's onDidChangeViewState.
    this.store.add(
      effect(() => {
        const root = services.dock.root.value;
        const focused = services.dock.focusedGroupId.value;
        // VS Code's viewColumn: the panel's editor group, counted in layout order (1-based).
        const panelGroups = new Set(
          [...services.dock.regionGroups("bottom"), ...services.dock.regionGroups("right")].map(
            (g) => g.id,
          ),
        );
        const editorGroups = allGroups(root)
          .filter((g) => !panelGroups.has(g.id))
          .map((g) => g.id);
        for (const panel of this.panels.values()) {
          if (!panel.tabId || panel.closing) continue;
          const group = services.dock.findTab(panel.tabId)?.group;
          const visible = !!group && !group.hidden && group.activeTabId === panel.tabId;
          const active = visible && focused === group?.id;
          const at = group ? editorGroups.indexOf(group.id) : -1;
          const viewColumn = at >= 0 ? at + 1 : undefined;
          if (
            visible === panel.state.visible &&
            active === panel.state.active &&
            viewColumn === panel.state.viewColumn
          )
            continue;
          panel.state = { visible, active, viewColumn };
          this.notify(panel, {
            kind: "state",
            visible,
            active,
            ...(viewColumn !== undefined && { viewColumn }),
          });
        }
        return undefined;
      }),
    );
    // Its tabs close when it stops, before the view type goes (disposal runs in reverse).
    this.store.add(toDisposable(() => this.closeAll()));
    return type;
  }

  private closeAll(): void {
    for (const panel of [...this.panels.values()]) this.close(panel);
  }

  /** Declared localResourceRoots: its pages may read their files (inside the workspace). */
  private allowRoots(raw: unknown): void {
    const roots = Array.isArray(raw)
      ? raw.filter((r): r is string => typeof r === "string").slice(0, 20)
      : [];
    if (roots.length) this.deps.allowRoots?.(roots);
  }

  /** The worker went away: what its code opened closes. */
  workerGone(): void {
    this.serializers.clear();
    this.closeAll();
  }

  dispose(): void {
    this.disposed = true;
    this.closeAll();
    this.store.dispose();
  }
}

function safeJson(v: unknown): string | undefined {
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
}

function pagePath(name: string): string {
  return `__webview-${name}.html`;
}
