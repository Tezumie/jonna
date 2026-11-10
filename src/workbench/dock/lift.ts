// Lifting a whole group while it is dragged by its tab strip (docs/dock.md §4): the live group
// element itself is transformed — never cloned or re-parented, so editors, terminals and iframes
// keep running — and shrinks toward the pointer, keeping its aspect ratio and the point that was
// grabbed under the cursor. On drop it glides into its new slot (or back home) with a FLIP tween.
// The transform is recorded so the iframe layer can move a browser view's iframe along with it.

export interface LiftTransform {
  /** The element's untransformed rect (page coordinates) the transform applies to. */
  base: { left: number; top: number; width: number; height: number };
  /** Transform origin, relative to the base rect's top-left. */
  ox: number;
  oy: number;
  tx: number;
  ty: number;
  sx: number;
  sy: number;
}

/** Live transforms of lifted groups, read by the iframe layer every frame. */
export const liftTransforms = new WeakMap<HTMLElement, LiftTransform>();

/** The ghost's largest side (px) once shrunk; small groups shrink less. */
const GHOST_MAX_WIDTH = 360;
const GHOST_MAX_HEIGHT = 240;
const SHRINK_MS = 160;
const SETTLE_MS = 200;

const easeOut = (t: number) => 1 - (1 - t) ** 3;

function apply(el: HTMLElement, t: LiftTransform): void {
  el.style.transformOrigin = `${t.ox}px ${t.oy}px`;
  el.style.transform = `translate(${t.tx}px, ${t.ty}px) scale(${t.sx}, ${t.sy})`;
  // Corners are drawn before the scale: CSS divides by it so they stay round (D186).
  el.style.setProperty("--lift-scale", String(Math.max(0.05, t.sx)));
  liftTransforms.set(el, t);
}

function clear(el: HTMLElement): void {
  el.style.removeProperty("transform");
  el.style.removeProperty("transform-origin");
  el.style.removeProperty("--lift-scale");
  liftTransforms.delete(el);
}

export class GroupLift {
  private readonly t: LiftTransform;
  private readonly target: number;
  private readonly started = performance.now();
  private raf = 0;
  private pointer: { x: number; y: number };

  constructor(
    private readonly el: HTMLElement,
    private readonly dockElement: HTMLElement,
    down: { x: number; y: number },
  ) {
    const r = el.getBoundingClientRect();
    this.pointer = down;
    this.t = {
      base: { left: r.left, top: r.top, width: r.width, height: r.height },
      ox: down.x - r.left,
      oy: down.y - r.top,
      tx: 0,
      ty: 0,
      sx: 1,
      sy: 1,
    };
    // Same factor on both axes: the ghost keeps the group's aspect ratio.
    this.target = Math.min(1, GHOST_MAX_WIDTH / r.width, GHOST_MAX_HEIGHT / r.height);
    dockElement.classList.add("is-group-dragging");
    el.classList.add("is-lifted");
    apply(el, this.t);
    this.raf = requestAnimationFrame(this.frame);
  }

  move(x: number, y: number): void {
    this.pointer = { x, y };
  }

  private frame = (): void => {
    const p = Math.min(1, (performance.now() - this.started) / SHRINK_MS);
    const s = 1 + (this.target - 1) * easeOut(p);
    this.t.sx = s;
    this.t.sy = s;
    this.t.tx = this.pointer.x - this.t.base.left - this.t.ox;
    this.t.ty = this.pointer.y - this.t.base.top - this.t.oy;
    apply(this.el, this.t);
    this.raf = requestAnimationFrame(this.frame);
  };

  /**
   * Ends the lift. `commit` runs the move (it may re-render the dock); afterwards the group glides
   * from where the ghost was to wherever it now is: its new slot, or home if nothing moved.
   */
  end(commit?: () => void): void {
    cancelAnimationFrame(this.raf);
    const from = this.el.getBoundingClientRect();
    this.el.classList.remove("is-lifted");
    this.dockElement.classList.remove("is-group-dragging");
    clear(this.el);
    this.el.classList.add("is-settling");
    commit?.();
    // The move command runs in a microtask; the dock has re-rendered by the next frame.
    requestAnimationFrame(() => {
      if (!this.el.isConnected) return;
      const to = this.el.getBoundingClientRect();
      if (to.width === 0 || to.height === 0) {
        this.el.classList.remove("is-settling");
        return;
      }
      const t: LiftTransform = {
        base: { left: to.left, top: to.top, width: to.width, height: to.height },
        ox: 0,
        oy: 0,
        tx: from.left - to.left,
        ty: from.top - to.top,
        sx: from.width / to.width,
        sy: from.height / to.height,
      };
      const start = { ...t };
      const begun = performance.now();
      const step = () => {
        const p = Math.min(1, (performance.now() - begun) / SETTLE_MS);
        const k = 1 - easeOut(p);
        t.tx = start.tx * k;
        t.ty = start.ty * k;
        t.sx = 1 + (start.sx - 1) * k;
        t.sy = 1 + (start.sy - 1) * k;
        if (p < 1) {
          apply(this.el, t);
          requestAnimationFrame(step);
        } else {
          clear(this.el);
          this.el.classList.remove("is-settling");
        }
      };
      step();
    });
  }
}

/**
 * Where an iframe should go for a slot inside a lifted group: the slot's untransformed rect plus
 * the group's transform re-expressed around the slot (so the page is scaled, not re-laid out).
 */
export function frameTransformFor(
  slot: HTMLElement,
  layer: DOMRect,
): { transform: string; origin: string; width: number; height: number; scale: number } | null {
  const group = slot.closest<HTMLElement>(".dock-group");
  const t = group ? liftTransforms.get(group) : undefined;
  if (!t) return null;
  const r = slot.getBoundingClientRect();
  const originX = t.base.left + t.ox;
  const originY = t.base.top + t.oy;
  // Invert the transform to find the slot's untransformed position.
  const left = originX + (r.left - originX - t.tx) / t.sx;
  const top = originY + (r.top - originY - t.ty) / t.sy;
  const width = r.width / t.sx;
  const height = r.height / t.sy;
  return {
    transform: `translate(${left - layer.left}px, ${top - layer.top}px) translate(${t.tx}px, ${t.ty}px) scale(${t.sx}, ${t.sy})`,
    origin: `${originX - left}px ${originY - top}px`,
    width,
    height,
    scale: t.sx,
  };
}
