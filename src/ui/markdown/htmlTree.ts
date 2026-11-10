// The browser's own HTML parser on the sanitizer's clean output (D218): README HTML gets HTML's
// full tree-building rules (implied end tags, foster parenting of what's misplaced in a table,
// misnested formatting), as markdown-it's output does in VS Code's preview, and the Markdown
// between HTML blocks lands inside the elements they leave open (`<details>` + blank line +
// Markdown). The parser runs in a DOMParser document, which has no browsing context: nothing in it
// runs or loads. It only ever sees what SafeHtmlWriter wrote (allowlisted tags, checked and
// escaped attributes, escaped text), and its tree is checked again here — every element through
// cleanTag, the same allowlist — before render.ts rebuilds it as fresh elements in the page.
// Inline HTML in a paragraph (`<b>…</b>` in prose) goes the same way (D229), so misnested
// formatting nests as the browser's parser has it.
// Without a DOMParser (unit tests) the sanitizer's own tree builder stands in.
import {
  cleanTag,
  SafeHtmlBuilder,
  type SafeHtmlWriter,
  type SafeNode,
  SLOT_ATTR,
} from "./sanitize";

const HTML_NS = "http://www.w3.org/1999/xhtml";
/** Deeper elements keep only their content (the page's own nesting stays sane). */
const MAX_DEPTH = 48;

/** The writer's HTML as a checked tree; Markdown slots as `slot` nodes. */
export function safeTree(writer: SafeHtmlWriter): SafeNode[] {
  if (typeof DOMParser === "undefined") return builderTree(writer);
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><head></head><body>${writer.html}</body></html>`,
    "text/html",
  );
  return walk(doc.body, 0);
}

/** The simple tree builder over the same tokens (no browser parser here). */
export function builderTree(writer: SafeHtmlWriter): SafeNode[] {
  const b = new SafeHtmlBuilder({ unknownAsText: writer.options.inline === true });
  for (const t of writer.tokens) {
    if (t.kind === "text") b.text(t.text);
    else if (t.kind === "slot") b.slot(t.index);
    else b.tag(t.tag);
  }
  return b.roots;
}

function walk(parent: Node, depth: number): SafeNode[] {
  const out: SafeNode[] = [];
  const text = (value: string) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.text += value;
    else out.push({ kind: "text", text: value });
  };
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      text((node as Text).data);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as Element;
    const slot = el.getAttribute(SLOT_ATTR);
    // Block slots are divs, a paragraph's (inline) slots spans.
    if (slot !== null && (el.localName === "div" || el.localName === "span")) {
      const index = Number(slot);
      if (Number.isInteger(index) && index >= 0) out.push({ kind: "slot", index });
      continue;
    }
    // The writer turned ids into data-anchor; cleanTag checks them (and every other) again.
    const attrs: [string, string][] = Array.from(el.attributes, (a) => [
      a.name === "data-anchor" ? "id" : a.name,
      a.value,
    ]);
    const clean =
      el.namespaceURI === HTML_NS && depth < MAX_DEPTH ? cleanTag(el.localName, attrs) : null;
    const children = walk(el, clean ? depth + 1 : depth);
    if (clean) out.push({ kind: "element", tag: clean.tag, attrs: clean.attrs, children });
    else
      for (const c of children) {
        if (c.kind === "text") text(c.text);
        else out.push(c);
      }
  }
  return out;
}
