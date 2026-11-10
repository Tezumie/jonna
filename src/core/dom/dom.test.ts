import assert from "node:assert/strict";
import { test } from "node:test";
import { classNames, type DocumentLike, h, morph, on, setDocumentForTests } from "./index";

/** Just enough of the DOM for h(): elements with attributes, style, dataset and children. */
class FakeNode {
  children: FakeNode[] = [];
  appendChild(child: FakeNode): FakeNode {
    this.children.push(child);
    return child;
  }
}
class FakeText extends FakeNode {
  constructor(public data: string) {
    super();
  }
}
class FakeElement extends FakeNode {
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  styles = new Map<string, string>();
  style = { setProperty: (k: string, v: string) => this.styles.set(k, v) };
  constructor(public tagName: string) {
    super();
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}
const fakeDocument = {
  createElement: (tag: string) => new FakeElement(tag),
  createTextNode: (text: string) => new FakeText(text),
} as unknown as DocumentLike;

test("h() builds elements with attributes, classes, style, dataset and children", () => {
  setDocumentForTests(fakeDocument);
  try {
    const el = h(
      "div",
      {
        class: { row: true, hidden: false },
        style: { "--indent": "8px" },
        dataset: { path: "/a" },
        "aria-expanded": true,
        title: "x",
        tabindex: 0,
        hidden: false,
      },
      "text",
      [h("span", null, 1), null, false],
    ) as unknown as FakeElement;
    assert.equal(el.tagName, "div");
    assert.equal(el.attributes.get("class"), "row");
    assert.equal(el.attributes.get("aria-expanded"), "");
    assert.equal(el.attributes.get("tabindex"), "0");
    assert.equal(el.attributes.has("hidden"), false);
    assert.equal(el.styles.get("--indent"), "8px");
    assert.equal(el.dataset.path, "/a");
    assert.equal(el.children.length, 2);
    assert.equal((el.children[0] as FakeText).data, "text");
    assert.throws(() => h("div", { onclick: () => {} }), /use on\(\)/);
  } finally {
    setDocumentForTests(undefined);
  }
});

test("classNames joins enabled classes", () => {
  assert.equal(classNames({ a: true, b: false, c: true }), "a c");
  assert.equal(classNames("x y"), "x y");
  assert.equal(classNames(undefined), "");
});

test("on() returns a Disposable that removes the listener", () => {
  const target = new EventTarget();
  let calls = 0;
  const d = on(target, "ping", () => calls++);
  target.dispatchEvent(new Event("ping"));
  d.dispose();
  target.dispatchEvent(new Event("ping"));
  assert.equal(calls, 1);
});

/** A minimal node tree for morph(): elements (attributes, children) and text nodes. */
class MNode {
  parent: MNode | null = null;
  childNodes: MNode[] = [];
  attrs = new Map<string, string>();
  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    public nodeValue: string | null = null,
  ) {}
  get attributes() {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }
  getAttribute(n: string) {
    return this.attrs.get(n) ?? null;
  }
  hasAttribute(n: string) {
    return this.attrs.has(n);
  }
  setAttribute(n: string, v: string) {
    this.attrs.set(n, v);
  }
  removeAttribute(n: string) {
    this.attrs.delete(n);
  }
  appendChild(c: MNode) {
    c.remove();
    c.parent = this;
    this.childNodes.push(c);
    return c;
  }
  remove() {
    if (!this.parent) return;
    this.parent.childNodes = this.parent.childNodes.filter((n) => n !== this);
    this.parent = null;
  }
  replaceWith(n: MNode) {
    const p = this.parent;
    if (!p) return;
    n.remove();
    p.childNodes[p.childNodes.indexOf(this)] = n;
    n.parent = p;
    this.parent = null;
  }
  isEqualNode(other: MNode) {
    return this.html === other.html;
  }
  get html(): string {
    if (this.nodeType === 3) return this.nodeValue ?? "";
    const attrs = this.attributes.map((a) => ` ${a.name}="${a.value}"`).join("");
    return `<${this.nodeName}${attrs}>${this.childNodes.map((c) => c.html).join("")}</${this.nodeName}>`;
  }
}
const el = (tag: string, attrs: Record<string, string>, ...kids: (MNode | string)[]) => {
  const n = new MNode(1, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const k of kids) n.appendChild(typeof k === "string" ? new MNode(3, "#text", k) : k);
  return n;
};

test("morph: updates in place, keeps unchanged nodes, replaces on tag or data-key change", () => {
  const button = el("BUTTON", { class: "x" }, "Hi");
  const root = el("DIV", {}, button, el("SPAN", {}, "1"));
  const out = morph(
    root as unknown as Node,
    el(
      "DIV",
      {},
      el("BUTTON", { class: "y" }, "Hi there"),
      el("P", {}, "2"),
      el("I", { "data-key": "k" }, "3"),
    ) as unknown as Node,
  );
  assert.equal(out, root);
  assert.equal(root.childNodes[0], button);
  assert.equal(
    root.html,
    '<DIV><BUTTON class="y">Hi there</BUTTON><P>2</P><I data-key="k">3</I></DIV>',
  );
  const keyed = root.childNodes[2];
  morph(
    root as unknown as Node,
    el(
      "DIV",
      {},
      el("BUTTON", { class: "y" }, "Hi there"),
      el("P", {}, "2"),
      el("I", { "data-key": "z" }, "3"),
    ) as unknown as Node,
  );
  assert.notEqual(root.childNodes[2], keyed);
  assert.equal(root.childNodes.length, 3);
});

test("morph: an identical tree keeps every node", () => {
  const span = el("SPAN", { class: "a" }, "x");
  const root = el("DIV", {}, el("P", {}, span));
  const out = morph(
    root as unknown as Node,
    el("DIV", {}, el("P", {}, el("SPAN", { class: "a" }, "x"))) as unknown as Node,
  );
  assert.equal(out, root);
  assert.equal(root.childNodes[0]?.childNodes[0], span);
});
