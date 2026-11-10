import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePlanLimits } from "./planLimits";

test("planLimits: Codex's /status card (D233)", () => {
  const text = [
    ">_ OpenAI Codex (v0.46.0)",
    " Model:            gpt-5-codex (reasoning medium, summaries auto)",
    " Directory:        ~/proj",
    " Account:          me@example.com (Plus)",
    " Context window:   100% left (0 used / 272K)",
    " 5h limit:         [████░░░░░░░░░░░░] 30% used (resets 14:32)",
    " Weekly limit:     [█░░░░░░░░░░░░░░░] 5% used (resets 09:00 on 3 Nov)",
  ].join("\n");
  assert.deepEqual(parsePlanLimits(text), [
    { label: "5h", usedPercent: 30, resets: "14:32" },
    { label: "Weekly", usedPercent: 5, resets: "09:00 on 3 Nov" },
  ]);
});

test("planLimits: Markdown layouts, percent left, no reset", () => {
  const md = [
    "**Rate limits**",
    "- **5h limit**: 72.5% left (resets in 2h 10m)",
    "- Weekly limit: 12% used",
    "| Monthly limit | 40% used | resets on 1 Dec |",
  ].join("\n");
  assert.deepEqual(parsePlanLimits(md), [
    { label: "5h", usedPercent: 27.5, resets: "in 2h 10m" },
    { label: "Weekly", usedPercent: 12 },
    { label: "Monthly", usedPercent: 40, resets: "1 Dec" },
  ]);
});

test("planLimits: nothing that looks like a limit is null", () => {
  assert.equal(parsePlanLimits(" Context window: 80% left"), null);
  assert.equal(parsePlanLimits("You have no limit on this plan."), null);
  assert.equal(parsePlanLimits("5h limit: unknown"), null);
  assert.equal(parsePlanLimits(""), null);
});
