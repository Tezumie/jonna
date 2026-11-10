// Quick access's word providers (VS Code's): "%" text in the files, "view " views, "task " tasks,
// "debug " launch configurations, "term " terminals, "edt " open editors. Each lists what the
// matching commands already know (tasks.list, debug.listConfigurations, ide://terminals, the
// dock, the views) and picks run those commands, so the box adds no behaviour of its own.
import type { CommandInfo } from "../../core/dispatcher/index";
import { type SearchEvent, searchIpc } from "../../core/ipc/fs";
import { fuzzyMatch } from "../../ui/fuzzy";
import { fileIcon, type IconName } from "../../ui/Icon";
import type { QuickPickItem } from "../../ui/QuickInput";
import type { WorkbenchServices } from "../../workbench/services";
import { chainSearches, planSearch } from "../search/folders";
import { effectiveOptions, type SearchSettings } from "../search/model";

export interface AccessItem extends QuickPickItem {
  /**
   * Workspace (or absolute) path of the file the row opens — the folder's name first in a
   * multi-root workspace; "" when it opens none.
   */
  rel: string;
  /** The file, absolute, when known (what opens it). */
  path?: string;
  kind: "file" | "line" | "command" | "symbol" | "prefix" | "action";
  command?: CommandInfo;
  line?: number;
  column?: number;
  prefix?: string;
  /** What an "action" row does when picked. */
  run?: () => Promise<unknown>;
}

export type Loaded = { items: AccessItem[]; message?: string };
type Execute = (command: string, input?: unknown) => Promise<unknown>;

const TEXT_RESULTS = 100;
/** Typing pauses this long before a text search (each one reads the folder). */
const TEXT_SEARCH_DELAY_MS = 200;

/** `rows` matching `query` by label (fuzzy), best first; all of them in order without a query. */
function filtered(query: string, rows: AccessItem[]): AccessItem[] {
  if (!query.trim()) return rows;
  const scored = rows.flatMap((row) => {
    const match = fuzzyMatch(query, `${row.label} ${row.description ?? ""}`);
    if (!match) return [];
    const inLabel = match.positions.filter((p) => p < row.label.length);
    return [{ row: { ...row, labelHighlights: inLabel }, score: match.score }];
  });
  scored.sort((a, b) => b.score - a.score);
  // A group's name stays on its first row only when nothing was reordered past it.
  return scored.map((s) => {
    const { separator: _separator, ...row } = s.row;
    return row;
  });
}

const action = (
  id: string,
  label: string,
  run: () => Promise<unknown>,
  extra: Partial<AccessItem> = {},
): AccessItem => ({ id, label, rel: "", kind: "action", run, ...extra });

export class QuickAccessProviders {
  private textRequest = 0;

  constructor(private readonly services: WorkbenchServices) {}

  load(mode: string, query: string, execute: Execute): Promise<Loaded> | Loaded {
    switch (mode) {
      case "text":
        return this.text(query);
      case "views":
        return { items: filtered(query, this.views(execute)) };
      case "tasks":
        return this.tasks(query, execute);
      case "debug":
        return this.debug(query, execute);
      case "terminals":
        return this.terminals(query, execute);
      case "editors":
        return this.editors(query, execute);
      default:
        return { items: [] };
    }
  }

  /**
   * "%": lines in the workspace's files (the search view's settings: excludes, smart case; in a
   * multi-root workspace every folder, each with its own, D251).
   */
  private async text(query: string): Promise<Loaded> {
    const { workspace } = this.services;
    const root = workspace.root.peek();
    if (!root) return { items: [], message: "Open a folder to search its files" };
    if (!query.trim()) return { items: [], message: "Type text to search for" };
    const id = ++this.textRequest;
    await new Promise((r) => setTimeout(r, TEXT_SEARCH_DELAY_MS));
    if (id !== this.textRequest) return { items: [] };
    const settingsAt = (at?: string): SearchSettings => {
      const get = <T>(key: string, fallback: T): T =>
        (at
          ? this.services.settings.peekAt<T | undefined>(key, at)
          : this.services.settings.peek<T | undefined>(key)) ?? fallback;
      return {
        filesExclude: get<Record<string, unknown>>("files.exclude", {}),
        searchExclude: get<Record<string, unknown>>("search.exclude", {}),
        useIgnoreFiles: get("search.useIgnoreFiles", true),
        followSymlinks: get("search.followSymlinks", true),
        smartCase: get("search.smartCase", false),
        maxResults: TEXT_RESULTS,
      };
    };
    const q = {
      query,
      isRegex: false,
      matchCase: false,
      wholeWord: false,
      include: [],
      exclude: [],
    };
    const folders = workspace.folders.peek();
    const multi = folders.length > 1;
    const runs = multi
      ? planSearch(folders, (f) => effectiveOptions(q, settingsAt(f.path), []))
      : [{ options: effectiveOptions(q, settingsAt(), []) }];
    const items: AccessItem[] = [];
    let truncated = false;
    await new Promise<void>((resolve, reject) => {
      const onEvent = (event: SearchEvent) => {
        if (event.kind === "done") {
          truncated = event.truncated;
          resolve();
          return;
        }
        // A workspace path (the folder's name first with several folders).
        const rel = multi ? workspace.relative(event.path) : event.rel;
        for (const m of event.matches) {
          const first = m.ranges[0];
          const lead = m.text.length - m.text.trimStart().length;
          items.push({
            id: `%${rel}:${m.line}:${items.length}`,
            rel,
            path: event.path,
            kind: "symbol",
            label: m.text.trim(),
            labelHighlights: m.ranges
              .flatMap(([s, e]) =>
                Array.from({ length: Math.max(0, e - s) }, (_, i) => s + i - lead),
              )
              .filter((p) => p >= 0),
            description: `${rel}:${m.line}`,
            icon: fileIcon(rel.slice(rel.lastIndexOf("/") + 1)),
            line: m.line,
            column: (first?.[0] ?? 0) + 1,
          });
        }
      };
      // Detached: the Search view's own search isn't cancelled by this one.
      const only = runs[0];
      const started =
        runs.length === 1 && only && !only.roots
          ? searchIpc.start({ ...only.options, maxResults: TEXT_RESULTS }, onEvent, true)
          : chainSearches(
              runs,
              onEvent,
              (options, sink, roots) => searchIpc.start(options, sink, true, undefined, roots),
              { isCurrent: () => id === this.textRequest, onError: reject },
            );
      started.catch(reject);
    });
    if (id !== this.textRequest) return { items: [] };
    const message = !items.length
      ? "No matching text"
      : truncated
        ? `The first ${TEXT_RESULTS} matches`
        : undefined;
    return { items, ...(message && { message }) };
  }

  /** "view ": side bar views, then the panels, then what extensions open. */
  private views(execute: Execute): AccessItem[] {
    const { views, dispatcher, extensionFeatures, context } = this.services;
    const sideBar = views.all.peek().map((v, i) =>
      action(`view:${v.id}`, v.title, () => execute("view.show", { id: v.id }), {
        icon: v.icon,
        ...(i === 0 && { separator: "Side bar" }),
      }),
    );
    const panels: [string, string, IconName][] = [
      ["Terminal", "terminal.toggle", "square-terminal"],
      ["Problems", "problems.show", "circle-alert"],
      ["Debug console", "debug.showConsole", "bug-play"],
      ["Agent", "layout.focusAgent", "agent"],
      ["Browser", "browser.open", "globe"],
      ["Settings", "settings.open", "settings"],
      ["Keyboard shortcuts", "keybindings.show", "keyboard"],
      ["Documentation", "help.showDocs", "book-open"],
    ];
    const panelItems = panels
      .filter(([, command]) => dispatcher.has(command))
      .map(([label, command, icon], i) =>
        action(`panel:${command}`, label, () => execute(command, {}), {
          icon,
          ...(i === 0 && { separator: "Panel" }),
        }),
      );
    const contributed = extensionFeatures
      .allOpeners((when) => context.matches(when))
      .map((o, i) =>
        action(`ext:${o.owner}:${o.command}`, o.title, () => execute(o.command, o.input ?? {}), {
          icon: (o.icon ?? "box") as IconName,
          ...(i === 0 && { separator: "Extensions" }),
        }),
      );
    return [...sideBar, ...panelItems, ...contributed];
  }

  /** "task ": the folder's tasks (tasks.list), running ones marked. */
  private async tasks(query: string, execute: Execute): Promise<Loaded> {
    if (!this.services.workspace.root.peek())
      return { items: [], message: "Open a folder to run its tasks" };
    const listed = (await execute("tasks.list", {})) as {
      tasks: {
        label: string;
        source: string;
        command: string;
        running: boolean;
        hide?: boolean;
        group?: string;
        default?: boolean;
      }[];
    };
    const rows = listed.tasks
      .filter((t) => !t.hide)
      .map((t) =>
        action(
          `task:${t.label}`,
          t.label,
          () => execute("tasks.run", { label: t.label, wait: false }),
          {
            description: [
              t.running ? "running" : "",
              t.group && t.default ? `default ${t.group} task` : "",
              t.source,
              t.command,
            ]
              .filter(Boolean)
              .join(" · "),
            icon: "square-terminal",
          },
        ),
      );
    const items = filtered(query, rows);
    return {
      items,
      ...(!rows.length && { message: "No tasks (add .vscode/tasks.json or package.json scripts)" }),
    };
  }

  /** "debug ": the launch configurations (debug.listConfigurations), then the active file's. */
  private async debug(query: string, execute: Execute): Promise<Loaded> {
    if (!this.services.workspace.root.peek())
      return { items: [], message: "Open a folder to debug it" };
    const listed = (await execute("debug.listConfigurations", {})) as {
      configurations: { name: string; type: string; request: string; source?: string }[];
      activeFile: { name: string; type: string; program?: string } | null;
    };
    const rows = listed.configurations.map((c) =>
      action(`debug:${c.name}`, c.name, () => execute("debug.start", { name: c.name }), {
        description: [c.type, c.request, c.source].filter(Boolean).join(" · "),
        icon: "bug-play",
      }),
    );
    const active = listed.activeFile;
    if (active?.program)
      rows.push(
        action(
          `debug-file:${active.program}`,
          active.name,
          () => execute("debug.start", { program: active.program }),
          {
            description: `${active.type} · the active file`,
            icon: "bug-play",
            separator: "Active file",
          },
        ),
      );
    if (this.services.dispatcher.has("debug.openLaunchJson"))
      rows.push(
        action("debug:add", "Add configuration…", () => execute("debug.openLaunchJson", {}), {
          icon: "settings",
          ...(rows.length > 0 && { separator: "launch.json" }),
        }),
      );
    return { items: filtered(query, rows) };
  }

  /** "term ": open terminals (ide://terminals), and a new one. */
  private async terminals(query: string, execute: Execute): Promise<Loaded> {
    const { state, workspace } = this.services;
    const value = state.has("ide://terminals")
      ? ((await state.get("ide://terminals", { budget: 20000 })).value as {
          terminals?: { id: number; title: string; cwd?: string | null; exited?: boolean }[];
        } | null)
      : null;
    const rows = (value?.terminals ?? []).map((t, i) =>
      action(
        `term:${t.id}`,
        `${i + 1}: ${t.title}`,
        () => execute("terminal.focus", { id: t.id }),
        {
          description: [
            t.exited ? "exited" : "",
            // A workspace path (D251: the folder's name first in multi-root).
            t.cwd ? (workspace.contains(t.cwd) ? workspace.relative(t.cwd) || "." : t.cwd) : "",
          ]
            .filter(Boolean)
            .join(" · "),
          icon: "square-terminal",
        },
      ),
    );
    rows.push(
      action("term:new", "Create new terminal", () => execute("terminal.create", {}), {
        icon: "plus",
        ...(rows.length > 0 && { separator: "" }),
      }),
    );
    return { items: filtered(query, rows) };
  }

  /** "edt ": open editors by group (most recent first in each), like VS Code's. */
  private editors(query: string, execute: Execute): Loaded {
    const { dock, workspace } = this.services;
    const tabs = dock.tabs().filter((t) => dock.isEditorLike(t));
    const groups: string[] = [];
    for (const t of tabs) {
      const group = dock.findTab(t.id)?.group.id;
      if (group && !groups.includes(group)) groups.push(group);
    }
    const rows: AccessItem[] = [];
    for (const [g, group] of groups.entries()) {
      const inGroup = tabs.filter((t) => dock.findTab(t.id)?.group.id === group);
      for (const [i, t] of inGroup.entries()) {
        const path = (t.viewState as { path?: unknown } | null)?.path;
        const title = dock.title(t);
        const file = typeof path === "string" && !/^(untitled|virtual):/.test(path);
        rows.push({
          ...action(`edt:${t.id}`, `${title}${dock.isDirty(t) ? " ●" : ""}`, () =>
            execute("layout.focusTab", { tabId: t.id }),
          ),
          // Files can open to the side too (Ctrl/Cmd+Enter).
          rel: file ? path : "",
          ...(typeof path === "string" && {
            description: workspace.contains(path) ? workspace.relative(path) : path,
            icon: fileIcon(title),
          }),
          ...(groups.length > 1 && i === 0 && { separator: `Group ${g + 1}` }),
        });
      }
    }
    return {
      items: filtered(query, rows),
      ...(!rows.length && { message: "No editors are open" }),
    };
  }
}
