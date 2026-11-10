import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInline, parseMarkdown } from "./parse";
import {
  cleanTag,
  decodeEntities,
  readTag,
  SafeHtmlBuilder,
  type SafeNode,
  safeSrcset,
  safeUrl,
  sanitizeHtml,
} from "./sanitize";

/** A compact view of a safe tree: `tag[attr=value](children)` and text. */
function show(nodes: readonly SafeNode[]): string {
  return nodes
    .map((n) => {
      if (n.kind === "text") return JSON.stringify(n.text);
      if (n.kind === "slot") return `#${n.index}`;
      const attrs = Object.entries(n.attrs)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      return `${n.tag}${attrs ? `[${attrs}]` : ""}(${show(n.children)})`;
    })
    .join(" ");
}
const clean = (html: string) => show(sanitizeHtml(html));

test("readTag: CommonMark open and close tags, attributes decoded", () => {
  const t = readTag("<IMG SRC=\"a.png\" height=64 alt='x &amp; y' hidden/>", 0);
  assert.deepEqual(t?.attrs, [
    ["src", "a.png"],
    ["height", "64"],
    ["alt", "x & y"],
    ["hidden", ""],
  ]);
  assert.equal(t?.name, "img");
  assert.equal(t?.selfClosing, true);
  assert.equal(readTag("</A >", 0)?.close, true);
  // Not tags: autolinks, emails, a lone "<", "<3".
  for (const s of ["<https://e.com>", "<a@b.com>", "< a>", "<3", "<a href=>"])
    assert.equal(readTag(s, 0), null, s);
});

test("the README heading: inline <img> tags in a heading", () => {
  const md =
    '# <img src="https://q5js.org/q5js_logo.avif" height="64"> <img src="https://q5js.org/q5js_brand.avif" height="64">';
  const [h] = parseMarkdown(md);
  assert.equal(h?.kind, "heading");
  const kids = h?.kind === "heading" ? h.children : [];
  assert.deepEqual(
    kids.map((k) => k.kind),
    ["tag", "text", "tag"],
  );
  const b = new SafeHtmlBuilder({ unknownAsText: true });
  for (const [i, k] of kids.entries())
    if (k.kind === "tag") b.tag(k.tag);
    else b.slot(i);
  assert.equal(
    show(b.roots),
    "img[src=https://q5js.org/q5js_logo.avif height=64]() #1 img[src=https://q5js.org/q5js_brand.avif height=64]()",
  );
});

test("inline HTML nests the Markdown between tags; unknown tags in prose stay text", () => {
  const inl = parseInline('<a href="https://e.com">**go**</a> and Vec<T> <sub>2</sub>');
  const b = new SafeHtmlBuilder({ unknownAsText: true });
  for (const [i, n] of inl.entries())
    if (n.kind === "tag") b.tag(n.tag);
    else b.slot(i);
  assert.equal(show(b.roots), 'a[href=https://e.com](#1) #3 "<T>" #5 sub(#7)');
  // Inline <script> swallows what's inside it.
  const s = parseInline("a <script>alert(1)</script> b");
  const b2 = new SafeHtmlBuilder({ unknownAsText: true });
  for (const [i, n] of s.entries())
    if (n.kind === "tag") b2.tag(n.tag);
    else b2.slot(i);
  assert.equal(show(b2.roots), "#0 #4");
});

test("HTML blocks: CommonMark conditions 1, 6 and 7", () => {
  const kinds = (md: string) => parseMarkdown(md).map((b) => b.kind);
  assert.deepEqual(kinds('<p align="center">\n  <img src="a.png">\n</p>\n\ntext'), [
    "htmlBlock",
    "paragraph",
  ]);
  // A line that is just one tag starts a block; a tag followed by text is a paragraph.
  assert.deepEqual(kinds('<a href="x">\n<img src="y">\n</a>'), ["htmlBlock"]);
  assert.deepEqual(kinds('<img src="y"> **bold** after'), ["paragraph"]);
  // <script> runs to its end tag, blank lines and all.
  assert.deepEqual(kinds("<script>\n\nalert(1)\n\n</script>\nafter"), ["htmlBlock", "paragraph"]);
});

test("sanitizeHtml keeps the README tags and checked attributes only", () => {
  assert.equal(
    clean(
      '<p align="center"><img src="logo.png" width="200" onerror="x()" style="position:fixed"></p>',
    ),
    "p[align=center](img[src=logo.png width=200]())",
  );
  assert.equal(
    clean("<details open><summary>More</summary><kbd>Ctrl</kbd>+<sup>1</sup></details>"),
    'details[open=](summary("More") kbd("Ctrl") "+" sup("1"))',
  );
  assert.equal(clean("<center>hi</center>"), 'div[align=center]("hi")');
  assert.equal(
    clean('<table><tr><td colspan="2" bgcolor="red">a<td>b</table>'),
    'table(tr(td[colspan=2]("a") td("b")))',
  );
  assert.equal(clean("<ul><li>a<li>b</ul>"), 'ul(li("a") li("b"))');
  // Unknown tags keep their text; ids become anchors (no clobbering the app's ids).
  assert.equal(clean('<font color="red">x</font>'), '"x"');
  assert.equal(clean('<a name="top" id="app"></a>'), "a[data-anchor=app]()");
  assert.equal(
    clean("a &amp; b &lt;c&gt; &copy; &#169; &#xA9; &bogus;"),
    '"a & b <c> © © © &bogus;"',
  );
  assert.equal(clean('<span align="left; x" width="1e9">s</span>'), 'span("s")');
});

test("sanitizeHtml drops scripts, frames, forms, SVG and their content", () => {
  for (const html of [
    "<script>alert(1)</script>",
    "<SCRIPT>alert(1)</SCRIPT>",
    "<script src=x></script>",
    "<style>body{display:none}</style>",
    '<iframe src="https://e.com"></iframe>',
    '<object data="x"></object><embed src="x">',
    '<form action="x"><input name="p"><button>Go</button></form>',
    '<svg onload="alert(1)"><script>alert(1)</script></svg>',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    "<template><img src=x onerror=alert(1)></template>",
    "<noscript><img src=x></noscript>",
    '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    '<base href="javascript:/">',
    '<link rel="stylesheet" href="x.css">',
  ])
    assert.equal(clean(html), "", html);
  // Text around them survives; a script's text never does, blank lines or not.
  assert.equal(clean("a<script>\n\nb</script>c"), '"ac"');
  // Nested and broken-up tags can't rebuild a script.
  // Nested and broken-up tags can't rebuild a script: what's left is only text.
  assert.equal(clean("<scr<script>x</script>ipt>alert(1)</script>"), '"<script>alert(1)"');
  assert.equal(clean("<<script>script>alert(1)<</script>/script>"), '"</script>"');
  // "<script/>" opens a script all the same (HTML ignores that slash).
  assert.equal(clean("a<script/>alert(1)</script>b"), '"ab"');
  const inl = parseInline("a <script/>alert(1) b");
  const b = new SafeHtmlBuilder({ unknownAsText: true });
  for (const [i, n] of inl.entries())
    if (n.kind === "tag") b.tag(n.tag);
    else b.slot(i);
  assert.equal(show(b.roots), "#0");
  assert.equal(clean("<img src=x onerror=alert(1)//"), '"<img src=x onerror=alert(1)//"');
});

test("safeUrl: schemes hidden by entities, whitespace and case are refused", () => {
  for (const url of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "&#106;avascript:alert(1)",
    "&#x6A;avascript:alert(1)",
    "&#0000106&#0000097vascript:alert(1)",
    "javascript&colon;alert(1)",
    "jav&#x09;ascript:alert(1)",
    "jav&Tab;ascript:alert(1)",
    "\u0001javascript:alert(1)",
    "java\u0000script:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "data:text/html;base64,PHNjcmlwdD4=",
    "file:///etc/passwd",
    "\\\\attacker\\share\\x.png",
    "//attacker.com/x.png",
    "/\\attacker.com/x.png",
    "C:\\Windows\\win.ini",
    "%5C%5Cattacker%5Cshare%5Cx.png",
    "%2F%2Fattacker.com/x.png",
    "/C:/Windows/win.ini",
  ]) {
    assert.equal(safeUrl(url, "link"), null, url);
    assert.equal(safeUrl(url, "image"), null, url);
  }
  assert.equal(safeUrl("https://e.com/a?b=1&amp;c=2", "link"), "https://e.com/a?b=1&c=2");
  assert.equal(safeUrl("mailto:a@b.com", "link"), "mailto:a@b.com");
  assert.equal(safeUrl("mailto:a@b.com", "image"), null);
  assert.equal(safeUrl("#usage", "link"), "#usage");
  assert.equal(safeUrl("docs/a b.png", "image"), "docs/a b.png");
  assert.equal(safeUrl("data:image/png;base64,AAAA", "image"), "data:image/png;base64,AAAA");
  assert.equal(safeUrl("data:image/png;base64,AAAA", "link"), null);
  assert.equal(safeUrl("DATA:IMAGE/SVG+XML,<svg/>", "image"), "DATA:IMAGE/SVG+XML,<svg/>");
});

test("attributes: handlers, styles and injected values never pass", () => {
  const attrs = (html: string) => {
    const t = readTag(html, 0);
    return t ? cleanTag(t.name, t.attrs)?.attrs : undefined;
  };
  assert.deepEqual(
    attrs('<img src="x.png" onerror="alert(1)" ONLOAD=alert(1) style="position:fixed" class="x">'),
    { src: "x.png" },
  );
  // A quote inside a value stays in the value (never a new attribute).
  assert.deepEqual(attrs('<img alt=\'a" onerror="alert(1)\' src="x.png">'), {
    alt: 'a" onerror="alert(1)',
    src: "x.png",
  });
  assert.deepEqual(attrs('<a href="javascript:alert(1)" title="t">'), { title: "t" });
  assert.deepEqual(attrs('<a href=" https://e.com ">'), { href: "https://e.com" });
  assert.deepEqual(attrs('<img src="x.png" width="64" height="50%" align="RIGHT">'), {
    src: "x.png",
    width: "64",
    height: "50%",
    align: "right",
  });
  assert.deepEqual(attrs('<img width="expression(alert(1))" align="javascript:x">'), {});
  assert.equal(cleanTag("script", []), null);
  assert.equal(cleanTag("svg", []), null);
});

test("safeUrl / attributes: more hidden schemes and loading attributes (audit)", () => {
  for (const url of [
    "&NewLine;javascript:alert(1)",
    "javascript&NewLine;:alert(1)",
    "&#106avascript:alert(1)",
    "\u000ejavascript:alert(1)",
    "java­script:alert(1)",
    "​javascript:alert(1)",
    "&#x64;ata:text/html,<script>alert(1)</script>",
    "x-ms-msdt:/id",
    "ms-settings:",
  ]) {
    assert.equal(safeUrl(url, "link"), null, url);
    assert.equal(safeUrl(url, "image"), null, url);
  }
  const attrs = (html: string) => {
    const t = readTag(html, 0);
    return t ? cleanTag(t.name, t.attrs)?.attrs : undefined;
  };
  assert.deepEqual(attrs('<details open ontoggle="alert(1)" style="x:url(https://e.com)">'), {
    open: "",
  });
  assert.deepEqual(attrs('<a href="https://e.com" target="_blank" ping="https://e.com">'), {
    href: "https://e.com",
  });
  assert.deepEqual(attrs('<div background="https://e.com/x.png" data-md-slot="0">'), {});
  for (const html of [
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<button formaction="javascript:alert(1)">x</button>',
    '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
    '<math><maction actiontype="statusline">x</maction></math>',
    '<video poster="https://e.com/x.png"></video>',
  ])
    assert.equal(clean(html), "", html);
});

test("srcset: each candidate checked", () => {
  assert.deepEqual(safeSrcset("a.png 1x, b.png 2x"), [
    { url: "a.png", descriptor: "1x" },
    { url: "b.png", descriptor: "2x" },
  ]);
  assert.deepEqual(safeSrcset("javascript:alert(1) 1x, https://e.com/b.png 2x"), [
    { url: "https://e.com/b.png", descriptor: "2x" },
  ]);
  assert.deepEqual(safeSrcset("data:image/png;base64,AA,BB 1x"), [
    { url: "data:image/png;base64,AA,BB", descriptor: "1x" },
  ]);
  assert.equal(
    clean(
      '<picture><source media="(prefers-color-scheme: dark)" srcset="dark.png"><img src="light.png"></picture>',
    ),
    "picture(source[media=(prefers-color-scheme: dark) srcset=dark.png]() img[src=light.png]())",
  );
  assert.equal(clean('<source srcset="javascript:x" media="x{}">'), "source()");
});

test("decodeEntities: numeric forms, named, unknown kept", () => {
  assert.equal(decodeEntities("&#106;&#x61;&#118&#X61;"), "java");
  assert.equal(decodeEntities("&colon;&Tab;&NewLine;&nope;"), ":\t\n&nope;");
  assert.equal(decodeEntities("&#0;&#xD800;&#99999999;"), "\ufffd\ufffd\ufffd");
});

test("adversarial HTML stays fast and shallow", () => {
  const start = performance.now();
  sanitizeHtml("<div>".repeat(20000));
  sanitizeHtml("<b>".repeat(20000));
  sanitizeHtml(`<a title="${"x".repeat(100000)}`);
  sanitizeHtml(`${"<svg>".repeat(5000)}text`);
  assert.ok(performance.now() - start < 1500);
  let depth = 0;
  const measure = (nodes: readonly SafeNode[], d: number) => {
    depth = Math.max(depth, d);
    for (const n of nodes) if (n.kind === "element") measure(n.children, d + 1);
  };
  measure(sanitizeHtml("<div>".repeat(5000)), 0);
  assert.ok(depth <= 48, `depth ${depth}`);
});
