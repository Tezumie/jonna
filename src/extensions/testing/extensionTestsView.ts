// Extensions' tests in the Testing view (VS Code's test controllers, D247; workbench/extensionTests.ts):
// one group per controller, under it the extension's items as it nests them, each with its last
// result. Opening an item that can resolve children asks the extension for them. Rows run
// `tests.runExtension` (Run, and Debug when the controller has a debug profile); a test with a
// file opens it at its line. view.ts draws these rows beside the built-in frameworks' groups.
import { h, replaceChildren } from "../../core/dom/index";
import type { IconName } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import {
  type ExtTestController,
  type ExtTestItem,
  type ExtTestStatus,
  profileFor,
  rollUpStatus,
  testChildren,
  testLeaves,
} from "../../workbench/extensionTests";
import type { WorkbenchServices } from "../../workbench/services";
import type { TestStatus } from "./model";

export type ExtNode =
  | { kind: "extController"; key: string }
  | { kind: "extItem"; key: string; wid: string };

/** What view.ts lends the rows (its buttons and status icons). */
export interface RowKit {
  chevron(has: boolean): Element;
  statusIcon(status: TestStatus): Element;
  action(name: IconName, title: string, command: string, input: unknown): HTMLElement;
}

const STATUS: Record<ExtTestStatus | "unknown", TestStatus> = {
  queued: "running",
  running: "running",
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  unknown: "unknown",
};

export class ExtensionTestRows {
  /**
   * The items (wid, "" for the top) each controller was asked about: once each, as in VS Code (a
   * handler that finds nothing, or only flips `busy`, isn't asked again on every redraw). Per
   * controller object: a reloaded extension's new controller is asked again.
   */
  private readonly resolved = new WeakMap<ExtTestController, Set<string>>();

  constructor(private readonly services: WorkbenchServices) {}

  private get controllers(): readonly ExtTestController[] {
    return this.services.extensionFeatures.tests.all.peek();
  }

  private controller(key: string): ExtTestController | undefined {
    return this.controllers.find((c) => c.key === key);
  }

  /** Reads every signal the rows show (view.ts's effect redraws on changes). */
  track(): void {
    for (const c of this.services.extensionFeatures.tests.all.value) {
      c.items.value;
      c.results.value;
      c.running.value;
      c.profiles.value;
    }
  }

  /** Whether any controller is there (the empty state hides, the activity bar shows Testing). */
  any(): boolean {
    return this.controllers.length > 0;
  }

  /** Counts of the leaves' last results, for the summary line. */
  counts(): { passed: number; failed: number; skipped: number; total: number } {
    const out = { passed: 0, failed: 0, skipped: 0, total: 0 };
    for (const c of this.controllers) {
      const results = c.results.peek();
      for (const leaf of testLeaves(c.items.peek(), null)) {
        out.total++;
        const s = results.get(leaf.wid)?.status;
        if (s === "passed") out.passed++;
        else if (s === "failed") out.failed++;
        else if (s === "skipped") out.skipped++;
      }
    }
    return out;
  }

  running(): string | null {
    return this.controllers.find((c) => c.running.peek())?.label ?? null;
  }

  id(n: ExtNode): string {
    return n.kind === "extController" ? `x:${n.key}` : `x:${n.key}:${n.wid}`;
  }

  roots(filter: string, failedOnly: boolean): ExtNode[] {
    return this.controllers
      .filter((c) => !(filter || failedOnly) || this.shown(c, null, filter, failedOnly))
      .map((c) => ({ kind: "extController" as const, key: c.key }));
  }

  hasChildren(n: ExtNode): boolean {
    const c = this.controller(n.key);
    if (!c) return false;
    if (n.kind === "extController") return true;
    const item = c.items.peek().find((i) => i.wid === n.wid);
    return !!item && (item.canResolveChildren || c.items.peek().some((i) => i.parent === n.wid));
  }

  async children(n: ExtNode, filter: string, failedOnly: boolean): Promise<ExtNode[]> {
    const c = this.controller(n.key);
    if (!c) return [];
    const parent = n.kind === "extController" ? null : n.wid;
    let items = testChildren(c.items.peek(), parent);
    // Not loaded yet: the extension finds them now (VS Code's resolveHandler).
    const resolvable =
      parent === null ? c.resolvable.peek() : this.item(c, parent)?.canResolveChildren;
    let asked = this.resolved.get(c);
    if (!asked) {
      asked = new Set();
      this.resolved.set(c, asked);
    }
    if (!items.length && resolvable && !asked.has(parent ?? "")) {
      asked.add(parent ?? "");
      await c.resolve(parent ?? undefined).catch((err: unknown) => this.error(err));
      items = testChildren(c.items.peek(), parent);
    }
    return items
      .filter((i) => !(filter || failedOnly) || this.shown(c, i.wid, filter, failedOnly))
      .map((i) => ({ kind: "extItem" as const, key: c.key, wid: i.wid }));
  }

  /** A leaf under `wid` passes the filter (its label or file) and "failed only". */
  private shown(
    c: ExtTestController,
    wid: string | null,
    filter: string,
    failedOnly: boolean,
  ): boolean {
    const results = c.results.peek();
    return testLeaves(c.items.peek(), wid).some(
      (leaf) =>
        (!failedOnly || results.get(leaf.wid)?.status === "failed") &&
        (!filter || `${leaf.label} ${leaf.path ?? ""}`.toLowerCase().includes(filter)),
    );
  }

  private item(c: ExtTestController, wid: string): ExtTestItem | undefined {
    return c.items.peek().find((i) => i.wid === wid);
  }

  /** A click on a row: a test with a file opens there; a failed one where it failed (D264). */
  open(n: ExtNode): void {
    if (n.kind !== "extItem") return;
    const c = this.controller(n.key);
    const item = c && this.item(c, n.wid);
    const failedAt = c?.results.peek().get(n.wid)?.location;
    if (failedAt) {
      this.run("editor.openFile", { path: failedAt.path, line: failedAt.line });
      return;
    }
    if (!item?.path) return;
    this.run("editor.openFile", { path: item.path, ...(item.line && { line: item.line }) });
  }

  render(n: ExtNode, row: HTMLElement, kit: RowKit): void {
    const c = this.controller(n.key);
    if (!c) {
      replaceChildren(row);
      return;
    }
    const results = c.results.peek();
    const items = c.items.peek();
    const debug = !!profileFor(c.profiles.peek(), "debug");
    const canRun = !!profileFor(c.profiles.peek(), "run");
    // A coverage profile (D255): its run's coverage shows like a built-in framework's.
    const coverage = !!profileFor(c.profiles.peek(), "coverage");
    const buttons = (input: Record<string, unknown>, what: string) =>
      h(
        "span",
        { class: "test-row-actions" },
        ...(coverage
          ? [
              kit.action("shield", `Run ${what} with coverage`, "tests.runExtension", {
                ...input,
                profile: "coverage",
              }),
            ]
          : []),
        ...(debug
          ? [
              kit.action("bug-play", `Debug ${what}`, "tests.runExtension", {
                ...input,
                profile: "debug",
              }),
            ]
          : []),
        ...(canRun ? [kit.action("play", `Run ${what}`, "tests.runExtension", input)] : []),
      );
    if (n.kind === "extController") {
      const leaves = testLeaves(items, null).map((l) => l.wid);
      const status = c.running.peek() ? "running" : rollUpStatus(results, leaves);
      setTooltip(row, `${c.label} (an extension's tests)`, undefined, { placement: "right" });
      replaceChildren(
        row,
        kit.chevron(true),
        kit.statusIcon(STATUS[status]),
        h("span", { class: "test-name is-group" }, c.label),
        buttons({ controller: c.key }, `${c.label} tests`),
        h("span", { class: "search-count" }, String(leaves.length)),
      );
      return;
    }
    const item = this.item(c, n.wid);
    if (!item) {
      replaceChildren(row);
      return;
    }
    const isLeaf = !items.some((i) => i.parent === item.wid) && !item.canResolveChildren;
    const r = results.get(item.wid);
    const status: TestStatus = item.busy
      ? "running"
      : item.error
        ? "failed"
        : isLeaf
          ? STATUS[r?.status ?? "unknown"]
          : STATUS[
              rollUpStatus(
                results,
                testLeaves(items, item.wid).map((l) => l.wid),
              )
            ];
    const duration = isLeaf && r?.durationMs !== undefined ? `${r.durationMs} ms` : "";
    const lines = [
      item.label,
      ...(item.error ? [item.error] : []),
      ...(isLeaf && r?.message ? [r.message.split("\n").slice(0, 6).join("\n")] : []),
      ...(item.path ? [`${item.path}${item.line ? `:${item.line}` : ""}`] : []),
    ];
    setTooltip(row, lines.join("\n"), undefined, { placement: "right" });
    replaceChildren(
      row,
      kit.chevron(this.hasChildren(n)),
      kit.statusIcon(status),
      h("span", { class: "test-name" }, item.label),
      h("span", { class: "test-meta" }, duration || item.description || ""),
      buttons({ controller: c.key, item: item.wid }, isLeaf ? "this test" : "these tests"),
    );
  }

  private run(command: string, input: unknown): void {
    void this.services.dispatcher.execute(command, input).catch((err: unknown) => this.error(err));
  }

  private error(err: unknown): void {
    this.services.notifications.show("error", err instanceof Error ? err.message : String(err));
  }
}
