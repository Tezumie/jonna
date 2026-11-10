// The Test coverage tab (D204), like VS Code's Test Coverage view: the last coverage run's files
// by folder, each with its covered share (a bar and a percentage; lines, branches and functions in
// its tooltip), the totals, what ran and what wrote no report. A filter, sort by name or by
// coverage, "Show inline coverage" and "Clear coverage". Clicking a file opens it (the margin then
// shows its lines); a file opens to its functions (VS Code's declarations: ran or not, how often),
// each opening the file at its line. Every action is a command.
import { h, on, replaceChildren } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect, type ReadonlySignal } from "../../core/reactive/index";
import { fileIcon, icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import { Tree } from "../../ui/Tree";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import type { CoverageReport, TestController } from "./controller";
import {
  type CoverageTotals,
  combinedPercent,
  type Declaration,
  type FileCoverage,
  fileTotals,
  percent,
  totals,
} from "./coverage";

type Node =
  | { kind: "root" }
  | { kind: "folder"; dir: string; files: FileCoverage[] }
  | { kind: "file"; fc: FileCoverage }
  | { kind: "declaration"; fc: FileCoverage; d: Declaration };

export function coverageViewDescriptor(
  services: WorkbenchServices,
  tests: TestController,
  inline: ReadonlySignal<boolean>,
): DockViewDescriptor {
  return {
    type: "testCoverage",
    title: () => "Test coverage",
    icon: () => "shield",
    singleton: true,
    defaultPlacement: "bottom",
    create: () => new CoverageView(services, tests, inline),
  };
}

const pct = (p: number | null) => (p === null ? "–" : `${p.toFixed(p === 100 ? 0 : 1)}%`);

/** "Lines 34/40 (85%) · Branches 3/4 (75%) · Functions 5/6 (83.3%)". */
export function totalsLabel(t: CoverageTotals, sep = " · "): string {
  const part = (name: string, c: { covered: number; total: number }) =>
    c.total ? `${name} ${c.covered}/${c.total} (${pct(percent(c))})` : "";
  return [part("Lines", t.lines), part("Branches", t.branches), part("Functions", t.functions)]
    .filter(Boolean)
    .join(sep);
}

class CoverageView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly tree: Tree<Node>;
  private readonly filter: HTMLInputElement;
  private readonly head: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly inlineToggle: HTMLButtonElement;
  private readonly sortToggle: HTMLButtonElement;
  private byCoverage = false;
  private folders: { dir: string; files: FileCoverage[] }[] = [];
  private readonly run: (command: string, input?: unknown) => void;

  constructor(
    private readonly services: WorkbenchServices,
    private readonly tests: TestController,
    inline: ReadonlySignal<boolean>,
  ) {
    this.run = (command, input) =>
      void services.dispatcher.execute(command, input ?? {}).catch((err: unknown) => {
        services.notifications.show("error", err instanceof Error ? err.message : String(err));
      });
    this.filter = h("input", {
      class: "input coverage-filter",
      type: "search",
      placeholder: "Filter files",
      spellcheck: "false",
      "aria-label": "Filter covered files",
    });
    const button = (name: Parameters<typeof icon>[0], title: string, command: string) => {
      const b = h("button", { class: "icon-button", type: "button" }, icon(name));
      setTooltip(b, title, command);
      this.store.add(on(b, "click", () => this.run(command, {})));
      return b;
    };
    this.inlineToggle = button("eye", "Show inline coverage", "tests.toggleInlineCoverage");
    this.inlineToggle.classList.add("coverage-inline-toggle");
    this.sortToggle = h(
      "button",
      { class: "icon-button coverage-sort", type: "button", "aria-pressed": "false" },
      icon("arrow-down-a-z"),
    );
    setTooltip(this.sortToggle, "Sort by coverage");
    this.store.add(
      on(this.sortToggle, "click", () => {
        this.byCoverage = !this.byCoverage;
        this.sortToggle.setAttribute("aria-pressed", String(this.byCoverage));
        void this.rebuild();
      }),
    );
    this.head = h("div", { class: "coverage-summary", role: "status" });
    const runButton = h(
      "button",
      { class: "button button-secondary button-sm coverage-run", type: "button" },
      "Run all tests with coverage",
    );
    this.store.add(on(runButton, "click", () => this.run("tests.runWithCoverage", {})));
    this.empty = h(
      "div",
      { class: "empty-state coverage-empty" },
      h("span", { class: "empty-state-icon" }, icon("shield")),
      h("div", { class: "empty-state-title" }, "No coverage yet"),
      h(
        "div",
        { class: "empty-state-text" },
        "Run tests with coverage (the shield in the Testing view, or Testing: Run all tests with coverage) to see which lines they ran.",
      ),
      runButton,
    );
    const body = h("div", { class: "coverage-body" });
    this.element = h(
      "div",
      { class: "coverage-view", tabindex: "-1" },
      h(
        "div",
        { class: "coverage-header" },
        h(
          "div",
          { class: "coverage-toolbar" },
          this.filter,
          this.sortToggle,
          this.inlineToggle,
          button("refresh-cw", "Run again with coverage", "tests.rerunWithCoverage"),
          button("x", "Clear coverage", "tests.clearCoverage"),
        ),
        this.head,
      ),
      this.empty,
      body,
    );
    this.tree = this.store.add(
      new Tree<Node>(
        body,
        {
          id: (n) =>
            n.kind === "folder"
              ? `d:${n.dir}`
              : n.kind === "file"
                ? n.fc.file
                : n.kind === "declaration"
                  ? `${n.fc.file}#${n.d.line}:${n.d.name}`
                  : "",
          hasChildren: (n) =>
            n.kind === "root" ||
            n.kind === "folder" ||
            (n.kind === "file" && (n.fc.declarations?.length ?? 0) > 0),
          children: async (n) =>
            n.kind === "root"
              ? this.folders.map((f) => ({ kind: "folder" as const, ...f }))
              : n.kind === "folder"
                ? n.files.map((fc) => ({ kind: "file" as const, fc }))
                : n.kind === "file"
                  ? (n.fc.declarations ?? []).map((d) => ({
                      kind: "declaration" as const,
                      fc: n.fc,
                      d,
                    }))
                  : [],
        },
        { render: (n, row, info) => this.renderRow(n, row, info.expanded) },
        { rowHeight: 22, ariaLabel: "Covered files" },
      ),
    );
    this.store.add(
      this.tree.onDidOpen(({ item, preserveFocus, preview }) => {
        if (item.kind === "file")
          this.run("editor.openFile", {
            path: this.abs(item.fc.file),
            preserveFocus,
            preview,
          });
        else if (item.kind === "declaration")
          this.run("editor.openFile", {
            path: this.abs(item.fc.file),
            ...(item.d.line > 0 && { line: item.d.line }),
            preserveFocus,
            preview,
          });
      }),
    );
    let frame = 0;
    this.store.add(
      on(this.filter, "input", () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => void this.rebuild());
      }),
    );
    this.store.add({ dispose: () => cancelAnimationFrame(frame) });
    this.store.add(
      effect(() => {
        const on = inline.value;
        this.inlineToggle.setAttribute("aria-pressed", String(on));
        setTooltip(
          this.inlineToggle,
          on ? "Hide inline coverage" : "Show inline coverage",
          "tests.toggleInlineCoverage",
        );
        return undefined;
      }),
    );
    this.store.add(
      effect(() => {
        tests.shownCoverage.value;
        tests.running.value;
        void this.rebuild();
        return undefined;
      }),
    );
  }

  /** A test file as named (with its folder's name first, of several: D251) made absolute. */
  private abs(rel: string): string {
    const { workspace } = this.services;
    return workspace.root.peek() ? workspace.resolve(rel) : rel;
  }

  private renderHead(report: CoverageReport | null, shown: FileCoverage[]): void {
    const running = this.tests.running.peek();
    if (!report) {
      replaceChildren(this.head, running ? `Running ${running}…` : "");
      return;
    }
    const t = totals(shown);
    const when = new Date(report.finishedAt).toLocaleTimeString();
    const all = h("span", { class: "coverage-total" }, pct(combinedPercent(t)));
    setTooltip(all, "Lines and branches covered");
    replaceChildren(
      this.head,
      all,
      h("span", {}, totalsLabel(t)),
      h(
        "span",
        { class: "coverage-meta" },
        running ? `Running ${running}…` : `${report.label} · ${when}`,
      ),
      ...report.problems.map((p) =>
        h("span", { class: "coverage-problem" }, icon("triangle-alert"), p),
      ),
    );
  }

  private async rebuild(): Promise<void> {
    const report = this.tests.shownCoverage.peek();
    const q = this.filter.value.trim().toLowerCase();
    const files = (report?.files ?? []).filter((f) => !q || f.file.toLowerCase().includes(q));
    this.renderHead(report, files);
    const byDir = new Map<string, FileCoverage[]>();
    for (const fc of files) {
      const dir = fc.file.includes("/") ? fc.file.slice(0, fc.file.lastIndexOf("/")) : "";
      byDir.set(dir, [...(byDir.get(dir) ?? []), fc]);
    }
    const score = (list: FileCoverage[]) => combinedPercent(totals(list)) ?? 101;
    this.folders = [...byDir]
      .map(([dir, list]) => ({
        dir,
        files: this.byCoverage
          ? [...list].sort((a, b) => score([a]) - score([b]) || a.file.localeCompare(b.file))
          : [...list].sort((a, b) => a.file.localeCompare(b.file)),
      }))
      .sort((a, b) =>
        this.byCoverage
          ? score(a.files) - score(b.files) || a.dir.localeCompare(b.dir)
          : a.dir.localeCompare(b.dir),
      );
    this.empty.hidden = !!report;
    await this.tree.setRoot(
      { kind: "root" },
      this.folders.map((f) => `d:${f.dir}`),
    );
  }

  private bar(t: CoverageTotals): HTMLElement[] {
    const p = combinedPercent(t);
    const bar = h(
      "span",
      { class: "coverage-bar", "aria-hidden": "true" },
      h("span", {
        class: `coverage-bar-fill ${p === null ? "" : p >= 80 ? "is-good" : p >= 50 ? "is-fair" : "is-poor"}`,
        style: { width: `${p ?? 0}%` },
      }),
    );
    return [bar, h("span", { class: "coverage-pct" }, pct(p))];
  }

  private renderRow(n: Node, row: HTMLElement, expanded: boolean): void {
    row.classList.add("coverage-row");
    if (n.kind === "folder") {
      const t = totals(n.files);
      setTooltip(row, `${n.dir || "(root)"}\n${totalsLabel(t, "\n")}`, undefined, {
        placement: "right",
      });
      replaceChildren(
        row,
        icon(expanded ? "chevron-down" : "chevron-right"),
        icon(expanded ? "folder-open" : "folder"),
        h("span", { class: "coverage-name" }, n.dir || "(root)"),
        h("span", { class: "coverage-spacer" }),
        ...this.bar(t),
      );
      return;
    }
    if (n.kind === "declaration") {
      const ran = n.d.hits > 0;
      setTooltip(
        row,
        `${n.d.name}${n.d.line ? ` (line ${n.d.line})` : ""}\n${ran ? `Ran ${n.d.hits} time${n.d.hits === 1 ? "" : "s"}` : "Not run"}`,
        undefined,
        { placement: "right" },
      );
      replaceChildren(
        row,
        h("span", { class: "coverage-indent" }),
        h("span", { class: "coverage-indent" }),
        icon("square-function"),
        h("span", { class: "coverage-name" }, n.d.name),
        h("span", { class: "coverage-spacer" }),
        h(
          "span",
          { class: `coverage-declaration ${ran ? "is-covered" : "is-uncovered"}` },
          ran ? `${n.d.hits}×` : "Not run",
        ),
      );
      return;
    }
    if (n.kind !== "file") return;
    const name = n.fc.file.split("/").pop() ?? n.fc.file;
    const t = fileTotals(n.fc);
    setTooltip(row, `${n.fc.file}\n${totalsLabel(t, "\n")}`, undefined, { placement: "right" });
    replaceChildren(
      row,
      n.fc.declarations?.length
        ? icon(expanded ? "chevron-down" : "chevron-right")
        : h("span", { class: "coverage-indent" }),
      icon(fileIcon(name)),
      h("span", { class: "coverage-name" }, name),
      h("span", { class: "coverage-spacer" }),
      ...this.bar(t),
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
