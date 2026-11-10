// More of VS Code's API on the worker side (D248): URI handlers (`window.registerUriHandler`), edits
// across files (`workspace.applyEdit` with a WorkspaceEdit: text edits, and files created, renamed
// and deleted), will-save listeners (`onWillSaveTextDocument` / `onWillSaveNotebookDocument`,
// with `waitUntil`) and the editor's cursor style (`TextEditorOptions.cursorStyle`). The `type`
// command override is `ide.commands.register("type", …)` (rpc.ts); the host checks it. Requests
// go to the host, which checks permissions as for the rest of the API. DOM-free, unit-tested.
import type { Disposable, TextRange } from "./rpc";
import type { OnCall, Request } from "./rpcTerminals";

/** A link to the IDE for this extension (`<scheme>://<publisher.name>/path?query#fragment`). */
export interface Uri {
  scheme: string;
  /** The extension's id. */
  authority: string;
  path: string;
  /** Still encoded (`new URLSearchParams(uri.query)` splits it). */
  query: string;
  fragment: string;
  /** The whole link. */
  text: string;
  toString(): string;
}

export interface UriHandler {
  handleUri(uri: Uri): unknown;
}

/** One operation of a WorkspaceEdit, applied in order. */
export type WorkspaceEditEntry =
  | ({ kind: "text"; path: string; text: string } & TextRange)
  | {
      kind: "create";
      path: string;
      /** The new file's text (default empty). */
      contents?: string;
      overwrite?: boolean;
      ignoreIfExists?: boolean;
    }
  | { kind: "rename"; from: string; to: string; overwrite?: boolean; ignoreIfExists?: boolean }
  | { kind: "delete"; path: string; recursive?: boolean; ignoreIfNotExists?: boolean };

/** VS Code's WorkspaceEdit: text edits and file operations, kept in the order they're added. */
export class WorkspaceEdit {
  private readonly list: WorkspaceEditEntry[] = [];

  replace(path: string, range: TextRange, text: string): void {
    this.list.push({ kind: "text", path, ...range, text: String(text) });
  }

  insert(path: string, position: { line: number; column: number }, text: string): void {
    this.list.push({
      kind: "text",
      path,
      startLine: position.line,
      startColumn: position.column,
      endLine: position.line,
      endColumn: position.column,
      text: String(text),
    });
  }

  delete(path: string, range: TextRange): void {
    this.list.push({ kind: "text", path, ...range, text: "" });
  }

  /** Several text edits of one file (VS Code's `set(uri, edits)`). */
  set(path: string, edits: (TextRange & { text: string })[]): void {
    for (const e of edits) this.replace(path, e, e.text);
  }

  createFile(
    path: string,
    options: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: string } = {},
  ): void {
    this.list.push({ kind: "create", path, ...options });
  }

  renameFile(
    from: string,
    to: string,
    options: { overwrite?: boolean; ignoreIfExists?: boolean } = {},
  ): void {
    this.list.push({ kind: "rename", from, to, ...options });
  }

  deleteFile(
    path: string,
    options: { recursive?: boolean; ignoreIfNotExists?: boolean } = {},
  ): void {
    this.list.push({ kind: "delete", path, ...options });
  }

  /** How many operations it holds (VS Code's `size` counts files; this counts operations). */
  get size(): number {
    return this.list.length;
  }

  entries(): WorkspaceEditEntry[] {
    return [...this.list];
  }
}

export interface WillSaveEvent {
  /** The file's absolute path. */
  path: string;
  /** Its language (text) or notebook type (notebooks). */
  languageId: string;
  reason: "manual" | "afterDelay" | "focusOut";
  /**
   * Holds the save until `thenable` settles (call it during the listener, not later). For a text
   * file it may resolve with edits (`{ startLine, …, text }[]`) applied before the write. All of
   * them together get 1.5 s.
   */
  waitUntil(thenable: unknown): void;
}

export type CursorStyle =
  | "line"
  | "block"
  | "underline"
  | "line-thin"
  | "block-outline"
  | "underline-thin";

export interface HookApis {
  registerUriHandler(handler: UriHandler): Disposable;
  applyEdit(
    edit: WorkspaceEdit | { entries(): WorkspaceEditEntry[] } | WorkspaceEditEntry[],
  ): Promise<boolean>;
  createWorkspaceEdit(): WorkspaceEdit;
  onWillSaveTextDocument(listener: (event: WillSaveEvent) => void): Disposable;
  onWillSaveNotebookDocument(listener: (event: WillSaveEvent) => void): Disposable;
  /** Sets the cursor of every editor (null: back to the user's setting); "fs.write". */
  setOptions(options: { cursorStyle?: CursorStyle | number | null }): Promise<void>;
}

/** Will-save listeners of one kind: subscribed at the host while there are any. */
function willSaveListeners(kind: "text" | "notebook", request: Request, on: OnCall) {
  const listeners = new Set<(e: WillSaveEvent) => void>();
  let off: (() => void) | null = null;
  return (listener: (e: WillSaveEvent) => void): Disposable => {
    listeners.add(listener);
    if (!off) {
      off = on(`willSave.${kind}`, async (args: Partial<WillSaveEvent>) => {
        const waits: unknown[] = [];
        let open = true;
        const event: WillSaveEvent = {
          path: String(args?.path ?? ""),
          languageId: String(args?.languageId ?? ""),
          reason:
            args?.reason === "afterDelay" || args?.reason === "focusOut" ? args.reason : "manual",
          waitUntil: (thenable) => {
            if (!open) throw new Error("waitUntil must be called while the event is handled.");
            waits.push(thenable);
          },
        };
        for (const l of [...listeners]) {
          try {
            l(event);
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
          }
        }
        open = false;
        const results = await Promise.all(waits.map((w) => Promise.resolve(w).catch(() => null)));
        // Edits (text files): every array of edit-shaped objects the promises resolved with.
        return results.flatMap((r) => (Array.isArray(r) ? r : [])).filter(isEditShaped);
      });
      void request("workspace.willSave", { kind, on: true }).catch((err: unknown) =>
        console.error(err instanceof Error ? err.message : String(err)),
      );
    }
    return {
      dispose: () => {
        listeners.delete(listener);
        if (!listeners.size && off) {
          off();
          off = null;
          void request("workspace.willSave", { kind, on: false }).catch(() => {});
        }
      },
    };
  };
}

function isEditShaped(v: unknown): boolean {
  const r = v as { startLine?: unknown; text?: unknown } | null;
  return !!r && typeof r.startLine === "number" && typeof r.text === "string";
}

export function createHookApis(request: Request, on: OnCall): HookApis {
  let uriHandler: { off: () => void } | null = null;
  return {
    registerUriHandler(handler) {
      if (uriHandler) throw new Error("The extension already has a URI handler.");
      const off = on("uri.handle", async (args: Partial<Uri>) => {
        const text = String(args?.text ?? "");
        const uri: Uri = {
          scheme: String(args?.scheme ?? ""),
          authority: String(args?.authority ?? ""),
          path: String(args?.path ?? "/"),
          query: String(args?.query ?? ""),
          fragment: String(args?.fragment ?? ""),
          text,
          toString: () => text,
        };
        await handler.handleUri(uri);
        return null;
      });
      const entry = { off };
      uriHandler = entry;
      void request("uri.register").catch((err: unknown) =>
        console.error(err instanceof Error ? err.message : String(err)),
      );
      return {
        dispose: () => {
          if (uriHandler !== entry) return;
          uriHandler = null;
          off();
          void request("uri.unregister").catch(() => {});
        },
      };
    },
    async applyEdit(edit) {
      const entries = Array.isArray(edit)
        ? edit
        : typeof edit?.entries === "function"
          ? edit.entries()
          : [];
      try {
        await request("workspace.applyEdit", { entries });
        return true;
      } catch (err) {
        // VS Code resolves false when an edit can't be applied; the reason goes to the log.
        console.error(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    createWorkspaceEdit: () => new WorkspaceEdit(),
    onWillSaveTextDocument: willSaveListeners("text", request, on),
    onWillSaveNotebookDocument: willSaveListeners("notebook", request, on),
    setOptions: (options) =>
      request("editor.setOptions", { cursorStyle: options?.cursorStyle ?? null }),
  };
}
