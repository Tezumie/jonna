import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildIndex,
  chunkPage,
  crawl,
  crawlTarget,
  dot,
  extractLinks,
  hybridSearch,
  metaRobots,
  parseRobots,
  renderDocHits,
  robotsAllows,
  searchIndex,
  sitePrefix,
  tokenize,
} from "./docsIndex";

test("robots.txt: our group or *, longest match wins, Allow on a tie, wildcards", () => {
  const rules = parseRobots(
    "User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /docs/private/\nAllow: /docs/private/ok.html\nDisallow: /*.php$\nCrawl-delay: 2\n",
  );
  assert.equal(rules.delay, 2);
  assert.ok(robotsAllows(rules, "/docs/intro"));
  assert.ok(!robotsAllows(rules, "/docs/private/secret"));
  assert.ok(robotsAllows(rules, "/docs/private/ok.html"));
  assert.ok(!robotsAllows(rules, "/a/b.php"));
  assert.ok(robotsAllows(rules, "/a/b.php?x=1"));
  // Two user-agent lines share a group.
  const shared = parseRobots("User-agent: a\nUser-agent: *\nDisallow: /x\n");
  assert.ok(!robotsAllows(shared, "/x/y"));
  assert.ok(robotsAllows(parseRobots(""), "/anything"));
  // Our own group beats *.
  const ours = parseRobots("User-agent: *\nDisallow: /\nUser-agent: ide-docs\nAllow: /\n");
  assert.ok(robotsAllows(ours, "/docs"));
});

test("links: within the site prefix, no fragments, queries, assets or other origins", () => {
  assert.equal(sitePrefix("https://x.dev/docs/intro?a=1#b"), "https://x.dev/docs/");
  assert.equal(sitePrefix("https://x.dev/docs/"), "https://x.dev/docs/");
  const prefix = "https://x.dev/docs/";
  const base = "https://x.dev/docs/guide/start";
  assert.equal(crawlTarget("../api#x", base, prefix), "https://x.dev/docs/api");
  assert.equal(crawlTarget("/docs/a?page=2", base, prefix), "https://x.dev/docs/a");
  assert.equal(crawlTarget("index.html", "https://x.dev/docs/", prefix), "https://x.dev/docs/");
  assert.equal(crawlTarget("/blog/post", base, prefix), null);
  assert.equal(crawlTarget("https://other.dev/docs/a", base, prefix), null);
  assert.equal(crawlTarget("/docs/logo.png", base, prefix), null);
  assert.equal(crawlTarget("http://x.dev/docs/a", base, prefix), null);
  assert.equal(crawlTarget("/docs", base, prefix), "https://x.dev/docs");
  assert.deepEqual(
    extractLinks(
      `<a href="a.html">A</a><a class=x href='b'>B</a><a href=c>C</a><a href="#top">T</a><a href="mailto:x@y">M</a><a href="javascript:void 0">J</a><a href="d?x=1&amp;y=2">D</a>`,
    ),
    ["a.html", "b", "c", "d?x=1&y=2"],
  );
  assert.deepEqual(metaRobots('<meta name="robots" content="noindex, follow">'), {
    noindex: true,
    nofollow: false,
  });
});

test("chunks: under their headings, long sections split", () => {
  const chunks = chunkPage(
    {
      url: "u",
      title: "Guide",
      text: `Intro text.\n\n# Install\n\nRun npm i.\n\n## Routes\n\n${"Route words here. ".repeat(100)}\n\nShort tail.`,
    },
    400,
  );
  assert.equal(chunks[0]?.heading, "");
  assert.equal(chunks[0]?.text, "Intro text.");
  assert.equal(chunks[1]?.heading, "Install");
  assert.ok(chunks.filter((c) => c.heading === "Routes").length >= 3);
  assert.ok(chunks.every((c) => c.text.length <= 700));
});

test("lexical index: BM25 ranks the chunk about the question first, stems plurals", () => {
  assert.deepEqual(tokenize("How do Routes and libraries work_well?"), [
    "route",
    "library",
    "work",
    "well",
  ]);
  const index = buildIndex([
    {
      url: "a",
      title: "Routing",
      heading: "Dynamic routes",
      text: "Dynamic routes take parameters in brackets.",
    },
    {
      url: "b",
      title: "Data",
      heading: "Fetching",
      text: "Fetch data on the server with loaders. Routes may load data.",
    },
    { url: "c", title: "Styling", heading: "CSS", text: "Use CSS modules for styles." },
    {
      url: "a",
      title: "Routing",
      heading: "Nested",
      text: "Nested routes share layouts. Routes routes routes.",
    },
    { url: "a", title: "Routing", heading: "More", text: "More about routes." },
  ]);
  const hits = searchIndex(index, "dynamic route parameters");
  assert.equal(hits[0]?.chunk.heading, "Dynamic routes");
  assert.ok(!hits.some((h) => h.chunk.url === "c"));
  // At most two chunks of one page.
  assert.ok(hits.filter((h) => h.chunk.url === "a").length <= 2);
  assert.deepEqual(searchIndex(index, "the and"), []);
  assert.match(
    renderDocHits("next", "dynamic", hits.slice(0, 1)),
    /### Routing › Dynamic routes\na/,
  );
  assert.match(renderDocHits("next", "zzz", []), /nothing matched/);
  // JSON round trip (what's stored on disk).
  const again = JSON.parse(JSON.stringify(index));
  assert.equal(searchIndex(again, "css styles")[0]?.chunk.url, "c");
});

test("crawl: bounded, robots.txt, rate limited, noindex, redirects off the site", async () => {
  const site: Record<string, { status?: number; text: string; url?: string; type?: string }> = {
    "https://x.dev/robots.txt": {
      text: "User-agent: *\nDisallow: /docs/secret\n",
      type: "text/plain",
    },
    "https://x.dev/docs/": {
      text: '<html><a href="a">A</a><a href="b">B</a><a href="secret">S</a><a href="/blog">X</a><a href="gone">G</a><a href="away">W</a><a href="hidden">H</a></html>',
    },
    "https://x.dev/docs/a": { text: '<html><a href="b">B</a><a href="c">C</a> page a</html>' },
    "https://x.dev/docs/b": { text: "<html>page b</html>" },
    "https://x.dev/docs/c": { text: "<html>page c</html>" },
    "https://x.dev/docs/gone": { status: 404, text: "" },
    "https://x.dev/docs/away": { text: "<html>x</html>", url: "https://elsewhere.dev/" },
    "https://x.dev/docs/hidden": { text: '<html><meta name="robots" content="noindex">h</html>' },
  };
  const fetched: string[] = [];
  const slept: number[] = [];
  const deps = {
    fetch: async (url: string) => {
      fetched.push(url);
      const p = site[url];
      if (!p) return { url, status: 404, contentType: "text/html", text: "" };
      return {
        url: p.url ?? url,
        status: p.status ?? 200,
        contentType: p.type ?? "text/html",
        text: p.text,
      };
    },
    toText: (html: string) => ({ title: "T", text: html.replace(/<[^>]+>/g, " ").trim() }),
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };
  const all = await crawl("https://x.dev/docs/", { maxPages: 10, delayMs: 500 }, deps);
  assert.deepEqual(
    all.pages.map((p) => p.url),
    ["https://x.dev/docs/", "https://x.dev/docs/a", "https://x.dev/docs/b", "https://x.dev/docs/c"],
  );
  assert.ok(!fetched.includes("https://x.dev/docs/secret"));
  assert.ok(!fetched.includes("https://x.dev/blog"));
  assert.deepEqual(all.skipped.map((s) => s.why).sort(), [
    "noindex",
    "redirected outside https://x.dev/docs/",
    "robots.txt",
    "status 404",
  ]);
  // Every request after the first waited (robots.txt's 0 s delay is shorter than ours).
  assert.ok(slept.length >= 6 && slept.every((ms) => ms === 500));
  const bounded = await crawl("https://x.dev/docs/", { maxPages: 2, delayMs: 0 }, deps);
  assert.equal(bounded.pages.length, 2);
  let stop = false;
  const cancelled = await crawl(
    "https://x.dev/docs/",
    { maxPages: 10, delayMs: 0 },
    { ...deps, cancelled: () => stop, progress: () => (stop = true) },
  );
  assert.equal(cancelled.pages.length, 1);
  // A site of nothing but broken links stops after a bounded number of requests.
  let broken = 0;
  const dead = await crawl(
    "https://y.dev/docs/",
    { maxPages: 5, delayMs: 0 },
    {
      ...deps,
      fetch: async (url: string) => {
        broken++;
        return url.endsWith("/docs/")
          ? {
              url,
              status: 200,
              contentType: "text/html",
              text: `<html>${Array.from({ length: 500 }, (_, i) => `<a href="p${i}">x</a>`).join("")}</html>`,
            }
          : { url, status: 404, contentType: "text/html", text: "" };
      },
    },
  );
  assert.equal(dead.pages.length, 1);
  // robots.txt, two sitemap.xml tries, then the bounded pages.
  assert.ok(broken <= 5 * 2 + 10 + 3, `${broken} requests`);
});

test("docsIndex: search by words and meaning fuses both rankings (D233)", () => {
  const index = buildIndex([
    { url: "a", title: "Styling", heading: "CSS", text: "Use CSS modules for styles." },
    { url: "b", title: "Theme", heading: "Colors", text: "Pick a palette for the look." },
    { url: "c", title: "Data", heading: "Fetching", text: "Fetch data on the server." },
  ]);
  // "appearance" matches no word; by meaning it's nearest the Theme chunk, then Styling.
  const vectors = [
    [0.6, 0.8, 0],
    [1, 0, 0],
    [0, 0, 1],
  ];
  const hits = hybridSearch(index, "appearance", vectors, [1, 0, 0]);
  assert.deepEqual(
    hits.map((h) => h.chunk.url),
    ["b", "a"],
  );
  // A chunk matched by both its words and its meaning comes before one matched by either.
  const both = hybridSearch(index, "css styles", vectors, [0.6, 0.8, 0]);
  assert.equal(both[0]?.chunk.url, "a");
  // Chunks without a vector still count by their words.
  const partial = hybridSearch(index, "fetch data", [null, null, null], [1, 0, 0]);
  assert.deepEqual(
    partial.map((h) => h.chunk.url),
    ["c"],
  );
  assert.equal(dot([1, 2], [3, 4]), 11);
});
