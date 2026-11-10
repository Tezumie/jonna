// The Test results tab (D204), like VS Code's Test Results view: the last runs, newest first (what
// ran, counts, how long, when), each opening to its tests (failed first) with their result and
// duration. Hover: rerun a run, open a test, compare a failure's expected and actual values.
// Selecting a test shows its own output beside the runs (D209: what its framework printed for
// it, else its message), as VS Code's results view does. Kept across reloads (D209). Every
// action is a tests.* command.
import { h, replaceChildren } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { type IconName, icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import { Tree } from "../../ui/Tree";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { ansiNodes } from "../editor/notebook/ansi";
import type { TestController } from "./controller";
import {
  countsLabel,
  durationLabel,
  type HistoryResult,
  type HistoryStatus,
  outputPaneText,
  type RunRecord,
} from "./history";

type Node =
  | { kind: "root" }
  | { kind: "run"; run: RunRecord }
  | { kind: "result"; run: RunRecord; result: HistoryResult };

const STATUS_ICON: Record<HistoryStatus, IconName> = {
  passed: "circle-check",
  failed: "circle-x",
  skipped: "circle-minus",
};

export function resultsViewDescriptor(
  services: WorkbenchServices,
  tests: TestController,
): DockViewDescriptor {
  return {
    type: "testResults",
    title: () => "Test results",
    icon: () => "history",
    singleton: true,
    defaultPlacement: "bottom",
    create: () => new ResultsView(services, tests),
  };
}

/** The open Test results tab (tests.showTestOutput selects a test in it). */
let openResults: ResultsView | null = null;

/** Selects a run's test in the open Test results tab and shows its output; false without one. */
export function revealTestOutput(run: number, test: string): boolean {
  return openResults?.showOutput(run, test) ?? false;
}

/** "just now", "5 min ago", or the time. */
function ago(at: number, now = Date.now()): string {
  const s = Math.round((now - at) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(at).toLocaleTimeString();
}

class ResultsView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly tree: Tree<Node>;
  private readonly empty: HTMLElement;
  private readonly detail: HTMLElement;
  /** The test whose output the pane shows ("run:test id"). */
  shown: { run: number; test: string } | null = null;
  private readonly run: (command: string, input?: unknown) => void;

  constructor(
    private readonly services: WorkbenchServices,
    private readonly tests: TestController,
  ) {
    this.run = (command, input) =>
      void services.dispatcher.execute(command, input ?? {}).catch((err: unknown) => {
        services.notifications.show("error", err instanceof Error ? err.message : String(err));
      });
    this.empty = h(
      "div",
      { class: "empty-state" },
      h("span", { class: "empty-state-icon" }, icon("history")),
      h("div", { class: "empty-state-title" }, "No test runs yet"),
      h("div", { class: "empty-state-text" }, "Each run of tests shows here, newest first."),
    );
    const body = h("div", { class: "test-results-body" });
    this.detail = h("div", { class: "test-result-detail", hidden: true });
    this.element = h(
      "div",
      { class: "test-results-view", tabindex: "-1" },
      this.empty,
      h("div", { class: "test-results-split" }, body, this.detail),
    );
    this.tree = this.store.add(
      new Tree<Node>(
        body,
        {
          id: (n) =>
            n.kind === "run"
              ? `r:${n.run.id}`
              : n.kind === "result"
                ? `r:${n.run.id}:${n.result.id}`
                : "",
          hasChildren: (n) => n.kind !== "result",
          children: async (n) =>
            n.kind === "root"
              ? this.tests.history.list().map((run) => ({ kind: "run" as const, run }))
              : n.kind === "run"
                ? n.run.results.map((result) => ({ kind: "result" as const, run: n.run, result }))
                : [],
        },
        { render: (n, row, info) => this.renderRow(n, row, info.expanded) },
        { rowHeight: 22, ariaLabel: "Test runs" },
      ),
    );
    this.store.add(
      this.tree.onDidOpen(({ item }) => {
        if (item.kind === "result") this.openResult(item.result);
      }),
    );
    this.store.add(
      this.tree.onDidChangeSelection((item) => {
        if (item?.kind === "result") this.renderDetail(item.run, item.result);
      }),
    );
    openResults = this;
    this.store.add({
      dispose: () => {
        if (openResults === this) openResults = null;
      },
    });
    let first = true;
    this.store.add(
      effect(() => {
        tests.historyVersion.value;
        const runs = this.tests.history.list();
        this.empty.hidden = runs.length > 0;
        // The newest run opens by itself (once).
        const newest = runs[0];
        const open = first && newest ? [`r:${newest.id}`] : this.tree.expandedIds();
        first = !newest;
        void this.tree.setRoot({ kind: "root" }, open);
        return undefined;
      }),
    );
  }

  /** Selects a run's test and shows its output (tests.showTestOutput). */
  showOutput(runId: number, test: string): boolean {
    const run = this.tests.history.get(runId);
    const result = run?.results.find((r) => r.id === test);
    if (!run || !result) return false;
    this.renderDetail(run, result);
    void this.tree.expand(`r:${run.id}`).then(() => this.tree.reveal(`r:${run.id}:${test}`));
    return true;
  }

  /** The output pane: the test's name, result and its own output. */
  private renderDetail(run: RunRecord, r: HistoryResult): void {
    this.shown = { run: run.id, test: r.id };
    this.detail.hidden = false;
    replaceChildren(
      this.detail,
      h(
        "div",
        { class: "test-result-detail-head" },
        this.statusIcon(r.status),
        h("span", { class: "test-name" }, r.name),
        h(
          "span",
          { class: "test-meta" },
          [r.durationMs !== undefined ? durationLabel(r.durationMs) : "", `run ${run.id}`]
            .filter(Boolean)
            .join(" · "),
        ),
      ),
      // A colored terminal's output, as VS Code's Test results shows it (SGR colors drawn with
      // the terminal palette's tokens, other escape sequences dropped).
      h("pre", { class: "test-result-output", tabindex: "0" }, ansiNodes(outputPaneText(r))),
    );
  }

  private openResult(r: HistoryResult): void {
    const t = this.tests.tests.peek().find((x) => x.id === r.id);
    if (!t) return;
    const { workspace } = this.services;
    // With several folders the file starts with its folder's name (D251).
    const path = workspace.root.peek() ? workspace.resolve(t.file) : t.file;
    this.run("editor.openFile", { path, line: t.line });
  }

  private action(name: IconName, title: string, command: string, input: unknown): HTMLElement {
    const b = h("button", { class: "icon-button test-row-action", type: "button" }, icon(name));
    setTooltip(b, title, command);
    b.addEventListener("mousedown", (e) => e.stopPropagation());
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      this.run(command, input);
    });
    return b;
  }

  private statusIcon(status: HistoryStatus | "cancelled"): SVGSVGElement {
    const el = icon(status === "cancelled" ? "ban" : STATUS_ICON[status]);
    el.classList.add("test-status", `is-${status === "cancelled" ? "skipped" : status}`);
    return el;
  }

  private renderRow(n: Node, row: HTMLElement, expanded: boolean): void {
    row.classList.add("test-row", "test-result-row");
    if (n.kind === "run") {
      const r = n.run;
      const status = r.cancelled
        ? "cancelled"
        : r.failed
          ? "failed"
          : r.passed
            ? "passed"
            : "skipped";
      setTooltip(
        row,
        `${r.label}${r.coverage ? " (with coverage)" : ""}\n${countsLabel(r)} · ${durationLabel(r.durationMs)}${r.cancelled ? " · stopped" : ""}\n${new Date(r.startedAt).toLocaleString()}\n${r.commands.join("\n")}`,
        undefined,
        { placement: "right" },
      );
      replaceChildren(
        row,
        icon(expanded ? "chevron-down" : "chevron-right"),
        this.statusIcon(status),
        h("span", { class: "test-name" }, r.label),
        h(
          "span",
          { class: "test-meta" },
          `${countsLabel(r)} · ${durationLabel(r.durationMs)} · ${ago(r.startedAt)}`,
        ),
        ...(r.coverage ? [icon("shield")] : []),
        h(
          "span",
          { class: "test-row-actions" },
          this.action("play", "Run again", "tests.rerunFromHistory", { run: r.id }),
        ),
      );
      return;
    }
    if (n.kind !== "result") return;
    const res = n.result;
    const live = this.tests.results.peek().get(res.id);
    const comparable =
      live &&
      live.status === "failed" &&
      live.expected !== undefined &&
      n.run === this.tests.history.list()[0];
    setTooltip(
      row,
      `${res.name}\n${res.file}${res.message ? `\n\n${res.message.split("\n").slice(0, 8).join("\n")}` : ""}`,
      undefined,
      { placement: "right" },
    );
    replaceChildren(
      row,
      h("span", { class: "test-chevron-space" }),
      this.statusIcon(res.status),
      h("span", { class: "test-name" }, res.name),
      h(
        "span",
        { class: "test-meta" },
        [res.durationMs !== undefined ? durationLabel(res.durationMs) : "", res.file]
          .filter(Boolean)
          .join(" · "),
      ),
      h(
        "span",
        { class: "test-row-actions" },
        ...(comparable
          ? [
              this.action("git-compare", "Compare expected with actual", "tests.compareExpected", {
                id: res.id,
              }),
            ]
          : []),
        this.action("square-terminal", "Show test output", "tests.showTestOutput", {
          test: res.id,
          run: n.run.id,
        }),
        this.action("play", "Run this test", "tests.run", { test: res.id }),
      ),
    );
  }

  focus(): void {
    this.tree.focus();
  }

  serialize(): null {
    return null;
  }

  dispose(): void {
    this.store.dispose();
  }
}
