// A site shown inside a browser tab (`browser.embedSites`, Rust `browser/embed.rs`): its own
// webview, a child of the IDE window, kept over the tab's page area. Positions follow the area
// every frame while something may be moving (a sash drag, a resize, a tab switch, a menu opening),
// then the loop sleeps, as the iframe layer does (D123). The webview hides while the tab isn't
// shown and while an overlay of the IDE (a menu, dialog, the quick input, a toast, a drag
// preview) covers the area — a native webview is drawn above the IDE's page, so it would hide
// them. Meanwhile the area shows the page's last snapshot.
import { on } from "../../core/dom/index";
import { browserIpc } from "../../core/ipc/browser";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { type Box, type Placement, placement, samePlacement } from "./embedGeometry";

/** After the last change the loop keeps checking this many frames, then sleeps. */
const SETTLE_FRAMES = 30;
/** A press (drag, sash) keeps the loop up at most this long (ms). */
const MAX_PRESS_MS = 10_000;

/**
 * What floats above the workbench but doesn't hide the page: tooltips come and go with the
 * pointer (hiding the page for each would flash), and the debug toolbar stays up a whole session.
 * They may be drawn under the page where they overlap it.
 */
const PASS_THROUGH = [".tooltip", ".debug-float"];

/** Overlays of the IDE's page that cover a webview: everything on top of the workbench. */
function overlayBoxes(doc: Document): Box[] {
  const boxes: Box[] = [];
  const visible = (el: Element) => {
    if (PASS_THROUGH.some((sel) => el.matches(sel))) return null;
    const style = getComputedStyle(el);
    return style.display === "none" || style.visibility === "hidden" ? null : style;
  };
  const add = (el: Element) => {
    const r = el.getBoundingClientRect();
    // Screen-reader-only and measuring elements are a pixel or two.
    if (r.width > 2 && r.height > 2) boxes.push(r);
  };
  for (const el of Array.from(doc.body.children)) {
    if (el.classList.contains("workbench") || el.tagName === "SCRIPT" || el.tagName === "STYLE")
      continue;
    const style = visible(el);
    if (!style) continue;
    // A layer (the overlay host, the drag-and-drop layer) covers the window but lets the pointer
    // through: what counts is what's in it.
    if (style.pointerEvents === "none") {
      for (const child of Array.from(el.children)) if (visible(child)) add(child);
    } else add(el);
  }
  return boxes;
}

export class EmbeddedSite implements Disposable {
  /** The webview's label while one is open. */
  label: string | null = null;
  private readonly store = new DisposableStore();
  /** Listeners of the window the tab is in (they move with it). */
  private readonly windowStore = this.store.add(new DisposableStore());
  private raf = 0;
  /** The window the frame loop runs in (the tab's). */
  private rafWindow: Window = window;
  private idle = 0;
  private pressedAt = 0;
  private placed: Placement | null = null;
  private host = "main";
  private sending = false;
  private resend = false;
  private shown = true;
  private snapshotUrl: string | null = null;
  private snapshotAt = 0;

  constructor(
    /** The tab's page area: the webview covers it. */
    private readonly slot: HTMLElement,
    /** Shows the page's last snapshot while the webview is hidden. */
    private readonly snapshot: HTMLImageElement,
    private readonly services: WorkbenchServices,
    /** Device mode's scale (the page is laid out at the device's size). */
    private readonly zoom: () => number,
    /** The webview went away without the tab closing it (its window closed with it). */
    private readonly onLost: () => void,
  ) {
    const observer = new ResizeObserver(() => this.wake());
    observer.observe(slot);
    this.store.add(toDisposable(() => observer.disconnect()));
    this.store.add(toDisposable(() => this.rafWindow.cancelAnimationFrame(this.raf)));
    this.store.add(toDisposable(() => this.dropSnapshot()));
    this.watch(slot.ownerDocument.defaultView ?? window);
    // Layout changes (a tab switched, moved or maximized, a region shown) move the area.
    const { dock } = services;
    this.store.add(
      effect(() => {
        dock.root.value;
        dock.focusedGroupId.value;
        this.wake();
        return undefined;
      }),
    );
  }

  get open(): boolean {
    return this.label !== null;
  }

  /** Bumped by each show and close: an open that finishes after another one is closed again. */
  private opening = 0;

  /** Shows `url` in a new webview over the area; returns its label. */
  async show(url: string, popup: boolean, name: string | undefined): Promise<string> {
    const p = this.measure();
    const opening = ++this.opening;
    const label = await browserIpc.embedOpen(this.host, url, p.bounds, popup, name);
    // Closed, disposed or shown again while it opened: this webview is nobody's (D233 audit).
    if (opening !== this.opening) {
      void browserIpc.closeWindow(label).catch(() => {});
      throw new Error("superseded");
    }
    this.label = label;
    this.placed = null;
    this.wake();
    return label;
  }

  /** The tab moved into another IDE window (or back): follow it there. */
  windowChanged(win: Window): void {
    this.watch(win);
    this.wake();
  }

  /** The tab is shown (or hidden): the webview follows. */
  setShown(shown: boolean): void {
    this.shown = shown;
    this.wake();
  }

  focus(): void {
    if (this.label) void browserIpc.embedFocus(this.label).catch(() => {});
  }

  /** Closes the webview (the tab shows something else, or closes). */
  close(): void {
    const label = this.label;
    this.label = null;
    this.opening++;
    this.placed = null;
    this.dropSnapshot();
    if (label) void browserIpc.closeWindow(label).catch(() => {});
  }

  /** The page loaded: a new snapshot shortly after (what shows while a menu covers it). */
  pageLoaded(): void {
    this.snapshotAt = 0;
    setTimeout(() => this.refreshSnapshot(), 700);
  }

  private watch(win: Window): void {
    this.windowStore.clear();
    const aux = win !== window ? this.services.auxWindows.labelOf(win) : null;
    this.host = aux ?? "main";
    const wake = () => this.wake();
    const down = () => {
      this.pressedAt = performance.now();
      this.wake();
    };
    const up = () => {
      this.pressedAt = 0;
      this.wake();
    };
    const s = this.windowStore;
    s.add(on(win, "resize", wake));
    s.add(on(win, "pointerdown", down, { capture: true }));
    s.add(on(win, "pointerup", up, { capture: true }));
    s.add(on(win, "pointercancel", up, { capture: true }));
    s.add(on(win, "blur", up));
    s.add(on(win, "keydown", wake, { capture: true }));
    // The pointer comes back to the IDE's page (from the site's webview, or from outside the
    // window): a fresh snapshot, before a menu can open over the page.
    let lastMove = 0;
    s.add(
      on(win, "pointermove", () => {
        const now = performance.now();
        if (now - lastMove > 300) this.refreshSnapshot();
        lastMove = now;
      }),
    );
    s.add(on(win, "transitionrun", wake, { capture: true }));
    s.add(on(win.document, "visibilitychange", wake));
    // Menus, dialogs and hover cards are added to the body; the quick input and toasts show
    // inside the overlay host.
    const observer = new MutationObserver(wake);
    observer.observe(win.document.body, { childList: true });
    for (const layer of Array.from(win.document.querySelectorAll(".overlay-host")))
      observer.observe(layer, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["hidden", "class", "style"],
      });
    s.add(toDisposable(() => observer.disconnect()));
  }

  private measure(): Placement {
    const win = this.slot.ownerDocument.defaultView ?? window;
    const visible =
      this.shown && this.slot.isConnected && win.document.visibilityState !== "hidden";
    const r = visible ? this.slot.getBoundingClientRect() : null;
    const covers = r && r.width > 0 ? overlayBoxes(win.document) : [];
    return placement(r, covers, win.devicePixelRatio, this.zoom());
  }

  /** Runs the placement loop for a while (until nothing changed for a few frames). */
  wake(): void {
    this.idle = 0;
    if (this.raf || !this.label) return;
    const win = this.slot.ownerDocument.defaultView ?? window;
    this.rafWindow = win;
    const tick = () => {
      this.raf = 0;
      if (!this.label) return;
      const next = this.measure();
      if (!samePlacement(this.placed, next)) {
        this.idle = 0;
        this.apply(next);
      } else this.idle++;
      const pressing = this.pressedAt > 0 && performance.now() - this.pressedAt < MAX_PRESS_MS;
      if (this.idle < SETTLE_FRAMES || pressing) this.raf = win.requestAnimationFrame(tick);
    };
    this.raf = win.requestAnimationFrame(tick);
  }

  /** Sends a placement; one call at a time, the newest wins. */
  private apply(next: Placement): void {
    const wasVisible = this.placed?.visible ?? false;
    this.placed = next;
    this.snapshot.hidden = next.visible || !this.snapshotUrl;
    if (wasVisible && !next.visible) this.refreshSnapshotLater();
    if (this.sending) {
      this.resend = true;
      return;
    }
    const label = this.label;
    if (!label) return;
    this.sending = true;
    void browserIpc
      .embedPlace(label, this.host, next.bounds, next.visible, next.zoom)
      .catch((err: unknown) => {
        // Gone with an auxiliary window that closed under it: the tab shows the page again.
        if (this.label === label && /closed/.test(String(err))) {
          this.label = null;
          this.placed = null;
          this.dropSnapshot();
          this.onLost();
        }
      })
      .finally(() => {
        this.sending = false;
        if (this.resend && this.placed && this.label) {
          this.resend = false;
          this.apply(this.placed);
        }
      });
  }

  /** The snapshot is a few seconds old at most when a menu opens over the page. */
  private refreshSnapshot(): void {
    const label = this.label;
    if (!label || !this.placed?.visible) return;
    const now = Date.now();
    if (now - this.snapshotAt < 1500) return;
    this.snapshotAt = now;
    void browserIpc
      .screenshot(label)
      .then((png) => {
        if (this.label !== label) return;
        const url = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
        this.dropSnapshot();
        this.snapshotUrl = url;
        this.snapshot.src = url;
        this.snapshot.hidden = this.placed?.visible ?? true;
      })
      .catch(() => {});
  }

  /** Hidden without a snapshot yet: none to show (the area stays the page's background). */
  private refreshSnapshotLater(): void {
    if (this.snapshotUrl) this.snapshot.hidden = false;
  }

  private dropSnapshot(): void {
    if (this.snapshotUrl) URL.revokeObjectURL(this.snapshotUrl);
    this.snapshotUrl = null;
    this.snapshot.removeAttribute("src");
    this.snapshot.hidden = true;
  }

  dispose(): void {
    this.close();
    this.store.dispose();
  }
}
