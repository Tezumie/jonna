// Built-in Testing (D149), like VS Code's Test Explorer for the common frameworks: the Testing view
// (tests found from their files, run all / a file / a test / the failed ones / the one at the
// cursor, results and failure messages), each test's result in the editor's margin, a status bar
// summary, and the same for agents: `tests.run` returns what passed and what failed (with the
// messages) and `ide://tests` holds the tests and their last results.
import type { BuiltinExtension } from "../../core/extensions/index";
import { pathKey } from "../../core/paths/index";
import { effect, untracked } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { GutterMark } from "../../workbench/gutterMarks";
import type { WorkbenchServices } from "../../workbench/services";
import { ContinuousRun } from "./continuousRun";
import { type Discovered, type RunSummary, TestController } from "./controller";
import { hasPerTestCoverage } from "./coverage";
import { coverageSummary, registerCoverage } from "./coverageUi";
import manifest from "./extension.json";
import {
  cancelExtensionTests,
  extensionCoverageFiles,
  registerExtensionTestCommands,
  runAllExtensionTests,
} from "./extensionTestCommands";
import { FRAMEWORK_LABEL, FRAMEWORKS, type Framework, testAt } from "./model";
import { registerResults } from "./resultsUi";
import { TestingView } from "./view";

const MAX_LISTED = 500;

export const testingExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dispatcher, state, views, workspace, statusBar, gutterMarks, notifications, settings } =
      services;
    const tests = sub.add(new TestController(services));
    const continuous = sub.add(new ContinuousRun(services, tests));
    const register: typeof dispatcher.register = (c) =>
      sub.add(dispatcher.register({ category: "Testing", ...c }));
    let view: TestingView | undefined;
    let discovered = false;
    /** How tests were named when the folders last changed (or the workspace opened). */
    let naming = tests.naming();
    const ensureDiscovered = async () => {
      if (!discovered) {
        discovered = true;
        await tests.discover();
      }
    };

    sub.add(
      views.register({
        id: "testing.view",
        title: "Testing",
        icon: "flask-conical",
        command: "tests.showView",
        alwaysShowSetting: "testing.alwaysShow",
        actions: [
          { command: "tests.runAll", icon: "play", title: "Run all tests" },
          { command: "tests.runFailed", icon: "rotate-ccw", title: "Rerun failed tests" },
          {
            command: "tests.runAllWithCoverage",
            icon: "shield",
            title: "Run all tests with coverage",
          },
          { command: "tests.cancel", icon: "square", title: "Stop the test run" },
          { command: "tests.refresh", icon: "refresh-cw", title: "Refresh tests" },
          { command: "tests.showResults", icon: "history", title: "Show test results" },
          { command: "tests.showOutput", icon: "square-terminal", title: "Show test output" },
        ],
        create(host) {
          view = new TestingView(host, services, tests, continuous);
          void ensureDiscovered();
          return view;
        },
      }),
    );

    // The activity bar shows Testing once the folder has tests (VS Code shows it once a test
    // extension finds some), or always with testing.alwaysShow.
    sub.add(
      effect(() => {
        settings.version.value;
        const always = settings.peek<boolean>("testing.alwaysShow") === true;
        // Extensions' test controllers count too.
        const fromExtensions = services.extensionFeatures.tests.all.value.length > 0;
        views.setAvailable(
          "testing.view",
          always || tests.tests.value.length > 0 || fromExtensions,
        );
        return undefined;
      }),
    );
    sub.add({ dispose: () => views.setAvailable("testing.view", true) });

    // A folder opens: find its tests (or wait for the view).
    sub.add(
      effect(() => {
        const root = workspace.root.value;
        discovered = false;
        continuous.reset();
        tests.tests.value = [];
        tests.results.value = new Map();
        tests.summary.value = null;
        tests.coverage.value = null;
        naming = untracked(() => tests.naming());
        // The folder's kept results, history and coverage (D209, testing.keepResults).
        queueMicrotask(() => void tests.restoreKept(root).catch(() => {}));
        if (root && services.settings.peek<boolean | undefined>("testing.discoverOnOpen") !== false)
          setTimeout(() => {
            if (workspace.root.peek() === root) void ensureDiscovered();
          }, 1500);
        return undefined;
      }),
    );

    // Folders added to or taken out of a multi-root workspace (D251): found again (the removed
    // folder's tests and results go; the added folder's are found). Going from one folder to
    // several (or back), or renaming one, names test files and ids anew: the last results and
    // the history are renamed with them.
    sub.add(
      workspace.onDidChangeFolders(({ removed }) => {
        const before = naming;
        naming = tests.naming();
        tests.rename(before, naming);
        if (removed.length) {
          const gone = (file: string) =>
            removed.some((f) => file === f.name || file.startsWith(`${f.name}/`));
          tests.tests.value = tests.tests.peek().filter((t) => !gone(t.file));
        }
        if (discovered) void tests.discover().catch(() => {});
      }),
    );

    // Test files changed on disk or saved: their tests again.
    let pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    sub.add({ dispose: () => clearTimeout(timer) });
    sub.add(
      services.events.on("files.didChange", ({ path }) => {
        if (!path) return;
        pending.add(path);
        clearTimeout(timer);
        timer = setTimeout(() => {
          const paths = pending;
          pending = new Set();
          for (const p of paths) void tests.rediscoverFile(p);
        }, 400);
      }),
    );

    // Results in the margin of open files.
    sub.add(
      effect(() => {
        const list = tests.tests.value;
        const results = tests.results.value;
        const enabled = services.settings.get<boolean | undefined>("testing.gutterMarks") !== false;
        const root = workspace.root.peek();
        const byPath = new Map<string, GutterMark[]>();
        if (enabled && root)
          for (const t of list) {
            const r = results.get(t.id);
            if (!r || r.status === "running") continue;
            // With several folders the file starts with its folder's name (D251).
            const key = pathKey(workspace.resolve(t.file));
            const marks = byPath.get(key) ?? [];
            marks.push({
              line: t.line,
              className: `test-glyph is-${r.status}`,
              hover:
                r.status === "failed"
                  ? `Failed: ${("message" in r && r.message ? r.message : "").split("\n").slice(0, 8).join("\n")}`
                  : r.status === "passed"
                    ? `Passed${"durationMs" in r && r.durationMs !== undefined ? ` (${r.durationMs} ms)` : ""}`
                    : "Skipped",
            });
            byPath.set(key, marks);
          }
        gutterMarks.set("testing", byPath);
        return undefined;
      }),
    );

    // Status bar: the last run's counts (click: the view).
    sub.add(
      statusBar.add({
        id: "tests.status",
        name: "Tests",
        alignment: "left",
        priority: 70,
        text: () => {
          // Continuous run on: an eye in front (VS Code shows it in the Testing view).
          const watching =
            continuous.all.value || continuous.files.value.size || continuous.tests.value.size
              ? "$(eye) "
              : "";
          if (tests.running.value) return `${watching}$(refresh-cw) Testing…`;
          const s = tests.summary.value;
          if (!s) return watching ? `${watching}Continuous run` : "";
          return `${watching}$(circle-check) ${s.passed} $(circle-x) ${s.failed}`;
        },
        tooltip: () => {
          const s = tests.summary.value;
          const watching = continuous.isOn() ? " · Continuous run is on" : "";
          return tests.running.value
            ? `Running ${tests.running.value}`
            : s
              ? `Tests: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped${watching} · Show testing`
              : `Show testing${watching}`;
        },
        command: "tests.showView",
      }),
    );

    // As test files are named: with several folders, the folder's name first (D251).
    const rel = (path: string) =>
      workspace.root.peek() && workspace.contains(path)
        ? workspace.relative(path)
        : path.replace(/\\/g, "/");
    const activeEditor = async (): Promise<{ file: string; line: number } | null> => {
      const snap = await state.get("ide://editors/active").catch(() => null);
      const v = snap?.value as { absolutePath?: string | null; cursor?: { line: number } } | null;
      return v?.absolutePath ? { file: rel(v.absolutePath), line: v.cursor?.line ?? 1 } : null;
    };

    /** What a run gives back to callers (and agents): counts, failures with messages. */
    const report = (summary: RunSummary, ran: (t: Discovered) => boolean, withCoverage = false) => {
      const results = tests.results.peek();
      const failures = tests.tests
        .peek()
        .filter((t) => ran(t) && results.get(t.id)?.status === "failed")
        .slice(0, 50)
        .map((t) => {
          const r = results.get(t.id);
          const done = r && r.status !== "running" ? r : undefined;
          const message = done?.message ?? "";
          const cut = (v: string) => (v.length > 1500 ? `${v.slice(0, 1500)}…` : v);
          return {
            id: t.id,
            file: t.file,
            line: t.line,
            name: t.path.join(" › "),
            message: cut(message),
            ...(done?.expected !== undefined && {
              expected: cut(done.expected),
              actual: cut(done.actual ?? ""),
            }),
          };
        });
      const cov = tests.coverage.peek();
      return {
        ...(summary.runId !== undefined && { run: summary.runId }),
        passed: summary.passed,
        failed: summary.failed,
        skipped: summary.skipped,
        durationMs: summary.durationMs,
        cancelled: summary.cancelled,
        commands: summary.commands,
        notes: summary.notes,
        failures,
        ...(withCoverage && cov && { coverage: coverageSummary(cov, 20) }),
        ...(tests.fileErrors.peek().size && {
          filesFailedToLoad: [...tests.fileErrors.peek()].map(([file, message]) => ({
            file,
            message: message.slice(0, 1500),
          })),
        }),
      };
    };
    const announce = (summary: RunSummary, user: boolean) => {
      if (!user) return;
      // The Testing view on screen already shows it.
      if (views.active.peek() === "testing.view" && services.layout.sidebarVisible.peek()) return;
      if (summary.cancelled) notifications.show("info", "Test run stopped.");
      else if (summary.failed)
        notifications.show(
          "error",
          `${summary.failed} test${summary.failed === 1 ? "" : "s"} failed, ${summary.passed} passed.`,
          {
            actions: [
              { label: "Show testing", run: () => void dispatcher.execute("tests.showView", {}) },
            ],
          },
        );
    };

    register({
      id: "tests.showView",
      title: "Show testing",
      description: "Shows the Testing view (the workspace's tests and their last results).",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: async (_input, ctx) => {
        await ctx.execute("view.show", { id: "testing.view" });
        view?.focus();
      },
    });

    register({
      id: "tests.refresh",
      title: "Refresh tests",
      description:
        "Finds the workspace's tests again (Vitest, Jest, node:test, pytest, cargo test, go test, from their files). Returns how many and the frameworks.",
      input: s.empty(),
      effects: ["read"],
      agent: "discoverable",
      run: async () => {
        discovered = true;
        const count = await tests.discover();
        const frameworks = [...new Set(tests.tests.peek().map((t) => t.framework))];
        return { tests: count, frameworks };
      },
    });

    register({
      id: "tests.list",
      title: "List tests",
      description:
        "The workspace's tests (file, line, name, framework, last status), optionally only those in `file` or with `status`.",
      input: s.object({
        file: s.string().describe("Workspace-relative file").optional(),
        status: s.enum(["passed", "failed", "skipped", "unknown"] as const).optional(),
      }),
      effects: ["read"],
      agent: "discoverable",
      run: async ({ file, status }) => {
        await ensureDiscovered();
        const list = tests.tests
          .peek()
          .filter(
            (t) => (!file || t.file === rel(file)) && (!status || tests.status(t.id) === status),
          );
        return {
          total: list.length,
          tests: list.slice(0, MAX_LISTED).map((t) => ({
            id: t.id,
            file: t.file,
            line: t.line,
            name: t.path.join(" › "),
            framework: t.framework,
            status: tests.status(t.id),
          })),
        };
      },
    });

    /** A test by id, or by its name (in `file`). */
    const findTest = (test: string, file?: string): Discovered => {
      const all = tests.tests.peek();
      const found =
        all.find((t) => t.id === test) ??
        all.find(
          (t) =>
            (t.path.join(" › ") === test || t.path.at(-1) === test) &&
            (!file || t.file === rel(file)),
        );
      if (!found) throw new Error(`No test "${test}" (tests.list shows them).`);
      return found;
    };

    /** tests.run and tests.runWithCoverage: what to run, then the report. */
    const runTests = async (
      input: { file?: string; test?: string; framework?: string; project?: string },
      coverage: boolean,
      user: boolean,
    ) => {
      const { file, test, framework, project } = input;
      await ensureDiscovered();
      const testId = test ? findTest(test, file).id : undefined;
      let summary: RunSummary;
      let ran: (t: Discovered) => boolean;
      if (framework && !file && !testId) {
        // One framework's tests: its files, one batch per project.
        const fw = framework as Framework;
        ran = (t) => t.framework === fw && (project === undefined || t.project === project);
        const files = [
          ...new Set(
            tests.tests
              .peek()
              .filter(ran)
              .map((t) => t.file),
          ),
        ];
        if (!files.length) throw new Error(`No ${fw} tests found.`);
        summary = await tests.run({
          files,
          label: `${FRAMEWORK_LABEL[fw]} tests${project ? ` (${project})` : ""}`,
          coverage,
        });
      } else {
        const target = { ...(file && { file: rel(file) }), ...(testId && { testId }) };
        ran = (t) =>
          (!target.testId || t.id === target.testId) && (!target.file || t.file === target.file);
        summary = await tests.run({ ...target, coverage });
      }
      announce(summary, user);
      return report(summary, ran, coverage);
    };
    const runInput = s.object({
      file: s.string().describe("Workspace-relative (or absolute) test file").optional(),
      test: s.string().describe("Test id (tests.list) or its name").optional(),
      framework: s.enum(FRAMEWORKS).optional(),
      project: s.string().describe("With framework: the project folder (relative)").optional(),
    });

    register({
      id: "tests.run",
      title: "Run tests",
      description:
        "Runs the workspace's tests with their own framework (Vitest, Jest, node:test, Mocha, Playwright, pytest, unittest, cargo test, go test): all of them, those in `file`, one `test` (an id from tests.list, or a name), or a `framework`'s. Returns passed / failed / skipped counts and each failure's file, line, name, message (and expected / actual when the assertion reported them). Needs a trusted folder.",
      input: runInput,
      effects: ["exec"],
      agent: "discoverable",
      run: (input, ctx) => runTests(input, false, ctx.caller.kind === "user"),
    });

    register({
      id: "tests.runAll",
      title: "Run all tests",
      description:
        "Runs every test in the workspace (see tests.run), and extensions' tests (tests.runExtension).",
      input: s.empty(),
      effects: ["exec"],
      agent: "hidden",
      run: async (_input, ctx) => {
        // Extensions' controllers run beside the built-in frameworks (VS Code's Run all).
        const extensions = services.extensionFeatures.tests.all.peek().length
          ? runAllExtensionTests(services)
          : null;
        try {
          const own = await ctx.execute("tests.run", {});
          return extensions ? { ...(own as object), extensions: await extensions } : own;
        } catch (err) {
          if (!extensions) throw err;
          return {
            extensions: await extensions,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    });

    register({
      id: "tests.runFailed",
      title: "Rerun failed tests",
      description: "Runs again the tests that failed last time.",
      input: s.empty(),
      effects: ["exec"],
      agent: "discoverable",
      run: async (_input, ctx) => {
        const summary = await tests.run({ failedOnly: true });
        announce(summary, ctx.caller.kind === "user");
        return report(summary, () => true);
      },
    });

    register({
      id: "tests.runFile",
      title: "Run tests in current file",
      description: "Runs the tests in the active editor's file.",
      input: s.empty(),
      effects: ["exec"],
      agent: "hidden",
      run: async (_input, ctx) => {
        const active = await activeEditor();
        if (!active) throw new Error("Open a test file first.");
        return ctx.execute("tests.run", { file: active.file });
      },
    });

    register({
      id: "tests.runAtCursor",
      title: "Run test at cursor",
      description: "Runs the test the cursor is in (the nearest one above it in the active file).",
      input: s.empty(),
      effects: ["exec"],
      agent: "hidden",
      run: async (_input, ctx) => {
        await ensureDiscovered();
        const active = await activeEditor();
        if (!active) throw new Error("Open a test file first.");
        const t = testAt(tests.tests.peek(), active.file, active.line);
        if (!t) throw new Error("There's no test at the cursor.");
        return ctx.execute("tests.run", { test: t.id });
      },
    });

    register({
      id: "tests.toggleContinuousRun",
      title: "Toggle continuous run",
      description:
        "Turns continuous run on or off (VS Code's): while on, saving a file runs the tests it affects again (a test file its own tests; a source file the tests named after it, e.g. util.ts → util.test.ts, else its project's tests). Without `file` / `test` it's for every test; with one, for that test file or test only. `on` sets it instead of toggling. Runs never overlap; turning it off stops a run it started. Needs a trusted folder.",
      input: s.object({
        file: s.string().describe("Workspace-relative test file").optional(),
        test: s.string().describe("Test id (tests.list)").optional(),
        on: s.boolean().describe("On (true) or off (false) instead of toggling").optional(),
      }),
      effects: ["exec"],
      agent: "discoverable",
      run: async ({ file, test, on }) => {
        await ensureDiscovered();
        if (test && !tests.tests.peek().some((t) => t.id === test))
          throw new Error(`No test "${test}" (tests.list shows them).`);
        const scope = { ...(file && { file: rel(file) }), ...(test && { test }) };
        const turningOn =
          on ??
          (scope.test
            ? !continuous.tests.peek().has(scope.test)
            : scope.file
              ? !continuous.files.peek().has(scope.file)
              : !continuous.all.peek());
        // Runs start on saves, unasked: the folder is trusted first.
        if (turningOn) await services.trust.require("Continuous test runs");
        const nowOn = continuous.set(scope, turningOn);
        return { on: nowOn, ...continuousState() };
      },
    });

    register({
      id: "tests.stopContinuousRun",
      title: "Turn off all continuous runs",
      description: "Turns continuous run off for every test, file and test it was on for.",
      input: s.empty(),
      effects: [],
      agent: "discoverable",
      run: () => {
        continuous.stopAll();
        return continuousState();
      },
    });

    register({
      id: "tests.cancel",
      title: "Stop the test run",
      description: "Stops the running tests.",
      input: s.empty(),
      effects: [],
      agent: "discoverable",
      run: () => ({ stopped: tests.cancel(), extensions: cancelExtensionTests(services) }),
    });

    register({
      id: "tests.showOutput",
      title: "Show test output",
      description:
        "Opens the last test run's output (commands and what they printed) in a read-only tab.",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: (_input, ctx) =>
        ctx.execute("editor.openReadOnly", {
          title: "Test output",
          content: tests.output || "No test run yet.",
          panel: true,
        }),
    });

    register({
      id: "tests.showMessage",
      title: "Show a test's failure",
      description: "Opens a failed test's whole message in a read-only tab.",
      input: s.object({ id: s.string() }),
      effects: [],
      agent: "hidden",
      run: (input, ctx) => {
        const t = tests.tests.peek().find((x) => x.id === input.id);
        const r = tests.results.peek().get(input.id);
        const message = r && "message" in r ? (r.message ?? "") : "";
        return ctx.execute("editor.openReadOnly", {
          title: `${t?.path.at(-1) ?? "Test"} (failed)`,
          content: `${t ? `${t.path.join(" › ")}\n${t.file}:${t.line}\n\n` : ""}${message}`,
        });
      },
    });

    registerCoverage({ sub, services, tests, register, rel, runTests });
    registerExtensionTestCommands(sub, services, register);
    // An extension's coverage run (D255): when it ends with coverage, the Testing view shows it
    // like a built-in framework's (the gutter, the coverage view and toolbar).
    const shownCoverage = new WeakSet<object>();
    sub.add(
      effect(() => {
        for (const c of services.extensionFeatures.tests.all.value) {
          const files = c.coverage.value;
          if (c.running.value || !files.length || shownCoverage.has(files)) continue;
          shownCoverage.add(files);
          untracked(() => {
            tests.coverage.value = {
              files: extensionCoverageFiles(files),
              finishedAt: Date.now(),
              label: c.label,
              problems: [],
            };
            tests.coverageTest.value = null;
          });
        }
        return undefined;
      }),
    );
    registerResults({
      sub,
      services,
      tests,
      register,
      rel,
      ensureDiscovered,
      findTest,
      activeEditor,
    });

    function continuousState() {
      const last = continuous.last;
      return {
        all: continuous.all.peek(),
        files: [...continuous.files.peek()],
        tests: [...continuous.tests.peek()],
        runs: continuous.runs.peek(),
        ...(last && {
          lastRun: {
            at: new Date(last.at).toISOString(),
            targets: last.targets,
            ...(last.summary && {
              passed: last.summary.passed,
              failed: last.summary.failed,
              cancelled: last.summary.cancelled,
            }),
          },
        }),
      };
    }

    sub.add(
      state.register("ide://tests", {
        description:
          "The workspace's tests (found from their files) and their last results: frameworks, counts, the running label, failures with messages (comparable: expected / actual values to diff), the last coverage run (totals, least covered files and their uncovered lines), the last 10 runs, up to 500 tests (file, line, name, status), and continuous run (on for all, files, tests; runs started, the last one).",
        get: () => {
          const list = tests.tests.peek();
          const results = tests.results.peek();
          const counts = { passed: 0, failed: 0, skipped: 0, unknown: 0 };
          for (const t of list) {
            const st = tests.status(t.id);
            if (st === "running") continue;
            counts[st]++;
          }
          const summary = tests.summary.peek();
          return {
            frameworks: [...new Set(list.map((t) => t.framework))],
            total: list.length,
            ...counts,
            running: tests.running.peek(),
            continuous: continuousState(),
            lastRun: summary
              ? {
                  durationMs: summary.durationMs,
                  finishedAt: new Date(summary.finishedAt).toISOString(),
                  commands: summary.commands,
                  cancelled: summary.cancelled,
                }
              : null,
            failures: list
              .filter((t) => results.get(t.id)?.status === "failed")
              .slice(0, 30)
              .map((t) => {
                const r = results.get(t.id);
                const message = r && "message" in r ? (r.message ?? "") : "";
                return {
                  id: t.id,
                  file: t.file,
                  line: t.line,
                  name: t.path.join(" › "),
                  message: message.slice(0, 800),
                  ...(r && "expected" in r && r.expected !== undefined && { comparable: true }),
                };
              }),
            coverage: (() => {
              const cov = tests.coverage.peek();
              if (!cov) return null;
              // Per-test coverage (D233): whether the report has it and which test is shown.
              const test = tests.coverageTest.peek();
              return {
                ...coverageSummary(cov, 30),
                perTest: hasPerTestCoverage(cov.files),
                shownTest: test ? test.label : null,
              };
            })(),
            history: tests.history
              .list()
              .slice(0, 10)
              .map((r) => ({
                run: r.id,
                ran: r.label,
                at: new Date(r.startedAt).toISOString(),
                passed: r.passed,
                failed: r.failed,
                skipped: r.skipped,
                durationMs: r.durationMs,
                coverage: r.coverage,
              })),
            tests: list.slice(0, MAX_LISTED).map((t) => ({
              file: t.file,
              line: t.line,
              name: t.path.join(" › "),
              framework: t.framework,
              status: tests.status(t.id),
            })),
          };
        },
      }),
    );
  },
};
