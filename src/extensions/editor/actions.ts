// Editor actions as dispatcher commands: `editor.runAction` (any engine action on the active
// editor) and the editor context menu, which is the IDE's Menu (DESIGN.md §12.5) instead of
// Monaco's, listing language actions only where a provider supports them (D52).

import { matchesWhen } from "../../core/context/index";
import { fsIpc } from "../../core/ipc/fs";
import { dialogIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { dirname } from "../../core/paths/index";
import { isUserCaller } from "../../core/permissions/commandGuards";
import { s } from "../../core/schema/index";
import { type IconName, knownIcon } from "../../ui/Icon";
import { type MenuItem, showContextMenu } from "../../ui/Menu";
import { resourceContext } from "../../workbench/extensionFeatures";
import type { WorkbenchServices } from "../../workbench/services";
import type { EngineEditor } from "./engine";
import { isUntitled } from "./untitled";
import type { EditorView } from "./view";

interface EditorMenuEntry {
  label: string;
  action: string;
  icon?: IconName;
  key?: string;
  mac?: string;
  separatorBefore?: boolean;
  /** Shown in the "Peek" submenu (VS Code's layout). */
  peek?: boolean;
  /** Only with a selection. */
  selection?: boolean;
  /**
   * The dispatcher command the entry runs instead of the engine action (which then only decides
   * whether it's shown): "Format document with…" picks a formatter first.
   */
  command?: string;
}

/**
 * The editor's context menu, VS Code's order. Entries whose engine action isn't available for the
 * file (no provider, read-only text) are left out.
 */
export const EDITOR_MENU: readonly EditorMenuEntry[] = [
  {
    label: "Go to definition",
    icon: "code",
    action: "editor.action.revealDefinition",
    key: "f12",
  },
  { label: "Go to type definition", icon: "braces", action: "editor.action.goToTypeDefinition" },
  {
    label: "Go to implementations",
    icon: "square-function",
    action: "editor.action.goToImplementation",
    key: "ctrl+f12",
    mac: "cmd+f12",
  },
  {
    label: "Go to references",
    icon: "text-search",
    action: "editor.action.goToReferences",
    key: "shift+f12",
  },
  {
    label: "Peek definition",
    icon: "code",
    action: "editor.action.peekDefinition",
    key: "alt+f12",
    peek: true,
  },
  {
    label: "Peek implementations",
    icon: "square-function",
    action: "editor.action.peekImplementation",
    key: "ctrl+shift+f12",
    mac: "cmd+shift+f12",
    peek: true,
  },
  {
    label: "Peek references",
    icon: "text-search",
    action: "editor.action.referenceSearch.trigger",
    peek: true,
  },
  {
    label: "Peek type definition",
    icon: "braces",
    action: "editor.action.peekTypeDefinition",
    peek: true,
  },
  {
    label: "Go to symbol in editor…",
    icon: "at-sign",
    action: "editor.action.quickOutline",
    key: "ctrl+shift+o",
    mac: "cmd+shift+o",
  },
  {
    label: "Rename symbol",
    icon: "text-cursor-input",
    action: "editor.action.rename",
    key: "f2",
    separatorBefore: true,
  },
  {
    label: "Change all occurrences",
    icon: "replace-all",
    action: "editor.action.changeAll",
    key: "ctrl+f2",
    mac: "cmd+f2",
  },
  {
    label: "Format document",
    icon: "wand-sparkles",
    action: "editor.action.formatDocument",
    key: "shift+alt+f",
  },
  {
    label: "Format document with…",
    icon: "sliders-horizontal",
    action: "editor.action.formatDocument",
    command: "editor.formatDocumentWith",
  },
  {
    label: "Format selection",
    icon: "wand-sparkles",
    action: "editor.action.formatSelection",
    key: "ctrl+k ctrl+f",
    mac: "cmd+k cmd+f",
    selection: true,
  },
  {
    label: "Format selection with…",
    icon: "sliders-horizontal",
    action: "editor.action.formatSelection",
    command: "editor.formatSelectionWith",
    selection: true,
  },
  {
    label: "Refactor…",
    icon: "lightbulb",
    action: "editor.action.refactor",
    key: "ctrl+shift+r",
    mac: "ctrl+shift+r",
  },
  { label: "Source action…", action: "editor.action.sourceAction", icon: "lightbulb" },
  {
    label: "Cut",
    icon: "scissors",
    action: "editor.action.clipboardCutAction",
    key: "ctrl+x",
    mac: "cmd+x",
    separatorBefore: true,
  },
  {
    label: "Copy",
    icon: "copy",
    action: "editor.action.clipboardCopyAction",
    key: "ctrl+c",
    mac: "cmd+c",
  },
  {
    label: "Paste",
    icon: "clipboard-paste",
    action: "editor.action.clipboardPasteAction",
    key: "ctrl+v",
    mac: "cmd+v",
  },
  {
    label: "Paste from history…",
    icon: "clipboard-clock",
    action: "editor.action.clipboardPasteAction",
    command: "editor.pasteFromHistory",
    key: "ctrl+k ctrl+v",
    mac: "cmd+k cmd+v",
  },
];

export function registerEditorActions(
  sub: DisposableStore,
  services: WorkbenchServices,
  activeView: () => EditorView | undefined,
  /** More entries for the clicked spot (e.g. "Stage change" on a changed line). */
  extra: (view: EditorView, line: number) => MenuItem[] = () => [],
): (view: EditorView, at: { x: number; y: number }) => void {
  const { dispatcher, keyboard } = services;
  /**
   * The active tab's view and engine editor, waiting briefly (D261) while a tab that just opened
   * loads its text: a command right after opening a file found "no active text editor".
   */
  const readyEditor = async (): Promise<{ view: EditorView; editor: EngineEditor } | null> => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const view = activeView();
      const editor = view?.engineEditor;
      if (view && editor) return { view, editor };
      // No editor tab at all, or it didn't load in time: nothing to wait for.
      if (!view || Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  sub.add(
    dispatcher.register({
      id: "editor.runAction",
      title: "Run editor action",
      category: "Editor",
      description:
        "Runs an editor engine action or command on the active editor, e.g. `editor.action.formatDocument`, `editor.action.rename`, `editor.action.commentLine`, `actions.find`, `cursorMove` with `args` { to: 'down', by: 'line', value: 3 }. Returns whether it ran (false if unsupported for this file). Agents and extensions run the editor's own actions only, on files of the open folder.",
      input: s.object({
        action: s.string().describe("Engine action or command id"),
        args: s.unknown().optional().describe("Arguments for it (a keybinding's `args`)"),
      }),
      effects: ["write"],
      agent: "discoverable",
      run: async ({ action, args }, ctx) => {
        const ready = await readyEditor();
        if (!ready) throw new Error("No active text editor");
        const { view, editor } = ready;
        // As editor.insertText: not the user's settings or keybindings (they name programs to
        // run), nor a file from elsewhere. Which actions is the dispatcher's check (commandGuards).
        if (!isUserCaller(ctx.caller)) {
          const path = view?.doc?.path.peek();
          // Any folder of a multi-root workspace is the workspace's (D251).
          if (!path || !services.workspace.contains(path))
            throw new Error(
              services.workspace.isMultiRoot()
                ? "Agents and extensions run editor actions on files of the workspace's folders."
                : "Agents and extensions run editor actions on files of the open folder.",
            );
        }
        if (!editor.actionSupported(action)) return { ran: false };
        return { ran: await editor.runAction(action, args) };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "editor.insertText",
      title: "Insert text",
      category: "Editor",
      description:
        "Types `text` into the active editor at the cursor (each cursor, replacing selected text), as one undoable edit. The file is changed in the editor, not saved. Extensions use it through ide.editor.insert.",
      input: s.object({ text: s.string().describe("Text to insert") }),
      effects: ["write"],
      agent: "discoverable",
      palette: false,
      run: async ({ text }, ctx) => {
        const ready = await readyEditor();
        if (!ready) throw new Error("No active text editor");
        const { view, editor } = ready;
        if (view.readOnly) throw new Error("The active editor is read-only.");
        // An extension's "fs.write" is for the open folder's files: not the user's settings or
        // keybindings (they name programs to run), nor a file from elsewhere.
        if (ctx.caller.kind === "ext") {
          const path = view.doc?.path.peek();
          if (!path || !services.workspace.contains(path))
            throw new Error(
              services.workspace.isMultiRoot()
                ? "Extensions can only type into files of the workspace's folders."
                : "Extensions can only type into files of the open folder.",
            );
        }
        editor.insertText(text);
        return { path: view.doc?.path.peek() ?? null, inserted: text.length };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "editor.select",
      title: "Select range",
      category: "Selection",
      description:
        "Selects a range in the active editor (1-based lines and columns; `endColumn` is exclusive, default: the end of `endLine`) and scrolls it into view.",
      input: s.object({
        startLine: s.integer({ min: 1 }),
        startColumn: s.integer({ min: 1 }).optional(),
        endLine: s.integer({ min: 1 }),
        endColumn: s.integer({ min: 1 }).optional(),
      }),
      effects: [],
      palette: false,
      run: async ({ startLine, startColumn, endLine, endColumn }) => {
        const ready = await readyEditor();
        if (!ready) throw new Error("No active text editor");
        const { view, editor } = ready;
        const range = {
          startLine,
          startColumn: startColumn ?? 1,
          endLine,
          endColumn: endColumn ?? Number.MAX_SAFE_INTEGER,
        };
        editor.select(range);
        view.focus();
        return { selected: range };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "editor.gotoLine",
      title: "Go to line…",
      category: "Go",
      description:
        "Moves the cursor of the active editor to `line` (and `column`), asking for the line when omitted.",
      input: s.object({
        line: s.integer({ min: 1 }).describe("1-based line").optional(),
        column: s.integer({ min: 1 }).describe("1-based column").optional(),
      }),
      effects: [],
      run: async ({ line, column }, ctx) => {
        const view = activeView();
        if (!view) throw new Error("No active text editor");
        // Unknown while the document loads: the reveal waits for it (and Monaco clamps).
        const lines = view.doc?.model.peek()?.lineCount ?? Number.MAX_SAFE_INTEGER;
        // Asked for from the keyboard: quick access with ":" (VS Code's Ctrl+G).
        if (line === undefined && ctx.caller.kind === "user") {
          await ctx.execute("quickOpen.show", { query: ":" });
          return { line: null };
        }
        const chosen =
          line ??
          Number(
            (await services.quickInput.prompt({
              prompt: lines < Number.MAX_SAFE_INTEGER ? `Go to line (1–${lines})` : "Go to line",
              validate: (v) => (/^\d+$/.test(v.trim()) ? undefined : "Type a line number."),
            })) ?? Number.NaN,
          );
        if (!Number.isFinite(chosen)) return { line: null };
        const target = Math.min(Math.max(1, chosen), lines);
        view.revealPosition(target, column ?? 1);
        view.focus();
        return { line: target };
      },
    }),
  );

  const { settings, workspace } = services;
  /** On/off editor settings as commands (View menu). */
  const toggles: [string, string, string, unknown, unknown][] = [
    ["editor.toggleWordWrap", "Toggle word wrap", "editor.wordWrap", "on", "off"],
    ["editor.toggleMinimap", "Toggle minimap", "editor.minimap.enabled", true, false],
    [
      "editor.toggleStickyScroll",
      "Toggle sticky scroll",
      "editor.stickyScroll.enabled",
      true,
      false,
    ],
    [
      "editor.toggleColumnSelection",
      "Toggle column selection mode",
      "editor.columnSelection",
      true,
      false,
    ],
    [
      "editor.toggleRenderWhitespace",
      "Toggle render whitespace",
      "editor.renderWhitespace",
      "all",
      "none",
    ],
  ];
  for (const [id, title, key, on, off] of toggles)
    sub.add(
      dispatcher.register({
        id,
        title,
        category: "View",
        description: `Switches the \`${key}\` user setting between ${JSON.stringify(on)} and ${JSON.stringify(off)}.`,
        input: s.empty(),
        effects: ["write"],
        run: async () => {
          const next = settings.peek(key) === on ? off : on;
          await settings.update(key, next, "user");
          return { [key]: next };
        },
      }),
    );

  // VS Code shows the mode in the status bar while it's on; a click turns it off.
  sub.add(
    services.statusBar.add({
      id: "editor.columnSelection",
      name: "Column selection",
      alignment: "right",
      priority: 40,
      text: () => {
        settings.version.value;
        return settings.peek("editor.columnSelection") === true ? "Column selection" : "";
      },
      tooltip: () => "Column selection mode is on: click to turn it off",
      command: "editor.toggleColumnSelection",
    }),
  );

  sub.add(
    dispatcher.register({
      id: "editor.saveAs",
      title: "Save as…",
      category: "File",
      description:
        "Writes the active editor's text to a new file in the folder (asking where when `path` is omitted) and opens it.",
      input: s.object({
        path: s
          .string()
          .describe("Destination, inside the folder (a workspace folder's, with several)")
          .optional(),
      }),
      effects: ["write"],
      when: "activeEditor",
      agent: "hidden",
      run: async ({ path }) => {
        const view = activeView();
        const model = view?.doc?.model.peek();
        if (!view?.doc || !model) throw new Error("No active text editor");
        // An untitled document: saving is "save as" (it becomes the file).
        if (isUntitled(view.doc.path.peek()))
          return dispatcher.execute("editor.saveUntitled", {
            untitled: view.doc.path.peek(),
            ...(path && { as: path }),
          });
        const picked = path ?? (await dialogIpc.pickSavePath("Save as", view.doc.path.peek()));
        if (!picked) return null;
        // Into any of the workspace's folders (D251); a relative path may name the folder first.
        const dest = workspace.root.peek() ? workspace.resolve(picked) : picked;
        if (!workspace.contains(dest))
          throw new Error(
            workspace.isMultiRoot()
              ? "Save inside one of the workspace's folders (files outside them aren't reachable)."
              : "Save inside the open folder (files outside it aren't reachable).",
          );
        await fsIpc.write(dest, new TextEncoder().encode(model.getText()));
        await dispatcher.execute("editor.openFile", { path: dest });
        return { saved: dest };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "workspace.openFile",
      title: "Open file…",
      category: "File",
      description:
        "Picks a file with the system dialog and opens it. With no folder open, its folder opens as the workspace.",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: async () => {
        const root = workspace.root.peek() ?? undefined;
        const picked = await dialogIpc.pickFile("Open file", root);
        if (!picked) return null;
        // Files are reachable inside the open folder: with none open, open the file's folder.
        if (!root && !(await workspace.open(dirname(picked)))) return null;
        else if (root && !workspace.contains(picked))
          throw new Error(
            workspace.isMultiRoot()
              ? "That file is outside the workspace's folders; add its folder first."
              : "That file is outside the open folder; open its folder first.",
          );
        await dispatcher.execute("editor.openFile", { path: picked });
        return { opened: picked };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "terminal.runSelectedText",
      title: "Run selected text in terminal",
      category: "Terminal",
      description:
        "Sends the active editor's selection (or the current line) to the most recent terminal and presses Enter.",
      input: s.empty(),
      effects: ["exec"],
      when: "activeEditor",
      agent: "hidden",
      run: async () => {
        const state = activeView()?.engineEditor?.activeState();
        const model = activeView()?.doc?.model.peek();
        if (!state || !model) throw new Error("No active text editor");
        const text =
          state.selectedText ||
          (model.getText().split(/\r?\n/)[state.cursor.line - 1] ?? "").trim();
        if (!text) return { sent: false };
        await dispatcher.execute("terminal.sendText", { text });
        return { sent: true };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "editor.copyAsMarkdown",
      title: "Copy as Markdown code block",
      category: "Edit",
      description:
        "Copies the selection (or the whole file) as a fenced Markdown code block with its language and a `path:lines` header — for chats, issues and docs.",
      input: s.empty(),
      effects: [],
      run: async () => {
        const view = activeView();
        const model = view?.doc?.model.peek();
        const state = view?.engineEditor?.activeState();
        if (!view?.doc || !model || !state) throw new Error("No active text editor");
        // With several folders, the folder's name first ("api/src/x.ts", D251).
        const rel = services.workspace.relative(view.doc.path.peek()) || view.doc.path.peek();
        const sel = state.selections[0];
        const text = state.selectedText || model.getText();
        const lines =
          state.selectedText && sel
            ? sel.start.line === sel.end.line
              ? `:${sel.start.line}`
              : `:${sel.start.line}-${sel.end.line}`
            : "";
        const fence = text.includes("```") ? "````" : "```";
        const markdown = `\`${rel}${lines}\`\n${fence}${model.languageId === "plaintext" ? "" : model.languageId}\n${text.replace(/\n$/, "")}\n${fence}\n`;
        await dispatcher.execute("ui.copyText", { text: markdown });
        return { chars: markdown.length };
      },
    }),
  );

  return (view, at) => {
    const editor = view.engineEditor;
    if (!editor) return;
    const run = (action: string) => () =>
      void dispatcher.execute("editor.runAction", { action }).catch(() => {});
    const items: MenuItem[] = [];
    const peek: MenuItem[] = [];
    const hasSelection = !!editor.activeState()?.selectedText;
    let pendingSeparator = false;
    for (const entry of EDITOR_MENU) {
      pendingSeparator ||= !!entry.separatorBefore;
      // Preconditions cover both "has a provider" and "is writable" (no Cut in read-only text).
      if (!editor.actionSupported(entry.action) || (entry.selection && !hasSelection)) continue;
      const { command } = entry;
      const item: MenuItem = {
        label: entry.label,
        ...(entry.icon && { icon: entry.icon }),
        ...(entry.key && { keybinding: keyboard.labelForKeys(entry.key, entry.mac) }),
        run: command
          ? () => void dispatcher.execute(command, {}).catch(() => {})
          : run(entry.action),
      };
      if (entry.peek) {
        peek.push(item);
        continue;
      }
      items.push({ ...item, separatorBefore: pendingSeparator && items.length > 0 });
      pendingSeparator = false;
    }
    // The Peek submenu goes after "Go to references" (VS Code's order).
    if (peek.length) {
      const after = items.findIndex((i) => i.label === "Go to references");
      items.splice(after >= 0 ? after + 1 : 0, 0, { label: "Peek", icon: "eye", submenu: peek });
    }
    if (editor.activeState()?.selectedText)
      items.push({
        label: "Copy as Markdown",
        icon: "copy",
        run: () => void dispatcher.execute("editor.copyAsMarkdown", {}).catch(() => {}),
      });
    // Extensions' commands for this file (contributes.menus "editor/context", D176).
    const path = view.doc?.path.peek() ?? "";
    const keys = resourceContext(path, false, view.doc?.model.peek()?.languageId);
    const contributed = services.extensionFeatures.menuItems("editor/context", (when) =>
      matchesWhen(when, (key) => (key in keys ? keys[key] : services.context.get(key))),
    );
    for (const [i, m] of contributed.entries())
      items.push({
        label: m.title,
        ...(m.icon && { icon: knownIcon(m.icon) }),
        separatorBefore: i === 0 && items.length > 0,
        run: () => void dispatcher.execute(m.command, { path }).catch(() => {}),
      });
    const more = extra(view, editor.activeState()?.cursor.line ?? 0);
    for (const [i, item] of more.entries())
      items.push({ ...item, separatorBefore: i === 0 && items.length > 0 });
    items.push({
      label: "Command palette",
      icon: "search",
      keybinding: keyboard.labelFor("palette.show"),
      separatorBefore: items.length > 0,
      run: () => void dispatcher.execute("palette.show", {}).catch(() => {}),
    });
    // After the engine's own mouse handling (it refocuses its text area on right-click), so the
    // menu keeps keyboard focus.
    requestAnimationFrame(() => {
      showContextMenu(at.x, at.y, items);
    });
  };
}
