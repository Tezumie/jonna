// Test run history (D204, VS Code's Test results): the last runs, newest first, each with what it
// was asked to run (so it can run again), when, how long, its counts and every test's result; and
// a test's last results across those runs, with each test's own output (D209). DOM-free and
// tested. Kept across reloads (D209, VS Code's testing.keepResults) through `snapshot` /
// `restore` (persist.ts writes them to the folder).

// The notebook's ANSI parser (SGR colors to the terminal palette's tokens), shared.
import { ansiSegments } from "../editor/notebook/ansi";

export type HistoryStatus = "passed" | "failed" | "skipped";

export interface HistoryResult {
  id: string;
  /** Suites and name, " › " between them. */
  name: string;
  file: string;
  status: HistoryStatus;
  durationMs?: number;
  message?: string;
  /** The test's own output (D209), where its framework reports it per test. */
  output?: string;
}

/** What to run again: the same shape as the controller's run target. */
export interface HistoryTarget {
  file?: string;
  files?: string[];
  testId?: string;
  testIds?: string[];
  failedOnly?: boolean;
  label?: string;
  coverage?: boolean;
}

export interface RunRecord {
  id: number;
  label: string;
  startedAt: number;
  durationMs: number;
  target: HistoryTarget;
  coverage: boolean;
  cancelled: boolean;
  passed: number;
  failed: number;
  skipped: number;
  commands: string[];
  results: HistoryResult[];
}

export interface TestHistoryEntry {
  run: number;
  at: number;
  status: HistoryStatus;
  durationMs?: number;
}

/** Results kept per run (a huge suite keeps the failures and the first others). */
const MAX_RESULTS = 2000;
const MAX_MESSAGE = 4000;
/** A test's output kept (its end, where the failure is), and a run's in all (failures first). */
const MAX_OUTPUT = 20_000;
const MAX_RUN_OUTPUT = 1_000_000;

const tail = (s: string, max: number) => (s.length > max ? `… ${s.slice(-max)}` : s);

export class RunHistory {
  private runs: RunRecord[] = [];
  private next = 1;

  constructor(private max = 20) {}

  /** How many runs are kept (testing.resultsHistory); older ones drop. */
  setMax(max: number): void {
    // A setting that isn't a number keeps the default (NaN would keep no runs at all).
    this.max = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 20;
    this.runs = this.runs.slice(0, this.max);
  }

  add(run: Omit<RunRecord, "id">): RunRecord {
    const failed = run.results.filter((r) => r.status === "failed");
    const others = run.results.filter((r) => r.status !== "failed");
    let outputLeft = MAX_RUN_OUTPUT;
    const results = [...failed, ...others].slice(0, MAX_RESULTS).map((r) => {
      const { output, ...rest } = r;
      const kept = output && outputLeft > 0 ? tail(output, Math.min(MAX_OUTPUT, outputLeft)) : "";
      outputLeft -= kept.length;
      return {
        ...rest,
        ...(r.message !== undefined && { message: r.message.slice(0, MAX_MESSAGE) }),
        ...(kept && { output: kept }),
      };
    });
    const record: RunRecord = { ...run, results, id: this.next++ };
    this.runs = [record, ...this.runs].slice(0, this.max);
    return record;
  }

  /** Newest first. */
  list(): readonly RunRecord[] {
    return this.runs;
  }

  get(id: number): RunRecord | undefined {
    return this.runs.find((r) => r.id === id);
  }

  /** A test's results in the kept runs, newest first (at most `limit`). */
  testHistory(testId: string, limit = 10): TestHistoryEntry[] {
    const out: TestHistoryEntry[] = [];
    for (const run of this.runs) {
      const r = run.results.find((x) => x.id === testId);
      if (!r) continue;
      out.push({
        run: run.id,
        at: run.startedAt,
        status: r.status,
        ...(r.durationMs !== undefined && { durationMs: r.durationMs }),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  clear(): void {
    this.runs = [];
  }

  /**
   * The runs with their test ids and files renamed (D251: the workspace's naming changed, one
   * folder to several or a folder renamed); results whose folder left the workspace drop.
   * `id` / `file` return null for a name whose folder is gone.
   */
  rename(id: (id: string) => string | null, file: (file: string) => string | null): void {
    // What to run again keeps a name it can't rename (its folder left): run again, it finds no
    // tests, where dropping it would widen the run to every test.
    const keep = (f: (x: string) => string | null) => (x: string) => f(x) ?? x;
    this.runs = this.runs.map((run) => {
      const t = run.target;
      const target: HistoryTarget = {
        ...t,
        ...(t.file !== undefined && { file: keep(file)(t.file) }),
        ...(t.files && { files: t.files.map(keep(file)) }),
        ...(t.testId !== undefined && { testId: keep(id)(t.testId) }),
        ...(t.testIds && { testIds: t.testIds.map(keep(id)) }),
      };
      const results: HistoryResult[] = [];
      for (const r of run.results) {
        const rid = id(r.id);
        const rfile = file(r.file);
        if (rid !== null && rfile !== null) results.push({ ...r, id: rid, file: rfile });
      }
      return { ...run, target, results };
    });
  }

  /** What's kept across reloads (D209). */
  snapshot(): { next: number; runs: RunRecord[] } {
    return { next: this.next, runs: this.runs };
  }

  /** Runs kept from before (D209): checked, newest first, at most the limit. */
  restore(data: unknown): number {
    const d = data as { next?: unknown; runs?: unknown } | null;
    if (!d || typeof d !== "object" || !Array.isArray(d.runs)) return 0;
    const runs = d.runs.filter(isRunRecord).slice(0, this.max);
    this.runs = runs;
    const highest = runs.reduce((n, r) => Math.max(n, r.id), 0);
    this.next = Math.max(highest + 1, typeof d.next === "number" ? Math.floor(d.next) : 1);
    return runs.length;
  }
}

const STATUSES = new Set(["passed", "failed", "skipped"]);

function isRunRecord(v: unknown): v is RunRecord {
  const r = v as Partial<RunRecord> | null;
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.id === "number" &&
    typeof r.label === "string" &&
    typeof r.startedAt === "number" &&
    typeof r.durationMs === "number" &&
    !!r.target &&
    typeof r.target === "object" &&
    typeof r.passed === "number" &&
    typeof r.failed === "number" &&
    typeof r.skipped === "number" &&
    Array.isArray(r.commands) &&
    Array.isArray(r.results) &&
    r.results.every(
      (x: Partial<HistoryResult> | null) =>
        !!x &&
        typeof x.id === "string" &&
        typeof x.name === "string" &&
        typeof x.file === "string" &&
        STATUSES.has(String(x.status)),
    )
  );
}

/** What the results tab's output pane shows for a test (D209): its own output, else its message. */
export function outputPaneText(r: HistoryResult): string {
  if (r.output?.trim()) return r.output;
  if (r.message?.trim()) return r.message;
  return r.status === "failed"
    ? "The test failed without a message."
    : "This test printed nothing its framework reports per test.";
}

/**
 * The output pane's text without its colors and other escape sequences (for agents: the output
 * keeps the framework's ANSI colors, which the Test results tab draws).
 */
export function plainOutputText(r: HistoryResult): string {
  return ansiSegments(outputPaneText(r))
    .map((seg) => seg.text)
    .join("");
}

/** "3 passed, 1 failed" (skipped only when there are some). */
export function countsLabel(r: Pick<RunRecord, "passed" | "failed" | "skipped">): string {
  return [
    `${r.passed} passed`,
    `${r.failed} failed`,
    ...(r.skipped ? [`${r.skipped} skipped`] : []),
  ].join(", ");
}

/** "450 ms", "2.3 s", "1 min 5 s". */
export function durationLabel(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const min = Math.floor(ms / 60_000);
  return `${min} min ${Math.round((ms % 60_000) / 1000)} s`;
}
