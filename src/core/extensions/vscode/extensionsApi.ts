// VS Code's `extensions` namespace for one extension of the shared Node host (D295): every
// installed and enabled VS Code package (code or not), with its live exports once it has
// activated in this process — the same object its own `activate` returned, as in VS Code —
// `isActive` as it is now, and `onDidChange` when the list or an activation changes. Built-in
// extensions the IDE stands in for (`vscode.git`, `vscode.ipynb`) are listed too.
// DOM-free and unit-tested.

import { newCellId, serializeIpynb } from "../../notebook/ipynb";
import type { NbCell, Notebook } from "../../notebook/types";
import type { SharedExtensionRegistry } from "./extensionRegistry";
import { toIdeNotebook } from "./notebooks";
import { EventEmitter, ExtensionKind, Uri } from "./types";
import type { NotebookData } from "./workbenchTypes";

/** A VS Code `Extension` object (what `getExtension` returns). */
export interface ShimExtension {
  readonly id: string;
  readonly extensionUri: Uri;
  readonly extensionPath: string;
  readonly isActive: boolean;
  readonly packageJSON: Record<string, unknown>;
  readonly extensionKind: ExtensionKind;
  readonly exports: unknown;
  activate(): Promise<unknown>;
}

export interface ExtensionsApiOptions {
  /** This extension's id as the IDE has it (lowercase). */
  selfId: string;
  selfPath: string;
  selfPackage: Record<string, unknown>;
  registry: SharedExtensionRegistry;
  /** Another package's package.json (VS Code's `packageJSON` is synchronous). */
  readPackage(path: string): Record<string, unknown> | undefined;
  /**
   * Asks the IDE to activate `id` (its dependencies, permissions and trust are checked there):
   * resolves once it has activated in this process.
   */
  activate(id: string): Promise<void>;
  /** Built-in extensions the IDE stands in for, by lowercase id. */
  builtIns: Record<string, object>;
}

export function createExtensionsApi(o: ExtensionsApiOptions) {
  const objects = new Map<string, ShimExtension>();
  const activating = new Map<string, Promise<unknown>>();
  const changed = new EventEmitter<void>();
  const off = o.registry.onDidChange(() => changed.fire());

  const make = (key: string, path: string): ShimExtension => {
    let pkg: Record<string, unknown> | undefined;
    const packageJSON = () => {
      pkg ??= key === o.selfId ? o.selfPackage : (o.readPackage(path) ?? {});
      return pkg;
    };
    const activate = (): Promise<unknown> => {
      if (o.registry.isActive(key)) return Promise.resolve(o.registry.exportsOf(key));
      // Nothing to run: active as soon as asked (VS Code's descriptive-only extensions).
      if (o.registry.get(key)?.hasCode === false) {
        o.registry.setActive(key, undefined);
        return Promise.resolve(undefined);
      }
      let pending = activating.get(key);
      if (!pending) {
        pending = o
          .activate(key)
          .then(() => o.registry.exportsOf(key))
          .finally(() => activating.delete(key));
        activating.set(key, pending);
      }
      return pending;
    };
    return {
      get id() {
        const p = packageJSON();
        return typeof p.publisher === "string" && typeof p.name === "string"
          ? `${p.publisher}.${p.name}`
          : key;
      },
      extensionUri: Uri.file(path),
      extensionPath: path,
      get isActive() {
        return o.registry.isActive(key);
      },
      get packageJSON() {
        return packageJSON();
      },
      // Desktop, not remote: every extension runs beside the UI (VS Code's ExtensionKind.UI).
      extensionKind: ExtensionKind.UI,
      get exports() {
        return o.registry.exportsOf(key);
      },
      activate,
    };
  };

  const extensionOf = (id: string): ShimExtension | undefined => {
    const key = id.toLowerCase();
    const info = key === o.selfId ? { path: o.selfPath } : o.registry.get(key);
    if (!info) return undefined;
    let ext = objects.get(key);
    // Reinstalled elsewhere (a development copy): a new object for the new folder.
    if (!ext || ext.extensionPath !== info.path) {
      ext = make(key, info.path);
      objects.set(key, ext);
    }
    return ext;
  };

  const self = extensionOf(o.selfId) as ShimExtension;
  const api = {
    getExtension: (id: string): unknown => {
      if (typeof id !== "string") return undefined;
      const builtIn = o.builtIns[id.toLowerCase()];
      if (builtIn) return builtIn;
      return extensionOf(id);
    },
    get all(): readonly unknown[] {
      const listed = o.registry
        .list()
        .filter((e) => e.id.toLowerCase() !== o.selfId)
        .flatMap((e) => extensionOf(e.id) ?? []);
      return [self, ...Object.values(o.builtIns), ...listed];
    },
    onDidChange: changed.event,
  };
  return {
    api,
    self,
    dispose: () => {
      off();
      changed.dispose();
    },
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * VS Code's built-in ipynb extension's API, on the IDE's own .ipynb writer (D204). The IDE's
 * notebooks give extensions a cell's and the notebook's metadata in that extension's layout
 * without the old `custom` key (ipynbMetadata.ts: `cell.metadata.metadata`,
 * `notebook.metadata.metadata`): `dropCustomMetadata` is true (Jupyter reads metadata that way).
 */
export function createIpynbExtension(): object {
  const exportsValue = {
    dropCustomMetadata: true,
    exportNotebook: (data: NotebookData): Promise<string> => Promise.resolve(exportNotebook(data)),
    setNotebookMetadata: () => Promise.resolve(false),
  };
  return {
    id: "vscode.ipynb",
    extensionUri: Uri.file(""),
    extensionPath: "",
    isActive: true,
    packageJSON: {
      name: "ipynb",
      publisher: "vscode",
      displayName: ".ipynb Support",
      version: "1.0.0",
    },
    extensionKind: ExtensionKind.UI,
    exports: exportsValue,
    activate: () => Promise.resolve(exportsValue),
  };
}

/** NotebookData → .ipynb text, as the IDE saves notebooks. */
export function exportNotebook(data: NotebookData): string {
  const ide = toIdeNotebook(data);
  const meta = isObject(data.metadata) ? data.metadata : {};
  // VS Code's layout (the file's metadata under `metadata`) or the IDE's (as the file has it).
  const nbMeta = isObject(meta.metadata) && !("kernelspec" in meta) ? meta.metadata : meta;
  const info = isObject(nbMeta.language_info) ? nbMeta.language_info : {};
  const language = typeof info.name === "string" ? info.name : "python";
  const taken = new Set<string>();
  const cells: NbCell[] = ide.cells.map((c, i) => {
    const raw = data.cells[i]?.metadata;
    const own = isObject(raw) && isObject(raw.metadata) ? raw.metadata : { ...(c.metadata ?? {}) };
    const languageId = data.cells[i]?.languageId;
    // The cell's language only when it isn't the notebook's (VS Code's ipynb does the same).
    delete own.vscode;
    if (c.kind === "code" && languageId && languageId !== language) own.vscode = { languageId };
    const wanted = isObject(raw) && typeof raw.id === "string" ? raw.id : "";
    const id = wanted && !taken.has(wanted) ? wanted : newCellId(taken);
    taken.add(id);
    return {
      id,
      kind: c.kind,
      source: c.source,
      metadata: own,
      outputs: (c.outputs ?? []) as NbCell["outputs"],
      executionCount: c.executionCount ?? null,
      extra: {},
    };
  });
  const notebook: Notebook = { cells, metadata: nbMeta, nbformat: 4, nbformatMinor: 5, extra: {} };
  return serializeIpynb(notebook);
}
