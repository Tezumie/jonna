// The `vscode` shim's commands (D256). A VS Code extension's handlers live here under VS Code's
// ids; the ones its package.json declares are also the IDE's commands (palette, keys, menus,
// agents) under the dispatcher's id. Commands with arguments (a code lens's, a tree row's) go
// through one hidden command of the extension with a handle to the arguments, kept here, so they
// arrive as the same objects. VS Code's own command ids an extension runs map onto the IDE's.
// DOM-free and unit-tested.

import type { WorkerApi } from "../rpc";
import { builtinCommand } from "./builtinCommands";
import { ANNOUNCE_VSCODE_COMMAND, RUN_VSCODE_COMMAND } from "./commandIds";
import { type CommandRef, pathOf, reviveArgument } from "./convert";
import { isExecuteCommand, runExecuteCommand } from "./executeCommands";

/** An argument as it crosses to the IDE or another extension: data (a Uri as its JSON). */
const serializeArgument = (v: unknown): unknown => {
  try {
    return v === undefined ? null : (JSON.parse(JSON.stringify(v)) as unknown);
  } catch {
    return null;
  }
};

import type { Command } from "./languageTypes";
import { Disposable, Position, Range, Uri, ViewColumn } from "./types";

/** A command of the package as the IDE has it (D256: `vscodeId` when they differ). */
export interface DeclaredCommand {
  id: string;
  vscodeId?: string;
  /** The language model tool it runs (D258), with what the agent is told about it. */
  tool?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** How a tree view's row arrives in a menu's input as the element the extension gave. */
export type TreeArgument = (item: { id?: unknown; view?: unknown }) => unknown;
/** A canSelectMany view's selected elements for a row's menu (its second argument), if any. */
export type TreeSelection = (
  item: { id?: unknown; view?: unknown },
  element: unknown,
) => unknown[] | undefined;

const MAX_REFS = 2000;

/**
 * VS Code's own commands that extensions run, as the IDE's (D258): the IDE's id and its input
 * from VS Code's arguments (a Uri's path, a string).
 */
const BUILTIN: Record<string, [string, (args: unknown[]) => Record<string, unknown>]> = (() => {
  const none = () => ({});
  const path = (args: unknown[]) => {
    const uri = Uri.revive(args[0]);
    return uri ? { path: pathOf(uri) } : {};
  };
  const text = (key: string) => (args: unknown[]) =>
    typeof args[0] === "string" ? { [key]: args[0] } : {};
  return {
    "workbench.action.closeActiveEditor": ["editor.closeTab", none],
    "workbench.action.closeAllEditors": ["editor.closeAll", none],
    "workbench.action.files.save": ["editor.save", none],
    "workbench.action.files.saveAs": ["editor.saveAs", none],
    "workbench.action.files.revert": ["editor.reloadFromDisk", none],
    "workbench.action.files.setActiveEditorReadonlyInSession": [
      "editor.setReadOnlyInSession",
      none,
    ],
    "workbench.action.files.setActiveEditorWriteableInSession": [
      "editor.setWritableInSession",
      none,
    ],
    "workbench.action.files.toggleActiveEditorReadonlyInSession": [
      "editor.toggleReadOnlyInSession",
      none,
    ],
    "workbench.action.files.resetActiveEditorReadonlyInSession": [
      "editor.resetReadOnlyInSession",
      none,
    ],
    "editor.action.formatDocument": ["editor.formatDocument", none],
    "editor.action.formatDocument.multiple": ["editor.formatDocumentWith", none],
    "editor.action.formatSelection.multiple": ["editor.formatSelectionWith", none],
    "workbench.action.quickOpen": ["quickOpen.show", text("query")],
    "workbench.action.showCommands": ["palette.show", none],
    "workbench.action.gotoSymbol": ["quickOpen.goToSymbol", none],
    "workbench.action.showAllSymbols": ["quickOpen.goToWorkspaceSymbol", none],
    "workbench.action.terminal.new": ["terminal.create", none],
    "workbench.action.terminal.focus": ["terminal.focus", none],
    "workbench.action.terminal.kill": ["terminal.kill", none],
    "workbench.action.terminal.clear": ["terminal.clear", none],
    "workbench.action.terminal.sendSequence": [
      "terminal.sendText",
      (args) => {
        const t = (args[0] as { text?: unknown } | undefined)?.text;
        return typeof t === "string" ? { text: t } : {};
      },
    ],
    "workbench.action.tasks.runTask": ["tasks.run", text("label")],
    "workbench.action.tasks.terminate": ["tasks.terminate", text("label")],
    "workbench.action.tasks.restartTask": ["tasks.restart", text("label")],
    "workbench.view.explorer": ["explorer.focus", none],
    "workbench.view.search": ["search.show", none],
    "workbench.action.findInFiles": [
      "search.show",
      (args) => {
        const q = (args[0] as { query?: unknown } | undefined)?.query;
        return typeof q === "string" ? { query: q } : {};
      },
    ],
    "workbench.view.scm": ["git.showView", none],
    "workbench.view.debug": ["debug.showView", none],
    "workbench.view.extensions": ["extensions.show", none],
    "workbench.extensions.search": ["extensions.show", text("query")],
    "workbench.debug.action.toggleRepl": ["debug.showConsole", none],
    "workbench.debug.action.focusRepl": ["debug.showConsole", none],
    "workbench.action.debug.start": ["debug.start", none],
    "workbench.action.debug.run": ["debug.runWithoutDebugging", none],
    "workbench.action.debug.stop": ["debug.stop", none],
    "workbench.action.debug.restart": ["debug.restart", none],
    "editor.debug.action.toggleBreakpoint": ["debug.toggleBreakpoint", none],
    "workbench.files.action.refreshFilesExplorer": ["explorer.refresh", none],
    "workbench.files.action.collapseExplorerFolders": ["explorer.collapseAll", none],
    revealInExplorer: ["explorer.reveal", path],
    revealFileInOS: ["explorer.revealInOs", path],
    copyFilePath: ["explorer.copyPath", path],
    copyRelativeFilePath: ["explorer.copyPath", (args) => ({ ...path(args), relative: true })],
    "markdown.showPreview": ["editor.renderMarkdown", path],
    "markdown.showPreviewToSide": ["editor.renderMarkdown", path],
    "vscode.openFolder": [
      "workspace.openFolder",
      (args) => ({ ...path(args), ...(args[1] === true && { newWindow: true }) }),
    ],
    "workbench.action.files.openFolder": ["workspace.openFolder", none],
    "vscode.diff": [
      "editor.compareFiles",
      (args) => {
        const left = Uri.revive(args[0]);
        const right = Uri.revive(args[1]);
        return left && right ? { path: pathOf(right), against: pathOf(left) } : {};
      },
    ],
  };
})();

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

export class ShimCommands {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>();
  private readonly byVscodeId = new Map<string, DeclaredCommand>();
  private readonly refs = new Map<number, { command: string; args: unknown[] }>();
  private nextRef = 1;
  treeArgument: TreeArgument = () => undefined;
  /** An absolute path for a workspace-relative one (index.ts sets it: the workspace's folders). */
  absolutePath: (path: string) => string = (path) => path;
  /** A line in the extension's log (index.ts sets it). */
  warn: (text: string) => void = () => {};
  treeSelection: TreeSelection = () => undefined;
  /** VS Code's `interactive.open` (the notebooks' part sets it). */
  openInteractive: ((args: unknown[]) => Promise<unknown>) | undefined;

  /**
   * Set once the webviews part exists (D419): takes `undo` / `redo` when a custom text editor of
   * the extension is the tab the user is in (its file has no text editor to undo in).
   */
  customTextUndo: ((action: "undo" | "redo") => Promise<boolean>) | undefined;

  constructor(
    private readonly ide: WorkerApi,
    declared: readonly DeclaredCommand[],
    private readonly shimCommand: string,
    private readonly unsupported: (name: string) => void,
  ) {
    for (const c of declared) if (!c.tool) this.byVscodeId.set(c.vscodeId ?? c.id, c);
    // The hidden command: a code lens, tree row or status bar item's command with its arguments.
    ide.commands.register(shimCommand, (input) => {
      // Another extension runs one of its code-registered commands (extensions.executeVscodeCommand).
      if (isPlainObject(input) && typeof input.id === "string") {
        const args = (Array.isArray(input.arguments) ? input.arguments : []).map(reviveArgument);
        // One of its keybindings (`resolve`): the command as VS Code's registry would find it —
        // one its code registered, VS Code's own, or another extension's.
        if (input.resolve === true) return this.executeCommand(input.id, ...args);
        // Its own internal ones ("_…") stay its own.
        const handler = input.id.startsWith("_") ? undefined : this.handlers.get(input.id);
        if (!handler) throw new Error(`command '${input.id}' not found`);
        return handler(...args);
      }
      const ref = isPlainObject(input) ? Number(input.ref) : Number.NaN;
      const entry = this.refs.get(ref);
      if (!entry) throw new Error("That command is no longer available.");
      return this.executeCommand(entry.command, ...entry.args);
    });
  }

  registerCommand(
    id: string,
    callback: (...args: unknown[]) => unknown,
    thisArg?: unknown,
  ): Disposable {
    if (this.handlers.has(id)) throw new Error(`command '${id}' already exists`);
    const fn = thisArg ? callback.bind(thisArg) : callback;
    this.handlers.set(id, fn);
    const declared = this.byVscodeId.get(id);
    const registration = declared
      ? this.ide.commands.register(declared.id, (input) => fn(...this.argumentsOf(input)))
      : undefined;
    // Not in its manifest: other extensions can still run it by its id (VS Code's one registry).
    if (!declared && !id.startsWith("_"))
      void this.ide.commands.execute(`${ANNOUNCE_VSCODE_COMMAND}${id}`, {}).catch(() => {});
    return new Disposable(() => {
      if (this.handlers.get(id) === fn) this.handlers.delete(id);
      registration?.dispose();
    });
  }

  /** What a command run by the IDE gets: VS Code's arguments from the IDE's input. */
  private argumentsOf(input: unknown): unknown[] {
    if (!isPlainObject(input)) return [];
    if (Array.isArray(input.arguments)) return input.arguments.map(reviveArgument);
    // A tree row's menu: the element the extension gave for that row.
    if (isPlainObject(input.item)) {
      const element = this.treeArgument(input.item);
      const selected = this.treeSelection(input.item, element);
      return selected ? [element, selected] : [element];
    }
    // The Explorer's and the editor's menus: the file (and, in VS Code, the selected ones).
    if (typeof input.path === "string") {
      const uri = Uri.file(input.path);
      return [uri, [uri]];
    }
    return [];
  }

  /** How the IDE runs `command` (a code lens's, a status bar item's): its id, or the hidden one. */
  ref(command: Command | string | undefined): CommandRef | undefined {
    if (!command) return undefined;
    const c = typeof command === "string" ? { command, title: "" } : command;
    const declared = this.byVscodeId.get(c.command);
    if (declared && !c.arguments?.length) return { command: declared.id };
    const ref = this.nextRef++;
    this.refs.set(ref, { command: c.command, args: c.arguments ?? [] });
    if (this.refs.size > MAX_REFS) {
      const oldest = this.refs.keys().next().value;
      if (oldest !== undefined) this.refs.delete(oldest);
    }
    return { command: this.shimCommand, input: { ref } };
  }

  async executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T> {
    const handler = this.handlers.get(id);
    if (handler) return (await handler(...args)) as T;
    const builtin = await this.builtin(id, args);
    if (builtin.handled) return builtin.value as T;
    const declared = this.byVscodeId.get(id);
    if (declared)
      return this.ide.commands.execute<T>(declared.id, { arguments: args.map(serializeArgument) });
    // Another extension's command, or the IDE's: resolved by the host (as this extension).
    return this.ide.commands.execute<T>(`${RUN_VSCODE_COMMAND}${id}`, {
      arguments: args.map(serializeArgument),
    });
  }

  getCommands(filterInternal = false): Promise<string[]> {
    const ids = [...new Set([...this.handlers.keys(), ...this.byVscodeId.keys()])];
    return Promise.resolve(filterInternal ? ids.filter((id) => !id.startsWith("_")) : ids);
  }

  /**
   * One of the editor's own commands on the active editor (cursorMove's `{ to, by, value,
   * select }`): false when there's none or the editor refused it (logged).
   */
  private async editorCommand(action: string, arg: unknown, quiet = false): Promise<boolean> {
    try {
      const r = await this.ide.commands.execute<{ ran?: unknown }>("editor.runAction", {
        action,
        ...(isPlainObject(arg) && { args: serializeArgument(arg) }),
      });
      return r?.ran === true;
    } catch (err) {
      if (!quiet) this.warn(`${action}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * VS Code's editorScroll (`{ to: "up" | "down", by: "line" | "wrappedLine" | "page" |
   * "halfPage" | "editor", value, revealCursor }`): the editor's own command, else its line, page
   * and top / bottom scrolls (half pages have none).
   */
  private async editorScroll(arg: unknown): Promise<boolean> {
    const o = isPlainObject(arg) ? arg : {};
    if (await this.editorCommand("editorScroll", o, true)) return true;
    const down = o.to === "down";
    if (o.to !== "up" && !down) return false;
    const by = typeof o.by === "string" ? o.by : "line";
    if (by === "editor")
      return this.editorCommand(down ? "scrollEditorBottom" : "scrollEditorTop", undefined);
    const step =
      by === "line" || by === "wrappedLine"
        ? down
          ? "scrollLineDown"
          : "scrollLineUp"
        : by === "page"
          ? down
            ? "scrollPageDown"
            : "scrollPageUp"
          : undefined;
    if (!step) {
      this.unsupported(`commands.executeCommand("editorScroll") by ${by}`);
      return false;
    }
    const times =
      typeof o.value === "number" && Number.isInteger(o.value)
        ? Math.min(100, Math.max(1, o.value))
        : 1;
    let moved = false;
    for (let i = 0; i < times; i++) moved = (await this.editorCommand(step, undefined)) || moved;
    return moved;
  }

  /** VS Code's own commands extensions run, in the IDE's terms. */
  private async builtin(
    id: string,
    args: unknown[],
  ): Promise<{ handled: boolean; value?: unknown }> {
    const ide = this.ide;
    const [a, b, c] = args;
    // In one of its custom text editors, undo and redo are that document's (D419).
    if ((id === "undo" || id === "redo") && (await this.customTextUndo?.(id)))
      return { handled: true };
    switch (id) {
      case "setContext": {
        const value =
          b === undefined || b === null || ["string", "number", "boolean"].includes(typeof b)
            ? (b as string | number | boolean | null | undefined)
            : Boolean(b);
        await ide.context.set(String(a), value).catch((err: unknown) => {
          this.unsupported(
            `setContext ${String(a)} (${err instanceof Error ? err.message : String(err)})`,
          );
        });
        return { handled: true };
      }
      case "vscode.open":
      case "vscode.openWith": {
        const uri = Uri.revive(a) ?? (typeof a === "string" ? Uri.parse(a) : undefined);
        if (!uri) return { handled: true };
        if (uri.scheme === "http" || uri.scheme === "https" || uri.scheme === "mailto")
          return { handled: true, value: await ide.env.openExternal(uri.toString(true)) };
        // vscode.open(uri, columnOrOptions); vscode.openWith(uri, viewType, columnOrOptions).
        const viewType = id === "vscode.openWith" && typeof b === "string" ? b : undefined;
        const third = id === "vscode.openWith" ? c : b;
        const options = isPlainObject(third) ? third : {};
        const column = typeof third === "number" ? third : options.viewColumn;
        const selection = Range.isRange(options.selection) ? options.selection : undefined;
        await ide.editor.open(pathOf(uri), {
          ...(selection && {
            line: selection.start.line + 1,
            column: selection.start.character + 1,
          }),
          ...(options.preview === false && { preview: false }),
          ...(options.preserveFocus === true && { preserveFocus: true }),
          ...(column === ViewColumn.Beside && { toSide: true }),
          // "default" is VS Code's text editor; anything else a custom editor's view type.
          ...(viewType && { with: viewType === "default" ? "text" : viewType }),
        });
        return { handled: true };
      }
      // A code lens's "3 references": the IDE opens the first (its own peek is for its providers).
      case "editor.action.showReferences":
      case "editor.action.peekLocations":
      case "editor.action.goToLocations": {
        const uri = Uri.revive(a);
        const locations = Array.isArray(c) ? c : [];
        const first = locations[0] as { uri?: unknown; range?: Range } | undefined;
        const target = first ? Uri.revive(first.uri) : uri;
        const at = first?.range?.start ?? (Position.isPosition(b) ? b : undefined);
        if (target)
          await ide.editor.open(
            pathOf(target),
            at ? { line: at.line + 1, column: at.character + 1 } : {},
          );
        return { handled: true };
      }
      case "workbench.action.openSettings":
      case "workbench.action.openGlobalSettings":
      case "workbench.action.openWorkspaceSettings":
        await ide.commands.execute("settings.open", typeof a === "string" ? { query: a } : {});
        return { handled: true };
      case "workbench.action.openSettingsJson":
        await ide.commands.execute("settings.openJson", {});
        return { handled: true };
      case "workbench.action.files.saveAll":
        await ide.commands.execute("editor.saveAll", {});
        return { handled: true };
      case "revealLine": {
        const o = isPlainObject(a) ? a : {};
        const active = await ide.editor.active();
        if (active && typeof o.lineNumber === "number")
          await ide.editor.open(active.path, { line: o.lineNumber + 1, preserveFocus: true });
        return { handled: true };
      }
      case "workbench.extensions.installExtension": {
        // An id: installed from Open VSX (the user allows what it asks for).
        const ext = typeof a === "string" ? a : Uri.revive(a)?.fsPath;
        if (!ext) return { handled: true };
        const value = await ide.commands.execute(
          /\.vsix$/i.test(ext) ? "extensions.installFromVsix" : "extensions.installFromStore",
          /\.vsix$/i.test(ext) ? { file: ext } : { id: ext },
        );
        return { handled: true, value };
      }
      // A controller picked by id (Jupyter: { notebookEditor, id, extension }); none: the picker.
      case "notebook.selectKernel": {
        const o = isPlainObject(a) ? a : {};
        const editor = o.notebookEditor as { notebook?: { uri?: unknown } } | undefined;
        const uri = Uri.revive(editor?.notebook?.uri) ?? Uri.revive(o.uri);
        const value = await ide.commands.execute("notebook.selectKernel", {
          ...(uri && { path: pathOf(uri) }),
          ...(typeof o.id === "string" && { kernel: o.id }),
        });
        return { handled: true, value };
      }
      // VS Code's Interactive Window (notebooks.ts opens it: { notebookUri, inputUri,
      // notebookEditor }).
      case "interactive.open": {
        if (!this.openInteractive) break;
        return { handled: true, value: await this.openInteractive(args) };
      }
      // VS Code's cell execution with its arguments (Jupyter: `{ ranges, document }` after it
      // adds cells; a menu's NotebookCell): those cells of that notebook, in order.
      case "notebook.cell.execute": {
        const cells = cellTargets(a);
        if (!cells) break;
        let value: unknown;
        for (const index of cells.indexes)
          value = await ide.commands.execute("notebook.runCell", { path: cells.path, index });
        return { handled: true, value };
      }
      case "notebook.execute": {
        const uri = Uri.revive(isPlainObject(a) && "uri" in a ? a.uri : a);
        if (!uri) break;
        return {
          handled: true,
          value: await ide.commands.execute("notebook.runAll", { path: pathOf(uri) }),
        };
      }
      case "notebook.cell.cancelExecution":
      case "notebook.cancelExecution": {
        const path = cellTargets(a)?.path ?? notebookPathOf(a);
        if (!path) break;
        return {
          handled: true,
          value: await ide.commands.execute("notebook.interrupt", { path }),
        };
      }
      // The editor's own cursor and scroll commands, with VS Code's arguments, on the active one.
      case "cursorMove":
        return { handled: true, value: await this.editorCommand(id, a) };
      case "editorScroll":
        return { handled: true, value: await this.editorScroll(a) };
      case "workbench.action.reloadWindow":
        this.unsupported(`commands.executeCommand("${id}")`);
        return { handled: true };
      default: {
        const mapped = BUILTIN[id];
        if (mapped)
          return { handled: true, value: await ide.commands.execute(mapped[0], mapped[1](args)) };
        // The rest of VS Code's commands the IDE has (notebook cells, undo, layout…): their
        // arguments don't carry over, the mapping's own input does.
        const simple = builtinCommand(id);
        if (simple)
          return {
            handled: true,
            value: await ide.commands.execute(simple.command, simple.input ?? {}),
          };
        // vscode.execute…Provider: every provider the editor has (executeCommands.ts).
        if (isExecuteCommand(id))
          return {
            handled: true,
            value: await runExecuteCommand(ide, id, args, {
              absolute: this.absolutePath,
              log: this.warn,
            }),
          };
        if (id.startsWith("vscode.execute") || id.startsWith("_")) {
          this.unsupported(`commands.executeCommand("${id}")`);
          // What VS Code resolves when no provider answers (D261: `undefined.forEach` threw).
          if (id === "vscode.executeCompletionItemProvider")
            return { handled: true, value: { isIncomplete: false, items: [] } };
          if (/^vscode\.execute\w*Provider$/.test(id) && !/Rename|SignatureHelp/.test(id))
            return { handled: true, value: [] };
          return { handled: true };
        }
        // Each view's "<view id>.focus" / ".open" (VS Code makes them for every view, D260): one
        // of the extension's own views is revealed.
        const view = /^(.+)\.(focus|open)$/.exec(id)?.[1];
        if (view && !this.byVscodeId.has(id)) {
          const shown = await ide.ui
            .webview(view)
            .reveal()
            .then(
              () => true,
              () => false,
            );
          if (shown) return { handled: true };
        }
        return { handled: false };
      }
    }
    // A notebook command without arguments it understands: the IDE's, on the active notebook.
    const simple = builtinCommand(id);
    return simple
      ? { handled: true, value: await ide.commands.execute(simple.command, simple.input ?? {}) }
      : { handled: false };
  }
}

/** Any object, a class's too (an extension's NotebookRange, the shim's NotebookDocument). */
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** The notebook a VS Code command's argument names (a Uri, `{ uri }`, a NotebookDocument). */
function notebookPathOf(arg: unknown): string | undefined {
  const o = isObject(arg) ? arg : undefined;
  const uri =
    Uri.revive(arg) ??
    Uri.revive(o?.uri) ??
    Uri.revive((o?.notebookEditor as { notebook?: { uri?: unknown } } | undefined)?.notebook?.uri);
  return uri ? pathOf(uri) : undefined;
}

/**
 * The cells VS Code's cell commands are given: `{ ranges, document }` (Jupyter), a NotebookCell
 * (`{ index, notebook }`) or `{ cell }` from a menu. Undefined when the argument is none of those.
 */
export function cellTargets(arg: unknown): { path: string; indexes: number[] } | undefined {
  if (!isObject(arg)) return undefined;
  const ranges = Array.isArray(arg.ranges) ? arg.ranges : undefined;
  if (ranges) {
    const path = notebookPathOf(arg.document);
    if (!path) return undefined;
    const indexes: number[] = [];
    for (const r of ranges.slice(0, 100)) {
      // `new NotebookRange(…)` as often as `{ start, end }` (an instance was skipped: nothing ran).
      const range = isObject(r) ? r : {};
      const start = Number(range.start);
      const end = Number(range.end);
      if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
      for (let i = Math.max(0, start); i < end && indexes.length < 10_000; i++) indexes.push(i);
    }
    return { path, indexes };
  }
  const cell = isObject(arg.cell) ? arg.cell : arg;
  // A NotebookCell of the shim's: its notebook is a class's object.
  const notebook = isObject(cell.notebook) ? cell.notebook : undefined;
  const path = notebook ? notebookPathOf(notebook) : undefined;
  return path && typeof cell.index === "number" ? { path, indexes: [cell.index] } : undefined;
}
