// VS Code's own command ids as the IDE's commands: what an extension's keybindings bind
// (Jupyter Keymap's notebook keys, a keymap pack's `undo`) and what `executeCommand` of one of
// them runs when the shim has no special handling for it. Only commands whose arguments don't
// matter (or are fixed here) are listed; ones that take a Uri or a string are in commands.ts.
// DOM-free.

import { VSCODE_COMMANDS } from "../../settings/vscodeImport";

/** The IDE's command for a VS Code one, with the input that makes it do the same. */
export interface BuiltinTarget {
  command: string;
  input?: Record<string, unknown>;
}

const insert = (where: "above" | "below", kind: "code" | "markdown"): BuiltinTarget => ({
  command: "notebook.insertCell",
  input: { where, kind },
});

/** VS Code's notebook commands (the ones keymaps and Jupyter bind) as the IDE notebook's. */
const NOTEBOOK: Readonly<Record<string, BuiltinTarget>> = {
  "notebook.cell.copy": { command: "notebook.copyCell" },
  "notebook.cell.cut": { command: "notebook.cutCell" },
  "notebook.cell.paste": { command: "notebook.pasteCell" },
  "notebook.cell.delete": { command: "notebook.deleteCell" },
  "notebook.cell.insertCodeCellAbove": insert("above", "code"),
  "notebook.cell.insertCodeCellAboveAndFocusContainer": insert("above", "code"),
  "notebook.cell.insertCodeCellBelow": insert("below", "code"),
  "notebook.cell.insertCodeCellBelowAndFocusContainer": insert("below", "code"),
  "notebook.cell.insertMarkdownCellAbove": insert("above", "markdown"),
  "notebook.cell.insertMarkdownCellBelow": insert("below", "markdown"),
  "notebook.cell.changeToCode": { command: "notebook.changeCellType", input: { kind: "code" } },
  "notebook.cell.changeToMarkdown": {
    command: "notebook.changeCellType",
    input: { kind: "markdown" },
  },
  "notebook.cell.execute": { command: "notebook.runCell" },
  "notebook.cell.executeAndFocusContainer": { command: "notebook.runCell" },
  "notebook.cell.executeAndSelectBelow": { command: "notebook.runCell", input: { advance: true } },
  "notebook.cell.executeAndInsertBelow": {
    command: "notebook.runCell",
    input: { insertBelow: true },
  },
  "notebook.execute": { command: "notebook.runAll" },
  "notebook.cancelExecution": { command: "notebook.interrupt" },
  "notebook.cell.cancelExecution": { command: "notebook.interrupt" },
  "notebook.cell.split": { command: "notebook.splitCell" },
  "notebook.cell.joinBelow": { command: "notebook.joinCells", input: { with: "next" } },
  "notebook.cell.joinAbove": { command: "notebook.joinCells", input: { with: "previous" } },
  "notebook.cell.moveUp": { command: "notebook.moveCell", input: { by: -1 } },
  "notebook.cell.moveDown": { command: "notebook.moveCell", input: { by: 1 } },
  "notebook.cell.copyUp": { command: "notebook.duplicateCell", input: { direction: "up" } },
  "notebook.cell.copyDown": { command: "notebook.duplicateCell", input: { direction: "down" } },
  "notebook.cell.toggleOutputs": { command: "notebook.toggleOutput" },
  "notebook.cell.toggleLineNumbers": { command: "notebook.toggleLineNumbers" },
  // VS Code's notebook-wide toggle (the cell's is notebook.cell.toggleLineNumbers).
  "notebook.toggleLineNumbers": { command: "notebook.toggleLineNumbers", input: { all: true } },
  "notebook.cell.clearOutputs": { command: "notebook.clearOutputs" },
  "notebook.clearAllCellsOutputs": { command: "notebook.clearAllOutputs" },
  "notebook.cell.edit": { command: "notebook.editCell" },
  "notebook.cell.quitEdit": { command: "notebook.previewCell" },
  "notebook.find": { command: "notebook.find" },
  "notebook.focusTop": { command: "notebook.selectCells", input: { index: 0 } },
  // VS Code's list keys, as keymaps bind them in notebooks (Jupyter Keymap's J / K, with a
  // notebook `when`): the notebook's cells are the list.
  "list.focusUp": { command: "notebook.selectCells", input: { move: -1 } },
  "list.focusDown": { command: "notebook.selectCells", input: { move: 1 } },
};

/**
 * The IDE's command for VS Code's built-in command `id`, or undefined when the IDE has none
 * (the caller still checks that the command is registered: a feature may be off).
 */
export function builtinCommand(id: string): BuiltinTarget | undefined {
  const notebook = NOTEBOOK[id];
  if (notebook) return notebook;
  const mapped = VSCODE_COMMANDS[id];
  if (mapped) {
    const input =
      mapped.args && typeof mapped.args === "object" && !Array.isArray(mapped.args)
        ? (mapped.args as Record<string, unknown>)
        : undefined;
    return { command: mapped.command, ...(input && { input }) };
  }
  // The editor's own actions run in the focused editor (as the keybinding import does).
  if (id.startsWith("editor.action.") || id.startsWith("actions."))
    return { command: "editor.runAction", input: { action: id } };
  return undefined;
}

/**
 * Whether `id` is one of VS Code's own commands rather than an extension's: one word (`undo`,
 * `cursorDown`, `tab`) or a namespace only VS Code itself uses. An extension's keybinding for
 * one the IDE has no command for is dropped (with a warning) instead of being sent to the
 * extension's code, which can't have it either.
 */
export function isVscodeBuiltinId(id: string): boolean {
  if (!id.includes(".")) return true;
  const first = id.split(".")[0] ?? "";
  return VSCODE_NAMESPACES.has(first);
}

const VSCODE_NAMESPACES = new Set([
  "workbench",
  "editor",
  "notebook",
  "interactive",
  "list",
  "actions",
  "breadcrumbs",
  "inlineChat",
  "chat",
  "search",
  "settings",
  "keybindings",
  "problems",
  "outline",
  "timeline",
  "testing",
  "terminal",
  "debug",
  "explorer",
  "scm",
  "notifications",
  "vscode",
]);
