// Shared pieces of the browser DevTools panels: the host each panel talks to, small DOM helpers
// (icon buttons, toggles, filter boxes, key/value tables) and formatting.
import { h, on } from "../../../core/dom/index";
import { type Disposable, type DisposableStore, toDisposable } from "../../../core/lifecycle/index";
import type { IconName } from "../../../ui/Icon";
import { icon } from "../../../ui/Icon";
import { Sash } from "../../../ui/Sash";
import { setTooltip } from "../../../ui/Tooltip";
import type { WorkbenchServices } from "../../../workbench/services";
import type { NetRequest, Page } from "../page";

export interface DevtoolsHost {
  readonly page: Page;
  /** The browser tab (the `tab` of browser.* commands). */
  readonly tabId: string;
  readonly services: WorkbenchServices;
  /** Reloads the page (as the toolbar's reload). */
  reload(): void;
  /** Runs a dispatcher command (every button is a command where one exists). */
  run(command: string, input?: unknown): void;
  /** A request's body bytes (proxy log or same-origin fetch), or null if not kept. */
  body(request: NetRequest, which: "request" | "response"): Promise<Uint8Array | null>;
  /** A URL as the page sees it (the proxy's) → as the user knows it (dev server, file). */
  displayUrl(url: string): string;
  /** Text of a resource by its shown URL (for Sources). */
  resourceText(url: string): Promise<string>;
  /** The workspace file a shown URL serves, if any (dev server paths, static previews). */
  workspaceFile(url: string): Promise<string | null>;
  /** Shows an element of the page in the Elements panel. */
  revealElement(id: string): void;
  /** Shows a request in the Network panel. */
  revealRequest(id: string): void;
  /** Shows a resource in Sources. */
  revealSource(url: string, line?: number): void;
  /** Syntax-colored nodes (the editor's colorizer), or null. */
  highlight(code: string, lang: string): Promise<Node[] | null>;
  copy(text: string): void;
  /** Opens the IDE's context menu. */
  menu(e: MouseEvent, items: import("../../../ui/Menu").MenuItem[]): void;
}

/** One DevTools tab. Created on first show; `onShow` each time it becomes visible. */
export interface DevtoolsPanel extends Disposable {
  readonly element: HTMLElement;
  onShow?(): void;
  onHide?(): void;
}

/** Pane sizes chosen by dragging, by split (kept while the IDE runs, for every browser tab). */
const paneSizes = new Map<string, number>();

/**
 * Two panes with a draggable divider (D146), like Chrome's: `sized` is the pane whose size is
 * kept ("first": a navigation list on the left; "second": a sidebar on the right). Narrower
 * than `stackBelow` px, the panes stack and the divider resizes heights instead. Double-click
 * the divider for the default size.
 */
export function splitPanes(
  store: DisposableStore,
  first: HTMLElement,
  second: HTMLElement,
  options: {
    key: string;
    sized: "first" | "second";
    size: number;
    min?: number;
    stackBelow?: number;
    /** Stacked, the sized pane's share of the height until dragged (default a half). */
    stackedShare?: number;
  },
): HTMLElement {
  const container = h("div", { class: "dt-split" });
  const sized = options.sized === "first" ? first : second;
  const minWide = options.min ?? 120;
  let stacked = false;
  let startSize = 0;
  const key = () => (stacked ? `${options.key}:stacked` : options.key);
  const apply = () => {
    const total = stacked ? container.clientHeight : container.clientWidth;
    // Stacked, a size of its own (a width in px makes no sense as a height).
    const want =
      paneSizes.get(key()) ??
      (stacked ? Math.round(total * (options.stackedShare ?? 0.5)) : options.size);
    // Stacked panes can be shorter than side-by-side ones are narrow.
    const min = stacked ? Math.min(minWide, 80) : minWide;
    const size = total > 0 ? Math.max(min, Math.min(want, total - min)) : want;
    sized.style.flex = `0 0 ${size}px`;
    sized.style.width = stacked ? "" : `${size}px`;
    sized.style.height = stacked ? `${size}px` : "";
  };
  const sash = store.add(
    new Sash(container, {
      orientation: "vertical",
      onStart: () => {
        const r = sized.getBoundingClientRect();
        startSize = stacked ? r.height : r.width;
      },
      onDrag: (delta) => {
        // The first pane grows with the pointer; the second shrinks.
        const signed = options.sized === "first" ? delta : -delta;
        paneSizes.set(key(), Math.max(stacked ? 60 : minWide, startSize + signed));
        apply();
      },
      onReset: () => {
        paneSizes.delete(key());
        apply();
      },
    }),
  );
  sash.element.classList.add("dt-sash");
  sized.classList.add("dt-pane-sized");
  container.append(first, sash.element, second);
  const observer = new ResizeObserver(() => {
    const stack = options.stackBelow !== undefined && container.clientWidth < options.stackBelow;
    if (stack !== stacked) {
      stacked = stack;
      container.classList.toggle("is-stacked", stacked);
      sash.orientation = stacked ? "horizontal" : "vertical";
    }
    apply();
  });
  observer.observe(container);
  store.add(toDisposable(() => observer.disconnect()));
  apply();
  return container;
}

export function iconButton(
  store: DisposableStore,
  name: IconName,
  title: string,
  run: () => void,
): HTMLButtonElement {
  const b = h("button", { class: "icon-button dt-icon", type: "button" }, icon(name));
  setTooltip(b, title);
  store.add(on(b, "click", run));
  return b;
}

/** A pressed/unpressed chip (filters, toggles). */
export function toggle(
  store: DisposableStore,
  label: string,
  initial: boolean,
  change: (on: boolean) => void,
  title?: string,
): HTMLButtonElement {
  const b = h(
    "button",
    { class: "dt-chip", type: "button", "aria-pressed": String(initial) },
    label,
  );
  if (title) setTooltip(b, title);
  store.add(
    on(b, "click", () => {
      const next = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(next));
      change(next);
    }),
  );
  return b;
}

export function filterInput(
  store: DisposableStore,
  placeholder: string,
  change: (text: string) => void,
): HTMLInputElement {
  const input = h("input", {
    class: "input dt-filter",
    type: "search",
    placeholder,
    spellcheck: "false",
  });
  let timer = 0;
  store.add(
    on(input, "input", () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => change(input.value.trim().toLowerCase()), 80);
    }),
  );
  return input;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatMs(ms: number): string {
  if (ms < 1) return "0 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** The last path segment of a URL (with query), for a compact name column. */
export function shortName(url: string): string {
  try {
    const u = new URL(url, "http://x/");
    const last = u.pathname.split("/").filter(Boolean).pop() ?? u.host;
    return (last || u.host || url) + u.search;
  } catch {
    return url;
  }
}

/** A two-column table of [key, value] rows. */
export function kvTable(rows: readonly (readonly [string, string])[], empty = "None"): HTMLElement {
  if (!rows.length) return h("div", { class: "dt-empty" }, empty);
  return h(
    "div",
    { class: "dt-kv" },
    ...rows.map(([k, v]) =>
      h(
        "div",
        { class: "dt-kv-row" },
        h("span", { class: "dt-kv-key" }, k),
        h("span", { class: "dt-kv-value" }, v),
      ),
    ),
  );
}

export const textDecoder = new TextDecoder();

/** Language id (for the colorizer) from a URL or mime type. */
export function languageOf(url: string, mime = ""): string {
  const m = mime.toLowerCase();
  if (m.includes("javascript") || /\.(m|c)?jsx?(\?|$)/.test(url)) return "javascript";
  if (/\.tsx?(\?|$)/.test(url)) return "typescript";
  if (m.includes("css") || /\.css(\?|$)/.test(url)) return "css";
  if (m.includes("json") || /\.(json|map)(\?|$)/.test(url)) return "json";
  if (m.includes("html") || /\.html?(\?|$)/.test(url) || url.endsWith("/")) return "html";
  if (m.includes("svg") || /\.svg(\?|$)/.test(url)) return "xml";
  return "plaintext";
}
