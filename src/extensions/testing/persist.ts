// Test results and coverage kept across reloads and restarts (D209, VS Code's testing.keepResults):
// the run history, each test's last result and the last coverage report, as JSON. DOM-free and
// tested; the controller reads and writes the files (`<root>/<IDE folder>/testing/results.json`
// and `…/coverage/last.json`, both git-ignored).
import type { CoverageReport } from "./controller";
import type { BranchArm, Counts, FileCoverage } from "./coverage";
import type { TestNaming } from "./folders";
import type { RunHistory } from "./history";
import type { TestResult } from "./model";

const VERSION = 1;
const STATUSES = new Set(["passed", "failed", "skipped"]);
/** Each test's last result kept (messages and outputs as the history keeps them). */
const MAX_RESULTS = 5000;
/** Above the model's own clip (20 000 and its "… " plus an escape kept whole): not cut again. */
const MAX_TEXT = 20_100;

const clip = (s: string | undefined) =>
  s === undefined ? undefined : s.length > MAX_TEXT ? s.slice(-MAX_TEXT) : s;

/** The history and the last results, as the file holds them. */
export function serializeResults(
  history: RunHistory,
  results: ReadonlyMap<string, TestResult | { status: "running" }>,
  naming?: TestNaming,
): string {
  const last: [string, TestResult][] = [];
  for (const [id, r] of results) {
    if (r.status === "running") continue;
    if (last.length >= MAX_RESULTS) break;
    const message = clip(r.message);
    const output = clip(r.output);
    last.push([
      id,
      {
        ...r,
        ...(message !== undefined && { message }),
        ...(output !== undefined && { output }),
      },
    ]);
  }
  return JSON.stringify({
    version: VERSION,
    savedAt: Date.now(),
    history: history.snapshot(),
    last,
    // How the ids name their files (D251): read back under another naming, they're renamed.
    ...(naming && { naming }),
  });
}

function isResult(v: unknown): v is TestResult {
  const r = v as Partial<TestResult> | null;
  return (
    !!r &&
    typeof r === "object" &&
    STATUSES.has(String(r.status)) &&
    (r.durationMs === undefined || typeof r.durationMs === "number") &&
    (r.message === undefined || typeof r.message === "string") &&
    (r.output === undefined || typeof r.output === "string") &&
    (r.expected === undefined || typeof r.expected === "string") &&
    (r.actual === undefined || typeof r.actual === "string")
  );
}

/** The file read back: its history (for RunHistory.restore) and each test's last result. */
export function parseResults(
  text: string,
): { history: unknown; results: Map<string, TestResult>; naming?: TestNaming } | null {
  let data: { version?: unknown; history?: unknown; last?: unknown; naming?: unknown };
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || data.version !== VERSION) return null;
  const results = new Map<string, TestResult>();
  if (Array.isArray(data.last))
    for (const entry of data.last.slice(0, MAX_RESULTS)) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !isResult(entry[1])) continue;
      results.set(entry[0], entry[1]);
    }
  const naming = isNaming(data.naming) ? data.naming : undefined;
  return { history: data.history, results, ...(naming && { naming }) };
}

function isNaming(v: unknown): v is TestNaming {
  const n = v as Partial<TestNaming> | null;
  return (
    !!n &&
    typeof n === "object" &&
    typeof n.multi === "boolean" &&
    Array.isArray(n.folders) &&
    n.folders.every(
      (f: unknown) =>
        !!f &&
        typeof (f as { path?: unknown }).path === "string" &&
        typeof (f as { name?: unknown }).name === "string",
    )
  );
}

const isCounts = (v: unknown): v is Counts =>
  !!v &&
  typeof v === "object" &&
  typeof (v as Counts).covered === "number" &&
  typeof (v as Counts).total === "number";

/** A coverage report as JSON (its maps as pairs). */
export function serializeCoverage(report: CoverageReport): string {
  return JSON.stringify({
    version: VERSION,
    finishedAt: report.finishedAt,
    label: report.label,
    problems: report.problems,
    files: report.files.map((f) => ({
      file: f.file,
      lines: [...f.lines],
      branches: [...f.branches],
      functions: f.functions,
      ...(f.declarations && { declarations: f.declarations }),
      // Per-test lines and branch columns (D233).
      ...(f.contexts && { contexts: [...f.contexts] }),
      ...(f.branchArms && { branchArms: [...f.branchArms] }),
    })),
  });
}

/** A coverage report read back; null when the file isn't one. */
export function parseCoverage(text: string): CoverageReport | null {
  let data: {
    version?: unknown;
    finishedAt?: unknown;
    label?: unknown;
    problems?: unknown;
    files?: unknown;
  };
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || data.version !== VERSION || !Array.isArray(data.files))
    return null;
  const files: FileCoverage[] = [];
  for (const raw of data.files) {
    const f = raw as {
      file?: unknown;
      lines?: unknown;
      branches?: unknown;
      functions?: unknown;
      declarations?: unknown;
      contexts?: unknown;
      branchArms?: unknown;
    };
    if (!f || typeof f.file !== "string" || !Array.isArray(f.lines) || !isCounts(f.functions))
      continue;
    const lines = new Map<number, number>();
    for (const pair of f.lines)
      if (Array.isArray(pair) && typeof pair[0] === "number" && typeof pair[1] === "number")
        lines.set(pair[0], pair[1]);
    const branches = new Map<number, Counts>();
    if (Array.isArray(f.branches))
      for (const pair of f.branches)
        if (Array.isArray(pair) && typeof pair[0] === "number" && isCounts(pair[1]))
          branches.set(pair[0], { covered: pair[1].covered, total: pair[1].total });
    const contexts = new Map<number, string[]>();
    if (Array.isArray(f.contexts))
      for (const pair of f.contexts)
        if (Array.isArray(pair) && typeof pair[0] === "number" && Array.isArray(pair[1]))
          contexts.set(
            pair[0],
            pair[1].filter((k: unknown): k is string => typeof k === "string"),
          );
    const branchArms = new Map<number, BranchArm[]>();
    if (Array.isArray(f.branchArms))
      for (const pair of f.branchArms)
        if (Array.isArray(pair) && typeof pair[0] === "number" && Array.isArray(pair[1]))
          branchArms.set(
            pair[0],
            pair[1].flatMap((a: unknown) => {
              const x = a as { column?: unknown; taken?: unknown } | null;
              return x && typeof x.column === "number" && typeof x.taken === "boolean"
                ? [{ column: x.column, taken: x.taken }]
                : [];
            }),
          );
    files.push({
      file: f.file,
      lines,
      branches,
      ...(contexts.size && { contexts }),
      ...(branchArms.size && { branchArms }),
      functions: { covered: f.functions.covered, total: f.functions.total },
      ...(Array.isArray(f.declarations) && {
        declarations: f.declarations.flatMap((d) => {
          const x = d as { name?: unknown; line?: unknown; hits?: unknown } | null;
          return x &&
            typeof x.name === "string" &&
            typeof x.line === "number" &&
            typeof x.hits === "number"
            ? [{ name: x.name, line: x.line, hits: x.hits }]
            : [];
        }),
      }),
    });
  }
  return {
    files,
    finishedAt: typeof data.finishedAt === "number" ? data.finishedAt : 0,
    label: typeof data.label === "string" ? data.label : "",
    problems: Array.isArray(data.problems)
      ? data.problems.filter((p): p is string => typeof p === "string")
      : [],
  };
}
