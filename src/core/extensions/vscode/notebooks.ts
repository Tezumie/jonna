// The `vscode` shim's notebooks (D257) on the IDE's (`ide.notebooks`): serializers (VS Code's
// NotebookData of bytes ↔ the IDE's cells with nbformat outputs), controllers as kernel sources
// (a cell runs through the controller's executeHandler; its NotebookCellExecution's outputs
// stream into the cell), cell status bar items, renderer messaging, and the open notebooks.
// DOM-free and unit-tested.

import { INTERACTIVE_NOTEBOOK, JUPYTER_NOTEBOOK } from "../../notebook/providers";
import type { KernelEvent } from "../../notebook/types";
import type { WorkerApi } from "../rpc";
import { fromBase64, toBase64 } from "../rpcAuthFs";
import type { NotebookData as IdeNotebookData } from "../rpcNotebooks";
import type { ShimCommands } from "./commands";
import { pathOf } from "./convert";
import { ShimTextDocument } from "./document";
import {
  fromVscodeCellMetadata,
  fromVscodeNotebookMetadata,
  toVscodeCellMetadata,
  toVscodeNotebookMetadata,
  VSCODE_IPYNB_TYPE,
} from "./ipynbMetadata";
import { type CellDocumentEvents, createNotebookEditors, ideNotebookType } from "./notebookEditors";
import {
  CancellationTokenSource,
  Disposable,
  EventEmitter,
  eventOf,
  NONE_TOKEN,
  Uri,
} from "./types";
import {
  NotebookCellData,
  NotebookCellOutput,
  NotebookCellOutputItem,
  NotebookData,
  NotebookEdit,
} from "./workbenchTypes";

type IdeCell = IdeNotebookData["cells"][number];

const STDOUT = "application/vnd.code.notebook.stdout";
const STDERR = "application/vnd.code.notebook.stderr";
const ERROR = "application/vnd.code.notebook.error";

const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const encode = (s: string) => new TextEncoder().encode(s);
const isText = (mime: string) =>
  mime.startsWith("text/") || /json|xml|javascript/.test(mime) || mime === "image/svg+xml";

/** VS Code's host for local files in a webview (its asWebviewUri's). */
export const WEBVIEW_RESOURCE_AUTHORITY = "file+.vscode-resource.vscode-cdn.net";

/**
 * A controller's asWebviewUri, as VS Code gives it (`https://file%2B.vscode-resource.
 * vscode-cdn.net/c%3A/…`): the notebook's output page loads such addresses through the IDE.
 * Anything but a file is returned as it is.
 */
export function notebookWebviewUri(uri: Uri): Uri {
  if (!(uri instanceof Uri) || uri.scheme !== "file") return uri;
  return Uri.from({
    scheme: "https",
    authority: WEBVIEW_RESOURCE_AUTHORITY,
    path: uri.path,
    query: uri.query,
    fragment: uri.fragment,
  });
}

/** An output's items as the IDE's kernel events (streams, an error, or a mime bundle). */
export function outputEvents(output: NotebookCellOutput): KernelEvent[] {
  const events: KernelEvent[] = [];
  const data: Record<string, string> = {};
  for (const item of output.items) {
    if (item.mime === STDOUT || item.mime === STDERR)
      events.push({
        type: "stream",
        name: item.mime === STDOUT ? "stdout" : "stderr",
        text: decode(item.data),
      });
    else if (item.mime === ERROR) {
      let e: { name?: string; message?: string; stack?: string } = {};
      try {
        // `null` or a number is valid JSON too, and not the shape.
        const parsed = JSON.parse(decode(item.data)) as unknown;
        if (parsed && typeof parsed === "object") e = parsed as typeof e;
      } catch {
        // Not VS Code's error shape: shown as its text.
      }
      events.push({
        type: "error",
        ename: e.name ?? "Error",
        evalue: e.message ?? decode(item.data),
        traceback: (e.stack ?? "").split("\n").filter(Boolean),
      });
    } else data[item.mime] = isText(item.mime) ? decode(item.data) : toBase64(item.data);
  }
  if (Object.keys(data).length)
    events.push({ type: "display", data, metadata: output.metadata ?? {} });
  return events;
}

/** An output as nbformat (what the IDE's notebook cells keep). */
export function toNbOutput(output: NotebookCellOutput): Record<string, unknown>[] {
  return outputEvents(output).map((e) => {
    if (e.type === "stream") return { output_type: "stream", name: e.name, text: e.text };
    if (e.type === "error")
      return { output_type: "error", ename: e.ename, evalue: e.evalue, traceback: e.traceback };
    return { output_type: "display_data", data: e.data, metadata: e.metadata ?? {} };
  });
}

function fromNbOutput(o: Record<string, unknown>): NotebookCellOutput {
  const text = (v: unknown) => (Array.isArray(v) ? v.join("") : String(v ?? ""));
  if (o.output_type === "stream")
    return new NotebookCellOutput([
      o.name === "stderr"
        ? NotebookCellOutputItem.stderr(text(o.text))
        : NotebookCellOutputItem.stdout(text(o.text)),
    ]);
  if (o.output_type === "error")
    return new NotebookCellOutput([
      NotebookCellOutputItem.error({
        name: String(o.ename ?? "Error"),
        message: String(o.evalue ?? ""),
        stack: Array.isArray(o.traceback) ? o.traceback.join("\n") : "",
      }),
    ]);
  const data = (o.data && typeof o.data === "object" ? o.data : {}) as Record<string, unknown>;
  const items = Object.entries(data).map(([mime, v]) =>
    isText(mime)
      ? NotebookCellOutputItem.text(
          typeof v === "string" ? v : Array.isArray(v) ? v.join("") : JSON.stringify(v),
          mime,
        )
      : new NotebookCellOutputItem(fromBase64(text(v)), mime),
  );
  return new NotebookCellOutput(items, (o.metadata as Record<string, unknown>) ?? undefined);
}

const languageOf = (c: IdeCell) =>
  ((c.metadata?.vscode as { languageId?: unknown } | undefined)?.languageId as
    | string
    | undefined) ?? (c.kind === "markdown" ? "markdown" : c.kind === "raw" ? "raw" : "plaintext");

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** A Jupyter notebook's language for its cells (VS Code's getPreferredLanguage). */
function preferredLanguage(metadata: Record<string, unknown> | undefined): string | undefined {
  const info = metadata?.language_info;
  const spec = metadata?.kernelspec;
  const name =
    (isObject(info) && typeof info.name === "string" && info.name) ||
    (isObject(spec) && typeof spec.language === "string" && spec.language) ||
    "";
  return name || undefined;
}

/** Whether `type` (VS Code's name or the IDE's) is Jupyter's, whose metadata VS Code wraps. */
const isIpynb = (type: string | undefined) =>
  type === VSCODE_IPYNB_TYPE || type === JUPYTER_NOTEBOOK;

/**
 * Marks a cell whose extension wrote `vscode.languageId` in its metadata itself: the IDE keeps
 * every cell's language there, and gives it back only to those (fromIdeNotebook).
 */
const OWN_LANGUAGE = "vscodeLanguageInMetadata";

/** The cell's own language (metadata.vscode.languageId), if it names one. */
function cellLanguage(c: IdeCell): string | undefined {
  const vscode = c.metadata?.vscode;
  const id = isObject(vscode) ? vscode.languageId : undefined;
  return typeof id === "string" && id ? id : undefined;
}

/** A cell's metadata without the language the IDE added to it (an extension's own stays). */
function withoutAddedLanguage(
  metadata: Record<string, unknown>,
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (extra?.[OWN_LANGUAGE] === true || !isObject(metadata.vscode)) return metadata;
  const { languageId: _added, ...vscode } = metadata.vscode;
  const { vscode: _all, ...rest } = metadata;
  return Object.keys(vscode).length ? { ...rest, vscode } : rest;
}

/**
 * An extension's NotebookData as the IDE's cells. A Jupyter notebook's (`notebookType`
 * jupyter-notebook) comes in VS Code's ipynb layout (ipynbMetadata.ts) and is unwrapped to the
 * file's metadata, a code cell's language in `metadata.vscode` only when it isn't the notebook's
 * (VS Code's serializer); another type's metadata is kept as it is, with the cell's language
 * added for the editor.
 */
export function toIdeNotebook(data: NotebookData, notebookType?: string): IdeNotebookData {
  if (isIpynb(notebookType)) {
    const metadata = data.metadata ? fromVscodeNotebookMetadata(data.metadata) : undefined;
    const preferred =
      preferredLanguage(metadata) ?? data.cells.find((c) => c.kind === 2)?.languageId;
    return {
      cells: data.cells.map((c) => {
        const kind = c.kind === 1 ? "markdown" : c.languageId === "raw" ? "raw" : "code";
        const raw = isObject(c.metadata) ? c.metadata : {};
        const file = fromVscodeCellMetadata(raw);
        const own = { ...file.metadata };
        if (kind === "code") {
          if (c.languageId && c.languageId !== preferred) own.vscode = { languageId: c.languageId };
          else delete own.vscode;
        }
        // VS Code writes the count its cell metadata has (kept in step with runs).
        const count =
          typeof raw.execution_count === "number"
            ? raw.execution_count
            : (c.executionSummary?.executionOrder ?? null);
        return {
          ...(file.id && { id: file.id }),
          kind,
          source: c.value,
          metadata: own,
          ...(c.outputs?.length && { outputs: c.outputs.flatMap(toNbOutput) }),
          executionCount: kind === "code" ? count : null,
          ...(file.attachments !== undefined && { extra: { attachments: file.attachments } }),
        };
      }),
      ...(metadata && { metadata }),
    };
  }
  return {
    cells: data.cells.map((c) => {
      const md = isObject(c.metadata) ? c.metadata : {};
      const vscode = isObject(md.vscode) ? md.vscode : {};
      return {
        kind: c.kind === 1 ? "markdown" : c.languageId === "raw" ? "raw" : "code",
        source: c.value,
        metadata: { ...md, vscode: { ...vscode, languageId: c.languageId } },
        ...(c.outputs?.length && { outputs: c.outputs.flatMap(toNbOutput) }),
        executionCount: c.executionSummary?.executionOrder ?? null,
        ...(typeof vscode.languageId === "string" && { extra: { [OWN_LANGUAGE]: true } }),
      };
    }),
    ...(data.metadata && { metadata: data.metadata }),
  };
}

/** The IDE's cells as an extension's NotebookData (toIdeNotebook's inverse, without loss). */
export function fromIdeNotebook(nb: IdeNotebookData, notebookType?: string): NotebookData {
  const ipynb = isIpynb(notebookType);
  const preferred = preferredLanguage(nb.metadata) ?? "python";
  const out = new NotebookData(
    nb.cells.map((c) => {
      const language = ipynb && c.kind === "code" ? (cellLanguage(c) ?? preferred) : languageOf(c);
      const d = new NotebookCellData(c.kind === "markdown" ? 1 : 2, c.source, language);
      if (ipynb)
        d.metadata = toVscodeCellMetadata({
          kind: c.kind,
          ...(c.metadata && { metadata: c.metadata }),
          ...(c.id && { id: c.id }),
          executionCount: c.executionCount ?? null,
          ...(c.extra?.attachments !== undefined && { attachments: c.extra.attachments }),
        });
      else if (c.metadata) d.metadata = withoutAddedLanguage(c.metadata, c.extra);
      if (c.outputs?.length) d.outputs = c.outputs.map(fromNbOutput);
      if (typeof c.executionCount === "number")
        d.executionSummary = { executionOrder: c.executionCount };
      return d;
    }),
  );
  if (ipynb) out.metadata = toVscodeNotebookMetadata(nb.metadata);
  else if (nb.metadata) out.metadata = nb.metadata;
  return out;
}

/** A kernel source id for a controller: "ctl-" and a hash of its id and notebook type. */
export function kernelSourceId(controllerId: string, notebookType: string): string {
  // Two FNV-1a passes (different seeds): 16 hex digits, unique enough per extension.
  const text = `${notebookType}\u0000${controllerId}`;
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
  }
  return `ctl-${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

export function createNotebooks(
  ide: WorkerApi,
  commands: ShimCommands,
  _unsupported: (name: string) => void,
  /** The open text documents cells' documents join (workspace.textDocuments, its events). */
  cellDocs?: CellDocumentEvents,
) {
  // Documents with their cells, the active editor, NotebookEdits (notebookEditors.ts, D265).
  const editors = createNotebookEditors(
    ide,
    (outputs) => outputs.map(fromNbOutput),
    (outputs) => outputs.flatMap(toNbOutput),
    cellDocs,
  );
  const notebookOf = (path: string, notebookType: string) => editors.known(path, notebookType);

  // VS Code's Interactive Window (`interactive.open`: showOptions, resource, controller id,
  // title): an untitled notebook of type `interactive` the extension adds cells to and runs
  // (NotebookEdit, then notebook.cell.execute). The extension selects its controller itself
  // (notebook.selectKernel). VS Code's input box below it isn't there: its input Uri names none.
  let interactiveSeq = 0;
  commands.openInteractive = async () => {
    const r = await ide.commands.execute<{ path: string }>("notebook.newUntitled", {
      type: INTERACTIVE_NOTEBOOK,
    });
    const notebookUri = Uri.parse(r.path);
    const notebookEditor = await editors.window
      .showNotebookDocument(notebookUri)
      .catch(() => undefined);
    return {
      notebookUri,
      inputUri: Uri.from({
        scheme: "vscode-interactive-input",
        path: `/InteractiveInput-${++interactiveSeq}`,
      }),
      notebookEditor,
    };
  };

  const registerNotebookSerializer = (
    type: string,
    serializer: {
      deserializeNotebook(
        content: Uint8Array,
        token: unknown,
      ): NotebookData | Promise<NotebookData>;
      serializeNotebook(data: NotebookData, token: unknown): Uint8Array | Promise<Uint8Array>;
    },
  ) => {
    const handle = ide.notebooks.registerSerializer(type, {
      deserialize: async (text) =>
        toIdeNotebook(await serializer.deserializeNotebook(encode(text), NONE_TOKEN), type),
      serialize: async (nb) =>
        decode(await serializer.serializeNotebook(fromIdeNotebook(nb, type), NONE_TOKEN)),
    });
    return new Disposable(() => handle.dispose());
  };

  const createNotebookController = (
    id: string,
    notebookType: string,
    label: string,
    handler?: (cells: unknown[], notebook: unknown, controller: unknown) => unknown,
  ) => {
    // The IDE's kernel source for it: a short id of its own (a controller's id holds an
    // interpreter's path, and Jupyter gives one id to its notebook and Interactive Window
    // controllers); its kernel keeps the controller's id (notebook.selectKernel picks by it).
    const sourceId = kernelSourceId(id, notebookType);
    /** A cell running now → the IDE's run of it (where its execution's outputs go). */
    const runs = new Map<
      unknown,
      { emit(e: KernelEvent): void; clear(o?: { wait?: boolean }): void }
    >();
    const ends = new Map<
      unknown,
      (result: { status: "ok" | "error"; count: number | null }) => void
    >();
    const onDidChangeSelectedNotebooks = new EventEmitter<unknown>();
    const onDidReceiveMessage = new EventEmitter<unknown>();
    const controller = {
      id,
      notebookType,
      label,
      description: undefined as string | undefined,
      detail: undefined as string | undefined,
      supportedLanguages: undefined as string[] | undefined,
      supportsExecutionOrder: false,
      executeHandler: handler,
      interruptHandler: undefined as ((notebook: unknown) => unknown) | undefined,
      onDidChangeSelectedNotebooks: onDidChangeSelectedNotebooks.event,
      updateNotebookAffinity: () => {},
      /**
       * Its kernel's variables (VS Code's notebookVariableProvider): the IDE's Variables panel
       * lists the top level.
       */
      variableProvider: undefined as
        | {
            provideVariables(
              notebook: unknown,
              parent: unknown,
              kind: number,
              start: number,
              token: unknown,
            ): AsyncIterable<unknown> | Iterable<unknown>;
            onDidChangeVariables?: unknown;
          }
        | undefined,
      // Messages with the preloads in its notebooks' output page (VS Code's notebookMessaging,
      // D295: Jupyter's ipywidgets): `editor` names one notebook, else every one running it.
      onDidReceiveMessage: onDidReceiveMessage.event,
      postMessage: (message: unknown, editor?: { notebook?: { uri?: unknown } }) => {
        const uri = editor?.notebook?.uri;
        return ide.notebooks.postKernelMessage(
          sourceId,
          message,
          uri instanceof Uri ? pathOf(uri) : undefined,
        );
      },
      // VS Code's address of a local file in the notebook's page; the page asks the IDE for
      // the file (the controller's extension folder or the workspace: notebookPage.ts).
      asWebviewUri: (uri: Uri) => notebookWebviewUri(uri),
      rendererScripts: [] as unknown[],
      createNotebookCellExecution: (cell: unknown) => {
        const run = runs.get(cell);
        const source = new CancellationTokenSource();
        let order: number | undefined;
        const emitAll = (outputs: NotebookCellOutput | readonly NotebookCellOutput[]) => {
          for (const o of Array.isArray(outputs) ? outputs : [outputs])
            for (const e of outputEvents(o)) run?.emit(e);
        };
        return {
          cell,
          token: source.token,
          get executionOrder() {
            return order;
          },
          set executionOrder(v: number | undefined) {
            order = v;
          },
          start: () => {},
          end: (success?: boolean) =>
            ends.get(cell)?.({ status: success === false ? "error" : "ok", count: order ?? null }),
          clearOutput: () => Promise.resolve(run?.clear()),
          replaceOutput: (outputs: NotebookCellOutput | readonly NotebookCellOutput[]) => {
            run?.clear();
            emitAll(outputs);
            return Promise.resolve();
          },
          appendOutput: (outputs: NotebookCellOutput | readonly NotebookCellOutput[]) => {
            emitAll(outputs);
            return Promise.resolve();
          },
          replaceOutputItems: (
            items: NotebookCellOutputItem | readonly NotebookCellOutputItem[],
          ) => {
            run?.clear();
            emitAll(
              new NotebookCellOutput(
                Array.isArray(items) ? [...items] : [items as NotebookCellOutputItem],
              ),
            );
            return Promise.resolve();
          },
          appendOutputItems: (
            items: NotebookCellOutputItem | readonly NotebookCellOutputItem[],
          ) => {
            emitAll(
              new NotebookCellOutput(
                Array.isArray(items) ? [...items] : [items as NotebookCellOutputItem],
              ),
            );
            return Promise.resolve();
          },
        };
      },
      dispose: () => source.dispose(),
    };
    const source = ide.notebooks.registerKernelSource({
      id: sourceId,
      label,
      notebookTypes: [ideNotebookType(notebookType)],
      messaging: true,
      find: () => [
        {
          id,
          label: controller.label,
          ...(controller.description && { detail: controller.description }),
          ...(controller.supportedLanguages && { languages: controller.supportedLanguages }),
        },
      ],
      start: (_option, context, host) => {
        host.setStatus("idle");
        const notebook = notebookOf(context.path, context.notebookType);
        // The notebook picked this controller (VS Code fires it before the first run).
        onDidChangeSelectedNotebooks.fire({ notebook, selected: true });
        // The notebook's editor as the controller's messages name it (VS Code's
        // NotebookEditor): the active one when it shows this notebook.
        const editorOf = () => {
          const shown = editors.window.activeNotebookEditor as { notebook?: unknown } | undefined;
          return shown?.notebook === notebook ? shown : { notebook };
        };
        return {
          // VS Code's NotebookRendererScript uris: the page loads them before any renderer.
          rendererScripts: controller.rendererScripts.flatMap((s) => {
            const uri = (s as { uri?: unknown } | null)?.uri;
            return uri instanceof Uri && uri.scheme === "file" ? [pathOf(uri)] : [];
          }),
          shutdown: () => {
            onDidChangeSelectedNotebooks.fire({ notebook, selected: false });
          },
          message: (message: unknown) => onDidReceiveMessage.fire({ editor: editorOf(), message }),
          execute: async (code, run) => {
            const index = run.cell?.index ?? 0;
            // The notebook's own cell (extensions key maps by them), its document brought up to
            // the text that runs (the notebook's change may not have been read yet).
            const known = run.cell ? notebook.cellById(run.cell.id) : undefined;
            if (known && run.cell) notebook.syncCellText(run.cell.id, code);
            const cell =
              known ??
              ({
                index,
                kind: 2,
                document: new ShimTextDocument(
                  `vscode-notebook-cell:${context.path}#${run.cell?.id ?? index}`,
                  run.cell?.language ?? "plaintext",
                  code,
                ),
                notebook,
                metadata: notebook.isIpynb
                  ? toVscodeCellMetadata({
                      kind: "code",
                      metadata: run.cell?.metadata ?? {},
                      ...(run.cell && { id: run.cell.id }),
                    })
                  : (run.cell?.metadata ?? {}),
                outputs: [],
                executionSummary: undefined,
              } as object);
            runs.set(cell, run);
            const ended = new Promise<{ status: "ok" | "error"; count: number | null }>((resolve) =>
              ends.set(cell, resolve),
            );
            host.setStatus("busy");
            try {
              await controller.executeHandler?.([cell], notebook, controller);
              // An execution ends when its `end` is called (often after the handler returned).
              return await Promise.race([
                ended,
                new Promise<{ status: "ok"; count: null }>((r) =>
                  setTimeout(() => r({ status: "ok", count: null }), 600_000),
                ),
              ]);
            } finally {
              runs.delete(cell);
              ends.delete(cell);
              host.setStatus("idle");
            }
          },
          interrupt: async () => {
            await controller.interruptHandler?.(notebook);
          },
          variables: async () => {
            const provider = controller.variableProvider;
            if (!provider) return null;
            const out: { name: string; type: string; value: string; size: string }[] = [];
            // Named variables at the top level (VariablesRequestKind.Named = 1).
            const all = provider.provideVariables(notebook, undefined, 1, 0, NONE_TOKEN);
            for await (const raw of all as AsyncIterable<unknown>) {
              const v = ((raw ?? {}) as { variable?: Record<string, unknown> }).variable ?? {};
              if (typeof v.name !== "string") continue;
              out.push({
                name: v.name,
                type: typeof v.type === "string" ? v.type : "",
                value: typeof v.value === "string" ? v.value : String(v.value ?? ""),
                size: "",
              });
              if (out.length >= 500) break;
            }
            return out;
          },
        };
      },
    });
    return controller;
  };

  /**
   * "Detecting kernels…" while an extension looks for them (VS Code shows it in the kernel
   * picker): the IDE's picker asks the controllers when it opens, so there's nothing to show.
   */
  const createNotebookControllerDetectionTask = (_notebookType: string) => ({ dispose() {} });

  /**
   * Kernel source actions (VS Code's notebookKernelSource proposal: Jupyter's "Python
   * Environments…", "Existing Jupyter Server…"): rows of the IDE's kernel picker. Choosing one
   * runs its command with the notebook (as VS Code does); a controller id it returns is picked.
   */
  let actionSeq = 0;
  const registerKernelSourceActionProvider = (
    notebookType: string,
    provider: {
      provideNotebookKernelSourceActions(token: unknown): unknown;
      onDidChangeNotebookKernelSourceActions?: (listener: () => void) => { dispose(): void };
    },
  ) => {
    const id = `kernel-source-actions-${++actionSeq}`;
    let registration: { dispose(): void } | undefined;
    let disposed = false;
    const refresh = async () => {
      const list = await Promise.resolve(
        provider.provideNotebookKernelSourceActions(NONE_TOKEN),
      ).catch(() => []);
      if (disposed) return;
      const actions = (Array.isArray(list) ? list : []).flatMap((raw, i) => {
        const a = (raw ?? {}) as {
          label?: unknown;
          description?: unknown;
          detail?: unknown;
          command?: string | { command?: string; arguments?: unknown[] };
        };
        const command = typeof a.command === "string" ? a.command : a.command?.command;
        if (typeof a.label !== "string" || !command) return [];
        const args = typeof a.command === "object" ? (a.command.arguments ?? []) : [];
        const detail = [a.description, a.detail].find((d) => typeof d === "string") as
          | string
          | undefined;
        return [
          {
            id: `a${i}`,
            label: a.label.replace(/\$\([\w-]+\)\s*/g, ""),
            ...(detail && { detail }),
            run: async (context: { path: string; notebookType: string }) => {
              const uri = Uri.file(context.path);
              const notebook = notebookOf(context.path, context.notebookType);
              // VS Code passes the notebook when the command has no arguments of its own.
              const result = await commands.executeCommand(
                command,
                ...(args.length ? args : [{ uri, notebookEditor: { notebook } }]),
              );
              const picked =
                typeof result === "string" ? result : (result as { id?: unknown } | undefined)?.id;
              if (typeof picked === "string")
                await ide.commands
                  .execute("notebook.selectKernel", { path: context.path, kernel: picked })
                  .catch(() => {});
              return undefined;
            },
          },
        ];
      });
      registration?.dispose();
      registration = ide.notebooks.registerKernelSource({
        id,
        label: "Kernel sources",
        notebookTypes: [ideNotebookType(notebookType)],
        actions,
        find: () => [],
        start: () => {
          throw new Error("Choose one of its actions.");
        },
      });
    };
    void refresh();
    const changes = provider.onDidChangeNotebookKernelSourceActions?.(() => void refresh());
    return new Disposable(() => {
      disposed = true;
      changes?.dispose();
      registration?.dispose();
    });
  };

  const registerNotebookCellStatusBarItemProvider = (
    notebookType: string,
    provider: { provideCellStatusBarItems(cell: unknown, token: unknown): unknown },
  ) => {
    const handle = ide.notebooks.registerCellStatusBarItemProvider(
      ideNotebookType(notebookType),
      async (ctx) => {
        const notebook = notebookOf(ctx.path, ctx.notebookType);
        // The notebook's own cell when it has it (VS Code passes its NotebookCell).
        const known = notebook.cellById(ctx.cell.id);
        if (known) notebook.syncCellText(ctx.cell.id, ctx.cell.source);
        const cell = known ?? {
          index: ctx.cell.index,
          kind: ctx.cell.kind === "markdown" ? 1 : 2,
          document: new ShimTextDocument(
            `vscode-notebook-cell:${ctx.path}#${ctx.cell.id}`,
            ctx.cell.language,
            ctx.cell.source,
          ),
          notebook,
          metadata: notebook.isIpynb
            ? toVscodeCellMetadata({
                kind:
                  ctx.cell.kind === "markdown"
                    ? "markdown"
                    : ctx.cell.kind === "raw"
                      ? "raw"
                      : "code",
                metadata: ctx.cell.metadata,
                id: ctx.cell.id,
                executionCount: ctx.cell.executionCount,
              })
            : ctx.cell.metadata,
          outputs: [],
          executionSummary: ctx.cell.executionCount
            ? { executionOrder: ctx.cell.executionCount }
            : undefined,
        };
        const r = (await provider.provideCellStatusBarItems(cell, NONE_TOKEN)) as unknown;
        const list = (Array.isArray(r) ? r : r ? [r] : []) as {
          text: string;
          tooltip?: unknown;
          alignment?: number;
          command?: Parameters<ShimCommands["ref"]>[0];
        }[];
        return list.map((i) => {
          const ref = commands.ref(i.command);
          return {
            text: i.text,
            ...(typeof i.tooltip === "string" && { tooltip: i.tooltip }),
            alignment: i.alignment === 2 ? ("right" as const) : ("left" as const),
            ...(ref && ref.input === undefined && { command: ref.command }),
          };
        });
      },
    );
    return new Disposable(() => handle.dispose());
  };

  const createRendererMessaging = (rendererId: string) => {
    const m = ide.notebooks.createRendererMessaging(rendererId);
    return {
      onDidReceiveMessage: eventOf<unknown>((listener) =>
        m.onDidReceiveMessage((e) =>
          listener({ editor: { notebook: { uri: Uri.file(e.path) } }, message: e.message }),
        ),
      ),
      postMessage: async (message: unknown, editor?: { notebook: { uri: Uri } }) => {
        await m.postMessage(message, editor ? { path: pathOf(editor.notebook.uri) } : undefined);
        return true;
      },
    };
  };

  return {
    notebooks: {
      createNotebookController,
      createNotebookControllerDetectionTask,
      registerKernelSourceActionProvider,
      registerNotebookCellStatusBarItemProvider,
      createRendererMessaging,
    },
    workspace: {
      get notebookDocuments() {
        return editors.documents();
      },
      onDidOpenNotebookDocument: editors.onDidOpen,
      onDidCloseNotebookDocument: editors.onDidClose,
      onDidSaveNotebookDocument: editors.onDidSave,
      onDidChangeNotebookDocument: editors.onDidChange,
      registerNotebookSerializer,
      openNotebookDocument: async (uriOrType: Uri | string, content?: NotebookData) => {
        if (uriOrType instanceof Uri) return editors.openNotebookDocument(uriOrType);
        // A new untitled notebook of that type (D267), with `content`'s cells: the IDE opens
        // it in a tab (VS Code keeps it hidden until shown).
        const r = await ide.commands.execute<{ path: string }>("notebook.newUntitled", {
          type: ideNotebookType(String(uriOrType)),
          ...(content && { notebook: toIdeNotebook(content, String(uriOrType)) }),
        });
        return editors.openNotebookDocument(Uri.parse(r.path));
      },
    },
    window: editors.window,
    ready: editors.ready,
    /** NotebookEdits in a WorkspaceEdit (after its text edits, as VS Code applies them). */
    applyEdits: async (ops: readonly { uri: Uri; edit: unknown }[]): Promise<boolean> => {
      const byPath = new Map<string, NotebookEdit[]>();
      for (const op of ops)
        if (op.edit instanceof NotebookEdit) {
          const path = pathOf(op.uri);
          byPath.set(path, [...(byPath.get(path) ?? []), op.edit]);
        }
      for (const [path, edits] of byPath) await editors.applyNotebookEdits(path, edits);
      return true;
    },
  };
}
