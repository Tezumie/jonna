import assert from "node:assert/strict";
import { test } from "node:test";
import { headingAnchor, pageSections, plainText, queryWords, searchDocs } from "./docsSearch";
import { docPages } from "./pages";

const page = (id: string, text: string) => ({
  id,
  title: /^#\s+(.+)$/m.exec(text)?.[1] ?? id,
  text,
});

const GIT = page(
  "08-git.md",
  [
    "# Source control",
    "",
    "Commit, branch and push without leaving the window.",
    "",
    "## Staging changes",
    "",
    "Click **+** beside a file to stage it, or use `git.stage`.",
    "",
    "```sh",
    "# not a heading: a comment in a shell block",
    "git stash push",
    "```",
    "",
    "### Stage a hunk",
    "",
    "Open the [diff](04-editing.md#diffs) and stage one hunk.",
    "",
    "## What's new?",
    "",
    "| Key | Does |",
    "|---|---|",
    "| Ctrl+Enter | Commits |",
  ].join("\n"),
);
const TERMINAL = page(
  "10-terminal.md",
  [
    "# Terminal",
    "",
    "A shell in a tab.",
    "",
    "## Profiles",
    "",
    "Pick a shell to stage a demo.",
  ].join("\n"),
);

test("docs search: a page is cut at its headings, code blocks included but not cut", () => {
  const sections = pageSections(GIT);
  assert.deepEqual(
    sections.map((s) => [s.level, s.heading, s.anchor]),
    [
      [1, "Source control", ""],
      [2, "Staging changes", "staging-changes"],
      [3, "Stage a hunk", "stage-a-hunk"],
      [2, "What's new?", "whats-new"],
    ],
  );
  assert.equal(sections[0]?.text, "Commit, branch and push without leaving the window.");
  assert.match(sections[1]?.text ?? "", /git stash push/);
  assert.match(sections[1]?.text ?? "", /Click \+ beside a file to stage it, or use git\.stage\./);
  assert.equal(sections[2]?.text, "Open the diff and stage one hunk.");
  assert.equal(sections[3]?.text, "Key Does Ctrl+Enter Commits");
});

test("docs search: Markdown's marks come off, and anchors match the renderer's", () => {
  assert.equal(
    plainText("- Use **bold**, `code` and [a link](x.md#y)."),
    "Use bold, code and a link.",
  );
  assert.equal(plainText("> A _quoted_ line"), "A quoted line");
  assert.equal(headingAnchor("Settings, themes and profiles"), "settings-themes-and-profiles");
  assert.equal(headingAnchor("What's new?"), "whats-new");
  assert.deepEqual(queryWords("  Stage  a stage HUNK "), ["stage", "a", "hunk"]);
});

test("docs search: every word must be there; headings count for more than text", () => {
  const sections = [...pageSections(GIT), ...pageSections(TERMINAL)];
  const hits = searchDocs(sections, "stage");
  assert.deepEqual(
    hits.map((h) => `${h.section.page}#${h.section.anchor}`),
    ["08-git.md#stage-a-hunk", "08-git.md#staging-changes", "10-terminal.md#profiles"],
  );
  // Both words, in whichever of heading, title and text.
  assert.deepEqual(
    searchDocs(sections, "terminal shell").map((h) => h.section.heading),
    ["Terminal", "Profiles"],
  );
  assert.deepEqual(searchDocs(sections, "stage nothing"), []);
  assert.deepEqual(searchDocs(sections, "   "), []);
  // A page's title finds the page's top first.
  assert.equal(searchDocs(sections, "source control")[0]?.section.anchor, "");
});

test("docs search: the snippet shows the words found, marked", () => {
  const [hit] = searchDocs(pageSections(GIT), "hunk diff");
  assert.ok(hit);
  const { text, marks } = hit.snippet;
  assert.deepEqual(
    marks.map(([a, b]) => text.slice(a, b).toLowerCase()),
    ["diff", "hunk"],
  );
  // A long section is cut around the first word found.
  const long = page("x.md", `# Long\n\n${"filler words ".repeat(60)}needle ${"more ".repeat(60)}`);
  const found = searchDocs(pageSections(long), "needle")[0];
  assert.ok(found && found.snippet.text.length < 200);
  assert.match(found.snippet.text, /^… .*needle.* …$/);
});

test("docs search: the real guide answers ordinary questions", () => {
  const sections = docPages("Acme").flatMap(pageSections);
  assert.ok(sections.length > 100);
  const top = (query: string) => searchDocs(sections, query)[0]?.section.page;
  assert.equal(top("multi-root workspaces"), "20-workspaces.md");
  assert.equal(top("keyboard shortcuts"), "17-keyboard-shortcuts.md");
  assert.ok(searchDocs(sections, "commit").some((h) => h.section.page === "08-git.md"));
  // Every anchor is one the page can scroll to: unique within its page or the first of its name.
  for (const s of sections) assert.ok(s.level === 1 || s.anchor.length > 0, s.heading);
});
