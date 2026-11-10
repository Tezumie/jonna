import assert from "node:assert/strict";
import { test } from "node:test";
import { cardFromTool } from "./displayCards";

test("display tools: the links and question a tool call describes (D171)", () => {
  assert.deepEqual(
    cardFromTool("show_links", {
      items: [
        { title: "Docs", url: "https://example.com/docs", note: "the reference" },
        { path: "src/main.ts", line: 12 },
        { url: "javascript:alert(1)" },
        { url: "https://www.example.org/x" },
      ],
    }),
    {
      kind: "links",
      items: [
        { title: "Docs", url: "https://example.com/docs", note: "the reference" },
        { title: "src/main.ts:12", url: "src/main.ts:12", file: true },
        { title: "example.org", url: "https://www.example.org/x" },
      ],
    },
  );
  assert.equal(cardFromTool("show_links", { items: [] }), null);
  // ask_user (D312): the older single question reads as one question.
  assert.deepEqual(cardFromTool("ask_user", { question: "Which?", options: ["A", " ", "B"] }), {
    kind: "ask",
    questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }],
  });
  assert.equal(cardFromTool("ask_user", { question: "Which?", options: [] }), null);
  // A note under each option (objects or `descriptions`), and several picks.
  assert.deepEqual(
    cardFromTool("ask_user", {
      question: "Which?",
      options: [{ label: "A", description: "The quick one" }, "B"],
      multi_select: true,
    }),
    {
      kind: "ask",
      questions: [
        {
          question: "Which?",
          options: [{ label: "A", description: "The quick one" }, { label: "B" }],
          multiSelect: true,
        },
      ],
    },
  );
  assert.deepEqual(
    cardFromTool("report_findings", {
      findings: [{ file: "a.ts", line: 3, summary: "Off by one." }],
    }),
    {
      kind: "findings",
      findings: [{ file: "a.ts", line: 3, summary: "Off by one.", shortSummary: "Off by one." }],
    },
  );
  assert.equal(cardFromTool("report_findings", {}), null);
  assert.equal(cardFromTool("show_chart", { labels: ["a"], series: [] }), null);
  assert.equal(cardFromTool("read_file", {}), null);
});
