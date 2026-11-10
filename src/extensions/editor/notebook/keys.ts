// The notebook's keys (D188), as Jupyter and VS Code have them. Command mode (the notebook has
// focus): Enter edits, Shift+Enter runs and moves on, Ctrl+Enter runs, Alt+Enter runs and adds a
// cell; A / B add above / below, D D deletes, M / Y / R change the kind, Z undoes a cell
// operation, O toggles the output, I I interrupts, 0 0 restarts, C / X / V copy, cut and paste,
// arrows and J / K move. In a cell's editor: the run keys, Esc back to command mode, the arrows
// past the first / last line into the next cell. VS Code's cell keys too (D204): Ctrl+Alt+J joins
// with the next cell (Shift: the previous), Shift+Alt+Down / Up copies the cell down / up, L
// toggles the cell's line numbers (Shift+L every cell's). Several cells (D209): Shift+Up / Down
// (Shift+K / J) extend the selection, Ctrl+A selects every cell, and the run, delete, move, copy,
// cut, clear and type keys act on every selected cell. Every key runs a command.
import type { CellView } from "./cell";

/** The commands that take `cellIds` (D209): with several cells selected they act on all. */
export const ON_SELECTION = new Set([
  "notebook.joinSelectedCells",
  "notebook.runCell",
  "notebook.deleteCell",
  "notebook.moveCell",
  "notebook.changeCellType",
  "notebook.copyCell",
  "notebook.cutCell",
  "notebook.clearOutputs",
]);

const MOD =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "Cmd" : "Ctrl";

/** Key labels for the cell toolbar and menu ("command" or "command:variant"). */
export const NOTEBOOK_KEY_LABELS: Readonly<Record<string, string>> = {
  "notebook.splitCell": `${MOD}+Shift+-`,
  "notebook.previewCell": "Esc",
  "notebook.cutCell": "X",
  "notebook.copyCell": "C",
  "notebook.pasteCell": "V",
  "notebook.joinCells:next": `${MOD}+Alt+J`,
  "notebook.joinCells:previous": `${MOD}+Alt+Shift+J`,
  "notebook.duplicateCell:down": "Shift+Alt+Down",
  "notebook.moveCell:up": "Alt+Up",
  "notebook.moveCell:down": "Alt+Down",
  "notebook.toggleLineNumbers": "L",
  "notebook.formatCell": "Shift+Alt+F",
  "notebook.toggleOutput": "O",
  "notebook.deleteCell": "D D",
};

/** What the keys need from the notebook view. */
export interface KeyTarget {
  readonly element: HTMLElement;
  readonly cells: CellView[];
  readonly selected: number;
  /** The selected cells' positions (D209). */
  selectedIndexes(): number[];
  mode: "command" | "edit";
  run(command: string, input?: Record<string, unknown>): void;
  select(i: number, focusCell?: boolean): void;
  editAt(i: number, at?: "start" | "end" | "keep"): void;
}

export interface EditorKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault(): void;
}

export class NotebookKeys {
  private lastKey = { key: "", at: 0 };

  constructor(private readonly view: KeyTarget) {}

  /** The same key twice within 600 ms (D D, I I, 0 0). */
  private twice(key: string): boolean {
    const now = performance.now();
    const again = this.lastKey.key === key && now - this.lastKey.at < 600;
    this.lastKey = again ? { key: "", at: 0 } : { key, at: now };
    return again;
  }

  /** A key in command mode. */
  onKey(e: KeyboardEvent) {
    const view = this.view;
    if (
      (e.target as HTMLElement).closest(".nb-editor, input, textarea, button.nb-kernel, .nb-find")
    )
      return;
    const mod = e.ctrlKey || e.metaKey;
    const cell = view.cells[view.selected];
    const id = cell?.cell.id;
    const picked = view.selectedIndexes();
    const run = (command: string, input: Record<string, unknown> = {}) => {
      e.preventDefault();
      e.stopPropagation();
      const which =
        picked.length > 1 && ON_SELECTION.has(command)
          ? { cellIds: picked.map((i) => view.cells[i]?.cell.id).filter((x) => x !== undefined) }
          : { cellId: id };
      view.run(command, { ...which, ...input });
    };
    const extend = (by: number) => {
      e.preventDefault();
      e.stopPropagation();
      view.run("notebook.selectCells", { by });
    };
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      e.stopPropagation();
      view.run("notebook.selectCells", { all: true });
      return;
    }
    if (e.shiftKey && !mod && !e.altKey) {
      if (e.key === "ArrowUp" || e.key === "K") return extend(-1);
      if (e.key === "ArrowDown" || e.key === "J") return extend(1);
    }
    if (e.key === "Enter" && e.shiftKey) return run("notebook.runCell", { advance: true });
    if (e.key === "Enter" && mod) return run("notebook.runCell");
    if (e.key === "Enter" && e.altKey) return run("notebook.runCell", { insertBelow: true });
    if (e.key === "Enter") return run("notebook.editCell");
    if (mod && e.key.toLowerCase() === "s") return run("notebook.save");
    if (mod && e.key.toLowerCase() === "z")
      return run(e.shiftKey ? "notebook.redo" : "notebook.undo");
    if (mod && e.altKey && e.key.toLowerCase() === "j")
      return run("notebook.joinCells", { with: e.shiftKey ? "previous" : "next" });
    if (mod || e.altKey) {
      // VS Code's Format notebook (in a cell's editor the same key formats the cell). By code:
      // Alt changes the character on some layouts.
      if (e.altKey && e.shiftKey && !mod && e.code === "KeyF") return run("notebook.format");
      if (e.altKey && e.shiftKey && e.key === "ArrowUp")
        return run("notebook.duplicateCell", { direction: "up" });
      if (e.altKey && e.shiftKey && e.key === "ArrowDown")
        return run("notebook.duplicateCell", { direction: "down" });
      if (e.altKey && e.key === "ArrowUp") return run("notebook.moveCell", { by: -1 });
      if (e.altKey && e.key === "ArrowDown") return run("notebook.moveCell", { by: 1 });
      return;
    }
    switch (e.key) {
      case "ArrowUp":
      case "k":
        e.preventDefault();
        view.select(view.selected - 1);
        return;
      case "ArrowDown":
      case "j":
        e.preventDefault();
        view.select(view.selected + 1);
        return;
      case "Home":
        e.preventDefault();
        view.select(0);
        return;
      case "End":
        e.preventDefault();
        view.select(view.cells.length - 1);
        return;
      case "a":
        return run("notebook.insertCell", { where: "above" });
      case "b":
        return run("notebook.insertCell");
      case "d":
        if (this.twice("d")) return run("notebook.deleteCell");
        e.preventDefault();
        return;
      case "z":
        return run("notebook.undo");
      case "m":
        return run("notebook.changeCellType", { kind: "markdown" });
      case "y":
        return run("notebook.changeCellType", { kind: "code" });
      case "r":
        return run("notebook.changeCellType", { kind: "raw" });
      case "o":
        return run("notebook.toggleOutput");
      case "i":
        if (this.twice("i")) return run("notebook.interrupt");
        e.preventDefault();
        return;
      case "0":
        if (this.twice("0")) return run("notebook.restart");
        e.preventDefault();
        return;
      case "c":
        return run("notebook.copyCell");
      case "x":
        return run("notebook.cutCell");
      case "v":
        return run("notebook.pasteCell");
      case "l":
        return run("notebook.toggleLineNumbers");
      case "L":
        return run("notebook.toggleLineNumbers", { all: true });
    }
  }

  /** A key in a cell's editor (before the editor acts on it). */
  onEditorKey(cell: CellView, e: EditorKey) {
    const view = this.view;
    const mod = e.ctrlKey || e.metaKey;
    const run = (command: string, input: Record<string, unknown> = {}) => {
      e.preventDefault();
      view.run(command, { cellId: cell.cell.id, ...input });
    };
    if (e.key === "Enter" && e.shiftKey && !mod) return run("notebook.runCell", { advance: true });
    if (e.key === "Enter" && mod) return run("notebook.runCell");
    if (e.key === "Enter" && e.altKey) return run("notebook.runCell", { insertBelow: true });
    // The editor's own popups (suggestions, find, parameter hints) and multiple cursors have
    // Escape and the arrows first.
    if (
      (e.key === "Escape" || e.key === "ArrowUp" || e.key === "ArrowDown") &&
      cell.editor?.hasOpenWidget()
    )
      return;
    if (e.key === "Escape") {
      e.preventDefault();
      view.mode = "command";
      if (cell.cell.kind === "markdown") cell.setEditingMarkdown(false);
      view.element.focus({ preventScroll: true });
      return;
    }
    if (mod && e.shiftKey && (e.key === "-" || e.key === "_")) return run("notebook.splitCell");
    if (mod && e.altKey && e.key.toLowerCase() === "j")
      return run("notebook.joinCells", { with: e.shiftKey ? "previous" : "next" });
    if (e.altKey && e.shiftKey && !mod && (e.key === "ArrowDown" || e.key === "ArrowUp"))
      return run("notebook.duplicateCell", { direction: e.key === "ArrowUp" ? "up" : "down" });
    // Arrow keys past the first / last line go to the cell above / below (VS Code's way).
    const state = cell.editor?.activeState();
    if (!state || !cell.doc || e.shiftKey || mod || e.altKey) return;
    const i = view.cells.indexOf(cell);
    if (e.key === "ArrowUp" && state.cursor.line === 1 && i > 0) {
      e.preventDefault();
      view.editAt(i - 1, "end");
    } else if (
      e.key === "ArrowDown" &&
      state.cursor.line === cell.doc.lineCount &&
      i < view.cells.length - 1
    ) {
      e.preventDefault();
      view.editAt(i + 1, "start");
    }
  }
}
