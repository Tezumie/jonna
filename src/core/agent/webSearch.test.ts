import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capResults,
  domainList,
  filterByDomains,
  formatResults,
  inDomain,
  normalizeDomain,
  SOURCES_RULE,
  searchPlan,
  setupMessage,
  webMentionKind,
  webSearchKeyId,
} from "./webSearch";

test("results are capped, deduplicated and formatted", () => {
  const results = capResults(
    [
      { title: " A ", url: "https://a.example", snippet: "one\n two" },
      { title: "dup", url: "https://a.example", snippet: "" },
      { title: "bad", url: "ftp://x", snippet: "" },
      { title: "", url: "http://b.example", snippet: "x".repeat(500) },
      { title: "C", url: "https://c.example", snippet: "" },
    ],
    2,
  );
  assert.deepEqual(
    results.map((r) => [r.title, r.url]),
    [
      ["A", "https://a.example"],
      ["http://b.example", "http://b.example"],
    ],
  );
  assert.equal(results[0]?.snippet, "one two");
  assert.equal(results[1]?.snippet.length, 401);
  const text = formatResults("q", results);
  assert.match(text, /untrusted/);
  assert.match(text, /1\. A\n {3}https:\/\/a\.example\n {3}one two/);
  assert.equal(formatResults("q", []), 'No results for "q".');
});

test("setup messages and the @web mention", () => {
  assert.match(setupMessage("off"), /agent\.setupWebSearch/);
  assert.match(setupMessage("brave", "key"), /no key is stored/);
  assert.match(setupMessage("searxng", "url"), /searxngUrl/);
  assert.equal(webSearchKeyId("tavily"), "websearch.tavily");
  assert.deepEqual(webMentionKind("https://x.dev/a"), { kind: "page", url: "https://x.dev/a" });
  assert.deepEqual(webMentionKind("docs.rs/serde"), { kind: "page", url: "docs.rs/serde" });
  assert.deepEqual(webMentionKind("tauri channels"), { kind: "search", query: "tauri channels" });
  assert.deepEqual(webMentionKind("search docs.rs"), { kind: "search", query: "docs.rs" });
  assert.equal(webMentionKind("  "), null);
});

test("domains: normalized, matched with subdomains, filtered", () => {
  assert.equal(normalizeDomain(" https://www.Docs.rs/serde?x "), "docs.rs");
  assert.equal(normalizeDomain("*.example.com:8080"), "example.com");
  assert.deepEqual(domainList(["docs.rs", "DOCS.RS", 3, "", "bad domain", "a.b"]), [
    "docs.rs",
    "a.b",
  ]);
  assert.equal(domainList("docs.rs").length, 0);
  assert.ok(inDomain("https://api.docs.rs/x", "docs.rs"));
  assert.ok(inDomain("https://docs.rs", "www.docs.rs"));
  assert.ok(!inDomain("https://notdocs.rs", "docs.rs"));
  assert.ok(!inDomain("not a url", "docs.rs"));
  const results = [
    { url: "https://docs.rs/a" },
    { url: "https://spam.docs.rs/b" },
    { url: "https://github.com/c" },
  ];
  assert.deepEqual(
    filterByDomains(results, ["docs.rs"], ["spam.docs.rs"]).map((r) => r.url),
    ["https://docs.rs/a"],
  );
  assert.equal(filterByDomains(results, [], ["github.com"]).length, 2);
  assert.equal(filterByDomains(results, [], []).length, 3);
});

test("search plans: query syntax, API fields, extended", () => {
  const brave = searchPlan("brave", "serde", 8, ["docs.rs"], ["spam.rs"], "standard");
  assert.equal(brave.query, "serde site:docs.rs -site:spam.rs");
  assert.equal(brave.options, undefined);
  assert.equal(brave.ask, 16);
  assert.equal(brave.keep, 8);
  assert.equal(brave.readPages, 0);
  // Several allowed domains: no OR in the query, the results are filtered.
  assert.equal(searchPlan("searxng", "q", 5, ["a.com", "b.com"], [], "standard").query, "q");
  const tavily = searchPlan("tavily", "q", 5, ["a.com"], ["b.com"], "extended");
  assert.equal(tavily.query, "q");
  assert.deepEqual(tavily.options, {
    includeDomains: ["a.com"],
    excludeDomains: ["b.com"],
    deep: true,
  });
  assert.equal(tavily.ask, 10);
  assert.equal(tavily.keep, 10);
  assert.equal(tavily.readPages, 3);
  // Exa takes one list: with both, it asks for more and the blocked ones are filtered here.
  assert.equal(searchPlan("exa", "q", 5, ["a.com"], ["b.com"], "standard").ask, 10);
  assert.equal(searchPlan("exa", "q", 5, ["a.com"], [], "standard").ask, 5);
  assert.equal(searchPlan("exa", "q", 5, [], [], "standard").options, undefined);
  assert.equal(searchPlan("brave", "q", 15, [], [], "extended").keep, 20);
});

test("results end with the Sources rule; extended adds the pages read", () => {
  const text = formatResults(
    "q",
    [{ title: "A", url: "https://a.example", snippet: "" }],
    [{ url: "https://a.example", title: "A page", text: "Body text" }],
  );
  assert.match(text, /read now:\n\n\[https:\/\/a\.example\] A page\nBody text/);
  assert.ok(text.endsWith(SOURCES_RULE));
});
