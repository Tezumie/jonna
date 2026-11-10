import assert from "node:assert/strict";
import { test } from "node:test";
import { docPages, findPage } from "./pages";

test("docs: pages with titles, product name filled in, found by name", () => {
  const pages = docPages("Acme");
  assert.ok(pages.length >= 8);
  assert.equal(pages[0]?.title, "Getting started");
  assert.ok(!pages.some((p) => p.text.includes("{{product}}")));
  assert.ok(pages[0]?.text.includes("Acme"));
  assert.equal(findPage(pages, "quick-access")?.id, "02-quick-access.md");
  assert.equal(findPage(pages, "02-quick-access.md")?.title, "Quick access");
  assert.equal(findPage(pages, "The agent")?.id, "05-agent.md");
  assert.equal(findPage(pages, "git")?.id, "08-git.md");
  assert.ok(pages.length >= 21);
  assert.equal(findPage(pages, "nope"), undefined);
});
