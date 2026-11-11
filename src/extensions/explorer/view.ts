// The explorer view: a lazy, virtualized tree of the workspace folder that refreshes from
// watcher batches. All actions (open, create, rename, delete, cut/copy/paste, move by dragging)
// go through dispatcher commands. Rows: multi-select, focused row, cut and drop-target states,
// indent guides and tinted file icons (DESIGN.md §12.4); the active editor is revealed.
// A multi-root workspace (D251): the tree's hidden root is the workspace, its rows the folders
// (each with its own files.exclude, its own drop and reveal scope); the header is the workspace's.
import { h, on, replaceChildren } from "../../core/dom/index";
import { type DirEntry, fsChanges, fsIpc, type WatchBatch, watchIpc } from "../../core/ipc/fs";
import {
  type Disposable,
  DisposableStore,
  MutableDisposable,
  toDisposable,
} from "../../core/lifecycle/index";
import { isExcluded } from "../../core/paths/glob";
import {
  basename,
  dirname,
  isAbsolute,
  isWithin,
  pathKey,
  relativePath,
} from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { fileIcon, fileIconThemeInfo, folderIcon, icon, themedIconsVersion } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import { eventClosest, Tree } from "../../ui/Tree";
import type { WorkbenchServices } from "../../workbench/services";
import type { ExplorerClipboard } from "./clipboard";
import { ExplorerFindBar } from "./findBar";
import { InlineEdit } from "./inlineEdit";
import { nestFiles, nestingRules, withNestedFiles } from "./nesting";
import { armTreeMove } from "./treeMove";
import { openExplorerMenu, showExplorerMoreMenu } from "./viewMenus";
import { treeChanged } from "./workspaceFolders";

/** Row height follows the density token (`--size-row`, DESIGN.md §5.2). */
function rowHeight(): number {
  const v = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--size-row"),
  );
  return Number.isFinite(v) && v > 0 ? v : 24;
}

/**
 * A listed entry; a compact folder row (D122) carries the folders it stands for, outermost first;
 * a file with nested files (explorer.fileNesting, D201) carries them.
 */
type Entry = DirEntry & { segments?: string[]; nested?: DirEntry[] };

const nestedOf = (e: DirEntry): DirEntry[] | undefined =>
  e.kind === "dir" ? undefined : (e as Entry).nested;

/** The tree's hidden root in a multi-root workspace (D251): its children are the folders. */
const WORKSPACE_ROOT = "\u0000workspace";

const NESTING_KEYS = [
  "explorer.fileNesting.enabled",
  "explorer.fileNesting.expand",
  "explorer.fileNesting.patterns",
];

/** Folders with more subfolders than this aren't looked into for compaction (one listing each). */
const COMPACT_LOOKAHEAD = 100;
const COMPACT_DEPTH = 32;

export class ExplorerView implements Disposable {
  readonly store = new DisposableStore();
  private readonly scope = this.store.add(new MutableDisposable<DisposableStore>());
  private readonly body: HTMLElement;
  private readonly findBar: ExplorerFindBar;
  private readonly empty: HTMLElement;
  tree: Tree<DirEntry> | undefined;
  /** Folders to re-expand when the tree is (re)created; set by state restore. */
  pendingExpanded: string[] = [];
  private rowHeight = 0;
  /** Whether the current tree is a multi-root one (its hidden root the workspace, not a folder). */
  private treeIsMulti = false;
  /** Cut or copied paths (explorer.cut / explorer.copy); cut rows render dimmed. */
  clipboard: ExplorerClipboard | null = null;
  private cutKeys = new Set<string>();
  private dropTarget: string | null = null;
  /** Inline rename / new item input. */
  readonly inline = new InlineEdit(
    () => this.tree,
    // A multi-root workspace's folders are rows: there's no hidden folder (D251).
    () => (this.services.workspace.isMultiRoot() ? null : this.services.workspace.root.peek()),
  );
  private lastRevealed = "";
  /** Folder inside a compact row → that row's id (its innermost folder), for refreshes. */
  private compactOf = new Map<string, string>();
  /** A nested file → the file it's listed under (explorer.fileNesting), for reveal. */
  private nestedIn = new Map<string, string>();
  /**
   * Files listed with nested files → those files' paths (the parents' ids are in the tree's
   * expanded ids, not folders).
   */
  private nestParents = new Map<string, string[]>();

  constructor(
    host: HTMLElement,
    readonly services: WorkbenchServices,
  ) {
    const openButton = h(
      "button",
      { class: "button button-primary", type: "button" },
      "Open folder",
    );
    const cloneButton = h(
      "button",
      { class: "button button-secondary", type: "button" },
      "Clone repository",
    );
    this.empty = h(
      "div",
      { class: "empty-state" },
      h("span", { class: "empty-state-icon" }, icon("folder")),
      h("div", { class: "empty-state-title" }, "No folder open"),
      h("div", { class: "empty-state-text" }, "Open a folder to browse its files."),
      h("div", { class: "empty-state-actions" }, openButton, cloneButton),
    );
    this.body = h("div", { class: "explorer-tree" });
    this.findBar = this.store.add(
      new ExplorerFindBar(() => this.tree as unknown as Tree<unknown> | undefined),
    );
    host.append(this.empty, this.findBar.element, this.body);
    this.store.add(toDisposable(() => host.replaceChildren()));
    this.store.add(toDisposable(() => clearTimeout(this.springTimer)));
    // Space in the explorer outside the rows and the root header (below a short tree) is the
    // root too: a click clears the selection, a right-click opens the root's menu (VS Code).
    // By the event's path, not the target: the tree's mousedown may already have re-rendered
    // the row and detached the target (a right-click on a file's name opened the root's menu, and
    // Ctrl/Shift+click lost the selection, D226).
    const outside = (e: MouseEvent) => {
      const path = e.composedPath();
      const tree = this.tree?.element;
      return !path.some(
        (n) => n === tree || (n instanceof Element && n.classList.contains("explorer-root")),
      );
    };
    this.store.add(
      on(this.body, "mousedown", (e) => {
        if (e.button === 0 && outside(e)) this.tree?.clearSelection();
      }),
    );
    this.store.add(
      on(this.body, "contextmenu", (e) => {
        if (!outside(e) || !this.tree) return;
        e.preventDefault();
        this.tree.clearSelection();
        this.showMenu(null, e.clientX, e.clientY);
      }),
    );
    this.store.add(on(openButton, "click", () => this.run("workspace.openFolder")));
    this.store.add(on(cloneButton, "click", () => this.run("git.clone", { open: true })));
    this.store.add(
      effect(() => {
        const root = services.workspace.root.value;
        this.empty.hidden = root !== null;
        this.body.hidden = root === null;
        return undefined;
      }),
    );
    // Load after the workspace's saved state (expanded folders) has been restored.
    this.store.add(services.workspace.onDidOpen((root) => void this.load(root)));
    this.store.add(services.workspace.onDidClose(() => void this.load(null)));
    // Folders added or taken out (D251): the tree is built again, keeping what was open, with
    // the added folders open.
    this.store.add(
      services.workspace.onDidChangeFolders(({ added }) => {
        const root = services.workspace.root.peek();
        if (!root) return;
        // A single folder's tree had that folder as its hidden (always open) root, so it isn't
        // among the expanded ids: it stays open as the first row of the workspace.
        const wasRoot = this.tree && !this.treeIsMulti ? [root] : [];
        this.pendingExpanded = [
          ...wasRoot,
          ...(this.tree?.expandedIds() ?? []),
          ...added.map((f) => f.path),
        ];
        void this.load(root);
      }),
    );
    const current = services.workspace.root.peek();
    if (current) void this.load(current);
    this.store.add(
      effect(() => {
        services.dock.root.value;
        services.dock.focusedGroupId.value;
        queueMicrotask(() => this.autoReveal());
        return undefined;
      }),
    );
    // Git colors and badges; the folder icons setting.
    this.store.add(
      effect(() => {
        services.decorations.revision.value;
        services.settings.watch("explorer.folderIcons").value;
        themedIconsVersion.value;
        this.tree?.rerender();
        return undefined;
      }),
    );
    // Density changes the row height: rebuild the tree, keeping expanded folders.
    this.store.add(
      services.theme.onDidChange(() => {
        const root = services.workspace.root.peek();
        if (!root || !this.tree || rowHeight() === this.rowHeight) return;
        this.pendingExpanded = this.tree.expandedIds();
        void this.load(root);
      }),
    );
  }

  focus(): void {
    this.tree?.focus();
  }

  setClipboard(clip: ExplorerClipboard | null): void {
    this.clipboard = clip;
    this.cutKeys = new Set(clip?.mode === "cut" ? clip.paths.map(pathKey) : []);
    this.tree?.rerender();
  }

  /** Whether a multi-root workspace is shown (its folders are the top rows, D251). */
  multiRoot(): boolean {
    return this.services.workspace.isMultiRoot();
  }

  /** The workspace folder holding `path` (the first folder when none does). */
  folderFor(path: string): string | null {
    return this.services.workspace.folderOf(path)?.path ?? this.services.workspace.root.peek();
  }

  /** Whether `entry` is one of a multi-root workspace's folders (a top row). */
  isFolderRow(entry: DirEntry | null | undefined): boolean {
    return (
      !!entry &&
      this.multiRoot() &&
      this.services.workspace.folders.peek().some((f) => pathKey(f.path) === pathKey(entry.path))
    );
  }

  /** The workspace's folders as the top rows of a multi-root tree. */
  private folderEntries(): DirEntry[] {
    return this.services.workspace.folders.peek().map((f) => ({
      name: f.name,
      path: f.path,
      kind: "dir",
      isSymlink: false,
      ignored: false,
    }));
  }

  /** Highlights where dragged rows or files from the OS would land (null clears). */
  setDropTarget(dir: string | null): void {
    if (dir === this.dropTarget) return;
    this.dropTarget = dir;
    const root = this.services.workspace.root.peek();
    // A multi-root workspace has no one folder below its rows: its folder rows light up instead.
    const isRoot =
      dir !== null && root !== null && !this.multiRoot() && pathKey(dir) === pathKey(root);
    this.tree?.element.classList.toggle("is-drop-root", isRoot);
    this.body.classList.toggle("is-drop-root", isRoot);
    this.tree?.rerender();
  }

  /** The folder a drop at client (x, y) goes into: a folder row, a file's folder, or the root. */
  dropFolderAt(x: number, y: number): string | null {
    const tree = this.tree;
    if (!tree) return null;
    // The header and empty space are the folder's in a single-folder window; a multi-root
    // workspace's header stands for the workspace, which holds no files itself (D251).
    const rootDrop = this.multiRoot() ? null : this.services.workspace.root.peek();
    const header = this.body.querySelector(".explorer-root")?.getBoundingClientRect();
    if (header && x >= header.left && x <= header.right && y >= header.top && y <= header.bottom)
      return rootDrop;
    const entry = tree.itemAtPoint(x, y);
    if (entry === undefined) return null;
    if (entry && this.inline.isPlaceholder(entry)) return null;
    return entry ? (entry.kind === "dir" ? entry.path : dirname(entry.path)) : rootDrop;
  }

  private springDir: string | null = null;
  private springTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Files dragged in from the OS: highlights the target folder, and a collapsed folder the
   * pointer rests on opens after a moment (as when moving rows inside the tree). null = left.
   */
  osDragOver(at: { x: number; y: number } | null): void {
    const tree = this.tree;
    const entry = at && tree ? tree.itemAtPoint(at.x, at.y) : undefined;
    this.setDropTarget(at ? this.dropFolderAt(at.x, at.y) : null);
    const dir = entry?.kind === "dir" && tree && !tree.isExpanded(entry.path) ? entry.path : null;
    if (dir === this.springDir) return;
    this.springDir = dir;
    clearTimeout(this.springTimer);
    if (dir && tree) this.springTimer = setTimeout(() => void tree.expand(dir), 600);
  }

  /** True when an inline input can be shown (the explorer is the visible sidebar view). */
  canEditInline(): boolean {
    return (
      !!this.tree &&
      this.services.views.active.peek() === "explorer.view" &&
      this.services.layout.sidebarVisible.peek() &&
      this.body.isConnected
    );
  }

  /**
   * The folder's own row above the tree (VS Code's root section): name and collapse; the actions
   * live in the view header (new file / new folder / collapse / ⋯). Also a drop target.
   */
  private rootHeader(root: string, tree: Tree<DirEntry>): HTMLElement {
    // A multi-root workspace's header is the workspace ("App (Workspace)"), D251.
    const workspaceFile = this.services.workspace.file.peek();
    const name = workspaceFile
      ? (this.services.workspace.name.peek() ?? root)
      : root
          .replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .pop() || root;
    const chevron = h("span", { class: "explorer-root-chevron" }, icon("chevron-down"));
    const header = h(
      "div",
      { class: "explorer-root", role: "button", tabindex: "-1", "aria-expanded": "true" },
      chevron,
      h("span", { class: "explorer-root-name" }, name),
    );
    setTooltip(header, workspaceFile ?? root, undefined, { placement: "right" });
    header.addEventListener("click", () => {
      // The root header stands for the folder itself: nothing below stays selected, so New file
      // and New folder go to the root.
      this.tree?.clearSelection();
      const collapsed = !this.body.classList.contains("is-root-collapsed");
      this.body.classList.toggle("is-root-collapsed", collapsed);
      header.setAttribute("aria-expanded", String(!collapsed));
      replaceChildren(chevron, icon(collapsed ? "chevron-right" : "chevron-down"));
      if (!collapsed) tree.rerender();
    });
    header.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.tree?.clearSelection();
      this.showMenu(null, e.clientX, e.clientY);
    });
    return header;
  }

  /** Opens the find bar (Ctrl+Alt+F), optionally with a query; returns how many rows match. */
  find(query?: string, filter?: boolean): number {
    return this.findBar.show(query, filter);
  }

  closeFind(): void {
    this.findBar.close();
  }

  /** Expands the folders leading to `path` and selects it (no focus change). */
  async revealPath(path: string): Promise<void> {
    // The folder that holds it: in a multi-root workspace, its row is the top of the chain (D251).
    const owner = this.services.workspace.folderOf(path)?.path;
    const tree = this.tree;
    if (!owner || !tree) return;
    const chain: string[] = [];
    for (
      let dir = dirname(path);
      isWithin(owner, dir) && pathKey(dir) !== pathKey(owner);
      dir = dirname(dir)
    )
      chain.unshift(dir);
    if (this.multiRoot()) chain.unshift(owner);
    // A folder made a moment ago (an extension's first file in the IDE's canvas folder) isn't listed yet:
    // its parent lists again first.
    for (const dir of chain) {
      if (!tree.has(dir)) await this.refresh([dirname(dir)]);
      await tree.expand(dir);
    }
    if (!tree.has(path)) await this.refresh([dirname(path)]);
    // A nested file: its parent file opens first.
    const nestParent = this.nestedIn.get(pathKey(path));
    // (Also when its row is known but folded away.)
    if (nestParent && !tree.isExpanded(nestParent)) await tree.expand(nestParent);
    tree.reveal(path);
  }

  /**
   * explorer.autoReveal: follow the active tab's file — an editor, or any tab that shows a file
   * (a canvas or another extension viewer, a preview, an image), by its view's `resource` (D186).
   * Followed on every switch of tab, so coming back to a file selects it again even when it was
   * the last one revealed (the selection may have moved in between).
   */
  private autoReveal(): void {
    const { dock, workspace, settings } = this.services;
    const tab = dock.activeTab();
    const descriptor = tab ? dock.descriptor(tab) : undefined;
    const state = tab ? (dock.liveView(tab.id)?.serialize() ?? tab.viewState) : null;
    const resource = tab && descriptor?.resource ? descriptor.resource(state) : undefined;
    const root = workspace.root.peek();
    const path = resource && root && !isAbsolute(resource) ? workspace.resolve(resource) : resource;
    const key = tab && path ? `${tab.id}\u0000${path}` : "";
    if (key === this.lastRevealed) return;
    // A tab with no file (the agent, a terminal) is remembered too: back on a file, it's revealed.
    const previous = this.lastRevealed;
    this.lastRevealed = key;
    if (!key) {
      // The file revealed for the tab before (now closed, or another tab took over) no longer
      // stays selected as if it were active (D190); a selection the user made is left alone.
      const was = previous.split("\u0000")[1];
      const selected = this.tree?.selection?.path;
      // Only for a tab of the editor area (focusing the terminal or the agent keeps it).
      const editorArea = !!tab && descriptor?.defaultPlacement === "main";
      if (editorArea && was && selected && pathKey(selected) === pathKey(was))
        this.tree?.clearSelection();
      return;
    }
    if (!root || !workspace.contains(path as string)) return;
    if (settings.peek<boolean>("explorer.autoReveal") === false) return;
    void this.revealPath(path as string);
  }

  /** Reloads directories whose listing may have changed. */
  async refresh(dirs?: readonly string[]): Promise<void> {
    const tree = this.tree;
    if (!tree) return;
    treeChanged.fire(dirs ?? this.services.workspace.folderPaths());
    if (!dirs) return tree.refresh();
    const targets = new Set<string>();
    for (const dir of dirs) {
      // A folder inside a compact row: its contents or its single child changed, so the row's
      // parent lists again (the chain may now break or grow), and the row itself.
      const row = this.compactOf.get(pathKey(dir));
      if (row) {
        targets.add(dirname(this.segmentsOf(row)[0] ?? row));
        targets.add(row);
      } else targets.add(dir);
    }
    // Together, one render (D379): a checkout or an install changes many folders at once.
    await tree.refreshMany(targets);
  }

  /** Innermost folders of the compact rows listed so far (explorer.compactFolders). */
  compactRows(): string[] {
    return [...new Set(this.compactOf.values())];
  }

  private segmentsOf(rowId: string): string[] {
    const out: string[] = [];
    for (const [k, v] of this.compactOf) if (v === rowId) out.push(k);
    return out;
  }

  /**
   * `paths` plus the files nested under any of them that is a collapsed nest parent (D203): what
   * delete, move, cut and copy of explorer rows act on, as in VS Code.
   */
  withNestedFiles(paths: readonly string[]): string[] {
    const tree = this.tree;
    if (!tree || !this.nestParents.size) return [...paths];
    return withNestedFiles(
      paths,
      (p) => this.nestParents.get(pathKey(p)),
      (p) => !tree.isExpanded(p),
    );
  }

  /** The folders the watcher follows: the root, expanded folders and folders in compact rows. */
  private watchedDirs(root: string, tree: Tree<DirEntry>): string[] {
    const segments = new Set<string>();
    for (const [segment, row] of this.compactOf)
      if (segment !== pathKey(row)) segments.add(segment);
    const folders = tree.expandedIds().filter((id) => !this.nestParents.has(pathKey(id)));
    // Every folder of a multi-root workspace (D251); never the hidden workspace row.
    const roots = this.multiRoot() ? this.services.workspace.folderPaths() : [root];
    return [
      ...roots,
      ...folders.filter((f) => f !== WORKSPACE_ROOT),
      ...this.segmentPaths(segments),
    ];
  }

  private compactPaths = new Map<string, string>();

  private segmentPaths(keys: Set<string>): string[] {
    return [...keys].map((k) => this.compactPaths.get(k) ?? k);
  }

  /**
   * VS Code's compact folders (explorer.compactFolders): a folder whose only visible entry is a
   * folder is shown as one row "a/b/c" standing for the innermost folder. Looks one listing
   * ahead per subfolder, and not at all in folders with many subfolders.
   */
  private async compact(entries: DirEntry[]): Promise<Entry[]> {
    const dirs = entries.filter((e) => e.kind === "dir");
    // A folder that started a compact row before may not any more (it got a second entry): its
    // old row is forgotten, else a change inside it would refresh that row instead of the folder.
    const forget = (dir: DirEntry) => {
      this.compactOf.delete(pathKey(dir.path));
      this.compactPaths.delete(pathKey(dir.path));
    };
    if (this.services.settings.peek<boolean>("explorer.compactFolders") === false) {
      for (const dir of dirs) forget(dir);
      return entries;
    }
    if (!dirs.length || dirs.length > COMPACT_LOOKAHEAD) {
      for (const dir of dirs) forget(dir);
      return entries;
    }
    const chains = await Promise.all(
      dirs.map(async (dir) => {
        const chain: DirEntry[] = [dir];
        for (let i = 0; i < COMPACT_DEPTH; i++) {
          const last = chain[chain.length - 1] as DirEntry;
          const inner = await fsIpc.listDir(last.path).catch(() => null);
          const visible = inner ? this.visibleEntries(last.path, inner) : [];
          const only = visible.length === 1 ? visible[0] : undefined;
          if (only?.kind !== "dir" || only.isSymlink) break;
          chain.push(only);
        }
        return chain;
      }),
    );
    const byPath = new Map(chains.map((c) => [c[0]?.path ?? "", c]));
    return entries.map((e) => {
      const chain = byPath.get(e.path);
      if (!chain || chain.length < 2) {
        if (e.kind === "dir") forget(e);
        return e;
      }
      const last = chain[chain.length - 1] as DirEntry;
      for (const seg of chain) {
        this.compactOf.set(pathKey(seg.path), last.path);
        this.compactPaths.set(pathKey(seg.path), seg.path);
      }
      return {
        ...last,
        name: chain.map((c) => c.name).join("/"),
        ignored: chain.some((c) => c.ignored),
        segments: chain.map((c) => c.path),
      };
    });
  }

  /**
   * VS Code's file nesting (explorer.fileNesting.*, D201): files a pattern ties to another file of
   * the folder are listed under it (nesting.ts).
   */
  private nest(dir: string, entries: Entry[]): Entry[] {
    const settings = this.services.settings;
    const files = entries.filter((e) => e.kind !== "dir");
    // What this listing said before is replaced: a file that is no longer a nest parent (nesting
    // turned off, a pattern changed) mustn't take its old nested files along on delete or move.
    for (const f of files) {
      this.nestParents.delete(pathKey(f.path));
      this.nestedIn.delete(pathKey(f.path));
    }
    if (settings.peek<boolean>("explorer.fileNesting.enabled") !== true) return entries;
    const map = nestFiles(
      files.map((f) => f.name),
      nestingRules(settings.peek("explorer.fileNesting.patterns")),
      basename(dir),
    );
    if (!map.size) return entries;
    const byName = new Map(files.map((f) => [f.name, f]));
    const nested = new Set([...map.values()].flat());
    return entries
      .filter((e) => e.kind === "dir" || !nested.has(e.name))
      .map((e) => {
        const names = e.kind === "dir" ? undefined : map.get(e.name);
        if (!names) return e;
        const children = names.map((n) => byName.get(n)).filter((c): c is Entry => c !== undefined);
        this.nestParents.set(
          pathKey(e.path),
          children.map((c) => c.path),
        );
        for (const c of children) this.nestedIn.set(pathKey(c.path), e.path);
        return { ...e, nested: children };
      });
  }

  private async load(root: string | null): Promise<void> {
    // Everything belonging to one opened folder lives in `scope`; replacing it disposes the old tree.
    const scope = new DisposableStore();
    this.scope.value = scope;
    this.tree = undefined;
    // An inline rename or new item of the old tree ends unnamed: its row is gone, and committed
    // later (on blur) it would act on the old folder; left pending, drags stay off.
    this.inline.cancel();
    this.compactOf.clear();
    this.compactPaths.clear();
    this.nestedIn.clear();
    this.nestParents.clear();
    this.treeIsMulti = false;
    if (root === null) return;
    const multi = this.multiRoot();
    this.treeIsMulti = multi;
    this.rowHeight = rowHeight();
    const tree = scope.add(
      new Tree<DirEntry>(
        this.body,
        {
          id: (e) => e.path,
          label: (e) => e.name,
          hasChildren: (e) => e.kind === "dir" || !!nestedOf(e)?.length,
          // A nest parent opens on click; its chevron shows the nested files (VS Code).
          opensWithChildren: (e) => !!nestedOf(e)?.length,
          startsExpanded: (e) =>
            !!nestedOf(e)?.length &&
            this.services.settings.peek<boolean>("explorer.fileNesting.expand") !== false,
          children: async (e) => {
            if (e.path === WORKSPACE_ROOT) return this.folderEntries();
            if (this.inline.isPlaceholder(e)) return [];
            const nested = nestedOf(e);
            if (nested) return nested;
            const listed = await this.compact(
              this.visibleEntries(e.path, await fsIpc.listDir(e.path)),
            );
            return this.inline.withPlaceholder(e, this.nest(e.path, listed));
          },
        },
        { render: (entry, row, info) => this.renderRow(entry, row, info) },
        { rowHeight: this.rowHeight, ariaLabel: "Files explorer", sticky: true },
      ),
    );
    scope.add(toDisposable(() => tree.element.remove()));
    this.tree = tree;
    scope.add(
      this.services.settings.model.onDidChange((keys) => {
        if (
          keys.includes("files.exclude") ||
          keys.includes("explorer.compactFolders") ||
          keys.includes("explorer.showExcludedFiles") ||
          keys.some((k) => NESTING_KEYS.includes(k))
        )
          void this.refresh([
            ...this.services.workspace.folderPaths(),
            ...tree.expandedIds().filter((id) => id !== WORKSPACE_ROOT),
          ]);
      }),
    );
    const header = this.rootHeader(root, tree);
    this.body.prepend(header);
    scope.add(toDisposable(() => header.remove()));
    scope.add(
      tree.onDidOpen(({ item, preserveFocus, preview }) => {
        if (this.inline.isPlaceholder(item)) return;
        this.run("editor.openFile", { path: item.path, preserveFocus, preview });
      }),
    );
    scope.add(
      on(
        tree.element,
        "contextmenu",
        (e) => {
          const seg = eventClosest(e, ".explorer-segment");
          this.menuSegment = seg?.dataset.segment ?? null;
        },
        { capture: true },
      ),
    );
    scope.add(tree.onContextMenu(({ item, x, y }) => this.showMenu(item, x, y)));
    // Dragging a file onto the dock opens it in the drop zone (docs/dock.md §4); dragging rows
    // onto a folder in the tree moves them (explorer.move).
    scope.add(
      on(tree.element, "pointerdown", (e) => {
        const row = (e.target as Element).closest<HTMLElement>(".explorer-row");
        if (e.button !== 0 || !row || !row.dataset.path) return;
        if (this.inline.active) return;
        // The selection moves together when the row is part of it (VS Code).
        const selected = tree.selectedItems().map((x) => x.path);
        const paths = selected.includes(row.dataset.path) ? selected : [row.dataset.path];
        this.services.dragFile(e, row, row.dataset.path, paths);
        armTreeMove(scope, tree, e, row.dataset.path, {
          root: () => (this.multiRoot() ? null : this.services.workspace.root.peek()),
          isRootAt: (x, y) => {
            const r = this.body.querySelector(".explorer-root")?.getBoundingClientRect();
            return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
          },
          setTarget: (dir) => this.setDropTarget(dir),
          move: (paths, dest) => this.run("explorer.move", { paths, dest, withNested: true }),
        });
      }),
    );
    scope.add(
      tree.onDidChangeExpansion(() => {
        void watchIpc.setDirs(this.watchedDirs(root, tree)).catch(() => {});
        this.services.persistence.scheduleSave();
      }),
    );
    const rootEntry: DirEntry = {
      name: root,
      path: multi ? WORKSPACE_ROOT : root,
      kind: "dir",
      isSymlink: false,
      ignored: false,
    };
    // A multi-root workspace opened for the first time shows its folders open.
    const expanded =
      multi && !this.pendingExpanded.length
        ? this.services.workspace.folderPaths()
        : this.pendingExpanded;
    this.pendingExpanded = [];
    // Opening a folder: the view's progress line until its tree is listed (D118).
    const busy = this.services.views.progress("explorer.view", "Opening folder");
    await tree.setRoot(rootEntry, expanded).finally(() => busy.dispose());
    if (scope.isDisposed) return;
    // The active tab's file again, now that there's a tree to show it in: a tab restored at
    // startup (or open before the folder was) was followed while the tree was still listing, and
    // that attempt is remembered, so switching back to the same tab wouldn't retry it (D412).
    this.lastRevealed = "";
    this.autoReveal();
    // Changes this window made itself (an agent's writes, Accept all, a revert) list their
    // folders again at once: the OS watcher can miss or delay them (D226).
    let changed = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    scope.add({ dispose: () => clearTimeout(timer) });
    scope.add(
      fsChanges.event((paths) => {
        // Each folder up to its workspace folder: a new file in a new folder shows its folder too.
        for (const p of paths) {
          const owner = this.services.workspace.folderOf(p)?.path;
          if (!owner) continue;
          for (let d = dirname(p); isWithin(owner, d); d = dirname(d)) {
            changed.add(d);
            if (pathKey(d) === pathKey(owner)) break;
          }
        }
        if (!changed.size || timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          const dirs = [...changed];
          changed = new Set();
          void this.refresh(dirs);
        }, 80);
      }),
    );
    try {
      const watcher = await watchIpc.start((batch: WatchBatch) => void this.refresh(batch.dirs));
      if (scope.isDisposed) return watcher.dispose();
      scope.add(watcher);
      await watchIpc.setDirs(this.watchedDirs(root, tree));
    } catch (err) {
      console.warn("file watching unavailable", err);
    }
  }

  private renderRow(
    entry: DirEntry,
    row: HTMLElement,
    info: { depth: number; expanded: boolean; loading: boolean },
  ): void {
    const isDir = entry.kind === "dir";
    row.classList.add("explorer-row");
    row.classList.toggle("is-ignored", entry.ignored);
    row.classList.toggle("is-excluded", this.excludedKeys.has(pathKey(entry.path)));
    row.classList.toggle("is-cut", this.cutKeys.has(pathKey(entry.path)));
    const root = this.services.workspace.root.peek();
    const dropRoot =
      this.dropTarget !== null &&
      root !== null &&
      !this.multiRoot() &&
      pathKey(this.dropTarget) === pathKey(root);
    // A multi-root workspace's folders: their own rows, set apart (D251).
    row.classList.toggle("is-workspace-folder", this.isFolderRow(entry));
    row.classList.toggle(
      "is-drop-folder",
      !dropRoot && this.dropTarget !== null && pathKey(entry.path) === pathKey(this.dropTarget),
    );
    row.classList.toggle(
      "is-drop-target",
      !dropRoot &&
        this.dropTarget !== null &&
        pathKey(entry.path) !== pathKey(this.dropTarget) &&
        isWithin(this.dropTarget, entry.path),
    );
    // Recycled rows: the name filled in below is the accessible name, not a past row's path.
    setTooltip(row, entry.path, undefined, { placement: "right", ariaLabel: false });
    row.dataset.path = entry.path;
    row.dataset.kind = entry.kind;
    // VS Code's compact layout: a folder's chevron and a file's icon share one column, so names
    // line up at each depth and the indent guide sits under the parent's chevron. Folders get an
    // icon after the chevron when explorer.folderIcons is on (off by default; any icon theme, D134; a theme
    // that hides the chevrons keeps them: they're the only expand mark); files stay put.
    const themeInfo = fileIconThemeInfo();
    const folderIcons =
      themeInfo.hidesExplorerArrows ||
      this.services.settings.peek<boolean>("explorer.folderIcons") === true;
    const fileGlyph = isDir
      ? folderIcons
        ? icon(folderIcon(entry.name, info.expanded))
        : null
      : icon(fileIcon(entry.name));
    if (isDir) fileGlyph?.classList.add("explorer-folder-icon");
    else fileGlyph?.classList.add("explorer-file-icon");
    const deco = this.services.decorations.get(entry.path, entry.kind === "dir" ? "dir" : "file");
    const color = deco?.color ? { color: `var(${deco.color})` } : undefined;
    row.classList.toggle("is-struck", deco?.strike === true);
    row.classList.toggle("is-faded", deco?.faded === true);
    if (deco?.tooltip)
      setTooltip(row, `${entry.path} · ${deco.tooltip}`, undefined, {
        placement: "right",
        ariaLabel: false,
      });
    const editor = this.inline.inputFor(entry);
    row.classList.toggle("is-editing", editor !== null);
    // A file with nested files (D201): a chevron of its own (only it toggles), then its icon.
    const nests = !!nestedOf(entry)?.length;
    row.classList.toggle("is-nest-parent", nests);
    const chevron =
      (isDir && !themeInfo.hidesExplorerArrows) || nests
        ? icon(info.expanded ? "chevron-down" : "chevron-right")
        : null;
    if (nests) chevron?.setAttribute("data-tree-twistie", "");
    replaceChildren(
      row,
      h("span", { class: "tree-indent", "aria-hidden": "true" }),
      chevron,
      fileGlyph,
      this.nameOf(entry, editor, color),
      deco?.badge
        ? h("span", { class: "explorer-badge", style: color }, deco.badge)
        : deco?.color && isDir
          ? h("span", { class: "explorer-dot", style: { background: `var(${deco.color})` } })
          : null,
      info.loading ? h("span", { class: "explorer-loading", "aria-label": "Loading" }, "…") : null,
    );
  }

  /**
   * The row's name. A compact row ("src/app/core", explorer.compactFolders) names each folder in
   * its own span, as VS Code does: right-clicking one acts on that folder (rename, delete, new
   * file…), and renaming edits that folder's name in its place (D191).
   */
  private nameOf(
    entry: Entry,
    editor: HTMLElement | null,
    color: { color: string } | undefined,
  ): HTMLElement {
    const segments = entry.segments;
    if (!segments || segments.length < 2)
      return editor ?? h("span", { class: "explorer-name", style: color }, entry.name);
    const renaming = editor ? this.inline.renaming() : null;
    const parts: (HTMLElement | string)[] = [];
    segments.forEach((path, i) => {
      if (i > 0) parts.push(h("span", { class: "explorer-segment-sep" }, "/"));
      parts.push(
        editor && renaming && pathKey(renaming) === pathKey(path)
          ? editor
          : h("span", { class: "explorer-segment", "data-segment": path }, basename(path)),
      );
    });
    return h("span", { class: "explorer-name is-compact", style: color }, ...parts);
  }

  /** The folder of a compact row that was right-clicked (its segment), for the menu. */
  private menuSegment: string | null = null;

  /** Entries files.exclude matches (shown dimmed while explorer.showExcludedFiles is on). */
  private readonly excludedKeys = new Set<string>();

  /**
   * Entries files.exclude doesn't hide (VS Code's glob map, workspace-relative). With
   * explorer.showExcludedFiles on (D142), they're all listed and the excluded ones dimmed —
   * still excluded from search and quick open.
   */
  private visibleEntries(dir: string, all: DirEntry[]): DirEntry[] {
    // A workspace folder nested in another is a top row of its own: listed inside its outer
    // folder too, it would be the same tree id twice (the tree keeps one node per id).
    const entries = this.multiRoot()
      ? all.filter((e) => e.kind !== "dir" || !this.isFolderRow(e))
      : all;
    // Each workspace folder's own files.exclude, matched relative to that folder (D251): the
    // listed folder's, not an entry's (an entry can be a folder with settings of its own).
    const root = this.folderFor(dir) ?? "";
    const patterns =
      this.services.settings.peekAt<Record<string, unknown>>("files.exclude", root || null) ?? {};
    if (!Object.keys(patterns).length || !root) return entries;
    const showAll = this.services.settings.peekAt<boolean | undefined>(
      "explorer.showExcludedFiles",
      root,
    );
    return entries.filter((e) => {
      const excluded = isExcluded(relativePath(root, e.path), patterns);
      if (excluded) this.excludedKeys.add(pathKey(e.path));
      else this.excludedKeys.delete(pathKey(e.path));
      return !excluded || showAll === true;
    });
  }

  /**
   * The explorer's context menu, in VS Code's groups and order: open (to the side / with / preview,
   * reveal, terminal) · find in folder / timeline · chat · cut, copy, paste · copy path · rename,
   * delete · new / refresh / collapse for the empty area.
   */
  private menuSeq = 0;

  /** A folder's menu waits for whether it is an extension (one quick check, D176). */
  private showMenu(item0: DirEntry | null, x: number, y: number): void {
    // A later right-click wins over a folder check still answering.
    const seq = ++this.menuSeq;
    // On one folder of a compact row: the menu is that folder's (D191).
    const segment = this.menuSegment;
    this.menuSegment = null;
    const segments = (item0 as Entry | null)?.segments;
    const item: DirEntry | null =
      item0 && segment && segments?.some((s) => pathKey(s) === pathKey(segment))
        ? ({ ...item0, path: segment, name: basename(segment), segments: undefined } as Entry)
        : item0;
    if (item?.kind !== "dir") {
      this.openMenu(item, x, y, null);
      return;
    }
    void this.services.dispatcher
      .execute<{ extension: boolean; id?: string | null; loaded?: boolean; dev?: boolean }>(
        "extensions.folderStatus",
        { folder: item.path },
      )
      .catch(() => null)
      .then((status) => {
        if (this.store.isDisposed || seq !== this.menuSeq) return;
        this.openMenu(item, x, y, status?.extension ? status : null);
      });
  }

  private openMenu(
    item: DirEntry | null,
    x: number,
    y: number,
    extension: { id?: string | null; loaded?: boolean; dev?: boolean } | null,
  ): void {
    openExplorerMenu(this, item, x, y, extension);
  }

  /** The header's ⋯ menu: folder-level actions (VS Code's explorer "…" plus close folder). */
  showMoreMenu(x: number, y: number): void {
    showExplorerMoreMenu(this, x, y);
  }

  run(command: string, input: unknown = {}): void {
    void this.services.dispatcher.execute(command, input).catch(() => {});
  }

  dispose(): void {
    this.store.dispose();
  }
}
