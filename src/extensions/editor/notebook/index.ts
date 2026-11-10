// Notebooks (D188): the "notebook" dock view for every notebook type (Jupyter's .ipynb is built
// in, D204; extensions add theirs), its commands (every button and key runs one; agents read,
// edit and run notebooks with the same), `ide://notebook`, kernel completions and hovers in
// cells, and the kernel each notebook last used (remembered per folder).

import { fromNotebookData } from "../../../core/extensions/rpcNotebooks";
import { fsIpc } from "../../../core/ipc/fs";
import type { DisposableStore } from "../../../core/lifecycle/index";
import { parseIpynb, serializeIpynb } from "../../../core/notebook/ipynb";
import { outputImages, readOutput } from "../../../core/notebook/nbformat";
import {
  INTERACTIVE_NOTEBOOK,
  JUPYTER_NOTEBOOK,
  type KernelOption,
} from "../../../core/notebook/providers";
import { basename, joinPath } from "../../../core/paths/index";
import { effect } from "../../../core/reactive/index";
import { s } from "../../../core/schema/index";
import { confirmAction } from "../../../ui/Dialog";
import { fileIconTint } from "../../../ui/fileTint";
import { fileIcon } from "../../../ui/Icon";
import type { DockViewDescriptor } from "../../../workbench/dock/views";
import { stateField } from "../../../workbench/dock/views";
import type { LanguageFeature } from "../../../workbench/extensionFeatures";
import type { WorkbenchServices } from "../../../workbench/services";
import type { EditorService } from "../service";
import { isUntitled } from "../untitled";
import { registerCellCommands } from "./cellCommands";
import { registerNotebookHotExit } from "./hotExit";
import { rememberedOption } from "./jupyter";
import { registerKernelCommands } from "./kernelPicker";
import { type CellKind, emptyNotebook, type NbCell, newCell, outputText, toScript } from "./model";
import { registerNotebookNavigation } from "./navigation";
import {
  cellIdsInput,
  moveCells,
  registerSelectionCommands,
  setKinds,
  targetCells,
} from "./selectionCommands";
import {
  findNotebook,
  NotebookView,
  notebookClipboard,
  notebookName,
  openNotebooks,
  untitledStart,
} from "./view";

export const NOTEBOOK_VIEW = "notebook";

export function registerNotebooks(
  sub: DisposableStore,
  services: WorkbenchServices,
  editors: EditorService,
): LanguageFeature {
  const { dispatcher, dock, persistence, workspace } = services;
  // Jupyter's .ipynb is built in (D204, like VS Code's ipynb extension): any notebook opens, edits
  // and saves without an extension. Kernels come from kernel sources (the built-in Jupyter
  // extension's, off until turned on; others'), other formats from extensions.
  sub.add(
    services.notebooks.registerType({
      id: JUPYTER_NOTEBOOK,
      label: "Jupyter notebook",
      extensions: [".ipynb"],
      owner: "builtin",
      opensByDefault: true,
      serializer: { deserialize: parseIpynb, serialize: serializeIpynb },
    }),
  );
  // VS Code's Interactive Window (its `interactive` notebook type: Jupyter's "Run in
  // Interactive Window", `# %%` cells of a .py file): an untitled notebook the extension adds
  // cells to and runs (interactive.open in the `vscode` shim). Saved, it's a Jupyter notebook.
  sub.add(
    services.notebooks.registerType({
      id: INTERACTIVE_NOTEBOOK,
      label: "Interactive window",
      extensions: [".interactive"],
      owner: "builtin",
      opensByDefault: false,
      serializer: { deserialize: parseIpynb, serialize: serializeIpynb },
    }),
  );
  // Every notebook type opens in the notebook editor (an extension's too).
  const viewerOf = new Map<string, { dispose(): void }>();
  const syncViewers = () => {
    const types = services.notebooks.allTypes();
    for (const [id, d] of viewerOf)
      if (!types.some((t) => t.id === id)) {
        d.dispose();
        viewerOf.delete(id);
      }
    for (const t of types)
      if (!viewerOf.has(t.id))
        viewerOf.set(
          t.id,
          services.viewers.register({
            id: t.id === JUPYTER_NOTEBOOK ? "notebook" : `notebook:${t.id}`,
            label: t.label,
            viewType: NOTEBOOK_VIEW,
            extensions: t.extensions,
            // An extension's format only opens its files when it says so (else Reopen with…,
            // D204: no "Open preview" button on files that are usually text, like .py).
            kind: t.opensByDefault ? "default" : "option",
          }),
        );
  };
  syncViewers();
  sub.add(services.notebooks.onDidChange(syncViewers));
  sub.add({
    dispose: () => {
      for (const d of viewerOf.values()) d.dispose();
      viewerOf.clear();
    },
  });

  const kernels = new Map<string, KernelOption>();
  sub.add(
    persistence.register("notebook.kernels", {
      save: () => Object.fromEntries(kernels),
      restore: (data) => {
        kernels.clear();
        if (data && typeof data === "object")
          for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
            if (!v || typeof v !== "object") continue;
            const option = rememberedOption(v);
            if (option) kernels.set(k, option);
          }
      },
    }),
  );
  let quietDepth = 0;
  const deps = {
    quiet: () => quietDepth > 0,
    services,
    editors,
    rememberedKernel: (path: string) => kernels.get(path),
    rememberKernel: (path: string, option: KernelOption) => {
      kernels.set(path, option);
      persistence.scheduleSave();
    },
  };
  const pathOf = (state: unknown) => String(stateField(state as never, "path") ?? "");
  const descriptor: DockViewDescriptor = {
    type: NOTEBOOK_VIEW,
    title: (state) => notebookName(pathOf(state)),
    icon: (state) => fileIcon(basename(pathOf(state))),
    tint: (state) => fileIconTint(basename(pathOf(state))),
    resource: (state) => pathOf(state) || undefined,
    tooltip: (state) => pathOf(state),
    defaultPlacement: "main",
    editorLike: true,
    // One view per notebook: two would edit two copies.
    duplicate: () => null,
    create: (state, ctx) => new NotebookView(pathOf(state), ctx, deps),
  };
  sub.add(dock.views.register(descriptor));
  // Where an open notebook's cell is (an extension's diagnostics for a cell document land there).
  sub.add(
    services.notebooks.registerCellLocator((path, cellId) => {
      const i = findNotebook(path)?.cells.findIndex((c) => c.cell.id === cellId) ?? -1;
      return i >= 0 ? i : undefined;
    }),
  );

  // `activeNotebook`: the active tab is a notebook (its keybindings, menus).
  sub.add(
    effect(() => {
      dock.root.value;
      dock.focusedGroupId.value;
      services.context.set("activeNotebook", dock.activeTab()?.viewType === NOTEBOOK_VIEW);
      return undefined;
    }),
  );

  /**
   * A path as the notebook views spell theirs (relative to the folder, or with several maybe
   * starting with a folder's name, D251; "C:/x" as "C:\\x").
   */
  // An untitled notebook's path is a name, not a file's (D267).
  const resolve = (path: string) =>
    isUntitled(path) || !workspace.root.peek() ? path : workspace.resolve(path);

  /** The notebook a command is for: `path` (opened if needed), else the active tab's. */
  const target = async (path?: string): Promise<NotebookView> => {
    if (path) {
      const full = resolve(path);
      let view = findNotebook(full);
      if (!view && isUntitled(full)) throw new Error(`${path} isn't open.`);
      if (!view) {
        await dispatcher.execute("editor.openFile", { path: full, preview: false });
        for (let i = 0; i < 60 && !findNotebook(full); i++)
          await new Promise((r) => setTimeout(r, 50));
        view = findNotebook(full);
      }
      if (!view) throw new Error(`${path} didn't open as a notebook.`);
      await view.whenLoaded();
      if (view.error) throw new Error(view.error);
      return view;
    }
    const tab = dock.activeTab();
    const live = tab?.viewType === NOTEBOOK_VIEW ? dock.liveView(tab.id) : undefined;
    if (live instanceof NotebookView) {
      await live.whenLoaded();
      // A notebook that couldn't be read can't be changed (its save would do nothing).
      if (live.error) throw new Error(live.error);
      return live;
    }
    throw new Error("No notebook is active: give `path`, or open an .ipynb file.");
  };
  const cellIndex = (view: NotebookView, input: { cellId?: string; index?: number }) => {
    const i = input.index ?? view.indexOf(input.cellId);
    if (i < 0 || i >= view.cells.length)
      throw new Error(`No cell ${input.cellId ?? input.index} (it has ${view.cells.length}).`);
    return i;
  };
  const register: typeof dispatcher.register = (c) =>
    sub.add(
      dispatcher.register({
        category: "Notebook",
        ...c,
        // An agent editing a notebook doesn't take the keyboard from the user.
        run: async (input, ctx) => {
          const quiet = ctx.caller.kind !== "user";
          if (quiet) quietDepth++;
          try {
            return await c.run(input as never, ctx);
          } finally {
            if (quiet) quietDepth--;
          }
        },
      } as typeof c),
    );
  const where = {
    path: s.string().describe("The .ipynb file (default: the active notebook)").optional(),
    cellId: s.string().describe("A cell's id (ide://notebook lists them)").optional(),
    index: s.integer({ min: 0 }).describe("A cell's position, from 0").optional(),
  };

  // ---- Find, go to cell, outline (D204) ----
  registerNotebookNavigation(register, target);
  // Kernels: the picker, enabling the Jupyter extension (D204).
  registerKernelCommands(register, target, services);
  // Join, copy down, line numbers, language, metadata, the source toggle (D204).
  registerCellCommands(register, target, services, editors, NOTEBOOK_VIEW);
  // Several cells: selecting them, joining them (D209).
  registerSelectionCommands(register, target);
  const several = { ...where, cellIds: cellIdsInput };

  // ---- Running ----
  register({
    id: "notebook.runCell",
    title: "Run cell",
    description:
      "Runs a notebook cell on its kernel (starting one: the notebook's remembered kernel, else the best one its kernel sources find; with none, the user picks, or an agent is told what's missing) and waits for it. Returns its outputs as text. Several selected cells (or `cellIds`) run in order, stopping at the first error. `advance`: then select the next cell (adding one at the end); `insertBelow`: then add a cell below. `images`: a single cell's PNG / JPEG / GIF / WebP outputs too, as base64 (`images: [{ mimeType, data }]`, at most 4).",
    input: s.object({
      ...several,
      advance: s.boolean().optional(),
      insertBelow: s.boolean().optional(),
      images: s.boolean().optional(),
    }),
    effects: ["exec"],
    agent: "discoverable",
    run: async (input) => {
      const view = await target(input.path);
      const picked = targetCells(view, input);
      const i = picked[picked.length - 1] ?? view.selected;
      const cell = view.cells[i];
      if (!cell) throw new Error("No cell.");
      const list = picked.map((j) => view.cells[j]).filter((c) => c !== undefined);
      if (input.advance) {
        // The next cell, in command mode; at the end a new cell to type in.
        if (i === view.cells.length - 1) view.insertCell(i + 1, "code", "", true);
        else {
          view.mode = "command";
          view.select(i + 1, true);
        }
      } else if (input.insertBelow) view.insertCell(i + 1, "code", "", true);
      const run = view.runCells(list);
      if (input.advance || input.insertBelow) {
        void run.catch((err: unknown) =>
          services.notifications.show("error", err instanceof Error ? err.message : String(err)),
        );
        return { cellId: cell.cell.id, started: true };
      }
      if (list.length > 1) {
        const r = await run;
        return {
          ran: r.ran,
          ...(r.failed && {
            failedCellId: r.failed.cell.id,
            error: outputText(r.failed.cell.outputs, 2000),
          }),
        };
      }
      await run;
      return {
        cellId: cell.cell.id,
        status: cell.runState,
        executionCount: cell.cell.executionCount,
        output: outputText(cell.cell.outputs),
        // For Claude Code's executeCode (D222): images as MCP image content.
        ...(input.images && { images: outputImages(cell.cell.outputs) }),
      };
    },
  });
  const runRange = (id: string, title: string, pick: (v: NotebookView, i: number) => number[]) =>
    register({
      id,
      title,
      description: `${title} of a notebook, in order, stopping at the first error. Returns how many ran and the failing cell's output.`,
      input: s.object(where),
      effects: ["exec"],
      agent: "discoverable",
      run: async (input) => {
        const view = await target(input.path);
        const i =
          input.cellId !== undefined || input.index !== undefined
            ? cellIndex(view, input)
            : view.selected;
        const list = pick(view, i)
          .map((j) => view.cells[j])
          .filter((c) => c !== undefined);
        const r = await view.runCells(list);
        return {
          ran: r.ran,
          ...(r.failed && {
            failedCellId: r.failed.cell.id,
            error: outputText(r.failed.cell.outputs, 2000),
          }),
        };
      },
    });
  runRange("notebook.runAll", "Run all cells", (v) => v.cells.map((_, j) => j));
  runRange("notebook.runAbove", "Run the cells above", (_, i) => [...Array(i).keys()]);
  runRange("notebook.runBelow", "Run this cell and the ones below", (v, i) =>
    v.cells.map((_, j) => j).filter((j) => j >= i),
  );
  register({
    id: "notebook.interrupt",
    title: "Interrupt the kernel",
    description: "Stops the running cell (KeyboardInterrupt) and the ones waiting.",
    input: s.object({ path: where.path, cellId: where.cellId }),
    effects: [],
    agent: "discoverable",
    run: async ({ path }) => {
      (await target(path)).interrupt();
      return { interrupted: true };
    },
  });
  register({
    id: "notebook.restart",
    title: "Restart the kernel",
    description: "Starts the kernel afresh: variables and imports are gone.",
    input: s.object({ path: where.path, cellId: where.cellId }),
    effects: ["exec"],
    agent: "discoverable",
    run: async ({ path }) => {
      await (await target(path)).restart();
      return { restarted: true };
    },
  });
  register({
    id: "notebook.restartAndRunAll",
    title: "Restart the kernel and run all",
    description: "Restarts the kernel, then runs every cell.",
    input: s.object({ path: where.path }),
    effects: ["exec"],
    agent: "discoverable",
    run: async ({ path }) => {
      const view = await target(path);
      await view.restart();
      const r = await view.runCells(view.cells);
      return { ran: r.ran, ...(r.failed && { failedCellId: r.failed.cell.id }) };
    },
  });
  // ---- Cells ----
  register({
    id: "notebook.insertCell",
    title: "Insert code cell",
    description:
      "Adds a cell below the selected one (or `where: above`, or at `index`). `kind`: code (default), markdown or raw; `source`: its text; `metadata`, `outputs` (nbformat, a code cell's) and `executionCount` as it should already have them (D267: an extension's NotebookEdit). Returns its id.",
    input: s.object({
      ...where,
      where: s.enum(["above", "below"]).optional(),
      kind: s.enum(["code", "markdown", "raw"]).optional(),
      source: s.string().optional(),
      metadata: s.unknown().describe("An object: the cell's metadata").optional(),
      outputs: s.array(s.unknown(), { maxItems: 1000 }).optional(),
      executionCount: s.integer({ min: 0 }).optional(),
    }),
    effects: ["write"],
    agent: "discoverable",
    run: async (input) => {
      const view = await target(input.path);
      const base =
        input.index !== undefined
          ? input.index
          : view.indexOf(input.cellId) + (input.where === "above" ? 0 : 1);
      const at = input.index !== undefined ? input.index : Math.max(0, base);
      const edit = input.source === undefined;
      const kind = (input.kind ?? "code") as CellKind;
      const outputs =
        kind === "code" ? (input.outputs ?? []).flatMap((o) => readOutput(o) ?? []) : [];
      // What it already has (an extension's cell with outputs) goes in with it, as one step.
      const metadata =
        input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
          ? (input.metadata as Record<string, unknown>)
          : undefined;
      const from =
        metadata || outputs.length || input.executionCount !== undefined
          ? {
              ...newCell(kind, input.source ?? ""),
              metadata: metadata ?? {},
              outputs,
              executionCount: kind === "code" ? (input.executionCount ?? null) : null,
            }
          : undefined;
      const cell = view.insertCell(at, kind, input.source ?? "", edit, from);
      return { cellId: cell.cell.id, index: view.cells.indexOf(cell) };
    },
  });
  register({
    id: "notebook.insertMarkdown",
    title: "Insert Markdown cell",
    description: "Adds a Markdown cell below the selected one.",
    input: s.object(where),
    effects: ["write"],
    run: async (input) => {
      const view = await target(input.path);
      const cell = view.insertCell(view.indexOf(input.cellId) + 1, "markdown", "", true);
      return { cellId: cell.cell.id };
    },
  });
  register({
    id: "notebook.editCell",
    title: "Edit cell",
    description:
      "With `source`: replaces a cell's text (undoable). Without: puts the cursor in the cell (a Markdown cell shows its text).",
    input: s.object({ ...where, source: s.string().optional() }),
    effects: ["write"],
    agent: "discoverable",
    run: async (input) => {
      const view = await target(input.path);
      const i = cellIndex(view, input);
      if (input.source !== undefined) {
        view.setSource(i, input.source);
        return { cellId: view.cells[i]?.cell.id };
      }
      view.editAt(i);
      return { cellId: view.cells[i]?.cell.id };
    },
  });
  register({
    id: "notebook.deleteCell",
    title: "Delete cell",
    description:
      "Deletes a cell, or the selected cells (or `cellIds`) (Z or notebook.undo brings them back).",
    input: s.object(several),
    effects: ["write"],
    agent: "discoverable",
    run: async (input) => {
      const view = await target(input.path);
      view.deleteCells(targetCells(view, input));
      return { cells: view.cells.length };
    },
  });
  register({
    id: "notebook.moveCell",
    title: "Move cell",
    description:
      "Moves a cell up (`by: -1`) or down (`by: 1`); several selected cells (or `cellIds`) move together, each past its neighbour.",
    input: s.object({ ...several, by: s.integer({ min: -1000, max: 1000 }) }),
    effects: ["write"],
    agent: "discoverable",
    run: async (input) => {
      const view = await target(input.path);
      const picked = targetCells(view, input);
      if (picked.length > 1) moveCells(view, picked, input.by);
      else view.moveCell(picked[0] ?? view.selected, input.by);
      return { index: view.selected };
    },
  });
  register({
    id: "notebook.changeCellType",
    title: "Change cell type",
    description:
      "Makes a cell, or the selected cells (or `cellIds`), code, markdown or raw (their outputs are cleared).",
    input: s.object({ ...several, kind: s.enum(["code", "markdown", "raw"]) }),
    effects: ["write"],
    agent: "discoverable",
    run: async (input) => {
      const view = await target(input.path);
      setKinds(view, targetCells(view, input), input.kind as CellKind);
      return { kind: input.kind };
    },
  });
  register({
    id: "notebook.splitCell",
    title: "Split cell at the cursor",
    description: "Splits the cell being edited at the cursor's line (Ctrl+Shift+-).",
    input: s.object(where),
    effects: ["write"],
    run: async (input) => {
      const view = await target(input.path);
      view.splitCell(cellIndex(view, input));
      return {};
    },
  });
  register({
    id: "notebook.clearOutputs",
    title: "Clear cell output",
    description: "Clears a cell's outputs (or the selected cells', or `cellIds`').",
    input: s.object(several),
    effects: ["write"],
    agent: "discoverable",
    run: async (input) => {
      const view = await target(input.path);
      view.clearOutputs(targetCells(view, input));
      return {};
    },
  });
  register({
    id: "notebook.clearAllOutputs",
    title: "Clear all outputs",
    description: "Clears every cell's outputs.",
    input: s.object({ path: where.path }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ path }) => {
      const view = await target(path);
      view.clearOutputs(view.cells.map((_, i) => i));
      return {};
    },
  });
  register({
    id: "notebook.toggleOutput",
    title: "Collapse or expand output",
    description: "Hides or shows a cell's outputs.",
    input: s.object(where),
    effects: [],
    run: async (input) => {
      const view = await target(input.path);
      const c = view.cells[cellIndex(view, input)];
      if (c) {
        c.outputsCollapsed = !c.outputsCollapsed;
        c.renderOutputs();
      }
      return {};
    },
  });
  for (const [id, redo] of [
    ["notebook.undo", false],
    ["notebook.redo", true],
  ] as const)
    register({
      id,
      title: redo ? "Redo cell operation" : "Undo cell operation",
      description: `${redo ? "Redoes" : "Undoes"} the last cell operation (add, delete, move, type, clear, an agent's edit).`,
      input: s.object({ path: where.path, cellId: where.cellId }),
      effects: ["write"],
      run: async ({ path }) => ({ done: (await target(path)).undo(redo) }),
    });
  register({
    id: "notebook.copyCell",
    title: "Copy cell",
    description:
      "Copies the selected cells (or `cellId` / `cellIds`) (V pastes them); their text goes to the clipboard too.",
    input: s.object(several),
    effects: [],
    run: async (input) => {
      const view = await target(input.path);
      const list = targetCells(view, input).flatMap((i) => view.cells[i] ?? []);
      if (!list.length) return {};
      notebookClipboard.cells = list.map((c) => JSON.parse(JSON.stringify(c.cell)) as NbCell);
      const text = list.map((c) => c.cell.source).join("\n\n");
      void dispatcher.execute("ui.copyText", { text }).catch(() => {});
      return { copied: list.length };
    },
  });
  register({
    id: "notebook.cutCell",
    title: "Cut cell",
    description: "Copies the selected cells (or `cellId` / `cellIds`) and deletes them.",
    input: s.object(several),
    effects: ["write"],
    run: async (input) => {
      const view = await target(input.path);
      const picked = targetCells(view, input);
      const list = picked.flatMap((i) => view.cells[i] ?? []);
      if (!list.length) return {};
      notebookClipboard.cells = list.map((c) => JSON.parse(JSON.stringify(c.cell)) as NbCell);
      view.deleteCells(picked);
      return { cut: list.length };
    },
  });
  register({
    id: "notebook.pasteCell",
    title: "Paste cell",
    description: "Pastes copied cells below the selected one.",
    input: s.object(where),
    effects: ["write"],
    run: async (input) => {
      const view = await target(input.path);
      // Below the cell, or the last of the selected cells.
      let at =
        (input.cellId !== undefined
          ? view.indexOf(input.cellId)
          : (view.selectedIndexes().pop() ?? view.selected)) + 1;
      const cells = notebookClipboard.cells;
      for (const c of cells) view.insertCell(at++, c.kind, c.source, false, c);
      return { pasted: cells.length };
    },
  });

  // ---- The notebook ----
  register({
    id: "notebook.save",
    title: "Save notebook",
    description: "Saves the notebook (.ipynb, nbformat 4) with its outputs.",
    input: s.object({ path: where.path }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ path }) => {
      const view = await target(path);
      await view.save();
      return { saved: view.path };
    },
  });
  register({
    id: "notebook.toggleVariables",
    title: "Show variables",
    description: "Shows or hides the kernel's variables beside the cells.",
    input: s.object({ path: where.path }),
    effects: [],
    run: async ({ path }) => {
      (await target(path)).toggleVariables();
      return {};
    },
  });
  register({
    id: "notebook.variables",
    title: "List kernel variables",
    description:
      "The running kernel's variables: name, type, size and a short value (Python kernels).",
    input: s.object({ path: where.path }),
    effects: ["read"],
    agent: "discoverable",
    run: async ({ path }) => {
      const view = await target(path);
      if (!view.kernel) return { variables: [], note: "No kernel is running: run a cell first." };
      await view.refreshVariables();
      return { variables: view.variables ?? [] };
    },
  });
  register({
    id: "notebook.read",
    title: "Read notebook",
    description:
      "A notebook's cells: id, kind, source, execution count and outputs as text (images by type). Opens it if needed. `metadata`: the notebook's and each cell's metadata and language too; `outputs`: each code cell's outputs as nbformat (`outputs`, images as base64) besides the text.",
    input: s.object({
      path: where.path,
      metadata: s.boolean().optional(),
      outputs: s.boolean().optional(),
    }),
    effects: ["read"],
    agent: "discoverable",
    run: async ({ path, metadata, outputs }) => {
      const view = await target(path);
      // The file's own fields besides metadata (VS Code's ipynb layout gives extensions them).
      const nb = metadata ? view.toNotebook() : null;
      return {
        path: view.path,
        type: view.notebookType,
        kernel: view.kernel?.info.peek()?.display ?? null,
        ...(metadata && { metadata: view.metadata }),
        ...(nb && { nbformat: nb.nbformat, nbformatMinor: nb.nbformatMinor }),
        cells: view.cells.map((c, i) => ({
          index: i,
          id: c.cell.id,
          kind: c.cell.kind,
          source: c.cell.source,
          ...(metadata && { metadata: c.cell.metadata, language: c.language() }),
          ...(metadata &&
            c.cell.extra.attachments !== undefined && { attachments: c.cell.extra.attachments }),
          ...(c.cell.kind === "code" && {
            executionCount: c.cell.executionCount,
            output: outputText(c.cell.outputs, 2000),
            ...(outputs && { outputs: c.cell.outputs }),
          }),
        })),
      };
    },
  });
  register({
    id: "notebook.exportScript",
    title: "Export as script",
    description:
      "Writes the notebook as a script beside it (Python: name.py with # %% cells) and opens it. An existing script is kept unless `overwrite` (the user is asked).",
    input: s.object({ path: where.path, overwrite: s.boolean().optional() }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ path, overwrite }, ctx) => {
      const view = await target(path);
      const ext =
        view.language() === "python"
          ? "py"
          : view.language() === "r"
            ? "r"
            : view.language() === "julia"
              ? "jl"
              : "txt";
      const out = `${view.path.replace(/\.[^./\\]+$/, "")}.${ext}`;
      const exists = await fsIpc.stat(out).then(
        () => true,
        () => false,
      );
      if (exists && !overwrite) {
        const ok =
          ctx.caller.kind === "user" &&
          (await confirmAction(
            "Replace the script?",
            `${basename(out)} already exists beside the notebook.`,
            "Replace",
          ));
        if (!ok)
          throw new Error(`${basename(out)} already exists (pass overwrite: true to replace it).`);
      }
      await fsIpc.write(out, new TextEncoder().encode(toScript(view.toNotebook())), "save");
      services.events.emit("files.didCreate", { path: out, kind: "file" });
      await dispatcher.execute("editor.openFile", { path: out });
      return { path: out };
    },
  });
  /** Shows a notebook tab for `path` (an untitled one: it has no file to open). */
  const showTab = (path: string) => {
    const existing = dock
      .tabs(NOTEBOOK_VIEW)
      .find((t) => String(stateField(t.viewState as never, "path") ?? "") === path);
    if (existing) {
      dock.activateTab(existing.id, true);
      return existing.id;
    }
    const group = dock.focusedGroup();
    return dock.openView(
      NOTEBOOK_VIEW,
      { path },
      group?.tabs.some(dock.isEditorLike) ? { groupId: group.id } : "main",
      true,
    );
  };
  register({
    id: "notebook.newUntitled",
    title: "New untitled notebook",
    description:
      "Opens a notebook with no file yet (VS Code's untitled notebook, D267): it's saved where the user picks on the first save. `type`: a notebook type (default jupyter.notebook); `notebook`: its cells to start with ({ cells: [{ kind, source, metadata?, outputs?, executionCount? }], metadata? }, as extensions' serializers give them). With `path` (an untitled notebook already open), shows that one. Returns its path (untitled:Untitled-N.ipynb).",
    input: s.object({
      type: s.string().describe("Notebook type id (default: jupyter.notebook)").optional(),
      notebook: s.unknown().describe("The cells to start with").optional(),
      path: s.string().describe("An open untitled notebook to show").optional(),
    }),
    effects: [],
    agent: "discoverable",
    run: async ({ type, notebook, path }) => {
      if (path) {
        if (!isUntitled(path) || !findNotebook(path)) throw new Error(`${path} isn't open.`);
        showTab(path);
        return { path };
      }
      const format = services.notebooks.type(type ?? JUPYTER_NOTEBOOK);
      if (!format) throw new Error(`No notebook type ${type} (is its extension enabled?).`);
      const dot = format.extensions[0] ?? ".ipynb";
      const taken = new Set(
        dock.tabs(NOTEBOOK_VIEW).map((t) => String(stateField(t.viewState as never, "path") ?? "")),
      );
      let n = 1;
      while (taken.has(`untitled:Untitled-${n}${dot}`)) n++;
      const untitled = `untitled:Untitled-${n}${dot}`;
      if (notebook !== undefined) untitledStart.set(untitled, fromNotebookData(notebook));
      showTab(untitled);
      for (let i = 0; i < 60 && !findNotebook(untitled); i++)
        await new Promise((r) => setTimeout(r, 50));
      await findNotebook(untitled)?.whenLoaded();
      return { path: untitled };
    },
  });
  register({
    id: "notebook.new",
    title: "New Jupyter notebook",
    description:
      "Creates an empty notebook (default: Untitled.ipynb in the open folder, numbered when taken) and opens it. `type`: another notebook type (an extension's, see ide://notebook types), written by its format.",
    input: s.object({
      path: s.string().optional(),
      type: s.string().describe("Notebook type id (default: jupyter.notebook)").optional(),
    }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ path, type }) => {
      const root = workspace.root.peek();
      if (!root) throw new Error("Open a folder first.");
      const format = services.notebooks.type(type ?? JUPYTER_NOTEBOOK);
      if (!format) throw new Error(`No notebook type ${type} (is its extension enabled?).`);
      const dot = format.extensions[0] ?? ".ipynb";
      let full = path ? resolve(path.toLowerCase().endsWith(dot) ? path : `${path}${dot}`) : "";
      if (
        full &&
        (await fsIpc.stat(full).then(
          () => true,
          () => false,
        ))
      )
        throw new Error(`${basename(full)} already exists: open it, or pick another name.`);
      if (!full)
        for (let n = 1; n < 1000; n++) {
          const candidate = joinPath(root, n === 1 ? `Untitled${dot}` : `Untitled-${n}${dot}`);
          const taken = await fsIpc.stat(candidate).then(
            () => true,
            () => false,
          );
          if (!taken) {
            full = candidate;
            break;
          }
        }
      const text = await format.serializer.serialize(emptyNotebook());
      await fsIpc.write(full, new TextEncoder().encode(text), "save");
      services.events.emit("files.didCreate", { path: full, kind: "file" });
      await dispatcher.execute("editor.openFile", { path: full, preview: false });
      return { path: full };
    },
  });

  // Closing the folder or the window: unsaved notebooks are asked about, like text files; closing
  // the window keeps them instead (hot exit, hotExit.ts).
  registerNotebookHotExit(sub, services, () => openNotebooks.values());
  // Kernels stop once the folder has closed (not when a later prompt cancels the close).
  sub.add(
    workspace.onDidClose(() => {
      for (const view of openNotebooks.values()) void view.kernel?.shutdown();
    }),
  );

  // ---- State ----
  sub.add(
    services.state.register("ide://notebook", {
      description:
        "The notebook types (formats) available, extensions' output renderers, and the active notebook: its path, type, kernel (name, status), selected cell, and cells (id, kind, language, first line, execution count, whether it has output; notebook.read gives the full text).",
      get: () => {
        const tab = dock.activeTab();
        const view = tab?.viewType === NOTEBOOK_VIEW ? dock.liveView(tab.id) : undefined;
        // The formats and kernel sources there are (D202: the IDE's and extensions').
        const types = services.notebooks.allTypes().map((t) => ({
          id: t.id,
          label: t.label,
          extensions: t.extensions,
          owner: t.owner,
        }));
        // Extensions' output renderers (D204).
        const renderers = services.notebooks.allRenderers().map((r) => ({
          id: r.id,
          owner: r.owner,
          mimeTypes: r.mimeTypes,
        }));
        // The notebooks' own paths: the map's keys are folded for lookup (lower case on
        // Windows), which agents and tests read as a different path.
        const openPaths = () => [...openNotebooks.values()].map((v) => v.path);
        if (!(view instanceof NotebookView))
          return { open: openPaths(), active: null, types, renderers };
        return {
          open: openPaths(),
          types,
          renderers,
          active: {
            path: view.path,
            type: view.notebookType,
            dirty: view.isDirty(),
            kernel: view.kernel
              ? {
                  name: view.kernel.info.peek()?.display ?? view.kernel.option.label,
                  status: view.kernel.status.peek(),
                  mode: view.kernel.info.peek()?.mode ?? null,
                }
              : null,
            selected: view.selected,
            // Several selected cells (D209); the focused one is `selected`.
            selection: view.selectedIndexes().map((i) => view.cells[i]?.cell.id),
            find: view.find.isOpen
              ? {
                  query: view.find.options.query,
                  matches: view.find.matches.length,
                  current: view.find.current,
                }
              : null,
            mode: view.mode,
            cells: view.cells.map((c) => ({
              id: c.cell.id,
              kind: c.cell.kind,
              language: c.language(),
              firstLine: c.cell.source.split("\n")[0]?.slice(0, 120) ?? "",
              executionCount: c.cell.executionCount,
              state: c.runState,
              outputs: c.cell.outputs.length,
            })),
          },
        };
      },
    }),
  );

  // Completions and hovers in cells, from the kernel (what's defined in it, like Jupyter).
  // A cell's document is "<notebook>.cell-<id>.<ext>": found by its id (ids are unique enough,
  // and the notebook may have been renamed since).
  const cellOf = (path: string) => {
    const id = /\.cell-([A-Za-z0-9_-]+)\.[A-Za-z0-9]+$/.exec(path)?.[1];
    if (!id) return null;
    for (const view of openNotebooks.values())
      for (const c of view.cells) if (c.cell.id === id) return { view, cell: c };
    return null;
  };
  const offset = (text: string, line: number, column: number) => {
    const lines = text.split("\n");
    let n = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) n += (lines[i]?.length ?? 0) + 1;
    return n + column - 1;
  };
  return {
    owner: "builtin.notebook",
    languages: ["*"],
    schemes: ["notebook-cell"],
    completion: {
      triggerCharacters: ["."],
      provide: async (ctx) => {
        const found = cellOf(ctx.path);
        const kernel = found?.view.kernel;
        if (
          !found ||
          !kernel ||
          kernel.status.peek() === "dead" ||
          kernel.status.peek() === "stopped"
        )
          return [];
        const text = found.cell.cell.source;
        const r = await kernel.complete(text, offset(text, ctx.line, ctx.column));
        if (!r) return [];
        const typed = ctx.word;
        return r.matches.slice(0, 100).map((m) => {
          const label = m.includes(".") ? (m.split(".").pop() ?? m) : m;
          return {
            label,
            insertText: label,
            kind: "variable" as const,
            detail: typed ? "kernel" : undefined,
          };
        });
      },
    },
    hover: async (ctx) => {
      const found = cellOf(ctx.path);
      const kernel = found?.view.kernel;
      if (!found || !kernel || !ctx.word || kernel.status.peek() === "busy") return null;
      const text = found.cell.cell.source;
      const doc = await kernel.inspect(text, offset(text, ctx.line, ctx.column));
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing ANSI escapes
      const plain = doc.replace(/\u001b\[[0-9;]*m/g, "").trim();
      return plain ? `\`\`\`\n${plain.slice(0, 3000)}\n\`\`\`` : null;
    },
  };
}
