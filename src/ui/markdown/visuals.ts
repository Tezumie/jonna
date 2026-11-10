// Diagrams and math in Markdown (D172), wherever Markdown is shown: the chat, file previews, the
// guide, extension pages. ```mermaid blocks are drawn by pele (MIT, Obsidian's renderer for
// Mermaid syntax: no dependencies, well under a millisecond per diagram, every Mermaid diagram
// type including xychart bar / line charts, pie, sankey). $…$ / $$…$$ / ```math go through KaTeX
// (MIT) as MathML, which the webviews draw natively: no fonts or CSS to ship. Both load on first
// use as their own chunks; once loaded, rendering is synchronous (a re-rendered chat message
// doesn't flicker), and results are cached by source.
import { SizedCache, stringBytes } from "../../core/cache/index";
import { h } from "../../core/dom/index";
import { icon } from "../Icon";
import { setTooltip } from "../Tooltip";

type Pele = typeof import("pele");
type Katex = typeof import("katex").default;

let pele: Pele | null = null;
let peleLoading: Promise<Pele> | null = null;
let katex: Katex | null = null;
let katexLoading: Promise<Katex> | null = null;

function loadPele(): Promise<Pele> {
  peleLoading ??= import("pele").then((m) => {
    pele = m;
    return m;
  });
  return peleLoading;
}

function loadKatex(): Promise<Katex> {
  katexLoading ??= import("katex").then((m) => {
    katex = m.default;
    return m.default;
  });
  return katexLoading;
}

/**
 * Results by source (a streaming chat re-renders the same diagram every frame), bounded by size
 * (D416): one big diagram's SVG can outweigh dozens of small ones. The key counts too: it holds
 * the source.
 */
const diagrams = new SizedCache<string, { svg: string } | { error: string }>({
  maxBytes: 8 * 1024 * 1024,
  maxEntryBytes: 2 * 1024 * 1024,
  sizeOf: (v, key) => stringBytes(key) + stringBytes("svg" in v ? v.svg : v.error),
});
const formulas = new SizedCache<string, string>({
  maxBytes: 2 * 1024 * 1024,
  maxEntryBytes: 256 * 1024,
  sizeOf: (v, key) => stringBytes(key) + stringBytes(v),
});

function remember<V>(cache: SizedCache<string, V>, key: string, value: V): V {
  cache.set(key, value);
  return value;
}

/** Short and stable: the element's `data-key`, so `morph` swaps it when the source changes. */
function hash(text: string): string {
  let n = 5381;
  for (let i = 0; i < text.length; i++) n = ((n << 5) + n + text.charCodeAt(i)) | 0;
  return `${text.length}-${(n >>> 0).toString(36)}`;
}

/** Widths are rounded to this (a resize redraws in steps, not every pixel). */
const WIDTH_STEP = 40;
/** The UI's text size, not the renderer's 16px default. */
const FONT_SIZE = 14;

/** Drawn for `width` px of room (0: unknown yet, its natural size); laid out to fit it. */
function draw(source: string, width: number): { svg: string } | { error: string } {
  const key = `${width}|${source}`;
  const cached = diagrams.get(key);
  if (cached) return cached;
  try {
    const fontFamily = getComputedStyle(document.body).fontFamily;
    const { svg } = (pele as Pele).render(source, {
      fontFamily,
      fontSize: FONT_SIZE,
      ...(width > 0 && { maxWidth: width }),
    });
    return remember(diagrams, key, { svg });
  } catch (err) {
    const e = err as { message?: string; line?: number };
    const first = (e.message ?? String(err)).split("\n")[0] ?? "";
    return remember(diagrams, key, {
      error: e.line
        ? `Line ${e.line}: ${first.replace(/^Parse error on line \d+:?\s*/, "")}`
        : first,
    });
  }
}

/**
 * Diagrams on screen are redrawn for their width when it changes (the chat narrows, a preview
 * splits). One observer for all; a diagram that leaves the page reports 0 and is dropped.
 */
const redraw = new WeakMap<Element, () => void>();
let observer: ResizeObserver | null = null;
function watchWidth(body: HTMLElement, fill: () => void): void {
  redraw.set(body, fill);
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (!entry.target.isConnected || entry.contentRect.width === 0) {
        observer?.unobserve(entry.target);
        continue;
      }
      redraw.get(entry.target)?.();
    }
  });
  observer.observe(body);
}

function roomFor(body: HTMLElement): number {
  if (!body.isConnected) return 0;
  // The body's content box (its padding is the card's).
  const style = getComputedStyle(body);
  const width = body.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  return width > 0 ? Math.max(WIDTH_STEP, Math.floor(width / WIDTH_STEP) * WIDTH_STEP) : 0;
}

const SVG_ALLOWED_HREF = /^(https?:|mailto:|#)/i;

/** What a diagram may hold: shapes, text, grouping, gradients and markers (pele draws with these). */
const SVG_ELEMENTS = new Set(
  (
    "svg g path rect circle ellipse line polyline polygon text tspan textPath title desc defs " +
    "marker clipPath mask pattern linearGradient radialGradient stop symbol use a"
  ).split(" "),
);
/** CSS in a style attribute that could load or run something. */
const UNSAFE_STYLE = /url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:/i;

/**
 * The renderer's SVG as nodes, defensively cleaned (it escapes labels and drops unsafe links
 * itself; this is a second line, D174 audit): only the elements diagrams are drawn with (no
 * script, style, animate / set, image, foreignObject), no event handlers, no links other than
 * http(s), mailto and in-page, and no style that loads or runs anything.
 */
function svgNodes(svg: string): Node | null {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName !== "svg" || doc.querySelector("parsererror")) return null;
  for (const el of Array.from(root.querySelectorAll("*")))
    if (!SVG_ELEMENTS.has(el.localName) || el.namespaceURI !== root.namespaceURI) el.remove();
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))])
    for (const { name, value } of Array.from(el.attributes)) {
      if (/^on/i.test(name)) el.removeAttribute(name);
      else if (/(^|:)href$/i.test(name) && !SVG_ALLOWED_HREF.test(value.trim()))
        el.removeAttribute(name);
      else if (name === "style" && UNSAFE_STYLE.test(value)) el.removeAttribute(name);
      // <use> only within the diagram (an outside file would be a network load).
      else if (el.localName === "use" && /(^|:)href$/i.test(name) && !value.trim().startsWith("#"))
        el.removeAttribute(name);
    }
  return document.importNode(root, true);
}

/** A ```mermaid block as a drawn diagram, with its source a click away. */
export function diagramElement(
  source: string,
  o: { openLink(href: string): void; copy(text: string): void },
): HTMLElement {
  const body = h("div", { class: "md-diagram-body" });
  const code = h("pre", { class: "md-diagram-source", hidden: true }, h("code", null, source));
  const toggle = h("button", { class: "icon-button", type: "button" }, icon("code"));
  setTooltip(toggle, "Show the source");
  toggle.addEventListener("click", () => {
    code.hidden = !code.hidden;
    setTooltip(toggle, code.hidden ? "Show the source" : "Hide the source");
  });
  const copy = h("button", { class: "icon-button", type: "button" }, icon("copy"));
  setTooltip(copy, "Copy the source");
  copy.addEventListener("click", () => o.copy(source));
  // Pan and zoom (D190): Ctrl+wheel or the buttons zoom, dragging moves a zoomed diagram,
  // double-click goes back to fitting the width.
  const view = { scale: 1, x: 0, y: 0 };
  const apply = () => {
    const svg = body.firstElementChild as HTMLElement | null;
    if (!svg) return;
    const moved = view.scale !== 1 || view.x !== 0 || view.y !== 0;
    svg.style.transform = moved ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})` : "";
    svg.style.transformOrigin = "0 0";
    body.classList.toggle("is-zoomed", moved);
  };
  const zoomAt = (factor: number, cx: number, cy: number) => {
    const next = Math.min(8, Math.max(0.25, view.scale * factor));
    const f = next / view.scale;
    view.x = cx - (cx - view.x) * f;
    view.y = cy - (cy - view.y) * f;
    view.scale = next;
    apply();
  };
  const zoomButton = (name: "zoom-in" | "zoom-out" | "scan", tip: string, run: () => void) => {
    const b = h("button", { class: "icon-button", type: "button" }, icon(name));
    setTooltip(b, tip);
    b.addEventListener("click", run);
    return b;
  };
  const centerZoom = (factor: number) => {
    const r = body.getBoundingClientRect();
    zoomAt(factor, r.width / 2, r.height / 2);
  };
  const reset = () => {
    view.scale = 1;
    view.x = 0;
    view.y = 0;
    apply();
  };
  const zoomIn = zoomButton("zoom-in", "Zoom in (Ctrl+wheel)", () => centerZoom(1.25));
  const zoomOut = zoomButton("zoom-out", "Zoom out", () => centerZoom(0.8));
  const fit = zoomButton("scan", "Fit (double-click)", reset);
  body.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = body.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false },
  );
  body.addEventListener("dblclick", reset);
  body.addEventListener("pointerdown", (e) => {
    if (view.scale === 1 && view.x === 0 && view.y === 0) return;
    if ((e.target as Element).closest("a")) return;
    // Dragging pans; it mustn't select the diagram's text (D191).
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    const start = { x: e.clientX - view.x, y: e.clientY - view.y };
    body.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      view.x = m.clientX - start.x;
      view.y = m.clientY - start.y;
      apply();
    };
    const up = () => {
      body.removeEventListener("pointermove", move);
      body.removeEventListener("pointerup", up);
    };
    body.addEventListener("pointermove", move);
    body.addEventListener("pointerup", up);
  });
  // Links the diagram has (`click A "https://…"`) open through the host, like other links.
  body.addEventListener("click", (e) => {
    const a = (e.target as Element).closest("a");
    const href = a?.getAttribute("href") ?? a?.getAttribute("xlink:href");
    if (!href) return;
    e.preventDefault();
    if (!href.startsWith("#")) o.openLink(href);
  });
  let drawnFor = -1;
  const fill = () => {
    const width = roomFor(body);
    if (width === drawnFor) return;
    drawnFor = width;
    const result = draw(source, width);
    if ("svg" in result) {
      const node = svgNodes(result.svg);
      if (node) {
        body.replaceChildren(node);
        apply();
        return;
      }
    }
    // Not drawable: the error, and the source shown (what was written stays readable).
    body.replaceChildren(
      h(
        "div",
        { class: "md-diagram-error" },
        icon("circle-alert"),
        `Can't draw this diagram. ${"error" in result ? result.error : ""}`.trim(),
      ),
    );
    code.hidden = false;
  };
  const el = h(
    "figure",
    { class: "md-diagram", "data-key": `diagram:${hash(source)}:${pele ? 1 : 0}` },
    h(
      "div",
      { class: "md-pre-header" },
      h("span", { class: "md-pre-lang" }, "Diagram"),
      zoomOut,
      zoomIn,
      fit,
      toggle,
      copy,
    ),
    body,
    code,
  );
  // Drawn now at its natural size (or the placeholder), then for its real width once on screen.
  watchWidth(body, () => {
    if (pele) fill();
  });
  if (pele) fill();
  else {
    body.append(h("div", { class: "md-diagram-pending" }, "Drawing…"));
    void loadPele().then(fill, () => {
      body.replaceChildren(
        h("div", { class: "md-diagram-error" }, "The diagram renderer didn't load."),
      );
      code.hidden = false;
    });
  }
  return el;
}

function formula(tex: string, display: boolean): string {
  const key = `${display ? "D" : "I"}${tex}`;
  const cached = formulas.get(key);
  if (cached !== undefined) return cached;
  // MathML only (no fonts or CSS); errors render in place, in the error color, not thrown.
  const markup = (katex as Katex).renderToString(tex, {
    displayMode: display,
    output: "mathml",
    throwOnError: false,
    trust: false,
    strict: "ignore",
  });
  return remember(formulas, key, markup);
}

/** KaTeX's MathML (it escapes the source; `trust` is off, so no links or HTML) as nodes. */
function mathNodes(markup: string): Node[] {
  const doc = new DOMParser().parseFromString(`<body>${markup}</body>`, "text/html");
  for (const el of Array.from(doc.body.querySelectorAll("script, iframe, style"))) el.remove();
  return Array.from(doc.body.childNodes).map((n) => document.importNode(n, true));
}

/** `$…$` (inline) or `$$…$$` / ```math (display) as a formula. */
export function mathElement(tex: string, display: boolean): HTMLElement {
  const el = h(display ? "div" : "span", {
    class: display ? "md-math-block" : "md-math",
    "data-key": `math:${hash(tex)}:${katex ? 1 : 0}`,
    title: display ? undefined : tex,
  });
  const fill = () => {
    try {
      el.replaceChildren(...mathNodes(formula(tex, display)));
    } catch {
      el.textContent = display ? tex : `$${tex}$`;
    }
  };
  if (katex) fill();
  else {
    // The source until KaTeX has loaded (a few ms, once).
    el.textContent = display ? tex : `$${tex}$`;
    void loadKatex().then(fill, () => {});
  }
  return el;
}
