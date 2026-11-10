// Built-in Search: workspace text search and replace (Rust grep-searcher, streamed), shown in the
// sidebar's search view. Commands: search.show (Ctrl/Cmd+Shift+F), search.run, search.replace,
// search.cancel, search.clear, search.dismiss, search.collapseAll/expandAll, search.copyResults,
// search.findInFolder, search.excludeFolder. Settings: search.* (exclude, ignore files, smart
// case, …). State: ide://search/last. D251: a multi-root workspace searches every folder (each
// with its own search.exclude / files.exclude; globs may start with a folder's name, folders.ts),
// and results go by workspace paths (the folder's name first).
import type { BuiltinExtension } from "../../core/extensions/index";
import { ChangedSinceError, type StepOptions } from "../../core/history/index";
import { fsIpc, historyIpc, type SearchEvent, searchIpc } from "../../core/ipc/fs";
import { clipboardIpc } from "../../core/ipc/system";
import { basename, isWithin, samePath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import manifest from "./extension.json";
import { chainSearches, planSearch, type SearchRun } from "./folders";
import {
  effectiveOptions,
  formatResults,
  type HistoryField,
  SearchModel,
  type SearchQuery,
  type SearchSettings,
  sameSearch,
} from "./model";
import { registerSearchEditor } from "./searchEditor";
import { SearchView } from "./view";

type SearchEventFile = Extract<SearchEvent, { kind: "file" }>;

/** How many matching lines `search.run` returns to its caller (the view shows everything). */
const RESULT_LINES_FOR_CALLER = 200;

export const searchExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dispatcher, views, state, workspace, events } = services;
    const model = new SearchModel();
    sub.add(model);
    let view: SearchView | undefined;

    sub.add(
      views.register({
        id: "search.view",
        title: "Search",
        icon: "search",
        command: "search.show",
        actions: [
          { command: "search.run", icon: "refresh-cw", title: "Search again" },
          { command: "search.openEditor", icon: "file-search", title: "Open in a search editor" },
          { command: "search.clear", icon: "circle-x", title: "Clear search results" },
          { command: "search.toggleViewMode", icon: "list-tree", title: "View as tree / list" },
          { command: "search.collapseAll", icon: "list-collapse", title: "Collapse all" },
          { command: "search.expandAll", icon: "list-chevrons-up-down", title: "Expand all" },
        ],
        create(host) {
          view = new SearchView(host, services, model);
          return view;
        },
      }),
    );
    // Each folder has its own history and view mode: none carried over from the last one (a
    // folder with nothing saved yet starts empty; restore fills it otherwise).
    const forget = () => {
      for (const h of Object.values(model.history)) h.replace([]);
      const mode =
        services.settings.peek<string>("search.defaultViewMode") === "tree" ? "tree" : "list";
      if (view) void view.setViewMode(mode);
      else model.viewMode = mode;
    };
    sub.add(
      workspace.onDidClose(() => {
        model.clear();
        forget();
      }),
    );
    // D251: a folder taken out of the workspace takes its results with it.
    sub.add(
      workspace.onDidChangeFolders(({ removed }) => {
        if (!removed.length) return;
        // A file stays while a folder still in the workspace holds it (folders may nest).
        const kept = workspace.folders
          .peek()
          .filter((f) => !removed.some((r) => samePath(r.path, f.path)));
        model.keepFiles(
          (file) =>
            kept.some((f) => isWithin(f.path, file.path)) ||
            !removed.some((r) => isWithin(r.path, file.path)),
        );
      }),
    );
    // The tree / list choice and what was typed in the fields (Up / Down), per folder (D172).
    model.viewMode =
      services.settings.peek<string>("search.defaultViewMode") === "tree" ? "tree" : "list";
    sub.add(
      services.persistence.register("search", {
        save: () => ({
          viewMode: model.viewMode,
          history: Object.fromEntries(
            Object.entries(model.history).map(([field, h]) => [field, h.entries]),
          ),
        }),
        restore: (data) => {
          const saved = (data ?? {}) as { viewMode?: unknown; history?: Record<string, unknown> };
          if (saved.viewMode === "tree" || saved.viewMode === "list") {
            if (view) void view.setViewMode(saved.viewMode);
            else model.viewMode = saved.viewMode;
          }
          // Filled in place: the open view holds these objects.
          for (const field of Object.keys(model.history) as HistoryField[]) {
            const list = saved.history?.[field];
            model.history[field].replace(
              Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [],
            );
          }
        },
      }),
    );

    const optionsInput = {
      query: s.string().describe("Text or regular expression").optional(),
      isRegex: s.boolean().describe("Treat query as a regular expression").optional(),
      matchCase: s.boolean().describe("Case-sensitive").optional(),
      wholeWord: s.boolean().describe("Match whole words only").optional(),
      include: s
        .array(s.string())
        .describe(
          "Globs to include, e.g. ['src', '*.ts']; in a multi-root workspace one starting with a folder's name ('api/**') searches that folder",
        )
        .optional(),
      exclude: s
        .array(s.string())
        .describe("Globs to exclude (a folder's name first: only in that folder)")
        .optional(),
      useExcludeSettings: s
        .boolean()
        .describe("Apply files.exclude, search.exclude and ignore files (default true)")
        .optional(),
      onlyOpenEditors: s.boolean().describe("Search only files open in editors").optional(),
      preserveCase: s
        .boolean()
        .describe("Replace keeps each match's case (UPPER, lower, Capitalized)")
        .optional(),
    };
    /** The query from input, falling back to the view's form, then the last search. */
    let lastQuery: SearchQuery | null = null;
    const resolveQuery = (input: Partial<SearchQuery>): SearchQuery => {
      const base: SearchQuery = view?.options() ??
        lastQuery ?? {
          query: "",
          isRegex: false,
          matchCase: false,
          wholeWord: false,
          include: [],
          exclude: [],
        };
      return {
        ...base,
        ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
      } as SearchQuery;
    };
    /** The search settings; `at`: a workspace folder's own (multi-root, D251). */
    const searchSettings = (at?: string): SearchSettings => {
      const get = <T>(key: string, fallback: T): T =>
        (at
          ? services.settings.peekAt<T | undefined>(key, at)
          : services.settings.peek<T | undefined>(key)) ?? fallback;
      return {
        filesExclude: get<Record<string, unknown>>("files.exclude", {}),
        searchExclude: get<Record<string, unknown>>("search.exclude", {}),
        useIgnoreFiles: get("search.useIgnoreFiles", true),
        followSymlinks: get("search.followSymlinks", true),
        smartCase: get("search.smartCase", false),
        maxResults: get("search.maxResults", 20000),
      };
    };
    /**
     * Workspace-relative paths of the files open in editor tabs (in a multi-root workspace the
     * folder's name first, so each is searched in its own folder; files outside every folder
     * can't be searched there and are left out).
     */
    const openEditors = (): string[] => {
      const multi = workspace.folders.peek().length > 1;
      const paths = services.dock
        .tabs("editor")
        .map((t) => (t.viewState as { path?: unknown } | null)?.path)
        .filter((p): p is string => typeof p === "string" && !p.startsWith("virtual:"))
        .filter((p) => !multi || workspace.contains(p))
        .map((p) => workspace.relative(p));
      return [...new Set(paths)];
    };
    const resolveOptions = (q: SearchQuery) => effectiveOptions(q, searchSettings(), openEditors());
    /**
     * The search calls for a query: one with one folder (as before); in a multi-root workspace
     * each folder gets its own settings and its share of folder-named globs (D251).
     */
    const resolveRuns = (q: SearchQuery): SearchRun[] => {
      const folders = workspace.folders.peek();
      if (folders.length < 2) return [{ options: resolveOptions(q) }];
      const editors = openEditors();
      return planSearch(folders, (f) => effectiveOptions(q, searchSettings(f.path), editors));
    };
    /** File results under their workspace paths (the folder's name first with several). */
    const relabel =
      (sink: (e: SearchEvent) => void) =>
      (e: SearchEvent): void => {
        if (e.kind === "file" && workspace.folders.peek().length > 1) {
          const rel = workspace.relative(e.path);
          sink(rel === e.path ? e : { ...e, rel });
        } else sink(e);
      };
    /** Bumped by each view search, cancel and clear: a chained search stops when overtaken. */
    let searchSeq = 0;
    const startRuns = (
      runs: readonly SearchRun[],
      sink: (e: SearchEvent) => void,
      onError: (err: unknown) => void,
      detached = false,
    ): Promise<void> => {
      // Bumped for a single run too: an older chain of runs must not start its next run (which
      // cancels the view's search in Rust) once this search has overtaken it.
      const mine = detached ? 0 : ++searchSeq;
      const only = runs[0];
      if (runs.length === 1 && only && !only.roots)
        return searchIpc.start(only.options, relabel(sink), detached);
      return chainSearches(
        runs,
        relabel(sink),
        (options, onEvent, roots) => searchIpc.start(options, onEvent, detached, undefined, roots),
        { isCurrent: () => detached || mine === searchSeq, onError },
      );
    };
    // Search editors (D196): the sidebar's query is where a new one starts.
    registerSearchEditor(
      sub,
      services,
      ({ contextLines: _, ...q }, sink, onError) =>
        startRuns(resolveRuns({ ...q, useExcludeSettings: true }), sink, onError, true),
      () => {
        if (!view) return null;
        const o = view.options();
        return {
          query: o.query,
          isRegex: o.isRegex,
          matchCase: o.matchCase,
          wholeWord: o.wholeWord,
          include: o.include,
          exclude: o.exclude,
        };
      },
    );

    sub.add(
      dispatcher.register({
        id: "search.show",
        title: "Search in files",
        category: "Search",
        description:
          "Shows the search view and focuses its query (prefilled with `query`, the editor selection, or with search.seedWithNearestWord the word at the cursor).",
        input: s.object({
          query: s.string().describe("Text to search for").optional(),
          include: s
            .array(s.string())
            .describe("Folders/globs to search in (workspace-relative)")
            .optional(),
        }),
        effects: [],
        agent: "hidden",
        run: async ({ query, include }, ctx) => {
          await ctx.execute("view.show", { id: "search.view" });
          if (include) view?.setOptions({ include });
          const selected =
            query ?? (state.has("ide://editors/active") ? await selectedText(services) : "");
          if (selected && view) {
            view.setOptions({ query: selected });
            await ctx.execute("search.run", { query: selected, wait: false });
          }
          view?.focus();
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "search.run",
        title: "Search workspace",
        category: "Search",
        description:
          "Searches file contents in the workspace (respects .gitignore, files.exclude and search.exclude unless useExcludeSettings is false). Results stream into the search view; by default waits and returns up to 200 matching lines with paths and line numbers.",
        input: s.object({
          ...optionsInput,
          maxResults: s
            .integer({ min: 1, max: 100000 })
            .describe("Stop after this many matches (default: search.maxResults)")
            .optional(),
          wait: s.boolean().describe("Wait for the search to finish (default true)").optional(),
        }),
        effects: ["read"],
        when: "workspaceOpen",
        agent: "core",
        run: async ({ wait, ...input }) => {
          const query = resolveQuery(input);
          const options = resolveOptions(query);
          if (!options.query) throw new Error("Type something to search for.");
          view?.setOptions(query);
          lastQuery = query;
          // A search asked for on purpose (a command, an agent) is remembered for Up / Down; the
          // view's search-as-you-type (wait: false) remembers on Enter, blur or an opened result.
          if (wait !== false) model.history.query.add(query.query);
          const sink = model.begin(options);
          if (query.onlyOpenEditors && !options.include.length) {
            model.fail("There are no open editors to search.");
            return wait === false ? { started: false } : summarize(model);
          }
          const failed = (err: unknown) =>
            model.fail(err instanceof Error ? err.message : String(err));
          await startRuns(resolveRuns(query), sink, failed).catch((err: unknown) => {
            failed(err);
            throw err;
          });
          if (wait === false) return { started: true };
          await model.whenDone();
          return summarize(model);
        },
      }),
    );

    // The agent's search tool (D306): every matching file with its lines and ranges, searched
    // apart from the view (the user's query, options and results stay as they are).
    sub.add(
      dispatcher.register({
        id: "search.find",
        title: "Find in files (results only)",
        category: "Search",
        description:
          "Searches file contents like search.run (gitignore, files.exclude and search.exclude apply) without touching the search view, and returns every matching file with its matching lines and match ranges, up to maxResults matches. `multiLine`: a regex may span lines and `.` matches line breaks.",
        input: s.object({
          query: s.string().describe("Text or regular expression"),
          isRegex: s.boolean().optional(),
          matchCase: s.boolean().optional(),
          wholeWord: s.boolean().optional(),
          include: s.array(s.string()).describe("Globs to include").optional(),
          exclude: s.array(s.string()).describe("Globs to exclude").optional(),
          multiLine: s.boolean().optional(),
          maxResults: s.integer({ min: 1, max: 100000 }).optional(),
        }),
        effects: ["read"],
        when: "workspaceOpen",
        agent: "discoverable",
        palette: false,
        run: async (input) => {
          if (!input.query) throw new Error("Give a query.");
          const query: SearchQuery = {
            query: input.query,
            isRegex: input.isRegex ?? false,
            matchCase: input.matchCase ?? false,
            wholeWord: input.wholeWord ?? false,
            include: input.include ?? [],
            exclude: input.exclude ?? [],
            ...(input.multiLine && { multiLine: true }),
            ...(input.maxResults !== undefined && { maxResults: input.maxResults }),
          };
          const files: { path: string; matches: SearchEventFile["matches"] }[] = [];
          let matches = 0;
          let truncated = false;
          // Set in the callbacks (a plain `null` would narrow to never after the await).
          let failure = null as string | null;
          await new Promise<void>((resolve) => {
            const failed = (err: unknown) => {
              failure = err instanceof Error ? err.message : String(err);
              resolve();
            };
            startRuns(
              resolveRuns(query),
              (e) => {
                if (e.kind === "file") files.push({ path: e.rel, matches: e.matches });
                else {
                  matches = e.matches;
                  truncated = e.truncated;
                  resolve();
                }
              },
              failed,
              true,
            ).catch(failed);
          });
          if (failure) throw new Error(failure);
          return { files, matches, truncated };
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "search.replace",
        title: "Replace in files",
        category: "Search",
        description:
          "Replaces every match of the current (or given) search with `replacement` in `paths` (default: all files with results), then searches again. `lines` limits it to matches on those lines (one result's Replace). Regex searches may use $1… in the replacement.",
        input: s.object({
          ...optionsInput,
          replacement: s.string().describe("Replacement text"),
          paths: s.array(s.string()).describe("Files to change (default: all results)").optional(),
          lines: s
            .array(s.integer({ min: 1 }))
            .describe("Only matches on these 1-based lines (with one path)")
            .optional(),
        }),
        effects: ["write", "destructive"],
        when: "workspaceOpen",
        agent: "discoverable",
        confirm: ({ paths, replacement, lines }) => {
          if (lines?.length)
            return `Replace the match${lines.length === 1 ? "" : "es"} on line${lines.length === 1 ? "" : "s"} ${lines.join(", ")} with "${replacement}"?`;
          const n = paths?.length ?? model.files.length;
          const m = paths ? undefined : model.matchCount;
          const what = m === undefined ? "all occurrences" : `${m} occurrence${m === 1 ? "" : "s"}`;
          return `Replace ${what} with "${replacement}" in ${n} file${n === 1 ? "" : "s"}?\n\nFiles are changed on disk; Undo (Edit menu or the explorer) reverts it.`;
        },
        run: async ({ replacement, paths, lines, ...input }, ctx) => {
          const query = resolveQuery(input);
          const options = resolveOptions(query);
          if (!options.query) throw new Error("Nothing to replace: run a search first.");
          // Replace what this query matches, not the results of an earlier, different search.
          if (!paths && !sameSearch(model.options, options))
            await ctx.execute("search.run", { ...query, wait: true });
          const targets = paths?.map((p) => workspace.resolve(p)) ?? model.files.map((f) => f.path);
          const result = await searchIpc.replace(
            { ...options, ...(lines?.length && { lines }) },
            replacement,
            targets,
          );
          for (const path of targets) events.emit("files.didChange", { path });
          // Workspace undo: every file back to its snapshot — all of them or none (D141): each
          // must still hold what this replace left (else nothing changes and it says which),
          // and a write failing half way puts the files already done back.
          const changes = result.changes.filter((c) => c.before && c.after);
          // The files this entry still covers: all, until the user chose to leave changed ones
          // out (D143) — those then keep their content through later undo / redo.
          let active = changes;
          const replay = async (to: "before" | "after", opts?: StepOptions) => {
            const expectOf = (c: (typeof changes)[number]) =>
              to === "before" ? c.afterHash : c.beforeHash;
            const changed: (typeof changes)[number][] = [];
            for (const c of active) if ((await fsIpc.hash(c.path)) !== expectOf(c)) changed.push(c);
            if (changed.length && !opts?.skipChanged)
              throw new ChangedSinceError(
                changed.map((c) => basename(c.path)),
                active.length,
              );
            const targets = active.filter((c) => !changed.includes(c));
            const done: (typeof changes)[number][] = [];
            try {
              for (const c of targets) {
                const id = to === "before" ? c.before : c.after;
                if (!id) continue;
                await historyIpc.restore(c.path, id, expectOf(c));
                done.push(c);
                events.emit("files.didChange", { path: c.path });
              }
            } catch (err) {
              for (const c of done.reverse()) {
                const back = to === "before" ? c.after : c.before;
                if (back) await historyIpc.restore(c.path, back).catch(() => {});
                events.emit("files.didChange", { path: c.path });
              }
              throw err;
            }
            active = targets;
          };
          if (result.skipped.length && ctx.caller.kind === "user")
            services.notifications.show(
              "warning",
              `${result.skipped.length} file${result.skipped.length === 1 ? " was" : "s were"} left unchanged (unreadable, too large to undo, or not writable): ${result.skipped
                .slice(0, 3)
                .map((p) => basename(p))
                .join(", ")}`,
            );
          if (changes.length)
            services.history.push({
              label: `Replace "${options.query}" with "${replacement}" in ${changes.length} file${changes.length === 1 ? "" : "s"}`,
              kind: "replace",
              paths: changes.map((c) => c.path),
              undo: (opts) => replay("before", opts),
              redo: (opts) => replay("after", opts),
            });
          await ctx.execute("search.run", { ...query, wait: true });
          return result;
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "search.cancel",
        title: "Cancel search",
        category: "Search",
        description: "Stops the running search (results so far stay).",
        input: s.empty(),
        effects: [],
        run: () => {
          searchSeq++;
          return searchIpc.cancel();
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "search.clear",
        title: "Clear search results",
        category: "Search",
        description: "Cancels any running search and clears the results.",
        input: s.empty(),
        effects: [],
        run: async () => {
          model.clear();
          searchSeq++;
          await searchIpc.cancel().catch(() => {});
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "search.dismiss",
        title: "Dismiss search result",
        category: "Search",
        description:
          "Hides one file's results, or one matching line (`line`), from the current results (VS Code's dismiss). Searching again brings them back.",
        input: s.object({
          path: s.string().describe("A result file, absolute or relative to the workspace root"),
          line: s.integer({ min: 1 }).describe("1-based line of the match to hide").optional(),
        }),
        effects: [],
        palette: false,
        run: ({ path, line }) => ({
          dismissed: model.dismiss(workspace.resolve(path), line),
        }),
      }),
    );
    sub.add(
      dispatcher.register({
        id: "search.toggleViewMode",
        title: "View search results as tree / list",
        category: "Search",
        description:
          "Shows the search results grouped by folder (tree) or as a flat list of files, like VS Code's View as tree. `mode` picks one; without it, it switches.",
        input: s.object({ mode: s.enum(["list", "tree"]).optional() }),
        effects: [],
        run: async ({ mode }) => {
          const next = mode ?? (model.viewMode === "tree" ? "list" : "tree");
          if (view) await view.setViewMode(next);
          else model.viewMode = next;
          services.persistence.scheduleSave();
          return { viewMode: next };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "search.collapseAll",
        title: "Collapse all search results",
        category: "Search",
        description: "Collapses every file in the search results.",
        input: s.empty(),
        effects: [],
        run: () => view?.collapseAll(),
      }),
    );
    sub.add(
      dispatcher.register({
        id: "search.toggleOption",
        title: "Toggle search option",
        category: "Search",
        description:
          "Flips one of the search view's toggles (match case, whole word, regex, preserve case, only open editors, use exclude settings) and searches again.",
        input: s.object({
          option: s.enum([
            "matchCase",
            "wholeWord",
            "isRegex",
            "preserveCase",
            "onlyOpenEditors",
            "useExcludeSettings",
          ] as const),
        }),
        effects: [],
        agent: "hidden",
        run: async ({ option }, ctx) => {
          await ctx.execute("view.show", { id: "search.view" });
          if (!view) throw new Error("The search view is not available.");
          return { [option]: view.toggle(option) };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "search.expandAll",
        title: "Expand all search results",
        category: "Search",
        description: "Expands every file in the search results.",
        input: s.empty(),
        effects: [],
        run: () => view?.expandAll(),
      }),
    );
    sub.add(
      dispatcher.register({
        id: "search.copyResults",
        title: "Copy search results",
        category: "Search",
        description:
          "Copies results to the clipboard as text: every result, one file's (`path`) or one line's (`path` and `line`). Returns the text.",
        input: s.object({
          path: s.string().describe("A result file, absolute or workspace-relative").optional(),
          line: s.integer({ min: 1 }).describe("1-based line of one match").optional(),
        }),
        effects: [],
        run: async ({ path, line }) => {
          const target = path && workspace.resolve(path);
          const files = model.files
            .filter((f) => !target || f.path === target)
            .map((f) => ({
              ...f,
              matches: line === undefined ? f.matches : f.matches.filter((m) => m.line === line),
            }))
            .filter((f) => f.matches.length);
          if (!files.length) throw new Error("No search results to copy.");
          const lineNumbers = services.settings.peek<boolean | undefined>("search.showLineNumbers");
          const text =
            line !== undefined
              ? files.flatMap((f) => f.matches.map((m) => m.text.trim())).join("\n")
              : formatResults(files, lineNumbers !== false);
          await clipboardIpc.writeText(text);
          return { copied: text.length > 2000 ? `${text.slice(0, 2000)}…` : text };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "search.findInFolder",
        title: "Find in folder",
        category: "Search",
        description:
          "Shows the search view limited to a folder (its files-to-include becomes `path`/**) and searches again if there is a query.",
        input: s.object({
          path: s.string().describe("Folder, absolute or workspace-relative"),
        }),
        effects: [],
        palette: false,
        run: async ({ path }, ctx) => {
          // D251: in a multi-root workspace the folder's name comes first ("api/src/**"), which
          // the search reads back as "in folder api"; a whole folder is its name ("api/**").
          const abs = workspace.resolve(path);
          const rel = workspace.contains(abs) ? workspace.relative(abs) : "";
          const include = rel && rel !== "." ? [`${rel}/**`] : [];
          await ctx.execute("search.show", { include });
          if (view?.options().query) await ctx.execute("search.run", { include, wait: false });
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "search.excludeFolder",
        title: "Exclude folder from search",
        category: "Search",
        description:
          "Adds a folder to the search view's files-to-exclude and searches again (this search only; search.exclude is the lasting setting).",
        input: s.object({
          path: s.string().describe("Folder, absolute or workspace-relative"),
        }),
        effects: [],
        palette: false,
        run: async ({ path }, ctx) => {
          const abs = workspace.resolve(path);
          const rel = workspace.contains(abs) ? workspace.relative(abs) : "";
          if (!rel || rel === ".") throw new Error("Pick a folder inside the workspace.");
          const exclude = [...new Set([...resolveQuery({}).exclude, `${rel}/**`])];
          view?.setOptions({ exclude });
          return ctx.execute("search.run", { exclude, wait: false });
        },
      }),
    );

    sub.add(
      state.register("ide://search/last", {
        description:
          "The last search: options, whether it is still running, counts and the top matches.",
        get: () =>
          model.options
            ? { options: model.options, viewMode: model.viewMode, ...summarize(model, 50) }
            : null,
      }),
    );
  },
};

function summarize(model: SearchModel, lines = RESULT_LINES_FOR_CALLER) {
  const results: { path: string; line: number; text: string }[] = [];
  for (const file of model.files) {
    for (const m of file.matches) {
      if (results.length >= lines) break;
      results.push({ path: file.rel, line: m.line, text: m.text.trim() });
    }
  }
  return {
    running: model.running,
    files: model.files.length,
    matches: model.matchCount,
    truncated: model.summary?.truncated ?? false,
    durationMs: model.summary?.durationMs,
    error: model.error,
    results,
  };
}

/**
 * The active editor's selection (single line), for prefilling the query; with no selection and
 * `search.seedWithNearestWord` on, the word at the cursor (D192).
 */
async function selectedText(services: WorkbenchServices): Promise<string> {
  const snapshot = await services.state.get("ide://editors/active").catch(() => null);
  const value = snapshot?.value as { selectedText?: unknown; wordAtCursor?: unknown } | null;
  return seedQuery(
    value?.selectedText,
    value?.wordAtCursor,
    services.settings.peek<boolean>("search.seedWithNearestWord") === true,
  );
}

/** Selection first (one line only), then the word at the cursor when the setting is on. */
export function seedQuery(selected: unknown, word: unknown, nearestWord: boolean): string {
  if (typeof selected === "string" && selected) return selected.includes("\n") ? "" : selected;
  return nearestWord && typeof word === "string" ? word : "";
}
