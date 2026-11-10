// The context keys VS Code sets for a notebook editor (notebookContextKeys.ts and
// notebookEditorWidget.ts there), as the IDE's notebook view sets them: extensions' keybindings
// (Jupyter Keymap's A, B, D D, Shift+Enter…) and menus (Jupyter's toolbar and cell buttons) test
// them. VS Code scopes them to the notebook editor; the IDE has one context, so the notebook
// that has the focus (or is the active tab) sets them and clears them when it goes. DOM-free and
// unit-tested.

import type { CellKind } from "./types";

/** VS Code's id for the notebook editor (`activeEditor == 'workbench.editor.notebook'`). */
export const NOTEBOOK_EDITOR_ID = "workbench.editor.notebook";
/** VS Code's id for the Interactive Window's editor. */
export const INTERACTIVE_EDITOR_ID = "workbench.editor.interactive";

/** VS Code's cell kinds: Markdown cells are "markup"; raw cells are code cells (language raw). */
export const vscodeCellType = (kind: CellKind): "code" | "markup" =>
  kind === "markdown" ? "markup" : "code";

/** VS Code's NotebookCellExecutionState as its context key spells it. */
export type CellExecutionState = "idle" | "pending" | "executing" | "succeeded" | "failed";

/** The IDE's run state of a cell as VS Code's `notebookCellExecutionState`. */
export function cellExecutionState(
  runState: "idle" | "queued" | "running" | "ok" | "error",
): CellExecutionState {
  switch (runState) {
    case "queued":
      return "pending";
    case "running":
      return "executing";
    case "ok":
      return "succeeded";
    case "error":
      return "failed";
    default:
      return "idle";
  }
}

/** Percent-encodes like VS Code's URI.toString() (its `encodeURIComponentFast`). */
function encodePart(s: string, isPath: boolean): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const plain =
      (code >= 97 && code <= 122) ||
      (code >= 65 && code <= 90) ||
      (code >= 48 && code <= 57) ||
      ch === "-" ||
      ch === "." ||
      ch === "_" ||
      ch === "~" ||
      (isPath && ch === "/");
    out += plain ? ch : encodeURIComponent(ch);
  }
  return out;
}

/**
 * A file's Uri as VS Code prints it (`Uri.file(path).toString()`): the `resource` context key,
 * and what extensions put in lists `resource in …` tests (Jupyter's debugDocuments).
 */
export function fileUriString(path: string): string {
  if (path.startsWith("untitled:")) return `untitled:${encodePart(path.slice(9), true)}`;
  let p = path.replace(/\\/g, "/");
  let authority = "";
  if (p.startsWith("//")) {
    const end = p.indexOf("/", 2);
    authority = end < 0 ? p.slice(2) : p.slice(2, end);
    p = end < 0 ? "/" : p.slice(end);
  } else if (!p.startsWith("/")) p = `/${p}`;
  // VS Code lower-cases a drive letter and encodes its colon.
  const drive = /^\/([A-Za-z]):(.*)$/.exec(p);
  const path_ = drive
    ? `/${drive[1]?.toLowerCase()}%3A${encodePart(drive[2] ?? "", true)}`
    : encodePart(p, true);
  return `file://${encodePart(authority.toLowerCase(), false)}${path_}`;
}

/**
 * A notebook cell's document Uri as the `vscode` shim prints it (`cell.document.uri.toString()`):
 * the `notebookCellResource` key, which Jupyter compares with its own lists of cells
 * (`notebookCellResource in jupyter.notebookeditor.runByLineCells`). The shim makes the Uri from
 * `vscode-notebook-cell:<notebook path>#<cell id>`: the whole path is one encoded part.
 */
export function cellUriString(notebookPath: string, cellId: string): string {
  return `vscode-notebook-cell:${encodePart(notebookPath, true)}#${encodePart(cellId, false)}`;
}

/** What the keys are computed from. */
export interface NotebookContextState {
  path: string;
  /** The IDE's notebook type ("jupyter.notebook"). */
  notebookType: string;
  focus: {
    /** The focus is somewhere in the notebook editor. */
    editor: boolean;
    /** In its cell list (command mode, or a cell's editor). */
    list: boolean;
    /** In a cell's text editor (edit mode). */
    cellEditor: boolean;
    /** In an output (a frame). */
    output: boolean;
  };
  /** The focused cell, when there is one. */
  cell: {
    id: string;
    kind: CellKind;
    language: string;
    runState: "idle" | "queued" | "running" | "ok" | "error";
    hasOutputs: boolean;
    /** Its Markdown is being edited (VS Code's notebookCellEditorFocused / markdownEditMode). */
    editing: boolean;
  } | null;
  /** The kernel picked or running: its source ("<extension id>/<controller id>"), else null. */
  kernel: string | null;
  kernelCount: number;
  /** A cell is running or waiting. */
  running: boolean;
  /** The kernel can be interrupted. */
  interruptible: boolean;
  readOnly: boolean;
  /** Cells selected (VS Code's notebookCellListFocused selection count). */
  selectedCount: number;
}

/**
 * Every key VS Code's notebook editor sets, with the values for `state` (null: the notebook
 * isn't the focused or active one, every key cleared). `notebookType` is the IDE's
 * ("jupyter.notebook"): extensions' `when` clauses are rewritten from VS Code's name on load.
 */
export function notebookContextKeys(
  state: NotebookContextState | null,
): Record<string, string | number | boolean | null | undefined> {
  if (!state) return Object.fromEntries(NOTEBOOK_CONTEXT_KEYS.map((k) => [k, undefined]));
  const { cell, focus } = state;
  const name = state.path.split(/[\\/]/).pop() ?? state.path;
  const dot = name.lastIndexOf(".");
  return {
    notebookEditorFocused: focus.editor,
    notebookCellListFocused: focus.list,
    notebookCellEditorFocused: focus.cellEditor,
    notebookOutputFocused: focus.output,
    notebookOutputInputFocused: false,
    notebookEditable: !state.readOnly,
    notebookType: state.notebookType,
    notebookViewType: state.notebookType,
    notebookKernel: state.kernel ?? undefined,
    notebookKernelSelected: !!state.kernel,
    notebookKernelCount: state.kernelCount,
    notebookKernelSource: state.kernel?.split("/")[0] ?? undefined,
    notebookHasRunningCell: state.running,
    notebookInterruptibleKernel: state.interruptible,
    notebookHasSomethingRunning: state.running,
    notebookMissingKernelExtension: false,
    notebookCellToolbarLocation: "right",
    notebookCellType: cell ? vscodeCellType(cell.kind) : undefined,
    notebookCellLanguage: cell?.language,
    notebookCellEditable: cell ? !state.readOnly : undefined,
    notebookCellExecutionState: cell ? cellExecutionState(cell.runState) : undefined,
    notebookCellExecuting: cell ? cell.runState === "running" : undefined,
    notebookCellHasOutputs: cell?.hasOutputs,
    notebookCellMarkdownEditMode: cell ? cell.kind === "markdown" && cell.editing : undefined,
    notebookCellResource: cell ? cellUriString(state.path, cell.id) : undefined,
    notebookCellListFocusedMultiple: state.selectedCount > 1,
    // The notebook as the active editor's resource (VS Code's ResourceContextKey).
    resource: fileUriString(state.path),
    resourcePath: state.path,
    resourceFilename: name,
    resourceExtname: dot > 0 ? name.slice(dot).toLowerCase() : "",
    resourceScheme: state.path.startsWith("untitled:") ? "untitled" : "file",
  };
}

/** The keys `notebookContextKeys` sets (cleared together when the notebook goes). */
export const NOTEBOOK_CONTEXT_KEYS: readonly string[] = [
  "notebookEditorFocused",
  "notebookCellListFocused",
  "notebookCellEditorFocused",
  "notebookOutputFocused",
  "notebookOutputInputFocused",
  "notebookEditable",
  "notebookType",
  "notebookViewType",
  "notebookKernel",
  "notebookKernelSelected",
  "notebookKernelCount",
  "notebookKernelSource",
  "notebookHasRunningCell",
  "notebookInterruptibleKernel",
  "notebookHasSomethingRunning",
  "notebookMissingKernelExtension",
  "notebookCellToolbarLocation",
  "notebookCellType",
  "notebookCellLanguage",
  "notebookCellEditable",
  "notebookCellExecutionState",
  "notebookCellExecuting",
  "notebookCellHasOutputs",
  "notebookCellMarkdownEditMode",
  "notebookCellResource",
  "notebookCellListFocusedMultiple",
  "resource",
  "resourcePath",
  "resourceFilename",
  "resourceExtname",
  "resourceScheme",
];
