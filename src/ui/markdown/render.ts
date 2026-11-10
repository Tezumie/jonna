// Renders parsed Markdown (parse.ts) to DOM nodes — text only through textContent, links only for
// http(s)/mailto (opened by the host), code blocks with a copy button. Styles: DESIGN.md §14.
import { h } from "../../core/dom/index";
import { icon } from "../Icon";
import { setLinkTooltip, setTooltip } from "../Tooltip";
import { safeTree } from "./htmlTree";
import { type Block, type Inline, parseMarkdown } from "./parse";
import { SafeHtmlWriter, type SafeNode, safeSrcset } from "./sanitize";
import { diagramElement, mathElement } from "./visuals";

export interface RenderOptions {
  /** Opens a link (the host decides: system browser, editor for file paths…). */
  openLink(href: string): void;
  copy(text: string): void;
  /** Heading level shift: chat answers render `#` as h2 (1, default); file previews as h1 (0). */
  headingShift?: number;
  /** An image's displayable URL (a blob: URL for a workspace file), or null to show its alt text. */
  image?(src: string): string | null | Promise<string | null>;
  /** Syntax-colored nodes for a code block (the editor engine's colorizer), or null; may be async. */
  highlight?(code: string, lang: string): Node[] | null | Promise<Node[] | null>;
  /** Single newlines inside a paragraph: a line break (chat, the default) or a space (documents). */
  softBreaks?: "br" | "space";
  /** Puts `data-line` (source line) on blocks for scroll sync. */
  lines?: boolean;
  /**
   * Extra buttons in a code block's header (before Copy): the chat's Apply / Insert. `info` is
   * the fence's whole info string ("ts:src/a.ts"); `closed` is false while it streams.
   */
  codeActions?(block: { text: string; lang: string; info: string; closed: boolean }): Node[];
  /** Draw ```mermaid diagrams and $math$ (default true; D172). */
  visuals?: boolean;
  /** Footnote numbers by id, in order of first reference (set per render). */
  notes?: Map<string, number>;
}

/**
 * Inline nodes; raw HTML tags among them (`# <img src=…>`, `<a href=…>text</a>`) nest what's
 * between them, through the sanitizer and the browser's parser like HTML blocks (D229: misnested
 * `<b><i></b></i>` as the browser has it). Unknown tags in prose ("Vec<T>") stay text.
 */
function inline(nodes: readonly Inline[], o: RenderOptions): Node[] {
  if (!nodes.some((n) => n.kind === "tag")) return nodes.map((n) => inlineNode(n, o));
  const writer = new SafeHtmlWriter({ inline: true });
  for (const [i, n] of nodes.entries()) {
    if (n.kind === "tag") writer.tag(n.tag);
    else writer.slot(i);
  }
  return safeDom(safeTree(writer), o, (i) => {
    const n = nodes[i];
    return n ? [inlineNode(n, o)] : [];
  });
}

function inlineNode(n: Inline, o: RenderOptions): Node {
  switch (n.kind) {
    case "text":
      return document.createTextNode(n.text);
    case "code":
      return h("code", { class: "md-code" }, n.text);
    case "math":
      return o.visuals === false
        ? h("code", { class: "md-code" }, `$${n.tex}$`)
        : mathElement(n.tex, false);
    case "strong":
      return h("strong", null, ...inline(n.children, o));
    case "em":
      return h("em", null, ...inline(n.children, o));
    case "del":
      return h("del", null, ...inline(n.children, o));
    case "mark":
    case "sub":
    case "sup":
      return h(n.kind, null, ...inline(n.children, o));
    case "footnoteRef": {
      const notes = o.notes ?? new Map<string, number>();
      let num = notes.get(n.id);
      if (num === undefined) {
        num = notes.size + 1;
        notes.set(n.id, num);
      }
      const a = h(
        "a",
        { class: "md-link", href: "#", id: `fnref-${n.id}`, "data-key": n.id },
        `[${num}]`,
      );
      a.addEventListener("click", (e) => {
        e.preventDefault();
        o.openLink(`#fn-${n.id}`);
      });
      return h("sup", { class: "md-footnote-ref" }, a);
    }
    case "image":
      return imageElement(n.src, n.alt, o);
    case "br":
      return n.soft && o.softBreaks === "space" ? document.createTextNode(" ") : h("br");
    case "link": {
      const a = h(
        "a",
        { class: "md-link", href: "#", "data-key": n.href },
        ...inline(n.children, o),
      );
      setLinkTooltip(a, n.href);
      a.addEventListener("click", (e) => {
        e.preventDefault();
        o.openLink(n.href);
      });
      return a;
    }
    default:
      return document.createTextNode("");
  }
}

/**
 * A sequence of blocks (a document, a list item, a quote…). HTML blocks that leave elements open
 * take in the Markdown that follows, up to the block that closes them (D218: `<details>`, blank
 * line, Markdown, `</details>` as on GitHub): such a run is one `md-html` element, its HTML parsed
 * by the browser's parser with the Markdown blocks in their places.
 */
function blockList(list: readonly Block[], o: RenderOptions): HTMLElement[] {
  const out: HTMLElement[] = [];
  let i = 0;
  while (i < list.length) {
    const first = list[i] as Block;
    if (first.kind !== "htmlBlock") {
      out.push(block(first, o));
      i++;
      continue;
    }
    const writer = new SafeHtmlWriter();
    const members: Block[] = [];
    do {
      const b = list[i] as Block;
      if (b.kind === "htmlBlock") writer.write(b.html);
      else writer.slot(members.length);
      members.push(b);
      i++;
    } while (i < list.length && writer.openCount > 0);
    const el = htmlElement(writer, members, o);
    if (o.lines && first.line !== undefined) el.dataset.line = String(first.line);
    out.push(el);
  }
  return out;
}

/** HTML blocks (and the Markdown blocks among them, `members[slot]`) as one `md-html` element. */
function htmlElement(
  writer: SafeHtmlWriter,
  members: readonly Block[],
  o: RenderOptions,
): HTMLElement {
  return h(
    "div",
    { class: "md-html" },
    ...safeDom(safeTree(writer), o, (index) => {
      const b = members[index];
      return b && b.kind !== "htmlBlock" ? [block(b, o)] : [];
    }),
  );
}

/** A block element; with `o.lines`, tagged with its source line (every level, for scroll sync). */
function block(b: Block, o: RenderOptions): HTMLElement {
  const el = blockElement(b, o);
  if (o.lines && b.line !== undefined) el.dataset.line = String(b.line);
  return el;
}

function blockElement(b: Block, o: RenderOptions): HTMLElement {
  switch (b.kind) {
    case "heading":
      return h(
        `h${Math.min(b.level + (o.headingShift ?? 1), 6)}` as "h2",
        { class: "md-heading", id: slug(b.children) },
        ...inline(b.children, o),
      );
    case "paragraph":
      return h("p", null, ...inline(b.children, o));
    case "math":
      if (o.visuals !== false) return mathElement(b.tex, true);
      return blockElement({ kind: "code", lang: "math", text: b.tex, closed: true }, o);
    case "code": {
      // A finished ```mermaid block is drawn (while it streams, its source shows as code).
      const fence = b.lang.toLowerCase();
      if (o.visuals !== false && b.closed && b.text.trim()) {
        if (fence === "mermaid") return diagramElement(b.text, o);
        if (fence === "math") return mathElement(b.text, true);
      }
      const copy = h("button", { class: "icon-button md-copy", type: "button" }, icon("copy"));
      setTooltip(copy, "Copy");
      // Copies what the block shows now (streamed blocks are updated in place).
      copy.addEventListener("click", () =>
        o.copy(copy.closest(".md-pre")?.querySelector("code")?.textContent ?? b.text),
      );
      const code = h("code", null, b.text);
      // "```src/main.rs" parses as lang "src": show (and color by) the file name instead.
      const info = b.info ?? b.lang;
      const named = /^[\w.-]*[/.]/.test(info) ? (info.split(/\s+/)[0] ?? "") : "";
      const label = named && named.length > b.lang.length ? named : b.lang;
      const lang = label === b.lang ? b.lang : (label.split(".").pop() ?? b.lang);
      if (o.highlight && b.text) {
        const nodes = o.highlight(b.text, lang);
        if (Array.isArray(nodes)) code.replaceChildren(...nodes);
        else if (nodes)
          void nodes.then((n) => {
            if (n) code.replaceChildren(...n);
          });
      }
      return h(
        "div",
        { class: "md-pre" },
        h(
          "div",
          // Keyed by what the actions are for: a block that closes while streaming gets Apply and
          // Insert, and `morph` must not turn its old Copy button into one (D161).
          { class: "md-pre-header", "data-key": `${b.closed ? "closed" : "open"}:${info}` },
          h("span", { class: "md-pre-lang" }, label || "text"),
          ...(o.codeActions?.({ text: b.text, lang: b.lang, info, closed: b.closed }) ?? []),
          copy,
        ),
        h("pre", null, code),
      );
    }
    case "list": {
      const items = b.items.map((it, i) => {
        const box = b.checked[i];
        return h(
          "li",
          box === null || box === undefined ? null : { class: "md-task" },
          box === null || box === undefined
            ? null
            : h("input", { type: "checkbox", disabled: true, ...(box && { checked: true }) }),
          ...blockList(it, o),
        );
      });
      return b.ordered ? h("ol", { start: b.start }, ...items) : h("ul", null, ...items);
    }
    case "quote":
      return h("blockquote", null, ...blockList(b.children, o));
    case "rule":
      return h("hr");
    case "alert":
      return h(
        "div",
        { class: `md-alert md-alert-${b.type}` },
        h("p", { class: "md-alert-title" }, ALERT_TITLES[b.type] ?? b.type),
        ...blockList(b.children, o),
      );
    case "deflist":
      return h(
        "dl",
        null,
        ...b.items.flatMap((it) => [
          h("dt", null, ...inline(it.term, o)),
          ...it.defs.map((d) => h("dd", null, ...blockList(d, o))),
        ]),
      );
    case "htmlBlock": {
      const writer = new SafeHtmlWriter();
      writer.write(b.html);
      return htmlElement(writer, [], o);
    }
    case "footnotes": {
      const notes = o.notes ?? new Map<string, number>();
      // Referenced notes in reference order, then any never referenced.
      const ordered = [...b.items].sort(
        (x, y) => (notes.get(x.id) ?? 1e9) - (notes.get(y.id) ?? 1e9),
      );
      return h(
        "section",
        { class: "md-footnotes" },
        h("hr"),
        h(
          "ol",
          null,
          ...ordered.map((it) => {
            const back = h("a", { class: "md-link md-footnote-back", href: "#" }, "↩");
            setTooltip(back, "Back to the reference");
            back.addEventListener("click", (e) => {
              e.preventDefault();
              o.openLink(`#fnref-${it.id}`);
            });
            const children = blockList(it.children, o);
            (children[children.length - 1] ?? children[0])?.append(" ", back);
            return h("li", { id: `fn-${it.id}` }, ...children);
          }),
        ),
      );
    }
    case "table":
      return h(
        "div",
        { class: "md-table-wrap" },
        h(
          "table",
          null,
          h("thead", null, h("tr", null, ...b.header.map((c) => h("th", null, ...inline(c, o))))),
          h(
            "tbody",
            null,
            ...b.rows.map((r) => h("tr", null, ...r.map((c) => h("td", null, ...inline(c, o))))),
          ),
        ),
      );
  }
}

const ALERT_TITLES: Record<string, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

/** An image: data:image URLs as they are, anything else through `o.image` (null: its alt text). */
function imageElement(src: string, alt: string, o: RenderOptions, key = src): HTMLElement {
  const missing = () => h("span", { class: "md-image-missing" }, alt || src);
  const img = h("img", { class: "md-image", alt });
  setTooltip(img, alt || src);
  img.dataset.key = key;
  if (!src) return missing();
  // One that can't load (gone, blocked, not an image) shows its alt text, as a missing one does.
  img.addEventListener("error", () => img.replaceWith(missing()), { once: true });
  if (/^data:image\//i.test(src)) img.setAttribute("src", src);
  else if (o.image) {
    const url = o.image(src);
    if (typeof url === "string") img.setAttribute("src", url);
    else if (url === null) return missing();
    else
      void url.then((u) => {
        if (u) img.setAttribute("src", u);
        else img.replaceWith(missing());
      });
  } else return missing();
  return img;
}

/**
 * A sanitized `srcset` with each URL made displayable now (data:image as is, others through
 * `o.image` when it answers at once; a workspace image that's still loading is left out until
 * the re-render that follows its load). Empty when none is ready.
 */
function displaySrcset(srcset: string, o: RenderOptions): string {
  const out: string[] = [];
  for (const { url, descriptor } of safeSrcset(srcset)) {
    const shown = /^data:image\//i.test(url) ? url : o.image?.(url);
    if (typeof shown === "string" && !/[\s,]/.test(shown))
      out.push(descriptor ? `${shown} ${descriptor}` : shown);
  }
  return out.join(", ");
}

/** The IDE's theme ("light" / "dark"): what `prefers-color-scheme` in a README should follow. */
const themeKind = (): "light" | "dark" =>
  document.documentElement.dataset.theme === "light" ? "light" : "dark";

/**
 * Sanitized HTML (sanitize.ts) as fresh elements: only the attributes the sanitizer kept, links
 * through `openLink` (the href is never put on the element), images through `image`. `slot`
 * renders the Markdown between inline tags.
 */
function safeDom(
  nodes: readonly SafeNode[],
  o: RenderOptions,
  slot?: (index: number) => Node[],
): Node[] {
  const out: Node[] = [];
  for (const n of nodes) {
    if (n.kind === "text") out.push(document.createTextNode(n.text));
    else if (n.kind === "slot") out.push(...(slot?.(n.index) ?? []));
    else {
      const el = safeElement(n, o, slot);
      if (el) out.push(el);
    }
  }
  return out;
}

function safeElement(
  n: Extract<SafeNode, { kind: "element" }>,
  o: RenderOptions,
  slot?: (index: number) => Node[],
): Node | null {
  const { tag, attrs } = n;
  if (tag === "img") {
    const img = imageElement(attrs.src ?? "", attrs.alt ?? "", o, attrs.src ?? attrs.srcset ?? "");
    if (img instanceof HTMLImageElement) {
      for (const name of ["width", "height", "align", "title", "loading"] as const)
        if (attrs[name] !== undefined) img.setAttribute(name, attrs[name] as string);
      if (attrs.srcset) {
        const set = displaySrcset(attrs.srcset, o);
        if (set) img.setAttribute("srcset", set);
      }
      if (attrs["data-anchor"]) img.dataset.anchor = attrs["data-anchor"];
    }
    return img;
  }
  if (tag === "source") {
    // A <picture>'s alternatives: GitHub's dark / light logos follow the IDE's theme.
    const media = attrs.media ?? "";
    const scheme = /prefers-color-scheme:\s*(light|dark)/i.exec(media)?.[1]?.toLowerCase();
    if (scheme && scheme !== themeKind()) return null;
    const set = attrs.srcset ? displaySrcset(attrs.srcset, o) : "";
    if (!set) return null;
    const source = document.createElement("source");
    source.setAttribute("srcset", set);
    if (media && !scheme) source.setAttribute("media", media);
    if (attrs.type) source.setAttribute("type", attrs.type);
    return source;
  }
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs))
    if (name !== "href") el.setAttribute(name, value);
  if (tag === "a") {
    const href = attrs.href;
    if (href) {
      el.setAttribute("href", "#");
      el.classList.add("md-link");
      el.dataset.key = href;
      setLinkTooltip(el, href);
      el.addEventListener("click", (e) => {
        e.preventDefault();
        o.openLink(href);
      });
    }
  }
  el.append(...safeDom(n.children, o, slot));
  return el;
}

/**
 * README-style HTML through the allowlist sanitizer (sanitize.ts) and the browser's parser on its
 * clean output (htmlTree.ts): kept tags rebuilt as fresh elements with checked attributes only
 * (no handlers, no style, no script URLs), links through `openLink`, images through `image`,
 * unknown tags keep their text, scripts and frames vanish.
 */
export function sanitizeHtml(html: string, o: RenderOptions): Node[] {
  const writer = new SafeHtmlWriter();
  writer.write(html);
  return safeDom(safeTree(writer), o);
}

/** GitHub-style heading id ("Getting started" → "getting-started") for `#anchor` links. */
export function slug(children: readonly Inline[]): string {
  const text = (nodes: readonly Inline[]): string =>
    nodes.map((n) => ("text" in n ? n.text : "children" in n ? text(n.children) : "")).join("");
  return text(children)
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

/** The rendered blocks of `source` (each top-level one with `data-line` when `o.lines`). */
export function markdownNodes(source: string, options: RenderOptions): HTMLElement[] {
  const o = { ...options, notes: new Map<string, number>() };
  return blockList(parseMarkdown(source), o);
}

/** Replaces `host`'s content with the rendered Markdown. */
export function renderMarkdown(host: HTMLElement, source: string, o: RenderOptions): void {
  host.replaceChildren(...markdownNodes(source, o));
}

/**
 * Whether a double-click at `target` belongs to a control in rendered Markdown (a link, a button
 * such as a diagram's zoom or a code block's copy, a field, a diagram you pan and zoom), so it
 * mustn't also switch the preview to its source (D202).
 */
export function isMarkdownControl(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "a, button, input, select, textarea, summary, label, [role='button'], [contenteditable='true'], .md-diagram, .md-pre-header",
    ) !== null
  );
}
