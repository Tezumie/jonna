// Finding things in a notebook (D204): find and replace across cells (the find bar's commands),
// going to a cell, and the notebook's outline (Markdown headings and code cells, also in the
// Outline view). Agents use the same commands.
import type { Dispatcher } from "../../../core/dispatcher/index";
import type { NotebookOutlineEntry } from "../../../core/notebook/outline";
import { s } from "../../../core/schema/index";
import type { WorkbenchServices } from "../../../workbench/services";
import type { OutlineTarget } from "../outlineView";
import { NotebookView, notebookOutlineVersion } from "./view";

type Register = Dispatcher["register"];

const findOptions = {
  query: s.string().describe("Text (or pattern) to find").optional(),
  caseSensitive: s.boolean().optional(),
  wholeWord: s.boolean().optional(),
  regex: s.boolean().describe("`query` is a regular expression").optional(),
  outputs: s.boolean().describe("Search the outputs' text too (default false)").optional(),
  markdown: s.boolean().describe("Search Markdown cells (default true)").optional(),
  code: s.boolean().describe("Search code and raw cells (default true)").optional(),
};

const matchInfo = (view: NotebookView) => {
  const find = view.find;
  const m = find.matches[find.current];
  return {
    query: find.options.query,
    matches: find.matches.length,
    current: find.current,
    ...(find.error && { error: find.error }),
    ...(m && {
      match: {
        cellId: m.cellId,
        index: m.cellIndex,
        where: m.where,
        line: m.line,
        column: m.column,
        endLine: m.endLine,
        endColumn: m.endColumn,
      },
    }),
  };
};

/** The outline entries flattened for agents. */
function flatten(
  entries: readonly NotebookOutlineEntry[],
  depth = 0,
  out: { name: string; kind: string; cellId: string; index: number; depth: number }[] = [],
) {
  for (const e of entries) {
    out.push({
      name: e.name,
      kind: e.kind === "cell" ? "code" : "heading",
      cellId: e.cellId,
      index: e.line - 1,
      depth,
    });
    flatten(e.children, depth + 1, out);
  }
  return out;
}

export function registerNotebookNavigation(
  register: Register,
  target: (path?: string) => Promise<NotebookView>,
): void {
  const where = {
    path: s.string().describe("The notebook (default: the active one)").optional(),
    cellId: s.string().describe("A cell's id (ide://notebook lists them)").optional(),
    index: s.integer({ min: 0 }).describe("A cell's position, from 0").optional(),
  };
  register({
    id: "notebook.find",
    title: "Find in notebook",
    description:
      "Opens the notebook's find bar (Ctrl+F) and searches every cell's source (and with `outputs`, the outputs' text); highlights the matches and shows the nearest one. Options left out keep their last value. Returns the match count and the current match (cell, line, column).",
    input: s.object({
      path: where.path,
      ...findOptions,
      replace: s.boolean().describe("Show the replace field").optional(),
      focus: s.boolean().describe("Put the cursor in the find field (default true)").optional(),
    }),
    // Its matches tell what the cells say (an extension needs fs.read).
    effects: ["read"],
    agent: "discoverable",
    run: async (input, ctx) => {
      const view = await target(input.path);
      const { path: _path, ...rest } = input;
      view.openFind({ ...rest, focus: ctx.caller.kind === "user" && rest.focus !== false });
      return matchInfo(view);
    },
  });
  for (const [id, title, direction] of [
    ["notebook.findNext", "Find next in notebook", 1],
    ["notebook.findPrevious", "Find previous in notebook", -1],
  ] as const)
    register({
      id,
      title,
      description: `Moves to the ${direction === 1 ? "next" : "previous"} match of the notebook's find (wrapping around) and shows it. Returns the match.`,
      input: s.object({ path: where.path }),
      effects: ["read"],
      agent: "discoverable",
      run: async ({ path }) => {
        const view = await target(path);
        if (!view.find.isOpen) view.openFind({ focus: false });
        view.find.step(direction);
        return matchInfo(view);
      },
    });
  register({
    id: "notebook.replace",
    title: "Replace in notebook",
    description:
      "Replaces the current match of the notebook's find (in a cell's source; `regex` finds can use $1) and moves to the next. Undo with notebook.undo.",
    input: s.object({ path: where.path, replacement: s.string() }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ path, replacement }) => {
      const view = await target(path);
      if (!view.find.isOpen) throw new Error("Nothing is being found: run notebook.find first.");
      const replaced = view.find.replace(replacement);
      return { replaced, ...matchInfo(view) };
    },
  });
  register({
    id: "notebook.replaceAll",
    title: "Replace all in notebook",
    description:
      "Replaces every match of the notebook's find (or of `query`) in the cells' sources, as one undo step. Returns how many were replaced.",
    input: s.object({ path: where.path, replacement: s.string(), ...findOptions }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ path, replacement, ...options }) => {
      const view = await target(path);
      if (options.query !== undefined || !view.find.isOpen)
        view.openFind({ ...options, focus: false });
      const replaced = view.find.replaceAll(replacement);
      return { replaced, ...matchInfo(view) };
    },
  });
  register({
    id: "notebook.closeFind",
    title: "Close find in notebook",
    description: "Closes the notebook's find bar and clears its highlights.",
    input: s.object({ path: where.path }),
    effects: [],
    agent: "hidden",
    run: async ({ path }, ctx) => {
      const view = await target(path);
      view.closeFind(ctx.caller.kind === "user");
    },
  });
  register({
    id: "notebook.revealCell",
    title: "Go to cell",
    description:
      "Shows a notebook cell (scrolls to it and selects it); with `line` (and `column`), puts the cursor there in its editor. The Outline and Problems views use it.",
    input: s.object({
      ...where,
      line: s.integer({ min: 1 }).describe("Line in the cell (1-based)").optional(),
      column: s.integer({ min: 1 }).optional(),
    }),
    effects: [],
    agent: "discoverable",
    run: async (input, ctx) => {
      const view = await target(input.path);
      const i =
        input.index ?? (input.cellId !== undefined ? view.indexOf(input.cellId) : view.selected);
      if (i < 0 || i >= view.cells.length)
        throw new Error(`No cell ${input.cellId ?? input.index}.`);
      view.revealCell(
        i,
        input.line !== undefined ? { line: input.line, column: input.column ?? 1 } : undefined,
        ctx.caller.kind === "user",
      );
      return { index: i, cellId: view.cells[i]?.cell.id };
    },
  });
  register({
    id: "notebook.outline",
    title: "Notebook outline",
    description:
      "A notebook's outline, as the Outline view shows it: Markdown headings (nested by level) and code cells (by their first line), flattened with depth and cell index.",
    input: s.object({ path: where.path }),
    effects: ["read"],
    agent: "discoverable",
    run: async ({ path }) => {
      const view = await target(path);
      return { path: view.path, entries: flatten(view.outline()) };
    },
  });
}

/** The active notebook as the Outline view's target (null when the active tab isn't one). */
export function notebookOutlineTarget(services: WorkbenchServices): OutlineTarget | null {
  notebookOutlineVersion.value;
  const tab = services.dock.activeTab();
  const view = tab?.viewType === "notebook" ? services.dock.liveView(tab.id) : undefined;
  if (!(view instanceof NotebookView)) return null;
  return {
    path: view.path,
    doc: null,
    line: view.selected + 1,
    custom: {
      key: view,
      version: view.outlineVersion,
      symbols: async () => view.outline(),
      open: (symbol, preserveFocus) => {
        const entry = symbol as NotebookOutlineEntry;
        const i = view.indexOf(entry.cellId);
        if (i >= 0)
          view.revealCell(
            i,
            entry.kind === "string" ? undefined : { line: entry.cellLine, column: 1 },
            !preserveFocus,
          );
      },
    },
  };
}
