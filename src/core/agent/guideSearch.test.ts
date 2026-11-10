import assert from "node:assert/strict";
import { test } from "node:test";
import { guideIndexText, guideResultText, guideSections, searchGuide } from "./guideSearch";

const pages = [
  {
    id: "05-agent.md",
    title: "The agent",
    text: "# The agent\n\nIntro text.\n\n## Plan mode\n\nPlan mode researches first; Build carries it out.\n\n```md\n# not a heading\n```\n\n## Loops\n\nType /loop to check something again and again.",
  },
  {
    id: "10-terminal.md",
    title: "Terminal",
    text: "# Terminal\n\n## Shells\n\nPick a shell. The agent's commands run in PowerShell on Windows.",
  },
];

test("guideSections splits at headings, not inside code", () => {
  const s = guideSections(pages[0] as (typeof pages)[number]);
  assert.deepEqual(
    s.map((x) => x.heading),
    ["The agent", "Plan mode", "Loops"],
  );
  assert.match(s[1]?.text ?? "", /# not a heading/);
});

test("searchGuide finds the section, heading matches first", () => {
  const hits = searchGuide(pages, "how do I use plan mode", 2);
  assert.equal(hits[0]?.heading, "Plan mode");
  assert.equal(hits[0]?.page, "05-agent.md");
  const loop = searchGuide(pages, "loop", 5);
  assert.equal(loop[0]?.heading, "Loops");
  assert.deepEqual(searchGuide(pages, "zzzz", 5), []);
  assert.match(
    guideResultText(hits.slice(0, 1), "plan mode"),
    /^## The agent › Plan mode \(05-agent\.md\)\n/,
  );
  assert.equal(guideIndexText(pages), "05-agent.md: The agent\n10-terminal.md: Terminal");
});
