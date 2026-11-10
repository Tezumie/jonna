// Search editors (D196, VS Code's): a search in an editor tab — the query, its toggles, include /
// exclude and the number of context lines on top, the results below as a document (file
// headers, numbered lines, matches marked; click a line to go there). Several can be open at
// once and each keeps its own search. Saved as `.code-search` files (VS Code's format, see
// core/search/searchEditor.ts), which open here and search again.
//
// Commands: search.openEditor (new one; from the Search view, its current query),
// searchEditor.run (search in the active one), searchEditor.save. State: ide://search/editor.

import type { Json } from "../../core/dock/index";
import { h, on, replaceChildren } from "../../core/dom/index";
import { Emitter } from "../../core/events/index";
import { fsIpc, type SearchEvent } from "../../core/ipc/fs";
import { dialogIpc } from "../../core/ipc/system";
import { DisposableStore } from "../../core/lifecycle/index";
import { basename, joinPath, relativePath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import {
  EMPTY_QUERY,
  parseSearchEditor,
  type SearchEditorFile,
  type SearchEditorQuery,
  serializeSearchEditor,
  summary,
  withContext,
} from "../../core/search/searchEditor";
import { type IconName, icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import type {
  DockView,
  DockViewContext,
  DockViewDescriptor,
  TabAction,
} from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";

const VIEW = "searchEditor";
/** Files whose text is read for context lines (more would be slow; they show matches only). */
const CONTEXT_FILES = 300;

interface EditorState {
  path: string | null;
  query: SearchEditorQuery;
}

function readState(state: Json): EditorState {
  const v = (state ?? {}) as Partial<EditorState> & { path?: unknown };
  return {
    path: typeof v.path === "string" ? v.path : null,
    query: { ...EMPTY_QUERY, ...(v.query && typeof v.query === "object" ? v.query : {}) },
  };
}

/**
 * Runs a search editor's query (every workspace folder, each with its own settings; detached from
 * the Search view's): file events, then one `done`. `onError`: a later folder's search failed.
 */
export type SearchEditorRunner = (
  q: SearchEditorQuery,
  sink: (event: SearchEvent) => void,
  onError: (err: unknown) => void,
) => Promise<void>;

/** The live search editors, so commands can find the active one. */
const live = new Set<SearchEditorView>();

class SearchEditorView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly changed = this.store.add(new Emitter<void>());
  /** The results' listeners, replaced on each render. */
  private readonly rows = this.store.add(new DisposableStore());
  readonly onDidChange = this.changed.event;
  path: string | null;
  query: SearchEditorQuery;
  files: SearchEditorFile[] = [];
  results = 0;
  searching = false;
  /** Why the last search failed (an invalid regular expression…). */
  private error: string | null = null;
  private seq = 0;
  private dirty = false;
  private readonly input: HTMLInputElement;
  private readonly include: HTMLInputElement;
  private readonly exclude: HTMLInputElement;
  private readonly contextCount: HTMLElement;
  private readonly toggles: Record<"matchCase" | "wholeWord" | "isRegex", HTMLButtonElement>;
  private readonly status: HTMLElement;
  private readonly body: HTMLElement;

  constructor(
    state: Json,
    private readonly services: WorkbenchServices,
    private readonly runSearch: SearchEditorRunner,
    private readonly ctx: DockViewContext,
  ) {
    const st = readState(state);
    this.path = st.path;
    this.query = st.query;
    const field = (placeholder: string, value: string) =>
      h("input", {
        class: "input search-editor-input",
        type: "text",
        placeholder,
        spellcheck: "false",
        value,
      }) as HTMLInputElement;
    this.input = field("Search", this.query.query);
    this.include = field("Files to include (e.g. src, *.ts)", this.query.include.join(", "));
    this.exclude = field("Files to exclude", this.query.exclude.join(", "));
    const toggle = (glyph: IconName, label: string, pressed: boolean) => {
      const b = h(
        "button",
        { class: "icon-button search-toggle", type: "button", "aria-pressed": String(pressed) },
        icon(glyph),
      ) as HTMLButtonElement;
      setTooltip(b, label);
      this.store.add(
        on(b, "click", () => {
          b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
          this.runFromForm();
        }),
      );
      return b;
    };
    this.toggles = {
      matchCase: toggle("case-sensitive", "Match case", this.query.matchCase),
      wholeWord: toggle("whole-word", "Match whole word", this.query.wholeWord),
      isRegex: toggle("regex", "Use regular expression", this.query.isRegex),
    };
    this.contextCount = h("span", { class: "search-editor-context-count" });
    const step = (glyph: IconName, label: string, by: number) => {
      const b = h(
        "button",
        { class: "icon-button", type: "button", "aria-label": label },
        icon(glyph),
      );
      setTooltip(b, label);
      this.store.add(
        on(b, "click", () => {
          this.query = {
            ...this.query,
            contextLines: Math.max(0, Math.min(10, this.query.contextLines + by)),
          };
          this.runFromForm();
        }),
      );
      return b;
    };
    this.status = h("div", { class: "search-editor-status", role: "status" });
    this.body = h("div", { class: "search-editor-results", role: "list" });
    for (const el of [this.input, this.include, this.exclude])
      this.store.add(
        on(el, "keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this.runFromForm();
          }
        }),
      );
    this.element = h(
      "div",
      { class: "search-editor", tabindex: "-1" },
      h(
        "div",
        { class: "search-editor-form" },
        h(
          "div",
          { class: "search-field search-editor-query", "data-toggles": "3" },
          this.input,
          h(
            "div",
            { class: "search-toggles" },
            this.toggles.matchCase,
            this.toggles.wholeWord,
            this.toggles.isRegex,
          ),
        ),
        h("div", { class: "search-editor-globs" }, this.include, this.exclude),
        h(
          "div",
          { class: "search-editor-context" },
          h("span", null, "Context lines"),
          step("minus", "Fewer context lines", -1),
          this.contextCount,
          step("plus", "More context lines", 1),
        ),
      ),
      this.status,
      this.body,
    );
    live.add(this);
    this.render();
    if (this.path) void this.loadFile(this.path);
    else if (this.query.query) void this.search();
  }

  /** The form as a query. */
  private formQuery(): SearchEditorQuery {
    const globs = (el: HTMLInputElement) =>
      el.value
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean);
    const pressed = (b: HTMLButtonElement) => b.getAttribute("aria-pressed") === "true";
    return {
      query: this.input.value,
      matchCase: pressed(this.toggles.matchCase),
      wholeWord: pressed(this.toggles.wholeWord),
      isRegex: pressed(this.toggles.isRegex),
      include: globs(this.include),
      exclude: globs(this.exclude),
      contextLines: this.query.contextLines,
    };
  }

  /** Enter, a toggle or the context buttons: through the command (one path for user and agents). */
  private runFromForm(): void {
    this.query = this.formQuery();
    void this.services.dispatcher
      .execute("searchEditor.run", { tab: this.tabId() })
      .catch(() => {});
  }

  private tabId(): string | undefined {
    return this.ctx.tabId;
  }

  /** Sets the form from `q` (a command's input). */
  setQuery(q: Partial<SearchEditorQuery>): void {
    this.query = { ...this.formQuery(), ...q };
    this.input.value = this.query.query;
    this.include.value = this.query.include.join(", ");
    this.exclude.value = this.query.exclude.join(", ");
    this.toggles.matchCase.setAttribute("aria-pressed", String(this.query.matchCase));
    this.toggles.wholeWord.setAttribute("aria-pressed", String(this.query.wholeWord));
    this.toggles.isRegex.setAttribute("aria-pressed", String(this.query.isRegex));
  }

  private async loadFile(path: string): Promise<void> {
    try {
      const text = new TextDecoder().decode(await fsIpc.read(path));
      this.setQuery(parseSearchEditor(text));
      if (this.query.query) await this.search(false);
      else this.render();
    } catch (err) {
      this.status.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  /** Runs the search for the form's query; resolves when the results are in. */
  async search(changed = true): Promise<{ results: number; files: number }> {
    this.query = this.formQuery();
    const mine = ++this.seq;
    this.files = [];
    this.results = 0;
    this.error = null;
    // A saved search that runs as its file opens isn't a change.
    if (changed && this.path !== null) this.dirty = true;
    if (!this.query.query) {
      this.searching = false;
      this.render();
      return { results: 0, files: 0 };
    }
    this.searching = true;
    this.render();
    const root = this.services.workspace.root.peek() ?? "";
    const multi = this.services.workspace.folders.peek().length > 1;
    const found: { path: string; rel: string; matches: SearchEditorFile["lines"] }[] = [];
    const failed = (err: unknown) => {
      if (mine === this.seq) this.error = err instanceof Error ? err.message : String(err);
    };
    await new Promise<void>((done) => {
      this.runSearch(
        this.query,
        (e) => {
          // A newer search replaced this one: stop collecting, but still finish (its caller waits).
          if (e.kind === "file") {
            if (mine === this.seq) found.push({ path: e.path, rel: e.rel, matches: e.matches });
          } else done();
        },
        failed,
      ).catch((err: unknown) => {
        failed(err);
        done();
      });
    });
    if (mine !== this.seq) return { results: this.results, files: this.files.length };
    // Context lines come from the files' text.
    const ctx = this.query.contextLines;
    const files: SearchEditorFile[] = [];
    for (const [i, f] of found.entries()) {
      let lines: string[] | null = null;
      if (ctx && i < CONTEXT_FILES)
        lines = await fsIpc
          .read(f.path)
          .then((b) => new TextDecoder().decode(b).split(/\r?\n/))
          .catch(() => null);
      if (mine !== this.seq) return { results: 0, files: 0 };
      files.push({
        // A workspace path (D251: the folder's name first in a multi-root workspace, which
        // `workspace.resolve` reads back), so each file can be found again across folders.
        rel: (multi
          ? this.services.workspace.relative(f.path)
          : f.rel || relativePath(root, f.path)
        ).replaceAll("\\", "/"),
        lines: withContext(f.matches, lines, ctx),
      });
    }
    this.files = files;
    this.results = found.reduce((n, f) => n + f.matches.length, 0);
    this.searching = false;
    this.render();
    // The tab comes back with this search after a restart.
    this.ctx.updateState(this.serialize());
    this.changed.fire();
    return { results: this.results, files: files.length };
  }

  private render(): void {
    this.contextCount.textContent = String(this.query.contextLines);
    this.status.textContent = this.error
      ? this.error
      : this.searching
        ? "Searching…"
        : this.query.query
          ? summary(this.results, this.files.length)
          : "Type what to search for and press Enter.";
    this.rows.clear();
    const rows: HTMLElement[] = [];
    for (const f of this.files) {
      const full = this.services.workspace.resolve(f.rel);
      const head = h(
        "button",
        { class: "search-editor-file", type: "button", role: "listitem" },
        icon("file"),
        h("span", { class: "search-editor-file-name" }, basename(f.rel)),
        h(
          "span",
          { class: "search-editor-file-dir" },
          f.rel.includes("/") ? f.rel.slice(0, f.rel.lastIndexOf("/")) : "",
        ),
      );
      this.rows.add(on(head, "click", () => this.open(full, 1, 1)));
      rows.push(head);
      let prev = -1;
      for (const l of f.lines) {
        if (prev !== -1 && l.line > prev + 1)
          rows.push(h("div", { class: "search-editor-gap" }, "…"));
        prev = l.line;
        const text = h("span", { class: "search-editor-text" });
        let at = 0;
        for (const [a, b] of l.ranges) {
          if (a > at) text.append(l.text.slice(at, a));
          text.append(h("mark", null, l.text.slice(a, b)));
          at = b;
        }
        text.append(l.text.slice(at));
        const row = h(
          "button",
          {
            class: { "search-editor-line": true, "is-context": l.ranges.length === 0 },
            type: "button",
            role: "listitem",
          },
          h("span", { class: "search-editor-num" }, String(l.line)),
          text,
        );
        this.rows.add(on(row, "click", () => this.open(full, l.line, (l.ranges[0]?.[0] ?? 0) + 1)));
        rows.push(row);
      }
    }
    replaceChildren(this.body, ...rows);
  }

  private open(path: string, line: number, column: number): void {
    void this.services.dispatcher
      .execute("editor.openFile", { path, line, column })
      .catch(() => {});
  }

  /** The document as saved. */
  text(): string {
    return serializeSearchEditor(this.query, this.files);
  }

  async save(path?: string): Promise<string | null> {
    let target = path ?? this.path;
    if (!target) {
      const root = this.services.workspace.root.peek();
      const name = `${(this.query.query || "search").replace(/[^\w.-]+/g, "-").slice(0, 40)}.code-search`;
      target = await dialogIpc.pickSavePath("Save search", root ? joinPath(root, name) : name);
      if (!target) return null;
      if (!target.endsWith(".code-search")) target += ".code-search";
    }
    await fsIpc.write(target, new TextEncoder().encode(this.text()));
    this.path = target;
    this.dirty = false;
    this.ctx.updateState(this.serialize());
    this.changed.fire();
    return target;
  }

  title(): string {
    return this.path ? basename(this.path) : `Search: ${this.query.query || "new"}`;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  actions(): TabAction[] {
    return [
      {
        icon: "refresh-cw",
        title: "Search again",
        command: "searchEditor.run",
        input: { tab: "$tab" },
      },
      {
        icon: "save",
        title: "Save as .code-search",
        command: "searchEditor.save",
        input: { tab: "$tab" },
      },
    ];
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  serialize(): Json {
    return { path: this.path, query: { ...this.query } } as unknown as Json;
  }

  dispose(): void {
    this.seq++;
    live.delete(this);
    this.store.dispose();
  }
}

export function registerSearchEditor(
  sub: DisposableStore,
  services: WorkbenchServices,
  runSearch: SearchEditorRunner,
  fromSidebar: () => Partial<SearchEditorQuery> | null,
): void {
  const { dispatcher, dock, state, viewers } = services;
  const views = new Map<string, SearchEditorView>();
  const descriptor: DockViewDescriptor = {
    type: VIEW,
    title: (st) => {
      const v = readState(st);
      return v.path ? basename(v.path) : `Search: ${v.query.query || "new"}`;
    },
    icon: () => "search",
    resource: (st) => readState(st).path ?? undefined,
    defaultPlacement: "main",
    editorLike: true,
    create: (st, ctx) => {
      const view = new SearchEditorView(st, services, runSearch, ctx);
      views.set(ctx.tabId, view);
      const origDispose = view.dispose.bind(view);
      view.dispose = () => {
        views.delete(ctx.tabId);
        origDispose();
      };
      return view;
    },
  };
  sub.add(dock.views.register(descriptor));
  sub.add(
    viewers.register({
      id: "searchEditor",
      label: "Search editor",
      viewType: VIEW,
      extensions: [".code-search"],
      kind: "default",
      icon: "search",
    }),
  );
  /** The search editor for a tab id, else the active one, else the most recent. */
  const target = (tab?: string): { id: string; view: SearchEditorView } | null => {
    if (tab && views.has(tab)) return { id: tab, view: views.get(tab) as SearchEditorView };
    const active = dock.activeTab();
    if (active?.viewType === VIEW && views.has(active.id))
      return { id: active.id, view: views.get(active.id) as SearchEditorView };
    const recent = dock.recentTab((t) => t.viewType === VIEW);
    return recent && views.has(recent.id)
      ? { id: recent.id, view: views.get(recent.id) as SearchEditorView }
      : null;
  };
  const queryInput = {
    query: s.string().optional(),
    isRegex: s.boolean().optional(),
    matchCase: s.boolean().optional(),
    wholeWord: s.boolean().optional(),
    include: s.array(s.string()).optional(),
    exclude: s.array(s.string()).optional(),
    contextLines: s.number().describe("Lines shown around each match (0–10)").optional(),
  };
  const pick = (input: Record<string, unknown>): Partial<SearchEditorQuery> =>
    Object.fromEntries(
      Object.entries(input).filter(([k, v]) => k in queryInput && v !== undefined),
    );

  sub.add(
    dispatcher.register({
      id: "search.openEditor",
      title: "New search editor",
      category: "Search",
      description:
        "Opens a search editor: a search in an editor tab, its results as a document (with context lines), saved as a .code-search file. Takes the query and options; without them, the Search view's current ones. Returns the tab and the result counts.",
      input: s.object({ ...queryInput, toSide: s.boolean().optional() }),
      effects: ["read"],
      run: async (input) => {
        const given = pick(input as Record<string, unknown>);
        const lines = services.settings.peek<number>(
          "search.searchEditor.defaultNumberOfContextLines",
        );
        const q = {
          ...EMPTY_QUERY,
          contextLines: typeof lines === "number" ? Math.max(0, Math.min(10, lines)) : 1,
          ...(Object.keys(given).length ? {} : (fromSidebar() ?? {})),
          ...given,
        };
        const tabId = dock.openView(
          VIEW,
          { path: null, query: q } as unknown as Json,
          input.toSide ? "right" : "main",
        );
        const view = views.get(tabId);
        if (view) view.focus();
        const counts = view && q.query ? await view.search() : { results: 0, files: 0 };
        return { tabId, ...counts };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "searchEditor.run",
      title: "Search again in search editor",
      category: "Search",
      description:
        "Runs the search of a search editor (default: the active one), with any of the query options changed. Returns the result counts and the first matches.",
      input: s.object({ ...queryInput, tab: s.string().optional() }),
      effects: ["read"],
      run: async (input) => {
        const t = target(input.tab);
        if (!t) throw new Error("No search editor is open (search.openEditor opens one).");
        const change = pick(input as Record<string, unknown>);
        if (Object.keys(change).length) t.view.setQuery(change);
        const counts = await t.view.search();
        return {
          tabId: t.id,
          ...counts,
          matches: t.view.files.slice(0, 20).map((f) => ({
            file: f.rel,
            lines: f.lines
              .filter((l) => l.ranges.length)
              .slice(0, 5)
              .map((l) => ({ line: l.line, text: l.text.slice(0, 200) })),
          })),
        };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "searchEditor.save",
      title: "Save search editor",
      category: "Search",
      description:
        "Saves a search editor (default: the active one) as a .code-search file (VS Code's format): `path`, else its file, else asked.",
      input: s.object({ tab: s.string().optional(), path: s.string().optional() }),
      effects: ["write"],
      run: async ({ tab, path }) => {
        const t = target(tab);
        if (!t) throw new Error("No search editor is open.");
        const saved = await t.view.save(path ? services.workspace.resolve(path) : undefined);
        return { saved };
      },
    }),
  );
  sub.add(
    state.register("ide://search/editor", {
      description:
        "The active (or last) search editor (D196): its query, result counts, file and the results as text (.code-search format, cut at 8000 characters).",
      get: () => {
        const t = target();
        if (!t) return null;
        return {
          tabId: t.id,
          path: t.view.path,
          query: t.view.query,
          results: t.view.results,
          files: t.view.files.length,
          searching: t.view.searching,
          text: t.view.text().slice(0, 8000),
        };
      },
    }),
  );
}
