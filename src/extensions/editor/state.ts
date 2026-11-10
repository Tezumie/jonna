// `ide://editors` and `ide://editors/active` state paths plus the editor status bar items.
import type { DisposableStore } from "../../core/lifecycle/index";
import { type ReadonlySignal, signal } from "../../core/reactive/index";
import { uriScheme } from "../../workbench/extensionRegistries";
import type { WorkbenchServices } from "../../workbench/services";
import { encodingInfo } from "./encodings";
import { selectionLabel } from "./selectionLabel";
import { documentLanguage, type EditorService } from "./service";
import type { EditorView } from "./view";

const LANGUAGE_NAMES: Record<string, string> = {
  typescript: "TypeScript",
  tsx: "TypeScript JSX",
  javascript: "JavaScript",
  jsx: "JavaScript JSX",
  json: "JSON",
  jsonc: "JSON with Comments",
  markdown: "Markdown",
  shellscript: "Shell Script",
  plaintext: "Plain Text",
  csharp: "C#",
  cpp: "C++",
};

export function languageLabel(id: string): string {
  return LANGUAGE_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

export interface EditorStateDeps {
  editors: EditorService;
  views: Map<string, EditorView>;
  activeView(): EditorView | undefined;
  cursorVersion: ReadonlySignal<number>;
  activeTabId: ReadonlySignal<string | null>;
}

export function registerEditorState(
  sub: DisposableStore,
  services: WorkbenchServices,
  deps: EditorStateDeps,
): void {
  const { state, workspace, statusBar, dock } = services;
  const { editors, activeView } = deps;
  const rel = (p: string) =>
    // An extension's file system's URI (D233) stays as it is.
    // With several folders a path starts with its folder's name ("api/src/x.ts", D251).
    p.startsWith("virtual:") || uriScheme(p) ? p : workspace.relative(p);

  sub.add(
    state.register("ide://editors", {
      description:
        "Open documents (path relative to the workspace, language, dirty, line ending, kind) and the editor tabs showing them (tab id, group id). `active` is the tab commands like Save act on.",
      get: () => {
        const tabs = dock.tabs("editor").map((t) => {
          const found = dock.findTab(t.id);
          const path = (t.viewState as { path?: unknown } | null)?.path;
          return {
            tabId: t.id,
            groupId: found?.group.id ?? null,
            path: typeof path === "string" ? rel(path) : null,
          };
        });
        return {
          active: deps.activeTabId.peek(),
          documents: editors.documents.peek().map((d) => ({
            path: rel(d.path.peek()),
            language: documentLanguage(d),
            dirty: d.dirty.peek(),
            kind: d.kind,
            eol: d.model.peek()?.eol === "\r\n" ? "CRLF" : "LF",
          })),
          tabs,
        };
      },
    }),
  );
  sub.add(
    state.register("ide://editors/active", {
      description:
        "The active editor tab: path, language, dirty, readOnly (can't be edited: not UTF-8, files.readonlyInclude, or set read-only for the session), diskState (ok, changed: changed on disk while edited, deleted), line ending, indentation ({tabSize, insertSpaces}), cursor, selections, visible line range and selected text (1-based lines/columns).",
      get: () => {
        const view = activeView();
        const doc = view?.doc;
        if (!view || !doc) return null;
        const path = doc.path.peek();
        const model = doc.model.peek();
        return {
          tabId: view.tabId,
          path: rel(path),
          absolutePath: path.startsWith("virtual:") ? null : path,
          language: documentLanguage(doc),
          dirty: doc.dirty.peek(),
          readOnly: view.readOnly,
          diskState: doc.diskState.peek(),
          eol: model?.eol === "\r\n" ? "CRLF" : "LF",
          encoding: doc.encoding,
          // Tab size and spaces (a language's own settings apply, D201).
          ...(model && { indentation: model.indentation() }),
          lineCount: model?.lineCount ?? doc.initialText.split("\n").length,
          ...(view.engineEditor?.activeState() ?? {}),
        };
      },
    }),
  );

  /**
   * The active editor's line, indentation, encoding, line endings and language in the main status
   * bar too, where VS Code has them (D204: people look there even with the per-file bar on);
   * `workbench.statusBar.editorInfo` turns them off.
   */
  const shown = () => services.settings.get<boolean>("workbench.statusBar.editorInfo") !== false;
  // Reopen / Save with encoding, indentation (a command, maybe an agent's: no cursor move follows).
  const encodingVersion = signal(0);
  sub.add(
    editors.encodingChanged.event(() => {
      encodingVersion.value = encodingVersion.peek() + 1;
    }),
  );
  /** Re-evaluated on cursor moves, active-tab changes and encoding changes. */
  const active = () => {
    deps.cursorVersion.value;
    encodingVersion.value;
    const id = deps.activeTabId.value;
    dock.decorations.value;
    return id ? deps.views.get(id) : undefined;
  };
  const textModel = () => {
    const doc = active()?.doc;
    return doc?.kind === "text" ? doc.model.value : null;
  };
  sub.add(
    statusBar.add({
      id: "editor.cursor",
      name: "Line and column",
      alignment: "right",
      priority: 90,
      text: () => {
        if (!shown()) return "";
        const status = active()?.engineEditor?.selectionStatus();
        return status ? selectionLabel(status) : "";
      },
      tooltip: () => "Go to line/column",
      command: "editor.gotoLine",
    }),
  );
  sub.add(
    statusBar.add({
      id: "editor.indentation",
      name: "Indentation",
      alignment: "right",
      priority: 92,
      text: () => {
        const model = shown() ? textModel() : null;
        if (!model) return "";
        const { insertSpaces, tabSize } = model.indentation();
        return insertSpaces ? `Spaces: ${tabSize}` : `Tab size: ${tabSize}`;
      },
      tooltip: () => "Select indentation",
      command: "editor.selectIndentation",
    }),
  );
  sub.add(
    statusBar.add({
      id: "editor.encoding",
      name: "Encoding",
      alignment: "right",
      priority: 94,
      text: () => {
        if (!shown() || !textModel()) return "";
        const enc = active()?.doc?.encoding ?? "utf8";
        return encodingInfo(enc)?.label ?? enc;
      },
      tooltip: () => "Select encoding",
      command: "editor.selectEncoding",
    }),
  );
  sub.add(
    statusBar.add({
      id: "editor.eol",
      name: "End of line",
      alignment: "right",
      priority: 95,
      text: () => {
        const model = shown() ? textModel() : null;
        return model ? (model.eol === "\r\n" ? "CRLF" : "LF") : "";
      },
      tooltip: () => "Select end of line sequence",
      command: "editor.changeEol",
    }),
  );
  sub.add(
    statusBar.add({
      id: "editor.language",
      name: "Language",
      alignment: "right",
      priority: 100,
      text: () => {
        if (!shown()) return "";
        const doc = active()?.doc;
        if (doc) doc.model.value;
        return doc ? languageLabel(documentLanguage(doc)) : "";
      },
      tooltip: () => "Select language mode",
      command: "editor.setLanguage",
    }),
  );
}
