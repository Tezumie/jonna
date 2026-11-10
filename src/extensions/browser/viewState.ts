// A browser tab's saved state (view.ts): where it is and how its DevTools and device mode are.
import type { Json } from "../../core/dock/index";
import { stateField } from "../../workbench/dock/views";
import { type Address, parseAddress, type Roots } from "./address";
import type { Viewport } from "./devices";
import type { DevtoolsTab } from "./devtools/index";

export const MIN_DEVTOOLS = 120;

/** The tab state: a dev-server or external `url`, or a workspace file `path`. */
export function addressFromState(state: Json, root: Roots): Address | null {
  const path = stateField(state, "path");
  if (typeof path === "string" && path) return { kind: "file", path };
  const url = stateField(state, "url");
  return typeof url === "string" ? parseAddress(url, root) : null;
}

export interface ViewOptions {
  devtools: boolean;
  tab: DevtoolsTab;
  side: "bottom" | "right";
  /** DevTools size in pixels. */
  size: number;
  viewport: Viewport;
  /** The page is shown in its own window (this tab keeps the toolbar and DevTools). */
  popped: boolean;
}

export function readOptions(state: Json): ViewOptions {
  const o = (stateField(state, "view") ?? {}) as Partial<ViewOptions>;
  return {
    devtools: o.devtools === true,
    tab:
      (["elements", "console", "network", "sources", "application"] as const).find(
        (t) => t === o.tab,
      ) ?? "console",
    side: o.side === "right" ? "right" : "bottom",
    size: typeof o.size === "number" && o.size >= MIN_DEVTOOLS ? o.size : 280,
    viewport:
      o.viewport && typeof o.viewport === "object"
        ? {
            width: typeof o.viewport.width === "number" ? o.viewport.width : null,
            height: typeof o.viewport.height === "number" ? o.viewport.height : null,
            device: typeof o.viewport.device === "string" ? o.viewport.device : null,
          }
        : { width: null, height: null, device: null },
    popped: o.popped === true,
  };
}

/** A ResizeObserver owned by a store. */
export class ResizeObserverDisposable {
  private readonly observer: ResizeObserver;
  constructor(target: Element, callback: () => void) {
    this.observer = new ResizeObserver(() => callback());
    this.observer.observe(target);
  }
  dispose(): void {
    this.observer.disconnect();
  }
}
