// The `browser` dock view: a toolbar (back, forward, reload, the address field with device size
// and own window inside it, element picker, DevTools with error counts, more), the page — in the
// tab's frame through the preview proxy (local dev servers, workspace files); other sites in a
// webview over the tab (`browser.embedSites`, embed.ts) or in their own window — with an
// optional device viewport, and DevTools under or beside it on a resizable split. The tab owns one
// `Page` (page.ts) that the DevTools panels, commands and agents all talk to.
import type { Json } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { Emitter } from "../../core/events/index";
import { browserIpc, type NetEvent } from "../../core/ipc/browser";
import { DisposableStore } from "../../core/lifecycle/index";
import { basename } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { icon } from "../../ui/Icon";
import { showMenu } from "../../ui/Menu";
import { Sash } from "../../ui/Sash";
import { setTooltip } from "../../ui/Tooltip";
import type { DockView, DockViewContext } from "../../workbench/dock/views";
import { stateField } from "../../workbench/dock/views";
import { captureRect, captureWindow, nextPaint, type Shot } from "../../workbench/screenshot";
import type { WorkbenchServices } from "../../workbench/services";
import {
  type Address,
  displayAddress,
  fileUrl,
  parseAddress,
  pathFromUrl,
  rootFor,
  rootsOf,
} from "./address";
import { renderDeviceBar } from "./deviceBar";
import type { Viewport } from "./devices";
import type { ElementsPanel } from "./devtools/elements";
import { Devtools, type DevtoolsTab } from "./devtools/index";
import { EmbeddedSite } from "./embed";
import { type FormSubmission, proxies } from "./links";
import {
  forgetTab,
  handleRequest,
  openerClosed,
  type PendingForm,
  type PopupLink,
  popupClosed,
  readPopup,
  type TabExtras,
} from "./opening";
import { type NetRequest, Page, problemCounts } from "./page";
import { type InputSink, webviewSink } from "./trustedInput";
import {
  devtoolsHostFor,
  findWorkspaceFile,
  moreMenuItems,
  renderCounts,
  serverList,
} from "./viewParts";
import {
  addressFromState,
  MIN_DEVTOOLS,
  ResizeObserverDisposable,
  readOptions,
  type ViewOptions,
} from "./viewState";
import { buildToolbar } from "./viewToolbar";

export { addressFromState };

export interface BrowserHost {
  services: WorkbenchServices;
  /** Live browser views by tab id. */
  views: Map<string, BrowserView>;
  /** External windows by label → their view. */
  windows: Map<string, BrowserView>;
  run(command: string, input?: unknown): void;
  /** Opens a new browser tab beside the current one (a page's target=_blank or window.open). */
  openTab(address: Address, opener: string, extras?: TabExtras): Promise<string>;
  /** The form a new tab was opened to post (by the token in its state), taken once. */
  takeForm(token: unknown): PendingForm | null;
}

/** The proxy page a tab posts a form from (proxy.rs POST_PATH). */
const POST_PATH = "/__ide/post";

const SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-pointer-lock";

export class BrowserView implements DockView {
  readonly element: HTMLElement;
  readonly page: Page;
  private readonly store = new DisposableStore();
  private readonly changed = this.store.add(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  private readonly frame: HTMLIFrameElement;
  private readonly popButton: HTMLElement;
  private readonly frameBox: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly main: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly note: HTMLElement;
  /** Error / warning badges on the DevTools button. */
  private readonly counts: HTMLElement;
  private readonly deviceBar: HTMLElement;
  private readonly pickButton: HTMLButtonElement;
  private readonly devtoolsButton: HTMLButtonElement;
  readonly devtools: Devtools;
  private readonly devtoolsBox: HTMLElement;
  private readonly sash: Sash;
  private options: ViewOptions;
  private address: Address | null;
  /** Origin of the proxy the frame currently loads (bridge messages must come from it). */
  proxyOrigin: string | null = null;
  private targetOrigin: string | null = null;
  /** Bumped by each load(); an older load seeing a newer token stops after its await. */
  private loadToken = 0;
  /** External window label, when the page is shown there. */
  windowLabel: string | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private picking = false;
  /** Set when another tab's `window.open` opened this one (the relay to its opener, D209). */
  readonly popup: PopupLink | null;
  /** Stand-ins other tabs' pages hold for this tab (a named `window.open` that reused it). */
  readonly aliases: PopupLink[] = [];
  /** The tab's window name (`window.open(url, name)`, `target="name"`): the page's `window.name`. */
  readonly windowName: string;
  /** A form to post once the tab's passing page is up (a form posted into this tab). */
  private pendingForm: PendingForm | null;
  /** Another site shown inside this tab (its webview over the page area). */
  private readonly embed: EmbeddedSite;
  /** The device scale the page is shown at (device mode). */
  private deviceScale = 1;
  /** The local page a link to another site left (that site's window has no way back to it). */
  private returnTo: Address | null = null;

  constructor(
    state: Json,
    private readonly ctx: DockViewContext,
    private readonly host: BrowserHost,
  ) {
    const s = this.store;
    // The workspace's folder, or its folders (D251: a file shows with its folder's name).
    const root = () => rootsOf(host.services.workspace);
    this.address = addressFromState(state, root());
    this.options = readOptions(state);
    this.popup = readPopup(stateField(state, "popup"));
    const name = stateField(state, "name");
    this.windowName = typeof name === "string" ? name.slice(0, 200) : "";
    this.pendingForm = host.takeForm(stateField(state, "formToken"));
    this.page = new Page(
      ctx.tabId,
      "frame",
      (m) => this.transport(m),
      (u) => this.mapUrl(u),
    );
    s.add({ dispose: () => this.page.dispose() });

    const toolbar = buildToolbar(s, {
      go: (text) => {
        void this.go(text).catch((err: unknown) => this.showError(err));
        this.frame.focus();
      },
      shownAddress: () => (this.address ? displayAddress(this.address, root()) : ""),
      back: () => void this.history("back"),
      forward: () => void this.history("forward"),
      reload: () => this.reload(),
      togglePick: () => void this.togglePick(),
      devtools: () => {
        if (!this.options.devtools && problemCounts(this.page).errors > 0)
          this.openDevtools("console");
        else this.toggleDevtools();
      },
      openInSystem: () => this.openInSystem(),
      toggleWindow: () => this.toggleWindow(),
      more: (anchor) => this.moreMenu(anchor),
      loading: () => this.page.loading.value,
    });
    this.input = toolbar.input;
    this.counts = toolbar.counts;
    this.pickButton = toolbar.pickButton;
    this.devtoolsButton = toolbar.devtoolsButton;
    this.popButton = toolbar.popButton;
    const bar = toolbar.bar;
    this.deviceBar = h("div", { class: "browser-devicebar", hidden: true });
    this.frame = h("iframe", {
      class: "browser-frame",
      sandbox: SANDBOX,
      allow: "clipboard-read; clipboard-write; fullscreen; geolocation; camera; microphone",
      "aria-label": "Page",
      // What the bridge reads about its tab (window.name lasts across the frame's pages).
      ...((this.popup || this.windowName) && {
        name: `ide-tab:${JSON.stringify({
          ...(this.popup && { popup: this.popup.id }),
          ...(this.windowName && { name: this.windowName }),
        })}`,
      }),
    });
    // What shows in place of another site's webview while an overlay covers it (embed.ts).
    const snapshot = h("img", { class: "browser-snapshot", alt: "", hidden: true });
    this.frameBox = h("div", { class: "browser-framebox" }, this.frame, snapshot);
    this.note = h("div", { class: "empty-state browser-note", hidden: true });
    this.stage = h("div", { class: "browser-stage" }, this.frameBox, this.note);
    this.devtoolsBox = h("div", { class: "browser-devtools" });
    this.main = h("div", { class: "browser-main" }, this.stage, this.devtoolsBox);
    this.element = h("div", { class: "browser-view" }, bar, this.deviceBar, this.main);
    this.devtools = s.add(
      new Devtools(devtoolsHostFor(this, host), {
        toggleSide: () => {
          this.options.side = this.options.side === "bottom" ? "right" : "bottom";
          this.layout();
          this.saveState();
        },
        close: () => this.toggleDevtools(false),
        side: () => this.options.side,
        toggleDevice: () => this.toggleDeviceBar(),
        deviceOn: () => !this.deviceBar.hidden,
      }),
    );
    this.devtools.active = this.options.tab;
    this.embed = s.add(
      new EmbeddedSite(
        this.frameBox,
        snapshot,
        host.services,
        () => this.deviceScale,
        () => {
          this.closeSite();
          if (this.address) void this.load(this.address).catch((e: unknown) => this.showError(e));
        },
      ),
    );
    this.devtoolsBox.append(this.devtools.element);
    let startSize = 0;
    this.sash = s.add(
      new Sash(this.main, {
        orientation: this.options.side === "right" ? "vertical" : "horizontal",
        // From the size on screen (it may be smaller than the saved one in a narrow tab).
        onStart: () =>
          (startSize =
            this.options.side === "right"
              ? this.devtoolsBox.offsetWidth
              : this.devtoolsBox.offsetHeight),
        onDrag: (d) => {
          const total =
            this.options.side === "right" ? this.main.clientWidth : this.main.clientHeight;
          this.options.size = Math.max(MIN_DEVTOOLS, Math.min(total - 80, startSize - d));
          this.layout();
        },
        onEnd: () => this.saveState(),
        onReset: () => {
          this.options.size = 280;
          this.layout();
          this.saveState();
        },
      }),
    );
    this.main.insertBefore(this.sash.element, this.devtoolsBox);
    s.add(new ResizeObserverDisposable(this.stage, () => this.fitViewport()));

    // The frame posts to the window it is in (the main one, or an auxiliary window).
    this.listenTo(window);
    s.add(
      on(this.frame, "load", () => {
        // The bridge says "ready" on its own; hello covers a bridge that loaded before us.
        this.hello();
        this.page.loading.value = false;
      }),
    );
    s.add(
      this.page.onDidNavigate((url) => {
        // A folder's proxy shows workspace files; a dev server's (or another site), URLs. The
        // proxy can change under the page (history across ports), so ask which it is now.
        if (this.page.proxied && this.proxyOrigin && !this.targetOrigin) {
          const r = this.proxyRoot();
          const path = r ? pathFromUrl(this.proxyOrigin, r, this.rawUrl(url)) : null;
          if (path) this.address = { kind: "file", path };
        } else if (url) this.address = parseAddress(url, root()) ?? this.address;
        this.saveState();
      }),
    );
    s.add(
      this.page.onRequest(
        (request) =>
          void handleRequest(this, host, request).catch((err: unknown) => this.showError(err)),
      ),
    );
    s.add(
      this.page.onKey((chord) => {
        if (chord === "devtools") this.toggleDevtools();
        else if (chord === "inspect") void this.togglePick();
        else if (chord === "address") this.focusAddress();
        else this.reload();
      }),
    );
    s.add(
      this.page.onPicked(() => {
        this.picking = false;
        this.pickButton.classList.remove("is-active");
      }),
    );
    // DevTools reloads only for a new document (its bridge's "ready", counted by the page, which
    // works even when the old document's "leave" was lost). Title changes (a ticking clock in
    // document.title) and same-document pushState navigations keep the Elements tree, as in
    // Chrome's and VS Code's DevTools, instead of reloading it each time.
    let seenDocuments = 0;
    s.add(
      effect(() => {
        this.page.title.value;
        this.page.url.value;
        const connected = this.page.connected.value;
        if (document.activeElement !== this.input)
          this.input.value = this.address ? displayAddress(this.address, root()) : "";
        const documents = this.page.documents.value;
        if (connected && documents !== seenDocuments) this.devtools.pageChanged();
        seenDocuments = documents;
        this.changed.fire();
        return undefined;
      }),
    );
    s.add(effect(() => renderCounts(this.page, this.counts, this.devtoolsButton)));
    host.views.set(ctx.tabId, this);
    s.add({
      dispose: () => {
        if (host.views.get(ctx.tabId) === this) host.views.delete(ctx.tabId);
        this.closeSite();
        if (this.popup) popupClosed(host, this.popup);
        openerClosed(host, ctx.tabId);
        forgetTab(ctx.tabId);
        clearTimeout(this.reloadTimer);
      },
    });
    this.layout();
    this.renderDeviceBar();
    if (this.address) void this.load(this.address).catch((err: unknown) => this.showError(err));
    else
      this.showNote(
        "Open a page",
        "Type a dev server address (localhost:5173), a file in this folder (index.html) or a web address. Servers your terminals start show up in the status bar.",
        ...this.serverButtons(),
      );
  }

  get tabId(): string {
    return this.ctx.tabId;
  }

  private readonly windowListener = this.store.add(new DisposableStore());
  /** The buttons of the note shown now: replaced with the note, not kept for the tab's life. */
  private readonly noteActions = this.store.add(new DisposableStore());

  private listenTo(win: Window): void {
    this.windowListener.clear();
    this.windowListener.add(on(win, "message", (e) => this.onFrameMessage(e as MessageEvent)));
  }

  /** Moved into (or back from) an auxiliary window: the frame reloaded there. */
  onWindowChanged(win: Window): void {
    this.embed.windowChanged(win);
    this.listenTo(win);
    if (this.embed.open) return;
    this.page.connected.value = false;
    this.renderToolbarState();
    // Some engines keep the frame's document alive across the move (no reload, no load event):
    // say hello again so its bridge reports ready to the new parent window.
    setTimeout(() => this.hello(), 50);
    setTimeout(() => {
      if (!this.page.connected.peek()) this.hello();
    }, 600);
  }

  get current(): Address | null {
    return this.address;
  }

  /**
   * A screenshot of the page as shown: its own window, or the frame (at the device size, without
   * the toolbar or DevTools). The tab is brought to the front first if it is hidden.
   */
  async capture(maxSide?: number): Promise<Shot> {
    if (this.windowLabel && this.embed.open) {
      // The site's webview is captured by itself; it must be shown (its tab in front).
      this.host.services.dock.activateTab(this.ctx.tabId, false);
      await nextPaint();
      await new Promise((r) => setTimeout(r, 150));
    }
    if (this.windowLabel) return captureWindow(this.windowLabel, maxSide);
    if (!this.address || this.frameBox.hidden) throw new Error("The tab has no page to capture.");
    if (this.frame.getBoundingClientRect().width === 0) {
      this.host.services.dock.activateTab(this.ctx.tabId, false);
      await nextPaint();
    }
    await nextPaint();
    const win = this.element.ownerDocument.defaultView;
    const label = win && win !== window ? this.host.services.auxWindows.labelOf(win) : null;
    return captureRect(
      this.frame.getBoundingClientRect(),
      maxSide,
      win && label ? { win, label } : null,
    );
  }

  /** Where trusted input goes (D346): the webview showing the page, and the frame in it. */
  inputSink(): InputSink | string {
    const win = this.element.ownerDocument.defaultView;
    const label =
      this.windowLabel ??
      (win && win !== window ? this.host.services.auxWindows.labelOf(win) : "main");
    return webviewSink(this.host.services.platform, label, this.windowLabel ? null : this.frame);
  }

  /**
   * Whether a capture now shows the page without bringing its tab forward (D340: a recording's
   * frames never take the user's view away): its own window, or a frame or embedded site on screen.
   */
  get onScreen(): boolean {
    if (this.windowLabel && !this.embed.open) return true;
    const box = (this.windowLabel ? this.element : this.frame).getBoundingClientRect();
    return box.width > 0 && box.height > 0 && (!!this.windowLabel || !this.frameBox.hidden);
  }

  /** The empty tab offers the servers terminals printed (filled in once known). */
  private serverButtons(): HTMLElement[] {
    return [
      serverList(this.host.services.dispatcher, (url) =>
        this.go(url).catch((err: unknown) => this.showError(err)),
      ),
    ];
  }

  // ---- Navigation -----------------------------------------------------------------------------

  /** Navigates to what the user typed (or an agent asked for). */
  async go(text: string): Promise<void> {
    const address = parseAddress(text, rootsOf(this.host.services.workspace));
    if (!address) throw new Error(`"${text}" isn't an address.`);
    this.returnTo = null;
    await this.load(address);
  }

  /**
   * Where the page itself wants to go (D209): another local server through its own proxy, by
   * the page's own navigation so history and the form's body stay as a browser has them; another
   * site in the tab's window (remembering the local page to come back to).
   */
  async navigateTo(
    address: Address,
    options: { replace?: boolean; form?: FormSubmission } = {},
  ): Promise<void> {
    if (address.kind === "local" && this.page.proxied) {
      const target = new URL(address.url);
      const info = await browserIpc.proxy(target.origin);
      proxies.remember(info.origin, info.target);
      const url = `${info.origin}${target.pathname}${target.search}${target.hash}`;
      // A redirect's goto page: replaced in the frame's history (Location.replace works across
      // origins), so Back doesn't land on it and bounce forward again.
      if (options.replace && !options.form && this.page.kind === "frame") {
        this.frame.contentWindow?.location.replace(url);
        return;
      }
      const done = this.page.connected.peek()
        ? options.form
          ? this.page.call("submitForm", { action: url, ...options.form })
          : this.page.call("navigate", { url, replace: options.replace === true })
        : Promise.reject(new Error("not connected"));
      if (await done.then(() => true).catch(() => false)) return;
    }
    if (address.kind === "external" && this.address && this.address.kind !== "external")
      this.returnTo = this.address;
    // A form for another site: posted from this tab's passing page, so its body isn't lost.
    if (options.form && address.kind !== "file")
      this.pendingForm = { action: address.url, form: options.form, via: this.proxyOrigin };
    await this.load(address);
  }

  /** A page asked for this tab by name (a named target): show `address`, posting `form` there. */
  async openFromPage(address: Address, form?: PendingForm): Promise<void> {
    if (form) {
      this.pendingForm = form;
      await this.load(address);
    } else await this.navigateTo(address);
  }

  /** Where the page is shown, for agents: the frame, a site's webview in the tab, or a window. */
  get shownIn(): "frame" | "tab" | "window" {
    return this.embed.open ? "tab" : this.page.kind;
  }

  /** The origin of the page as the user knows it (the dev server's, or the site's). */
  realOrigin(): string | null {
    try {
      return new URL(this.page.url.peek()).origin;
    } catch {
      return this.proxyOrigin;
    }
  }

  close(): void {
    this.ctx.close();
  }

  /**
   * Shows `address`. Local pages (dev servers, workspace files) show in the tab's frame, or — when
   * popped out (`inWindow`, remembered per tab) — in their own window, still through the proxy so
   * live reload, the network log and DevTools keep working. Other sites always get a window.
   */
  async load(address: Address, inWindow?: boolean): Promise<void> {
    // Two quick navigations: the earlier one's proxy can answer last. Only the latest load
    // may touch the frame or window after an await.
    const token = ++this.loadToken;
    if (inWindow !== undefined) this.options.popped = inWindow;
    this.address = address;
    this.saveState();
    this.page.beginLoad();
    const root = this.host.services.workspace.root.peek();
    if (address.kind === "external") {
      this.page.proxied = false;
      let url = address.url;
      const form = this.pendingForm;
      if (form) {
        // Posted from a passing page of a preview proxy (the posting tab's, else the folder's).
        const via =
          form.via ?? (root && (await browserIpc.proxy(root).catch(() => null))?.origin) ?? null;
        if (token !== this.loadToken) return;
        if (via) url = `${via}${POST_PATH}`;
        else this.pendingForm = null;
      }
      if (!this.options.popped && this.embedSites() && (await this.showEmbedded(url, token)))
        return;
      return this.openWindow(url, address.url, false, token);
    }
    let src: string;
    if (address.kind === "local") {
      const target = new URL(address.url);
      const info = await browserIpc.proxy(target.origin);
      proxies.remember(info.origin, info.target);
      if (token !== this.loadToken) return;
      this.proxyOrigin = info.origin;
      this.targetOrigin = target.origin;
      src = `${info.origin}${target.pathname}${target.search}${target.hash}`;
      // A form posted into this tab: sent from the proxy's passing page.
      if (this.pendingForm) {
        this.pendingForm = { ...this.pendingForm, action: src };
        src = `${info.origin}${POST_PATH}`;
      }
    } else {
      // The file's own folder is previewed (each folder of a multi-root workspace has its
      // proxy, D251).
      const folder = rootFor(rootsOf(this.host.services.workspace), address.path);
      if (!folder) throw new Error("Open a folder to preview its files.");
      const info = await browserIpc.proxy(folder);
      proxies.remember(info.origin, info.target);
      if (token !== this.loadToken) return;
      this.proxyOrigin = info.origin;
      this.targetOrigin = null;
      src = fileUrl(info.origin, folder, address.path);
    }
    this.page.proxied = true;
    const shown =
      address.kind === "local"
        ? address.url
        : displayAddress(address, rootsOf(this.host.services.workspace));
    if (this.options.popped) return this.openWindow(src, shown, true, token);
    // Back from a window (or a site's webview) to the frame.
    this.closeSite();
    this.page.kind = "frame";
    this.note.hidden = true;
    this.frameBox.hidden = false;
    this.page.url.value = shown;
    this.frame.src = src;
    this.renderToolbarState();
  }

  /** Pops the page out into its own window, or brings it back into the tab. */
  async popOut(out = !this.options.popped): Promise<void> {
    if (!this.address) return;
    await this.load(this.address, out);
  }

  get poppedOut(): boolean {
    return this.options.popped && !!this.windowLabel;
  }

  /** Whether other sites show inside the tab (the setting; a failure falls back to a window). */
  private embedSites(): boolean {
    return this.host.services.settings.peek<boolean>("browser.embedSites") === true;
  }

  /** Tells the page in a window or webview to go to `url` (connected or not: no waiting). */
  private sendNavigate(url: string): void {
    this.transport({ ns: "ide-host", type: "call", id: -1, method: "navigate", params: { url } });
  }

  /** Another site in a webview over this tab's page area; false if it can't be shown there. */
  private async showEmbedded(url: string, token: number): Promise<boolean> {
    // From a site's own window into the tab.
    if (this.windowLabel && !this.embed.open) this.closeSite();
    this.page.kind = "window";
    this.proxyOrigin = null;
    this.targetOrigin = null;
    this.frame.removeAttribute("src");
    this.frame.hidden = true;
    this.frameBox.classList.add("is-embedded");
    this.note.hidden = true;
    this.frameBox.hidden = false;
    if (this.embed.open) this.sendNavigate(url);
    else {
      let label: string;
      try {
        label = await this.embed.show(url, this.popup !== null, this.windowName || undefined);
      } catch {
        // A newer navigation took over while this one opened: it shows instead.
        if (token !== this.loadToken) return true;
        this.frame.hidden = false;
        this.frameBox.classList.remove("is-embedded");
        return false;
      }
      if (token !== this.loadToken) {
        this.embed.close();
        return true;
      }
      this.windowLabel = label;
      this.host.windows.set(label, this);
      this.helloForForm();
    }
    const shown = this.address?.kind === "external" ? this.address.url : url;
    this.page.url.value = shown;
    this.renderToolbarState();
    return true;
  }

  /** Closes the page's own window or its webview in the tab. */
  private closeSite(): void {
    const label = this.windowLabel;
    this.windowLabel = null;
    this.frame.hidden = false;
    this.frameBox.classList.remove("is-embedded");
    if (!label) return;
    this.host.windows.delete(label);
    if (this.embed.open) this.embed.close();
    else void browserIpc.closeWindow(label).catch(() => {});
  }

  private async openWindow(
    url: string,
    shown: string,
    proxied: boolean,
    token: number,
  ): Promise<void> {
    // From a site's webview in the tab to a window of its own.
    if (this.embed.open) this.closeSite();
    this.page.kind = "window";
    if (!proxied) {
      this.proxyOrigin = null;
      this.targetOrigin = null;
    }
    this.frameBox.hidden = true;
    this.frame.removeAttribute("src");
    if (this.windowLabel) this.sendNavigate(url);
    else {
      const label = await browserIpc.openWindow(
        url,
        shown,
        !proxied && this.popup !== null,
        this.windowName || undefined,
      );
      if (token !== this.loadToken) {
        // A newer load took over while this window opened; it shows its own page (frame or
        // window), so this one would only be a stray window showing the old address.
        void browserIpc.closeWindow(label).catch(() => {});
        return;
      }
      this.windowLabel = label;
      this.host.windows.set(label, this);
      this.helloForForm();
    }
    if (token !== this.loadToken) return;
    this.page.url.value = shown;
    this.renderToolbarState();
    const close = h("button", { class: "button button-secondary", type: "button" }, "Close window");
    this.noteActions.clear();
    this.noteActions.add(on(close, "click", () => this.ctx.close()));
    if (proxied) {
      const back = h(
        "button",
        { class: "button button-primary", type: "button" },
        "Show in this tab",
      );
      this.noteActions.add(on(back, "click", () => void this.popOut(false)));
      this.showNote(
        "Showing in its own window",
        "The page has its own window; this tab keeps the address bar, DevTools (console, network, elements) and agent tools. Live reload works there too.",
        back,
      );
      return;
    }
    this.showNote(
      "Showing in its own window",
      "Other sites open in a separate window; this tab controls it (address, DevTools console and network, agent tools). Closing the tab closes the window.",
      close,
    );
  }

  /** The page's own window closed: the tab stays, showing how to reopen. */
  windowClosed(): void {
    this.windowLabel = null;
    // A popped-out page comes back into the tab when its window closes (another site only when
    // sites show in the tab).
    if (
      this.options.popped &&
      this.address &&
      (this.address.kind !== "external" || this.embedSites())
    ) {
      void this.popOut(false).catch((err: unknown) => this.showError(err));
      return;
    }
    // A popup's window closed: the popup is gone (its opener sees `closed`), as in a browser.
    if (this.popup) {
      this.close();
      return;
    }
    this.page.connected.value = false;
    const reopen = h("button", { class: "button button-primary", type: "button" }, "Open again");
    this.noteActions.clear();
    this.noteActions.add(
      on(reopen, "click", () => {
        if (this.address) void this.load(this.address).catch((err: unknown) => this.showError(err));
      }),
    );
    const back = this.returnTo;
    const backButton = back
      ? h("button", { class: "button button-secondary", type: "button" }, "Back")
      : null;
    if (backButton)
      this.noteActions.add(
        on(backButton, "click", () => void this.history("back").catch(() => {})),
      );
    this.showNote(
      "The window was closed",
      this.address ? displayAddress(this.address, null) : "",
      reopen,
      ...(backButton ? [backButton] : []),
    );
  }

  private transport(message: unknown): void {
    if (this.windowLabel) {
      void browserIpc.send(this.windowLabel, message).catch(() => {});
      return;
    }
    if (this.proxyOrigin && this.frame.contentWindow)
      this.frame.contentWindow.postMessage(message, this.proxyOrigin);
  }

  private hello(): void {
    if (this.proxyOrigin && this.frame.contentWindow)
      this.frame.contentWindow.postMessage({ ns: "ide-host", type: "hello" }, this.proxyOrigin);
  }

  private onFrameMessage(e: MessageEvent): void {
    if (e.source !== this.frame.contentWindow) return;
    const data = e.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object" || data.ns !== "ide-bridge") return;
    if (e.origin !== this.proxyOrigin) {
      // Another of our proxies (a link to another local server, history back across ports):
      // the page is still ours. Any other origin isn't.
      if (!proxies.has(e.origin)) return;
      this.adoptProxy(e.origin);
    }
    // The bridge's first "ready" goes out before it knows us: answer with hello.
    // The goto page a redirect passes through isn't the tab's page: nothing to show or keep.
    if (data.type === "ready" && data.passing === true) {
      this.submitPending();
      return;
    }
    if (data.type === "ready" && !this.page.connected.peek()) this.hello();
    this.page.handle(data);
  }

  /** From the bridge in this tab's external window. */
  windowMessage(message: Record<string, unknown>): void {
    if (message.type === "ready" && message.passing === true) {
      this.submitPending();
      return;
    }
    if (message.type === "ready" && message.loaded === true) this.embed.pageLoaded();
    // A popped-out page that moved to another local server's proxy.
    if (this.page.proxied && typeof message.url === "string" && URL.canParse(message.url)) {
      const origin = new URL(message.url).origin;
      if (origin !== this.proxyOrigin && proxies.has(origin)) this.adoptProxy(origin);
    }
    this.page.handle(message);
  }

  /**
   * A site's webview may report its passing page before the tab knows its label (the report is
   * dropped then): asking again makes it answer once more.
   */
  private helloForForm(): void {
    if (this.pendingForm) this.transport({ ns: "ide-host", type: "hello" });
  }

  /** Posts the form this tab was opened for, from the passing page now up (links.js). */
  private submitPending(): void {
    const pending = this.pendingForm;
    if (!pending?.action) return;
    this.pendingForm = null;
    // A window or webview talks JSON: files go as their names (the frame can take the files).
    const entries = this.windowLabel
      ? pending.form.entries.map(([k, v]): [string, unknown] => [
          k,
          typeof v === "string" ? v : v instanceof File ? v.name : String(v ?? ""),
        ])
      : pending.form.entries;
    this.transport({
      ns: "ide-host",
      type: "call",
      id: -1,
      method: "submitForm",
      params: { ...pending.form, entries, action: pending.action },
    });
  }

  /** The frame (or window) now shows a page of another of our proxies. */
  private adoptProxy(origin: string): void {
    this.proxyOrigin = origin;
    this.targetOrigin = proxies.upstream(origin);
  }

  /** A request the proxy forwarded for this tab's frame. */
  networkEvent(e: NetEvent): void {
    const request: NetRequest = {
      id: `p${e.id}`,
      logId: e.id,
      method: e.method,
      url: this.mapUrl(`${e.origin}${e.url}`),
      status: e.status,
      mime: e.mime,
      size: e.size,
      startMs: e.startMs,
      ttfbMs: e.ttfbMs,
      durationMs: e.phase === "done" ? e.durationMs : Date.now() - e.startMs,
      reqHeaders: e.reqHeaders,
      resHeaders: e.resHeaders,
      ...(e.error && { error: e.error }),
      protocol: e.protocol,
      done: e.phase === "done",
      truncated: e.truncated,
      hasRequestBody: e.hasRequestBody,
    };
    this.page.addRequest(request);
  }

  /** The folder the current static preview's proxy serves (the first folder, if unknown). */
  private proxyRoot(): string | null {
    return (
      (this.proxyOrigin ? proxies.folder(this.proxyOrigin) : null) ??
      this.host.services.workspace.root.peek()
    );
  }

  /** Proxy URL → the address the user knows (dev server origin or workspace path). */
  mapUrl(url: string): string {
    if (!this.proxyOrigin || !url.startsWith(this.proxyOrigin)) return url;
    if (this.targetOrigin) return this.targetOrigin + url.slice(this.proxyOrigin.length);
    const root = this.proxyRoot();
    const path = root ? pathFromUrl(this.proxyOrigin, root, url) : null;
    return path && root
      ? displayAddress({ kind: "file", path }, rootsOf(this.host.services.workspace))
      : url;
  }

  /** The address the user knows → the URL the frame uses. */
  rawUrl(mapped: string): string {
    if (!this.proxyOrigin) return mapped;
    if (this.targetOrigin && mapped.startsWith(this.targetOrigin))
      return this.proxyOrigin + mapped.slice(this.targetOrigin.length);
    const root = this.proxyRoot();
    if (!this.targetOrigin && root) {
      const parsed = parseAddress(mapped, rootsOf(this.host.services.workspace));
      if (parsed?.kind === "file") return fileUrl(this.proxyOrigin, root, parsed.path);
    }
    return mapped;
  }

  /** The workspace file a shown URL serves: static previews directly, dev servers by path. */
  workspaceFile(url: string): Promise<string | null> {
    return findWorkspaceFile(url, rootsOf(this.host.services.workspace), this.targetOrigin);
  }

  /** Back / forward; back from another site's first page returns to the local page before. */
  async history(direction: "back" | "forward"): Promise<unknown> {
    const result = this.page.connected.peek()
      ? await this.page.call<{ atStart?: boolean }>(direction).catch(() => null)
      : null;
    const to = this.returnTo;
    if (direction === "back" && to && (!result || result.atStart)) {
      this.returnTo = null;
      await this.load(to);
      return { ok: true, url: displayAddress(to, rootsOf(this.host.services.workspace)) };
    }
    return result ?? { ok: false };
  }

  reload(): void {
    if (!this.address) return;
    // A fresh session: console and network start over (unless "Preserve log").
    this.page.newDocument();
    if (this.page.connected.peek() && this.page.kind === "frame") {
      void this.page.call("reload").catch(() => this.reloadFrame());
    } else if (this.page.kind === "window" && this.windowLabel) {
      void this.page.call("reload").catch(() => {});
    } else void this.load(this.address).catch((err: unknown) => this.showError(err));
  }

  private reloadFrame(): void {
    const src = this.frame.src;
    this.frame.src = src;
  }

  /** A workspace file changed: static previews reload, stylesheets swap in place (debounced). */
  fileChanged(path?: string): void {
    if (this.address?.kind !== "file") return;
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      if (path?.toLowerCase().endsWith(".css") && this.page.connected.peek())
        void this.page.call("reloadCss").catch(() => this.reload());
      else this.reload();
    }, 150);
  }

  // ---- Devtools, picker, device mode ----------------------------------------------------------

  openDevtools(tab?: DevtoolsTab): void {
    if (!this.options.devtools) this.toggleDevtools(true);
    if (tab) this.devtools.show(tab);
    this.options.tab = this.devtools.active;
    this.saveState();
  }

  toggleDevtools(open = !this.options.devtools): void {
    this.options.devtools = open;
    this.layout();
    this.saveState();
  }

  async togglePick(on = !this.picking): Promise<void> {
    this.picking = on;
    this.pickButton.classList.toggle("is-active", on);
    if (on) {
      this.openDevtools("elements");
      this.devtools.panel<ElementsPanel>("elements");
    }
    await this.page.call("dom.pick", { on }).catch(() => {
      this.picking = false;
      this.pickButton.classList.remove("is-active");
    });
  }

  /** Reveals an element (by ref) in Elements. */
  async revealElement(id: string): Promise<void> {
    this.openDevtools("elements");
    await this.devtools.panel<ElementsPanel>("elements").reveal(id);
  }

  setViewport(viewport: Viewport): void {
    this.options.viewport = viewport;
    if (viewport.width !== null) this.deviceBar.hidden = false;
    this.renderDeviceBar();
    this.fitViewport();
    this.saveState();
  }

  private toggleDeviceBar(): void {
    const on = this.deviceBar.hidden;
    this.deviceBar.hidden = !on;
    if (!on) this.setViewport({ width: null, height: null, device: null });
    else if (this.options.viewport.width === null)
      this.setViewport({ width: 393, height: 852, device: "iphone-15" });
    this.devtools?.syncDevice();
  }

  /** The pop-out button shows whether the page is in its own window. */
  /** Whether the whole browser tab (toolbar, page, DevTools) is in a window of its own. */
  private get inOwnWindow(): boolean {
    return this.element.ownerDocument !== document;
  }

  /** The toolbar's window button: the whole tool into a window of its own (D101), or back. */
  private toggleWindow(): void {
    this.host.run(this.inOwnWindow ? "layout.returnFromWindow" : "layout.moveToNewWindow", {
      tabId: this.ctx.tabId,
    });
  }

  private renderToolbarState(): void {
    const out = this.inOwnWindow;
    this.popButton.classList.toggle("is-active", out);
    setTooltip(
      this.popButton,
      out ? "Move back into the main window" : "Open in a new window (with DevTools)",
    );
  }

  private renderDeviceBar(): void {
    renderDeviceBar(
      this.deviceBar,
      this.options.viewport,
      (vp) => this.setViewport(vp),
      () => this.toggleDeviceBar(),
    );
  }

  /** Device mode: the frame at the device's size, scaled down to fit the stage. */
  private fitViewport(): void {
    const { width, height } = this.options.viewport;
    this.stage.classList.toggle("is-device", width !== null);
    if (width === null || height === null) {
      this.frameBox.style.cssText = "";
      this.frame.style.cssText = "";
      this.deviceScale = 1;
      this.embed.wake();
      return;
    }
    const pad = 32;
    const scale = Math.min(
      1,
      (this.stage.clientWidth - pad) / width,
      (this.stage.clientHeight - pad) / height,
    );
    const s = Math.max(0.1, scale);
    // A site's webview is laid out at the device's size by zooming it to the shown scale.
    this.deviceScale = s;
    this.embed.wake();
    this.frame.style.cssText = `width:${width}px;height:${height}px;transform:scale(${s});transform-origin:0 0`;
    this.frameBox.style.cssText = `width:${Math.round(width * s)}px;height:${Math.round(height * s)}px`;
    const label = this.deviceBar.querySelector(".browser-scale");
    if (label) label.textContent = s < 1 ? `${Math.round(s * 100)}%` : "";
  }

  private layout(): void {
    const { devtools: open, side, size } = this.options;
    this.main.classList.toggle("is-side", side === "right");
    this.devtoolsBox.hidden = !open;
    this.sash.hidden = !open;
    this.sash.orientation = side === "right" ? "vertical" : "horizontal";
    this.devtoolsBox.style.flexBasis = `${size}px`;
    this.devtoolsButton.classList.toggle("is-active", open);
    this.devtools.setVisible(open);
    if (open) this.devtools.show(this.devtools.active);
    requestAnimationFrame(() => this.fitViewport());
  }

  private moreMenu(anchor: HTMLElement): void {
    const { settings } = this.host.services;
    const liveOnEdit = settings.peek<boolean>("browser.liveReload.onEdit") !== false;
    const items = moreMenuItems({
      address: this.address,
      root: rootsOf(this.host.services.workspace),
      deviceMode: !this.deviceBar.hidden,
      inOwnWindow: this.inOwnWindow,
      popped: this.options.popped,
      embedSites: this.embedSites(),
      devtools: this.options.devtools,
      liveOnEdit,
      run: (command, input = {}) => this.host.run(command, input),
      hardReload: () => void this.hardReload(),
      toggleDevice: () => this.toggleDeviceBar(),
      toggleWindow: () => this.toggleWindow(),
      popOut: () => void this.popOut(),
      toggleDevtools: () => this.toggleDevtools(),
      openNetwork: () => this.openDevtools("network"),
      clearSiteData: () => void this.page.call("storage.clear", { area: "all" }).catch(() => {}),
      toggleLiveOnEdit: () =>
        void settings.update("browser.liveReload.onEdit", !liveOnEdit, "user").catch(() => {}),
    });
    showMenu(anchor, items, "Browser");
  }

  private async hardReload(): Promise<void> {
    this.page.newDocument();
    await browserIpc.setNoCache(true).catch(() => {});
    this.reloadFrame();
    setTimeout(() => void browserIpc.setNoCache(false).catch(() => {}), 3000);
  }

  private openInSystem(): void {
    const a = this.address;
    if (!a) return;
    // Static previews are real local pages too (the bridge stays idle outside the IDE).
    const url =
      a.kind === "file" && this.proxyOrigin
        ? this.rawUrl(displayAddress(a, rootsOf(this.host.services.workspace)))
        : a.kind === "file"
          ? null
          : a.url;
    if (url) this.host.run("ui.openLink", { url });
  }

  // ---- Chrome ----------------------------------------------------------------------------------

  private showNote(title: string, detail: string, ...actions: HTMLElement[]): void {
    this.frameBox.hidden = this.page.kind === "window" || !this.address;
    this.note.replaceChildren(
      icon(this.page.kind === "window" ? "app-window" : "globe"),
      h("div", { class: "empty-state-title" }, title),
      h("div", { class: "empty-state-text" }, detail),
      ...actions,
    );
    this.note.hidden = !this.frameBox.hidden;
  }

  private showError(err: unknown): void {
    this.page.loading.value = false;
    this.frameBox.hidden = true;
    this.note.replaceChildren(
      icon("triangle-alert"),
      h("div", { class: "empty-state-title" }, "Couldn't open the page"),
      h("div", { class: "empty-state-text" }, err instanceof Error ? err.message : String(err)),
    );
    this.note.hidden = false;
  }

  private saveState(): void {
    this.ctx.updateState(this.serialize());
    this.changed.fire();
  }

  title(): string {
    const t = this.page.title.peek();
    if (t) return t;
    const a = this.address;
    if (!a) return "Browser";
    return a.kind === "file" ? basename(a.path) : a.url.replace(/^https?:\/\//, "");
  }

  focus(): void {
    if (this.embed.open) this.embed.focus();
    else if (!this.address) this.input.focus();
    else if (!this.frameBox.hidden) this.frame.focus();
    else this.element.focus();
  }

  focusAddress(): void {
    this.input.focus();
  }

  onResize(): void {
    this.fitViewport();
    this.embed.wake();
  }

  onShow(): void {
    this.embed.setShown(true);
  }

  onHide(): void {
    this.embed.setShown(false);
  }

  serialize(): Json {
    return this.state() as unknown as Json;
  }

  private state(): Record<string, unknown> {
    const a = this.address;
    const where = a ? (a.kind === "file" ? { path: a.path } : { url: a.url }) : {};
    const { devtools, side, size, viewport, popped } = this.options;
    return {
      ...where,
      ...(this.windowName && { name: this.windowName }),
      view: {
        devtools,
        tab: this.devtools.active,
        side,
        size,
        viewport: { width: viewport.width, height: viewport.height, device: viewport.device },
        // Popped out comes back popped out after a restart.
        ...(popped && { popped }),
      },
    };
  }

  dispose(): void {
    this.store.dispose();
  }
}
