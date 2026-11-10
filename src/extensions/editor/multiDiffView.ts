// The multi-file diff tab (`multiDiff` dock view, D229; VS Code's multi-diff editor): one
// scrollable tab with a collapsible diff per changed file. Each file's diff editor is created as
// it scrolls near the view and let go when it's far away (its height is kept, so the scrollbar
// doesn't jump); unchanged regions are folded and each diff is as tall as its content, so the
// page scrolls, not the editors. Working-tree files show the shared document on the right
// (editable, as in the diff tab); staged files HEAD ↔ index; commits and ranges two content
// sources (git:<rev>). Source control opens it for "View all changes", a commit's "Open
// changes" and the Graph's Incoming / Outgoing rows. Commands: editor.openMultiDiff (its
// `background` updates an open tab without activating it: source control's changes tabs follow
// the status that way, D233), editor.multiDiff.collapseAll / expandAll and nextFile /
// previousFile (Ctrl+Alt+PageDown / PageUp, `activeMultiDiff`). A new list of files keeps the
// file at the top of the view, folds, unsaved edits and the focus. State: ide://editor/multiDiffs.

import type { Json } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { Emitter } from "../../core/events/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { basename, dirname } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { fileIcon, type IconName, icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import type { DockView, DockViewContext, DockViewDescriptor } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import type { EditorEngine, EngineDiffEditor, EngineDocument } from "./engine";
import {
  adjacentFile,
  entryKey,
  entryKind,
  filesLabel,
  isEditable,
  type MultiDiffEntry,
  type MultiDiffState,
  placeholderHeight,
  readMultiDiffState,
  sameDiffFiles,
  scrollAnchor,
} from "./multiDiff";
import type { EditorDocument, EditorService } from "./service";

const VIEW_TYPE = "multiDiff";
const LINE_HEIGHT = 19;
/** How far outside the view a file's diff editor is created (and kept). */
const KEEP_MARGIN = "800px 0px";

const STATUS_COLORS: Record<string, string> = {
  M: "--git-modified-fg",
  T: "--git-modified-fg",
  A: "--diff-added-fg",
  U: "--diff-added-fg",
  R: "--diff-added-fg",
  C: "--diff-added-fg",
  D: "--diff-removed-fg",
};

/** One file: its header and, while near the view, its diff editor. */
class FileSection {
  readonly element: HTMLElement;
  readonly body: HTMLElement;
  private readonly host: HTMLElement;
  private readonly note: HTMLElement;
  private chevron: SVGSVGElement;
  private readonly store = new DisposableStore();
  /** The live editor and what it shows (while mounted). */
  private live: DisposableStore | null = null;
  private diff: EngineDiffEditor | undefined;
  private original: EngineDocument | undefined;
  private copy: EngineDocument | undefined;
  doc: EditorDocument | undefined;
  private measured: number | undefined;
  private lines: number | undefined;
  private loadToken = 0;
  collapsed: boolean;

  constructor(
    readonly entry: MultiDiffEntry,
    private readonly owner: MultiDiffView,
    collapsed: boolean,
  ) {
    this.collapsed = collapsed;
    const name = basename(entry.path);
    // With several folders, the folder's name first (D251).
    const rel = owner.services.workspace.relative(entry.path) || entry.path;
    const dir = rel.includes("/") ? dirname(rel) : "";
    this.chevron = icon(collapsed ? "chevron-right" : "chevron-down");
    const color = entry.status ? STATUS_COLORS[entry.status] : undefined;
    const button = (glyph: IconName, title: string, run: () => void) => {
      const b = h(
        "button",
        { class: "icon-button", type: "button", "aria-label": title },
        icon(glyph),
      );
      setTooltip(b, title);
      this.store.add(
        on(b, "click", (e) => {
          e.stopPropagation();
          run();
        }),
      );
      return b;
    };
    const header = h(
      "div",
      {
        class: "multi-diff-header",
        role: "button",
        tabindex: "0",
        "aria-expanded": collapsed ? "false" : "true",
      },
      this.chevron,
      icon(fileIcon(name)),
      h(
        "span",
        { class: "multi-diff-name", style: color ? { color: `var(${color})` } : undefined },
        name,
      ),
      h(
        "span",
        { class: "multi-diff-dir" },
        entry.from ? `${dir}${dir ? " " : ""}← ${entry.from}` : dir,
      ),
      h("span", { class: "multi-diff-spacer" }),
      button("git-compare", "Open changes in a diff tab", () => owner.openSingle(entry)),
      entry.status !== "D" || entry.head
        ? button("file", "Open file", () =>
            owner.run("editor.openFile", { path: entry.path, preview: false }),
          )
        : null,
      entry.status
        ? h(
            "span",
            { class: "scm-badge", style: color ? { color: `var(${color})` } : undefined },
            entry.status,
          )
        : null,
    );
    setTooltip(header, `${rel}${entry.from ? ` (renamed from ${entry.from})` : ""}`, undefined, {
      ariaLabel: false,
    });
    this.store.add(on(header, "click", () => owner.toggle(this)));
    this.store.add(
      on(header, "keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          owner.toggle(this);
        }
      }),
    );
    this.host = h("div", { class: "multi-diff-editor" });
    this.note = h("div", { class: "multi-diff-note", hidden: true });
    this.body = h("div", { class: "multi-diff-body", hidden: collapsed }, this.note, this.host);
    this.element = h(
      "section",
      { class: "multi-diff-file", "data-path": entry.path },
      header,
      this.body,
    );
    this.setHeight();
  }

  get mounted(): boolean {
    return this.live !== null;
  }

  /** Dirty edits keep a working-tree file's editor (letting it go would drop nothing, but the caret). */
  get dirty(): boolean {
    return this.doc?.dirty.peek() ?? false;
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.body.hidden = collapsed;
    const chevron = icon(collapsed ? "chevron-right" : "chevron-down");
    this.chevron.replaceWith(chevron);
    this.chevron = chevron;
    this.element
      .querySelector(".multi-diff-header")
      ?.setAttribute("aria-expanded", collapsed ? "false" : "true");
    if (collapsed && !this.dirty) this.unmount();
  }

  private setHeight(): void {
    const height = placeholderHeight(this.measured, this.lines, LINE_HEIGHT);
    this.host.style.height = `${height}px`;
  }

  async mount(engine: EditorEngine): Promise<void> {
    if (this.live || this.collapsed) return;
    const live = new DisposableStore();
    this.live = live;
    const diff = engine.createDiffEditor(this.host, { embedded: true });
    this.diff = diff;
    live.add(diff);
    // The content height counts once the diff has folded the unchanged regions: before that it's
    // the whole file's, and the page would jump.
    let computed = false;
    const follow = () => {
      if (!computed) return;
      const height = diff.contentHeight();
      if (height <= 0 || height === this.measured) return;
      this.measured = height;
      this.setHeight();
    };
    live.add(diff.onDidChangeContentHeight(follow));
    live.add(
      diff.onDidUpdateDiff(() => {
        computed = true;
        follow();
      }),
    );
    live.add(diff.onDidFocus(() => this.owner.focusedSection(this)));
    if (isEditable(this.entry)) {
      try {
        const editors = this.owner.editors;
        const doc = editors.find(this.entry.path) ?? (await editors.load(this.entry.path));
        if (this.live !== live) return;
        if (doc.kind !== "text") throw new Error("binary");
        this.doc = doc;
        editors.retain(doc);
        live.add({
          dispose: () => {
            editors.release(doc);
            if (this.doc === doc) this.doc = undefined;
          },
        });
        live.add(
          effect(() => {
            doc.dirty.value;
            this.owner.changed();
            return undefined;
          }),
        );
        live.add(
          effect(() => {
            doc.model.value;
            void this.load();
            return undefined;
          }),
        );
        return;
      } catch (err) {
        if (this.live !== live) return;
        if (err instanceof Error && err.message === "binary") {
          this.showNote("A binary file: its changes can't be shown as text.");
          return;
        }
        // Gone from disk: compared with an empty text.
      }
    }
    await this.load();
  }

  /** (Re)reads the sides (the base changes after a stage, a commit, a checkout). */
  async load(): Promise<void> {
    const engine = this.owner.editors.loadedEngine;
    const diff = this.diff;
    if (!engine || !diff) return;
    const token = ++this.loadToken;
    const { path, base: baseSource, head } = this.entry;
    const qd = this.owner.services.quickDiff;
    const kind = entryKind(this.entry);
    const [base, right] =
      kind === "range"
        ? await Promise.all([
            baseSource ? qd.content(baseSource, path) : Promise.resolve(null),
            qd.content(head ?? "", path),
          ])
        : kind === "staged"
          ? await Promise.all([qd.original(path, "head"), qd.original(path, "index")])
          : [await (baseSource ? qd.content(baseSource, path) : qd.original(path, "index")), null];
    if (token !== this.loadToken || !this.live) return;
    const strip = (t: string | null) => (t ?? "").replace(/^﻿/, "");
    const before = strip(base);
    const shared = kind === "working" ? this.doc?.model.peek() : undefined;
    const after = shared ? null : strip(right);
    this.lines = Math.max(
      before.split("\n").length,
      (shared?.getText() ?? after ?? "").split("\n").length,
    );
    if (this.measured === undefined) this.setHeight();
    // New models first, shown, then the old ones disposed (Monaco throws on disposed models).
    const oldOriginal = this.original;
    const oldCopy = this.copy;
    this.original = engine.createDocument(path, before, { readOnly: true, scheme: "git" });
    this.copy = shared
      ? undefined
      : engine.createDocument(path, after ?? "", { readOnly: true, scheme: "git-index" });
    diff.setDocuments(this.original, shared ?? this.copy ?? null);
    oldOriginal?.dispose();
    oldCopy?.dispose();
  }

  private showNote(text: string): void {
    this.note.textContent = text;
    this.note.hidden = false;
    this.host.hidden = true;
  }

  /** Lets the editor go (scrolled far away, folded, or the tab closed); its height stays. */
  unmount(): void {
    if (!this.live) return;
    const live = this.live;
    this.live = null;
    this.loadToken++;
    live.dispose();
    this.diff = undefined;
    this.original?.dispose();
    this.copy?.dispose();
    this.original = undefined;
    this.copy = undefined;
    this.host.replaceChildren();
  }

  /** The diff's change count (null until mounted and computed). */
  changes(): number | null {
    return this.diff ? this.diff.changeCount() : null;
  }

  focus(): void {
    this.diff?.focus();
  }

  dispose(): void {
    this.unmount();
    this.store.dispose();
  }
}

export class MultiDiffView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly changedEmitter = this.store.add(new Emitter<void>());
  readonly onDidChange = this.changedEmitter.event;
  private readonly list: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly label: HTMLElement;
  private readonly count: HTMLElement;
  private readonly refreshButton: HTMLElement;
  private sections: FileSection[] = [];
  private observer: IntersectionObserver | undefined;
  private readonly near = new Set<FileSection>();
  private visible = false;
  private state: MultiDiffState;
  private lastFocused: FileSection | undefined;

  constructor(
    state: Json,
    private readonly ctx: DockViewContext,
    readonly services: WorkbenchServices,
    readonly editors: EditorService,
    live: Set<MultiDiffView>,
  ) {
    this.state = readMultiDiffState(state);
    this.label = h("span", { class: "diff-label" });
    this.count = h("span", { class: "diff-count" });
    const button = (glyph: IconName, title: string, command: string) => {
      const b = h(
        "button",
        { class: "icon-button", type: "button", "aria-label": title },
        icon(glyph),
      );
      setTooltip(b, title, command);
      this.store.add(on(b, "click", () => this.run(command, { tabId: this.ctx.tabId })));
      return b;
    };
    this.refreshButton = h(
      "button",
      { class: "icon-button", type: "button", "aria-label": "Refresh" },
      icon("refresh-cw"),
    );
    setTooltip(this.refreshButton, "Refresh (list the changed files again)");
    this.store.add(
      on(this.refreshButton, "click", () => {
        const r = this.state.refresh;
        if (r) this.run(r.command, r.input ?? {});
      }),
    );
    const toolbar = h(
      "div",
      { class: "diff-toolbar" },
      this.label,
      this.count,
      h("span", { class: "diff-spacer" }),
      button("list-collapse", "Collapse all", "editor.multiDiff.collapseAll"),
      button("list-chevrons-up-down", "Expand all", "editor.multiDiff.expandAll"),
      this.refreshButton,
    );
    this.list = h("div", { class: "multi-diff-list" });
    this.scroller = h("div", { class: "multi-diff-scroll" }, this.list);
    this.element = h(
      "div",
      { class: "editor-view multi-diff-view", tabindex: "-1" },
      toolbar,
      this.scroller,
    );
    // Stage, unstage, commit, checkout: the git sides change.
    this.store.add(
      services.quickDiff.onDidChange(() => {
        for (const sec of this.sections)
          if (sec.mounted && entryKind(sec.entry) !== "range") void sec.load();
      }),
    );
    live.add(this);
    this.store.add({ dispose: () => live.delete(this) });
    this.render();
  }

  /**
   * A new list of files for the same source (Refresh, opened again, or a status it follows). The
   * file at the top of the view stays there, folded files stay folded, a file's editor keeps its
   * unsaved edits and caret, and the focus stays where it was.
   */
  setState(state: MultiDiffState): void {
    // A tab in the background has no layout: no place to keep.
    const before = this.scroller.clientHeight > 0 ? this.offsets() : null;
    const anchor =
      before &&
      scrollAnchor(
        before.sections.map((sec) => entryKey(sec.entry)),
        before.tops,
        this.scroller.scrollTop,
      );
    const active = document.activeElement;
    const hadFocus = active instanceof HTMLElement && this.element.contains(active);
    // Files folded before stay folded.
    const keys = new Set(state.files.map(entryKey));
    this.state = { ...state, collapsed: this.collapsedPaths().filter((k) => keys.has(k)) };
    this.render();
    if (anchor) {
      const after = this.offsets();
      const top = after.tops[after.sections.findIndex((sec) => entryKey(sec.entry) === anchor.key)];
      if (top !== undefined) this.scroller.scrollTop = top + anchor.offset;
    }
    // Moving the sections back into the list takes the focus from an editor in them.
    if (hadFocus && active.isConnected && document.activeElement !== active)
      active.focus({ preventScroll: true });
    this.ctx.updateState(this.serialize());
    this.changedEmitter.fire();
    this.syncMounted(false);
  }

  /** Whether the tab lists `files` (in order) under `title` now. */
  shows(files: readonly MultiDiffEntry[], title: string): boolean {
    return this.state.title === title && sameDiffFiles(this.state.files, files);
  }

  /** The file sections and their offsets in the scrolled content. */
  private offsets(): { sections: FileSection[]; tops: number[] } {
    const base = this.scroller.getBoundingClientRect().top - this.scroller.scrollTop;
    return {
      sections: this.sections,
      tops: this.sections.map((sec) => sec.element.getBoundingClientRect().top - base),
    };
  }

  /** The file Next / Previous file last went to (the focus may not have followed). */
  private visited: number | undefined;

  /**
   * Scrolls to the next (1) or previous (-1) file and focuses its header: from the focused file
   * (or the one last gone to, while it's in view), else from the top of the view. Null at the
   * end.
   */
  goToFile(direction: 1 | -1): { file: string | null; index?: number; files: number } {
    const { sections, tops } = this.offsets();
    const { scrollTop, clientHeight } = this.scroller;
    let current = sections.findIndex((sec) => sec.element.contains(document.activeElement));
    // The focus went elsewhere (or never came: a window in the background): the file last gone
    // to, while it's still in view (short lists don't scroll to it).
    const last = this.visited;
    const lastTop = last === undefined ? undefined : tops[last];
    const inView =
      lastTop !== undefined && lastTop >= scrollTop - 1 && lastTop < scrollTop + clientHeight;
    if (current < 0 && last !== undefined && inView) current = last;
    const at = adjacentFile(tops, scrollTop, current, direction);
    const sec = at === null ? undefined : sections[at];
    if (at === null || !sec) return { file: null, files: sections.length };
    this.visited = at;
    this.scroller.scrollTop = tops[at] ?? 0;
    sec.element.querySelector<HTMLElement>(".multi-diff-header")?.focus({ preventScroll: true });
    return {
      file: this.services.workspace.relative(sec.entry.path) || sec.entry.path,
      index: at,
      files: sections.length,
    };
  }

  private collapsedPaths(): string[] {
    return this.sections.filter((s) => s.collapsed).map((s) => entryKey(s.entry));
  }

  private render(): void {
    this.observer?.disconnect();
    this.near.clear();
    const collapsed = new Set(this.state.collapsed ?? []);
    // A file listed again with the same sides keeps its section (its editor, unsaved edits and
    // caret); the others are let go.
    const before = new Map(this.sections.map((sec) => [JSON.stringify(sec.entry), sec]));
    this.sections = this.state.files.map((entry) => {
      const key = JSON.stringify(entry);
      const kept = before.get(key);
      if (kept) {
        before.delete(key);
        return kept;
      }
      return new FileSection(entry, this, collapsed.has(entryKey(entry)));
    });
    for (const sec of before.values()) {
      if (sec === this.lastFocused) this.lastFocused = undefined;
      sec.dispose();
    }
    this.label.textContent = this.state.title;
    this.count.textContent = filesLabel(this.state.files.length);
    this.refreshButton.hidden = !this.state.refresh;
    if (!this.sections.length)
      this.list.replaceChildren(
        h("div", { class: "empty-state-text multi-diff-empty" }, "There are no changes to show."),
      );
    else this.list.replaceChildren(...this.sections.map((sec) => sec.element));
    const bySection = new Map(this.sections.map((sec) => [sec.body, sec]));
    this.observer = new IntersectionObserver(
      (records) => {
        for (const r of records) {
          const sec = bySection.get(r.target as HTMLElement);
          if (!sec) continue;
          if (r.isIntersecting) this.near.add(sec);
          else this.near.delete(sec);
        }
        this.syncMounted();
      },
      { root: this.scroller, rootMargin: KEEP_MARGIN },
    );
    for (const sec of this.sections) this.observer.observe(sec.body);
  }

  /**
   * Editors for the files near the view; the others let go (unless they hold unsaved edits or
   * the caret). `release` false: only create (the tab was just shown and the observer hasn't
   * reported what's near yet).
   */
  private syncMounted(release = true): void {
    if (!this.visible || this.store.isDisposed) return;
    void this.editors.ensureEngine().then((engine) => {
      if (this.store.isDisposed || !this.visible) return;
      for (const sec of this.sections) {
        if (this.near.has(sec) && !sec.collapsed) void sec.mount(engine);
        else if (release && sec.mounted && !sec.dirty && sec !== this.lastFocused) sec.unmount();
      }
    });
  }

  toggle(sec: FileSection): void {
    sec.setCollapsed(!sec.collapsed);
    this.ctx.updateState(this.serialize());
    this.syncMounted();
  }

  setAllCollapsed(collapsed: boolean): void {
    for (const sec of this.sections) if (sec.collapsed !== collapsed) sec.setCollapsed(collapsed);
    this.ctx.updateState(this.serialize());
    this.syncMounted();
  }

  focusedSection(sec: FileSection): void {
    this.lastFocused = sec;
  }

  changed(): void {
    this.changedEmitter.fire();
  }

  /** The file's diff in a diff tab of its own (the same two sides). */
  openSingle(entry: MultiDiffEntry): void {
    const kind = entryKind(entry);
    this.run("editor.openDiff", {
      path: entry.path,
      ...(kind === "staged" && { staged: true }),
      ...(entry.base && { base: entry.base }),
      ...(entry.head && { head: entry.head, headLabel: this.state.title }),
      preview: false,
    });
  }

  run(command: string, input: unknown = {}): void {
    void this.services.dispatcher.execute(command, input).catch(() => {});
  }

  describe(): {
    tabId: string;
    title: string;
    source: string | null;
    files: {
      path: string;
      status: string | null;
      collapsed: boolean;
      shown: boolean;
      changes: number | null;
    }[];
  } {
    const { workspace } = this.services;
    return {
      tabId: this.ctx.tabId,
      title: this.state.title,
      source: this.state.source ?? null,
      files: this.sections.map((sec) => ({
        path: workspace.relative(sec.entry.path) || sec.entry.path,
        status: sec.entry.status ?? null,
        collapsed: sec.collapsed,
        shown: sec.mounted,
        changes: sec.changes(),
      })),
    };
  }

  isDirty(): boolean {
    return this.sections.some((sec) => sec.dirty);
  }

  /** As the diff tab: the last tab showing a dirty document asks first. */
  async confirmClose(): Promise<boolean> {
    for (const sec of this.sections) {
      const doc = sec.doc;
      if (!doc || doc.refs > 1 || !doc.dirty.peek()) continue;
      if (!(await this.editors.confirmDiscard(doc))) return false;
    }
    return true;
  }

  onShow(): void {
    this.visible = true;
    this.syncMounted(false);
  }
  onHide(): void {
    this.visible = false;
  }
  focus(): void {
    if (this.lastFocused?.mounted) this.lastFocused.focus();
    else this.element.focus();
  }
  serialize(): Json {
    const collapsed = this.collapsedPaths();
    return {
      title: this.state.title,
      ...(this.state.source && { source: this.state.source }),
      ...(this.state.refresh && { refresh: this.state.refresh as unknown as Json }),
      files: this.state.files as unknown as Json,
      ...(collapsed.length && { collapsed }),
    } as Json;
  }

  dispose(): void {
    this.observer?.disconnect();
    for (const sec of this.sections) sec.dispose();
    this.sections = [];
    this.store.dispose();
  }
}

export function registerMultiDiffView(
  sub: DisposableStore,
  services: WorkbenchServices,
  editors: EditorService,
): void {
  const { dock, dispatcher, workspace, state } = services;
  const live = new Set<MultiDiffView>();
  const descriptor: DockViewDescriptor = {
    type: VIEW_TYPE,
    title: (st) => readMultiDiffState(st).title,
    icon: () => "git-compare",
    tooltip: (st) => {
      const read = readMultiDiffState(st);
      return `${read.title} · ${filesLabel(read.files.length)}`;
    },
    defaultPlacement: "main",
    editorLike: true,
    create: (st, ctx) => new MultiDiffView(st, ctx, services, editors, live),
  };
  sub.add(dock.views.register(descriptor));

  const viewFor = (tabId: string | undefined): MultiDiffView => {
    const id = tabId ?? dock.activeTab()?.id ?? dock.recentTab((t) => t.viewType === VIEW_TYPE)?.id;
    const view = id ? dock.liveView(id) : undefined;
    if (view instanceof MultiDiffView) return view;
    const any = [...live][0];
    if (!tabId && any) return any;
    throw new Error("No multi-file diff is open.");
  };

  const fileSchema = s.object({
    path: s.string().describe("File (absolute or workspace-relative)"),
    status: s.string().describe("Status letter shown in its header (M, A, D, R…)").optional(),
    from: s.string().describe("Renames: the old path").optional(),
    staged: s.boolean().describe("Staged changes (HEAD ↔ index)").optional(),
    base: s.string().describe("Content source for the left side (e.g. git:<rev>)").optional(),
    head: s
      .string()
      .describe("Content source for the right side, read-only (e.g. git:<rev>)")
      .optional(),
  });
  sub.add(
    dispatcher.register({
      id: "editor.openMultiDiff",
      title: "Open changes of several files",
      category: "Git",
      description:
        "Opens a multi-file diff tab (VS Code's multi-diff editor): one scrollable tab with a collapsible diff per file. Each file is working tree (index ↔ file, editable), `staged` (HEAD ↔ index) or two content sources (`base` ↔ `head`, e.g. git:<parent> ↔ git:<commit>). `source` names what it shows: opening the same source again reuses the tab and lists the files again. Source control's View all changes, a commit's Open changes and the Graph's Incoming / Outgoing rows open it.",
      input: s.object({
        title: s.string().describe("The tab's title"),
        files: s.array(fileSchema),
        source: s
          .string()
          .describe("What the tab shows (reuses a tab of the same source)")
          .optional(),
        refresh: s
          .object({ command: s.string(), input: s.unknown().optional() })
          .describe("The command its Refresh button runs (it reopens the same source)")
          .optional(),
        preserveFocus: s.boolean().optional(),
        background: s
          .boolean()
          .describe(
            "Only update a tab already open for `source`, without activating it or taking the focus (a list that follows a status: source control's changes tabs). Nothing opens when there's none; an unchanged list is left alone.",
          )
          .optional(),
      }),
      effects: [],
      when: "workspaceOpen",
      agent: "discoverable",
      run: async ({ title, files, source, refresh, preserveFocus, background }) => {
        const next = readMultiDiffState({
          title,
          ...(source && { source }),
          ...(refresh && { refresh: refresh as unknown as Json }),
          files: files.map((f) => ({ ...f, path: workspace.resolve(f.path) })) as unknown as Json,
        });
        const existing = source
          ? dock.tabs(VIEW_TYPE).find((t) => readMultiDiffState(t.viewState).source === source)
          : undefined;
        if (background) {
          if (!source) throw new Error("`background` needs a `source`.");
          if (!existing) return { tabId: null, files: next.files.length, updated: false };
          const view = dock.liveView(existing.id);
          // Not created yet (restored, never shown): it reads its saved list when it is, and the
          // caller asks again (source control follows the dock's changes).
          if (!(view instanceof MultiDiffView) || view.shows(next.files, next.title))
            return { tabId: existing.id, files: next.files.length, updated: false };
          view.setState(next);
          return { tabId: existing.id, files: next.files.length, updated: true };
        }
        if (existing) {
          const view = dock.liveView(existing.id);
          if (view instanceof MultiDiffView) view.setState(next);
          dock.activateTab(existing.id, !preserveFocus);
          return { tabId: existing.id, files: next.files.length };
        }
        const focused = dock.focusedGroup();
        const group = focused?.tabs.some(dock.isEditorLike) ? focused.id : undefined;
        const tabId = dock.openView(
          VIEW_TYPE,
          next as unknown as Json,
          group ? { groupId: group } : "main",
          !preserveFocus,
        );
        return { tabId, files: next.files.length };
      },
    }),
  );
  for (const [id, title, collapsed] of [
    ["editor.multiDiff.collapseAll", "Collapse all files in the multi-file diff", true],
    ["editor.multiDiff.expandAll", "Expand all files in the multi-file diff", false],
  ] as const)
    sub.add(
      dispatcher.register({
        id,
        title,
        category: "Git",
        description: `${collapsed ? "Folds" : "Unfolds"} every file of a multi-file diff tab (default: the active one).`,
        input: s.object({ tabId: s.string().optional() }),
        effects: [],
        run: async ({ tabId }) => {
          const view = viewFor(tabId);
          view.setAllCollapsed(collapsed);
          return view.describe();
        },
      }),
    );
  // Next / previous file (VS Code's multi-diff editor keys, Ctrl+Alt+PageDown / PageUp).
  for (const [id, title, direction] of [
    ["editor.multiDiff.nextFile", "Go to the next file in the multi-file diff", 1],
    ["editor.multiDiff.previousFile", "Go to the previous file in the multi-file diff", -1],
  ] as const)
    sub.add(
      dispatcher.register({
        id,
        title,
        category: "Git",
        description: `Scrolls a multi-file diff tab (default: the active one, else the last one used) to the ${direction === 1 ? "next" : "previous"} file and focuses its header (VS Code's multi-diff editor): from the focused file (or the one it last went to, while in view), else from the top of the view. Returns the file it went to, workspace-relative (null at the ${direction === 1 ? "end" : "start"}).`,
        input: s.object({ tabId: s.string().describe("The multi-file diff tab").optional() }),
        effects: [],
        run: async ({ tabId }) => {
          const tab = tabId
            ? dock.tabs(VIEW_TYPE).find((t) => t.id === tabId)
            : dock.activeTab()?.viewType === VIEW_TYPE
              ? dock.activeTab()
              : dock.recentTab((t) => t.viewType === VIEW_TYPE);
          if (!tab) throw new Error("No multi-file diff is open.");
          if (dock.activeTab()?.id !== tab.id) dock.activateTab(tab.id, false);
          const view = dock.liveView(tab.id);
          if (!(view instanceof MultiDiffView))
            throw new Error("The multi-file diff isn't shown yet.");
          return view.goToFile(direction);
        },
      }),
    );
  // `activeMultiDiff`: the active tab is a multi-file diff (its keys).
  sub.add(
    effect(() => {
      dock.root.value;
      dock.focusedGroupId.value;
      services.context.set("activeMultiDiff", dock.activeTab()?.viewType === VIEW_TYPE);
      return undefined;
    }),
  );
  sub.add(
    state.register("ide://editor/multiDiffs", {
      description:
        "Open multi-file diff tabs: title, source, and per file its path, status, whether it's folded, whether its diff editor exists now (it's created near the view) and its change count once computed.",
      get: () => [...live].map((v) => v.describe()),
    }),
  );
}
