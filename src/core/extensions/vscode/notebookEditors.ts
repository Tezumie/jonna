// The `vscode` shim's notebook documents and editors (D265) on the IDE's notebook editor: a
// NotebookDocument's cells as `notebook.read` gives them (refreshed when the notebook changes,
// with VS Code's content and cell changes), the active notebook editor and its selected cells
// (`ide.editor.onDidChangeNotebook`), showing one, and NotebookEdits applied through the IDE's
// cell commands (insert, delete, metadata), one after another as VS Code applies them.
// DOM-free and unit-tested.

import { JUPYTER_NOTEBOOK } from "../../notebook/providers";
import type { WorkerApi } from "../rpc";
import { pathOf } from "./convert";
import { pathKey, ShimTextDocument, type TextDocumentChangeEvent } from "./document";
import {
  fromVscodeCellMetadata,
  fromVscodeNotebookMetadata,
  toVscodeCellMetadata,
  toVscodeNotebookMetadata,
  VSCODE_IPYNB_TYPE,
} from "./ipynbMetadata";
import { vscodeLanguageId } from "./languageIds";
import { EventEmitter, Uri } from "./types";
import { type NotebookCellOutput, type NotebookEdit, NotebookRange } from "./workbenchTypes";

/** VS Code calls Jupyter notebooks "jupyter-notebook"; the IDE, JUPYTER_NOTEBOOK. */
const VSCODE_JUPYTER = "jupyter-notebook";
export const vscodeNotebookType = (type: string) =>
  type === JUPYTER_NOTEBOOK ? VSCODE_JUPYTER : type;
export const ideNotebookType = (type: string) =>
  type === VSCODE_JUPYTER ? JUPYTER_NOTEBOOK : type;

/** A cell as `notebook.read` (with `metadata` and `outputs`) gives it. */
export interface ReadCell {
  index: number;
  id: string;
  kind: "code" | "markdown" | "raw";
  source: string;
  metadata?: Record<string, unknown>;
  language?: string;
  executionCount?: number | null;
  outputs?: Record<string, unknown>[];
  /** A Jupyter cell's attachments (VS Code's ipynb layout gives them in the cell's metadata). */
  attachments?: unknown;
}

export interface NotebookRead {
  path: string;
  type: string;
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformatMinor?: number;
  cells: ReadCell[];
}

/**
 * The cell's metadata as extensions see it: Jupyter notebooks' in VS Code's ipynb layout
 * (`{ execution_count, metadata, id, attachments }`), other types' as their serializer gave it.
 */
export function cellMetadataOf(c: ReadCell, ipynb: boolean): Record<string, unknown> {
  if (!ipynb) return c.metadata ?? {};
  return toVscodeCellMetadata({
    kind: c.kind,
    ...(c.metadata && { metadata: c.metadata }),
    id: c.id,
    ...(c.executionCount !== undefined && { executionCount: c.executionCount }),
    ...(c.attachments !== undefined && { attachments: c.attachments }),
  });
}

/** VS Code's NotebookCell. */
export interface ShimNotebookCell {
  readonly index: number;
  readonly notebook: ShimNotebook;
  readonly kind: 1 | 2;
  readonly document: ShimTextDocument;
  readonly metadata: Record<string, unknown>;
  readonly outputs: readonly NotebookCellOutput[];
  readonly executionSummary: { executionOrder?: number } | undefined;
}

/** VS Code's NotebookDocumentChangeEvent's parts. */
export interface NotebookChanges {
  contentChanges: {
    range: NotebookRange;
    removedCells: ShimNotebookCell[];
    addedCells: ShimNotebookCell[];
  }[];
  cellChanges: {
    cell: ShimNotebookCell;
    document: ShimTextDocument | undefined;
    metadata: Record<string, unknown> | undefined;
    outputs: readonly NotebookCellOutput[] | undefined;
    executionSummary: { executionOrder?: number } | undefined;
  }[];
  metadata: Record<string, unknown> | undefined;
}

type OutputsOf = (outputs: Record<string, unknown>[]) => NotebookCellOutput[];

/**
 * Where a notebook's cell documents go besides their cells (the `vscode` shim's open documents:
 * workspace.textDocuments and its events, as in VS Code, where a cell's TextDocument is opened
 * with its cell, changes in place and is closed when the cell or the notebook goes).
 */
export interface CellDocumentEvents {
  opened(doc: ShimTextDocument): void;
  changed(event: TextDocumentChangeEvent): void;
  closed(doc: ShimTextDocument): void;
}

/** VS Code's NotebookDocument: its cells as the IDE last told them. */
export class ShimNotebook {
  readonly uri: Uri;
  /** VS Code's name for its type ("" until the IDE says it). */
  notebookType: string;
  /** Not saved to a file yet (`untitled:Untitled-1.ipynb`, D267). */
  readonly isUntitled: boolean;
  version = 0;
  isDirty = false;
  isClosed = false;
  metadata: Record<string, unknown> = {};
  /** Its cells' ids in the IDE, by index (what edits address). */
  ids: string[] = [];
  private cells: ShimNotebookCell[] = [];
  /** What each cell was read as (its changes are told from it). */
  private read: ReadCell[] = [];

  constructor(
    readonly path: string,
    notebookType: string,
    private readonly saver: (nb: ShimNotebook) => Promise<boolean>,
    private readonly outputsOf: OutputsOf,
    private readonly cellDocs?: CellDocumentEvents,
  ) {
    this.isUntitled = path.startsWith("untitled:");
    this.uri = this.isUntitled ? Uri.parse(path) : Uri.file(path);
    this.notebookType = vscodeNotebookType(notebookType);
  }

  /** A Jupyter notebook: its metadata in VS Code's ipynb layout (ipynbMetadata.ts). */
  get isIpynb(): boolean {
    return this.notebookType === VSCODE_IPYNB_TYPE;
  }

  get cellCount(): number {
    return this.cells.length;
  }

  /** As in VS Code, an index out of range is clamped. */
  cellAt(index: number): ShimNotebookCell | undefined {
    return this.cells[Math.max(0, Math.min(Math.trunc(index), this.cells.length - 1))];
  }

  getCells(range?: NotebookRange): ShimNotebookCell[] {
    return range ? this.cells.slice(range.start, range.end) : [...this.cells];
  }

  /** The cell with this IDE id, if it's one of this notebook's. */
  cellById(id: string): ShimNotebookCell | undefined {
    const i = this.ids.indexOf(id);
    return i >= 0 ? this.cells[i] : undefined;
  }

  save(): Promise<boolean> {
    return this.saver(this);
  }

  /**
   * A cell's text as the editor has it now (a provider is asked about it before the notebook's
   * change is read): its document changes in place, a new version with VS Code's change event.
   */
  syncCellText(cellId: string, text: string): ShimTextDocument | undefined {
    const doc = this.cellById(cellId)?.document;
    if (doc) this.setDocumentText(doc, text);
    return doc;
  }

  private setDocumentText(doc: ShimTextDocument, text: string): void {
    const change = doc.setText(text);
    if (!change) return;
    doc.version++;
    this.cellDocs?.changed({ document: doc, contentChanges: [change], reason: undefined });
  }

  /** The notebook closed: its cells' documents close with it. */
  closeCells(): void {
    for (const c of this.cells) this.closeDocument(c.document);
  }

  private closeDocument(doc: ShimTextDocument): void {
    if (doc.isClosed) return;
    doc.isClosed = true;
    this.cellDocs?.closed(doc);
  }

  /** The IDE's cells now; returns what changed (VS Code's change event). */
  update(next: NotebookRead): NotebookChanges {
    const before = this.read;
    const oldCells = this.cells;
    const metadata = this.isIpynb
      ? toVscodeNotebookMetadata(next.metadata, {
          ...(next.nbformat !== undefined && { nbformat: next.nbformat }),
          ...(next.nbformatMinor !== undefined && { nbformatMinor: next.nbformatMinor }),
        })
      : (next.metadata ?? {});
    const sameMetadata = JSON.stringify(this.metadata) === JSON.stringify(metadata);
    this.metadata = metadata;
    // Cells kept (same id) are the same objects with new contents, as in VS Code.
    const kept = new Map(oldCells.map((c, i) => [before[i]?.id ?? "", c]));
    this.read = next.cells;
    this.ids = next.cells.map((c) => c.id);
    const cellChanges: NotebookChanges["cellChanges"] = [];
    const nextIds = new Set(this.ids);
    // Cells that went: their documents close (VS Code's onDidCloseTextDocument).
    for (const [i, c] of oldCells.entries())
      if (!nextIds.has(before[i]?.id ?? "")) this.closeDocument(c.document);
    this.cells = next.cells.map((c, index) => {
      const old = kept.get(c.id);
      const was = old ? before[old.index] : undefined;
      const cell = this.cellOf(c, index, old);
      if (old && was) {
        const doc = was.source !== c.source || was.language !== c.language;
        const md = JSON.stringify(was.metadata ?? {}) !== JSON.stringify(c.metadata ?? {});
        const outputs = JSON.stringify(was.outputs ?? []) !== JSON.stringify(c.outputs ?? []);
        const summary = was.executionCount !== c.executionCount;
        if (doc || md || outputs || summary)
          cellChanges.push({
            cell,
            document: doc ? cell.document : undefined,
            metadata: md || (summary && this.isIpynb) ? cell.metadata : undefined,
            outputs: outputs ? cell.outputs : undefined,
            executionSummary: summary ? cell.executionSummary : undefined,
          });
      }
      return cell;
    });
    if (oldCells.length || this.cells.length) this.version++;
    return {
      contentChanges: contentChange(
        before.map((c) => c.id),
        this.ids,
        oldCells,
        this.cells,
      ),
      cellChanges,
      metadata: sameMetadata ? undefined : this.metadata,
    };
  }

  private cellOf(c: ReadCell, index: number, old?: ShimNotebookCell): ShimNotebookCell {
    const language =
      c.kind === "markdown"
        ? "markdown"
        : c.kind === "raw"
          ? "raw"
          : vscodeLanguageId(c.language ?? "plaintext");
    // One document for the cell's life, as in VS Code: its text changes in place (a new
    // version, onDidChangeTextDocument); a new language closes and opens it again.
    let document = old?.document;
    if (document && !document.isClosed) {
      if (document.languageId !== language) {
        this.closeDocument(document);
        document.languageId = language;
        document.isClosed = false;
        if (document.setText(c.source)) document.version++;
        this.cellDocs?.opened(document);
      } else this.setDocumentText(document, c.source);
    } else {
      document = new ShimTextDocument(
        `vscode-notebook-cell:${this.path}#${c.id}`,
        language,
        c.source,
      );
      this.cellDocs?.opened(document);
    }
    const cell = {
      index,
      notebook: this,
      kind: (c.kind === "markdown" ? 1 : 2) as 1 | 2,
      document,
      metadata: cellMetadataOf(c, this.isIpynb),
      outputs: this.outputsOf(c.outputs ?? []),
      executionSummary:
        typeof c.executionCount === "number" ? { executionOrder: c.executionCount } : undefined,
    };
    // A kept cell stays the same object (extensions keep them in maps).
    return old ? Object.assign(old, cell) : cell;
  }
}

/** The cells added and removed between two lists of ids, as one range (VS Code's shape). */
export function contentChange<T>(
  before: readonly string[],
  after: readonly string[],
  oldCells: readonly T[],
  newCells: readonly T[],
): { range: NotebookRange; removedCells: T[]; addedCells: T[] }[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  const removedEnd = before.length - tail;
  const addedEnd = after.length - tail;
  if (start === removedEnd && start === addedEnd) return [];
  return [
    {
      range: new NotebookRange(start, removedEnd),
      removedCells: oldCells.slice(start, removedEnd),
      addedCells: newCells.slice(start, addedEnd),
    },
  ];
}

/** Selected cells' indexes as VS Code's ranges (runs of neighbours). */
export function rangesOf(indexes: readonly number[]): NotebookRange[] {
  const sorted = [...new Set(indexes)].filter((i) => i >= 0).sort((a, b) => a - b);
  const out: NotebookRange[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && last.end === i) out[out.length - 1] = new NotebookRange(last.start, i + 1);
    else out.push(new NotebookRange(i, i + 1));
  }
  return out;
}

/**
 * A metadata replacement as the IDE's merge (`notebook.setMetadata`): keys that went are null.
 * The IDE's own `vscode` key (a cell's language) stays.
 */
export function metadataPatch(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...after };
  for (const key of Object.keys(before)) if (!(key in after) && key !== "vscode") patch[key] = null;
  return patch;
}

/** One NotebookEdit as the IDE's cell commands, in order. */
export function editSteps(
  edit: NotebookEdit,
  nb: {
    ids: readonly string[];
    metadata: Record<string, unknown>;
    cellMetadata(i: number): Record<string, unknown>;
    /** A Jupyter notebook: `metadata` and cells' are in VS Code's ipynb layout (unwrapped here). */
    ipynb?: boolean;
  },
  path: string,
  /** A new cell's outputs as nbformat (D267: they go in with it). */
  toNb: (outputs: readonly NotebookCellOutput[]) => Record<string, unknown>[] = () => [],
): {
  command: string;
  input: Record<string, unknown>;
  cell?: number;
}[] {
  // The file's metadata (VS Code's ipynb layout wraps a Jupyter notebook's, ipynbMetadata.ts).
  const fileNotebook = (md: Record<string, unknown>) =>
    nb.ipynb ? fromVscodeNotebookMetadata(md) : md;
  const fileCell = (md: Record<string, unknown>) =>
    nb.ipynb ? fromVscodeCellMetadata(md).metadata : md;
  if (edit.newNotebookMetadata)
    return [
      {
        command: "notebook.setMetadata",
        input: {
          path,
          metadata: metadataPatch(
            fileNotebook(nb.metadata),
            fileNotebook(edit.newNotebookMetadata),
          ),
        },
      },
    ];
  const cellMetadata = (edit as { newCellMetadata?: Record<string, unknown> }).newCellMetadata;
  if (cellMetadata) {
    const id = nb.ids[edit.range.start];
    if (id === undefined) throw new Error(`No cell ${edit.range.start}.`);
    return [
      {
        command: "notebook.setMetadata",
        input: {
          path,
          cellId: id,
          metadata: metadataPatch(
            fileCell(nb.cellMetadata(edit.range.start)),
            fileCell(cellMetadata),
          ),
        },
      },
    ];
  }
  const steps: ReturnType<typeof editSteps> = [];
  const removed = nb.ids.slice(edit.range.start, edit.range.end);
  if (removed.length)
    steps.push({ command: "notebook.deleteCell", input: { path, cellIds: removed } });
  edit.newCells.forEach((c, i) => {
    const kind = c.kind === 1 ? "markdown" : c.languageId === "raw" ? "raw" : "code";
    const outputs = kind === "code" && c.outputs?.length ? toNb(c.outputs) : [];
    const order = c.executionSummary?.executionOrder;
    const metadata = c.metadata ? fileCell(c.metadata) : undefined;
    steps.push({
      command: "notebook.insertCell",
      input: {
        path,
        index: edit.range.start + i,
        kind,
        source: c.value,
        ...(metadata && Object.keys(metadata).length && { metadata }),
        ...(outputs.length && { outputs }),
        ...(kind === "code" && typeof order === "number" && { executionCount: order }),
      },
      cell: i,
    });
  });
  return steps;
}

/** The notebook editor (VS Code's NotebookEditor) for the active notebook. */
class ShimNotebookEditor {
  private ranges: NotebookRange[];

  constructor(
    readonly notebook: ShimNotebook,
    selections: NotebookRange[],
    private readonly ide: WorkerApi,
  ) {
    this.ranges = selections;
  }

  readonly viewColumn = 1;

  get selections(): readonly NotebookRange[] {
    return this.ranges;
  }

  set selections(ranges: readonly NotebookRange[]) {
    this.ranges = [...ranges];
    const cellIds = ranges.flatMap((r) => this.notebook.ids.slice(r.start, r.end));
    if (cellIds.length)
      void this.ide.commands
        .execute("notebook.selectCells", { path: this.notebook.path, cellIds })
        .catch(() => {});
  }

  get selection(): NotebookRange {
    return this.ranges[0] ?? new NotebookRange(0, 0);
  }

  set selection(range: NotebookRange) {
    this.selections = [range];
  }

  get visibleRanges(): NotebookRange[] {
    return [new NotebookRange(0, this.notebook.cellCount)];
  }

  setSelections(ranges: NotebookRange[]): void {
    this.ranges = ranges;
  }

  revealRange(range: NotebookRange): void {
    void this.ide.commands
      .execute("notebook.revealCell", { path: this.notebook.path, index: range.start })
      .catch(() => {});
  }
}

const sameRanges = (a: readonly NotebookRange[], b: readonly NotebookRange[]) =>
  a.length === b.length && a.every((r, i) => r.start === b[i]?.start && r.end === b[i]?.end);

/** The open notebooks, the active editor, and applying NotebookEdits. */
export function createNotebookEditors(
  ide: WorkerApi,
  outputsOf: OutputsOf,
  toNb: (outputs: readonly NotebookCellOutput[]) => Record<string, unknown>[],
  /** The open text documents its cells' documents join (workspace.textDocuments). */
  cellDocs?: CellDocumentEvents,
) {
  const open = new Map<string, ShimNotebook>();
  const onDidOpen = new EventEmitter<ShimNotebook>();
  const onDidClose = new EventEmitter<ShimNotebook>();
  const onDidSave = new EventEmitter<ShimNotebook>();
  const onDidChange = new EventEmitter<unknown>();
  const onDidChangeActive = new EventEmitter<ShimNotebookEditor | undefined>();
  const onDidChangeVisible = new EventEmitter<readonly ShimNotebookEditor[]>();
  const onDidChangeSelection = new EventEmitter<unknown>();
  let active: ShimNotebookEditor | undefined;

  const save = async (nb: ShimNotebook) => {
    const r = await ide.commands
      .execute<{ saved?: unknown }>("notebook.save", { path: nb.path })
      .catch(() => null);
    return !!r;
  };
  /** The notebook for `path` (made if it isn't known; read with `refresh`). */
  const known = (path: string, notebookType: string): ShimNotebook => {
    let nb = open.get(pathKey(path));
    if (!nb) {
      nb = new ShimNotebook(path, notebookType, save, outputsOf, cellDocs);
      open.set(pathKey(path), nb);
    }
    // Made before its type was known (the active editor's event came first).
    else if (!nb.notebookType && notebookType) nb.notebookType = vscodeNotebookType(notebookType);
    return nb;
  };
  const read = (path: string) =>
    ide.commands.execute<NotebookRead>("notebook.read", { path, metadata: true, outputs: true });
  /** Reads its cells again; the changes go to onDidChangeNotebookDocument. */
  const refresh = async (nb: ShimNotebook, fire = true) => {
    const changes = nb.update(await read(nb.path));
    if (fire && (changes.contentChanges.length || changes.cellChanges.length || changes.metadata))
      onDidChange.fire({ notebook: nb, ...changes });
  };
  // A burst of changes (typing in a cell) is read once.
  const timers = new Map<ShimNotebook, ReturnType<typeof setTimeout>>();
  const refreshSoon = (nb: ShimNotebook) => {
    clearTimeout(timers.get(nb));
    timers.set(
      nb,
      setTimeout(() => {
        timers.delete(nb);
        if (!nb.isClosed) void refresh(nb).catch(() => {});
      }, 80),
    );
  };

  const payload = (p: unknown) => p as { path: string; notebookType: string };
  ide.events.on("notebook.didOpen", (p) => {
    const { path, notebookType } = payload(p);
    const nb = known(path, notebookType);
    nb.isClosed = false;
    // Opened with its cells, as in VS Code.
    void refresh(nb, false)
      .catch(() => {})
      .then(() => onDidOpen.fire(nb));
  });
  ide.events.on("notebook.didClose", (p) => {
    const key = pathKey(payload(p).path);
    const nb = open.get(key);
    open.delete(key);
    if (!nb) return;
    nb.isClosed = true;
    clearTimeout(timers.get(nb));
    onDidClose.fire(nb);
    // Its cells' documents close with it (onDidCloseTextDocument, as in VS Code).
    nb.closeCells();
  });
  ide.events.on("notebook.didSave", (p) => {
    const nb = open.get(pathKey(payload(p).path));
    if (!nb) return;
    nb.isDirty = false;
    onDidSave.fire(nb);
  });
  ide.events.on("notebook.didChange", (p) => {
    const nb = open.get(pathKey(payload(p).path));
    if (!nb) return;
    nb.isDirty = true;
    refreshSoon(nb);
  });

  /** The active notebook editor as the IDE tells it (or none). */
  ide.editor.onDidChangeNotebook((e) => {
    if (!e) {
      if (!active) return;
      active = undefined;
      onDidChangeActive.fire(undefined);
      onDidChangeVisible.fire([]);
      return;
    }
    const nb = open.get(pathKey(e.path)) ?? known(e.path, "");
    const ranges = rangesOf(e.selection);
    if (active?.notebook === nb) {
      if (sameRanges(active.selections, ranges)) return;
      active.setSelections(ranges);
      onDidChangeSelection.fire({ notebookEditor: active, selections: ranges });
      return;
    }
    const editor = new ShimNotebookEditor(nb, ranges, ide);
    const fire = () => {
      // Another one may have become active while its cells were read.
      if (active !== editor) return;
      onDidChangeActive.fire(editor);
      onDidChangeVisible.fire([editor]);
    };
    active = editor;
    if (nb.version === 0)
      void refresh(nb, false)
        .catch(() => {})
        .then(fire);
    else fire();
  });

  /** Waits (a few seconds at most) for `path` to be the active notebook. */
  const activeFor = async (path: string): Promise<ShimNotebookEditor | undefined> => {
    const key = pathKey(path);
    for (let i = 0; i < 100; i++) {
      if (active && pathKey(active.notebook.path) === key) return active;
      await new Promise((r) => setTimeout(r, 50));
    }
    return undefined;
  };

  const showNotebookDocument = async (
    target: ShimNotebook | Uri,
    options?: { selections?: NotebookRange[] },
  ) => {
    const path = target instanceof ShimNotebook ? target.path : pathOf(target);
    // An untitled notebook has no file to open: its tab is shown.
    if (path.startsWith("untitled:")) await ide.commands.execute("notebook.newUntitled", { path });
    else await ide.commands.execute("editor.openFile", { path });
    const editor = await activeFor(path);
    if (!editor) throw new Error(`${path} didn't open as a notebook.`);
    if (options?.selections?.length) editor.selections = options.selections;
    return editor;
  };

  const openNotebookDocument = async (uri: Uri) => {
    const path = pathOf(uri);
    const nb = open.get(pathKey(path));
    if (nb && nb.version > 0) return nb;
    // The IDE opens it in its notebook editor to read it (VS Code doesn't show it).
    const r = await read(path);
    const doc = known(r.path, r.type);
    doc.update(r);
    return doc;
  };

  /** NotebookEdits for one notebook, each against the notebook as the previous one left it. */
  const applyNotebookEdits = async (path: string, edits: NotebookEdit[]): Promise<void> => {
    const r = await read(path);
    const nb = known(r.path, r.type);
    nb.update(r);
    for (const edit of edits) {
      const steps = editSteps(
        edit,
        {
          ids: nb.ids,
          metadata: nb.metadata,
          cellMetadata: (i) => nb.cellAt(i)?.metadata ?? {},
          ipynb: nb.isIpynb,
        },
        nb.path,
        toNb,
      );
      for (const step of steps) {
        const done = await ide.commands.execute<{ cellId?: string }>(step.command, step.input);
        const data = step.cell !== undefined ? edit.newCells[step.cell] : undefined;
        if (!data || !done?.cellId) continue;
        // A code cell's own language (its metadata and outputs went in with it).
        if (data.kind !== 1 && data.languageId && data.languageId !== "raw")
          await ide.commands.execute("notebook.changeCellLanguage", {
            path: nb.path,
            cellId: done.cellId,
            language: data.languageId,
          });
      }
      await refresh(nb);
    }
  };

  /** The notebooks open before it started, and the active one (no event told it of those). */
  const ready = async () => {
    const state = (await ide.state.get("ide://notebook").catch(() => null)) as {
      open?: string[];
      active?: { path: string; selection?: string[] } | null;
    } | null;
    await Promise.all(
      (state?.open ?? []).map(async (path) => {
        const r = await read(path).catch(() => null);
        if (r) known(r.path, r.type).update(r);
      }),
    );
    const now = state?.active;
    const nb = now ? open.get(pathKey(now.path)) : undefined;
    if (now && nb && !active)
      active = new ShimNotebookEditor(
        nb,
        rangesOf((now.selection ?? []).map((id) => nb.ids.indexOf(id))),
        ide,
      );
  };

  return {
    known,
    ready,
    /** The notebook documents VS Code's workspace has. */
    documents: () => [...open.values()].filter((nb) => !nb.isClosed),
    onDidOpen: onDidOpen.event,
    onDidClose: onDidClose.event,
    onDidSave: onDidSave.event,
    onDidChange: onDidChange.event,
    openNotebookDocument,
    applyNotebookEdits,
    window: {
      get activeNotebookEditor() {
        return active;
      },
      get visibleNotebookEditors() {
        return active ? [active] : [];
      },
      onDidChangeActiveNotebookEditor: onDidChangeActive.event,
      onDidChangeVisibleNotebookEditors: onDidChangeVisible.event,
      onDidChangeNotebookEditorSelection: onDidChangeSelection.event,
      onDidChangeNotebookEditorVisibleRanges: new EventEmitter<unknown>().event,
      showNotebookDocument,
    },
  };
}
