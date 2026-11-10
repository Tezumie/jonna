// Drag handle between two parts. Reports the absolute drag delta from where the drag started,
// so the owner computes the new size from the size at drag start (no accumulated rounding).
import { h, on } from "../core/dom/index";
import { type Disposable, DisposableStore, toDisposable } from "../core/lifecycle/index";

export interface SashOptions {
  orientation: "vertical" | "horizontal"; // vertical sash = resizes width
  onStart(): void;
  onDrag(delta: number): void;
  onEnd?(): void;
  /** Double-click resets the size. */
  onReset?(): void;
}

export class Sash implements Disposable {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private orient: SashOptions["orientation"];

  constructor(host: HTMLElement, options: SashOptions) {
    this.orient = options.orientation;
    this.element = h("div", {
      class: `sash sash-${options.orientation}`,
      role: "separator",
      "aria-orientation": options.orientation,
    });
    host.appendChild(this.element);
    this.store.add(toDisposable(() => this.element.remove()));
    const drag = this.store.add(new DisposableStore());
    this.store.add(
      on(this.element, "pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const orientation = this.orient;
        const start = orientation === "vertical" ? e.clientX : e.clientY;
        this.element.setPointerCapture(e.pointerId);
        this.element.classList.add("is-active");
        document.body.classList.add(`is-resizing-${orientation}`);
        // In the drag store, so disposing the sash mid-drag doesn't leave the body's resize
        // cursor (and its pointer-events rules) on for good.
        drag.add(
          toDisposable(() => {
            this.element.classList.remove("is-active");
            document.body.classList.remove(`is-resizing-${orientation}`);
          }),
        );
        options.onStart();
        // One update per frame: pointermove can fire far more often than the screen paints.
        let frame = 0;
        let last = start;
        drag.add(
          on(this.element, "pointermove", (m) => {
            last = orientation === "vertical" ? m.clientX : m.clientY;
            if (frame) return;
            frame = requestAnimationFrame(() => {
              frame = 0;
              options.onDrag(last - start);
            });
          }),
        );
        drag.add(toDisposable(() => cancelAnimationFrame(frame)));
        const end = () => {
          if (frame) options.onDrag(last - start);
          drag.clear(); // also removes the drag classes
          options.onEnd?.();
        };
        drag.add(on(this.element, "pointerup", end));
        drag.add(on(this.element, "pointercancel", end));
      }),
    );
    if (options.onReset) {
      const reset = options.onReset;
      this.store.add(on(this.element, "dblclick", () => reset()));
    }
  }

  /** Switches between resizing width (vertical) and height (horizontal). */
  set orientation(value: SashOptions["orientation"]) {
    this.orient = value;
    this.element.classList.toggle("sash-vertical", value === "vertical");
    this.element.classList.toggle("sash-horizontal", value === "horizontal");
    this.element.setAttribute("aria-orientation", value);
  }

  set hidden(value: boolean) {
    this.element.hidden = value;
  }

  dispose(): void {
    this.store.dispose();
  }
}
