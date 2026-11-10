// Minimal DOM helpers: `h()` to build elements, `on()` / `delegate()` to listen with a Disposable.
// No virtual DOM. Components create their DOM once and update it in place (often from effects).
import { type Disposable, toDisposable } from "../lifecycle/index";

export type Child = Node | string | number | null | undefined | false | readonly Child[];

export type Props = {
  class?: string | Record<string, boolean>;
  style?: Partial<Record<string, string>>;
  dataset?: Record<string, string>;
} & Record<string, unknown>;

/** The subset of `Document` that `h()` needs (lets tests pass a fake document). */
export interface DocumentLike {
  createElement(tag: string): HTMLElement;
  createTextNode(text: string): Text;
}

/**
 * Creates an element: `h("div", { class: "row", "aria-label": "x" }, child, …)`.
 * Attribute values: `true` sets an empty attribute, `false`/null/undefined omit it.
 * Event handlers are deliberately not supported here; use `on()` so they're owned by a store.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K];
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement;
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement {
  const doc = currentDocument();
  const el = doc.createElement(tag);
  if (props) applyProps(el, props);
  append(el, children, doc);
  return el;
}

function applyProps(el: HTMLElement, props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") {
      el.setAttribute("class", classNames(value as Props["class"]));
    } else if (key === "style") {
      for (const [prop, v] of Object.entries(value as Record<string, string>)) {
        if (v !== undefined) el.style.setProperty(prop, v);
      }
    } else if (key === "dataset") {
      for (const [k, v] of Object.entries(value as Record<string, string>)) el.dataset[k] = v;
    } else if (typeof value === "function") {
      throw new Error(`h(): use on() for event handlers (got "${key}")`);
    } else {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
}

/** `classNames({ a: true, b: false })` → "a"; strings pass through. */
export function classNames(value: Props["class"]): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return Object.entries(value)
    .filter(([, on]) => on)
    .map(([name]) => name)
    .join(" ");
}

/** Replaces all children of `parent` (same child rules as `h()`). */
export function replaceChildren(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

/** Appends children (flattening arrays, skipping null/false). */
export function append(parent: Node, children: readonly Child[], doc = currentDocument()): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child, doc);
    else if (typeof child === "string" || typeof child === "number") {
      parent.appendChild(doc.createTextNode(String(child)));
    } else parent.appendChild(child as Node);
  }
}

let testDocument: DocumentLike | undefined;
/** Tests only: route `h()` to a fake document. */
export function setDocumentForTests(doc: DocumentLike | undefined): void {
  testDocument = doc;
}
function currentDocument(): DocumentLike {
  return testDocument ?? globalThis.document;
}

// ---- Events -----------------------------------------------------------------

type Handler<E> = (event: E) => void;

export function on<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  handler: Handler<HTMLElementEventMap[K]>,
  options?: AddEventListenerOptions,
): Disposable;
export function on<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  handler: Handler<WindowEventMap[K]>,
  options?: AddEventListenerOptions,
): Disposable;
export function on<K extends keyof DocumentEventMap>(
  target: Document,
  type: K,
  handler: Handler<DocumentEventMap[K]>,
  options?: AddEventListenerOptions,
): Disposable;
export function on(
  target: EventTarget,
  type: string,
  handler: Handler<Event>,
  options?: AddEventListenerOptions,
): Disposable;
/** Adds an event listener and returns a Disposable that removes it. */
export function on(
  target: EventTarget,
  type: string,
  handler: Handler<Event>,
  options?: AddEventListenerOptions,
): Disposable {
  target.addEventListener(type, handler, options);
  return toDisposable(() => target.removeEventListener(type, handler, options));
}

/**
 * Event delegation: one listener on `root` handles events from descendants matching `selector`.
 * `handler` receives the matched element (closest match inside `root`).
 */
export function delegate<K extends keyof HTMLElementEventMap>(
  root: HTMLElement,
  type: K,
  selector: string,
  handler: (event: HTMLElementEventMap[K], matched: HTMLElement) => void,
): Disposable {
  return on(root, type, (event) => {
    const target = event.target as Element | null;
    const matched = target?.closest?.(selector);
    if (matched instanceof HTMLElement && root.contains(matched)) handler(event, matched);
  });
}

/**
 * Updates `target` in place to look like `source` (attributes, text, children by position) and
 * returns the node now in the document — `target`, or `source` where the tag or `data-key` differs. Unchanged
 * nodes stay the same objects, so hover, focus, CSS animations and a click in progress survive a
 * re-render. Event listeners stay those of `target`: handlers must read their state when they run,
 * not capture it at render time.
 */
export function morph(target: Node, source: Node): Node {
  const key = (n: Node) => (n.nodeType === 1 ? (n as Element).getAttribute("data-key") : null);
  // A different tag, or a different `data-key` (an element whose handlers belong to one thing).
  if (
    target.nodeType !== source.nodeType ||
    target.nodeName !== source.nodeName ||
    key(target) !== key(source)
  ) {
    (target as ChildNode).replaceWith(source);
    return source;
  }
  if (target.nodeType !== 1) {
    if (target.nodeValue !== source.nodeValue) target.nodeValue = source.nodeValue;
    return target;
  }
  // An identical subtree, compared natively: nothing to walk. A long document's re-render is
  // mostly unchanged blocks (D278).
  if (target.isEqualNode(source)) return target;
  const a = target as Element;
  const b = source as Element;
  for (const { name } of Array.from(a.attributes))
    if (!b.hasAttribute(name)) a.removeAttribute(name);
  for (const { name, value } of Array.from(b.attributes))
    if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  const next = Array.from(b.childNodes);
  const have = Array.from(a.childNodes);
  for (const [i, child] of next.entries()) {
    const old = have[i];
    if (old) morph(old, child);
    else a.appendChild(child);
  }
  for (const extra of have.slice(next.length)) extra.remove();
  return a;
}
