import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type FindingsCard,
  findingsResult,
  findingsSummary,
  findingTarget,
  fixMessage,
  parseFindings,
} from "./findings";

test("report_findings: typed findings from the model's JSON (D313)", () => {
  const card = parseFindings({
    findings: [
      {
        file: "./src\\cart.ts",
        line: "41",
        summary: "The discount is applied twice when the cart has one item.",
        short_summary:
          "Discount applied twice for a single-item cart, which is a long title past sixty",
        failure_scenario: "cart = [{ price: 10 }], code SAVE10 → total 8 instead of 9",
        category: "Correctness",
        verdict: "confirmed",
      },
      { file: "src/util.ts", summary: "Dead branch.", outcome: "no change needed" },
    ],
  }) as FindingsCard;
  assert.equal(card.findings.length, 2);
  const [a, b] = card.findings;
  assert.equal(a?.file, "src/cart.ts");
  assert.equal(a?.line, 41);
  assert.equal(a?.verdict, "CONFIRMED");
  assert.equal(a?.category, "correctness");
  assert.ok((a?.shortSummary.length ?? 0) <= 60);
  assert.ok(a?.shortSummary.endsWith("…"));
  assert.equal(b?.outcome, "no_change_needed");
  assert.equal(b?.shortSummary, "Dead branch.");
  assert.equal(findingTarget(a ?? b ?? ({} as never)), "src/cart.ts:41");
  assert.equal(findingsSummary(card), "2 findings");
});

test("report_findings: an empty list is a clean review; a finding needs a file and a summary", () => {
  assert.deepEqual(parseFindings({ findings: [] }), { kind: "findings", findings: [] });
  assert.match(findingsResult({ kind: "findings", findings: [] }), /no findings/);
  assert.match((parseFindings({}) as { error: string }).error, /array/);
  assert.match(
    (parseFindings({ findings: [{ file: "a.ts" }] }) as { error: string }).error,
    /finding 1/,
  );
});

test("report_findings: Fix asks for the open ones and a re-report", () => {
  const card = parseFindings({
    findings: [
      { file: "a.ts", line: 3, summary: "Off by one.", failure_scenario: "n = 0 → crash" },
      { file: "b.ts", summary: "Leak.", outcome: "fixed" },
    ],
  }) as FindingsCard;
  const message = fixMessage(card.findings);
  assert.match(
    message,
    /^Fix this review finding:\n1\. a\.ts:3 — Off by one\.\n {3}Fails when: n = 0 → crash/,
  );
  assert.ok(!message.includes("b.ts"));
  assert.match(message, /report_findings again/);
  assert.equal(findingsSummary(card), "2 findings · 1 fixed");
  assert.match(findingsResult(card), /outcomes/);
});
