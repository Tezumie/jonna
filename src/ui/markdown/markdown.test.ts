import assert from "node:assert/strict";
import { test } from "node:test";
import { builderTree } from "./htmlTree";
import { parseInline, parseMarkdown } from "./parse";
import { SafeHtmlWriter } from "./sanitize";

test("inline: code, strong, em, links, snake_case", () => {
  assert.deepEqual(parseInline("use `a*b` and **bold** _it_ [x](https://e.com) snake_case_name"), [
    { kind: "text", text: "use " },
    { kind: "code", text: "a*b" },
    { kind: "text", text: " and " },
    { kind: "strong", children: [{ kind: "text", text: "bold" }] },
    { kind: "text", text: " " },
    { kind: "em", children: [{ kind: "text", text: "it" }] },
    { kind: "text", text: " " },
    { kind: "link", href: "https://e.com", children: [{ kind: "text", text: "x" }] },
    { kind: "text", text: " snake_case_name" },
  ]);
});

test("blocks: headings, fences (unclosed while streaming), lists, tables, quotes", () => {
  const md =
    "# Title\n\nSome text\nmore.\n\n- a\n- b\n  - nested\n1. one\n2. two\n\n| x | y |\n|---|:-:|\n| 1 | 2 |\n\n> quoted\n\n---\n```ts\nconst x = 1;\n";
  const b = parseMarkdown(md);
  assert.deepEqual(
    b.map((x) => x.kind),
    ["heading", "paragraph", "list", "list", "table", "quote", "rule", "code"],
  );
  const list = b[2];
  assert.ok(
    list?.kind === "list" && list.items.length === 2 && list.items[1]?.[1]?.kind === "list",
  );
  const code = b[7];
  assert.ok(
    code?.kind === "code" && code.lang === "ts" && code.text === "const x = 1;" && !code.closed,
  );
  const table = b[4];
  assert.ok(table?.kind === "table" && table.rows.length === 1 && table.header.length === 2);
});

test("parseMarkdown: setext, tasks, images, strikethrough, autolinks, comments, lines", () => {
  const blocks = parseMarkdown(
    "Title\n=====\n\n<!-- hidden -->\n- [x] done\n- [ ] todo\n\nSee ![logo](img/a.png) ~~old~~ https://example.com.",
  );
  assert.equal(blocks[0]?.kind, "heading");
  assert.equal(blocks[0]?.line, 0);
  const list = blocks[1];
  assert.ok(list?.kind === "list");
  assert.deepEqual(list.kind === "list" && list.checked, [true, false]);
  assert.equal(list.line, 4);
  const para = blocks[2];
  assert.ok(para?.kind === "paragraph");
  const kinds = para.kind === "paragraph" ? para.children.map((c) => c.kind) : [];
  assert.ok(kinds.includes("image") && kinds.includes("del") && kinds.includes("link"));
  const link = para.kind === "paragraph" ? para.children.find((c) => c.kind === "link") : undefined;
  assert.equal(link?.kind === "link" && link.href, "https://example.com");
});

test("parseMarkdown: footnotes, alerts, deflists, front matter, html, mark/sub/sup", () => {
  const src = [
    "---",
    "title: x",
    "---",
    "Text[^a] and ==hi== H~2~O x^2^ <kbd>Ctrl</kbd>.",
    "",
    "> [!WARNING]",
    "> Careful.",
    "",
    "Term",
    ": Definition",
    "",
    "<details>",
    "<summary>More</summary>",
    "",
    "Hidden",
    "</details>",
    "",
    "[^a]: The note.",
  ].join("\n");
  const blocks = parseMarkdown(src);
  const kinds = blocks.map((b) => b.kind);
  // D218: the <details> block ends at the blank line (CommonMark); "Hidden" is Markdown, and the
  // block tag </details> ends its paragraph (render.ts nests "Hidden" in the open <details>).
  assert.deepEqual(kinds, [
    "paragraph",
    "alert",
    "deflist",
    "htmlBlock",
    "paragraph",
    "htmlBlock",
    "footnotes",
  ]);
  assert.equal(blocks[0]?.line, 3);
  const para = blocks[0];
  const inl = para?.kind === "paragraph" ? para.children.map((c) => c.kind) : [];
  for (const k of ["footnoteRef", "mark", "sub", "sup", "tag"])
    assert.ok(inl.includes(k as never), k);
  const html = blocks[3];
  assert.ok(html?.kind === "htmlBlock" && html.html.includes("<summary>More</summary>"));
  assert.deepEqual(blocks[4], {
    kind: "paragraph",
    children: [{ kind: "text", text: "Hidden" }],
    line: blocks[4]?.line,
  });
  assert.ok(blocks[5]?.kind === "htmlBlock" && blocks[5].html === "</details>");
});

test("HTML blocks around Markdown: the writer keeps <details> open for it, the parser closes it (D218)", () => {
  const w = new SafeHtmlWriter();
  w.write('<details open>\n<summary>More <b onclick="x()">here</b></summary>');
  assert.equal(w.openCount, 1);
  w.slot(1);
  assert.equal(w.openCount, 1);
  w.write("</details>");
  assert.equal(w.openCount, 0);
  assert.equal(
    w.html,
    '<details open>\n<summary>More <b>here</b></summary><div data-md-slot="1"></div></details>',
  );
  // Without a browser parser the builder nests the same way.
  const tree = builderTree(w);
  assert.equal(tree.length, 1);
  const details = tree[0];
  assert.ok(details?.kind === "element" && details.tag === "details");
  assert.deepEqual(details.children.at(-1), { kind: "slot", index: 1 });
  // An open <p> is closed by the Markdown block after it (it's a block), as by the parser.
  const p = new SafeHtmlWriter();
  p.write('<p align="center">\n<img src="logo.png" alt="">');
  assert.equal(p.openCount, 1);
  p.slot(1);
  assert.equal(p.openCount, 0);
});

test("SafeHtmlWriter: only clean markup reaches the parser", () => {
  const w = new SafeHtmlWriter();
  w.write(
    [
      '<div id="top" style="color:red" onmouseover="x()"><center>c</center>',
      "<script>alert(1)</script><svg><text>s</text></svg><iframe src=x></iframe>",
      '<a href="javascript:alert(1)">j</a><a href="https://e.com/?a=1&b=&quot;2">e</a>',
      '<img src="x.png" alt="a&quot;b"><blink>kept text</blink>&lt;b&gt; 1 < 2',
      '<template><img src=x onerror=alert(1)></template><textarea></textarea><x-y data-md-slot="0">z</x-y></div>',
    ].join(""),
  );
  assert.equal(
    w.html,
    '<div data-anchor="top"><div align="center">c</div><a>j</a>' +
      '<a href="https://e.com/?a=1&amp;b=&quot;2">e</a><img src="x.png" alt="a&quot;b">' +
      "kept text&lt;b&gt; 1 &lt; 2z</div>",
  );
  assert.equal(w.openCount, 0);
});

test("inline HTML in prose is written for the browser's parser: inline slots, unknown tags as text (D229)", () => {
  const nodes = parseInline("a <b>bold <i>both</b> it</i> Vec<T> <script>x</script>end");
  const w = new SafeHtmlWriter({ inline: true });
  for (const [i, n] of nodes.entries()) {
    if (n.kind === "tag") w.tag(n.tag);
    else w.slot(i);
  }
  // Misnesting is left to the parser (it nests `</b>` inside `<i>` by HTML's rules); `<T>`
  // isn't a tag we know, so it shows as written; the script and its content are gone.
  assert.match(w.html, /^<span data-md-slot="0"><\/span><b><span data-md-slot="\d+"><\/span><i>/);
  assert.match(w.html, /<\/b>/);
  assert.match(w.html, /&lt;T&gt;/);
  assert.doesNotMatch(w.html, /script|>x</);
  // Without a parser the builder nests it, with the same text for unknown tags.
  const tree = builderTree(w);
  assert.ok(tree.some((n) => n.kind === "element" && n.tag === "b"));
  assert.ok(tree.some((n) => n.kind === "text" && n.text.includes("<T>")));
});

test("badges: an image inside a link, soft and hard breaks", () => {
  const inl = parseInline(
    "[![npm](https://img.shields.io/npm/v/x)](https://npmjs.com/x)\n[![MIT](b.svg)](LICENSE)  \nend",
  );
  assert.deepEqual(inl[0], {
    kind: "link",
    href: "https://npmjs.com/x",
    children: [{ kind: "image", src: "https://img.shields.io/npm/v/x", alt: "npm" }],
  });
  assert.deepEqual(inl[1], { kind: "br", soft: true });
  assert.equal(inl[2]?.kind, "link");
  assert.deepEqual(inl[3], { kind: "br" });
  // Unbalanced brackets stay text.
  assert.deepEqual(parseInline("a [b](c"), [{ kind: "text", text: "a [b](c" }]);
});

test("long paragraphs parse in linear time", () => {
  const long = `${"word [x ".repeat(4000)}end ~~a~~ <kbd>k</kbd> https://e.com`;
  const t = performance.now();
  const inl = parseInline(long);
  assert.ok(performance.now() - t < 1500);
  assert.ok(inl.some((n) => n.kind === "del"));
  assert.ok(inl.some((n) => n.kind === "tag" && n.tag.name === "kbd"));
  assert.ok(inl.some((n) => n.kind === "link"));
});

test("deep nesting doesn't overflow the stack (D161)", () => {
  assert.ok(parseMarkdown(">".repeat(3000)).length > 0);
  const list = Array.from({ length: 3000 }, (_, i) => `${"  ".repeat(i)}- x`).join("\n");
  assert.ok(parseMarkdown(list).length > 0);
});

test("adversarial inline input stays fast (D163)", () => {
  for (const text of [
    "![".repeat(30000),
    "[^".repeat(30000),
    "<b>".repeat(20000),
    "<!--".repeat(30000),
    "<a b=c d ".repeat(10000),
    `<a x="${"y".repeat(3000)}`.repeat(30),
    "&#x41".repeat(30000),
  ]) {
    const start = performance.now();
    parseInline(text);
    assert.ok(performance.now() - start < 1500, `${text.slice(0, 4)}… took too long`);
  }
});

test("math: $…$ inline by GitHub's rules, $$ blocks (D172)", () => {
  const inlineOf = (text: string) =>
    parseInline(text)
      .map((n) => (n.kind === "math" ? `M(${n.tex})` : n.kind === "text" ? n.text : n.kind))
      .join("");
  assert.equal(inlineOf("Euler: $e^{i\\pi} + 1 = 0$."), "Euler: M(e^{i\\pi} + 1 = 0).");
  // Prices and lone dollars stay text.
  assert.equal(inlineOf("It costs $5 and $10 later."), "It costs $5 and $10 later.");
  assert.equal(inlineOf("From $5-$10"), "From $5-$10");
  assert.equal(inlineOf("A $ b $ c"), "A $ b $ c");
  assert.equal(inlineOf("Escaped \\$x$"), "Escaped $x$");
  assert.equal(inlineOf("`$x$` in code"), "code in code");
  assert.equal(inlineOf("$$x^2$$ inline"), "M(x^2) inline");
  const blocks = parseMarkdown("Before\n\n$$\n\\frac{a}{b}\n$$\n\n$$ x + y $$\nAfter");
  assert.deepEqual(
    blocks.map((b) => (b.kind === "math" ? `math:${b.tex}` : b.kind)),
    ["paragraph", "math:\\frac{a}{b}", "math:x + y", "paragraph"],
  );
  // An unclosed $$ is just text.
  assert.equal(parseMarkdown("$$\nnot closed")[0]?.kind, "paragraph");
});
