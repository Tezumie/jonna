// More notebook commands (D204, VS Code's cell menu and notebook surfaces): join cells, copy a cell
// down, line numbers, a cell's language, a Markdown cell's preview, notebook and cell metadata
// (for extensions and agents), and switching a notebook's tab between the notebook and its file's
// text (like the Markdown preview's toggle; VS Code's "Reopen editor with…").
import { s } from "../../../core/schema/index";
import { confirmSaveChanges } from "../../../ui/Dialog";
import type { QuickPickItem } from "../../../ui/QuickInput";
import { stateField } from "../../../workbench/dock/views";
import type { WorkbenchServices } from "../../../workbench/services";
import type { EditorService } from "../service";
import { NotebookView } from "./view";

type Register = WorkbenchServices["dispatcher"]["register"];
type Target = (path?: string) => Promise<NotebookView>;

const where = {
  path: s.string().describe("The notebook (default: the active one)").optional(),
  cellId: s.string().describe("A cell's id (ide://notebook lists them)").optional(),
  index: s.integer({ min: 0 }).describe("A cell's position, from 0").optional(),
};

const metadataPatch = s
  .unknown()
  .describe("An object: the keys to set (a value of null removes the key)");

export function registerCellCommands(
  register: Register,
  target: Target,
  services: WorkbenchServices,
  editors: EditorService,
  notebookViewType: string,
): void {
  const { dispatcher, dock, quickInput } = services;
  const cellIndex = (view: NotebookView, input: { cellId?: string; index?: number }) => {
    const i = input.index ?? view.indexOf(input.cellId);
    if (i < 0 || i >= view.cells.length)
      throw new Error(`No cell ${input.cellId ?? input.index} (it has ${view.cells.length}).`);
    return i;
  };

  register({
    id: "notebook.joinCells",
    title: "Join cells",
    description:
      "Joins a cell with the cell above (`with: previous`) or below (`with: next`, the default) into one: their text, one newline between, in the upper cell. Undoable.",
    input: s.object({ ...where, with: s.enum(["previous", "next"]).optional() }),
    effects: ["write"],
    agent: "discoverable",
    run: async (input) => {
      const view = await target(input.path);
      const i = cellIndex(view, input);
      if (!view.joinCells(i, input.with ?? "next"))
        throw new Error(
          `There's no cell ${input.with === "previous" ? "above" : "below"} to join.`,
        );
      return { cellId: view.cells[view.selected]?.cell.id, cells: view.cells.length };
    },
  });
  register({
    id: "notebook.duplicateCell",
    title: "Copy cell down",
    description:
      "Copies a cell below it (`direction: up`: above it), with its outputs. Returns the copy's id.",
    input: s.object({ ...where, direction: s.enum(["down", "up"]).optional() }),
    effects: ["write"],
    agent: "discoverable",
    run: async (input) => {
      const view = await target(input.path);
      const copy = view.duplicateCell(cellIndex(view, input), input.direction ?? "down");
      return { cellId: copy?.cell.id ?? null };
    },
  });
  register({
    id: "notebook.toggleLineNumbers",
    title: "Show cell line numbers",
    description:
      "Shows or hides line numbers in a cell's editor (L); `all`: in every cell (Shift+L). The notebook.lineNumbers setting is the default for new views.",
    input: s.object({ ...where, all: s.boolean().optional() }),
    effects: [],
    run: async (input) => {
      const view = await target(input.path);
      return { lineNumbers: view.toggleLineNumbers(cellIndex(view, input), input.all === true) };
    },
  });
  // Formatting through the language servers in cells (D229, VS Code's Format cell / notebook).
  const formatCells = async (view: NotebookView, indexes: number[]) => {
    const keep = view.selected;
    const command = view.mode === "command";
    let formatted = 0;
    for (const i of indexes) {
      const c = view.cells[i];
      if (c?.cell.kind !== "code" || c.language() !== view.language()) continue;
      const editor = c.ensureEditor();
      if (editor && (await editor.runAction("editor.action.formatDocument").catch(() => false)))
        formatted++;
    }
    // Running the action focuses each cell's editor: back where the user was.
    if (command) view.select(keep);
    return formatted;
  };
  /**
   * Every code cell formatted as one notebook undo step (VS Code's Format notebook is one edit
   * of the notebook): each cell's formatted text is asked without changing it, then the changed
   * ones are set together (`setSources`, as replace all does). The cells' requests all see the
   * notebook before any change, so a formatter of the whole joined document gives each cell its
   * own part.
   */
  const formatNotebook = async (view: NotebookView) => {
    let formatted = 0;
    const changes: { index: number; source: string }[] = [];
    for (const [i, c] of view.cells.entries()) {
      if (c.cell.kind !== "code" || c.language() !== view.language()) continue;
      c.ensureEditor();
      const doc = c.doc;
      if (!doc?.formattedText) continue;
      const before = doc.getText();
      const after = await doc.formattedText();
      if (after === null) continue;
      formatted++;
      // The cell may have been edited while the server answered: that answer is stale.
      if (after !== before && doc.getText() === before) changes.push({ index: i, source: after });
    }
    view.setSources(changes);
    return formatted;
  };
  register({
    id: "notebook.formatCell",
    title: "Format cell",
    description:
      "Formats a code cell's text with its language server's formatter (the notebook's cells as one document). The cell changes in the editor, not on disk. Returns whether a formatter ran.",
    input: s.object(where),
    effects: ["write"],
    agent: "discoverable",
    run: async (input) => {
      const view = await target(input.path);
      return { formatted: (await formatCells(view, [cellIndex(view, input)])) > 0 };
    },
  });
  register({
    id: "notebook.format",
    title: "Format notebook",
    description:
      "Formats every code cell of the notebook's language with its language server's formatter (Shift+Alt+F in the notebook). The cells change in the editor, not on disk, as one notebook undo step. Returns how many cells a formatter ran on.",
    input: s.object({ path: where.path }),
    effects: ["write"],
    agent: "discoverable",
    run: async (input) => {
      const view = await target(input.path);
      const formatted = await formatNotebook(view);
      if (!formatted) throw new Error("No formatter for this notebook's cells.");
      return { formatted };
    },
  });
  register({
    id: "notebook.previewCell",
    title: "Stop editing cell",
    description: "Shows a Markdown cell rendered again (Esc in its editor does the same).",
    input: s.object(where),
    effects: [],
    run: async (input) => {
      const view = await target(input.path);
      view.previewCell(cellIndex(view, input));
      return {};
    },
  });
  register({
    id: "notebook.changeCellLanguage",
    title: "Change cell language",
    description:
      "Sets a code cell's language (kept in its metadata as VS Code does: metadata.vscode.languageId); the notebook's language clears it, \"markdown\" makes it a Markdown cell (and a language makes a Markdown cell code). Without `language`, the user picks: the kernel's languages first.",
    input: s.object({
      ...where,
      language: s.string().describe('A language id: "python", "sql", "markdown"…').optional(),
    }),
    effects: ["write"],
    agent: "discoverable",
    run: async (input) => {
      const view = await target(input.path);
      const i = cellIndex(view, input);
      const cell = view.cells[i];
      if (!cell) throw new Error("No cell.");
      let language = input.language;
      if (language === undefined) {
        const engine = editors.loadedEngine ?? (await editors.ensureEngine());
        const own = view.language();
        const kernelLanguages = [
          own,
          ...(view.kernel?.option.languages ?? []).map((l) => l.toLowerCase()),
        ];
        const first = [...new Set([...kernelLanguages, "markdown"])];
        const rest = engine
          .languages()
          .map((l) => l.id)
          .filter((id) => !first.includes(id))
          .sort((a, b) => view.languageName(a).localeCompare(view.languageName(b)));
        const current = cell.language();
        const items: QuickPickItem[] = [...first, ...rest].map((id, n) => ({
          id,
          label: view.languageName(id),
          description: `${id}${id === current ? " · current" : ""}${id === own ? " · the notebook's" : ""}`,
          ...(n === first.length && { separator: "Other languages" }),
        }));
        language = (await quickInput.pick(items, { placeholder: "Select the cell's language" }))
          ?.id;
        if (!language) return { language: null };
      }
      view.setCellLanguage(i, language);
      return { language, kind: view.cells[i]?.cell.kind };
    },
  });
  register({
    id: "notebook.setMetadata",
    title: "Set notebook or cell metadata",
    description:
      "Merges `metadata` into the notebook's metadata, or a cell's (with `cellId` / `index`): keys set, null removes one. Saved with the notebook (an .ipynb's metadata, another format's as its serializer keeps it). Undoable.",
    input: s.object({ ...where, metadata: metadataPatch }),
    effects: ["write"],
    agent: "discoverable",
    run: async (input) => {
      const view = await target(input.path);
      const patch = input.metadata;
      if (!patch || typeof patch !== "object" || Array.isArray(patch))
        throw new Error("`metadata` must be an object of keys to set.");
      if (input.cellId !== undefined || input.index !== undefined) {
        const i = cellIndex(view, input);
        view.setCellMetadata(i, patch as Record<string, unknown>);
        return { cellId: view.cells[i]?.cell.id, metadata: view.cells[i]?.cell.metadata };
      }
      view.setMetadata(patch as Record<string, unknown>);
      return { metadata: view.metadata };
    },
  });

  register({
    id: "notebook.toggleSource",
    title: "Show notebook source",
    description:
      "Switches a notebook's tab between the notebook and its file's text (an .ipynb's JSON) in the same tab, like the Markdown preview's toggle. A tab with unsaved changes stays open beside the new one.",
    input: s.object({
      path: s.string().optional(),
      tabId: s.string().describe("The tab to switch (default: the active one)").optional(),
    }),
    effects: ["read"],
    agent: "hidden",
    run: async ({ path, tabId }, ctx) => {
      const ref = tabId ? dock.findTab(tabId) : undefined;
      const tab = ref ? ref.group.tabs[ref.index] : dock.activeTab();
      const p = tab ? stateField(tab.viewState, "path") : undefined;
      const file = path ?? (typeof p === "string" ? p : undefined);
      if (!tab || !file) throw new Error("No notebook to switch.");
      const toText = tab.viewType === notebookViewType;
      if (!toText && !services.notebooks.typeFor(file))
        throw new Error(`${file} isn't a notebook (no notebook format reads it).`);
      // Unsaved notebook changes aren't in the file: save them first, or keep the tab.
      const live = dock.liveView(tab.id);
      if (toText && live instanceof NotebookView && live.isDirty() && ctx.caller.kind === "user") {
        const answer = await confirmSaveChanges(
          "Save the notebook first?",
          "The source shows the file as saved; unsaved changes stay in the notebook's tab.",
        );
        if (answer === "cancel") return { tabId: tab.id, showing: "notebook" };
        if (answer === "save") await live.save();
      }
      const at = dock.findTab(tab.id);
      if (!at) throw new Error("That tab isn't open.");
      const id = dock.openView(
        toText ? "editor" : notebookViewType,
        { path: file },
        { groupId: at.group.id, index: at.index + 1 },
        true,
      );
      const fresh = dock.findTab(id);
      const freshTab = fresh?.group.tabs[fresh.index];
      if (freshTab) dock.view(freshTab); // the editor's document is retained before the old tab goes
      const old = dock.findTab(tab.id);
      const oldTab = old?.group.tabs[old.index];
      if (oldTab && !dock.isDirty(oldTab))
        await dispatcher.execute("layout.closeTab", { tabId: tab.id }).catch(() => {});
      return { tabId: id, showing: toText ? "source" : "notebook" };
    },
  });
}
