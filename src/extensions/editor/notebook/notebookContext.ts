// VS Code's notebook context keys (core/notebook/contextKeys.ts) set by the notebook that has the
// focus, or else is the active tab: extensions' keybindings and menus test them (Jupyter
// Keymap's A / B / D D only in command mode: `notebookEditorFocused && !inputFocus`; Jupyter's
// run-by-line button: `notebookKernel =~ /^ms-toolsai.jupyter\//`). One notebook owns the keys
// at a time; the owner clears them when it loses the focus to something else or closes.
import { on } from "../../../core/dom/index";
import { DisposableStore } from "../../../core/lifecycle/index";
import { type NotebookContextState, notebookContextKeys } from "../../../core/notebook/contextKeys";
import type { WorkbenchServices } from "../../../workbench/services";
import type { CellView } from "./cell";

/** What the keys are read from (the notebook view). */
export interface NotebookContextSource {
  readonly element: HTMLElement;
  readonly cells: readonly CellView[];
  readonly selected: number;
  readonly path: string;
  readonly notebookType: string;
  selectedIndexes(): number[];
  list(): HTMLElement;
  /** The kernel's source now, or the remembered one's (null: none picked). */
  kernelSource(): string | null;
  kernelBusy(): boolean;
  /** The notebook is the active tab of the focused group. */
  isActiveTab(): boolean;
}

/** The notebook whose keys are set now (one at a time). */
let owner: NotebookContextKeys | null = null;

export class NotebookContextKeys {
  private readonly store = new DisposableStore();
  private frame = 0;

  constructor(
    private readonly source: NotebookContextSource,
    private readonly services: WorkbenchServices,
  ) {
    const el = source.element;
    this.store.add(on(el, "focusin", () => this.update()));
    // Where the focus went is known after the event.
    this.store.add(on(el, "focusout", () => queueMicrotask(() => this.update())));
    // The kernel count follows the kernel sources (extensions starting, controllers made).
    this.store.add(services.notebooks.onDidChange(() => this.schedule()));
    this.store.add({
      dispose: () => {
        cancelAnimationFrame(this.frame);
        if (owner === this) {
          owner = null;
          this.services.context.setMany(notebookContextKeys(null));
        }
      },
    });
  }

  /** Something the keys show changed (selection, kernel, a cell's run): set once per frame. */
  schedule(): void {
    if (this.frame || this.store.isDisposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  }

  /** The notebook was shown or hidden as a tab. */
  update(): void {
    if (this.store.isDisposed) return;
    const state = this.state();
    if (!state) {
      // Not focused and not the active tab: the keys are another's (or nobody's) now.
      if (owner === this) {
        owner = null;
        this.services.context.setMany(notebookContextKeys(null));
      }
      return;
    }
    // A notebook that has the focus wins over one that's merely an active tab.
    if (owner && owner !== this && !state.focus.editor && owner.hasFocus()) return;
    owner = this;
    this.services.context.setMany(notebookContextKeys(state));
  }

  private hasFocus(): boolean {
    return this.source.element.contains(document.activeElement);
  }

  /** The keys' inputs, or null when this notebook shouldn't set them. */
  private state(): NotebookContextState | null {
    const s = this.source;
    const active = document.activeElement;
    const inEditor = !!active && s.element.contains(active);
    if (!inEditor && !s.isActiveTab()) return null;
    const list = s.list();
    const inList = inEditor && (active === s.element || list.contains(active));
    const cellEditor = inEditor && !!active?.closest(".nb-editor");
    const output =
      inEditor && !!active?.closest(".nb-outputs, .nb-page-frame, .nb-page-slot, iframe");
    const view = s.cells[s.selected];
    const kernel = s.kernelSource();
    return {
      path: s.path,
      notebookType: s.notebookType,
      focus: { editor: inEditor, list: inList, cellEditor, output },
      cell: view
        ? {
            id: view.cell.id,
            kind: view.cell.kind,
            language: view.language(),
            runState: view.runState,
            hasOutputs: view.cell.outputs.length > 0,
            editing: view.editingMarkdown,
          }
        : null,
      kernel,
      kernelCount: this.services.notebooks
        .sourcesFor(s.notebookType)
        // A source of kernel source actions only (Jupyter's "Python Environments…") runs none.
        .filter((k) => !(k.actions?.length && k.label === "Kernel sources")).length,
      running: s.cells.some((c) => c.runState === "running" || c.runState === "queued"),
      interruptible: s.kernelBusy(),
      readOnly: false,
      selectedCount: s.selectedIndexes().length,
    };
  }

  dispose(): void {
    this.store.dispose();
  }
}
