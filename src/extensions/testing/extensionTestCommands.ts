// Commands and state for extensions' test controllers (D247, workbench/extensionTests.ts): run a
// controller's tests (all, or an item and what's under it) with its Run or Debug profile, stop
// them, and `ide://tests/extensions` (the controllers, their tests and last results). The Testing
// view's rows run these; agents can too.
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import {
  type ExtFileCoverage,
  type ExtTestController,
  type ExtTestProfileKind,
  profileFor,
  testLeaves,
} from "../../workbench/extensionTests";
import type { WorkbenchServices } from "../../workbench/services";
import type { FileCoverage } from "./coverage";

/** Leaves listed per controller in state and results. */
const MAX_LISTED = 500;

/** What a run of extension tests left: counts and the failures, over the leaves it covered. */
export function extensionRunReport(c: ExtTestController, wid: string | null) {
  const results = c.results.peek();
  const leaves = testLeaves(c.items.peek(), wid);
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: { item: string; test: string; message?: string; path?: string; line?: number }[] =
    [];
  for (const leaf of leaves) {
    const r = results.get(leaf.wid);
    if (r?.status === "passed") passed++;
    else if (r?.status === "skipped") skipped++;
    else if (r?.status === "failed") {
      failed++;
      if (failures.length < 50)
        failures.push({
          item: leaf.wid,
          test: leaf.label,
          ...(r.message && { message: r.message.slice(0, 2000) }),
          ...(r.location && { failedAt: `${r.location.path}:${r.location.line}` }),
          ...(leaf.path && { path: leaf.path }),
          ...(leaf.line && { line: leaf.line }),
        });
    }
  }
  return {
    controller: c.key,
    label: c.label,
    tests: leaves.length,
    passed,
    failed,
    skipped,
    failures,
  };
}

/** Runs every controller that has a profile of `kind` (Run all tests). */
export async function runAllExtensionTests(
  services: WorkbenchServices,
  kind: ExtTestProfileKind = "run",
): Promise<ReturnType<typeof extensionRunReport>[]> {
  const controllers = services.extensionFeatures.tests.all
    .peek()
    .filter((c) => profileFor(c.profiles.peek(), kind));
  await Promise.all(controllers.map((c) => c.run(kind).catch(() => {})));
  return controllers.map((c) => extensionRunReport(c, null));
}

/** Stops every extension test run under way; how many controllers were running. */
export function cancelExtensionTests(services: WorkbenchServices): number {
  let n = 0;
  for (const c of services.extensionFeatures.tests.all.peek())
    if (c.running.peek()) {
      c.cancel();
      n++;
    }
  return n;
}

export function registerExtensionTestCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  register: WorkbenchServices["dispatcher"]["register"],
): void {
  const registry = services.extensionFeatures.tests;
  const find = (key: string) => {
    const c = registry.all.peek().find((x) => x.key === key || x.id === key);
    if (!c) throw new Error(`No extension test controller ${key} (see ide://tests/extensions).`);
    return c;
  };

  register({
    id: "tests.runExtension",
    title: "Run an extension's tests",
    description:
      "Runs tests an extension found (its test controller, as in VS Code): every controller's, one `controller`'s (its key from ide://tests/extensions), or one `item` of it and what's under it, with its Run profile or `profile: \"debug\"`. Returns passed / failed / skipped counts and the failures' messages once the extension's run handler is done.",
    input: s.object({
      controller: s
        .string()
        .describe('A controller\'s key, "<extension id>/<controller id>" (ide://tests/extensions)')
        .optional(),
      item: s.string().describe("An item's id in that controller (`wid` in the state)").optional(),
      profile: s
        .enum(["run", "debug", "coverage"] as const)
        .describe('Which of its run profiles (default "run")')
        .optional(),
    }),
    effects: ["exec"],
    agent: "discoverable",
    run: async ({ controller, item, profile }) => {
      const kind = profile ?? "run";
      if (!controller) {
        if (item) throw new Error("Name the item's controller too.");
        const reports = await runAllExtensionTests(services, kind);
        if (!reports.length) throw new Error(`No extension test controller has a ${kind} profile.`);
        return { runs: reports };
      }
      const c = find(controller);
      if (item && !c.items.peek().some((i) => i.wid === item))
        throw new Error(`${c.label} has no item ${item}.`);
      await c.run(kind, item ? [item] : undefined);
      return extensionRunReport(c, item ?? null);
    },
  });

  register({
    id: "tests.cancelExtension",
    title: "Stop an extension's test run",
    description: "Stops the extension test runs under way (their cancellation token).",
    input: s.empty(),
    effects: [],
    agent: "discoverable",
    run: () => ({ stopped: cancelExtensionTests(services) }),
  });

  sub.add(
    services.state.register("ide://tests/extensions", {
      description:
        "Extensions' test controllers (VS Code's test API): each one's key, label, run profiles, whether it's running, its tests (wid, parent, label, file, line, last status and failure message; 500 at most) and the end of its runs' output.",
      get: () =>
        registry.all.peek().map((c) => {
          const results = c.results.peek();
          const items = c.items.peek();
          return {
            key: c.key,
            owner: c.owner,
            label: c.label,
            running: c.running.peek(),
            profiles: c.profiles.peek(),
            tests: items.length,
            items: items.slice(0, MAX_LISTED).map((i) => {
              const r = results.get(i.wid);
              return {
                wid: i.wid,
                parent: i.parent,
                label: i.label,
                ...(i.path && { path: i.path }),
                ...(i.line && { line: i.line }),
                ...(r && { status: r.status }),
                ...(r?.message && { message: r.message.slice(0, 1000) }),
                ...(r?.location && { failedAt: `${r.location.path}:${r.location.line}` }),
                ...(i.error && { error: i.error }),
              };
            }),
            output: c.output().slice(-8000),
          };
        }),
    }),
  );
}

/**
 * An extension's coverage run as the Testing view's coverage (D255): its controller's files (from
 * run.addCoverage) in the shape the built-in frameworks' reports have.
 */
export function extensionCoverageFiles(files: readonly ExtFileCoverage[]): FileCoverage[] {
  return files.map((f) => {
    const branches = new Map<number, { covered: number; total: number }>();
    for (const [line, taken, total] of f.branches ?? [])
      branches.set(line, { covered: taken, total });
    const functions = f.functions ?? [];
    return {
      file: f.file,
      lines: new Map(f.lines),
      branches,
      functions: { covered: functions.filter((x) => x.hits > 0).length, total: functions.length },
      ...(functions.length && {
        declarations: functions.map((x) => ({ name: x.name, line: x.line, hits: x.hits })),
      }),
    };
  });
}
