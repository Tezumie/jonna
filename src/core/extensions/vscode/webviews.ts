// The `vscode` shim's webview views and custom editors (D257): pages a VS Code extension's code
// writes for a view of `"type": "webview"` (registerWebviewViewProvider) or for a file it opens
// (registerCustomEditorProvider, its custom editors being the IDE's code-page viewers), set with
// `ide.ui.webview(id).setHtml` and talking through the same messages, with VS Code's page API
// (views.ts' bridge). A view is resolved once its provider registers (its page stays while the
// view is closed); a custom editor once per tab. DOM-free and unit-tested.

import type { WorkerApi } from "../rpc";
import { webviewUri } from "../rpcWebviewPanels";
import { pathOf, uriOf } from "./convert";
import type { Documents } from "./document";
import { Disposable, EventEmitter, NONE_TOKEN, type Uri } from "./types";
import { safeWebviewUri, withVscodeBridge } from "./views";

type Handle = ReturnType<WorkerApi["ui"]["webview"]>;

/** VS Code's Webview over one view's page, or one viewer tab's (`instance`). */
function makeWebview(
  handle: Handle,
  extensionPath: string,
  /** The workspace's folders now: their files are served too (VS Code's localResourceRoots). */
  roots: () => readonly string[],
  messages: EventEmitter<unknown>,
  instance?: number,
  options: Record<string, unknown> = {},
  editorKeys = false,
  report?: (page: PageReport) => void,
) {
  let html = "";
  return {
    get html() {
      return html;
    },
    set html(value: string) {
      html = value;
      report?.({ length: value.length, shown: false });
      void handle.setHtml(withVscodeBridge(value, { editorKeys }), instance).then(
        () => report?.({ length: value.length, shown: true }),
        (err: unknown) => {
          const error = err instanceof Error ? err.message : String(err);
          report?.({ length: value.length, shown: false, error });
          console.error(err);
        },
      );
    },
    options,
    cspSource: "'self'",
    postMessage: (message: unknown) =>
      handle.postMessage(message, instance).then(
        () => true,
        () => false,
      ),
    onDidReceiveMessage: messages.event,
    asWebviewUri: (uri: Uri) =>
      safeWebviewUri(uri, (path) => webviewUri(extensionPath, path, roots())),
  };
}

/** Where a webview view's page stands (`ide://ext/<id>/vscode`, D260). */
export interface PageReport {
  length: number;
  shown: boolean;
  error?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export function createWebviews(
  ide: WorkerApi,
  docs: Documents,
  extensionPath: string,
  unsupported: (name: string) => void,
) {
  const workspaceRoots = () => (ide.workspace.workspaceFolders ?? []).map((f) => f.path);
  /** Each webview view: whether its provider resolved it, and its page (D260). */
  const viewStates = new Map<string, { resolved: boolean; page?: PageReport; error?: string }>();
  const registerWebviewViewProvider = (
    viewId: string,
    provider: { resolveWebviewView(view: unknown, context: unknown, token: unknown): unknown },
    options?: { webviewOptions?: { retainContextWhenHidden?: boolean } },
  ) => {
    const handle = ide.ui.webview(viewId);
    const messages = new EventEmitter<unknown>();
    const listening = handle.onMessage((m) => messages.fire(m));
    const state: { resolved: boolean; page?: PageReport; error?: string } = { resolved: false };
    viewStates.set(viewId, state);
    const onDidDispose = new EventEmitter<void>();
    const onDidChangeVisibility = new EventEmitter<void>();
    let title: string | undefined;
    let description: string | undefined;
    // VS Code resolves a view when it's being opened, so a show() made while resolving is a
    // no-op there. Here views resolve when they register (the page is ready when opened), so
    // such a show() would take the focus and change the layout at startup (D269): its tab opens
    // in the background instead (a panel or secondary view is there, not shown; a side bar view
    // is its activity bar icon).
    let resolving = true;
    const view = {
      viewType: viewId,
      webview: makeWebview(
        handle,
        extensionPath,
        workspaceRoots,
        messages,
        undefined,
        { ...options?.webviewOptions },
        false,
        (page) => {
          state.page = page;
        },
      ),
      get title() {
        return title;
      },
      // The view's header shows them in place of its manifest title (VS Code's).
      set title(v: string | undefined) {
        title = typeof v === "string" ? v : undefined;
        ide.ui.setViewTitle(viewId, { title, description });
      },
      get description() {
        return description;
      },
      set description(v: string | undefined) {
        description = typeof v === "string" ? v : undefined;
        ide.ui.setViewTitle(viewId, { title, description });
      },
      badge: undefined as unknown,
      get visible() {
        return visible;
      },
      onDidDispose: onDidDispose.event,
      onDidChangeVisibility: onDidChangeVisibility.event,
      show: () => {
        void handle.reveal(resolving ? { background: true } : undefined).catch(() => {});
      },
    };
    let visible = false;
    let started = false;
    // VS Code resolves a view the first time it shows (the page's own state lives in the page:
    // context.state is undefined).
    const resolve = () => {
      if (started) return;
      started = true;
      void Promise.resolve()
        .then(() => provider.resolveWebviewView(view, { state: undefined }, NONE_TOKEN))
        .then(
          () => {
            state.resolved = true;
          },
          (err: unknown) => {
            state.error = err instanceof Error ? err.message : String(err);
            console.error(err);
          },
        )
        .finally(() => {
          resolving = false;
        });
    };
    const shown = (now: boolean) => {
      if (now) resolve();
      if (now === visible) return;
      visible = now;
      if (state.resolved || started) onDidChangeVisibility.fire();
    };
    const watching = ide.ui.watchView(viewId, shown);
    // The host that can't say (or an old one): resolved at once, as before.
    void watching.visible.then(shown, () => resolve());
    return new Disposable(() => {
      watching.dispose();
      listening.dispose();
      onDidDispose.fire();
      viewStates.delete(viewId);
    });
  };

  type CustomProvider = {
    resolveCustomTextEditor?(document: unknown, panel: unknown, token: unknown): unknown;
    openCustomDocument?(uri: Uri, context: unknown, token: unknown): unknown;
    resolveCustomEditor?(document: unknown, panel: unknown, token: unknown): unknown;
    onDidChangeCustomDocument?: (
      listener: (e: { document: unknown; undo?(): unknown; redo?(): unknown }) => void,
    ) => { dispose(): unknown };
    saveCustomDocument?(document: unknown, token: unknown): unknown;
    revertCustomDocument?(document: unknown, token: unknown): unknown;
  };

  const registerCustomEditorProvider = (
    viewType: string,
    provider: CustomProvider,
    options?: {
      webviewOptions?: Record<string, unknown>;
      supportsMultipleEditorsPerDocument?: boolean;
    },
  ) => {
    const handle = ide.ui.webview(viewType);
    const tabs = new Map<
      number,
      { messages: EventEmitter<unknown>; disposed: EventEmitter<void>; document: unknown }
    >();
    /** An editable custom document's edits (D258): undo / redo, and where it was last saved. */
    const editsOf = new Map<
      unknown,
      {
        stack: { undo?(): unknown; redo?(): unknown }[];
        at: number;
        saved: number;
        changed: boolean;
      }
    >();
    const stateOf = (document: unknown) => {
      let state = editsOf.get(document);
      if (!state) {
        state = { stack: [], at: 0, saved: 0, changed: false };
        editsOf.set(document, state);
      }
      return state;
    };
    const showDirty = (document: unknown) => {
      const state = stateOf(document);
      const dirty = state.changed || state.at !== state.saved;
      for (const [instance, tab] of tabs)
        if (tab.document === document) void handle.setDirty(dirty, instance).catch(() => {});
    };
    const changes = provider.onDidChangeCustomDocument?.((e) => {
      const state = stateOf(e.document);
      if (e.undo || e.redo) {
        state.stack.splice(state.at);
        state.stack.push(e);
        state.at = state.stack.length;
        if (state.saved > state.at) state.saved = -1;
      } else state.changed = true;
      showDirty(e.document);
    });
    /** Ctrl+S / Z / Y in the page (the bridge sends them; the IDE's keys don't reach a page). */
    const key = async (document: unknown, action: string) => {
      const state = stateOf(document);
      if (action === "save") {
        if (!provider.saveCustomDocument) return;
        await provider.saveCustomDocument(document, NONE_TOKEN);
        state.saved = state.at;
        state.changed = false;
      } else if (action === "undo" && state.at > 0) await state.stack[--state.at]?.undo?.();
      else if (action === "redo" && state.at < state.stack.length)
        await state.stack[state.at++]?.redo?.();
      showDirty(document);
    };
    const open = async (path: string, instance: number) => {
      const messages = new EventEmitter<unknown>();
      const disposed = new EventEmitter<void>();
      const uri = uriOf(path);
      const text = !!provider.resolveCustomTextEditor;
      // Another tab of the same file shares its document (VS Code's supportsMultipleEditorsPerDocument).
      const shared = text
        ? undefined
        : [...tabs.values()].find((t) => pathOf((t.document as { uri: Uri }).uri) === pathOf(uri))
            ?.document;
      const document = text
        ? await docs.sync(path)
        : (shared ??
          (await provider.openCustomDocument?.(
            uri,
            { backupId: undefined, untitledDocumentData: undefined },
            NONE_TOKEN,
          )));
      tabs.set(instance, { messages, disposed, document });
      const title = path.split(/[\\/]/).pop() ?? path;
      const panel = {
        viewType,
        title,
        iconPath: undefined as unknown,
        webview: makeWebview(
          handle,
          extensionPath,
          workspaceRoots,
          messages,
          instance,
          {
            ...options?.webviewOptions,
          },
          !text,
        ),
        options: options?.webviewOptions ?? {},
        active: true,
        visible: true,
        viewColumn: 1,
        onDidDispose: disposed.event,
        onDidChangeViewState: new EventEmitter<unknown>().event,
        reveal: () => {},
        dispose: () => unsupported("WebviewPanel.dispose of a custom editor"),
      };
      if (text) await provider.resolveCustomTextEditor?.(document, panel, NONE_TOKEN);
      else await provider.resolveCustomEditor?.(document, panel, NONE_TOKEN);
    };
    const listening = handle.onMessage((m) => {
      if (!isRecord(m) || typeof m.instance !== "number") return;
      if (m.ide === "viewerOpened" && typeof m.path === "string")
        void open(m.path, m.instance).catch((err: unknown) => console.error(err));
      else if (m.ide === "viewerMessage") {
        const tab = tabs.get(m.instance);
        const inner = m.message;
        if (isRecord(inner) && typeof inner.__ide === "string") {
          if (tab) void key(tab.document, inner.__ide).catch((err: unknown) => console.error(err));
          return;
        }
        tab?.messages.fire(inner);
      } else if (m.ide === "viewerClosed") {
        const tab = tabs.get(m.instance);
        tabs.delete(m.instance);
        tab?.disposed.fire();
        // The document goes with its last tab.
        if (tab && ![...tabs.values()].some((t) => t.document === tab.document)) {
          editsOf.delete(tab.document);
          (tab.document as { dispose?(): unknown } | undefined)?.dispose?.();
        }
      }
    });
    return new Disposable(() => {
      changes?.dispose();
      listening.dispose();
    });
  };

  /** The webview views' state for `ide://ext/<id>/vscode`. */
  const report = () => [...viewStates].map(([id, v]) => ({ id, ...v }));
  return { registerWebviewViewProvider, registerCustomEditorProvider, report };
}
