// The "editor" dock view: one engine editor per tab, showing a shared EditorDocument. Until
// Monaco is ready it shows the file's first lines as plain text (DESIGN.md §16); binary files
// and load errors get an empty state. The DOM node survives moves between groups (the dock moves
// it and calls onResize).
import type { Json } from "../../core/dock/index";
import { h, on, replaceChildren } from "../../core/dom/index";
import { Emitter } from "../../core/events/index";
import { fsIpc } from "../../core/ipc/fs";
import { DisposableStore } from "../../core/lifecycle/index";
import { basename } from "../../core/paths/index";
import { effect, untracked } from "../../core/reactive/index";
import { fileIconTint } from "../../ui/fileTint";
import { fileIcon, icon } from "../../ui/Icon";
import type {
  DockView,
  DockViewContext,
  DockViewDescriptor,
  TabAction,
} from "../../workbench/dock/views";
import { stateField } from "../../workbench/dock/views";
import { Breadcrumbs, type ChromeHost, FileStatusBar } from "./chrome";
import type { EngineEditor } from "./engine";
import type { EditorFileRules } from "./fileRules";
import type { EditorPosition, EditorPositions } from "./positions";
import { documentName, type EditorDocument, type EditorService } from "./service";
import { isUntitled, untitledName } from "./untitled";

const PREVIEW_LINES = 40;

export interface EditorViewHost {
  readonly editors: EditorService;
  /** Live editor views by tab id (for "active editor", delete handling, state). */
  readonly views: Map<string, EditorView>;
  run(command: string, input?: unknown): void;
  /** Called when the view's editor gains focus or its cursor moves. */
  onActivity(view: EditorView): void;
  /** Right-click in the text: the IDE's editor menu (actions.ts). */
  contextMenu(view: EditorView, at: { x: number; y: number; gutterLine?: number }): void;
  /** Toolbar actions for a file's tab (e.g. "Open preview to the side" for Markdown and SVG). */
  actionsFor(path: string): TabAction[];
  /** Breadcrumbs and the per-file status bar (chrome.ts). */
  readonly chrome: ChromeHost;
  /** Where files were scrolled to, for a file opened again (positions.ts, D190). */
  readonly positions: EditorPositions;
  /** A file from outside the folder that the user opened themselves (it may be let in again). */
  userOpenedOutside(path: string): boolean;
  /** The project's own formatter for this view's file (D140); true when it handled it. */
  formatDocument(view: EditorView): Promise<boolean>;
  /** Ctrl+Z at a workspace operation's edit: offer undoing it everywhere (D141). */
  workspaceUndo(view: EditorView, how: "undo" | "redo"): boolean | Promise<boolean>;
  /** Read-only by the settings or the session, secret values hidden (fileRules.ts). */
  readonly fileRules: EditorFileRules;
}

export function editorViewDescriptor(host: EditorViewHost): DockViewDescriptor {
  return {
    type: "editor",
    title: (state) => {
      const path = stateField(state, "path");
      if (typeof path !== "string") return "Untitled";
      return isUntitled(path) ? untitledName(path) : basename(path);
    },
    icon: (state) => {
      const path = stateField(state, "path");
      return typeof path === "string" && !isUntitled(path) ? fileIcon(basename(path)) : "file";
    },
    tint: (state) => {
      const path = stateField(state, "path");
      return typeof path === "string" && !path.startsWith("virtual:") && !isUntitled(path)
        ? fileIconTint(basename(path))
        : undefined;
    },
    resource: (state) => {
      const path = stateField(state, "path");
      return typeof path === "string" && !path.startsWith("virtual:") && !isUntitled(path)
        ? path
        : undefined;
    },
    tooltip: (state) => {
      const path = stateField(state, "path");
      if (typeof path === "string" && isUntitled(path))
        return `${untitledName(path)} · not saved yet`;
      return typeof path === "string" && !path.startsWith("virtual:") ? path : "Untitled";
    },
    defaultPlacement: "main",
    editorLike: true,
    duplicate: (state) => state,
    actions: (state) => {
      const path = stateField(state, "path");
      return typeof path === "string" && !path.startsWith("virtual:") && !isUntitled(path)
        ? host.actionsFor(path)
        : [];
    },
    create: (state, ctx) => new EditorView(state, ctx, host),
  };
}

export class EditorView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly changed = this.store.add(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  private readonly engineHost: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly crumbs: Breadcrumbs;
  private readonly fileStatus: FileStatusBar;
  private editor: EngineEditor | undefined;
  doc: EditorDocument | undefined;
  private path: string;
  private visible = false;
  /** What fileRules says about the shown file, applied to the editor when it's made. */
  private forcedReadOnly = false;
  private secretMask = false;

  /** Can't be edited: its document is read-only, or the settings or the session keep it so. */
  get readOnly(): boolean {
    return (this.doc?.model.peek()?.readOnly ?? false) || this.forcedReadOnly;
  }

  /** Shown in its group (not a background tab). */
  get isVisible(): boolean {
    return this.visible;
  }

  constructor(
    state: Json,
    private readonly ctx: DockViewContext,
    private readonly host: EditorViewHost,
  ) {
    const path = stateField(state, "path");
    this.path = typeof path === "string" ? path : "";
    this.engineHost = h("div", { class: "editor-engine", hidden: true });
    this.preview = h("pre", { class: "editor-preview", "aria-hidden": "true" });
    this.notice = h("div", { class: "empty-state", hidden: true });
    this.banner = h("div", { class: "banner is-warning", role: "status", hidden: true });
    const subject = {
      path: () => this.doc?.path.peek() ?? this.path,
      encoding: () => this.doc?.encoding ?? "utf8",
      editor: () => this.engineEditor,
      model: () => this.doc?.model.peek() ?? null,
      reveal: (line: number, column: number) => {
        this.revealPosition(line, column);
        this.engineEditor?.focus();
      },
      relayout: () => this.onResize(),
    };
    this.crumbs = this.store.add(new Breadcrumbs(host.chrome, subject));
    this.fileStatus = this.store.add(new FileStatusBar(host.chrome, subject));
    this.crumbs.element.hidden = true;
    this.fileStatus.element.hidden = true;
    this.element = h(
      "div",
      { class: "editor-view", tabindex: "-1" },
      this.banner,
      this.crumbs.element,
      this.preview,
      this.engineHost,
      this.notice,
      this.fileStatus.problems,
      this.fileStatus.element,
    );
    host.views.set(ctx.tabId, this);
    // Only our own entry: a tab restored with the same id may already have replaced it.
    this.store.add({
      dispose: () => {
        if (host.views.get(ctx.tabId) === this) host.views.delete(ctx.tabId);
      },
    });
    void this.load();
  }

  get tabId(): string {
    return this.ctx.tabId;
  }

  private async load(): Promise<void> {
    const { editors } = this.host;
    let doc: EditorDocument;
    try {
      doc = editors.find(this.path) ?? (await editors.load(this.path));
    } catch (err) {
      // A file from outside the folder that the user opened in this tab (restored after a
      // restart, D190): it's theirs to see again. (The list of those may still be loading.)
      const outside = /^([a-zA-Z]:[\\/]|\/)/.test(this.path);
      if (outside && !this.host.userOpenedOutside(this.path))
        await new Promise((done) => setTimeout(done, 400));
      if (outside && this.host.userOpenedOutside(this.path)) {
        const again = await fsIpc
          .allowFile(this.path)
          .then(() => editors.load(this.path))
          .catch(() => null);
        if (again && !this.store.isDisposed) return this.attachLoaded(again);
      }
      if (this.store.isDisposed) return;
      this.showNotice("Couldn't open this file", err instanceof Error ? err.message : String(err));
      return;
    }
    if (this.store.isDisposed) return;
    this.attachLoaded(doc);
  }

  private attachLoaded(doc: EditorDocument): void {
    const { editors } = this.host;
    this.doc = doc;
    editors.retain(doc);
    this.store.add({ dispose: () => editors.release(doc) });
    // Its encoding shows in the status bar (reopened or saved with another one, D199).
    this.store.add(
      editors.encodingChanged.event((p) => {
        if (p !== doc.path.peek()) return;
        this.fileStatus.update();
        // Read-only or writable now (reopened, or rewritten as UTF-8 elsewhere, D218): the
        // banner follows (the disk state signal alone may not have changed).
        this.showDiskState(doc);
      }),
    );
    this.store.add(
      effect(() => {
        // Title/dirty decorations and the persisted path follow the document (renames).
        const path = doc.path.value;
        // Editing keeps a preview tab open (DESIGN.md §12.3).
        // (Deferred: a reload from disk is dirty for an instant, then clean again.)
        if (doc.dirty.value) queueMicrotask(() => doc.dirty.peek() && this.ctx.pin());
        if (path !== this.path && doc.kind !== "virtual") {
          this.path = path;
          this.ctx.updateState({ path });
        }
        this.changed.fire();
        return undefined;
      }),
    );
    if (doc.kind === "binary") {
      this.showNotice(
        `${documentName(doc)} is a binary file`,
        "It can't be displayed in the text editor.",
        {
          label: "Open in hex viewer",
          run: () => this.host.run("editor.reopenWith", { path: doc.path.peek(), with: "hex" }),
        },
      );
      return;
    }
    // Read-only by the settings or the session, secret values covered (fileRules.ts); a rename
    // takes the session's choice along.
    let rulesPath = doc.path.peek();
    this.store.add(
      effect(() => {
        const path = doc.path.value;
        const rules = this.host.fileRules;
        if (path !== rulesPath) {
          const from = rulesPath;
          untracked(() => rules.renamed(from, path));
          rulesPath = path;
        }
        this.forcedReadOnly = rules.readOnly(path);
        this.secretMask = rules.hideSecrets(path);
        this.editor?.setForcedReadOnly(this.forcedReadOnly);
        this.editor?.setSecretMask(this.secretMask);
        return undefined;
      }),
    );
    this.store.add(effect(() => this.showDiskState(doc)));
    this.store.add(effect(() => this.showChrome(doc)));
    this.preview.textContent = doc.initialText.split("\n", PREVIEW_LINES).join("\n");
    this.store.add(effect(() => this.showModel(doc.model.value !== null)));
    void editors.ensureEngine().catch((err: unknown) => console.error(err));
  }

  private showModel(ready: boolean): undefined {
    const engine = this.host.editors.loadedEngine;
    const model = this.doc?.model.peek() ?? null;
    if (!ready || !engine) {
      this.editor?.setDocument(null);
      return undefined;
    }
    if (!this.editor) {
      const editor = engine.createEditor(this.engineHost);
      this.editor = editor;
      this.store.add(editor);
      this.store.add(editor.onDidFocus(() => this.host.onActivity(this)));
      this.store.add(
        editor.onDidChangeCursor(() => {
          this.host.onActivity(this);
          this.cursorMoved();
          this.recordPosition();
        }),
      );
      // A file opened again goes back to where it was (D190), unless a line was asked for.
      const saved = this.doc ? this.host.positions.get(this.doc.path.peek()) : undefined;
      if (saved && !this.pendingReveal) this.pendingPosition = saved;
      this.store.add(editor.onContextMenu((at) => this.host.contextMenu(this, at)));
      // A click on a change bar opens the file's changes at that line (D201: VS Code shows a
      // small peek there; the diff tab has stage / revert and next / previous already).
      this.store.add(
        editor.onChangeBarClick(({ line, staged }) => {
          const path = this.doc?.path.peek();
          if (!path || path.startsWith("virtual:")) return;
          // Its own tab (not a preview): the file's tab you clicked in stays open (D203).
          this.host.run(
            "editor.openDiff",
            staged
              ? { path, line, preview: false, staged: true }
              : { path, line, preview: false, fromChangeBar: true },
          );
        }),
      );
      editor.setFormatOverride(() => this.host.formatDocument(this));
      editor.setUndoOverride((how) => this.host.workspaceUndo(this, how));
    }
    this.engineHost.hidden = false;
    this.preview.hidden = true;
    this.editor.setForcedReadOnly(this.forcedReadOnly);
    this.editor.setSecretMask(this.secretMask);
    this.editor.setDocument(model);
    this.cursorMoved();
    if (this.visible) {
      this.editor.layout();
      this.applyPendingPosition();
    }
    if (this.pendingReveal && model) {
      this.editor.revealPosition(this.pendingReveal.line, this.pendingReveal.column);
      this.pendingReveal = undefined;
    }
    // Keep focus where the user expects it: if the preview had focus, hand it to Monaco.
    if (this.element.contains(document.activeElement) || document.activeElement === this.element)
      this.editor.focus();
    return undefined;
  }

  private pendingPosition: EditorPosition | undefined;
  private applyingPosition = false;

  /** The remembered spot, once the editor has a size (a background tab waits to be shown). */
  private applyPendingPosition(): void {
    const at = this.pendingPosition;
    const editor = this.engineEditor;
    if (!at || !editor || this.pendingReveal) return;
    this.pendingPosition = undefined;
    this.applyingPosition = true;
    try {
      const lines = this.doc?.model.peek()?.lineCount ?? at.line;
      editor.revealPosition(Math.min(at.line, lines), at.column);
      editor.scrollToLine(Math.min(at.top, Math.max(0, lines - 1)));
    } finally {
      this.applyingPosition = false;
    }
  }

  private recordPosition(): void {
    const editor = this.engineEditor;
    const doc = this.doc;
    if (!editor || !doc || this.applyingPosition || this.pendingPosition || !this.visible) return;
    if (doc.kind !== "text" || isUntitled(doc.path.peek())) return;
    const state = editor.activeState();
    if (!state) return;
    this.host.positions.set(doc.path.peek(), {
      top: Math.round(editor.scrollLine() * 100) / 100,
      line: state.cursor.line,
      column: state.cursor.column,
    });
  }

  /** Breadcrumbs and the file status bar, as the settings say; refreshed on text changes. */
  private showChrome(doc: EditorDocument): undefined {
    const crumbs = this.host.chrome.showBreadcrumbs() && doc.kind === "text";
    const status = this.host.chrome.showFileStatus() && doc.kind === "text";
    const model = doc.model.value;
    doc.path.value;
    const changed =
      this.crumbs.element.hidden === crumbs || this.fileStatus.element.hidden === status;
    this.crumbs.element.hidden = !crumbs;
    this.fileStatus.element.hidden = !status;
    if (!status) this.fileStatus.problems.hidden = true;
    this.chromeText?.dispose();
    this.chromeText = model?.onDidChangeContent(() => this.crumbs.textChanged());
    this.crumbs.textChanged();
    this.crumbs.render();
    this.fileStatus.update();
    if (changed && this.visible) queueMicrotask(() => this.editor?.layout());
    return undefined;
  }
  private chromeText: { dispose(): void } | undefined;

  /** The language changed (Change language mode): the status bar shows it. */
  refreshStatus(): void {
    this.fileStatus.update();
  }

  /** Cursor moved: the symbol path and Ln/Col follow. */
  private cursorMoved(): void {
    this.crumbs.render();
    this.fileStatus.update();
  }

  /** DESIGN.md §12.12 banner when the file changed or vanished on disk under unsaved edits. */
  private showDiskState(doc: EditorDocument): undefined {
    const state = doc.diskState.value;
    // A non-UTF-8 file opens read-only (saving would damage it): say why it can't be edited.
    this.banner.hidden = state === "ok" && !doc.notUtf8;
    if (state === "ok") {
      if (doc.notUtf8)
        replaceChildren(
          this.banner,
          icon("triangle-alert"),
          h(
            "span",
            { class: "banner-message" },
            doc.encoding === "utf8" || doc.encoding === "utf8bom"
              ? "This file isn't UTF-8 encoded, so it opened read-only: saving would damage its characters. Reopen it with its encoding (the encoding in the status bar) to edit it."
              : "This encoding can be read but not written here, so the file is read-only.",
          ),
          (() => {
            const b = h(
              "button",
              { class: "button button-secondary button-sm", type: "button" },
              "Reopen with encoding…",
            );
            b.addEventListener("click", () =>
              this.host.run("editor.reopenWithEncoding", { path: doc.path.peek() }),
            );
            return b;
          })(),
        );
      if (doc.notUtf8 && this.visible) queueMicrotask(() => this.editor?.layout());
      return undefined;
    }
    const button = (label: string, command: string, primary = false) => {
      const b = h(
        "button",
        {
          class: `button ${primary ? "button-primary" : "button-secondary"} button-sm`,
          type: "button",
        },
        label,
      );
      b.addEventListener("click", () => this.host.run(command, { path: doc.path.peek() }));
      return b;
    };
    replaceChildren(
      this.banner,
      icon("triangle-alert"),
      h(
        "span",
        { class: "banner-message" },
        state === "changed"
          ? "This file changed on disk, and you have unsaved changes."
          : "This file was deleted on disk. Save to create it again.",
      ),
      state === "changed" ? button("Reload", "editor.reloadFromDisk", true) : null,
      button(state === "changed" ? "Keep my changes" : "Dismiss", "editor.keepLocalChanges"),
    );
    if (this.visible) queueMicrotask(() => this.editor?.layout());
    return undefined;
  }

  private showNotice(
    title: string,
    detail: string,
    action?: { label: string; run: () => void },
  ): void {
    this.preview.hidden = true;
    this.engineHost.hidden = true;
    const close = h("button", { class: "button button-secondary", type: "button" }, "Close tab");
    this.store.add(on(close, "click", () => this.ctx.close()));
    const primary = action
      ? h("button", { class: "button button-primary", type: "button" }, action.label)
      : null;
    if (primary && action) this.store.add(on(primary, "click", action.run));
    this.notice.replaceChildren(
      icon("file"),
      h("div", { class: "empty-state-title" }, title),
      h("div", { class: "empty-state-text" }, detail),
      primary ? h("div", { class: "empty-state-actions" }, primary, close) : close,
    );
    this.notice.hidden = false;
  }

  /** Reveals line:column now, or as soon as the engine shows the document. */
  revealPosition(line: number, column = 1): void {
    this.pendingPosition = undefined; // a line asked for wins over the remembered spot
    if (this.engineEditor) this.engineEditor.revealPosition(line, column);
    else this.pendingReveal = { line, column };
  }
  private pendingReveal: { line: number; column: number } | undefined;

  /** The engine editor, once Monaco shows this document. */
  get engineEditor(): EngineEditor | undefined {
    return this.doc?.model.peek() ? this.editor : undefined;
  }

  title(): string {
    return this.doc ? documentName(this.doc) : basename(this.path);
  }

  isDirty(): boolean {
    return this.doc?.dirty.peek() ?? false;
  }

  /** The last tab showing a dirty document asks Save / Don't save / Cancel. */
  async confirmClose(): Promise<boolean> {
    const doc = this.doc;
    if (!doc || doc.refs > 1) return true;
    return this.host.editors.confirmDiscard(doc);
  }

  onShow(): void {
    this.visible = true;
    this.editor?.layout();
    this.applyPendingPosition();
  }

  onHide(): void {
    this.visible = false;
  }

  onResize(): void {
    if (this.visible) this.editor?.layout();
  }

  focus(): void {
    if (this.engineEditor) this.engineEditor.focus();
    else this.element.focus();
    this.host.onActivity(this);
  }

  serialize(): Json {
    return { path: this.path };
  }

  persist(): boolean {
    return !this.path.startsWith("virtual:");
  }

  dispose(): void {
    this.chromeText?.dispose();
    this.store.dispose();
  }
}
