// Problems: diagnostics from the language services (open files) and from tasks' problem matchers
// (any file, D134), as the `problems` dock tab
// (Ctrl/Cmd+Shift+M), status-bar counts, `problems.list` for agents and `ide://diagnostics`.
// Diagnostics are mirrored into a signal so views and the status bar update reactively.

import { clipboardIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { pathKey } from "../../core/paths/index";
import { effect, type ReadonlySignal, type Signal, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { Diagnostic, DiagnosticSeverity } from "./engine";
import { fixPrompt, formatProblem, matchProblems } from "./problemActions";
import { countProblems, type ProblemCounts } from "./problemCounts";
import { problemsViewDescriptor } from "./problemsView";
import type { EditorService } from "./service";

const ORDER: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

/** Sorted by path, then severity, then position; hints are left out (not "problems"). */
export function sortDiagnostics(list: readonly Diagnostic[]): Diagnostic[] {
  return list
    .filter((d) => d.severity !== "hint")
    .sort(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        ORDER[a.severity] - ORDER[b.severity] ||
        (a.cell?.index ?? 0) - (b.cell?.index ?? 0) ||
        a.line - b.line ||
        a.column - b.column,
    );
}

/**
 * Errors and warnings on file names, in the explorer and on tabs (VS Code's
 * problems.decorations.enabled, D279): the file's color and its count, ahead of git's letter;
 * folders holding them take the color.
 */
function registerProblemDecorations(
  sub: DisposableStore,
  services: WorkbenchServices,
  diagnostics: ReadonlySignal<readonly Diagnostic[]>,
): void {
  let counts: ProblemCounts = { files: new Map(), dirs: new Map() };
  let enabled = true;
  /** The counts last decorated: unchanged counts (a message's wording) redraw nothing (D379). */
  let shownKey = "";
  sub.add(
    effect(() => {
      enabled = services.settings.get<boolean>("problems.decorations.enabled") !== false;
      counts = enabled ? countProblems(diagnostics.value) : { files: new Map(), dirs: new Map() };
      let key = "";
      for (const [file, c] of counts.files) key += `${file}\0${c.errors}\0${c.warnings}\n`;
      if (key === shownKey) return undefined;
      shownKey = key;
      services.decorations.changed();
      return undefined;
    }),
  );
  sub.add(
    services.decorations.register({
      decorate: (path, kind) => {
        if (!enabled) return undefined;
        const key = pathKey(path);
        if (kind === "dir") {
          const error = counts.dirs.get(key);
          if (error === undefined) return undefined;
          return {
            color: error ? "--status-danger-fg" : "--status-warning-fg",
            tooltip: "Contains problems",
            priority: 1,
          };
        }
        const c = counts.files.get(key);
        if (!c) return undefined;
        const total = c.errors + c.warnings;
        const parts = [
          c.errors ? `${c.errors} ${c.errors === 1 ? "error" : "errors"}` : "",
          c.warnings ? `${c.warnings} ${c.warnings === 1 ? "warning" : "warnings"}` : "",
        ].filter(Boolean);
        return {
          color: c.errors ? "--status-danger-fg" : "--status-warning-fg",
          badge: total > 9 ? "9+" : String(total),
          tooltip: parts.join(", "),
          priority: 1,
        };
      },
    }),
  );
}

export function registerProblems(
  sub: DisposableStore,
  services: WorkbenchServices,
  editors: EditorService,
): Signal<readonly Diagnostic[]> {
  const { dispatcher, dock, statusBar, state, workspace } = services;
  const diagnostics = signal<readonly Diagnostic[]>([]);
  /** Tasks' problems (problem matchers, D134), open or not. */
  const external = (): Diagnostic[] =>
    [...services.problems.all.peek().values()].flat().map((p) => ({ ...p, external: true }));
  editors.whenEngine((engine) => {
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(
        () =>
          (diagnostics.value = sortDiagnostics([
            // Closed files whose models are kept for undo show what language servers report for
            // them as closed files (the engine leaves the built-in checkers' out, D218). Tasks'
            // problems come from their own list (the editors' copies are the squiggles).
            ...engine.diagnostics().filter((d) => !d.external),
            ...external(),
          ])),
      );
    };
    sub.add(engine.onDidChangeDiagnostics(sync));
    // Tasks' problems → squiggles in open files (each owner replaces its own set).
    let owners = new Set<string>();
    sub.add(
      effect(() => {
        const all = services.problems.all.value;
        for (const owner of owners) if (!all.has(owner)) engine.setExternalDiagnostics(owner, []);
        for (const [owner, list] of all)
          engine.setExternalDiagnostics(
            owner,
            list.map((p) => ({ ...p, external: true })),
          );
        owners = new Set(all.keys());
        sync();
        return undefined;
      }),
    );
    // Closing a file hides its built-in checkers' problems (its model may live on for undo).
    sub.add(editors.onDidChangeText(sync));
    sub.add({ dispose: () => cancelAnimationFrame(frame) });
    sync();
  });
  registerProblemDecorations(sub, services, diagnostics);
  const count = (severity: DiagnosticSeverity) =>
    diagnostics.value.filter((d) => d.severity === severity).length;
  const rel = (path: string) => {
    // With several folders a path starts with its folder's name (D251).
    return workspace.root.peek() ? workspace.relative(path).replaceAll("\\", "/") : path;
  };

  sub.add(dock.views.register(problemsViewDescriptor(services, diagnostics, rel)));
  sub.add(
    statusBar.add({
      id: "problems",
      name: "Problems",
      alignment: "left",
      priority: 50,
      text: () => `$(circle-x) ${count("error")}  $(triangle-alert) ${count("warning")}`,
      tooltip: () => "Problems",
      command: "problems.show",
    }),
  );

  sub.add(
    dispatcher.register({
      id: "problems.show",
      title: "Show problems",
      category: "View",
      description: "Opens the problems tab (diagnostics of open files).",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: () => {
        dock.openView("problems", null, "bottom", true);
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "problems.list",
      title: "List problems",
      category: "View",
      description:
        "Returns errors and warnings from the language services for open files (TS/JS, JSON, CSS, HTML, language servers), from language servers that report the whole workspace (workspace/diagnostic: files not open too) and from tasks' problem matchers (any file, e.g. after tasks.run of a build), optionally for one file or severity.",
      input: s.object({
        path: s.string().describe("Only this file (absolute or relative)").optional(),
        severity: s.enum(["error", "warning", "info"]).describe("Only this severity").optional(),
        limit: s.integer({ min: 1, max: 1000 }).describe("Max items (default 100)").optional(),
      }),
      effects: ["read"],
      agent: "core",
      run: ({ path, severity, limit }) => {
        const wanted = path?.replaceAll("\\", "/");
        const items = diagnostics
          .peek()
          .filter((d) => !severity || d.severity === severity)
          .filter(
            (d) => !wanted || rel(d.path) === wanted || d.path.replaceAll("\\", "/") === wanted,
          )
          .slice(0, limit ?? 100)
          .map((d) => ({ ...d, path: rel(d.path) }));
        return { total: diagnostics.peek().length, items };
      },
    }),
  );
  const target = {
    path: s.string().describe("Only this file (absolute or relative)").optional(),
    line: s.integer({ min: 1 }).describe("Only problems on this line").optional(),
    column: s.integer({ min: 1 }).describe("Only problems at this column").optional(),
    message: s.string().describe("Only problems with exactly this message").optional(),
  };
  const pick = (input: { path?: string; line?: number; column?: number; message?: string }) => {
    const items = matchProblems(diagnostics.peek(), input, rel);
    if (!items.length) throw new Error("No matching problems.");
    return items;
  };
  sub.add(
    dispatcher.register({
      id: "problems.copy",
      title: "Copy problems",
      category: "View",
      description:
        "Copies problems to the clipboard, one per line as `path:line:column - severity source(code): message` (format `message`: the messages only). Without input: every problem; `path`: one file's; `path`+`line`(+`column`, `message`): one.",
      input: s.object({
        ...target,
        format: s
          .enum(["full", "message"])
          .describe("Whole line (default) or message only")
          .optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ format, ...where }) => {
        const items = pick(where);
        const text = items
          .map((d) => (format === "message" ? d.message : formatProblem(d, rel)))
          .join("\n");
        await clipboardIpc.writeText(text);
        services.notifications.show(
          "info",
          items.length === 1 ? "Copied the problem." : `Copied ${items.length} problems.`,
        );
        return { copied: items.length };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "problems.fixWithAgent",
      title: "Fix problems with agent",
      category: "View",
      description:
        "Sends problems (same selection as problems.copy: all, one file's or one) to the agent to fix. The active chat if it's idle, else a new one.",
      input: s.object(target),
      effects: [],
      agent: "hidden",
      run: async (where) => {
        const items = pick(where).slice(0, 50);
        const message = fixPrompt(items, rel);
        try {
          await dispatcher.execute("agent.send", { message, wait: false });
        } catch (err) {
          // The active chat is busy: a new one (like terminal.fixWithAgent).
          if (!/still working/i.test(err instanceof Error ? err.message : String(err))) throw err;
          await dispatcher.execute("agent.newSession");
          await dispatcher.execute("agent.send", { message, wait: false });
        }
        return { sent: items.length };
      },
    }),
  );
  sub.add(
    state.register("ide://diagnostics", {
      description:
        "Diagnostics (errors, warnings, info) for open files: counts and items with relative path, line, column, message, source and code.",
      get: ({ budget }) => {
        const all = diagnostics.peek();
        const max = budget > 4000 ? 200 : 50;
        return {
          counts: {
            errors: all.filter((d) => d.severity === "error").length,
            warnings: all.filter((d) => d.severity === "warning").length,
            total: all.length,
          },
          items: all.slice(0, max).map((d) => ({ ...d, path: rel(d.path) })),
        };
      },
    }),
  );
  return diagnostics;
}
