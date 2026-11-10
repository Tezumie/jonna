// Commands over fileRules.ts: VS Code's "Set / Toggle / Reset active editor read-only in
// session" (workbench.action.files.*ReadonlyInSession), a lock in the status bar that toggles it
// (IntelliJ's), and Paste from history (clipboardHistory.ts) with the picked entry previewed
// below the cursor before it's pasted.

import { h } from "../../core/dom/index";
import { clipboardIpc } from "../../core/ipc/system";
import type { Disposable, DisposableStore } from "../../core/lifecycle/index";
import type { ReadonlySignal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { QuickPickItem } from "../../ui/QuickInput";
import type { WorkbenchServices } from "../../workbench/services";
import { editorClipboard, historyRow } from "./clipboardHistory";
import type { EditorFileRules } from "./fileRules";
import { documentName } from "./service";
import { isUntitled } from "./untitled";
import type { EditorView } from "./view";

interface Deps {
  rules: EditorFileRules;
  activeView: () => EditorView | undefined;
  cursorVersion: ReadonlySignal<number>;
  activeTabId: ReadonlySignal<string | null>;
}

/** Lines shown in the paste preview; the rest is summed up in the picker's row. */
const PREVIEW_LINES = 12;
/** Characters of an entry the picker's filter searches. */
const FILTER_CHARS = 2000;

export function registerFileRuleCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  deps: Deps,
): void {
  const { dispatcher, settings } = services;
  const { rules, activeView } = deps;

  /** The file a read-only command acts on: `path`, or the active editor's. */
  const target = (path: string | undefined) => {
    const view = activeView();
    const file = path ? services.workspace.resolve(path) : view?.doc?.path.peek();
    if (!file) throw new Error("No active text editor");
    const doc = view?.doc && view.doc.path.peek() === file ? view.doc : undefined;
    if (file.startsWith("virtual:")) throw new Error("Generated text is always read-only.");
    return { file, fixed: doc?.notUtf8 === true ? doc : undefined };
  };
  const readOnlyInput = s.object({
    path: s.string().describe("The file (default: the active editor's)").optional(),
  });
  const session = (
    id: string,
    title: string,
    description: string,
    next: (now: boolean) => boolean | null,
  ) =>
    sub.add(
      dispatcher.register({
        id,
        title,
        category: "File",
        description,
        input: readOnlyInput,
        effects: [],
        when: "activeEditor",
        agent: "hidden",
        run: ({ path }) => {
          const { file, fixed } = target(path);
          // A file that isn't UTF-8 is read-only already: the lock shows it closed (D407).
          const value = next(rules.readOnly(file) || !!fixed);
          if (value === false && fixed)
            throw new Error(
              `${documentName(fixed)} isn't UTF-8: reopen it with its encoding to edit it.`,
            );
          rules.setSession(file, value);
          return { path: file, readOnly: rules.readOnly(file) || !!fixed };
        },
      }),
    );
  session(
    "editor.setReadOnlyInSession",
    "Set active editor read-only in session",
    "Makes the file read-only in its editors until the window closes (VS Code's), whatever files.readonlyInclude says.",
    () => true,
  );
  session(
    "editor.setWritableInSession",
    "Set active editor writeable in session",
    "Makes the file editable until the window closes, even when files.readonlyInclude or its permissions make it read-only.",
    () => false,
  );
  session(
    "editor.toggleReadOnlyInSession",
    "Toggle active editor read-only in session",
    "Switches the file between read-only and editable for the rest of the session (the status bar's lock).",
    (now) => !now,
  );
  session(
    "editor.resetReadOnlyInSession",
    "Reset active editor read-only in session",
    "Drops the session's choice for the file: files.readonlyInclude, files.readonlyExclude and files.readonlyFromPermissions decide again.",
    () => null,
  );

  // The lock: open while the file can be edited, closed while it can't; a click toggles it.
  const lockState = () => {
    deps.cursorVersion.value;
    deps.activeTabId.value;
    if (settings.get<boolean>("workbench.statusBar.editorInfo") === false) return null;
    const doc = activeView()?.doc;
    if (!doc || doc.kind !== "text") return null;
    const path = doc.path.value;
    doc.model.value;
    if (path.startsWith("virtual:") || isUntitled(path)) return null;
    return { fixed: doc.notUtf8, locked: doc.notUtf8 || rules.readOnly(path), path };
  };
  sub.add(
    services.statusBar.add({
      id: "editor.readOnly",
      name: "Read-only",
      alignment: "right",
      priority: 96,
      text: () => {
        const state = lockState();
        return state ? (state.locked ? "$(lock)" : "$(lock-open)") : "";
      },
      tooltip: () => {
        const state = lockState();
        if (!state) return "";
        if (state.fixed) return "Read-only: the file isn't UTF-8 (reopen it with its encoding)";
        return state.locked
          ? "Read-only. Click to allow editing for this session"
          : "Click to make the file read-only for this session";
      },
      command: "editor.toggleReadOnlyInSession",
    }),
  );

  // ---- Paste from history ----
  sub.add(
    dispatcher.register({
      id: "editor.pasteFromHistory",
      title: "Paste from history…",
      category: "Edit",
      description:
        "Lists the last texts copied or cut in the editor (and the system clipboard's), newest first, previews the one selected below the cursor and pastes the one picked. Kept in memory for this window only.",
      input: s.empty(),
      effects: ["write"],
      when: "activeEditor",
      agent: "hidden",
      run: async () => {
        const view = activeView();
        const editor = view?.engineEditor;
        if (!view || !editor) throw new Error("No active text editor");
        if (view.readOnly) throw new Error("The active editor is read-only.");
        // A copy from another program is on the system clipboard, not in the list yet.
        const current = await clipboardIpc.readText().catch(() => "");
        if (current && editorClipboard.entries()[0]?.text !== current) editorClipboard.add(current);
        const entries = editorClipboard.entries();
        if (!entries.length) {
          services.notifications.show("info", "Nothing has been copied yet.");
          return { pasted: false };
        }
        const now = Date.now();
        const items: QuickPickItem[] = entries.map((entry, i) => {
          const row = historyRow(entry, now);
          return {
            id: String(i),
            label: row.label,
            description: row.description,
            ...(row.detail && { detail: row.detail }),
          };
        });
        let preview: Disposable | null = null;
        const line = editor.activeState()?.cursor.line ?? 1;
        const showPreview = (item: QuickPickItem | undefined) => {
          preview?.dispose();
          preview = null;
          const entry = item ? entries[Number(item.id)] : undefined;
          const text = entry?.secret ? "••••••••" : entry?.text;
          if (!text) return;
          const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
          const shown = lines.slice(0, PREVIEW_LINES);
          const more = lines.length - shown.length;
          const node = h(
            "div",
            { class: "paste-preview", "aria-hidden": "true" },
            h("pre", { class: "paste-preview-text" }, shown.join("\n") || " "),
            more > 0 ? h("div", { class: "paste-preview-more" }, `${more} more lines`) : null,
          );
          const rows = shown.length + (more > 0 ? 1 : 0);
          preview = editor.addZone(line, node, rows * editor.lineHeight() + 8);
        };
        let picked: QuickPickItem | undefined;
        try {
          picked = await services.quickInput.pick(items, {
            placeholder: "Paste from history (newest first)",
            // A hidden value isn't found by its text either.
            matchOn: (item) => {
              const entry = entries[Number(item.id)];
              return entry && !entry.secret ? entry.text.slice(0, FILTER_CHARS) : item.label;
            },
            onActive: showPreview,
          });
        } finally {
          showPreview(undefined);
        }
        const text = picked ? entries[Number(picked.id)]?.text : undefined;
        if (!text) return { pasted: false };
        view.focus();
        editor.insertText(text);
        // Pasted again: it's the newest now.
        editorClipboard.add(text, Date.now(), entries[Number(picked?.id)]?.secret === true);
        return { pasted: true, characters: text.length };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "editor.clearClipboardHistory",
      title: "Clear clipboard history",
      category: "Edit",
      description: "Forgets the texts Paste from history lists (the system clipboard is kept).",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: () => {
        editorClipboard.clear();
        return { cleared: true };
      },
    }),
  );
}
