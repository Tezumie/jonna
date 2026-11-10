// Test results in the workbench (D204): the run history (the Test results tab, rerun a past run,
// a test's last results for agents), "Compare expected with actual" (a diff tab of a failed
// assertion's values) and "Debug test" (the test under the debugger, through debug.start with a
// launch configuration made for its framework, debugConfig.ts).
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { Discovered, TestController } from "./controller";
import { debugConfiguration, debugPackage, debugUnsupported } from "./debugConfig";
import { countsLabel, plainOutputText } from "./history";
import { testAt } from "./model";
import { resultsViewDescriptor, revealTestOutput } from "./resultsView";

export interface ResultsDeps {
  sub: DisposableStore;
  services: WorkbenchServices;
  tests: TestController;
  register: WorkbenchServices["dispatcher"]["register"];
  rel(path: string): string;
  ensureDiscovered(): Promise<void>;
  findTest(test: string, file?: string): Discovered;
  activeEditor(): Promise<{ file: string; line: number } | null>;
}

export function registerResults(deps: ResultsDeps): void {
  const { sub, services, tests, register, rel } = deps;
  const { dock, quickDiff, workspace } = services;
  sub.add(dock.views.register(resultsViewDescriptor(services, tests)));

  // The two sides of a failed assertion, for the diff tab ("testExpected:<test id>").
  const side = (key: "expected" | "actual") => async (_path: string, scheme: string) => {
    const id = scheme.slice(scheme.indexOf(":") + 1);
    const r = tests.results.peek().get(id);
    return r && r.status !== "running" ? (r[key] ?? null) : null;
  };
  sub.add(quickDiff.registerContent("testExpected:", side("expected")));
  sub.add(quickDiff.registerContent("testActual:", side("actual")));

  // A test file as named (with its folder's name first, of several: D251) made absolute.
  const abs = (file: string) => (workspace.root.peek() ? workspace.resolve(file) : file);

  register({
    id: "tests.compareExpected",
    title: "Compare expected with actual",
    category: "Testing",
    description:
      "Opens a failed test's expected and actual values side by side in a diff tab (when its framework reported them: Jest, Vitest, node:test, Mocha, Playwright, pytest, unittest assertions).",
    input: s.object({ id: s.string().describe("Test id (tests.list)") }),
    effects: [],
    agent: "hidden",
    run: async ({ id }, ctx) => {
      const t = tests.tests.peek().find((x) => x.id === id);
      const r = tests.results.peek().get(id);
      if (!t || !r || r.status !== "failed")
        throw new Error("That test hasn't failed (run it first).");
      if (r.expected === undefined)
        throw new Error("The test's failure has no expected and actual values to compare.");
      return ctx.execute("editor.openDiff", {
        path: abs(t.file),
        base: `testExpected:${id}`,
        baseLabel: "Expected",
        head: `testActual:${id}`,
        headLabel: "Actual",
      });
    },
  });

  register({
    id: "tests.showResults",
    title: "Show test results",
    category: "Testing",
    description: "Opens the Test results tab: the last test runs with each test's result.",
    input: s.empty(),
    effects: [],
    agent: "hidden",
    run: () => {
      dock.openView("testResults", null, "bottom", true);
    },
  });

  register({
    id: "tests.showTestOutput",
    title: "Show test output",
    category: "Testing",
    description:
      "Shows a test's own output in the Test results tab (what its framework printed for that test: Go's output, pytest's captured output, cargo's stdout, node:test's diagnostics, Jest / Vitest's failure with its stack; else its message). `run`: a past run's (default: the newest run that has the test). Returns the text.",
    input: s.object({
      test: s.string().describe("Test id (tests.list) or its name"),
      run: s.integer({ min: 1 }).describe("A run's id (tests.history)").optional(),
    }),
    effects: ["read"],
    agent: "discoverable",
    run: async ({ test, run }, ctx) => {
      const list = tests.history.list();
      const byId = (id: string) =>
        (run === undefined ? list : list.filter((r) => r.id === run)).find((r) =>
          r.results.some((x) => x.id === id),
        );
      let record = byId(test);
      let id = test;
      if (!record) {
        await deps.ensureDiscovered();
        id = deps.findTest(test).id;
        record = byId(id);
      }
      const result = record?.results.find((x) => x.id === id);
      if (!record || !result)
        throw new Error(
          run === undefined ? "That test hasn't run yet." : `Run ${run} didn't run that test.`,
        );
      if (ctx.caller.kind === "user" || ctx.caller.kind === "test") {
        dock.openView("testResults", null, "bottom", true);
        // The tab draws its runs first.
        await new Promise((r) => setTimeout(r, 50));
        revealTestOutput(record.id, id);
      }
      return {
        run: record.id,
        test: result.name,
        status: result.status,
        output: plainOutputText(result),
      };
    },
  });

  register({
    id: "tests.history",
    title: "Get test run history",
    category: "Testing",
    description:
      "The last test runs (newest first: id, what ran, when, counts, duration, failed tests); with `test` (an id or name), that test's results in those runs.",
    input: s.object({ test: s.string().describe("Test id (tests.list) or its name").optional() }),
    effects: ["read"],
    agent: "discoverable",
    run: async ({ test }) => {
      if (test) {
        await deps.ensureDiscovered();
        const t = deps.findTest(test);
        return {
          test: t.path.join(" › "),
          file: t.file,
          runs: tests.history
            .testHistory(t.id, 20)
            .map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
        };
      }
      return {
        runs: tests.history.list().map((r) => ({
          run: r.id,
          ran: r.label,
          at: new Date(r.startedAt).toISOString(),
          durationMs: r.durationMs,
          counts: countsLabel(r),
          coverage: r.coverage,
          cancelled: r.cancelled,
          failed: r.results
            .filter((x) => x.status === "failed")
            .slice(0, 20)
            .map((x) => ({ id: x.id, name: x.name, file: x.file })),
        })),
      };
    },
  });

  register({
    id: "tests.rerunFromHistory",
    title: "Rerun a past test run",
    category: "Testing",
    description:
      "Runs again what a past run (tests.history's `run` id) ran: the same tests, file or all; with coverage if it had it. Needs a trusted folder.",
    input: s.object({ run: s.number().describe("Run id (tests.history)") }),
    effects: ["exec"],
    agent: "discoverable",
    run: async ({ run }) => {
      const past = tests.history.get(run);
      if (!past) throw new Error(`No run ${run} (tests.history lists them).`);
      const summary = await tests.run({ ...past.target, coverage: past.coverage });
      return {
        run: summary.runId,
        passed: summary.passed,
        failed: summary.failed,
        skipped: summary.skipped,
        cancelled: summary.cancelled,
      };
    },
  });

  register({
    id: "tests.clearHistory",
    title: "Clear test results",
    category: "Testing",
    description: "Forgets the past test runs (the Test results tab empties).",
    input: s.empty(),
    effects: [],
    agent: "hidden",
    run: () => {
      tests.history.clear();
      tests.historyChanged();
    },
  });

  /** Starts the debugger on a test (or a file's tests) with a configuration for its framework. */
  const debugTests = async (
    target: { test?: Discovered; file?: string },
    execute: (id: string, input: unknown) => Promise<unknown>,
  ) => {
    const root = workspace.root.peek();
    if (!root) throw new Error("Open a folder first.");
    const one = target.test ?? tests.tests.peek().find((t) => t.file === target.file);
    if (!one) throw new Error("No tests in that file.");
    const unsupported = debugUnsupported(one.framework);
    if (unsupported) throw new Error(unsupported);
    const local = (f: string) =>
      one.project && f.startsWith(`${one.project}/`) ? f.slice(one.project.length + 1) : f;
    const cwd = one.project ? workspace.resolve(one.project) : root;
    const pkg = debugPackage(one.framework);
    const nodeModules = pkg ? await tests.nodeModulesWith(one.project, pkg) : null;
    if (pkg && !nodeModules)
      throw new Error(`Debugging needs ${pkg} installed in the project (npm install).`);
    const configuration = debugConfiguration(
      {
        framework: one.framework,
        file: local(one.file),
        ...(target.test && { test: target.test }),
        cwd,
        ...(nodeModules && { nodeModules }),
      },
      services.platform === "windows",
    );
    if (!configuration) throw new Error(`Debugging ${one.framework} tests isn't supported.`);
    const started = (await execute("debug.start", { configuration })) as Record<string, unknown>;
    return { ...started, test: target.test?.id ?? null, file: one.file, configuration };
  };

  register({
    id: "tests.debug",
    title: "Debug test",
    category: "Testing",
    description:
      "Starts the debugger on one `test` (an id or name) or the tests in `file`: node:test, Jest and Mocha through Node's inspector, pytest and unittest through debugpy (pip install debugpy). Breakpoints in the test and the code it calls stop it. Needs a trusted folder.",
    input: s.object({
      test: s.string().describe("Test id (tests.list) or its name").optional(),
      file: s.string().describe("Workspace-relative test file").optional(),
    }),
    effects: ["exec"],
    agent: "discoverable",
    run: async ({ test, file }, ctx) => {
      await deps.ensureDiscovered();
      if (!test && !file) throw new Error("Give a test or a file.");
      return debugTests(
        test ? { test: deps.findTest(test, file) } : { file: rel(file ?? "") },
        ctx.execute,
      );
    },
  });

  register({
    id: "tests.debugAtCursor",
    title: "Debug test at cursor",
    category: "Testing",
    description: "Starts the debugger on the test the cursor is in (see tests.debug).",
    input: s.empty(),
    effects: ["exec"],
    agent: "hidden",
    run: async (_input, ctx) => {
      await deps.ensureDiscovered();
      const active = await deps.activeEditor();
      if (!active) throw new Error("Open a test file first.");
      const t = testAt(tests.tests.peek(), active.file, active.line);
      if (!t) throw new Error("There's no test at the cursor.");
      return ctx.execute("tests.debug", { test: t.id });
    },
  });

  register({
    id: "tests.debugFile",
    title: "Debug tests in current file",
    category: "Testing",
    description: "Starts the debugger on the active editor's tests (see tests.debug).",
    input: s.empty(),
    effects: ["exec"],
    agent: "hidden",
    run: async (_input, ctx) => {
      const active = await deps.activeEditor();
      if (!active) throw new Error("Open a test file first.");
      return ctx.execute("tests.debug", { file: active.file });
    },
  });
}
