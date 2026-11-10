import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeEntities, htmlTitle, htmlToText, normalizeUrl, pageText } from "./webText";

const PAGE = `<!doctype html><html><head><title>Guide &amp; docs</title>
<style>body{color:red}</style><script>var x = "<p>no</p>";</script></head>
<body><nav><a href="/">Home</a> <a href="/blog">Blog</a></nav>
<main>
<h1>Getting   started</h1>
<p>Install it with <code>npm i thing</code>, then read the <a href="/api">API docs</a>.</p>
<ul><li>One</li><li>Two <b>bold</b></li></ul>
<ol><li>First</li><li>Second</li></ol>
<pre><code>const a = 1 &lt; 2;
  indented();</code></pre>
<p>Ends here&nbsp;&mdash; done.<br>Next line</p>
<a href="#top">Top</a> <a href="javascript:void 0">noop</a>
<img src="x.png" alt="A diagram">
</main><footer>© 2026</footer></body></html>`;

test("web text: main content as Markdown-like text", () => {
  const text = htmlToText(PAGE, "https://example.com/guide/start");
  assert.equal(
    text,
    [
      "# Getting started",
      "",
      "Install it with `npm i thing`, then read the [API docs](https://example.com/api).",
      "",
      "- One",
      "- Two **bold**",
      "",
      "1. First",
      "2. Second",
      "",
      "```",
      "const a = 1 < 2;",
      "  indented();",
      "```",
      "",
      "Ends here — done.",
      "Next line",
      "",
      "Top noop [image: A diagram]",
    ].join("\n"),
  );
  assert.ok(!text.includes("Home"), "navigation is left out");
  assert.ok(!text.includes("color:red") && !text.includes("var x"));
  assert.ok(!text.includes("2026"), "footer is left out");
  assert.equal(htmlTitle(PAGE), "Guide & docs");
});

test("web text: entities, plain text pages, caps", () => {
  assert.equal(
    decodeEntities("a &lt;b&gt; &#x41;&#66; &bogus; &amp;amp;"),
    "a <b> AB &bogus; &amp;",
  );
  const plain = pageText({
    url: "https://x.dev/a.txt",
    contentType: "text/plain",
    text: "  hello <b>there</b>\n",
    truncated: false,
  });
  assert.deepEqual(plain, {
    url: "https://x.dev/a.txt",
    title: "",
    text: "hello <b>there</b>",
    truncated: false,
  });
  const long = pageText(
    { url: "u", contentType: "text/html", text: `<p>${"word ".repeat(100)}</p>`, truncated: false },
    50,
  );
  assert.ok(long.truncated);
  assert.ok(long.text.endsWith("… (truncated)"));
  // Without <main>: the body; nested skipped tags close properly.
  assert.equal(htmlToText("<body><nav><div><nav>x</nav></div>y</nav><p>kept</p></body>"), "kept");
});

test("web addresses: a scheme is added when missing", () => {
  assert.equal(normalizeUrl(" https://a.dev/x "), "https://a.dev/x");
  assert.equal(normalizeUrl("docs.rs/serde"), "https://docs.rs/serde");
  assert.equal(normalizeUrl("localhost:5173/app"), "http://localhost:5173/app");
  assert.throws(() => normalizeUrl("not a url"));
  assert.throws(() => normalizeUrl("file:///etc/hosts"), /Only http and https/);
  assert.throws(() => normalizeUrl("README.md is"));
});

test("web text: a page of many blocks converts in linear time", () => {
  const html = `<body>${"<div>word</div>".repeat(40000)}</body>`;
  const started = Date.now();
  const text = htmlToText(html);
  assert.ok(Date.now() - started < 3000);
  assert.equal(text.split("\n\n").length, 40000);
});
