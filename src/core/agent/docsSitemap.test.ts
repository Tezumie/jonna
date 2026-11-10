// D207: @docs crawls seeded by sitemap.xml, pages that need JavaScript, scheduled refresh.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  crawl,
  NEEDS_JAVASCRIPT,
  needsJavaScript,
  parseSitemap,
  robotsSitemaps,
  staleDocs,
} from "./docsIndex";

test("sitemaps: robots.txt's lines, url sets and sitemap indexes", () => {
  assert.deepEqual(
    robotsSitemaps(
      "User-agent: *\nDisallow: /x\nSitemap: https://x.dev/sitemap.xml # main\nsitemap:https://x.dev/b.xml\nSitemap: https://x.dev/sitemap.xml\n",
    ),
    ["https://x.dev/sitemap.xml", "https://x.dev/b.xml"],
  );
  assert.deepEqual(
    parseSitemap(
      '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://x.dev/docs/a?x=1&amp;y=2</loc><lastmod>2026-01-01</lastmod></url><url><loc><![CDATA[https://x.dev/docs/b]]></loc></url></urlset>',
    ),
    { pages: ["https://x.dev/docs/a?x=1&y=2", "https://x.dev/docs/b"], sitemaps: [] },
  );
  assert.deepEqual(
    parseSitemap("<sitemapindex><sitemap><loc>https://x.dev/s1.xml</loc></sitemap></sitemapindex>"),
    { pages: [], sitemaps: ["https://x.dev/s1.xml"] },
  );
});

test("a page that's empty without its scripts needs JavaScript", () => {
  assert.equal(
    needsJavaScript(
      '<html><body><div id="root"></div><script src="app.js"></script></body></html>',
      "",
    ),
    true,
  );
  assert.equal(
    needsJavaScript(
      "<html><body><noscript>You need to enable JavaScript to run this app.</noscript><script></script></body></html>",
      "You need to enable JavaScript to run this app.",
    ),
    true,
  );
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  assert.equal(needsJavaScript(`<html><script></script><p>${words}</p></html>`, words), false);
  // No scripts: a short page is just short.
  assert.equal(needsJavaScript("<html><p>Short.</p></html>", "Short."), false);
});

test("the crawl reads sitemap pages within the folder and skips JavaScript-only ones", async () => {
  const site: Record<string, { text: string; type?: string }> = {
    "https://x.dev/robots.txt": {
      text: "User-agent: *\nDisallow: /docs/private\nSitemap: https://x.dev/maps/index.xml\nSitemap: https://other.dev/sitemap.xml\n",
      type: "text/plain",
    },
    "https://x.dev/maps/index.xml": {
      text: "<sitemapindex><sitemap><loc>https://x.dev/maps/docs.xml</loc></sitemap></sitemapindex>",
      type: "application/xml",
    },
    "https://x.dev/maps/docs.xml": {
      text: "<urlset><url><loc>https://x.dev/docs/orphan</loc></url><url><loc>https://x.dev/docs/app</loc></url><url><loc>https://x.dev/blog/post</loc></url><url><loc>https://x.dev/docs/private/x</loc></url></urlset>",
      type: "application/xml",
    },
    "https://x.dev/docs/": { text: "<html><p>start page with enough words here</p></html>" },
    "https://x.dev/docs/orphan": { text: "<html><p>an orphan page nothing links to</p></html>" },
    "https://x.dev/docs/app": {
      text: '<html><body><div id="app"></div><script src="/bundle.js"></script></body></html>',
    },
  };
  const fetched: string[] = [];
  const result = await crawl(
    "https://x.dev/docs/",
    { maxPages: 10, delayMs: 0 },
    {
      fetch: async (url) => {
        fetched.push(url);
        const p = site[url];
        return p
          ? { url, status: 200, contentType: p.type ?? "text/html", text: p.text }
          : { url, status: 404, contentType: "text/html", text: "" };
      },
      toText: (html) => ({ title: "T", text: html.replace(/<[^>]+>/g, " ").trim() }),
      sleep: async () => {},
    },
  );
  assert.deepEqual(
    result.pages.map((p) => p.url),
    ["https://x.dev/docs/", "https://x.dev/docs/orphan"],
  );
  assert.deepEqual(result.skipped, [
    { url: "https://x.dev/docs/app", why: NEEDS_JAVASCRIPT },
    { url: "https://x.dev/docs/private/x", why: "robots.txt" },
  ]);
  // Another site's sitemap and pages outside the folder aren't fetched.
  assert.ok(!fetched.includes("https://other.dev/sitemap.xml"));
  assert.ok(!fetched.includes("https://x.dev/blog/post"));
});

test("stale sources: indexed longer ago than the setting; 0 turns it off", () => {
  const day = 86_400_000;
  const now = 100 * day;
  const sources = [
    { name: "old", crawledAt: now - 8 * day },
    { name: "fresh", crawledAt: now - 2 * day },
    { name: "never" },
  ];
  assert.deepEqual(staleDocs(sources, 7, now), ["old"]);
  assert.deepEqual(staleDocs(sources, 1, now), ["old", "fresh"]);
  assert.deepEqual(staleDocs(sources, 0, now), []);
});

test("a page that needs JavaScript is read through render when there is one (D233)", async () => {
  const site: Record<string, string> = {
    "https://x.dev/docs/": '<html><p>start page with enough words</p><a href="app">app</a></html>',
    "https://x.dev/docs/app":
      '<html><body><div id="app"></div><script src="/bundle.js"></script></body></html>',
    "https://x.dev/docs/broken":
      '<html><body><div id="root"></div><script src="/b.js"></script></body></html>',
  };
  const rendered: string[] = [];
  const result = await crawl(
    "https://x.dev/docs/",
    { maxPages: 10, delayMs: 0 },
    {
      fetch: async (url) => {
        const text = site[url];
        return text !== undefined
          ? { url, status: 200, contentType: "text/html", text }
          : { url, status: 404, contentType: "text/html", text: "" };
      },
      toText: (html) => ({ title: "T", text: html.replace(/<[^>]+>/g, " ").trim() }),
      sleep: async () => {},
      render: async (url) => {
        rendered.push(url);
        return url.endsWith("/app") ? { title: "App", text: "Rendered app docs." } : null;
      },
    },
  );
  assert.deepEqual(rendered, ["https://x.dev/docs/app"]);
  const app = result.pages.find((p) => p.url === "https://x.dev/docs/app");
  assert.equal(app?.text, "Rendered app docs.");
  assert.equal(app?.title, "App");
  assert.ok(!result.skipped.some((s) => s.why === NEEDS_JAVASCRIPT));
});
