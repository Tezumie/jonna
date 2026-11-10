// The search sidebar view: query with case / whole word / regex toggles, optional replace field
// (with preserve case), include/exclude globs (with "only open editors" and "use exclude settings
// and ignore files"), and the results as a tree (file → matching lines) that fills in while the
// search streams. Typing runs `search.run` (debounced; `search.searchOnType`); clicking a line
// opens it in a preview tab; with a replacement typed, lines show the change (struck match, new
// text). Right-click offers VS Code's result actions (open to the side, replace, dismiss, copy,
// reveal, find in folder, exclude). Up / Down in a field walks what was typed there before, and
// the results can show grouped by folder (D172), both like VS Code.
import { h, on, replaceChildren } from "../../core/dom/index";
import { DisposableStore, MutableDisposable } from "../../core/lifecycle/index";
import { dirname } from "../../core/paths/index";
import { fileIcon, type IconName, icon } from "../../ui/Icon";
import { type MenuItem, showContextMenu } from "../../ui/Menu";
import { setTooltip } from "../../ui/Tooltip";
import { Tree } from "../../ui/Tree";
import type { WorkbenchServices } from "../../workbench/services";
import {
  type FileResult,
  type FolderNode,
  folderTree,
  type HistoryField,
  previewReplacement,
  type SearchModel,
  type SearchQuery,
} from "./model";

type Node =
  | { kind: "root" }
  | { kind: "folder"; folder: FolderNode }
  | { kind: "file"; file: FileResult }
  | { kind: "match"; file: FileResult; index: number };

const folderId = (rel: string) => `folder:${rel}`;

/** Form toggles: the three query ones, preserve case (replace) and the two scope ones. */
export type ToggleName =
  | "matchCase"
  | "wholeWord"
  | "isRegex"
  | "preserveCase"
  | "onlyOpenEditors"
  | "useExcludeSettings";

/** Characters kept before the first match of a long line. */
const LEAD_CHARS = 16;
/** search.collapseResults "auto": files with more matches than this start collapsed. */
const AUTO_COLLAPSE_OVER = 10;

export class SearchView {
  private readonly store = new DisposableStore();
  private readonly menu = this.store.add(new MutableDisposable());
  readonly query: HTMLInputElement;
  readonly replace: HTMLInputElement;
  private readonly include: HTMLInputElement;
  private readonly exclude: HTMLInputElement;
  private readonly message: HTMLElement;
  private readonly tree: Tree<Node>;
  private readonly toggles: Record<ToggleName, HTMLButtonElement>;
  private replaceRow: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private refreshFrame = 0;
  /** A refresh is running; another was asked for meanwhile (they run one at a time). */
  private refreshing = false;
  private refreshAgain = false;
  /** Each file's match list as it was last listed in the tree (D379). */
  private readonly listed = new Map<string, readonly unknown[]>();
  /** Files already shown (expanded or collapsed once on arrival). */
  private readonly known = new Set<string>();

  constructor(
    host: HTMLElement,
    private readonly services: WorkbenchServices,
    private readonly model: SearchModel,
  ) {
    const input = (placeholder: string, label: string) =>
      h("input", {
        class: "input search-input",
        type: "text",
        placeholder,
        spellcheck: "false",
        "aria-label": label,
      });
    this.query = input("Search", "Search");
    this.replace = input("Replace", "Replace");
    this.include = input("Files to include (e.g. src, *.ts)", "Files to include");
    this.exclude = input("Files to exclude", "Files to exclude");
    const toggle = (name: IconName, label: string, pressed = false, research = true) => {
      const b = h(
        "button",
        { class: "icon-button search-toggle", type: "button", "aria-pressed": String(pressed) },
        icon(name),
      );
      setTooltip(b, label);
      this.store.add(
        on(b, "click", () => {
          b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
          if (research) this.schedule(0);
          else this.tree.rerender();
        }),
      );
      return b;
    };
    this.toggles = {
      matchCase: toggle("case-sensitive", "Match case"),
      wholeWord: toggle("whole-word", "Match whole word"),
      isRegex: toggle("regex", "Use regular expression"),
      preserveCase: toggle("case-upper", "Preserve case", false, false),
      onlyOpenEditors: toggle("book-open", "Search only in open editors"),
      useExcludeSettings: toggle("list-filter", "Use exclude settings and ignore files", true),
    };
    /** An input with its toggles inside, on the right (VS Code's find widget look). */
    const field = (el: HTMLInputElement, ...buttons: HTMLButtonElement[]) =>
      h(
        "div",
        { class: "search-field", "data-toggles": String(buttons.length) },
        el,
        h("div", { class: "search-toggles" }, ...buttons),
      );
    const replaceAll = h("button", { class: "icon-button", type: "button" }, icon("replace-all"));
    setTooltip(replaceAll, "Replace all", "search.replace");
    this.store.add(
      on(replaceAll, "click", () =>
        this.run("search.replace", { replacement: this.replace.value }),
      ),
    );
    const expander = h(
      "button",
      { class: "icon-button search-expander", type: "button" },
      icon("chevron-right"),
    );
    setTooltip(expander, "Toggle replace");
    this.replaceRow = h(
      "div",
      { class: "search-row", hidden: true },
      field(this.replace, this.toggles.preserveCase),
      replaceAll,
    );
    this.store.add(
      on(expander, "click", () => {
        this.replaceRow.hidden = !this.replaceRow.hidden;
        expander.replaceChildren(icon(this.replaceRow.hidden ? "chevron-right" : "chevron-down"));
        if (!this.replaceRow.hidden) this.replace.focus();
        this.tree.rerender();
      }),
    );
    this.message = h("div", { class: "search-message", role: "status" });
    const treeHost = h("div", { class: "search-results" });
    host.append(
      h(
        "div",
        { class: "search-form" },
        h(
          "div",
          { class: "search-main" },
          expander,
          h(
            "div",
            { class: "search-fields" },
            h(
              "div",
              { class: "search-row search-query" },
              field(
                this.query,
                this.toggles.matchCase,
                this.toggles.wholeWord,
                this.toggles.isRegex,
              ),
            ),
            this.replaceRow,
          ),
        ),
        h(
          "div",
          { class: "search-globs" },
          field(this.include, this.toggles.onlyOpenEditors),
          field(this.exclude, this.toggles.useExcludeSettings),
        ),
      ),
      this.message,
      treeHost,
    );
    const setting = <T>(key: string, fallback: T): T =>
      services.settings.peek<T | undefined>(key) ?? fallback;
    for (const el of [this.query, this.include, this.exclude])
      this.store.add(
        on(el, "input", () => {
          if (setting("search.searchOnType", true))
            this.schedule(setting("search.searchOnTypeDebouncePeriod", 300));
        }),
      );
    for (const el of [this.query, this.include, this.exclude])
      this.store.add(
        on(el, "keydown", (e) => {
          if (e.key !== "Enter") return;
          this.remember();
          this.schedule(0);
        }),
      );
    const fields: [HTMLInputElement, HistoryField][] = [
      [this.query, "query"],
      [this.replace, "replace"],
      [this.include, "include"],
      [this.exclude, "exclude"],
    ];
    for (const [el, field] of fields) {
      this.store.add(
        on(el, "keydown", (e) => {
          const history = model.history[field];
          if ((e.key !== "ArrowUp" && e.key !== "ArrowDown") || e.altKey || e.ctrlKey || e.metaKey)
            return;
          const value = e.key === "ArrowUp" ? history.previous(el.value) : history.next();
          if (value === undefined) return;
          e.preventDefault();
          el.value = value;
          el.setSelectionRange(value.length, value.length);
          if (field === "replace") this.tree.rerender();
          else this.schedule(0);
        }),
      );
      this.store.add(on(el, "input", () => model.history[field].reset()));
      // Leaving a field remembers what it holds (as VS Code does once a search ran with it).
      this.store.add(on(el, "blur", () => this.remember(field)));
    }
    this.store.add(on(this.replace, "input", () => this.tree.rerender()));
    this.tree = this.store.add(
      new Tree<Node>(
        treeHost,
        {
          id: (n) =>
            n.kind === "file"
              ? n.file.path
              : n.kind === "match"
                ? `${n.file.path}#${n.index}`
                : n.kind === "folder"
                  ? folderId(n.folder.rel)
                  : "",
          hasChildren: (n) => n.kind !== "match",
          children: async (n) => {
            if (n.kind === "root" && this.model.viewMode === "tree")
              return this.folderChildren(folderTree(this.model.files));
            if (n.kind === "root")
              return this.model.files.map((file) => ({ kind: "file" as const, file }));
            if (n.kind === "folder") return this.folderChildren(n.folder);
            if (n.kind !== "file") return [];
            this.listed.set(n.file.path, n.file.matches);
            return n.file.matches.map((_, index) => ({
              kind: "match" as const,
              file: n.file,
              index,
            }));
          },
        },
        { render: (n, row, info) => this.renderRow(n, row, info.expanded) },
        { rowHeight: 22, ariaLabel: "Search results", sticky: true },
      ),
    );
    this.store.add(
      this.tree.onDidOpen(({ item, preserveFocus, preview }) => {
        if (item.kind !== "match") return;
        this.openMatch(item, { preserveFocus, preview });
      }),
    );
    this.store.add(
      this.tree.onContextMenu(({ item, x, y }) => {
        if (item?.kind === "folder") this.showFolderMenu(item.folder, x, y);
        else if (item && item.kind !== "root") this.showMenu(item, x, y);
      }),
    );
    this.store.add(
      services.settings.model.onDidChange((keys) => {
        if (keys.includes("search.showLineNumbers")) this.tree.rerender();
      }),
    );
    this.store.add(model.onDidChange(() => this.scheduleRefresh()));
    this.store.add({ dispose: () => clearTimeout(this.timer) });
    this.store.add({ dispose: () => cancelAnimationFrame(this.refreshFrame) });
    void this.tree.setRoot({ kind: "root" });
  }

  private folderChildren(folder: FolderNode): Node[] {
    return [
      ...folder.folders.map((f) => ({ kind: "folder" as const, folder: f })),
      ...folder.files.map((file) => ({ kind: "file" as const, file })),
    ];
  }

  /** Remembers what the fields hold (`field`, or the search ones) for Up / Down. */
  private remember(field?: HistoryField): void {
    const values: Record<HistoryField, string> = {
      query: this.query.value,
      replace: this.replaceRow.hidden ? "" : this.replace.value,
      include: this.include.value,
      exclude: this.exclude.value,
    };
    // A query is remembered once it has been searched (not every half-typed word on blur).
    const searched = this.model.options !== null;
    for (const key of field ? [field] : (["query", "include", "exclude"] as const))
      if (key !== "query" || searched) this.model.history[key].add(values[key].trim());
  }

  /** Shows the results as a list of files or grouped by folder (search.toggleViewMode). */
  async setViewMode(mode: "list" | "tree"): Promise<void> {
    if (this.model.viewMode === mode) return;
    this.model.viewMode = mode;
    this.known.clear();
    await this.tree.setRoot({ kind: "root" });
    await this.refresh();
  }

  /** Current form values (settings are applied by the commands, see effectiveOptions). */
  options(): SearchQuery {
    const globs = (el: HTMLInputElement) =>
      el.value
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean);
    const pressed = (name: ToggleName) =>
      this.toggles[name].getAttribute("aria-pressed") === "true";
    return {
      query: this.query.value,
      isRegex: pressed("isRegex"),
      matchCase: pressed("matchCase"),
      wholeWord: pressed("wholeWord"),
      include: globs(this.include),
      exclude: globs(this.exclude),
      preserveCase: pressed("preserveCase"),
      onlyOpenEditors: pressed("onlyOpenEditors"),
      useExcludeSettings: pressed("useExcludeSettings"),
    };
  }

  /** Mirrors options set by a command (so the form shows what ran). */
  setOptions(o: Partial<SearchQuery> & { replacement?: string }): void {
    if (o.query !== undefined) this.query.value = o.query;
    if (o.include) this.include.value = o.include.join(", ");
    if (o.exclude) this.exclude.value = o.exclude.join(", ");
    for (const key of Object.keys(this.toggles) as ToggleName[]) {
      const value = o[key];
      if (typeof value === "boolean") this.toggles[key].setAttribute("aria-pressed", String(value));
    }
    if (o.replacement !== undefined) {
      this.replace.value = o.replacement;
      this.replaceRow.hidden = false;
    }
  }

  /** Flips a toggle as a click would (searching again unless it is preserve case). */
  toggle(name: ToggleName): boolean {
    this.toggles[name].click();
    return this.toggles[name].getAttribute("aria-pressed") === "true";
  }

  /** The replacement typed in the form, or undefined while the replace row is hidden. */
  replacement(): string | undefined {
    return this.replaceRow.hidden ? undefined : this.replace.value;
  }

  collapseAll(): void {
    this.tree.collapseAll();
    // New results arriving later shouldn't re-expand what was just collapsed.
    for (const file of this.model.files) this.known.add(file.path);
    for (const rel of this.folderRels()) this.known.add(folderId(rel));
  }

  async expandAll(): Promise<void> {
    for (const rel of this.folderRels()) {
      this.known.add(folderId(rel));
      await this.tree.expand(folderId(rel));
    }
    for (const file of this.model.files) {
      this.known.add(file.path);
      await this.tree.expand(file.path);
    }
  }

  /** The tree mode's folders, parents first (expanding needs the parent open). */
  private folderRels(): string[] {
    if (this.model.viewMode !== "tree") return [];
    const out: string[] = [];
    const walk = (f: FolderNode) => {
      for (const sub of f.folders) {
        out.push(sub.rel);
        walk(sub);
      }
    };
    walk(folderTree(this.model.files));
    return out;
  }

  focus(): void {
    this.query.focus();
    this.query.select();
  }

  /** The row's ✕: hide this file's or line's results (search.dismiss). */
  private dismissButton(path: string, line?: number): HTMLElement {
    const b = h("button", { class: "icon-button search-row-action", type: "button" }, icon("x"));
    setTooltip(b, "Dismiss");
    b.addEventListener("mousedown", (e) => e.stopPropagation());
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      this.run("search.dismiss", { path, ...(line !== undefined && { line }) });
    });
    return b;
  }

  private openMatch(
    item: { file: FileResult; index: number },
    extra: Record<string, unknown> = {},
  ): void {
    const m = item.file.matches[item.index];
    if (!m) return;
    this.remember();
    this.run("editor.openFile", {
      path: item.file.path,
      line: m.line,
      column: (m.ranges[0]?.[0] ?? 0) + 1,
      ...extra,
    });
  }

  /** VS Code's result menu: open · replace / dismiss · copy · reveal / scope · collapse. */
  /** A folder row (tree view): search in it or leave it out, reveal it, collapse / expand. */
  private showFolderMenu(folder: FolderNode, x: number, y: number): void {
    const run =
      (command: string, input: unknown = {}) =>
      () =>
        this.run(command, input);
    const { workspace } = this.services;
    this.menu.value = showContextMenu(x, y, [
      {
        label: "Find in folder…",
        icon: "search",
        run: run("search.findInFolder", { path: folder.rel }),
      },
      {
        label: "Exclude folder from search",
        icon: "eye-off",
        run: run("search.excludeFolder", { path: folder.rel }),
      },
      {
        label: "Reveal in explorer",
        icon: "locate",
        separatorBefore: true,
        // A workspace path (D251: the folder's name first with several folders).
        run: run("explorer.reveal", {
          path: workspace.root.peek() ? workspace.resolve(folder.rel) : folder.rel,
        }),
      },
      {
        label: "Collapse all",
        icon: "list-collapse",
        separatorBefore: true,
        run: run("search.collapseAll"),
      },
      { label: "Expand all", icon: "list-tree", run: run("search.expandAll") },
    ]);
  }

  private showMenu(n: Exclude<Node, { kind: "root" | "folder" }>, x: number, y: number): void {
    const key = (id: string) => this.services.keyboard.labelFor(id);
    const run =
      (command: string, input: unknown = {}) =>
      () =>
        this.run(command, input);
    const path = n.file.path;
    const match = n.kind === "match" ? n.file.matches[n.index] : undefined;
    const replacing = !this.replaceRow.hidden;
    const folder = this.services.workspace.relative(dirname(path));
    const groups: MenuItem[][] = [
      [
        n.kind === "match"
          ? {
              label: "Open",
              icon: "file-input" as IconName,
              run: () => this.openMatch(n, { preview: false }),
            }
          : {
              label: "Open",
              icon: "file-input" as IconName,
              run: run("editor.openFile", { path }),
            },
        {
          label: "Open to the side",
          icon: "columns-2",
          keybinding: key("editor.openToSide"),
          run:
            n.kind === "match"
              ? () => this.openMatch(n, { toSide: true })
              : run("editor.openFile", { path, toSide: true }),
        },
      ],
      [
        ...(replacing
          ? [
              {
                label: match ? "Replace" : "Replace all in file",
                icon: (match ? "replace" : "replace-all") as IconName,
                run: run("search.replace", {
                  replacement: this.replace.value,
                  paths: [path],
                  ...(match && { lines: [match.line] }),
                }),
              },
            ]
          : []),
        {
          label: "Dismiss",
          icon: "x",
          run: run("search.dismiss", { path, ...(match && { line: match.line }) }),
        },
      ],
      [
        {
          label: "Copy",
          icon: "copy",
          run: run("search.copyResults", { path, ...(match && { line: match.line }) }),
        },
        { label: "Copy path", icon: "clipboard-copy", run: run("explorer.copyPath", { path }) },
        {
          label: "Copy relative path",
          icon: "clipboard-copy",
          run: run("explorer.copyPath", { path, relative: true }),
        },
        { label: "Copy all", icon: "copy", run: run("search.copyResults") },
      ],
      [
        { label: "Reveal in explorer", icon: "locate", run: run("explorer.reveal", { path }) },
        {
          label: "Reveal in file manager",
          icon: "folder-search",
          keybinding: key("explorer.revealInOs"),
          run: run("explorer.revealInOs", { path }),
        },
        ...(folder && folder !== "."
          ? [
              {
                label: "Find in folder…",
                icon: "search" as IconName,
                run: run("search.findInFolder", { path: folder }),
              },
              {
                label: "Exclude folder from search",
                icon: "eye-off" as IconName,
                run: run("search.excludeFolder", { path: folder }),
              },
            ]
          : []),
      ],
      [
        { label: "Collapse all", icon: "list-collapse", run: run("search.collapseAll") },
        { label: "Expand all", icon: "list-tree", run: run("search.expandAll") },
      ],
    ];
    const items = groups
      .filter((g) => g.length)
      .flatMap((g, i) => g.map((it, j) => ({ ...it, separatorBefore: i > 0 && j === 0 })));
    this.menu.value = showContextMenu(x, y, items);
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const o = this.options();
      if (!o.query) {
        this.run("search.clear");
        return;
      }
      this.run("search.run", { ...o, wait: false });
    }, delay);
  }

  /** Coalesces streamed results into one tree refresh per frame. */
  private scheduleRefresh(): void {
    if (this.refreshFrame) return;
    this.refreshFrame = requestAnimationFrame(() => {
      this.refreshFrame = 0;
      void this.refresh();
    });
  }

  private async refresh(): Promise<void> {
    // One at a time: a refresh that awaits mustn't run beside the next frame's.
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshAgain = false;
        await this.refreshOnce();
      } while (this.refreshAgain);
    } finally {
      this.refreshing = false;
    }
  }

  private async refreshOnce(): Promise<void> {
    const { model } = this;
    // Keep what the user collapsed; files that just arrived open as search.collapseResults says.
    // While results stream in only the root and folders change (D379): a file's matches arrive
    // whole, so they aren't listed again every frame (that was quadratic on large result sets).
    if (model.running) {
      await this.tree.refresh((n) => n.kind === "root" || n.kind === "folder");
      // A file whose matches changed since they were listed (a match dismissed, a new search
      // reusing the row) lists again; the rest don't.
      await this.tree.refresh(
        (n) =>
          n.kind === "file" &&
          this.listed.has(n.file.path) &&
          this.listed.get(n.file.path) !== n.file.matches,
      );
    } else await this.tree.refresh();
    const folders = this.folderRels();
    const current = new Set([...model.files.map((f) => f.path), ...folders.map(folderId)]);
    for (const path of this.known) if (!current.has(path)) this.known.delete(path);
    for (const path of this.listed.keys()) if (!current.has(path)) this.listed.delete(path);
    // Folders open as they appear (their files then follow search.collapseResults).
    const newFolders = folders.map(folderId).filter((id) => !this.known.has(id));
    for (const id of newFolders) this.known.add(id);
    await this.tree.expandMany(newFolders);
    const mode = this.services.settings.peek<string | undefined>("search.collapseResults");
    const open: string[] = [];
    for (const file of model.files) {
      if (this.known.has(file.path)) continue;
      this.known.add(file.path);
      const collapse =
        mode === "alwaysCollapse" || (mode === "auto" && file.matches.length > AUTO_COLLAPSE_OVER);
      if (!collapse) open.push(file.path);
    }
    // One render for every file that arrived, not one each.
    await this.tree.expandMany(open);
    const n = model.matchCount;
    this.message.classList.toggle("is-error", !!model.error);
    const scope = model.options?.useIgnoreFiles === false ? " (ignore files off)" : "";
    this.message.textContent = model.error
      ? model.error
      : !model.options
        ? ""
        : model.running
          ? `Searching… ${n} results in ${model.files.length} files`
          : n === 0
            ? `No results found.${scope}`
            : `${n} result${n === 1 ? "" : "s"} in ${model.files.length} file${model.files.length === 1 ? "" : "s"}${model.summary?.truncated ? " (stopped at the result limit)" : ""}${scope}`;
  }

  private renderRow(n: Node, row: HTMLElement, expanded: boolean): void {
    row.classList.add("search-row-item");
    // Rows are recycled: the folder mark follows the node.
    row.classList.toggle("is-folder", n.kind === "folder");
    if (n.kind === "folder") {
      replaceChildren(
        row,
        icon(expanded ? "chevron-down" : "chevron-right"),
        icon(expanded ? "folder-open" : "folder"),
        h("span", { class: "search-file-name" }, n.folder.name),
        h("span", { class: "search-file-dir" }),
        h("span", { class: "search-count" }, String(n.folder.count)),
      );
      setTooltip(row, n.folder.rel, undefined, { ariaLabel: false });
      return;
    }
    if (n.kind === "file") {
      const name = n.file.rel.slice(n.file.rel.replace(/\\/g, "/").lastIndexOf("/") + 1);
      const glyph = icon(fileIcon(name));
      const replaceFile = h(
        "button",
        { class: "icon-button search-row-action", type: "button" },
        icon("replace-all"),
      );
      setTooltip(replaceFile, "Replace all in this file");
      replaceFile.addEventListener("mousedown", (e) => e.stopPropagation());
      replaceFile.addEventListener("click", (e) => {
        e.stopPropagation();
        this.run("search.replace", { replacement: this.replace.value, paths: [n.file.path] });
      });
      replaceChildren(
        row,
        icon(expanded ? "chevron-down" : "chevron-right"),
        glyph,
        h("span", { class: "search-file-name" }, name),
        h(
          "span",
          { class: "search-file-dir" },
          // In the tree the folder rows say where it is.
          this.model.viewMode === "tree"
            ? ""
            : n.file.rel.slice(0, Math.max(0, n.file.rel.lastIndexOf("/"))),
        ),
        h("span", { class: "search-count" }, String(n.file.matches.length)),
        this.replaceRow.hidden ? null : replaceFile,
        this.dismissButton(n.file.path),
      );
      return;
    }
    if (n.kind !== "match") return;
    const m = n.file.matches[n.index];
    if (!m) return;
    const options = this.model.options;
    const replacing = !this.replaceRow.hidden && options !== null;
    const preview = options && {
      ...options,
      preserveCase: this.toggles.preserveCase.getAttribute("aria-pressed") === "true",
    };
    const parts: (string | HTMLElement)[] = [];
    // Start a little before the first match so it is visible in a narrow sidebar.
    const first = m.ranges[0]?.[0] ?? 0;
    let at = first > LEAD_CHARS + 8 ? first - LEAD_CHARS : 0;
    if (at > 0) parts.push("…");
    for (const [start, end] of m.ranges) {
      parts.push(m.text.slice(at, start).replace(/^\s+/, at === 0 ? "" : " "));
      const hit = m.text.slice(start, end);
      if (replacing && preview) {
        parts.push(h("del", { class: "search-hit is-removed" }, hit));
        parts.push(
          h(
            "ins",
            { class: "search-hit is-added" },
            previewReplacement(hit, preview, this.replace.value),
          ),
        );
      } else {
        parts.push(h("mark", { class: "search-hit" }, hit));
      }
      at = end;
    }
    parts.push(m.text.slice(at));
    const lineNumbers = this.services.settings.peek<boolean | undefined>("search.showLineNumbers");
    replaceChildren(
      row,
      h("span", { class: "search-line" }, ...parts),
      lineNumbers === false ? null : h("span", { class: "search-line-number" }, String(m.line)),
      this.dismissButton(n.file.path, m.line),
    );
  }

  private run(command: string, input: unknown = {}): void {
    void this.services.dispatcher.execute(command, input).catch(() => {});
  }

  dispose(): void {
    this.store.dispose();
  }
}
