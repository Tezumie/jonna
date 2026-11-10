// report_findings (D313): a code review's verified findings as a typed list the chat draws as a
// card (each opens its file at the line; Fix / Fix all ask the agent to fix them), like Claude
// Code's ReportFindings. A re-report after fixing carries each finding's outcome. DOM-free and
// tested.

export type FindingVerdict = "CONFIRMED" | "PLAUSIBLE";
export type FindingOutcome = "fixed" | "skipped" | "no_change_needed";

export interface Finding {
  /** Relative to the folder. */
  file: string;
  line?: number;
  summary: string;
  /** At most 60 characters: the row's title. */
  shortSummary: string;
  /** Concrete inputs or state → the wrong output or crash. */
  failureScenario?: string;
  /** A kebab-case slug: correctness, simplification, efficiency, test-coverage… */
  category?: string;
  verdict?: FindingVerdict;
  outcome?: FindingOutcome;
}

export interface FindingsCard {
  kind: "findings";
  findings: Finding[];
}

const MAX_FINDINGS = 50;
const SHORT_LIMIT = 60;
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

const OUTCOMES: readonly FindingOutcome[] = ["fixed", "skipped", "no_change_needed"];

function shorten(s: string, limit: number): string {
  return s.length <= limit ? s : `${s.slice(0, limit - 1).trimEnd()}…`;
}

/** A finding from the model's JSON (snake_case as the tool takes it, camelCase as stored). */
function findingOf(raw: unknown): Finding | null {
  const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const file = text(f.file).replace(/\\/g, "/").replace(/^\.\//, "");
  const summary = text(f.summary);
  if (!file || !summary) return null;
  const lineIn = typeof f.line === "string" ? Number(f.line) : f.line;
  const line =
    typeof lineIn === "number" && Number.isFinite(lineIn) && lineIn > 0
      ? Math.floor(lineIn)
      : undefined;
  const short = text(f.short_summary) || text(f.shortSummary) || summary;
  const scenario = text(f.failure_scenario) || text(f.failureScenario);
  const category = text(f.category)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const verdict = text(f.verdict).toUpperCase();
  const outcome = text(f.outcome)
    .toLowerCase()
    .replace(/[\s-]+/g, "_") as FindingOutcome;
  return {
    file,
    ...(line && { line }),
    summary,
    shortSummary: shorten(short, SHORT_LIMIT),
    ...(scenario && { failureScenario: scenario }),
    ...(category && { category }),
    ...((verdict === "CONFIRMED" || verdict === "PLAUSIBLE") && { verdict }),
    ...(OUTCOMES.includes(outcome) && { outcome }),
  };
}

/** The findings a call reports (an empty list is a clean review), or why they can't be read. */
export function parseFindings(args: unknown): FindingsCard | { error: string } {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  if (!Array.isArray(a.findings)) return { error: "give findings: an array (empty if none)" };
  const findings: Finding[] = [];
  for (const [i, raw] of (a.findings as unknown[]).entries()) {
    const f = findingOf(raw);
    if (!f) return { error: `finding ${i + 1} needs a file and a summary` };
    findings.push(f);
  }
  return { kind: "findings", findings: findings.slice(0, MAX_FINDINGS) };
}

/** Where a finding opens: "src/a.ts:12". */
export const findingTarget = (f: Finding) => (f.line ? `${f.file}:${f.line}` : f.file);

/** One line for the tool row: "3 findings · 1 fixed". */
export function findingsSummary(card: FindingsCard): string {
  const n = card.findings.length;
  if (!n) return "No findings";
  const fixed = card.findings.filter((f) => f.outcome === "fixed").length;
  return `${n} finding${n === 1 ? "" : "s"}${fixed ? ` · ${fixed} fixed` : ""}`;
}

/** The message Fix (one) or Fix all sends to the agent. */
export function fixMessage(findings: readonly Finding[]): string {
  const open = findings.filter((f) => !f.outcome);
  const list = (open.length ? open : findings).map((f, i) =>
    [
      `${i + 1}. ${findingTarget(f)} — ${f.summary}`,
      f.failureScenario ? `   Fails when: ${f.failureScenario}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return [
    list.length === 1 ? "Fix this review finding:" : "Fix these review findings:",
    ...list,
    "",
    "Check each against the code first and skip one that turns out wrong. When done, call report_findings again with the same findings, each with its outcome (fixed, skipped or no_change_needed).",
  ].join("\n");
}

/** What the model gets back after reporting. */
export function findingsResult(card: FindingsCard): string {
  const n = card.findings.length;
  if (!n) return "Reported: no findings. Say so in one line.";
  const reReport = card.findings.some((f) => f.outcome);
  return reReport
    ? `Reported ${n} finding${n === 1 ? "" : "s"} with their outcomes; the user sees them as a card. Finish with one or two lines, without listing them again.`
    : `Shown to the user as a card of ${n} finding${n === 1 ? "" : "s"} (they open each, and can ask you to fix them). Finish with one or two lines, without listing them again.`;
}
