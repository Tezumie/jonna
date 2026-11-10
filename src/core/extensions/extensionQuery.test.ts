import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterText,
  type InstalledFacts,
  installedOnly,
  isEmptyQuery,
  matchesInstalled,
  matchesPublisher,
  parseExtensionQuery,
  publisherNamespaces,
  storeSortBy,
} from "./extensionQuery";

test("query: filters come out, the rest is the text", () => {
  const q = parseExtensionQuery('python publisher:"Microsoft" @sort:installs  lint');
  assert.equal(q.text, "python lint");
  assert.equal(q.publisher, "Microsoft");
  assert.equal(q.sort, "installs");
  const r = parseExtensionQuery("@installed @DISABLED @category:Themes @tag:git ext:.ts @id:A.B");
  assert.deepEqual(
    [r.installed, r.disabled, r.category, r.tag, r.ext, r.id, r.text],
    [true, true, "Themes", "git", "ts", "a.b", ""],
  );
  assert.equal(
    parseExtensionQuery('@category:"Programming Languages"').category,
    "Programming Languages",
  );
  assert.equal(parseExtensionQuery("@outdated").updates, true);
  // Unknown @words stay text; an empty value is dropped.
  assert.equal(parseExtensionQuery("@nope publisher:").text, "@nope");
  assert.equal(parseExtensionQuery("@sort:sideways").sort, undefined);
});

test("query: empty, installed-only, sort, filter text", () => {
  assert.ok(isEmptyQuery(parseExtensionQuery("  ")));
  assert.ok(!isEmptyQuery(parseExtensionQuery("@popular")));
  assert.ok(installedOnly(parseExtensionQuery("@enabled git")));
  assert.ok(!installedOnly(parseExtensionQuery("publisher:x")));
  assert.equal(storeSortBy(parseExtensionQuery("@popular")), "downloadCount");
  assert.equal(storeSortBy(parseExtensionQuery("@sort:rating")), "averageRating");
  assert.equal(storeSortBy(parseExtensionQuery("@recentlyPublished")), "timestamp");
  assert.equal(storeSortBy(parseExtensionQuery("x")), undefined);
  assert.equal(filterText("publisher", "Red Hat"), 'publisher:"Red Hat"');
  assert.equal(filterText("@category", "Themes"), "@category:Themes");
});

test("query: publishers by name or namespace, Microsoft's several namespaces", () => {
  assert.ok(publisherNamespaces("Microsoft").includes("ms-python"));
  assert.deepEqual(
    publisherNamespaces("Red Hat"),
    ["red hat", "redhat", "red-hat"].filter((n) => !n.includes(" ")),
  );
  assert.ok(matchesPublisher("Anthropic", "anthropic"));
  assert.ok(matchesPublisher("Microsoft", "ms-toolsai"));
  assert.ok(matchesPublisher("Dracula Theme", "dracula-theme"));
  assert.ok(matchesPublisher("Acme Labs", "whatever", "acme labs"));
  assert.ok(!matchesPublisher("Anthropic", "openai"));
});

const ext = (over: Partial<InstalledFacts> = {}): InstalledFacts => ({
  id: "acme.todo",
  displayName: "Todo tree",
  description: "Lists every TODO",
  publisher: "Acme",
  categories: ["Other"],
  keywords: ["todo", "fixme"],
  fileExtensions: [".md"],
  enabled: true,
  builtin: false,
  hasUpdate: false,
  recommended: false,
  ...over,
});

test("query: installed extensions match the text and every filter", () => {
  const m = (raw: string, e = ext()) => matchesInstalled(parseExtensionQuery(raw), e);
  assert.ok(m("todo list"));
  assert.ok(!m("todo nope"));
  assert.ok(m("@enabled"));
  assert.ok(!m("@disabled"));
  assert.ok(m("@disabled", ext({ enabled: false })));
  assert.ok(!m("@builtin"));
  assert.ok(m("@updates", ext({ hasUpdate: true })));
  assert.ok(m("publisher:acme @category:other @tag:FIXME ext:md @id:acme.todo"));
  assert.ok(!m("publisher:other"));
  assert.ok(!m("@category:Themes"));
  assert.ok(!m("ext:ts"));
});
