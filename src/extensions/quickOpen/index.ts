// Built-in Quick open (Ctrl/Cmd+P): go to a file by fuzzy name over the Rust workspace index,
// recently opened files first, `file:line[:col]` to jump, `:line` for the active editor. It is
// VS Code's quick access (quickAccess.ts, D133): ">" commands, "@" symbols, "#" workspace symbols,
// ":" line, "?" help.
// `quickOpen.search` is the same lookup for agents. Recent files persist per workspace. D251: a
// multi-root workspace's every folder, files named by workspace paths (the folder's name first).
import type { CommandInfo } from "../../core/dispatcher/index";
import type { BuiltinExtension } from "../../core/extensions/index";
import { indexIpc } from "../../core/ipc/fs";
import { pathKey } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { fuzzyMatch } from "../../ui/fuzzy";
import { fileIcon } from "../../ui/Icon";
import type { QuickPickItem } from "../../ui/QuickInput";
import type { WorkbenchServices } from "../../workbench/services";
import { symbolIcon } from "../editor/chrome";
import { rankCommands } from "./commandRank";
import manifest from "./extension.json";
import { indexItemFile, parseQuickOpen, pushRecent } from "./goto";
import { collectInput } from "./input";
import { type AccessItem, QuickAccessProviders } from "./providers";
import { groupByKind, PLACEHOLDERS, PREFIXES, parseAccess, parseLine } from "./quickAccess";
import { findWorkspaceSymbols, type SymbolScope } from "./workspaceSymbols";

const RESULTS = 60;
const MAX_RECENT_COMMANDS = 12;

interface FileItem extends QuickPickItem {
  /** Workspace path ("" for the go-to-line entry): the folder's name first in multi-root. */
  rel: string;
  /** The file, absolute (what opens it). */
  path: string;
}

/** A pick row for `rel`, splitting match positions between name (label) and folder. */
function fileItem(
  rel: string,
  path: string,
  positions: readonly number[],
  note?: string,
): FileItem {
  const slash = rel.lastIndexOf("/");
  const name = rel.slice(slash + 1);
  const dir = slash >= 0 ? rel.slice(0, slash) : "";
  const nameStart = slash + 1;
  return {
    id: rel,
    rel,
    path,
    label: name,
    description: note ? (dir ? `${dir} · ${note}` : note) : dir,
    labelHighlights: positions.filter((p) => p >= nameStart).map((p) => p - nameStart),
    descriptionHighlights: positions.filter((p) => p < slash),
    icon: fileIcon(name),
  };
}

export const quickOpenExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dispatcher, workspace, quickInput, dock, persistence, state, keyboard } = services;
    /** Absolute paths, most recent first. */
    let recent: string[] = [];
    /** Tab ids, most recently active first (Ctrl+Tab's order). */
    let tabOrder: string[] = [];

    sub.add(
      persistence.register("quickOpen", {
        // Workspace paths (D251: the folder's name first in multi-root), read back by resolve.
        save: () => {
          const root = workspace.root.peek();
          return { recent: root ? recent.map((p) => workspace.relative(p)) : [] };
        },
        restore: (data) => {
          const root = workspace.root.peek();
          const list = (data as { recent?: unknown } | null)?.recent;
          recent =
            root && Array.isArray(list)
              ? list
                  .filter((p): p is string => typeof p === "string")
                  .map((p) => workspace.resolve(p))
              : [];
        },
      }),
    );
    // Another folder's recent files don't carry over (its own come back with its state).
    sub.add(
      workspace.onDidClose(() => {
        recent = [];
      }),
    );
    // Remember editors as they become active.
    sub.add(
      effect(() => {
        dock.root.value;
        dock.focusedGroupId.value;
        const tab = dock.activeTab();
        if (tab && tabOrder[0] !== tab.id)
          tabOrder = [tab.id, ...tabOrder.filter((id) => id !== tab.id)].slice(0, 200);
        const path = (tab?.viewState as { path?: unknown } | null)?.path;
        const root = workspace.root.peek();
        // Files from outside the folder too (D190: they can be opened now); listed after its own.
        if (
          tab?.viewType === "editor" &&
          typeof path === "string" &&
          root &&
          !/^(untitled|virtual):/.test(path)
        ) {
          if (recent[0] !== path) {
            recent = pushRecent(recent, path);
            persistence.scheduleSave();
          }
        }
        return undefined;
      }),
    );

    /** Recent files matching `query` first, then the index (deduplicated). */
    const search = async (query: string, limit: number) => {
      const root = workspace.root.peek();
      if (!root) return { items: [] as FileItem[], indexing: false, total: 0 };
      // Same form as the Rust index: relative with "/" (Windows paths included).
      // The workspace's files first, then ones opened from elsewhere (D190).
      const ordered = [
        ...recent.filter((p) => workspace.contains(p)),
        ...recent.filter((p) => !workspace.contains(p)),
      ];
      const fromRecent = ordered
        .map((path) => {
          const rel = workspace.relative(path).replaceAll("\\", "/");
          return { path, rel, match: fuzzyMatch(query, rel) };
        })
        .filter((r) => r.match !== null)
        .slice(0, query ? 8 : 30)
        .map((r) => fileItem(r.rel, r.path, r.match?.positions ?? [], "recently opened"));
      if (!query) return { items: fromRecent, indexing: false, total: recent.length };
      // Every folder's files (D251: an item from a folder other than the first names its root).
      const result = await indexIpc.query(query, limit);
      const folders = workspace.folders.peek();
      const seen = new Set(fromRecent.map((i) => pathKey(i.path)));
      const rest = result.items
        .map((i) => indexItemFile(i, folders, root))
        .filter((f) => !seen.has(pathKey(f.path)))
        .map((f) => fileItem(f.rel, f.path, f.positions));
      return {
        items: [...fromRecent, ...rest].slice(0, limit),
        indexing: result.indexing,
        total: result.total,
      };
    };

    /** Most recently run commands, newest first, kept across sessions (D262, VS Code's). */
    const recentCommands: string[] = (persistence.globalState().recentCommands ?? [])
      .filter((id): id is string => typeof id === "string")
      .slice(0, MAX_RECENT_COMMANDS);
    const commandLabel = (c: CommandInfo) => (c.category ? `${c.category}: ${c.title}` : c.title);

    const providers = new QuickAccessProviders(services);

    const commandItems = (query: string): AccessItem[] => {
      const list = dispatcher
        .list()
        .filter((c) => c.palette && c.enabled && c.id !== "palette.show");
      const scored = list.flatMap((command) => {
        const text = commandLabel(command);
        const match = query ? fuzzyMatch(query, text) : { score: 0, positions: [] };
        return match ? [{ id: command.id, command, text, match }] : [];
      });
      // How well they match, then recently used first (VS Code's "recently used", D262), then
      // the score; "t" … "theme" puts Color theme first (commandRank.ts, D269).
      return rankCommands(query, scored, recentCommands)
        .slice(0, 200)
        .map(({ command, text, match }) => ({
          id: command.id,
          rel: "",
          kind: "command",
          command,
          label: text,
          labelHighlights: match.positions,
          ...(recentCommands.includes(command.id) && { description: "recently used" }),
          ...(keyboard.labelFor(command.id) && { keybinding: keyboard.labelFor(command.id) }),
        }));
    };

    const symbolItems = async (
      query: string,
      byKind = false,
    ): Promise<{ items: AccessItem[]; message?: string }> => {
      const outline = state.has("ide://editors/active/outline")
        ? ((await state.get("ide://editors/active/outline", { budget: 20000 })).value as {
            path: string;
            symbols: { name: string; kind: string; line: number; column: number; depth: number }[];
          } | null)
        : null;
      if (!outline) return { items: [], message: "Open an editor to go to its symbols" };
      // Grouped ("@:") rows aren't indented: a group mixes depths.
      const indent = !query && !byKind;
      const items = outline.symbols.flatMap((sym, i) => {
        const match = query ? fuzzyMatch(query, sym.name) : { score: 0, positions: [] };
        if (!match) return [];
        return [
          {
            id: `@${i}`,
            rel: outline.path,
            kind: "symbol" as const,
            symbolKind: sym.kind,
            label: `${"  ".repeat(indent ? sym.depth : 0)}${sym.name}`,
            labelHighlights: match.positions.map((p) => p + (indent ? sym.depth * 2 : 0)),
            description: sym.kind,
            icon: symbolIcon(sym.kind),
            line: sym.line,
            column: sym.column,
            score: match.score,
          },
        ];
      });
      if (query) items.sort((x, y) => y.score - x.score);
      const message = !outline.symbols.length ? "No symbols in this file (yet)" : undefined;
      if (!byKind) return { items, ...(message && { message }) };
      // "@:": VS Code's groups by kind ("functions (3)"), best matches first within each.
      const grouped = groupByKind(items.map((item) => ({ kind: item.symbolKind, item })));
      return {
        items: grouped.map((g) => ({
          ...g.item,
          ...(g.separator !== undefined && { separator: g.separator }),
        })),
        ...(message && { message }),
      };
    };

    /** Typing pauses this long before a workspace symbol search (each one reads the folder). */
    const SYMBOL_SEARCH_DELAY_MS = 150;
    let symbolRequest = 0;
    /** Where workspace symbols come from: the folder, or every folder of a multi-root workspace. */
    const symbolScope = (root: string): string | SymbolScope =>
      workspace.folders.peek().length > 1
        ? {
            contains: (p) => workspace.contains(p),
            relative: (p) => workspace.relative(p),
            multi: true,
          }
        : root;
    const workspaceSymbolItems = async (
      query: string,
    ): Promise<{ items: AccessItem[]; message?: string }> => {
      const root = workspace.root.peek();
      if (!root) return { items: [], message: "Open a folder to search its symbols" };
      if (!query.trim()) return { items: [], message: "Type the name of a symbol" };
      const id = ++symbolRequest;
      await new Promise((r) => setTimeout(r, SYMBOL_SEARCH_DELAY_MS));
      // A newer query is on its way; this one's results would be dropped anyway.
      if (id !== symbolRequest) return { items: [] };
      const found = await findWorkspaceSymbols(
        query,
        symbolScope(root),
        services.languageClients.clients.peek(),
        RESULTS,
        (q) => services.extensionFeatures.workspaceSymbols(q),
      );
      return {
        items: found.map((sym, i) => ({
          id: `#${i}`,
          rel: sym.rel,
          path: sym.path,
          kind: "symbol" as const,
          label: sym.name,
          labelHighlights: sym.positions,
          description: sym.container ? `${sym.container} · ${sym.rel}` : sym.rel,
          icon: symbolIcon(sym.kind),
          line: sym.line,
          column: sym.column,
        })),
        ...(!found.length && { message: "No matching symbols" }),
      };
    };

    sub.add(
      dispatcher.register({
        id: "quickOpen.show",
        title: "Go to file…",
        category: "Go",
        description:
          "Opens quick access (VS Code's): files by fuzzy name, `file:line[:col]`; with '>' commands, '@' symbols in the active editor ('@:' grouped by kind), '#' symbols in the workspace, ':' a line, '%' text in the files, 'view ' views, 'task ' tasks, 'debug ' launch configurations, 'term ' terminals, 'edt ' open editors, '?' help. Ctrl/Cmd+Enter opens the picked file to the side, → at the end of the text opens it in the background. `query` is the initial text (e.g. '>' for the command palette).",
        input: s.object({ query: s.string().describe("Initial text, e.g. '>' or '@'").optional() }),
        effects: [],
        agent: "hidden",
        run: async ({ query }, ctx) => {
          let parsed = parseQuickOpen("");
          const picked = await quickInput.pickDynamic<AccessItem>({
            placeholder: PLACEHOLDERS[parseAccess(query ?? "").mode],
            placeholderFor: (text) => PLACEHOLDERS[parseAccess(text).mode],
            value: query ?? "",
            // Ctrl/Cmd+Enter: a file (or a symbol's, a match's file) to the side; →: in the background.
            alternate: (item, how) => {
              if (!item.rel || !["file", "symbol", "action"].includes(item.kind)) return false;
              const at =
                item.kind === "file"
                  ? {
                      ...(parsed.line && { line: parsed.line }),
                      ...(parsed.column && { column: parsed.column }),
                    }
                  : item.line
                    ? { line: item.line, column: item.column ?? 1 }
                    : {};
              void ctx
                .execute("editor.openFile", {
                  path: item.path ?? item.rel,
                  ...at,
                  ...(how === "side" ? { toSide: true } : { preserveFocus: true }),
                })
                .catch((err: unknown) =>
                  services.notifications.show(
                    "error",
                    err instanceof Error ? err.message : String(err),
                  ),
                );
              return true;
            },
            load: async (text) => {
              const access = parseAccess(text);
              if (access.mode === "commands") return { items: commandItems(access.query) };
              if (access.mode === "symbols") return symbolItems(access.query, access.byKind);
              if (["text", "views", "tasks", "debug", "terminals", "editors"].includes(access.mode))
                return providers.load(access.mode, access.query, (id, input) =>
                  ctx.execute(id, input ?? {}),
                );
              if (access.mode === "workspaceSymbols") return workspaceSymbolItems(access.query);
              if (access.mode === "help")
                return {
                  items: [
                    { prefix: "", label: "Go to file" },
                    ...PREFIXES.filter((p) => p.mode !== "help"),
                  ].map((p) => ({
                    id: `?${p.prefix}`,
                    rel: "",
                    kind: "prefix" as const,
                    prefix: p.prefix,
                    label: p.prefix ? `${p.prefix}  ${p.label}` : `…  ${p.label}`,
                  })),
                };
              if (access.mode === "line") {
                const at = parseLine(access.query);
                return {
                  items: at
                    ? [
                        {
                          id: ":line",
                          rel: "",
                          kind: "line" as const,
                          label: `Go to line ${at.line}${at.column ? `, column ${at.column}` : ""}`,
                          icon: "chevron-right" as const,
                          line: at.line,
                          ...(at.column && { column: at.column }),
                        },
                      ]
                    : [],
                  ...(!at && { message: "Type a line number" }),
                };
              }
              if (!workspace.root.peek())
                return { items: [], message: "Open a folder to search its files (> for commands)" };
              parsed = parseQuickOpen(access.query);
              if (!parsed.file && parsed.line)
                return {
                  items: [
                    {
                      id: ":line",
                      rel: "",
                      kind: "line" as const,
                      label: `Go to line ${parsed.line}`,
                      icon: "chevron-right" as const,
                      line: parsed.line,
                      ...(parsed.column && { column: parsed.column }),
                    },
                  ],
                };
              const r = await search(parsed.file, RESULTS);
              const message = r.indexing && r.items.length === 0 ? "Indexing files…" : undefined;
              return {
                items: r.items.map((i) => ({ ...i, kind: "file" as const })),
                ...(message && { message }),
              };
            },
          });
          if (!picked) return { opened: null };
          if (picked.kind === "prefix")
            return ctx.execute("quickOpen.show", { query: picked.prefix ?? "" });
          if (picked.kind === "action") {
            await picked.run?.();
            return { ran: picked.id };
          }
          if (picked.kind === "line") {
            await ctx.execute("editor.gotoLine", {
              line: picked.line,
              ...(picked.column && { column: picked.column }),
            });
            return { opened: null };
          }
          if (picked.kind === "symbol") {
            await ctx.execute("editor.openFile", {
              path: picked.path ?? picked.rel,
              line: picked.line,
              column: picked.column ?? 1,
            });
            return { opened: picked.rel };
          }
          if (picked.kind === "command" && picked.command) {
            const input = await collectInput(picked.command.inputSchema, quickInput, picked.label);
            if (input === undefined) return { ran: null };
            const previous = recentCommands.indexOf(picked.id);
            if (previous >= 0) recentCommands.splice(previous, 1);
            recentCommands.unshift(picked.id);
            recentCommands.length = Math.min(recentCommands.length, MAX_RECENT_COMMANDS);
            void persistence.saveGlobal({ recentCommands: [...recentCommands] }).catch(() => {});
            await ctx.execute(picked.id, input);
            return { ran: picked.id };
          }
          await ctx.execute("editor.openFile", {
            path: picked.path ?? picked.rel,
            ...(parsed.line && { line: parsed.line }),
            ...(parsed.column && { column: parsed.column }),
          });
          return { opened: picked.rel };
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "quickOpen.goToSymbol",
        title: "Go to symbol in editor…",
        category: "Go",
        description: "Quick access with '@': the active editor's symbols (Ctrl/Cmd+Shift+O).",
        input: s.empty(),
        effects: [],
        agent: "hidden",
        run: (_input, ctx) => ctx.execute("quickOpen.show", { query: "@" }),
      }),
    );

    sub.add(
      dispatcher.register({
        id: "quickOpen.goToWorkspaceSymbol",
        title: "Go to symbol in workspace…",
        category: "Go",
        description: "Quick access with '#': declarations across the folder (Ctrl/Cmd+T).",
        input: s.empty(),
        effects: [],
        agent: "hidden",
        run: (_input, ctx) => ctx.execute("quickOpen.show", { query: "#" }),
      }),
    );
    for (const [id, title, prefix, what] of [
      [
        "quickOpen.openView",
        "Open view…",
        "view ",
        "views: the side bar's, the panels, extensions'",
      ],
      ["quickOpen.quickTextSearch", "Quick search…", "%", "text in the folder's files"],
      ["quickOpen.showEditors", "Show all editors…", "edt ", "open editors, by group"],
    ] as const)
      sub.add(
        dispatcher.register({
          id,
          title,
          category: "Go",
          description: `Quick access with '${prefix}': ${what}.`,
          input: s.empty(),
          effects: [],
          agent: "hidden",
          run: (_input, ctx) => ctx.execute("quickOpen.show", { query: prefix }),
        }),
      );

    // Ctrl+Tab (VS Code's editor switcher): open editors, most recently used first, the previous
    // one selected; Tab again moves on while Ctrl is held, releasing Ctrl opens the selection.
    let switching = false;
    sub.add(
      dispatcher.register({
        id: "quickOpen.switchEditor",
        title: "Switch editor…",
        category: "Go",
        description:
          "Picks an open editor, most recently used first (Ctrl+Tab; again to move on, release Ctrl to open). `back` starts from the least recent.",
        input: s.object({ back: s.boolean().optional() }),
        effects: [],
        agent: "hidden",
        run: async ({ back }, ctx) => {
          if (switching && quickInput.moveActive(back ? -1 : 1)) return { tabId: null };
          const tabs = dock.tabs().filter((t) => dock.isEditorLike(t));
          const rank = (id: string) => {
            const i = tabOrder.indexOf(id);
            return i < 0 ? Number.MAX_SAFE_INTEGER : i;
          };
          tabs.sort((a, b) => rank(a.id) - rank(b.id));
          if (tabs.length === 0) return { tabId: null };
          const items = tabs.map((t) => {
            const path = (t.viewState as { path?: unknown } | null)?.path;
            const title = dock.title(t);
            return {
              id: t.id,
              label: title,
              ...(typeof path === "string" && {
                description: workspace.contains(path) ? workspace.relative(path) : path,
                icon: fileIcon(title),
              }),
            };
          });
          switching = true;
          const picked = await quickInput
            .pick(items, {
              placeholder: "Switch to an open editor",
              matchOn: (i) => `${i.label} ${i.description ?? ""}`,
              activeIndex: back ? items.length - 1 : 1,
              acceptOnKeyUp: ["Control"],
            })
            .finally(() => {
              switching = false;
            });
          if (!picked) return { tabId: null };
          await ctx.execute("layout.focusTab", { tabId: picked.id });
          return { tabId: picked.id };
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "quickOpen.findSymbols",
        title: "Find symbols in workspace",
        category: "Go",
        description:
          "Finds declarations (functions, classes, types, structs, top-level constants…) by fuzzy name across the folder: running language servers' workspace symbols plus a search for declaration lines. Returns relative paths with 1-based lines and columns.",
        input: s.object({
          query: s.string().describe("Part of a symbol name, e.g. 'quickOpen'"),
          limit: s.integer({ min: 1, max: 200 }).describe("Max results (default 30)").optional(),
        }),
        effects: ["read"],
        when: "workspaceOpen",
        agent: "discoverable",
        palette: false,
        run: async ({ query, limit }) => {
          const root = workspace.root.peek();
          if (!root) throw new Error("No folder is open.");
          const found = await findWorkspaceSymbols(
            query,
            symbolScope(root),
            services.languageClients.clients.peek(),
            limit ?? 30,
            (q) => services.extensionFeatures.workspaceSymbols(q),
          );
          return {
            symbols: found.map(({ name, kind, rel, line, column, container }) => ({
              name,
              kind,
              path: rel,
              line,
              column,
              ...(container && { container }),
            })),
          };
        },
      }),
    );

    // A file picker for extensions (D183): quick open's fuzzy search over the project's files,
    // returning the choice instead of opening it (the canvas's "Add file…").
    sub.add(
      dispatcher.register({
        id: "quickOpen.pickFile",
        title: "Pick a file",
        category: "Go",
        description:
          "Asks the user to pick a project file with quick open's fuzzy search and returns its relative path (null when dismissed). `extensions` limits it to those endings, e.g. ['.png', '.jpg'].",
        input: s.object({
          placeholder: s.string().optional(),
          extensions: s.array(s.string()).optional(),
        }),
        effects: ["read"],
        when: "workspaceOpen",
        palette: false,
        run: async ({ placeholder, extensions }, ctx) => {
          // A person picks: an agent or an MCP client waiting on a picker would just hang.
          if (["agent", "acp", "mcp"].includes(ctx.caller.kind))
            throw new Error("quickOpen.pickFile asks the user; use quickOpen.search instead.");
          const endings = (extensions ?? []).map((e) => e.toLowerCase());
          const fits = (rel: string) =>
            !endings.length || endings.some((e) => rel.toLowerCase().endsWith(e));
          const picked = await quickInput.pickDynamic<FileItem>({
            placeholder: placeholder ?? "Search files by name",
            value: "",
            load: async (text) => {
              const r = await search(text, RESULTS * (endings.length ? 4 : 1));
              const items = r.items.filter((i) => fits(i.rel)).slice(0, RESULTS);
              // An empty box lists only recent files: say what to do rather than "no files".
              const message = items.length
                ? undefined
                : r.indexing
                  ? "Indexing files…"
                  : text.trim()
                    ? "No matching files"
                    : "Type part of a file name";
              return { items, ...(message && { message }) };
            },
          });
          return { path: picked?.rel ?? null };
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "quickOpen.search",
        title: "Find files",
        category: "Go",
        description:
          "Finds workspace files by fuzzy name (respects .gitignore), recently opened first. Returns relative paths; open one with editor.openFile.",
        input: s.object({
          query: s.string().describe("Part of a file name or path, e.g. 'explorer view'"),
          limit: s.integer({ min: 1, max: 200 }).describe("Max results (default 20)").optional(),
        }),
        effects: ["read"],
        when: "workspaceOpen",
        agent: "core",
        run: async ({ query, limit }) => {
          const r = await search(query, limit ?? 20);
          return { files: r.items.map((i) => i.rel), indexing: r.indexing, totalIndexed: r.total };
        },
      }),
    );

    sub.add(
      state.register("ide://workspace/recentFiles", {
        description: "Recently opened files in this workspace (relative paths, newest first).",
        get: () => {
          const root = workspace.root.peek();
          return root ? recent.slice(0, 30).map((p) => workspace.relative(p)) : [];
        },
      }),
    );
  },
};
