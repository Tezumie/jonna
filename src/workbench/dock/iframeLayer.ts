// Iframes reload whenever their DOM node moves, so views that contain one never put it in the dock
// tree: they render an empty "slot" there, and the iframe lives in this layer outside the dock,
// absolutely positioned over its slot (docs/dock.md §6). Positions follow the slot every frame
// while something may be moving — a slot resized, the window resized, a pointer pressed (drags,
// sashes) — and for half a second after the last change; then the loop sleeps (D123: a frame
// loop with layout reads forever kept the window busy while a page was open).
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { frameTransformFor } from "./lift";

interface Entry {
  slot: HTMLElement;
  frame: HTMLIFrameElement;
  last: string;
}

// Slot size changes are applied in the same frame (ResizeObserver runs after layout, before
// paint), so a page grows with its tab instead of trailing it by a frame.

/** A press keeps the frame loop running at most this long (ms). */
const MAX_PRESS_MS = 10_000;

export class IframeLayer implements Disposable {
  readonly element: HTMLElement;
  private readonly entries = new Set<Entry>();
  private readonly store = new DisposableStore();
  private raf = 0;
  private idleFrames = 0;
  private pointerDown = false;
  /** When the current press started (performance.now()), to cap how long it keeps the loop up. */
  private pointerDownAt = 0;

  constructor(host: HTMLElement) {
    this.element = document.createElement("div");
    this.element.className = "iframe-layer";
    host.appendChild(this.element);
    this.store.add(toDisposable(() => this.element.remove()));
    this.store.add(toDisposable(() => cancelAnimationFrame(this.raf)));
    const wake = () => this.wake();
    const down = () => {
      this.pointerDown = true;
      this.pointerDownAt = performance.now();
      this.wake();
    };
    const up = () => {
      this.pointerDown = false;
      this.wake();
    };
    // The release can miss the window (let go over an iframe or outside it, the window loses
    // focus mid-drag): these also end the press, or the loop would run every frame forever.
    const hidden = () => {
      if (document.visibilityState === "hidden") up();
    };
    window.addEventListener("resize", wake);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("lostpointercapture", up, true);
    window.addEventListener("blur", up);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("keydown", wake, true);
    window.addEventListener("transitionrun", wake, true);
    this.store.add(
      toDisposable(() => {
        window.removeEventListener("resize", wake);
        window.removeEventListener("pointerdown", down, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", up, true);
        window.removeEventListener("lostpointercapture", up, true);
        window.removeEventListener("blur", up);
        document.removeEventListener("visibilitychange", hidden);
        window.removeEventListener("keydown", wake, true);
        window.removeEventListener("transitionrun", wake, true);
      }),
    );
  }

  /** Follows the slots again (layout may be changing). */
  wake(): void {
    this.idleFrames = 0;
    if (!this.raf && this.entries.size) this.raf = requestAnimationFrame(this.tick);
  }

  /** Keeps `frame` positioned over `slot` until the returned Disposable is disposed. */
  attach(slot: HTMLElement, frame: HTMLIFrameElement): Disposable {
    const entry: Entry = { slot, frame, last: "" };
    frame.classList.add("iframe-layer-frame");
    this.element.appendChild(frame);
    this.entries.add(entry);
    this.tick();
    const observer = new ResizeObserver(() => this.sync());
    observer.observe(slot);
    return toDisposable(() => {
      observer.disconnect();
      this.entries.delete(entry);
      frame.remove();
    });
  }

  /** Positions every frame now (layout is current) and keeps following. */
  private sync(): void {
    this.tick();
  }

  private tick = (): void => {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.entries.size === 0) return;
    let changed = false;
    const layer = this.element.getBoundingClientRect();
    for (const entry of this.entries) {
      // A slot that is detached or hidden (inactive tab, hidden group) hides its iframe.
      const visible = entry.slot.isConnected && entry.slot.offsetParent !== null;
      // Inside a group being dragged: scale the iframe with the group instead of resizing it.
      const lifted = visible ? frameTransformFor(entry.slot, layer) : null;
      // Above the drag layer while lifted, and while it settles (no blink under the group).
      entry.frame.classList.toggle(
        "is-lifted",
        !!lifted || !!entry.slot.closest(".dock-group.is-lifted, .dock-group.is-settling"),
      );
      if (lifted) {
        changed = true;
        entry.last = "lifted";
        entry.frame.style.visibility = "visible";
        entry.frame.style.transformOrigin = lifted.origin;
        entry.frame.style.transform = lifted.transform;
        entry.frame.style.setProperty("--lift-scale", String(Math.max(0.05, lifted.scale)));
        entry.frame.style.width = `${lifted.width}px`;
        entry.frame.style.height = `${lifted.height}px`;
        continue;
      }
      if (entry.last === "lifted") {
        entry.frame.style.removeProperty("transform-origin");
        entry.frame.style.removeProperty("--lift-scale");
      }
      const r = entry.slot.getBoundingClientRect();
      const key = visible
        ? `${r.left - layer.left},${r.top - layer.top},${r.width},${r.height}`
        : "hidden";
      if (key === entry.last) continue;
      changed = true;
      entry.last = key;
      entry.frame.style.visibility = visible ? "visible" : "hidden";
      if (visible) {
        entry.frame.style.transform = `translate(${r.left - layer.left}px, ${r.top - layer.top}px)`;
        entry.frame.style.width = `${r.width}px`;
        entry.frame.style.height = `${r.height}px`;
      }
    }
    this.idleFrames = changed ? 0 : this.idleFrames + 1;
    // Last resort for a release no event reported: no real press keeps things moving this long.
    if (this.pointerDown && performance.now() - this.pointerDownAt > MAX_PRESS_MS)
      this.pointerDown = false;
    if (this.pointerDown || this.idleFrames < 30) this.raf = requestAnimationFrame(this.tick);
  };

  dispose(): void {
    for (const entry of this.entries) entry.frame.remove();
    this.entries.clear();
    this.store.dispose();
  }
}
