// The Testing view (D149), like VS Code's Test Explorer: the workspace's tests by framework, file
// and suite, each with its last result (passed, failed, skipped, running); a summary line; a
// filter (text, failed only); continuous run (for every test, or a file's or a test's eye on
// hover); Run on every row (hover); a failed test shows its message under it. Clicking a test
// opens it at its line. Every action is a tests.* command. Extensions' test controllers have
// groups of their own (extensionTestsView.ts).
import { h, on, replaceChildren } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { fileIcon, type IconName, icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import { Tree } from "../../ui/Tree";
import type { WorkbenchServices } from "../../workbench/services";
import type { ContinuousRun } from "./continuousRun";
import type { Discovered, TestController } from "./controller";
import { ExtensionTestRows, type ExtNode } from "./extensionTestsView";
import { FRAMEWORK_LABEL, type Framework, type TestStatus } from "./model";

type Node =
  | { kind: "root" }
  | { kind: "group"; framework: Framework; project: string; tests: Discovered[] }
  | { kind: "file"; file: string; tests: Discovered[]; depth: number }
  | { kind: "suite"; file: string; path: string[]; tests: Discovered[] }
  | { kind: "test"; test: Discovered }
  | { kind: "message"; test: Discovered; text: string }
  | ExtNode;

const STATUS_ICON: Record<TestStatus, IconName> = {
  passed: "circle-check",
  failed: "circle-x",
  skipped: "circle-minus",
  running: "refresh-cw",
  unknown: "circle-dot",
};

const STATUS_LABEL: Record<TestStatus, string> = {
  passed: "Passed",
  failed: "Failed",
  skipped: "Skipped",
  running: "Running",
  unknown: "Not run",
};

export class TestingView {
  private readonly store = new DisposableStore();
  private readonly tree: Tree<Node>;
  private readonly summary: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly filterInput: HTMLInputElement;
  private readonly failedToggle: HTMLButtonElement;
  private readonly continuousToggle: HTMLButtonElement;
  private filter = "";
  private failedOnly = false;
  private readonly ext: ExtensionTestRows;

  constructor(
    host: HTMLElement,
    private readonly services: WorkbenchServices,
    private readonly tests: TestController,
    private readonly continuous: ContinuousRun,
  ) {
    this.ext = new ExtensionTestRows(services);
    this.summary = h("div", { class: "test-summary", role: "status" });
    this.filterInput = h("input", {
      class: "input test-filter",
      type: "search",
      placeholder: "Filter (e.g. text, file)",
      spellcheck: "false",
      "aria-label": "Filter tests",
    });
    this.failedToggle = h(
      "button",
      { class: "icon-button test-failed-toggle", type: "button", "aria-pressed": "false" },
      icon("circle-x"),
    );
    setTooltip(this.failedToggle, "Show only failed tests");
    this.continuousToggle = h(
      "button",
      { class: "icon-button test-continuous-toggle", type: "button", "aria-pressed": "false" },
      icon("eye"),
    );
    setTooltip(this.continuousToggle, "Turn on continuous run", "tests.toggleContinuousRun");
    this.empty = h(
      "div",
      { class: "empty-state test-empty", hidden: true },
      h("span", { class: "empty-state-icon" }, icon("flask-conical")),
      h("div", { class: "empty-state-title" }, "No tests found"),
      h(
        "div",
        { class: "empty-state-text" },
        "Tests from Vitest, Jest, node:test, Mocha, Playwright, pytest, unittest, cargo test and go test show here: files like *.test.ts, test_*.py, #[test] functions and *_test.go.",
      ),
    );
    const treeHost = h("div", { class: "test-tree" });
    host.append(
      h(
        "div",
        { class: "test-head" },
        h(
          "div",
          { class: "test-filter-row" },
          this.filterInput,
          this.failedToggle,
          this.continuousToggle,
        ),
        this.summary,
      ),
      this.empty,
      treeHost,
    );
    let timer = 0;
    this.store.add({ dispose: () => clearTimeout(timer) });
    this.store.add(
      on(this.filterInput, "input", () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => {
          this.filter = this.filterInput.value.trim().toLowerCase();
          void this.refresh();
        }, 120);
      }),
    );
    this.store.add(
      on(this.failedToggle, "click", () => {
        this.failedOnly = !this.failedOnly;
        this.failedToggle.setAttribute("aria-pressed", String(this.failedOnly));
        void this.refresh();
      }),
    );

    this.store.add(
      on(this.continuousToggle, "click", () => this.run("tests.toggleContinuousRun", {})),
    );
    this.store.add(
      effect(() => {
        const all = continuous.all.value;
        this.continuousToggle.setAttribute("aria-pressed", String(all));
        setTooltip(
          this.continuousToggle,
          all ? "Turn off continuous run" : "Turn on continuous run",
          "tests.toggleContinuousRun",
        );
        return undefined;
      }),
    );

    this.tree = this.store.add(
      new Tree<Node>(
        treeHost,
        {
          id: (n) =>
            n.kind === "extController" || n.kind === "extItem"
              ? this.ext.id(n)
              : n.kind === "group"
                ? `g:${n.framework}:${n.project}`
                : n.kind === "file"
                  ? `f:${n.file}`
                  : n.kind === "suite"
                    ? `s:${n.file}:${n.path.join("\u0000")}`
                    : n.kind === "test"
                      ? `t:${n.test.id}`
                      : n.kind === "message"
                        ? `m:${n.test.id}`
                        : "root",
          hasChildren: (n) =>
            n.kind === "extController" || n.kind === "extItem"
              ? this.ext.hasChildren(n)
              : n.kind === "root" ||
                n.kind === "group" ||
                n.kind === "file" ||
                n.kind === "suite" ||
                (n.kind === "test" && !!this.message(n.test)),
          children: async (n) => this.children(n),
        },
        { render: (n, row, info) => this.render(n, row, info.expanded) },
        { rowHeight: 22, ariaLabel: "Tests", sticky: true },
      ),
    );
    this.store.add(
      this.tree.onDidOpen(({ item }) => {
        if (item.kind === "test")
          this.run("editor.openFile", { path: this.abs(item.test.file), line: item.test.line });
        else if (item.kind === "message") this.run("tests.showMessage", { id: item.test.id });
        else if (item.kind === "extItem") this.ext.open(item);
      }),
    );
    this.store.add(
      effect(() => {
        tests.tests.value;
        tests.results.value;
        tests.fileErrors.value;
        tests.running.value;
        tests.summary.value;
        tests.discovering.value;
        continuous.all.value;
        continuous.files.value;
        continuous.tests.value;
        this.ext.track();
        this.renderSummary();
        void this.refresh();
        return undefined;
      }),
    );
    void this.tree.setRoot({ kind: "root" }).then(() => {
      this.rooted = true;
      void this.refresh();
    });
  }

  private rooted = false;
  /** Rows opened automatically once (per filter), so a row the user closes stays closed. */
  private readonly opened = new Set<string>();

  focus(): void {
    this.tree.focus();
  }

  /** A test file as named (with its folder's name first, of several: D251) made absolute. */
  private abs(rel: string): string {
    const { workspace } = this.services;
    return workspace.root.peek() ? workspace.resolve(rel) : rel;
  }

  private message(t: Discovered): string | null {
    const r = this.tests.results.peek().get(t.id);
    return r?.status === "failed" && "message" in r && r.message ? r.message : null;
  }

  private status(tests: readonly Discovered[]): TestStatus {
    let any = false;
    let all = true;
    let skipped = true;
    for (const t of tests) {
      const s = this.tests.status(t.id);
      if (s === "running") return "running";
      if (s === "failed") return "failed";
      if (s === "passed" || s === "skipped") any = true;
      else all = false;
      if (s !== "skipped") skipped = false;
    }
    if (!tests.length || !any) return "unknown";
    return skipped ? "skipped" : all ? "passed" : "unknown";
  }

  private visible(): Discovered[] {
    return this.tests.tests.peek().filter((t) => {
      if (this.failedOnly && this.tests.status(t.id) !== "failed") return false;
      if (!this.filter) return true;
      return `${t.file} ${t.path.join(" ")}`.toLowerCase().includes(this.filter);
    });
  }

  private async refresh(): Promise<void> {
    const all = this.tests.tests.peek();
    this.empty.hidden = all.length > 0 || this.ext.any() || this.tests.discovering.peek();
    if (!this.rooted) return;
    await this.tree.refresh();
    // Groups and files open the first time they appear (files when there are few tests, or a
    // filter is on); after that, what the user closed stays closed.
    const few = all.length <= 200;
    const ids = [
      ...this.groupNodes().map((n) => `g:${n.framework}:${n.project}`),
      ...this.ext.roots(this.filter, this.failedOnly).map((n) => this.ext.id(n)),
    ];
    if (few || this.filter || this.failedOnly)
      ids.push(...new Set(this.visible().map((t) => `f:${t.file}`)));
    let rest: string[] = [];
    for (const id of ids) {
      const key = `${id}|${this.filter}|${this.failedOnly}`;
      if (this.opened.has(key)) continue;
      this.opened.add(key);
      rest.push(id);
    }
    // Level by level, one render each (D379): a group's files exist once it's loaded; one render
    // per file was slow with hundreds of files.
    while (rest.length) {
      const ready = rest.filter((id) => this.tree.has(id));
      if (!ready.length) break;
      rest = rest.filter((id) => !this.tree.has(id));
      await this.tree.expandMany(ready);
    }
  }

  private groupNodes(): Extract<Node, { kind: "group" }>[] {
    const groups = new Map<string, Extract<Node, { kind: "group" }>>();
    for (const t of this.visible()) {
      const key = `${t.framework}|${t.project}`;
      let g = groups.get(key);
      if (!g) {
        g = { kind: "group", framework: t.framework, project: t.project, tests: [] };
        groups.set(key, g);
      }
      g.tests.push(t);
    }
    return [...groups.values()];
  }

  private async children(n: Node): Promise<Node[]> {
    if (n.kind === "root")
      return [...this.groupNodes(), ...this.ext.roots(this.filter, this.failedOnly)];
    if (n.kind === "extController" || n.kind === "extItem")
      return this.ext.children(n, this.filter, this.failedOnly);
    if (n.kind === "group") {
      const files = new Map<string, Discovered[]>();
      for (const t of n.tests) files.set(t.file, [...(files.get(t.file) ?? []), t]);
      return [...files].map(([file, tests]) => ({ kind: "file" as const, file, tests, depth: 0 }));
    }
    if (n.kind === "file" || n.kind === "suite") {
      const depth = n.kind === "suite" ? n.path.length : 0;
      const out: Node[] = [];
      const seen = new Set<string>();
      for (const t of n.tests) {
        if (t.path.length - 1 === depth) out.push({ kind: "test", test: t });
        else {
          const name = t.path[depth] ?? "";
          if (seen.has(name)) continue;
          seen.add(name);
          const path = t.path.slice(0, depth + 1);
          out.push({
            kind: "suite",
            file: n.file,
            path,
            tests: n.tests.filter(
              (x) => path.every((p, i) => x.path[i] === p) && x.path.length > path.length,
            ),
          });
        }
      }
      return out;
    }
    if (n.kind === "test") {
      const text = this.message(n.test);
      return text ? [{ kind: "message", test: n.test, text }] : [];
    }
    return [];
  }

  private renderSummary(): void {
    const running = this.tests.running.peek() ?? this.ext.running();
    const s = this.tests.summary.peek();
    const all = this.tests.tests.peek();
    // Extensions' tests count too.
    const ext = this.ext.counts();
    let passed = ext.passed;
    let failed = ext.failed;
    let skipped = ext.skipped;
    for (const t of all) {
      const st = this.tests.status(t.id);
      if (st === "passed") passed++;
      else if (st === "failed") failed++;
      else if (st === "skipped") skipped++;
    }
    const parts: (HTMLElement | string)[] = [];
    if (running)
      parts.push(h("span", { class: "test-running" }, icon("refresh-cw"), `Running ${running}…`));
    else if (this.tests.discovering.peek()) parts.push("Finding tests…");
    else {
      parts.push(
        h("span", { class: "is-passed" }, icon("circle-check"), String(passed)),
        h("span", { class: "is-failed" }, icon("circle-x"), String(failed)),
        h("span", { class: "is-skipped" }, icon("circle-minus"), String(skipped)),
        h("span", { class: "test-total" }, `of ${all.length + ext.total}`),
      );
      if (s)
        parts.push(
          h(
            "span",
            { class: "test-time" },
            `${(s.durationMs / 1000).toFixed(1)} s${s.cancelled ? " · stopped" : ""}`,
          ),
        );
    }
    replaceChildren(this.summary, ...parts);
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

  /** The eye a file or test shows while continuous run is on for it. */
  private watching(on: boolean): SVGSVGElement[] {
    if (!on) return [];
    const el = icon("eye");
    el.classList.add("test-watching");
    el.setAttribute("aria-label", "Continuous run is on");
    return [el];
  }

  private continuousAction(on: boolean, input: { file?: string; test?: string }): HTMLElement {
    return this.action(
      on ? "eye-off" : "eye",
      on ? "Turn off continuous run" : "Turn on continuous run",
      "tests.toggleContinuousRun",
      input,
    );
  }

  private statusIcon(status: TestStatus): SVGSVGElement {
    const el = icon(STATUS_ICON[status]);
    el.classList.add("test-status", `is-${status}`);
    return el;
  }

  private render(n: Node, row: HTMLElement, expanded: boolean): void {
    row.classList.add("test-row");
    delete row.dataset.tooltip;
    row.removeAttribute("aria-label");
    const chevron = (has: boolean) =>
      has
        ? icon(expanded ? "chevron-down" : "chevron-right")
        : h("span", { class: "test-chevron-space" });
    if (n.kind === "extController" || n.kind === "extItem") {
      this.ext.render(n, row, {
        chevron,
        statusIcon: (status) => this.statusIcon(status),
        action: (name, title, command, input) => this.action(name, title, command, input),
      });
      return;
    }
    if (n.kind === "group") {
      const status = this.status(n.tests);
      replaceChildren(
        row,
        chevron(true),
        this.statusIcon(status),
        h("span", { class: "test-name is-group" }, FRAMEWORK_LABEL[n.framework]),
        h("span", { class: "test-meta" }, n.project || ""),
        h(
          "span",
          { class: "test-row-actions" },
          this.action(
            "shield",
            `Run ${FRAMEWORK_LABEL[n.framework]} tests with coverage`,
            "tests.runWithCoverage",
            { framework: n.framework, project: n.project },
          ),
          this.action("play", `Run ${FRAMEWORK_LABEL[n.framework]} tests`, "tests.run", {
            framework: n.framework,
            project: n.project,
          }),
        ),
        h("span", { class: "search-count" }, String(n.tests.length)),
      );
      return;
    }
    if (n.kind === "file") {
      const name = n.file.split("/").pop() ?? n.file;
      const dir = n.file.slice(0, Math.max(0, n.file.length - name.length - 1));
      const error = this.tests.fileErrors.peek().get(n.file);
      replaceChildren(
        row,
        chevron(true),
        this.statusIcon(error ? "failed" : this.status(n.tests)),
        icon(fileIcon(name)),
        h("span", { class: "test-name" }, name),
        h("span", { class: "test-meta" }, dir),
        ...this.watching(this.continuous.files.peek().has(n.file)),
        h(
          "span",
          { class: "test-row-actions" },
          this.action("file", "Open file", "editor.openFile", { path: this.abs(n.file) }),
          this.continuousAction(this.continuous.files.peek().has(n.file), { file: n.file }),
          this.action("shield", "Run with coverage", "tests.runWithCoverage", { file: n.file }),
          this.action("bug-play", "Debug the tests in this file", "tests.debug", { file: n.file }),
          this.action("play", "Run the tests in this file", "tests.run", { file: n.file }),
        ),
      );
      if (error)
        setTooltip(row, error.split("\n").slice(0, 6).join("\n"), undefined, {
          placement: "right",
        });
      return;
    }
    if (n.kind === "suite") {
      replaceChildren(
        row,
        chevron(true),
        this.statusIcon(this.status(n.tests)),
        h("span", { class: "test-name" }, n.path.at(-1) ?? ""),
        h("span", { class: "test-row-actions" }),
      );
      return;
    }
    if (n.kind === "test") {
      const t = n.test;
      const r = this.tests.results.peek().get(t.id);
      const status = r?.status ?? "unknown";
      const duration =
        r && "durationMs" in r && r.durationMs !== undefined ? `${r.durationMs} ms` : "";
      const past = this.tests.history
        .testHistory(t.id, 5)
        .map(
          (e) =>
            `${STATUS_LABEL[e.status]}${e.durationMs !== undefined ? ` ${e.durationMs} ms` : ""}`,
        );
      setTooltip(
        row,
        `${t.path.join(" › ")}\n${STATUS_LABEL[status]}${duration ? ` · ${duration}` : ""} · ${t.file}:${t.line}${past.length > 1 ? `\nLast runs: ${past.join(", ")}` : ""}`,
        undefined,
        {
          placement: "right",
        },
      );
      replaceChildren(
        row,
        chevron(!!this.message(t)),
        this.statusIcon(status),
        h("span", { class: "test-name" }, t.path.at(-1) ?? ""),
        h("span", { class: "test-meta" }, duration),
        ...this.watching(this.continuous.tests.peek().has(t.id)),
        h(
          "span",
          { class: "test-row-actions" },
          this.continuousAction(this.continuous.tests.peek().has(t.id), { test: t.id }),
          this.action("shield", "Run with coverage", "tests.runWithCoverage", { test: t.id }),
          this.action("bug-play", "Debug this test", "tests.debug", { test: t.id }),
          this.action("play", "Run this test", "tests.run", { test: t.id }),
        ),
      );
      return;
    }
    if (n.kind === "message") {
      const first = n.text.split("\n").find((l) => l.trim()) ?? "";
      const r = this.tests.results.peek().get(n.test.id);
      const comparable = r?.status === "failed" && r.expected !== undefined;
      setTooltip(row, "Show the whole message", undefined, { placement: "right" });
      replaceChildren(
        row,
        h("span", { class: "test-chevron-space" }),
        icon("circle-alert"),
        h("span", { class: "test-message" }, first.trim()),
        h(
          "span",
          { class: "test-row-actions" },
          ...(comparable
            ? [
                this.action(
                  "git-compare",
                  "Compare expected with actual",
                  "tests.compareExpected",
                  { id: n.test.id },
                ),
              ]
            : []),
          this.action("file-text", "Show the whole message", "tests.showMessage", {
            id: n.test.id,
          }),
        ),
      );
    }
  }

  private run(command: string, input: unknown = {}): void {
    void this.services.dispatcher.execute(command, input).catch((err: unknown) => {
      this.services.notifications.show("error", err instanceof Error ? err.message : String(err));
    });
  }

  dispose(): void {
    this.store.dispose();
  }
}
