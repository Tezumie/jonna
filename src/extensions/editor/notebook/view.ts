// The notebook editor (D188): a dock tab for a notebook file (any notebook type, D202; .ipynb is
// built in, D204). Cells are edited in place (code in embedded editors, Markdown rendered until
// edited), run on a kernel (running.ts) with their outputs streaming in, and saved back through
// the type's serializer. Keys follow Jupyter / VS Code (keys.ts). Every button runs a command
// (index.ts), so agents and keybindings can do the same.
import { h, on } from "../../../core/dom/index";
import { Emitter } from "../../../core/events/index";
import { dialogIpc } from "../../../core/ipc/system";
import { DisposableStore } from "../../../core/lifecycle/index";
import { type NotebookOutlineEntry, notebookOutline } from "../../../core/notebook/outline";
import type { KernelOption, NotebookKernel } from "../../../core/notebook/providers";
import { type CellSelection, clampSelection, collapsed } from "../../../core/notebook/selection";
import { basename, joinPath, pathKey } from "../../../core/paths/index";
import { effect, signal } from "../../../core/reactive/index";
import { confirmSaveChanges } from "../../../ui/Dialog";
import type { DockView, DockViewContext, TabAction } from "../../../workbench/dock/views";
import type { WorkbenchServices } from "../../../workbench/services";
import { hotExitEnabled } from "../hotExit";
import type { EditorService } from "../service";
import { isUntitled, untitledName, untitledTarget } from "../untitled";
import { NotebookBreadcrumbs } from "./breadcrumbs";
import { type CellHost, CellView } from "./cell";
import { insertBar, languageName } from "./cellChrome";
import { CellDrag } from "./cellDrag";
import { notebookCellHost } from "./cellHost";
import { NotebookFindBar } from "./findBar";
import { NotebookKeys } from "./keys";
import { NotebookLanguageLink } from "./language";
import {
  type CellKind,
  emptyNotebook,
  type NbCell,
  type NbOutput,
  type Notebook,
  newCell,
  notebookLanguage,
} from "./model";
import { NotebookContextKeys } from "./notebookContext";
import { NotebookFile, savedMetadata } from "./notebookFile";
import { NotebookOutputHost } from "./outputHost";
import { variablesContent } from "./panels";
import { NotebookRunner } from "./running";
import { NotebookToolbar, notebookMenuKeys } from "./toolbar";
import { WIDGET_STATE_MIME, WidgetStore } from "./widgets";

/** Bumped when any notebook's cells change (the Outline view re-reads the active one's). */
export const notebookOutlineVersion = signal(0);

export { notebookClipboard } from "./cellHost";

interface Snapshot {
  cells: NbCell[];
  selected: number;
  /** Cells whose text the step replaced (an agent's edit, replace all): their text comes back too. */
  textOf?: string[];
}

/** A cell as an undo step keeps it: its text and fields, its outputs by reference (they're
 * replaced, not changed, when the cell runs again; images aren't copied 100 times). */
const keep = (c: NbCell): NbCell => ({ ...c, metadata: { ...c.metadata }, extra: { ...c.extra } });

/** Open notebooks by path key (commands and the completion provider find them here). */
export const openNotebooks = new Map<string, NotebookView>();
export const findNotebook = (path: string) => openNotebooks.get(pathKey(path));

/**
 * What an untitled notebook (`untitled:Untitled-1.ipynb`, D267) starts with, until its view
 * takes it; without one it starts empty. It has no file until it's saved, which asks where.
 */
export const untitledStart = new Map<string, Notebook>();

/** A notebook's name in its tab and dialogs: "Untitled-1.ipynb" for an untitled one. */
export const notebookName = (path: string) =>
  isUntitled(path) ? untitledName(path) : basename(path);

export interface NotebookDeps {
  services: WorkbenchServices;
  editors: EditorService;
  /** The kernel remembered for a notebook in this folder. */
  rememberedKernel(path: string): KernelOption | undefined;
  rememberKernel(path: string, option: KernelOption): void;
  /** A command from an agent (or another non-user caller) is running: don't move the focus. */
  quiet(): boolean;
}

export class NotebookView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly changed = this.store.add(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  private readonly list: HTMLElement;
  private readonly toolbar: NotebookToolbar;
  private readonly sidePanel: HTMLElement;
  private nb: Notebook | null = null;
  cells: CellView[] = [];
  /** The focused cell (single-cell commands and the toolbar act on it). */
  selected = 0;
  /** The selected cells (D209: Shift / Ctrl+click and Shift+arrows select several). */
  private selection: CellSelection = collapsed(0, 1);
  /** Command mode: keys act on cells. Edit mode: the cell's editor has them. */
  mode: "command" | "edit" = "command";
  private version = 0;
  private savedVersion = 0;
  private readonly undoStack: Snapshot[] = [];
  private readonly redoStack: Snapshot[] = [];
  /** The kernel and the run queue (running.ts). */
  readonly runner: NotebookRunner;
  /** The file: its format, reading, writing, changes on disk (notebookFile.ts). */
  readonly file: NotebookFile;
  private readonly keys = new NotebookKeys(this);
  /** Find and replace across the cells (D204). */
  readonly find: NotebookFindBar;
  /** Bumped when cells change (the Outline re-reads them). */
  outlineVersion = 0;
  showVariables = false;
  error: string | null = null;
  private readonly loaded: Promise<void>;
  /** What every cell is given (cellHost.ts). */
  private readonly cellHost: CellHost;
  /** Outputs' frames and renderers, images, links, status items (outputHost.ts). */
  private readonly outputs: NotebookOutputHost;
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  private findTimer: ReturnType<typeof setTimeout> | undefined;
  /** The kernel's widgets (D189), or the file's saved ones until it runs. */
  readonly widgets = new WidgetStore();
  /** VS Code's notebook context keys while this notebook has the focus or is the active tab. */
  private readonly contextKeys: NotebookContextKeys;

  constructor(
    public path: string,
    private readonly ctx: DockViewContext,
    private readonly deps: NotebookDeps,
  ) {
    const { services } = deps;
    this.list = h("div", { class: "nb-cells", role: "list" });
    this.toolbar = new NotebookToolbar(services, (command, input) => this.run(command, input));
    this.file = new NotebookFile({
      services,
      path: () => this.path,
      disposed: () => this.store.isDisposed,
      isDirty: () => this.isDirty(),
      reload: (nb, clean) => {
        if (clean) this.savedVersion = ++this.version;
        this.applyNotebook(nb);
        if (clean) {
          this.changed.fire();
          this.keepBackup();
        }
      },
    });
    this.sidePanel = h("aside", { class: "nb-side", hidden: true });
    this.outputs = this.store.add(
      new NotebookOutputHost({
        services,
        widgets: this.widgets,
        path: () => this.path,
        notebookType: () => this.notebookType,
        cells: () => this.cells,
        kernel: () => this.kernel,
        run: (command, input) => this.run(command, input),
        list: () => this.list,
      }),
    );
    this.runner = this.store.add(
      new NotebookRunner({
        services,
        path: () => this.path,
        notebookType: () => this.notebookType,
        cells: () => this.cells,
        selected: () => this.selected,
        widgets: this.widgets,
        metadata: () => this.nb?.metadata,
        language: () => this.language(),
        rememberedKernel: (p) => deps.rememberedKernel(p),
        rememberKernel: (p, o) => deps.rememberKernel(p, o),
        quiet: () => deps.quiet(),
        kernelChanged: () => {
          this.renderToolbar();
          // A VS Code controller's kernel draws outputs in its output page (D295).
          this.outputs.kernelChanged();
          this.changed.fire();
        },
        markDirty: () => this.markDirty(),
        languageChanged: () => {
          for (const c of this.cells) if (c.cell.kind === "code") c.applyLanguage();
        },
        ranCells: () => {
          if (this.showVariables) void this.refreshVariables();
        },
        // Never once closed: a run that waited for a kernel across Close folder asked by path,
        // and the command opened the notebook again (its tab came back on the empty window).
        pickKernel: () =>
          this.store.isDisposed
            ? Promise.reject(new Error("The notebook was closed."))
            : services.dispatcher
                .execute("notebook.selectKernel", { path: this.path })
                .then(() => {}),
        ranCell: (c) =>
          services.events.emit("notebook.didRunCell", {
            path: this.path,
            notebookType: this.notebookType,
            cellId: c.cell.id,
            status: c.runState === "ok" ? "ok" : "error",
            executionCount: c.cell.executionCount,
          }),
      }),
    );
    this.find = this.store.add(
      new NotebookFindBar({
        cells: () => this.cells,
        from: () => {
          const c = this.cells[this.selected];
          const cursor = c?.editor?.activeState()?.cursor;
          const offset = cursor
            ? c.cell.source
                .split("\n")
                .slice(0, cursor.line - 1)
                .reduce((n, l) => n + l.length + 1, 0) +
              cursor.column -
              1
            : 0;
          return { cellIndex: this.selected, offset };
        },
        reveal: (m) =>
          this.revealCell(
            m.cellIndex,
            m.where === "source"
              ? { line: m.line, column: m.column, endLine: m.endLine, endColumn: m.endColumn }
              : undefined,
            false,
            m.where === "output",
          ),
        setSources: (changes) => this.setSources(changes),
        closed: () => this.focus(),
        run: (command, input) => this.run(command, input),
      }),
    );
    this.cellHost = this.store.add(
      notebookCellHost({
        view: this,
        services,
        editors: deps.editors,
        keys: this.keys,
        outputs: this.outputs,
        find: this.find,
      }),
    );
    // Breadcrumbs above the toolbar, as in VS Code (D229).
    const notebook = this;
    const crumbs = this.store.add(
      new NotebookBreadcrumbs(
        {
          get path() {
            return notebook.path;
          },
          get selected() {
            return notebook.selected;
          },
          outline: () => this.outline(),
          select: (i) => this.select(i),
          onDidChange: (listener) => this.changed.event(listener),
        },
        services,
      ),
    );
    this.element = h(
      "div",
      { class: "notebook-editor", tabindex: "-1" },
      crumbs.element,
      this.toolbar.element,
      this.file.banner,
      h("div", { class: "nb-body" }, this.list, this.sidePanel, this.find.element),
    );
    this.renderToolbar();
    this.store.add(on(this.element, "keydown", (e) => this.keys.onKey(e)));
    const view = this;
    this.contextKeys = this.store.add(
      new NotebookContextKeys(
        {
          element: this.element,
          get cells() {
            return view.cells;
          },
          get selected() {
            return view.selected;
          },
          get path() {
            return view.path;
          },
          get notebookType() {
            return view.notebookType;
          },
          selectedIndexes: () => this.selectedIndexes(),
          list: () => this.list,
          kernelSource: () =>
            this.kernel?.option.source ?? deps.rememberedKernel(this.path)?.source ?? null,
          kernelBusy: () => this.kernel?.status.peek() === "busy",
          isActiveTab: () => services.dock.activeTab()?.id === ctx.tabId,
        },
        services,
      ),
    );
    this.store.add(this.changed.event(() => this.contextKeys.schedule()));
    // The Outline view follows the selection and the cells (D204).
    // (peek: a change fired inside an effect must not make that effect depend on the counter)
    this.store.add(
      this.changed.event(() => {
        notebookOutlineVersion.value = notebookOutlineVersion.peek() + 1;
      }),
    );
    this.store.add({
      dispose: () => {
        clearTimeout(this.findTimer);
        clearTimeout(this.changeTimer);
      },
    });
    this.store.add(new NotebookLanguageLink(this, services, deps.editors));
    this.store.add(
      on(this.list, "mousedown", (e) => {
        const target = e.target as HTMLElement;
        // The cell's controls keep the mode (a toolbar button acts on the cell as it is).
        if (target.closest(".nb-cell-toolbar, .nb-insert, .nb-cell-foot button")) return;
        const el = target.closest<HTMLElement>(".nb-cell");
        const i = el ? this.cells.findIndex((c) => c.element === el) : -1;
        if (i < 0) return;
        const inEditor = !!target.closest(".nb-editor");
        // Shift+click selects a range, Ctrl / Cmd+click adds or removes a cell (D209); in a
        // cell's editor the keys are the editor's (text selection, cursors).
        if (!inEditor && (e.shiftKey || e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this.mode = "command";
          this.run("notebook.selectCells", {
            cellId: this.cells[i]?.cell.id,
            extend: e.shiftKey ? "range" : "toggle",
          });
          queueMicrotask(() => this.element.focus({ preventScroll: true }));
          return;
        }
        // The gutter of a cell among several selected: a drag takes all of them (cellDrag.ts),
        // which also selects this one alone on a click without a drag.
        const many = this.selection.selected.length > 1 && this.selection.selected.includes(i);
        if (!(many && CellDrag.isHandle(target))) this.select(i, false);
        if (!inEditor) {
          this.mode = "command";
          // Keys go to the notebook (command mode) once the press ends.
          queueMicrotask(() => this.element.focus({ preventScroll: true }));
        }
      }),
    );
    this.store.add(
      new CellDrag(this.list, {
        cells: () => this.cells,
        selected: () => this.selection.selected,
        run: (command, input) => this.run(command, input),
      }),
    );
    this.store.add(
      services.events.on("files.didChange", ({ path }) => {
        if (path === this.path) void this.file.changedOnDisk();
      }),
    );
    openNotebooks.set(pathKey(this.path), this);
    this.store.add(this.widgets);
    // Extensions' toolbar and cell buttons came or went; their status items too.
    let menusSeen = services.extensionFeatures.menus.peek();
    this.store.add(
      effect(() => {
        const menus = services.extensionFeatures.menus.value;
        if (menus !== menusSeen) {
          menusSeen = menus;
          queueMicrotask(() => {
            this.renderToolbar();
            for (const c of this.cells) c.refreshChrome();
          });
        }
        return undefined;
      }),
    );
    // Their `when` clauses test context keys extensions set later (Jupyter's
    // jupyter.ispythonnotebook): the buttons follow those keys, once a frame at most.
    let chromeFrame = 0;
    this.store.add(
      services.context.onDidChange((keys) => {
        if (chromeFrame || !keys.some((k) => notebookMenuKeys(services).has(k))) return;
        chromeFrame = requestAnimationFrame(() => {
          chromeFrame = 0;
          if (this.store.isDisposed) return;
          this.renderToolbar();
          for (const c of this.cells) c.refreshChrome();
        });
      }),
    );
    this.store.add({ dispose: () => cancelAnimationFrame(chromeFrame) });
    this.store.add({
      dispose: () => {
        if (findNotebook(this.path) === this) openNotebooks.delete(pathKey(this.path));
        // Closed without saving: its backup goes.
        if (this.isDirty()) this.keepBackup();
        if (this.nb)
          services.events.emit("notebook.didClose", {
            path: this.path,
            notebookType: this.notebookType,
          });
      },
    });
    this.loaded = this.load();
  }

  whenLoaded(): Promise<void> {
    return this.loaded;
  }

  get kernel(): NotebookKernel | null {
    return this.runner.kernel;
  }

  get variables() {
    return this.runner.variables;
  }

  /** The notebook type's id ("jupyter.notebook"), once known. */
  get notebookType(): string {
    return this.file.notebookType;
  }

  private get services(): WorkbenchServices {
    return this.deps.services;
  }

  run(command: string, input: Record<string, unknown> = {}): void {
    // A closed view's late callbacks (blur, a timer) would open its notebook again by path.
    if (this.store.isDisposed) return;
    void this.services.dispatcher
      .execute(command, { path: this.path, ...input })
      .catch((err: unknown) =>
        this.services.notifications.show("error", err instanceof Error ? err.message : String(err)),
      );
  }

  // ---- Loading and saving ---------------------------------------------------------------------

  private async load(): Promise<void> {
    try {
      // An untitled notebook has no file: what it was opened with, or nothing (D267).
      const untitled = isUntitled(this.path);
      const text = untitled ? "" : await this.file.readText();
      await this.deps.editors.ensureEngine();
      if (this.store.isDisposed) return;
      const nb = untitled
        ? (untitledStart.get(this.path) ?? emptyNotebook())
        : await this.file.deserialize(text);
      untitledStart.delete(this.path);
      if (this.store.isDisposed) return;
      this.restoreWidgets(nb);
      this.applyNotebook(nb);
      this.file.savedText = text;
      this.error = null;
      // Untitled with content: unsaved, as VS Code shows it.
      if (untitled && nb.cells.some((c) => c.source || c.outputs.length)) this.markDirty();
      this.services.events.emit("notebook.didOpen", {
        path: this.path,
        notebookType: this.notebookType,
      });
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.list.replaceChildren(
        h(
          "div",
          { class: "nb-error" },
          h("p", null, `This notebook can't be opened: ${this.error}`),
          h(
            "p",
            null,
            "Show its source to fix it (the tab's Show source button, or Reopen with…).",
          ),
        ),
      );
    }
    this.changed.fire();
  }

  /**
   * Shows `nb`'s cells, keeping the views of cells that are still there (same id and kind): their
   * editors, a running cell's output, and with `merge` (undo) their current text and outputs.
   */
  private applyNotebook(nb: Notebook, merge = false): void {
    this.nb = nb;
    const live = new Map(this.cells.map((c) => [c.cell.id, c]));
    const next = nb.cells.map((c) => {
      const view = live.get(c.id);
      if (view && view.cell.kind === c.kind) {
        live.delete(c.id);
        if (!merge) {
          view.setSource(c.source);
          view.cell.metadata = c.metadata;
          view.cell.extra = c.extra;
          if (view.runState !== "running") {
            view.cell.outputs = c.outputs;
            view.cell.executionCount = c.executionCount;
            view.renderOutputs();
          }
        } else view.cell.metadata = c.metadata;
        view.applyLanguage();
        return view;
      }
      return this.cellView(merge && view ? { ...c, source: view.cell.source } : c);
    });
    for (const gone of live.values()) gone.dispose();
    this.cells = next;
    this.contentChanged();
    this.replaceListChildren(
      insertBar(
        () => 0,
        (command, input) => this.run(command, input),
        "is-top",
      ),
      ...this.cells.map((c) => c.element),
    );
    if (!this.cells.length) this.insertCell(0, "code", "", false);
    this.selected = Math.min(this.selected, this.cells.length - 1);
    this.select(this.selected, false);
    this.renderToolbar();
  }

  /** The list's element for cell `at` (the top insert bar comes first). */
  private elementAt(at: number): Element | null {
    return this.list.children[at + 1] ?? null;
  }

  /**
   * The output page of a VS Code controller's notebook (D295) lies in the list after the cells:
   * it stays where it is (a frame moved in the page reloads, its widgets with it).
   */
  private outputPageFrame(): Element | null {
    return this.list.querySelector(":scope > .nb-page-frame");
  }

  /** Replaces the list's children, the output page kept (last). */
  private replaceListChildren(...nodes: Node[]): void {
    const keep = this.outputPageFrame();
    for (const child of [...this.list.children]) if (child !== keep) child.remove();
    for (const n of nodes) this.list.insertBefore(n, keep);
  }

  /** Widgets saved in the file (shown, not live, until the notebook runs). */
  private restoreWidgets(nb: Notebook): void {
    const saved = nb.metadata.widgets as Record<string, unknown> | undefined;
    if (saved && typeof saved === "object") this.widgets.restore(saved[WIDGET_STATE_MIME]);
  }

  private cellView(c: NbCell): CellView {
    const view = new CellView(c, this.cellHost);
    this.outputs.statusChanged(view);
    return view;
  }

  /** A language's name for the cell's label ("python" → "Python"). */
  languageName(language: string): string {
    return languageName(this.deps.editors.loadedEngine, language);
  }

  language(): string {
    return (
      this.kernel?.info.peek()?.language?.toLowerCase() ??
      (this.nb ? notebookLanguage(this.nb) : "python")
    );
  }

  toNotebook(): Notebook {
    const nb = this.nb ?? emptyNotebook();
    return { ...nb, cells: this.cells.map((c) => c.cell) };
  }

  /** The notebook's metadata (an extension's or an agent's notebook.setMetadata merges into it). */
  get metadata(): Record<string, unknown> {
    return this.nb?.metadata ?? {};
  }

  /** Merges `patch` into the notebook's metadata (null removes a key); one undo step. */
  setMetadata(patch: Record<string, unknown>): void {
    if (!this.nb) return;
    this.snapshot();
    const next = { ...this.nb.metadata };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    this.nb.metadata = next;
    this.markDirty();
  }

  /** Where an untitled notebook is saved: its own target, else the user picks (D267). */
  private async untitledDestination(): Promise<string | null> {
    const target = untitledTarget(this.path);
    if (target) return target;
    const { workspace } = this.services;
    const root = workspace.root.peek();
    const picked = await dialogIpc.pickSavePath(
      "Save notebook",
      root ? joinPath(root, untitledName(this.path)) : untitledName(this.path),
    );
    if (!picked) return null;
    const dest = root ? workspace.resolve(picked) : picked;
    if (root && !workspace.contains(dest))
      throw new Error("Save inside the open folder (files outside it aren't reachable).");
    return dest;
  }

  async save(): Promise<void> {
    if (!this.nb) return;
    // An untitled notebook becomes the file the user picks (VS Code: the untitled document
    // closes, the file's opens).
    const wasUntitled = isUntitled(this.path);
    if (wasUntitled) {
      const dest = await this.untitledDestination();
      if (!dest || this.store.isDisposed) return;
      this.services.events.emit("notebook.didClose", {
        path: this.path,
        notebookType: this.notebookType,
      });
      this.renamed(dest);
    }
    // Extensions' onWillSaveNotebookDocument (1.5 s each): they change cells through the
    // notebook commands before the notebook is taken.
    const { hooks } = this.services.extensionFeatures;
    if (hooks.hasWillSave("notebook"))
      await hooks.runWillSave(
        "notebook",
        { path: this.path, languageId: this.notebookType, reason: "manual" },
        () => {},
      );
    if (!this.nb) return;
    const nb = this.toNotebook();
    // What ran it and the widgets' state go into the file (notebookFile.ts).
    nb.metadata = savedMetadata(nb.metadata, this.kernel?.info.peek(), this.widgets.toSaved());
    this.nb.metadata = nb.metadata;
    // The version `nb` was taken at: edits made while it's serialized and written stay unsaved.
    const version = this.version;
    await this.file.write(nb);
    this.savedVersion = version;
    this.keepBackup();
    if (wasUntitled) {
      this.services.events.emit("files.didCreate", { path: this.path, kind: "file" });
      this.services.events.emit("notebook.didOpen", {
        path: this.path,
        notebookType: this.notebookType,
      });
    }
    this.services.events.emit("files.didSave", { path: this.path });
    this.services.events.emit("notebook.didSave", {
      path: this.path,
      notebookType: this.notebookType,
    });
    this.changed.fire();
  }

  markDirty(): void {
    this.version++;
    this.ctx.pin();
    this.contentChanged();
    this.changed.fire();
    this.keepBackup();
  }

  /** Hot exit: the folder's state (this notebook's backup) is saved a moment after a change. */
  private keepBackup(): void {
    if (hotExitEnabled(this.services)) this.services.persistence.scheduleSave();
  }

  /** Puts back the unsaved notebook hot exit kept (notebook/hotExit.ts), as one undo step. */
  applyBackup(nb: Notebook): void {
    if (!this.nb) return;
    this.snapshot(this.cells.map((c) => c.cell.id));
    this.applyNotebook(nb);
    this.markDirty();
  }

  /** The cells or their text changed: the outline reloads, the find's matches follow (D204). */
  private contentChanged(): void {
    this.outlineVersion++;
    // Extensions hear of it once things settle (notebook.didChange).
    if (this.nb && this.changeTimer === undefined)
      this.changeTimer = setTimeout(() => {
        this.changeTimer = undefined;
        if (this.store.isDisposed) return;
        this.services.events.emit("notebook.didChange", {
          path: this.path,
          notebookType: this.notebookType,
          cells: this.cells.length,
        });
      }, 300);
    if (!this.find.isOpen) return;
    clearTimeout(this.findTimer);
    this.findTimer = setTimeout(() => this.find.search(), 200);
  }

  // ---- Find, outline, going to a cell (D204) ----------------------------------------------------

  openFind(options: Parameters<NotebookFindBar["open"]>[0]): void {
    this.find.open(options);
  }

  closeFind(focus = true): void {
    this.find.close();
    if (focus) this.focus();
  }

  outline(): NotebookOutlineEntry[] {
    return notebookOutline(
      this.cells.map((c) => ({ id: c.cell.id, kind: c.cell.kind, source: c.cell.source })),
    );
  }

  /**
   * Shows cell `i`: selects it and scrolls it into view; with `at`, its editor gets the cursor
   * (or the selection) there and the line is scrolled to. `focus`: the editor takes the keys.
   * `outputs`: the cell's outputs are what's shown.
   */
  revealCell(
    i: number,
    at?: { line: number; column: number; endLine?: number; endColumn?: number },
    focus = true,
    outputs = false,
  ): void {
    const c = this.cells[i];
    if (!c) return;
    this.select(i, false);
    if (!at) {
      (outputs ? c.outputs : c.element).scrollIntoView({ block: "center" });
      if (focus && !this.deps.quiet()) {
        this.mode = "command";
        this.element.focus({ preventScroll: true });
      }
      return;
    }
    if (c.cell.kind === "markdown") c.setEditingMarkdown(true);
    const editor = c.ensureEditor();
    if (!editor) {
      c.element.scrollIntoView({ block: "center" });
      return;
    }
    if (at.endLine !== undefined && at.endColumn !== undefined)
      editor.select({
        startLine: at.line,
        startColumn: at.column,
        endLine: at.endLine,
        endColumn: at.endColumn,
      });
    else editor.revealPosition(at.line, at.column);
    // The line, not just the cell, into view: a long cell scrolls inside the notebook's list.
    requestAnimationFrame(() => {
      const host = c.element.querySelector(".nb-editor");
      if (!host) return;
      const box = host.getBoundingClientRect();
      const list = this.list.getBoundingClientRect();
      const y = box.top - list.top + this.list.scrollTop + (at.line - 1) * editor.lineHeight();
      if (y < this.list.scrollTop || y > this.list.scrollTop + this.list.clientHeight - 40)
        this.list.scrollTop = Math.max(0, y - this.list.clientHeight / 2);
    });
    if (focus && !this.deps.quiet()) {
      this.mode = "edit";
      editor.focus();
    }
  }

  /** Several cells' text at once, one undo step (replace all). */
  setSources(changes: readonly { index: number; source: string }[]): void {
    if (!changes.length) return;
    this.snapshot(changes.flatMap((c) => this.cells[c.index]?.cell.id ?? []));
    for (const { index, source } of changes) this.cells[index]?.setSource(source);
    this.markDirty();
  }

  /** Bumped by every edit (hot exit keeps a backup per version). */
  get editVersion(): number {
    return this.version;
  }

  isDirty(): boolean {
    return this.version !== this.savedVersion;
  }

  async confirmClose(): Promise<boolean> {
    if (!this.isDirty()) return true;
    const answer = await confirmSaveChanges(
      "Save the notebook?",
      `${notebookName(this.path)} has unsaved changes.`,
    );
    if (answer === "cancel") return false;
    // Not saved after all (an untitled one's Save dialog cancelled): it stays open.
    if (answer === "save") await this.save();
    return answer === "discard" || !this.isDirty();
  }

  // ---- Toolbar, kernel and running (running.ts) -----------------------------------------------

  private renderToolbar(): void {
    const k = this.kernel;
    const info = k?.info.peek();
    this.toolbar.render({
      kernelLabel:
        info?.display ?? k?.option.label ?? this.deps.rememberedKernel(this.path)?.label ?? null,
      kernelDetail: k ? k.option.detail : null,
      status: k?.status.peek() ?? "stopped",
      showVariables: this.showVariables,
      notebookType: this.notebookType,
      kernelSource: k?.option.source ?? this.deps.rememberedKernel(this.path)?.source ?? null,
    });
  }

  useKernel(option: KernelOption): Promise<void> {
    return this.runner.useKernel(option);
  }

  ensureKernel(): Promise<NotebookKernel> {
    return this.runner.ensureKernel();
  }

  runCells(list: CellView[]) {
    return this.runner.runCells(list);
  }

  interrupt(): void {
    this.runner.interrupt();
  }

  async restart(): Promise<void> {
    await this.runner.restart();
    this.renderSide();
  }

  async refreshVariables(): Promise<void> {
    await this.runner.refreshVariables();
    this.renderSide();
  }

  toggleVariables(): void {
    this.showVariables = !this.showVariables;
    this.renderToolbar();
    this.renderSide();
    if (this.showVariables) void this.refreshVariables();
  }

  private renderSide(): void {
    this.sidePanel.hidden = !this.showVariables;
    if (!this.showVariables) return;
    this.sidePanel.replaceChildren(...variablesContent(!!this.kernel, this.variables));
  }

  // ---- Cells --------------------------------------------------------------------------------------

  indexOf(cellId?: string): number {
    if (cellId === undefined) return this.selected;
    return this.cells.findIndex((c) => c.cell.id === cellId);
  }

  select(i: number, focusCell = true): void {
    if (!this.cells.length) return;
    this.setSelection(collapsed(i, this.cells.length), focusCell);
  }

  /** The selected cells' positions, ascending (the focused one alone unless several are). */
  selectedIndexes(): number[] {
    return [...this.cellSelection.selected];
  }

  get cellSelection(): CellSelection {
    return clampSelection(this.selection, this.cells.length);
  }

  /** Selects cells (D209): the focus scrolls into view; every selected cell is marked. */
  setSelection(sel: CellSelection, focusCell = true): void {
    if (!this.cells.length) return;
    this.selection = clampSelection(sel, this.cells.length);
    this.selected = this.selection.focus;
    const picked = new Set(this.selection.selected);
    for (const [j, c] of this.cells.entries()) c.setSelected(picked.has(j), j === this.selected);
    this.list.classList.toggle("is-multi", picked.size > 1);
    this.cells[this.selected]?.element.scrollIntoView({ block: "nearest" });
    if (focusCell && this.mode === "command" && !this.deps.quiet())
      this.element.focus({ preventScroll: true });
    this.changed.fire();
  }

  /** Puts the cells in a new order (old positions, D209); only the cells that moved are moved. */
  reorder(order: readonly number[]): void {
    const next = order.map((i) => this.cells[i]).filter((c) => c !== undefined);
    if (next.length !== this.cells.length) return;
    this.cells = next;
    for (const [k, c] of next.entries()) {
      const at = this.elementAt(k);
      if (at !== c.element) this.list.insertBefore(c.element, at);
    }
  }

  snapshot(textOf?: string[]): void {
    this.undoStack.push({
      cells: this.cells.map((c) => keep(c.cell)),
      selected: this.selected,
      ...(textOf?.length && { textOf }),
    });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private restore(s: Snapshot): void {
    if (!this.nb) return;
    // Undo puts cells back (added, deleted, moved, retyped): text typed since stays.
    this.applyNotebook({ ...this.nb, cells: s.cells.map(keep) }, true);
    for (const id of s.textOf ?? []) {
      const view = this.cells.find((c) => c.cell.id === id);
      const text = s.cells.find((c) => c.id === id)?.source;
      if (view && text !== undefined) view.setSource(text);
    }
    this.select(s.selected);
    this.markDirty();
  }

  undo(redo = false): boolean {
    const from = redo ? this.redoStack : this.undoStack;
    const to = redo ? this.undoStack : this.redoStack;
    const s = from.pop();
    if (!s) return false;
    to.push({
      cells: this.cells.map((c) => keep(c.cell)),
      selected: this.selected,
      ...(s.textOf && { textOf: s.textOf }),
    });
    this.restore(s);
    return true;
  }

  /** Adds a cell (a copy of `from` when given: its text, metadata and outputs). */
  insertCell(index: number, kind: CellKind, source = "", edit = true, from?: NbCell): CellView {
    this.snapshot();
    const fresh = newCell(kind, source);
    const view = this.cellView(
      from
        ? {
            ...fresh,
            metadata: JSON.parse(JSON.stringify(from.metadata)) as Record<string, unknown>,
            outputs: JSON.parse(JSON.stringify(from.outputs)) as NbOutput[],
            executionCount: from.executionCount,
          }
        : fresh,
    );
    const at = Math.max(0, Math.min(index, this.cells.length));
    this.cells.splice(at, 0, view);
    this.list.insertBefore(view.element, this.elementAt(at));
    if (kind === "markdown" && edit) view.setEditingMarkdown(true);
    this.select(at, false);
    if (edit && !this.deps.quiet()) {
      this.mode = "edit";
      requestAnimationFrame(() => view.focusEditor("start"));
    }
    this.markDirty();
    return view;
  }

  deleteCells(indexes: number[], undoStep = true): void {
    if (!indexes.length) return;
    if (undoStep) this.snapshot();
    for (const i of [...indexes].sort((a, b) => b - a)) {
      const [view] = this.cells.splice(i, 1);
      view?.element.remove();
      view?.dispose();
    }
    if (!this.cells.length) {
      const view = this.cellView(newCell("code"));
      this.cells.push(view);
      this.list.insertBefore(view.element, this.outputPageFrame());
    }
    this.select(Math.min(indexes[0] ?? 0, this.cells.length - 1));
    this.markDirty();
  }

  moveCell(i: number, delta: number): void {
    const j = i + delta;
    if (j < 0 || j >= this.cells.length) return;
    this.snapshot();
    const [view] = this.cells.splice(i, 1);
    if (!view) return;
    this.cells.splice(j, 0, view);
    this.list.insertBefore(view.element, this.elementAt(j + (delta > 0 ? 1 : 0)));
    this.select(j);
    this.markDirty();
  }

  setKind(i: number, kind: CellKind, undoStep = true): void {
    const view = this.cells[i];
    if (!view || view.cell.kind === kind) return;
    if (undoStep) this.snapshot();
    const replacement = this.cellView({
      ...keep(view.cell),
      kind,
      outputs: [],
      executionCount: null,
    });
    this.cells[i] = replacement;
    view.element.replaceWith(replacement.element);
    view.dispose();
    if (undoStep) this.select(i);
    this.markDirty();
  }

  setSource(i: number, source: string): void {
    const view = this.cells[i];
    if (!view) return;
    this.snapshot([view.cell.id]);
    view.setSource(source);
    this.markDirty();
  }

  /** Merges `patch` into a cell's metadata (null removes a key); one undo step. */
  setCellMetadata(i: number, patch: Record<string, unknown>): void {
    const view = this.cells[i];
    if (!view) return;
    this.snapshot();
    const next = { ...view.cell.metadata };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    view.cell.metadata = next;
    view.applyLanguage();
    this.outputs.statusChanged(view);
    this.markDirty();
  }

  /**
   * A code cell's own language (VS Code keeps it as metadata.vscode.languageId); the notebook's
   * language clears it. "markdown" makes the cell a Markdown cell, a language makes a Markdown
   * cell code (VS Code's language picker does both).
   */
  setCellLanguage(i: number, language: string): void {
    const view = this.cells[i];
    if (!view) return;
    if (language === "markdown") {
      this.setKind(i, "markdown");
      return;
    }
    if (view.cell.kind !== "code") {
      this.setKind(i, "code");
      if (language === this.language()) return;
    }
    const target = this.cells[i];
    if (!target) return;
    const vscode = { ...((target.cell.metadata.vscode as Record<string, unknown>) ?? {}) };
    if (language === this.language()) delete vscode.languageId;
    else vscode.languageId = language;
    this.setCellMetadata(i, { vscode: Object.keys(vscode).length ? vscode : null });
    // The editor's document is named by the language's extension: a new one for the new name.
    target.applyLanguage();
  }

  clearOutputs(indexes: number[]): void {
    this.snapshot();
    for (const i of indexes) {
      const c = this.cells[i];
      if (c?.cell.kind !== "code") continue;
      c.cell.outputs = [];
      c.cell.executionCount = null;
      c.setRunState("idle");
      c.renderOutputs();
    }
    this.markDirty();
  }

  /** Splits the cell at the cursor (Ctrl+Shift+-, as in VS Code). */
  splitCell(i: number): void {
    const view = this.cells[i];
    const state = view?.editor?.activeState();
    if (!view || !state || !view.doc) return;
    const lines = view.cell.source.split("\n");
    const cut = state.cursor.line - 1;
    const top = lines.slice(0, cut).join("\n");
    const bottom = lines.slice(cut).join("\n");
    if (!top.trim() || !bottom.trim()) return;
    view.setSource(top);
    const below = this.insertCell(i + 1, view.cell.kind, bottom, false);
    below.ensureEditor();
  }

  /**
   * Joins cell `i` with the one above or below (VS Code's Join with previous / next cell): the
   * text of both, one newline between, in the upper cell (its kind and metadata); the lower one
   * goes. Outputs of the joined cell are cleared (they came from part of its code). One undo
   * step. Returns false when there's no such neighbour.
   */
  joinCells(i: number, withCell: "previous" | "next"): boolean {
    const upper = withCell === "previous" ? i - 1 : i;
    const top = this.cells[upper];
    const bottom = this.cells[upper + 1];
    if (!top || !bottom) return false;
    this.snapshot([top.cell.id]);
    const joined = [top.cell.source, bottom.cell.source].join("\n");
    top.setSource(joined);
    if (top.cell.kind === "code" && bottom.cell.source.trim()) {
      top.cell.outputs = [];
      top.cell.executionCount = null;
      top.setRunState("idle");
      top.renderOutputs();
    }
    this.cells.splice(upper + 1, 1);
    bottom.element.remove();
    bottom.dispose();
    this.select(upper, false);
    this.markDirty();
    return true;
  }

  /** Copies cell `i` below (or above) it, with its outputs (VS Code's Copy cell down / up). */
  duplicateCell(i: number, direction: "down" | "up" = "down"): CellView | null {
    const c = this.cells[i];
    if (!c) return null;
    return this.insertCell(
      direction === "down" ? i + 1 : i,
      c.cell.kind,
      c.cell.source,
      false,
      c.cell,
    );
  }

  /** "Show cell line numbers": one cell, or every cell (Shift+L). Returns the new state. */
  toggleLineNumbers(i: number, all = false): boolean {
    const on = !(this.cells[i]?.lineNumbers ?? false);
    for (const c of all ? this.cells : this.cells.slice(i, i + 1)) c.setLineNumbers(on);
    return on;
  }

  editAt(i: number, at: "start" | "end" | "keep" = "keep"): void {
    const c = this.cells[i];
    if (!c) return;
    this.select(i, false);
    this.mode = "edit";
    if (c.cell.kind === "markdown") c.setEditingMarkdown(true);
    requestAnimationFrame(() => c.focusEditor(at));
  }

  /** A Markdown cell back to its rendered view (VS Code's Stop editing cell). */
  previewCell(i: number): void {
    const c = this.cells[i];
    if (c?.cell.kind !== "markdown") return;
    c.setEditingMarkdown(false);
    this.mode = "command";
    if (!this.deps.quiet()) this.element.focus({ preventScroll: true });
  }

  // ---- Dock ------------------------------------------------------------------------------------------

  title(): string {
    return notebookName(this.path);
  }

  /** The file was renamed or moved: same view, kernel and unsaved edits, new path (D187). */
  renamed(path: string): void {
    if (findNotebook(this.path) === this) openNotebooks.delete(pathKey(this.path));
    this.path = path;
    openNotebooks.set(pathKey(path), this);
    this.ctx.updateState({ path });
    this.changed.fire();
  }

  actions(): TabAction[] {
    return [
      { icon: "play", title: "Run all", command: "notebook.runAll", input: { path: this.path } },
      // Like the Markdown preview's "Open source" (D204): the file's text in this tab.
      {
        icon: "code",
        title: "Show source",
        command: "notebook.toggleSource",
        input: { path: this.path, tabId: "$tab" },
      },
    ];
  }

  focus(): void {
    if (this.mode === "edit") this.cells[this.selected]?.focusEditor();
    else this.element.focus({ preventScroll: true });
  }

  onShow(): void {
    this.services.context.set("activeNotebook", true);
    for (const c of this.cells) c.layout();
    this.contextKeys.schedule();
  }

  onHide(): void {
    this.services.context.set("activeNotebook", false);
    this.contextKeys.schedule();
  }

  /** A cell's run state changed (its context keys: notebookCellExecutionState). */
  runStateChanged(): void {
    this.contextKeys.schedule();
  }

  onResize(): void {
    for (const c of this.cells) c.layout();
  }

  serialize() {
    return { path: this.path };
  }

  dispose(): void {
    for (const c of this.cells) c.dispose();
    this.store.dispose();
  }
}
