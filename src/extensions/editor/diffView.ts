// The diff tab (`diff` dock view): a file against its git base, side by side (also: against its
// saved version, another file, a local-history version or an agent's proposal — D113). Working-tree diffs
// show index ↔ the file (the right side is the shared, editable document: edits and saves work as
// in its editor tab); staged diffs show HEAD ↔ index (read-only). The toolbar stages, unstages or
// reverts the change at the cursor, or the whole file. Command: editor.openDiff.

import type { Json } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { Emitter } from "../../core/events/index";
import { fsIpc, historyIpc } from "../../core/ipc/fs";
import { DisposableStore } from "../../core/lifecycle/index";
import { JUPYTER_NOTEBOOK, type NotebookType } from "../../core/notebook/providers";
import { basename, isAbsolute, samePath } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { fileIconTint } from "../../ui/fileTint";
import { fileIcon, type IconName, icon } from "../../ui/Icon";
import { showContextMenu } from "../../ui/Menu";
import { setTooltip } from "../../ui/Tooltip";
import type { DockView, DockViewContext, DockViewDescriptor } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { diffToggleItems } from "./diffSettings";
import type { EngineDiffEditor, EngineDocument } from "./engine";
import { diffNotebooks, notebookDiffElement } from "./notebook/diff";
import type { EditorDocument, EditorService } from "./service";

interface DiffState {
  path: string;
  staged: boolean;
  /** Proposed changes of agent session `agent` (file ↔ proposal) instead of git. */
  agent?: string;
  /** A local-history snapshot id (snapshot ↔ file) instead of git, and its label. */
  version?: string;
  versionLabel?: string;
  /** The file's saved version ↔ the open document (unsaved changes). */
  saved?: boolean;
  /** Another file ↔ this one (Compare with selected). */
  against?: string;
  /** A content provider (quickDiff.registerContent scheme) for the left side ↔ the file (D120). */
  base?: string;
  baseLabel?: string;
  /** A content provider for the right side too (read-only): a commit's change is git:<parent> ↔ git:<commit> (D137). */
  head?: string;
  headLabel?: string;
  /** Open at this line of the right side (a click on a change bar, D201); not saved. */
  line?: number;
}

function readState(state: Json): DiffState {
  const o = (state ?? {}) as {
    path?: unknown;
    staged?: unknown;
    agent?: unknown;
    version?: unknown;
    versionLabel?: unknown;
    saved?: unknown;
    against?: unknown;
    base?: unknown;
    baseLabel?: unknown;
    head?: unknown;
    headLabel?: unknown;
    line?: unknown;
  };
  return {
    ...(typeof o.line === "number" && o.line > 0 && { line: Math.floor(o.line) }),
    ...(o.saved === true && { saved: true }),
    ...(typeof o.against === "string" && { against: o.against }),
    path: typeof o.path === "string" ? o.path : "",
    staged: o.staged === true,
    ...(typeof o.agent === "string" && { agent: o.agent }),
    ...(typeof o.version === "string" && { version: o.version }),
    ...(typeof o.versionLabel === "string" && { versionLabel: o.versionLabel }),
    ...(typeof o.base === "string" && { base: o.base }),
    ...(typeof o.baseLabel === "string" && { baseLabel: o.baseLabel }),
    ...(typeof o.head === "string" && { head: o.head }),
    ...(typeof o.headLabel === "string" && { headLabel: o.headLabel }),
  };
}

const kindLabel = (st: DiffState) =>
  st.head
    ? (st.headLabel ?? "commit")
    : st.base
      ? (st.baseLabel ?? "changes")
      : st.saved
        ? "unsaved"
        : st.against
          ? `↔ ${basename(st.against)}`
          : st.version
            ? (st.versionLabel ?? "history")
            : st.agent
              ? "proposed"
              : st.staged
                ? "staged"
                : "working tree";

class DiffView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly changed = this.store.add(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  private readonly host: HTMLElement;
  private readonly count: HTMLElement;
  private diff: EngineDiffEditor | undefined;
  private original: EngineDocument | undefined;
  private indexCopy: EngineDocument | undefined;
  private doc: EditorDocument | undefined;
  private visible = false;
  private readonly state: DiffState;
  private loadToken = 0;
  /** A notebook's cell-by-cell diff (D189), shown instead of the JSON one unless switched. */
  private cellsPanel: HTMLElement | null = null;
  private nbToggle: HTMLElement | null = null;
  private showCells = true;
  /** A line to show once the diff is computed (D201). */
  private pendingLine: number | null = null;
  /** A notebook's format (D202): its cells are compared. */
  private notebookType: NotebookType | null = null;
  private cellsToken = 0;
  /** The diff was computed at least once (a reveal can happen now). */
  private computed = false;

  /** Shows `line` of the right side (now, or once the diff is computed). */
  revealLine(line: number): void {
    if (this.diff && this.computed) this.diff.revealModifiedLine(line);
    else this.pendingLine = line;
  }

  constructor(
    state: Json,
    private readonly ctx: DockViewContext,
    private readonly services: WorkbenchServices,
    private readonly editors: EditorService,
  ) {
    this.state = readState(state);
    this.pendingLine = this.state.line ?? null;
    const { staged, agent } = this.state;
    this.count = h("span", { class: "diff-count" });
    const button = (name: IconName, title: string, run: () => void) => {
      const b = h("button", { class: "icon-button", type: "button" }, icon(name));
      setTooltip(b, title);
      this.store.add(on(b, "click", run));
      return b;
    };
    // Inline or side by side, whitespace, collapsed regions (D200).
    const more = () => {
      const b = button("ellipsis", "Diff view options", () => {
        const r = b.getBoundingClientRect();
        this.store.add(showContextMenu(r.left, r.bottom + 2, diffToggleItems(this.services)));
      });
      return b;
    };
    const atCursor = (command: string) => () => {
      const line = this.diff?.modifiedLine();
      if (line) this.run(command, { path: this.state.path, line });
    };
    const agentAt = (action: "accept" | "reject", line: boolean) => () => {
      const at = line ? this.diff?.modifiedLine() : undefined;
      if (line && !at) return;
      this.run("agent.reviewChange", {
        session: agent,
        path: this.state.path,
        action,
        ...(at && { line: at }),
      });
    };
    const agentBar = () =>
      h(
        "div",
        { class: "diff-toolbar" },
        h("span", { class: "diff-label" }, "Agent's proposal (file ↔ proposed)"),
        this.count,
        h("span", { class: "diff-spacer" }),
        button("arrow-up", "Previous change", () => this.diff?.goToChange("previous")),
        button("arrow-down", "Next change", () => this.diff?.goToChange("next")),
        more(),
        button("undo-2", "Reject change at cursor", agentAt("reject", true)),
        button("check", "Accept change at cursor", agentAt("accept", true)),
        button("circle-x", "Reject file", agentAt("reject", false)),
        button("circle-check", "Accept file", agentAt("accept", false)),
      );
    const gitBar = () =>
      h(
        "div",
        { class: "diff-toolbar" },
        h(
          "span",
          { class: "diff-label" },
          staged ? "Staged (HEAD ↔ index)" : "Working tree (index ↔ file)",
        ),
        this.count,
        h("span", { class: "diff-spacer" }),
        button("arrow-up", "Previous change", () => this.diff?.goToChange("previous")),
        button("arrow-down", "Next change", () => this.diff?.goToChange("next")),
        more(),
        staged
          ? button("minus", "Unstage change at cursor", atCursor("git.unstageChange"))
          : button("plus", "Stage change at cursor", atCursor("git.stageChange")),
        staged ? null : button("undo-2", "Revert change at cursor", atCursor("git.revertChange")),
        staged
          ? button("circle-x", "Unstage file", () =>
              this.run("git.unstage", { paths: [this.state.path] }),
            )
          : button("check", "Stage file", () =>
              this.run("git.stage", { paths: [this.state.path] }),
            ),
        button("file", "Open file", () => this.run("editor.openFile", { path: this.state.path })),
      );
    const historyBar = () =>
      h(
        "div",
        { class: "diff-toolbar" },
        h(
          "span",
          { class: "diff-label" },
          `Local history: ${this.state.versionLabel ?? "version"} ↔ file`,
        ),
        this.count,
        h("span", { class: "diff-spacer" }),
        button("arrow-up", "Previous change", () => this.diff?.goToChange("previous")),
        button("arrow-down", "Next change", () => this.diff?.goToChange("next")),
        more(),
        button("history", "Restore this version", () =>
          this.run("history.restore", { path: this.state.path, id: this.state.version }),
        ),
        button("file", "Open file", () => this.run("editor.openFile", { path: this.state.path })),
      );
    const fileBar = () =>
      h(
        "div",
        { class: "diff-toolbar" },
        h(
          "span",
          { class: "diff-label" },
          this.state.saved
            ? "Saved ↔ unsaved changes"
            : `${basename(this.state.against ?? "")} ↔ ${basename(this.state.path)}`,
        ),
        this.count,
        h("span", { class: "diff-spacer" }),
        button("arrow-up", "Previous change", () => this.diff?.goToChange("previous")),
        button("arrow-down", "Next change", () => this.diff?.goToChange("next")),
        more(),
        this.state.saved
          ? button("undo-2", "Revert to saved", () =>
              this.run("editor.reloadFromDisk", { path: this.state.path }),
            )
          : button("arrow-left-right", "Swap sides", () =>
              this.run("editor.compareFiles", {
                path: this.state.against,
                against: this.state.path,
              }),
            ),
        button("file", "Open file", () => this.run("editor.openFile", { path: this.state.path })),
      );
    const commitBar = () =>
      h(
        "div",
        { class: "diff-toolbar" },
        h(
          "span",
          { class: "diff-label" },
          // Two labelled sides that aren't a commit (Testing's expected ↔ actual): just the labels.
          this.state.head && !this.state.head.startsWith("git:") && this.state.baseLabel
            ? `${this.state.baseLabel} ↔ ${this.state.headLabel ?? "right"}`
            : `${this.state.headLabel ?? "Commit"} (${this.state.baseLabel ?? "parent"} ↔ commit)`,
        ),
        this.count,
        h("span", { class: "diff-spacer" }),
        button("arrow-up", "Previous change", () => this.diff?.goToChange("previous")),
        button("arrow-down", "Next change", () => this.diff?.goToChange("next")),
        more(),
        button("file", "Open file", () => this.run("editor.openFile", { path: this.state.path })),
      );
    const toolbar = this.state.head
      ? commitBar()
      : this.state.saved || this.state.against
        ? fileBar()
        : this.state.version
          ? historyBar()
          : agent
            ? agentBar()
            : gitBar();
    this.host = h("div", { class: "diff-engine" });
    this.element = h("div", { class: "editor-view diff-view", tabindex: "-1" }, toolbar, this.host);
    // Notebooks (D189): cell by cell by default; the file's text diff is one click away. Any
    // notebook type with a serializer (D202: an extension's too).
    const nbType = services.notebooks.typeFor(this.state.path);
    // Only a format its files open in by default (an extension's that isn't stays text).
    this.notebookType = nbType?.opensByDefault ? nbType : null;
    if (this.notebookType) {
      this.cellsPanel = h("div", { class: "nbd-host" });
      const toggle = h(
        "button",
        { class: "button button-ghost button-sm diff-nb-toggle", type: "button" },
        this.sourceLabel(),
      );
      this.nbToggle = toggle;
      setTooltip(toggle, "Switch between the cell-by-cell diff and the notebook file's JSON");
      this.store.add(
        on(toggle, "click", () => {
          this.showCells = !this.showCells;
          toggle.textContent = this.showCells ? this.sourceLabel() : "Show cells";
          this.applyMode();
        }),
      );
      toolbar.append(toggle);
      this.element.append(this.cellsPanel);
      this.applyMode();
    }
    this.store.add(services.quickDiff.onDidChange(() => void this.loadBase()));
    // Saved / other-file bases change when a file is saved.
    if (this.state.saved || this.state.against)
      this.store.add(editors.onDidSave(() => void this.loadBase()));
    void this.init();
  }

  private async init(): Promise<void> {
    const engine = await this.editors.ensureEngine();
    if (this.store.isDisposed) return;
    const diff = engine.createDiffEditor(this.host);
    this.diff = diff;
    this.store.add(diff);
    this.store.add(
      diff.onDidUpdateDiff(() => {
        this.showCount();
        this.computed = true;
        // Opened from a change bar: to that line once the diff is there (D201).
        if (this.pendingLine !== null) {
          diff.revealModifiedLine(this.pendingLine);
          this.pendingLine = null;
        }
        // Typed in the right side: the cells follow.
        if (this.cellsPanel && this.original) {
          const modified =
            this.state.staged || this.state.agent || this.state.head
              ? this.indexCopy
              : (this.doc?.model.peek() ?? this.indexCopy);
          void this.renderCells(this.original.getText(), modified?.getText() ?? "");
        }
      }),
    );
    if (this.state.agent || this.state.head) {
      await this.loadBase();
    } else if (!this.state.staged) {
      try {
        const doc =
          this.editors.find(this.state.path) ?? (await this.editors.load(this.state.path));
        if (this.store.isDisposed) return;
        this.doc = doc;
        this.editors.retain(doc);
        this.store.add({ dispose: () => this.editors.release(doc) });
        this.store.add(
          effect(() => {
            // Editing in the diff keeps a preview tab open, like an editor tab.
            if (doc.dirty.value) queueMicrotask(() => doc.dirty.peek() && this.ctx.pin());
            this.changed.fire();
            return undefined;
          }),
        );
        this.store.add(
          effect(() => {
            doc.model.value;
            void this.loadBase();
            return undefined;
          }),
        );
      } catch {
        // Deleted file: compare against an empty text.
        await this.loadBase();
      }
    } else {
      await this.loadBase();
    }
    if (this.visible) diff.layout();
  }

  /** (Re)loads the base side (and the index copy for staged diffs). */
  private async loadBase(): Promise<void> {
    const engine = this.editors.loadedEngine;
    if (!engine || !this.diff) return;
    const token = ++this.loadToken;
    const { path, staged, agent, version, saved, against, base: scheme, head } = this.state;
    const disk = (p: string) =>
      fsIpc
        .read(p)
        .then((b) => new TextDecoder().decode(b))
        .catch(() => "");
    const [base, index] = head
      ? await Promise.all([
          scheme ? this.services.quickDiff.content(scheme, path) : Promise.resolve(null),
          this.services.quickDiff.content(head, path),
        ])
      : scheme
        ? [await this.services.quickDiff.content(scheme, path), null]
        : saved
          ? [await disk(path), null]
          : against
            ? [this.editors.find(against)?.model.peek()?.getText() ?? (await disk(against)), null]
            : version
              ? [
                  await historyIpc
                    .read(path, version)
                    .then((b) => new TextDecoder().decode(b))
                    .catch(() => ""),
                  null,
                ]
              : agent
                ? await Promise.all([
                    this.services.quickDiff.content("disk", path),
                    this.services.quickDiff.content(`agent:${agent}`, path),
                  ])
                : await Promise.all([
                    this.services.quickDiff.original(path, staged ? "head" : "index"),
                    staged
                      ? this.services.quickDiff.original(path, "index")
                      : Promise.resolve(null),
                  ]);
    if (token !== this.loadToken || this.store.isDisposed) return;
    const strip = (t: string | null) => (t ?? "").replace(/^﻿/, "");
    if (
      this.original &&
      this.original.getText() === strip(base) &&
      !staged &&
      this.doc?.model.peek()
    )
      return this.attach();
    // New models first, shown, then the old ones disposed: disposing models the diff editor
    // still shows makes Monaco throw and the view flicker.
    const oldOriginal = this.original;
    const oldIndexCopy = staged || agent || head ? this.indexCopy : undefined;
    this.original = engine.createDocument(path, strip(base), { readOnly: true, scheme: "git" });
    if (staged || agent || head)
      this.indexCopy = engine.createDocument(path, strip(index), {
        readOnly: true,
        scheme: "git-index",
      });
    this.attach();
    oldOriginal?.dispose();
    oldIndexCopy?.dispose();
  }

  private attach(): void {
    const modified =
      this.state.staged || this.state.agent || this.state.head
        ? this.indexCopy
        : this.doc?.model.peek();
    if (!this.diff || !this.original) return;
    if (!modified) {
      // Deleted in the working tree: show the base against nothing.
      const engine = this.editors.loadedEngine;
      if (!engine) return;
      this.indexCopy ??= engine.createDocument(this.state.path, "", {
        readOnly: true,
        scheme: "git-empty",
      });
      this.diff.setDocuments(this.original, this.indexCopy);
      void this.renderCells(this.original.getText(), "");
      return;
    }
    this.diff.setDocuments(this.original, modified);
    void this.renderCells(this.original.getText(), modified.getText());
  }

  /** The file's own text: JSON for Jupyter notebooks, another format's text otherwise. */
  private sourceLabel(): string {
    return this.notebookType?.id === JUPYTER_NOTEBOOK ? "Show JSON" : "Show text";
  }

  private applyMode(): void {
    if (!this.cellsPanel) return;
    if (this.nbToggle)
      this.nbToggle.textContent = this.showCells ? this.sourceLabel() : "Show cells";
    this.cellsPanel.hidden = !this.showCells;
    this.host.hidden = this.showCells;
    if (!this.showCells && this.visible) queueMicrotask(() => this.diff?.layout());
  }

  /** The notebook's cells compared (both sides parsed; a side that doesn't parse says so). */
  private async renderCells(before: string, after: string): Promise<void> {
    const panel = this.cellsPanel;
    // Looked up again by id: an extension that reloaded has a new serializer.
    const type = this.notebookType ? this.services.notebooks.type(this.notebookType.id) : undefined;
    if (!panel || !type) return;
    const token = ++this.cellsToken;
    try {
      const [a, b] = await Promise.all([
        type.serializer.deserialize(before),
        type.serializer.deserialize(after),
      ]);
      if (this.store.isDisposed || token !== this.cellsToken) return;
      const diff = diffNotebooks(a, b);
      const left = this.state.head
        ? (this.state.baseLabel ?? "parent")
        : this.state.version
          ? (this.state.versionLabel ?? "version")
          : this.state.agent
            ? "file"
            : this.state.saved
              ? "saved"
              : this.state.staged
                ? "HEAD"
                : this.state.against
                  ? basename(this.state.against)
                  : "index";
      const right = this.state.head
        ? (this.state.headLabel ?? "commit")
        : this.state.agent
          ? "proposal"
          : this.state.staged
            ? "index"
            : "file";
      panel.replaceChildren(notebookDiffElement(diff, { before: left, after: right }));
    } catch (err) {
      panel.replaceChildren(
        h(
          "div",
          { class: "nbd-error" },
          `The cells can't be compared (${err instanceof Error ? err.message : String(err)}): showing the JSON.`,
        ),
      );
      this.showCells = false;
      this.applyMode();
    }
  }

  private showCount(): void {
    const n = this.diff?.changeCount() ?? 0;
    this.count.textContent = n === 0 ? "No changes" : `${n} change${n === 1 ? "" : "s"}`;
  }

  private run(command: string, input: unknown): void {
    void this.services.dispatcher.execute(command, input).catch(() => {});
  }

  title(): string {
    return `${basename(this.state.path)} (${kindLabel(this.state)})`;
  }

  isDirty(): boolean {
    return this.doc?.dirty.peek() ?? false;
  }

  /** Same rule as editor tabs: the last tab showing a dirty document asks first. */
  async confirmClose(): Promise<boolean> {
    const doc = this.doc;
    if (!doc || doc.refs > 1) return true;
    return this.editors.confirmDiscard(doc);
  }

  onShow(): void {
    this.visible = true;
    this.diff?.layout();
  }
  onHide(): void {
    this.visible = false;
  }
  onResize(): void {
    if (this.visible) this.diff?.layout();
  }
  focus(): void {
    if (this.diff) this.diff.focus();
    else this.element.focus();
  }
  serialize(): Json {
    return {
      path: this.state.path,
      staged: this.state.staged,
      ...(this.state.agent && { agent: this.state.agent }),
      ...(this.state.version && { version: this.state.version }),
      ...(this.state.versionLabel && { versionLabel: this.state.versionLabel }),
      ...(this.state.saved && { saved: true }),
      ...(this.state.against && { against: this.state.against }),
      ...(this.state.base && { base: this.state.base }),
      ...(this.state.baseLabel && { baseLabel: this.state.baseLabel }),
      ...(this.state.head && { head: this.state.head }),
      ...(this.state.headLabel && { headLabel: this.state.headLabel }),
    };
  }

  dispose(): void {
    this.store.dispose();
    this.original?.dispose();
    this.indexCopy?.dispose();
  }
}

export function registerDiffView(
  sub: DisposableStore,
  services: WorkbenchServices,
  editors: EditorService,
): void {
  const { dock, dispatcher, workspace } = services;
  const descriptor: DockViewDescriptor = {
    type: "diff",
    title: (state) => `${basename(readState(state).path)} (${kindLabel(readState(state))})`,
    icon: (state) => fileIcon(basename(readState(state).path)),
    tint: (state) => fileIconTint(basename(readState(state).path)),
    resource: (state) => readState(state).path || undefined,
    tooltip: (state) => {
      const st = readState(state);
      if (st.saved) return `${st.path} · Saved ↔ unsaved changes`;
      if (st.against) return `${st.against} ↔ ${st.path}`;
      if (st.base) return `${st.path} · ${st.baseLabel ?? "Changes"}`;
      return `${st.path} · ${st.version ? `Local history (${st.versionLabel ?? "version"})` : st.agent ? "Agent's proposed changes" : st.staged ? "Staged changes" : "Working tree changes"}`;
    },
    defaultPlacement: "main",
    editorLike: true,
    create: (state, ctx) => new DiffView(state, ctx, services, editors),
  };
  sub.add(dock.views.register(descriptor));

  sub.add(
    dispatcher.register({
      id: "editor.openDiff",
      title: "Open changes",
      category: "Git",
      description:
        "Opens a side-by-side diff of a file against git: working-tree changes (index ↔ file, editable) or, with `staged`, staged changes (HEAD ↔ index). Reuses an open diff tab of the same file and kind.",
      input: s.object({
        path: s
          .string()
          .describe(
            "File path, absolute or relative to the workspace root (with several folders, may start with a folder's name)",
          ),
        staged: s
          .boolean()
          .describe("Show staged changes instead of working-tree changes")
          .optional(),
        agent: s.string().describe("Agent session id: its proposed changes to the file").optional(),
        version: s
          .string()
          .describe("Local-history snapshot id (history.list): that version ↔ file")
          .optional(),
        versionLabel: s.string().describe("Label for the snapshot in the title").optional(),
        base: s
          .string()
          .describe("Content source for the left side (e.g. agentBefore:<session>) ↔ the file")
          .optional(),
        baseLabel: s.string().describe("Label for that side in the title").optional(),
        head: s
          .string()
          .describe("Content source for the right side too, read-only (e.g. git:<commit>)")
          .optional(),
        headLabel: s.string().describe("Label for the right side").optional(),
        preserveFocus: s.boolean().describe("Keep keyboard focus where it is").optional(),
        preview: s.boolean().describe("Open as a preview tab").optional(),
        line: s.number().describe("Show this line of the right side (1-based)").optional(),
        fromChangeBar: s
          .boolean()
          .describe("Compare with what the change bars compare with (git.quickDiffBase)")
          .optional(),
      }),
      effects: [],
      when: "workspaceOpen",
      agent: "discoverable",
      run: async ({
        path,
        staged,
        agent,
        version,
        versionLabel,
        base,
        baseLabel,
        head,
        headLabel,
        preserveFocus,
        preview,
        line,
        fromChangeBar,
      }) => {
        // A change bar's diff has the bars' base: HEAD or the merge base when set so (D201).
        const barBase = fromChangeBar ? services.settings.peek<string>("git.quickDiffBase") : null;
        if ((barBase === "head" || barBase === "mergeBase") && !base && !agent && !version) {
          base = `quickDiffBase:${barBase}`;
          baseLabel = barBase === "head" ? "HEAD" : "Merge base";
        }
        const target = workspace.resolve(path);
        const kind = staged ?? false;
        const existing = dock.tabs("diff").find((t) => {
          const st = readState(t.viewState);
          return (
            samePath(st.path, target) &&
            st.staged === kind &&
            st.agent === agent &&
            st.version === version &&
            st.base === base &&
            st.head === head
          );
        });
        if (existing) {
          dock.activateTab(existing.id, !preserveFocus);
          if (!preview && existing.preview) dock.pinTab(existing.id);
          if (line) (dock.liveView(existing.id) as DiffView | undefined)?.revealLine?.(line);
          return { tabId: existing.id };
        }
        const focused = dock.focusedGroup();
        const group = focused?.tabs.some(dock.isEditorLike) ? focused.id : undefined;
        const tabId = dock.openView(
          "diff",
          {
            path: target,
            staged: kind,
            ...(agent && { agent }),
            ...(version && { version }),
            ...(versionLabel && { versionLabel }),
            ...(base && { base }),
            ...(baseLabel && { baseLabel }),
            ...(head && { head }),
            ...(headLabel && { headLabel }),
            ...(line && { line }),
          },
          group ? { groupId: group } : "main",
          !preserveFocus,
          { preview: preview ?? false },
        );
        return { tabId };
      },
    }),
  );

  /** Opens (or reveals) a diff tab for `state`. */
  const openFileDiff = (state: DiffState): string => {
    const existing = dock.tabs("diff").find((t) => {
      const st = readState(t.viewState);
      return (
        samePath(st.path, state.path) &&
        st.saved === state.saved &&
        (st.against ?? "") === (state.against ?? "")
      );
    });
    if (existing) {
      dock.activateTab(existing.id, true);
      return existing.id;
    }
    const focused = dock.focusedGroup();
    const group = focused?.tabs.some(dock.isEditorLike) ? focused.id : undefined;
    return dock.openView(
      "diff",
      { ...state, staged: false } as unknown as Json,
      group ? { groupId: group } : "main",
      true,
    );
  };
  const activePath = (): string | undefined => {
    const tab = dock.activeTab() ?? dock.recentTab((t) => t.viewType === "editor");
    const p = (tab?.viewState as { path?: unknown } | null)?.path;
    return typeof p === "string" ? p : undefined;
  };
  sub.add(
    dispatcher.register({
      id: "editor.compareWithSaved",
      title: "Compare with saved",
      category: "File",
      description:
        "Shows a file's unsaved changes: its saved version ↔ the open document (editable; default: the active editor).",
      input: s.object({ path: s.string().optional() }),
      effects: [],
      when: "workspaceOpen",
      run: ({ path }) => {
        const target = path ? workspace.resolve(path) : activePath();
        if (!target) throw new Error("No file is open.");
        return { tabId: openFileDiff({ path: target, staged: false, saved: true }) };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "editor.compareFiles",
      title: "Compare files",
      category: "File",
      description:
        "Shows two files side by side: `against` (left) ↔ `path` (right, editable). Without a folder open (`<cli> --diff a b`), both paths are absolute.",
      input: s.object({ path: s.string(), against: s.string() }),
      effects: [],
      run: ({ path, against }) => {
        const root = workspace.root.peek() ?? "";
        // No folder (the command line's --diff, D209 leftovers): files the user named, absolute.
        if (!root && !(isAbsolute(path) && isAbsolute(against)))
          throw new Error("Open a folder first, or pass absolute paths.");
        return {
          tabId: openFileDiff({
            path: workspace.resolve(path),
            staged: false,
            against: workspace.resolve(against),
          }),
        };
      },
    }),
  );
}
