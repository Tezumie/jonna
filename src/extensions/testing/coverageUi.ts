// Test coverage in the workbench (D204): "Run with coverage" commands, the Test coverage tab,
// covered and uncovered lines in the editor's margin (VS Code's "Show inline coverage", on by
// default after a coverage run: testing.showInlineCoverage), percentages in the explorer
// (testing.showCoverageInExplorer) and the same for agents (`tests.coverage`).
import type { DisposableStore } from "../../core/lifecycle/index";
import { pathKey } from "../../core/paths/index";
import { effect, type Signal, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { GutterMark } from "../../workbench/gutterMarks";
import type { WorkbenchServices } from "../../workbench/services";
import type { CoverageReport, RunTarget, TestController } from "./controller";
import {
  combinedPercent,
  contextMatches,
  coverageContexts,
  fileTotals,
  hasPerTestCoverage,
  lineStates,
  nextUncovered,
  percent,
  testsCovering,
  totals,
  uncoveredRanges,
  untakenArms,
} from "./coverage";
import { registerCoverageToolbar } from "./coverageToolbar";
import { coverageViewDescriptor, totalsLabel } from "./coverageView";
import { FRAMEWORKS, type TestCase } from "./model";

/** A per-test key's test name ("TestCalc › test_sub"), from the discovered tests if listed. */
export function contextLabel(key: string, discovered: readonly TestCase[]): string {
  const known = discovered.find((t) => contextMatches(key, t));
  if (known) return known.path.join(" › ");
  const parts = key.split("::");
  return parts.length > 1 ? parts.slice(1).join(" › ") : key;
}

/** "Covered by test_a, test_b (+3 more)" for a line's hover. */
function coveredByLabel(keys: readonly string[], discovered: readonly TestCase[]): string {
  const names = keys.slice(0, 3).map((k) => contextLabel(k, discovered));
  const more = keys.length - names.length;
  return `Covered by ${names.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
}

/** What agents and the state tree get: totals, then the least covered files first. */
export function coverageSummary(report: CoverageReport, max = 100) {
  const t = totals(report.files);
  return {
    finishedAt: new Date(report.finishedAt).toISOString(),
    ran: report.label,
    percent: combinedPercent(t),
    lines: { ...t.lines, percent: percent(t.lines) },
    branches: { ...t.branches, percent: percent(t.branches) },
    functions: { ...t.functions, percent: percent(t.functions) },
    files: report.files.length,
    ...(report.problems.length && { problems: report.problems }),
    leastCovered: report.files
      .map((fc) => ({ fc, p: combinedPercent(fileTotals(fc)) }))
      .sort((a, b) => (a.p ?? 101) - (b.p ?? 101) || a.fc.file.localeCompare(b.fc.file))
      .slice(0, max)
      .map(({ fc, p }) => ({ file: fc.file, percent: p, uncovered: uncoveredRanges(fc, 20) })),
  };
}

export interface CoverageDeps {
  sub: DisposableStore;
  services: WorkbenchServices;
  tests: TestController;
  register: WorkbenchServices["dispatcher"]["register"];
  rel(path: string): string;
  runTests(
    input: { file?: string; test?: string; framework?: string; project?: string },
    coverage: boolean,
    user: boolean,
  ): Promise<unknown>;
}

export function registerCoverage(deps: CoverageDeps): { inline: Signal<boolean> } {
  const { sub, services, tests, register, rel } = deps;
  const { dock, gutterMarks, settings, workspace, decorations } = services;
  // On after each coverage run (unless testing.showInlineCoverage is off); the toggle hides it.
  const inline = signal(settings.peek<boolean>("testing.showInlineCoverage") !== false);
  sub.add(dock.views.register(coverageViewDescriptor(services, tests, inline)));

  // A new report: the margin shows it again (VS Code turns inline coverage on with a new run).
  let seen: CoverageReport | null = null;
  sub.add(
    effect(() => {
      const report = tests.coverage.value;
      if (
        report &&
        report !== seen &&
        settings.peek<boolean>("testing.showInlineCoverage") !== false
      )
        inline.value = true;
      seen = report;
      return undefined;
    }),
  );

  // Covered and uncovered lines in the margin (one test's, when "Show coverage for test" picked
  // one), with the tests that ran each line and the branches not taken, at their columns.
  sub.add(
    effect(() => {
      const report = tests.shownCoverage.value;
      const on = inline.value;
      const discovered = tests.tests.value;
      const root = workspace.root.peek();
      const byPath = new Map<string, GutterMark[]>();
      if (report && on && root)
        for (const fc of report.files) {
          const states = lineStates(fc);
          const marks: GutterMark[] = [];
          for (const [line, st] of states) {
            const hits = fc.lines.get(line) ?? 0;
            const b = fc.branches.get(line);
            const arms = untakenArms(fc, line);
            const by = testsCovering(fc, line);
            const parts = [
              st === "uncovered" ? "Not run" : `Ran ${hits} time${hits === 1 ? "" : "s"}`,
              ...(b && st !== "uncovered" ? [`${b.covered} of ${b.total} branches taken`] : []),
              ...(arms.length
                ? [`not taken at column${arms.length === 1 ? "" : "s"} ${arms.join(", ")}`]
                : []),
              ...(by.length ? [coveredByLabel(by, discovered)] : []),
            ];
            marks.push({
              line,
              className: `coverage-glyph is-${st}`,
              hover: parts.join(" · "),
              // A branch not taken, marked where it starts (Istanbul's reports say where).
              ...(arms.length && {
                columns: arms.map((column) => ({
                  column,
                  className: "coverage-branch-missed",
                  hover: "Branch not taken",
                })),
              }),
            });
          }
          // With several folders the file starts with its folder's name (D251).
          byPath.set(pathKey(workspace.resolve(fc.file)), marks);
        }
      gutterMarks.set("coverage", byPath);
      return undefined;
    }),
  );
  sub.add({ dispose: () => gutterMarks.set("coverage", new Map()) });

  // Percentages in the explorer (a badge; off by default, it takes git's letter's place).
  let byFile = new Map<string, number | null>();
  let explorerOn = settings.peek<boolean>("testing.showCoverageInExplorer") === true;
  sub.add(
    decorations.register({
      decorate: (path, kind) => {
        if (!explorerOn || kind !== "file") return undefined;
        const p = byFile.get(pathKey(path));
        if (p === undefined) return undefined;
        return {
          badge: p === null ? "–" : `${Math.round(p)}%`,
          tooltip: `Coverage: ${p === null ? "nothing to cover" : `${p}%`}`,
        };
      },
    }),
  );
  sub.add(
    effect(() => {
      settings.version.value;
      const report = tests.shownCoverage.value;
      const root = workspace.root.peek();
      explorerOn = settings.peek<boolean>("testing.showCoverageInExplorer") === true;
      byFile = new Map(
        (report?.files ?? []).map((fc) => [
          pathKey(root ? workspace.resolve(fc.file) : `/${fc.file}`),
          combinedPercent(fileTotals(fc)),
        ]),
      );
      decorations.changed();
      return undefined;
    }),
  );

  const showTab = (focus: boolean) => dock.openView("testCoverage", null, "bottom", focus);

  register({
    id: "tests.runWithCoverage",
    title: "Run tests with coverage",
    category: "Testing",
    description:
      "Runs tests like tests.run (all, a `file`, a `test`, a `framework`'s) and measures which lines they ran: Vitest / Jest (Istanbul JSON), node:test (lcov), Mocha (c8), pytest (pytest-cov), unittest (coverage.py), go test (-coverprofile), cargo test (cargo-llvm-cov). Returns the run's counts and failures, plus coverage totals and the least covered files with their uncovered lines. Shows covered lines in the editor's margin. Needs a trusted folder.",
    input: s.object({
      file: s.string().describe("Workspace-relative (or absolute) test file").optional(),
      test: s.string().describe("Test id (tests.list) or its name").optional(),
      framework: s.enum(FRAMEWORKS).optional(),
      project: s.string().describe("With framework: the project folder (relative)").optional(),
    }),
    effects: ["exec"],
    agent: "discoverable",
    run: async (input, ctx) => {
      const user = ctx.caller.kind === "user";
      if (user) showTab(false);
      return deps.runTests(input, true, user);
    },
  });

  register({
    id: "tests.runAllWithCoverage",
    title: "Run all tests with coverage",
    category: "Testing",
    description: "Runs every test with coverage (see tests.runWithCoverage).",
    input: s.empty(),
    effects: ["exec"],
    agent: "hidden",
    run: (_input, ctx) => ctx.execute("tests.runWithCoverage", {}),
  });

  register({
    id: "tests.rerunWithCoverage",
    title: "Rerun the last coverage run",
    category: "Testing",
    description: "Runs what the last coverage run ran again, with coverage.",
    input: s.empty(),
    effects: ["exec"],
    agent: "hidden",
    run: async (_input, ctx) => {
      const last: RunTarget | undefined = tests.history.list().find((r) => r.coverage)?.target;
      if (!last) return ctx.execute("tests.runWithCoverage", {});
      const summary = await tests.run({ ...last, coverage: true });
      const report = tests.coverage.peek();
      return {
        passed: summary.passed,
        failed: summary.failed,
        ...(report && { coverage: coverageSummary(report, 20) }),
      };
    },
  });

  register({
    id: "tests.showCoverage",
    title: "Show test coverage",
    category: "Testing",
    description:
      "Opens the Test coverage tab: the last coverage run's files with their covered share.",
    input: s.empty(),
    effects: [],
    agent: "hidden",
    run: () => {
      showTab(true);
    },
  });

  register({
    id: "tests.toggleInlineCoverage",
    title: "Show inline coverage",
    category: "Testing",
    description:
      "Shows or hides the last coverage run's covered and uncovered lines in the editor's margin (VS Code's Show inline coverage). `on` sets it instead of toggling.",
    input: s.object({
      on: s.boolean().optional(),
      // The editor title's button passes its file; inline coverage is for every file.
      path: s.string().describe("Ignored (the editor title's button passes it)").optional(),
    }),
    effects: [],
    agent: "discoverable",
    run: ({ on }) => {
      inline.value = on ?? !inline.peek();
      return { inline: inline.peek(), hasCoverage: tests.coverage.peek() !== null };
    },
  });

  register({
    id: "tests.clearCoverage",
    title: "Clear test coverage",
    category: "Testing",
    description: "Forgets the last coverage run (the margin, the explorer and the tab clear).",
    input: s.empty(),
    effects: [],
    agent: "discoverable",
    run: () => ({ cleared: tests.clearCoverage() }),
  });

  register({
    id: "tests.coverage",
    title: "Get test coverage",
    category: "Testing",
    description:
      "The last coverage run's results: totals (lines, branches, functions) and the least covered files with their uncovered line ranges; with `file`, that file's totals and uncovered lines. Run tests.runWithCoverage first.",
    input: s.object({ file: s.string().describe("Workspace-relative file").optional() }),
    effects: ["read"],
    agent: "discoverable",
    run: ({ file }) => {
      const report = tests.coverage.peek();
      if (!report) return { coverage: null, hint: "Run tests.runWithCoverage first." };
      if (!file) return coverageSummary(report);
      const fc = report.files.find((f) => f.file === rel(file));
      if (!fc) return { file: rel(file), covered: false, note: "Not in the coverage report." };
      const t = fileTotals(fc);
      return {
        file: fc.file,
        percent: combinedPercent(t),
        summary: totalsLabel(t),
        uncovered: uncoveredRanges(fc, 200),
        partial: [...lineStates(fc)].filter(([, st]) => st === "partial").map(([n]) => n),
        ...(fc.declarations && {
          functions: fc.declarations.slice(0, 300).map((d) => ({
            name: d.name,
            line: d.line,
            ran: d.hits,
          })),
        }),
      };
    },
  });

  // VS Code's "Go to next / previous uncovered line" (the editor's coverage toolbar).
  const goUncovered = (direction: 1 | -1) =>
    register({
      id: direction === 1 ? "tests.goToNextUncoveredLine" : "tests.goToPreviousUncoveredLine",
      title: direction === 1 ? "Go to next uncovered line" : "Go to previous uncovered line",
      category: "Testing",
      description: `Moves the active editor's cursor to the ${direction === 1 ? "next" : "previous"} line the last coverage run didn't run fully (not run, or a branch not taken), wrapping around the file.`,
      input: s.object({
        path: s.string().describe("The file (default: the active editor's)").optional(),
      }),
      effects: [],
      agent: "hidden",
      run: async ({ path }, ctx) => {
        const report = tests.coverage.peek();
        if (!report) throw new Error("No coverage yet: run tests with coverage first.");
        const snap = await services.state.get("ide://editors/active").catch(() => null);
        const active = snap?.value as {
          absolutePath?: string | null;
          cursor?: { line: number };
        } | null;
        const target = path ?? active?.absolutePath;
        if (!target) throw new Error("Open a file first.");
        const file = rel(target);
        const fc = report.files.find((f) => f.file === file);
        if (!fc) throw new Error(`${file} isn't in the coverage report.`);
        const from =
          active?.absolutePath && pathKey(active.absolutePath) === pathKey(target)
            ? (active.cursor?.line ?? 1)
            : direction === 1
              ? 0
              : Number.MAX_SAFE_INTEGER;
        const line = nextUncovered(fc, from, direction);
        if (line === null) return { line: null, note: "Every line ran." };
        if (!inline.peek()) inline.value = true;
        await ctx.execute("editor.openFile", { path: target, line });
        return { file, line };
      },
    });
  goUncovered(1);
  goUncovered(-1);

  // ---- Per-test coverage (D233; coverage.py's dynamic contexts, lcov's TN:) ----
  /** The tests the report has per-test lines for, as picker rows (key, name, file). */
  const perTestChoices = () => {
    const report = tests.coverage.peek();
    const discovered = tests.tests.peek();
    return coverageContexts(report?.files ?? []).map((key) => {
      const known = discovered.find((t) => contextMatches(key, t));
      return {
        id: key,
        label: contextLabel(key, discovered),
        description: known?.file ?? key.split("::")[0] ?? "",
        file: known?.file ?? key.split("::")[0] ?? "",
        path: known?.path ?? key.split("::").slice(1),
      };
    });
  };
  /** The test `query` names (a key, a test id, or its name) among the report's. */
  const findCoverageTest = (query: string) => {
    const choices = perTestChoices();
    const byId = tests.tests.peek().find((t) => t.id === query);
    const q = query.trim().toLowerCase();
    return (
      choices.find((c) => c.id === query) ??
      (byId && choices.find((c) => contextMatches(c.id, byId))) ??
      choices.find((c) => c.label.toLowerCase() === q) ??
      choices.find((c) => c.label.toLowerCase().endsWith(q))
    );
  };
  const showFor = (choice: { file: string; path: string[]; label: string } | null) => {
    tests.coverageTest.value = choice
      ? { file: choice.file, path: choice.path, label: choice.label }
      : null;
    if (!inline.peek()) inline.value = true;
    const shown = tests.shownCoverage.peek();
    return {
      test: choice?.label ?? null,
      files: shown?.files.length ?? 0,
      ...(shown && { percent: combinedPercent(totals(shown.files)) }),
    };
  };

  register({
    id: "tests.showCoverageForTest",
    title: "Show coverage for test…",
    category: "Testing",
    description:
      "Shows one test's coverage in the margin, the explorer and the Test coverage tab (VS Code's per-test coverage): the lines it ran. Needs per-test data from the last coverage run: pytest (coverage.py's dynamic contexts, --cov-context=test) or lcov with TN: records. `test` is a test id (tests.list), its name or its key from tests.coveredBy; `all: true` goes back to every test. Without either, asks (the user).",
    input: s.object({
      test: s.string().describe("Test id, name or per-test key").optional(),
      all: s.boolean().describe("Show every test's coverage again").optional(),
    }),
    effects: [],
    agent: "discoverable",
    run: async ({ test, all }, ctx) => {
      const report = tests.coverage.peek();
      if (!report) throw new Error("No coverage yet: run tests with coverage first.");
      if (all) return showFor(null);
      if (!hasPerTestCoverage(report.files))
        throw new Error(
          "The last coverage run has no per-test data (pytest's runs have it; Jest, Vitest, Go and cargo report coverage for the whole run only).",
        );
      if (test !== undefined) {
        const found = findCoverageTest(test);
        if (!found) throw new Error(`No per-test coverage for "${test}".`);
        return showFor(found);
      }
      if (ctx.caller.kind !== "user") throw new Error("Pass `test` (or `all: true`).");
      const current = tests.coverageTest.peek();
      const picked = await services.quickInput.pick(
        [
          { id: "", label: "All tests", description: current ? "" : "Shown now" },
          ...perTestChoices(),
        ],
        { placeholder: "Show coverage for which test?" },
      );
      if (!picked) return null;
      return showFor(picked.id ? (findCoverageTest(picked.id) ?? null) : null);
    },
  });

  register({
    id: "tests.coveredBy",
    title: "Show tests covering this line…",
    category: "Testing",
    description:
      "The tests that ran a line in the last coverage run (default: the active editor's cursor line), from per-test data (pytest's dynamic contexts, lcov's TN:). Asked by the user, a picker shows them and picking one shows that test's coverage (tests.showCoverageForTest).",
    input: s.object({
      path: s.string().describe("The file (default: the active editor's)").optional(),
      line: s.integer({ min: 1 }).describe("1-based (default: the cursor's)").optional(),
    }),
    effects: [],
    agent: "discoverable",
    run: async ({ path, line }, ctx) => {
      const report = tests.coverage.peek();
      if (!report) throw new Error("No coverage yet: run tests with coverage first.");
      const snap = await services.state.get("ide://editors/active").catch(() => null);
      const active = snap?.value as {
        absolutePath?: string | null;
        cursor?: { line: number };
      } | null;
      const target = path ?? active?.absolutePath;
      if (!target) throw new Error("Open a file first.");
      const at = line ?? active?.cursor?.line ?? 1;
      const file = rel(target);
      const fc = report.files.find((f) => f.file === file);
      const discovered = tests.tests.peek();
      const keys = fc ? testsCovering(fc, at) : [];
      const list = keys.map((key) => ({ key, name: contextLabel(key, discovered) }));
      if (ctx.caller.kind === "user") {
        if (!hasPerTestCoverage(report.files))
          throw new Error("The last coverage run has no per-test data (pytest's runs have it).");
        if (!list.length) {
          services.notifications.show("info", `No test ran line ${at} of ${file}.`);
          return { file, line: at, tests: [] };
        }
        const picked = await services.quickInput.pick(
          list.map((t) => ({ id: t.key, label: t.name, description: t.key.split("::")[0] ?? "" })),
          { placeholder: `Tests that ran line ${at}: show one's coverage` },
        );
        if (picked) await ctx.execute("tests.showCoverageForTest", { test: picked.id });
      }
      return { file, line: at, tests: list };
    },
  });

  register({
    id: "tests.toggleCoverageToolbar",
    title: "Show or hide the coverage toolbar",
    category: "Testing",
    description:
      "Shows or hides the floating coverage toolbar over the editor (VS Code's testing.coverageToolbarEnabled): the file's coverage, which test's coverage is shown, Covered by, previous / next uncovered line and inline coverage. `on` sets it.",
    input: s.object({ on: s.boolean().optional() }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ on }) => {
      const next = on ?? settings.peek<boolean>("testing.coverageToolbarEnabled") === false;
      await settings.update("testing.coverageToolbarEnabled", next, "user");
      return { on: next };
    },
  });
  registerCoverageToolbar(sub, services, tests, inline);
  // The editor's coverage actions (VS Code's floating coverage toolbar), in its title bar while a
  // coverage report is loaded: previous / next uncovered line, inline coverage on or off.
  sub.add(
    effect(() => {
      services.context.setMany({ testCoverageLoaded: tests.coverage.value !== null });
      return undefined;
    }),
  );
  sub.add(
    services.extensionFeatures.addMenus([
      {
        owner: "builtin.testing",
        location: "editor/title",
        command: "tests.goToPreviousUncoveredLine",
        title: "Go to previous uncovered line",
        icon: "arrow-up",
        when: "testCoverageLoaded",
      },
      {
        owner: "builtin.testing",
        location: "editor/title",
        command: "tests.goToNextUncoveredLine",
        title: "Go to next uncovered line",
        icon: "arrow-down",
        when: "testCoverageLoaded",
      },
      {
        owner: "builtin.testing",
        location: "editor/title",
        command: "tests.toggleInlineCoverage",
        title: "Show or hide inline coverage",
        icon: "shield",
        when: "testCoverageLoaded",
      },
    ]),
  );

  return { inline };
}
