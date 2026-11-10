// The `problems` dock tab: diagnostics grouped by file (severity icon, message, source/code,
// line:column), with a filter box. Enter or click opens the location in a preview tab; the copy
// button on a hovered row, Ctrl/Cmd+C and the context menu copy problems or send them to the
// agent (problemActions.ts, D129).
import { h, on, replaceChildren } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect, type ReadonlySignal } from "../../core/reactive/index";
import { fileIcon, type IconName, icon } from "../../ui/Icon";
import { showContextMenu } from "../../ui/Menu";
import { setTooltip } from "../../ui/Tooltip";
import { Tree } from "../../ui/Tree";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import type { Diagnostic, DiagnosticSeverity } from "./engine";
import { problemMenu, targetOf } from "./problemActions";

type Node =
  | { kind: "root" }
  | { kind: "file"; path: string; items: Diagnostic[] }
  | { kind: "item"; d: Diagnostic; index: number };

const SEVERITY_ICON: Record<DiagnosticSeverity, IconName> = {
  error: "circle-x",
  warning: "triangle-alert",
  info: "info",
  hint: "info",
};

export function problemsViewDescriptor(
  services: WorkbenchServices,
  diagnostics: ReadonlySignal<readonly Diagnostic[]>,
  rel: (path: string) => string,
): DockViewDescriptor {
  return {
    type: "problems",
    title: () => "Problems",
    icon: () => "circle-alert",
    singleton: true,
    defaultPlacement: "bottom",
    create: () => new ProblemsView(services, diagnostics, rel),
  };
}

class ProblemsView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly tree: Tree<Node>;
  private readonly filter: HTMLInputElement;
  private readonly empty: HTMLElement;
  private groups: { path: string; items: Diagnostic[] }[] = [];

  private readonly run: (command: string, input?: unknown) => void;

  constructor(
    services: WorkbenchServices,
    private readonly diagnostics: ReadonlySignal<readonly Diagnostic[]>,
    private readonly rel: (path: string) => string,
  ) {
    this.filter = h("input", {
      class: "input problems-filter",
      type: "search",
      placeholder: "Filter (e.g. text, **/*.ts)",
      "aria-label": "Filter problems",
    });
    this.empty = h(
      "div",
      { class: "empty-state" },
      h("span", { class: "empty-state-icon" }, icon("circle-check")),
      h("div", { class: "empty-state-title" }, "No problems in open files"),
    );
    this.run = (command, input) =>
      void services.dispatcher.execute(command, input ?? {}).catch((err: unknown) => {
        services.notifications.show("error", err instanceof Error ? err.message : String(err));
      });
    const body = h("div", { class: "problems-body" });
    this.element = h(
      "div",
      { class: "problems-view", tabindex: "-1" },
      h("div", { class: "problems-header" }, this.filter),
      body,
      this.empty,
    );
    this.tree = this.store.add(
      new Tree<Node>(
        body,
        {
          id: (n) =>
            n.kind === "file" ? n.path : n.kind === "item" ? `${n.d.path}#${n.index}` : "",
          hasChildren: (n) => n.kind !== "item",
          children: async (n) =>
            n.kind === "root"
              ? this.groups.map((g) => ({ kind: "file" as const, ...g }))
              : n.kind === "file"
                ? n.items.map((d, index) => ({ kind: "item" as const, d, index }))
                : [],
        },
        { render: (n, row, info) => this.renderRow(n, row, info.expanded) },
        { rowHeight: 22, ariaLabel: "Problems" },
      ),
    );
    const open = (d: Diagnostic, preserveFocus = false, preview = true) =>
      d.cell
        ? // A notebook cell's problem (D204): the notebook opens at that cell's line.
          void services.dispatcher
            .execute("editor.openFile", { path: d.path, preserveFocus, preview })
            .then(() =>
              this.run("notebook.revealCell", {
                path: d.path,
                cellId: d.cell?.id,
                line: d.line,
                column: d.column,
              }),
            )
            .catch(() => {})
        : this.run("editor.openFile", {
            path: d.path,
            line: d.line,
            column: d.column,
            preserveFocus,
            preview,
          });
    this.store.add(
      this.tree.onDidOpen(({ item, preserveFocus, preview }) => {
        if (item.kind === "item") open(item.d, preserveFocus, preview);
      }),
    );
    this.store.add(
      this.tree.onContextMenu(({ item, x, y }) => {
        if (!item || item.kind === "root") return;
        const items =
          item.kind === "item"
            ? problemMenu(item.d, this.run, { goTo: () => open(item.d) })
            : [
                {
                  label: "Copy problems in this file",
                  icon: "copy" as const,
                  run: () => this.run("problems.copy", { path: item.path }),
                },
                {
                  label: "Copy all problems",
                  icon: "copy" as const,
                  run: () => this.run("problems.copy", {}),
                },
                {
                  label: "Fix all in this file with agent",
                  icon: "agent" as const,
                  separatorBefore: true,
                  run: () => this.run("problems.fixWithAgent", { path: item.path }),
                },
              ];
        this.store.add(showContextMenu(x, y, items));
      }),
    );
    // Ctrl/Cmd+C copies the selected problems (a file row: all of that file's).
    this.store.add(
      on(this.tree.element, "keydown", (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "c" || e.shiftKey || e.altKey)
          return;
        const picked = this.tree.selectedItems();
        if (!picked.length) return;
        e.preventDefault();
        e.stopPropagation();
        const one = picked.length === 1 ? picked[0] : undefined;
        if (one?.kind === "item") this.run("problems.copy", targetOf(one.d));
        else if (one?.kind === "file") this.run("problems.copy", { path: one.path });
        else this.run("problems.copy", {});
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
        diagnostics.value;
        // A language server publishes file by file: one rebuild per frame, not one each (D379).
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => void this.rebuild());
        return undefined;
      }),
    );
  }

  private async rebuild(): Promise<void> {
    const q = this.filter.value.trim().toLowerCase();
    const byPath = new Map<string, Diagnostic[]>();
    for (const d of this.diagnostics.peek()) {
      const r = this.rel(d.path);
      if (q && !`${r} ${d.message} ${d.source ?? ""} ${d.code ?? ""}`.toLowerCase().includes(q))
        continue;
      const list = byPath.get(d.path) ?? [];
      list.push(d);
      byPath.set(d.path, list);
    }
    this.groups = [...byPath].map(([path, items]) => ({ path, items }));
    this.empty.hidden = this.groups.length > 0;
    await this.tree.setRoot(
      { kind: "root" },
      this.groups.map((g) => g.path),
    );
  }

  private renderRow(n: Node, row: HTMLElement, expanded: boolean): void {
    row.classList.add("problems-row");
    if (n.kind === "file") {
      const r = this.rel(n.path);
      // A file outside the folder keeps its own (Windows) separators.
      const cut = Math.max(r.lastIndexOf("/"), r.lastIndexOf("\\"));
      const name = r.slice(cut + 1);
      const glyph = icon(fileIcon(name));
      replaceChildren(
        row,
        icon(expanded ? "chevron-down" : "chevron-right"),
        glyph,
        h("span", { class: "problems-file" }, name),
        h("span", { class: "problems-dir" }, r.slice(0, Math.max(0, cut))),
        h("span", { class: "search-count" }, String(n.items.length)),
      );
      return;
    }
    if (n.kind !== "item") return;
    const { d } = n;
    const sev = icon(SEVERITY_ICON[d.severity]);
    sev.classList.add(`is-${d.severity}`);
    const copy = h("button", { class: "icon-button problems-copy", type: "button" }, icon("copy"));
    setTooltip(copy, "Copy problem");
    // The row opens on mousedown (Tree): the button keeps the press to itself.
    copy.addEventListener("mousedown", (e) => e.stopPropagation());
    copy.addEventListener("click", (e) => {
      e.stopPropagation();
      this.run("problems.copy", targetOf(d));
    });
    const message = h("span", { class: "problems-message" }, d.message.split("\n")[0] ?? "");
    setTooltip(message, d.message, undefined, { placement: "below" });
    replaceChildren(
      row,
      sev,
      message,
      h(
        "span",
        { class: "problems-source" },
        `${d.source ?? ""}${d.code ? `(${d.code})` : ""} [${d.cell ? `Cell ${d.cell.index + 1}, ` : ""}Ln ${d.line}, Col ${d.column}]`,
      ),
      copy,
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
