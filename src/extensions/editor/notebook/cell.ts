// One notebook cell on screen (D188, D204): the run button and execution count on the left, the
// text in an embedded editor (created once the cell comes near the screen; until then its text),
// a Markdown cell rendered with the Markdown preview's styles until it's edited, a toolbar at the
// top right on hover or selection, a status row (how the run went, extensions' items, the cell's
// language), the outputs with their own buttons, and the "+ Code / + Markdown" bar below it.
import { h, on } from "../../../core/dom/index";
import { DisposableStore } from "../../../core/lifecycle/index";
import type { CellStatusItem } from "../../../core/notebook/providers";
import { icon } from "../../../ui/Icon";
import { isMarkdownControl, markdownNodes } from "../../../ui/markdown/render";
import { setTooltip } from "../../../ui/Tooltip";
import type { EditorEngine, EngineDocument, EngineEditor } from "../engine";
import { type CellChromeState, cellToolbarButtons, insertBar } from "./cellChrome";
import type { NbCell, NbOutput } from "./model";
import { outputGroups } from "./outputFrame";
import { outputElement } from "./outputs";

export type RunState = "idle" | "queued" | "running" | "ok" | "error";

export interface CellHost {
  engine(): EditorEngine | undefined;
  /** The cell's document path (language from its extension). */
  docPath(cell: NbCell): string;
  run(command: string, input?: unknown): void;
  /** Text changed (dirty, autosave…). */
  edited(cell: CellView): void;
  focused(cell: CellView, editing: boolean): void;
  editorKey(cell: CellView, e: Parameters<Parameters<EngineEditor["onKeyDown"]>[0]>[0]): void;
  openLink(href: string): void;
  copy(text: string): void;
  highlight(code: string, lang: string): Promise<Node[] | null>;
  image(src: string, cell: NbCell): string | null | Promise<string | null>;
  /** Long outputs scroll inside the cell. */
  scrollOutputs(): boolean;
  /** A sandboxed frame for an output that runs code (D189), or null to draw it inline. */
  frame?(
    o: NbOutput,
    cell: CellView,
    before: NbOutput[],
  ): { element: HTMLElement; dispose(): void } | null;
  /** Cells show line numbers (notebook.lineNumbers). */
  lineNumbers(): boolean;
  /** The cell's editor was made (find highlights reach it, D204). */
  editorCreated?(cell: CellView): void;
  /** The notebook's language (a code cell's, unless the cell names its own). */
  notebookLanguage(): string;
  /** A language id's name ("python" → "Python"). */
  languageName(language: string): string;
  /** What the toolbar and the "…" menu show for this cell. */
  chrome(cell: CellView): CellChromeState;
  /** Opens the cell's "…" menu under `anchor`. */
  openMenu(cell: CellView, anchor: HTMLElement): void;
  /** Where a cell added from the bar below this one goes. */
  indexBelow(cell: CellView): number;
  /** The cell's run state changed (VS Code's notebookCellExecutionState context key). */
  runStateChanged?(cell: CellView): void;
}

const fmtTime = (ms: number) =>
  ms < 1000
    ? `${Math.round(ms)}ms`
    : ms < 60_000
      ? `${(ms / 1000).toFixed(1)}s`
      : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** A cell's own language, as VS Code keeps it in an .ipynb (metadata.vscode.languageId). */
export function cellLanguageOf(cell: NbCell): string | null {
  const vscode = cell.metadata.vscode;
  const id = isObject(vscode) ? vscode.languageId : undefined;
  return typeof id === "string" && id ? id : null;
}

export class CellView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly gutter: HTMLElement;
  private readonly runButton: HTMLElement;
  private readonly count: HTMLElement;
  private readonly statusLine: HTMLElement;
  private readonly statusItems: HTMLElement;
  private readonly languageButton: HTMLElement;
  private readonly foot: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly editorHost: HTMLElement;
  private readonly placeholder: HTMLElement;
  private readonly rendered: HTMLElement;
  readonly outputs: HTMLElement;
  private readonly outputBody: HTMLElement;
  readonly inputRow: HTMLElement;
  doc: EngineDocument | null = null;
  editor: EngineEditor | null = null;
  private observer: IntersectionObserver | null = null;
  /** A Markdown cell being edited (else rendered). */
  editingMarkdown = false;
  runState: RunState = "idle";
  private started = 0;
  outputsCollapsed = false;
  /** "Show cell line numbers" (D204): the notebook's setting until toggled for this cell. */
  lineNumbers: boolean;
  /** The outputs on screen (to redraw only what changed). */
  private drawn: {
    output: NbOutput;
    el: HTMLElement;
    size: number;
    data: unknown;
    /** Drawn inside a later output's frame instead (D189). */
    companion: boolean;
    /** A frame's (D189): stopped when the output goes. */
    dispose?: () => void;
  }[] = [];
  sourceCollapsed = false;

  constructor(
    readonly cell: NbCell,
    private readonly host: CellHost,
  ) {
    this.lineNumbers = host.lineNumbers();
    this.runButton = h(
      "button",
      { class: "icon-button nb-run", type: "button", "aria-label": "Run cell" },
      icon("play"),
    );
    on(this.runButton, "click", (e) => {
      e.stopPropagation();
      host.run(this.runState === "running" ? "notebook.interrupt" : "notebook.runCell", {
        cellId: cell.id,
      });
    });
    this.count = h("div", { class: "nb-count" });
    this.statusLine = h("div", { class: "nb-status" });
    this.statusItems = h("div", { class: "nb-status-items" });
    this.languageButton = h("button", { class: "nb-cell-language", type: "button" });
    on(this.languageButton, "mousedown", (e) => e.preventDefault());
    on(this.languageButton, "click", (e) => {
      e.stopPropagation();
      host.run("notebook.changeCellLanguage", { cellId: cell.id });
    });
    setTooltip(this.languageButton, "Change the cell's language");
    this.foot = h(
      "div",
      { class: "nb-cell-foot" },
      this.statusLine,
      this.statusItems,
      h("span", { class: "nb-spacer" }),
      this.languageButton,
    );
    this.toolbar = h("div", { class: "nb-cell-toolbar", role: "toolbar", "aria-label": "Cell" });
    this.gutter = h("div", { class: "nb-gutter" }, this.runButton, this.count);
    this.editorHost = h("div", { class: "nb-editor" });
    this.placeholder = h("pre", { class: "nb-editor-placeholder" });
    // The Markdown preview's own classes (md md-document): a cell reads like the preview.
    this.rendered = h("div", { class: "nb-markdown md md-document" });
    this.outputBody = h("div", { class: "nb-outputs-body" });
    const collapse = h(
      "button",
      { class: "icon-button nb-out-collapse", type: "button", "aria-label": "Collapse output" },
      icon("chevron-down"),
    );
    setTooltip(collapse, "Collapse or expand the output (O)");
    on(collapse, "click", () => host.run("notebook.toggleOutput", { cellId: cell.id }));
    const clear = h(
      "button",
      { class: "icon-button nb-out-clear", type: "button", "aria-label": "Clear output" },
      icon("ban"),
    );
    setTooltip(clear, "Clear this output");
    on(clear, "click", () => host.run("notebook.clearOutputs", { cellId: cell.id }));
    this.outputs = h(
      "div",
      { class: "nb-outputs" },
      h("div", { class: "nb-outputs-actions" }, collapse, clear),
      this.outputBody,
    );
    this.inputRow = h("div", { class: "nb-input-row", hidden: true });
    this.element = h(
      "div",
      { class: "nb-cell", "data-cell": cell.id, tabindex: "-1", role: "listitem" },
      this.gutter,
      h(
        "div",
        { class: "nb-main" },
        // Sticky (D209): the toolbar stays in view at the top of a cell taller than the screen.
        h("div", { class: "nb-toolbar-dock" }, this.toolbar),
        this.editorHost,
        this.placeholder,
        this.rendered,
        this.foot,
        this.inputRow,
        this.outputs,
      ),
      insertBar(
        () => host.indexBelow(this),
        (command, input) => host.run(command, input),
      ),
    );
    on(this.rendered, "dblclick", (e) => {
      if (!isMarkdownControl(e.target)) host.run("notebook.editCell", { cellId: cell.id });
    });
    this.refreshKind();
    this.renderOutputs();
    this.watchVisibility();
  }

  /** Creates the editor when the cell comes within a screen of the view. */
  private watchVisibility(): void {
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) this.ensureEditor();
      },
      { rootMargin: "800px 0px" },
    );
    this.observer.observe(this.element);
    this.store.add({ dispose: () => this.observer?.disconnect() });
  }

  ensureEditor(): EngineEditor | null {
    if (this.editor) return this.editor;
    const engine = this.host.engine();
    if (!engine) return null;
    if (this.cell.kind === "markdown" && !this.editingMarkdown) return null;
    this.doc = this.store.add(
      // LF always: a notebook's sources are LF-joined (Jupyter's), and a one-line cell would
      // otherwise get the OS's line ending (CRLF on Windows) at the first Enter.
      engine.createDocument(this.host.docPath(this.cell), this.cell.source, {
        scheme: "notebook-cell",
        eol: "\n",
      }),
    );
    this.store.add(
      this.doc.onDidChangeContent(() => {
        this.cell.source = this.doc?.getText() ?? this.cell.source;
        this.host.edited(this);
      }),
    );
    const editor = this.store.add(engine.createEditor(this.editorHost, { embedded: true }));
    this.editor = editor;
    editor.setDocument(this.doc);
    editor.setLineNumbers?.(this.lineNumbers);
    const size = () => {
      this.editorHost.style.height = `${Math.max(editor.contentHeight(), editor.lineHeight() + 16)}px`;
      editor.layout();
    };
    this.store.add(editor.onDidChangeContentHeight(size));
    this.store.add(editor.onDidFocus(() => this.host.focused(this, true)));
    this.store.add(editor.onKeyDown((e) => this.host.editorKey(this, e)));
    this.placeholder.hidden = true;
    this.editorHost.hidden = this.sourceCollapsed;
    requestAnimationFrame(size);
    this.host.editorCreated?.(this);
    return editor;
  }

  /** The source changed from outside the editor (an agent's edit, undo of a cell operation). */
  setSource(text: string): void {
    this.cell.source = text;
    if (this.doc && this.doc.getText() !== text) this.doc.replaceText(text);
    this.placeholder.textContent = text || " ";
    if (this.cell.kind === "markdown" && !this.editingMarkdown) this.renderMarkdown();
  }

  /** The cell's language: its own (metadata.vscode.languageId), else the notebook's. */
  language(): string {
    if (this.cell.kind === "markdown") return "markdown";
    if (this.cell.kind === "raw") return "raw";
    return cellLanguageOf(this.cell) ?? this.host.notebookLanguage();
  }

  refreshKind(): void {
    const md = this.cell.kind === "markdown";
    this.element.classList.toggle("is-markdown", md);
    this.element.classList.toggle("is-code", this.cell.kind === "code");
    this.element.classList.toggle("is-raw", this.cell.kind === "raw");
    this.element.classList.toggle("is-md-editing", md && this.editingMarkdown);
    // Only code runs (VS Code shows no run button on Markdown cells: Esc or ✓ renders them).
    this.runButton.hidden = this.cell.kind !== "code";
    this.outputs.hidden = this.cell.kind !== "code" || this.cell.outputs.length === 0;
    const showEditor = !md || this.editingMarkdown;
    this.rendered.hidden = showEditor;
    if (!showEditor) this.renderMarkdown();
    if (showEditor && !this.editor) {
      this.placeholder.hidden = false;
      this.placeholder.textContent = this.cell.source || " ";
      this.editorHost.hidden = true;
    } else if (showEditor) {
      this.placeholder.hidden = true;
      this.editorHost.hidden = this.sourceCollapsed;
    } else {
      this.placeholder.hidden = true;
      this.editorHost.hidden = true;
    }
    this.updateCount();
    this.refreshChrome();
  }

  /** The toolbar's buttons, the language label and the status row for the cell's state. */
  refreshChrome(): void {
    this.toolbar.replaceChildren(
      ...cellToolbarButtons(
        this.host.chrome(this),
        (command, input) => this.host.run(command, { cellId: this.cell.id, ...input }),
        (anchor) => this.host.openMenu(this, anchor),
      ),
    );
    const md = this.cell.kind === "markdown";
    // VS Code: a code cell's language at the bottom right; a Markdown cell's while edited.
    const showLanguage = this.cell.kind === "code" || (md && this.editingMarkdown);
    this.languageButton.hidden = !showLanguage;
    if (showLanguage) this.languageButton.textContent = this.host.languageName(this.language());
    this.updateFoot();
  }

  private updateFoot(): void {
    this.foot.hidden =
      this.languageButton.hidden && this.statusLine.hidden && !this.statusItems.childElementCount;
  }

  /** Extensions' items in the status row (D204). */
  setStatusItems(items: readonly CellStatusItem[]): void {
    const el = (item: CellStatusItem) => {
      const node = item.command
        ? h("button", { class: "nb-status-item is-action", type: "button" }, item.text)
        : h("span", { class: "nb-status-item" }, item.text);
      if (item.tooltip) setTooltip(node, item.tooltip);
      const command = item.command;
      if (command) {
        on(node, "mousedown", (e) => e.preventDefault());
        on(node, "click", (e) => {
          e.stopPropagation();
          this.host.run(command, { cellId: this.cell.id });
        });
      }
      node.classList.toggle("is-right", item.alignment === "right");
      return node;
    };
    this.statusItems.replaceChildren(...items.map(el));
    this.updateFoot();
  }

  /** A Markdown cell between rendered and edited. */
  setEditingMarkdown(editing: boolean): void {
    if (this.cell.kind !== "markdown") return;
    if (this.editingMarkdown === editing && (!editing || this.editor)) return;
    this.editingMarkdown = editing;
    this.refreshKind();
    if (editing) {
      this.ensureEditor();
      this.placeholder.hidden = true;
      this.editorHost.hidden = false;
      requestAnimationFrame(() => this.editor?.layout());
    }
  }

  private renderMarkdown(): void {
    const source = this.cell.source.trim();
    this.rendered.replaceChildren(
      ...(source
        ? markdownNodes(source, {
            openLink: (href) => this.host.openLink(href),
            copy: (t) => this.host.copy(t),
            headingShift: 0,
            softBreaks: "space",
            highlight: (code, lang) => this.host.highlight(code, lang),
            image: (src) => this.host.image(src, this.cell),
          })
        : [h("p", { class: "nb-empty-md" }, "Empty Markdown cell: double-click to edit")]),
    );
  }

  setLanguage(path: string): void {
    const engine = this.host.engine();
    if (!engine || !this.doc) return;
    const lang = engine.languageFor(path.split(".").pop() ?? "") ?? "plaintext";
    engine.setLanguage(this.doc, lang);
  }

  /** The editor's syntax follows the cell's language (its own or the notebook's). */
  applyLanguage(): void {
    const engine = this.host.engine();
    if (engine && this.doc && this.cell.kind === "code") {
      const lang = this.language();
      const known = engine.languages().some((l) => l.id === lang);
      engine.setLanguage(this.doc, known ? lang : (engine.languageFor(lang) ?? "plaintext"));
    }
    this.refreshChrome();
  }

  setLineNumbers(on: boolean): void {
    this.lineNumbers = on;
    this.editor?.setLineNumbers?.(on);
  }

  updateCount(): void {
    const n = this.cell.executionCount;
    this.count.textContent =
      this.cell.kind !== "code"
        ? ""
        : this.runState === "queued"
          ? "[*]"
          : this.runState === "running"
            ? "[*]"
            : `[${n ?? " "}]`;
    this.element.classList.toggle("is-running", this.runState === "running");
    this.element.classList.toggle("is-queued", this.runState === "queued");
    this.runButton.replaceChildren(
      icon(this.runState === "running" ? "square" : this.runState === "queued" ? "clock" : "play"),
    );
    setTooltip(
      this.runButton,
      this.runState === "running"
        ? "Stop (interrupt the kernel)"
        : "Run cell (Ctrl+Enter; Shift+Enter runs and moves on)",
    );
  }

  setRunState(state: RunState, durationMs?: number): void {
    if (state === "running") this.started = performance.now();
    this.runState = state;
    this.updateCount();
    this.host.runStateChanged?.(this);
    if (state === "ok" || state === "error") {
      const took = durationMs ?? performance.now() - this.started;
      this.statusLine.replaceChildren(
        icon(state === "ok" ? "check" : "circle-x"),
        h("span", null, fmtTime(took)),
      );
      this.statusLine.className = `nb-status is-${state}`;
      this.statusLine.hidden = false;
    } else if (state === "running") {
      this.statusLine.replaceChildren(h("span", null, "Running…"));
      this.statusLine.className = "nb-status is-running";
      this.statusLine.hidden = false;
    } else if (state === "queued") {
      this.statusLine.replaceChildren(h("span", null, "Waiting to run"));
      this.statusLine.className = "nb-status is-queued";
      this.statusLine.hidden = false;
    } else this.statusLine.hidden = true;
    this.updateFoot();
  }

  renderOutputs(): void {
    const hostOptions = {
      openLink: (href: string) => this.host.openLink(href),
      copy: (t: string) => this.host.copy(t),
      scrollable: this.host.scrollOutputs(),
    };
    // Only what changed is drawn again: a growing stream redraws itself, new outputs are added
    // (D188: redrawing everything per frame froze long training logs).
    const outs = this.cell.outputs;
    const same =
      this.drawn.length <= outs.length && this.drawn.every((d, i) => d.output === outs[i]);
    if (!same) {
      for (const d of this.drawn) d.dispose?.();
      this.drawn = [];
      this.outputBody.replaceChildren();
    }
    const groups = outputGroups(outs);
    for (const [i, o] of outs.entries()) {
      const size = typeof o.text === "string" ? o.text.length : -1;
      const drawn = this.drawn[i];
      const companion = groups.companions.has(i);
      if (drawn && drawn.size === size && drawn.data === o.data && drawn.companion === companion)
        continue;
      const framed =
        o.output_type === "stream" || o.output_type === "error" || companion
          ? null
          : (this.host.frame?.(o, this, groups.before.get(i) ?? []) ?? null);
      const el = companion
        ? h("div", { class: "nb-out-companion", hidden: true })
        : (framed?.element ?? outputElement(o, hostOptions));
      drawn?.dispose?.();
      if (drawn) drawn.el.replaceWith(el);
      else this.outputBody.append(el);
      this.drawn[i] = {
        output: o,
        el,
        size,
        data: o.data,
        companion,
        ...(framed && { dispose: () => framed.dispose() }),
      };
    }
    this.outputs.hidden = this.cell.kind !== "code" || this.cell.outputs.length === 0;
    this.outputs.classList.toggle("is-collapsed", this.outputsCollapsed);
    this.outputs.classList.toggle("is-scrolling", hostOptions.scrollable);
  }

  /** Draws every output again (their frames too: the folder's trust changed). */
  redrawOutputs(): void {
    for (const d of this.drawn) d.dispose?.();
    this.drawn = [];
    this.outputBody.replaceChildren();
    this.renderOutputs();
  }

  /** Puts the cursor in the editor (creating it if needed). */
  focusEditor(at: "start" | "end" | "keep" = "keep"): void {
    const editor = this.ensureEditor();
    if (!editor || !this.doc) return;
    if (at === "start") editor.revealPosition(1, 1);
    else if (at === "end") {
      const lines = this.doc.lineCount;
      editor.revealPosition(lines, 10_000);
    }
    editor.focus();
  }

  /** Selected (one of several, D209) and focused (the cell the keys and toolbar act on). */
  setSelected(selected: boolean, focused: boolean): void {
    this.element.classList.toggle("is-selected", selected);
    this.element.classList.toggle("is-focused", selected && focused);
    this.element.setAttribute("aria-selected", String(selected));
  }

  toggleSourceCollapsed(): void {
    this.sourceCollapsed = !this.sourceCollapsed;
    this.element.classList.toggle("is-source-collapsed", this.sourceCollapsed);
    this.refreshKind();
  }

  layout(): void {
    this.editor?.layout();
  }

  dispose(): void {
    for (const d of this.drawn) d.dispose?.();
    this.drawn = [];
    this.store.dispose();
  }
}
