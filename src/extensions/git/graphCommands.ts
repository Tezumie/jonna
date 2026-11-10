// The Graph section of Source control (D210): the view (always a section of scm.view, below
// Changes and above the Git tools extension's sections), its header buttons, and the commands
// behind it — go to HEAD, show more, the branch filter, and VS Code's Incoming / Outgoing
// changes (the commits a pull or push would bring and the files they change, each file's diff
// from the fork). State: ide://git/graph.

import type { DisposableStore } from "../../core/lifecycle/index";
import { resolveInRoot } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { rangeFiles } from "./changesTab";
import type { GitRepo } from "./controller";
import { ScmGraphView, SYNC_TITLES, type SyncDirection, syncCommand } from "./graphView";

export function registerGraph(sub: DisposableStore, services: WorkbenchServices, git: GitRepo) {
  const { dispatcher, views, state, quickInput } = services;
  let view: ScmGraphView | undefined;

  sub.add(
    views.register({
      id: "scm.graph",
      title: "Graph",
      icon: "git-graph",
      sectionOf: "scm.view",
      // Above the Git tools extension's sections (10–13).
      sectionOrder: 0,
      sectionOnly: true,
      sectionDefault: { collapsed: false, height: 300 },
      // Only with a repository: the "No repository" page has the view to itself (D254).
      sectionWhen: () => git.repo.value !== null,
      // Drag its header onto the dock, or view.moveView, for a tab of its own (D233).
      movable: true,
      actions: [
        {
          command: "git.graphFilter",
          icon: "list-filter",
          title: "Branches: the current one and its upstream, or all…",
          menu: true,
          // The choice as text, as VS Code's Graph header shows it.
          label: () => {
            services.settings.version.value;
            return services.settings.peek<boolean | undefined>("git.graph.allBranches") === true
              ? "All"
              : "Auto";
          },
        },
        { command: "git.revealHeadInGraph", icon: "target", title: "Go to the current commit" },
        { command: "git.fetch", icon: "cloud-download", title: "Fetch" },
        { command: "git.pull", icon: "arrow-down-to-dot", title: "Pull" },
        { command: "git.push", icon: "arrow-up-from-dot", title: "Push" },
        { command: "git.refresh", icon: "refresh-cw", title: "Refresh" },
      ],
      create(host) {
        const created = new ScmGraphView(host, services, git);
        view = created;
        return {
          focus: () => created.focus(),
          dispose: () => {
            created.dispose();
            if (view === created) view = undefined;
          },
        };
      },
    }),
  );

  /** Shows the Graph section (expanded) and waits for its view. */
  const showGraph = async (): Promise<ScmGraphView | undefined> => {
    await dispatcher.execute("view.show", { id: "scm.graph" });
    // The section creates its view when it renders expanded (the same task, or soon after; a
    // timer, not a frame: a window in the background may not paint).
    if (!view) await new Promise((r) => setTimeout(r, 50));
    return view;
  };

  sub.add(
    dispatcher.register({
      id: "git.revealHeadInGraph",
      title: "Go to the current commit in the graph",
      category: "Git",
      description: "Shows Source control's Graph section and selects HEAD's commit in it.",
      input: s.empty(),
      effects: [],
      when: "gitRepo",
      run: async () => ({ revealed: (await (await showGraph())?.revealHead()) ?? false }),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "git.graphShowMore",
      title: "Show more commits in the graph",
      category: "Git",
      description: "Lists 50 more commits in Source control's Graph.",
      input: s.empty(),
      effects: [],
      when: "gitRepo",
      run: async () => ({ commits: (await showGraph())?.showMoreHistory() ?? 0 }),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "git.graphFilter",
      title: "Choose the graph's branches…",
      category: "Git",
      description:
        "The Graph header's branch filter (VS Code's Auto / All): a menu at `x`, `y` (or a picker) to show the current branch with its upstream, or every branch. git.toggleGraphAllBranches sets it directly.",
      input: s.object({ x: s.number().optional(), y: s.number().optional() }),
      effects: [],
      agent: "hidden",
      run: async ({ x, y }, ctx) => {
        if (x !== undefined && y !== undefined && view) {
          view.filterMenu(x, y);
          return null;
        }
        if (ctx.caller.kind !== "user") return null;
        const all = services.settings.peek<boolean | undefined>("git.graph.allBranches") === true;
        const picked = await quickInput.pick(
          [
            { id: "auto", label: "Auto", description: "The current branch and its upstream" },
            { id: "all", label: "All branches", description: "Every branch, tag and remote" },
          ].map((i) => ({ ...i, ...(i.id === (all ? "all" : "auto") && { detail: "Shown now" }) })),
          { placeholder: "Branches in the graph" },
        );
        if (!picked) return null;
        return ctx.execute("git.toggleGraphAllBranches", { value: picked.id === "all" });
      },
    }),
  );

  // ---- Incoming / outgoing changes ------------------------------------------------------------
  const syncChanges = async (
    direction: SyncDirection,
    path: string | undefined,
    user: boolean,
    all = false,
  ) => {
    const repo = git.repo.peek();
    if (!repo) throw new Error("No repository.");
    const b = git.status.peek()?.branch;
    if (!b?.upstream)
      throw new Error("This branch has no upstream yet: publish it (git.sync) to compare.");
    const ipc = git.ipc;
    const [upstream, head, base] = await Promise.all([
      ipc.revParse("@{u}"),
      ipc.revParse("HEAD"),
      ipc.mergeBaseOf("HEAD", "@{u}"),
    ]);
    const tip = direction === "incoming" ? upstream : head;
    const [commits, files] = await Promise.all([
      ipc.logRange(direction === "incoming" ? "HEAD..@{u}" : "@{u}..HEAD", 200),
      tip === base ? Promise.resolve([]) : ipc.diffNames(base, tip),
    ]);
    const info = {
      direction,
      upstream: b.upstream,
      base,
      tip,
      commits: commits.map((c) => ({ hash: c.hash, subject: c.subject, author: c.author })),
      files: files.map((f) => ({
        status: f.status,
        path: f.path,
        ...(f.origPath && { from: f.origPath }),
      })),
    };
    const open = async (rel: string) => {
      const file = files.find((f) => f.path === rel);
      if (!file) throw new Error(`${SYNC_TITLES[direction]} don't change ${rel}.`);
      await dispatcher.execute("editor.openDiff", {
        path: resolveInRoot(repo.root, rel),
        base: `git:${base}${file.origPath ? `@${file.origPath}` : ""}`,
        baseLabel: `${base.slice(0, 7)} (where they forked)`,
        head: `git:${tip}`,
        headLabel: `${direction === "incoming" ? b.upstream : (b.head ?? "HEAD")} · ${SYNC_TITLES[direction].toLowerCase()}`,
      });
    };
    if (path) {
      await open(path);
      return info;
    }
    // Every file in one multi-file diff tab (VS Code's, D229).
    if (all) {
      await dispatcher.execute("editor.openMultiDiff", {
        title: `${SYNC_TITLES[direction]} · ${direction === "incoming" ? b.upstream : (b.head ?? "HEAD")}`,
        source: `git:${direction}:${repo.root}`,
        refresh: { command: syncCommand(direction), input: { all: true } },
        files: rangeFiles(repo.root, files, base, tip),
      });
      return info;
    }
    if (!user || !files.length) return info;
    const picked = await quickInput.pick(
      files.map((f) => ({
        id: f.path,
        label: f.path,
        description: f.origPath ? `${f.status} ← ${f.origPath}` : f.status,
        icon: "git-compare" as const,
      })),
      {
        placeholder: `${SYNC_TITLES[direction]}: ${commits.length} commit${commits.length === 1 ? "" : "s"} ${direction === "incoming" ? `on ${b.upstream}` : `to push to ${b.upstream}`} — pick a file to see its change`,
      },
    );
    if (picked) await open(picked.id);
    return info;
  };
  const syncInput = s.object({
    path: s.string().describe("A file they change (repo-relative): open its diff").optional(),
    all: s
      .boolean()
      .describe("Open every file they change in one multi-file diff tab (fork ↔ tip)")
      .optional(),
  });
  sub.add(
    dispatcher.register({
      id: "git.showOutgoingChanges",
      title: "Show outgoing changes…",
      category: "Git",
      description:
        "The commits on the current branch not on its upstream yet (what a push sends, @{u}..HEAD) and the files they change together since the branches forked. With `path`, opens that file's diff (fork ↔ HEAD); with `all`, every file in one multi-file diff tab; from the palette, pick a file. The Graph's Outgoing changes row.",
      input: syncInput,
      effects: ["read"],
      when: "gitRepo",
      agent: "discoverable",
      run: ({ path, all }, ctx) => syncChanges("outgoing", path, ctx.caller.kind === "user", all),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "git.showIncomingChanges",
      title: "Show incoming changes…",
      category: "Git",
      description:
        "The commits on the current branch's upstream not on the branch yet (what a pull brings, HEAD..@{u}; fetch first for the latest) and the files they change together since the branches forked. With `path`, opens that file's diff (fork ↔ upstream); with `all`, every file in one multi-file diff tab; from the palette, pick a file. The Graph's Incoming changes row.",
      input: syncInput,
      effects: ["read"],
      when: "gitRepo",
      agent: "discoverable",
      run: ({ path, all }, ctx) => syncChanges("incoming", path, ctx.caller.kind === "user", all),
    }),
  );

  sub.add(
    state.register("ide://git/graph", {
      description:
        "Source control's Graph section: whether it's shown, the branch filter, how many commits are listed, and the Outgoing / Incoming changes rows' commit counts (null: no such row).",
      get: () => ({
        shown: view !== undefined,
        allBranches: services.settings.peek<boolean | undefined>("git.graph.allBranches") === true,
        ...(view?.describe() ?? { commits: 0, outgoing: null, incoming: null, more: false }),
      }),
    }),
  );
}
