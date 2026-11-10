// What a notebook gives each of its cells (from view.ts, m7.12): the `CellHost` that cell.ts
// calls for its editor's document name, keys, outputs, links and images, and its toolbar and
// "…" menu state (cellChrome.ts), acting on the notebook through its commands.
import type { Disposable } from "../../../core/lifecycle/index";
import { languageExtension } from "../../../core/notebook/concat";
import {
  cellExecutionState,
  cellUriString,
  vscodeCellType,
} from "../../../core/notebook/contextKeys";
import { showMenu } from "../../../ui/Menu";
import type { WorkbenchServices } from "../../../workbench/services";
import { inlineColors } from "../renderFile";
import type { EditorService } from "../service";
import { type CellHost, type CellView, cellLanguageOf } from "./cell";
import { type CellChromeState, cellMenuItems } from "./cellChrome";
import type { NotebookFindBar } from "./findBar";
import { NOTEBOOK_KEY_LABELS, type NotebookKeys, ON_SELECTION } from "./keys";
import type { NbCell } from "./model";
import type { NotebookOutputHost } from "./outputHost";
import { notebookWhen } from "./toolbar";
import type { NotebookView } from "./view";

/** Cells copied with C / X (or the cell menu), pasted with V, in any notebook. */
export const notebookClipboard: { cells: NbCell[] } = { cells: [] };

export interface CellHostDeps {
  view: NotebookView;
  services: WorkbenchServices;
  editors: EditorService;
  keys: NotebookKeys;
  outputs: NotebookOutputHost;
  find: NotebookFindBar;
}

/** The host every cell of `deps.view` shares; `dispose` closes a cell menu left open. */
export function notebookCellHost(deps: CellHostDeps): CellHost & Disposable {
  const { view, services, editors, keys, outputs, find } = deps;
  let menu: Disposable | null = null;
  const extension = (cell: NbCell) => {
    if (cell.kind === "markdown") return "md";
    if (cell.kind === "raw") return "txt";
    return languageExtension(cellLanguageOf(cell) ?? view.language()) ?? "txt";
  };
  return {
    engine: () => editors.loadedEngine,
    docPath: (cell) => `${view.path}.cell-${cell.id}.${extension(cell)}`,
    run: (command, input) => view.run(command, input as Record<string, unknown>),
    edited: (cell) => {
      view.markDirty();
      outputs.statusChanged(cell);
    },
    focused: (cell, editing) => {
      const i = view.cells.indexOf(cell);
      if (i >= 0) view.select(i, false);
      if (editing) view.mode = "edit";
    },
    editorKey: (cell, e) => keys.onEditorKey(cell, e),
    // A cell's editor came near the screen: the find's highlights reach it.
    editorCreated: () => find.redraw(),
    openLink: (href) => outputs.openLink(href),
    copy: (text) => void services.dispatcher.execute("ui.copyText", { text }).catch(() => {}),
    highlight: async (code, lang) => {
      const html = await services.documents.highlight(code, lang).catch(() => null);
      if (!html) return null;
      const t = document.createElement("template");
      t.innerHTML = inlineColors(html);
      return Array.from(t.content.childNodes);
    },
    image: (src, cell) => outputs.image(src, cell),
    scrollOutputs: () => services.settings.peek<boolean>("notebook.output.scrolling") !== false,
    frame: (o, cell, before) => outputs.frame(o, cell, before),
    lineNumbers: () => services.settings.peek<string>("notebook.lineNumbers") === "on",
    notebookLanguage: () => view.language(),
    languageName: (language) => view.languageName(language),
    chrome: (cell) => chromeState(view, services, cell),
    openMenu: (cell, anchor) => {
      menu?.dispose();
      const state = chromeState(view, services, cell);
      const ids = view.selectedIndexes().flatMap((j) => view.cells[j]?.cell.id ?? []);
      menu = showMenu(
        anchor,
        cellMenuItems(state, (command, input) =>
          view.run(command, {
            // A cell among several selected: the menu acts on all of them (D209).
            ...(state.selectedCount > 1 && ON_SELECTION.has(command)
              ? { cellIds: ids }
              : { cellId: cell.cell.id }),
            ...input,
          }),
        ),
        "Cell actions",
      );
    },
    indexBelow: (cell) => view.cells.indexOf(cell) + 1,
    runStateChanged: () => view.runStateChanged(),
    dispose: () => {
      menu?.dispose();
      menu = null;
    },
  };
}

/** What a cell's toolbar and "…" menu show (D204). */
function chromeState(
  view: NotebookView,
  services: WorkbenchServices,
  cell: CellView,
): CellChromeState {
  const index = view.cells.indexOf(cell);
  const selected = view.selectedIndexes();
  return {
    kind: cell.cell.kind,
    index: index < 0 ? 0 : index,
    count: view.cells.length,
    editingMarkdown: cell.editingMarkdown,
    hasOutputs: cell.cell.outputs.length > 0,
    outputsCollapsed: cell.outputsCollapsed,
    lineNumbers: cell.lineNumbers,
    canPaste: notebookClipboard.cells.length > 0,
    selectedCount: selected.length > 1 && selected.includes(index) ? selected.length : 1,
    extensionItems: services.extensionFeatures
      .menuItems(
        "notebook/cell/title",
        notebookWhen(services, {
          notebookType: view.notebookType,
          // VS Code's values for this cell (not the focused one's): "markup" for Markdown.
          notebookCellType: vscodeCellType(cell.cell.kind),
          notebookCellLanguage: cell.language(),
          notebookCellResource: cellUriString(view.path, cell.cell.id),
          notebookCellHasOutputs: cell.cell.outputs.length > 0,
          notebookCellExecutionState: cellExecutionState(cell.runState),
          notebookCellEditable: true,
          ...(view.kernel && { notebookKernel: view.kernel.option.source }),
        }),
      )
      .slice(0, 12),
    keyFor: (command) => NOTEBOOK_KEY_LABELS[command] ?? "",
  };
}
