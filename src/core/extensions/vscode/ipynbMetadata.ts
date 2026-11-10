// Jupyter notebooks' metadata as VS Code's built-in ipynb extension gives it to extensions
// (extensions/ipynb/src/deserializers.ts and serializers.ts there, with dropCustomMetadata):
// a cell's metadata is `{ execution_count, metadata, id, attachments }` (the file's cell fields;
// `metadata` is the file's cell metadata), and the notebook's is the file without its cells
// (`{ cells: [], metadata, nbformat, nbformat_minor }` plus `indentAmount`). The IDE keeps the
// file's metadata as it is (core/notebook/ipynb.ts), so the `vscode` shim wraps it on the way
// to extensions and unwraps what they write back (NotebookEdit.updateCellMetadata /
// updateNotebookMetadata, new cells). Jupyter reads `cell.metadata.metadata` and
// `notebook.metadata.metadata` that way. DOM-free and unit-tested.

/** VS Code's name for Jupyter notebooks: the type whose metadata has this layout. */
export const VSCODE_IPYNB_TYPE = "jupyter-notebook";

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** A deep copy (VS Code's deserializer copies the file's metadata with JSON). */
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The file's fields of a cell, as the IDE keeps them. */
export interface IpynbCellFields {
  kind: "code" | "markdown" | "raw";
  /** The cell's metadata as the file has it. */
  metadata?: Record<string, unknown>;
  id?: string;
  executionCount?: number | null;
  attachments?: unknown;
}

/** A cell's metadata as VS Code's ipynb extension gives it (getNotebookCellMetadata). */
export function toVscodeCellMetadata(cell: IpynbCellFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (cell.kind === "code")
    out.execution_count = typeof cell.executionCount === "number" ? cell.executionCount : null;
  out.metadata = copy(cell.metadata ?? {});
  if (typeof cell.id === "string" && cell.id) out.id = cell.id;
  if (cell.attachments !== undefined && cell.attachments !== null)
    out.attachments = copy(cell.attachments);
  return out;
}

/** The fields VS Code's layout wraps a file's cell metadata in. */
const CELL_WRAPPER = ["metadata", "execution_count", "id", "attachments", "custom"];

/**
 * The file's cell fields from VS Code's layout (what an extension wrote): `metadata` (or the old
 * `custom.metadata`); metadata with none of the layout's fields is taken as the file's itself.
 */
export function fromVscodeCellMetadata(md: unknown): {
  metadata: Record<string, unknown>;
  attachments?: unknown;
  id?: string;
} {
  if (!isObject(md)) return { metadata: {} };
  const custom = isObject(md.custom) ? md.custom : undefined;
  const wrapped = isObject(md.metadata)
    ? md.metadata
    : custom && isObject(custom.metadata)
      ? custom.metadata
      : undefined;
  if (!wrapped && !CELL_WRAPPER.some((k) => k in md)) return { metadata: copy(md) };
  const attachments = md.attachments ?? custom?.attachments;
  const id = typeof md.id === "string" ? md.id : typeof custom?.id === "string" ? custom.id : "";
  return {
    metadata: copy(wrapped ?? {}),
    ...(attachments !== undefined && attachments !== null && { attachments: copy(attachments) }),
    ...(id && { id }),
  };
}

/** The notebook's metadata as VS Code's ipynb extension gives it (the file without its cells). */
export function toVscodeNotebookMetadata(
  metadata: Record<string, unknown> | undefined,
  format: { nbformat?: number; nbformatMinor?: number; extra?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    // The file's own other top-level fields, as VS Code keeps them.
    ...copy(format.extra ?? {}),
    cells: [],
    metadata: copy(metadata ?? {}),
    nbformat: format.nbformat ?? 4,
    nbformat_minor: format.nbformatMinor ?? 5,
    // The IDE writes Jupyter's one-space indents (VS Code reads the file's).
    indentAmount: " ",
  };
}

/** The fields VS Code's layout puts beside the file's notebook metadata. */
const NOTEBOOK_WRAPPER = [
  "metadata",
  "cells",
  "nbformat",
  "nbformat_minor",
  "indentAmount",
  "custom",
];

/** The file's notebook metadata from VS Code's layout (what an extension wrote). */
export function fromVscodeNotebookMetadata(md: unknown): Record<string, unknown> {
  if (!isObject(md)) return {};
  if (isObject(md.metadata)) return copy(md.metadata);
  const custom = isObject(md.custom) ? md.custom : undefined;
  if (custom && isObject(custom.metadata)) return copy(custom.metadata);
  if (NOTEBOOK_WRAPPER.some((k) => k in md)) return {};
  return copy(md);
}
