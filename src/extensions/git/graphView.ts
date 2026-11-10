// Source control's Graph (D137, D148), its own resizable section below Changes since D210 (the
// sidebar section and sash the Git tools extension's sections use, VS Code's Graph view): the
// branch's history with its upstream (or every branch's), lanes colored like VS Code's
// scmGraph, refs as badges, a hover card per commit; VS Code's "Outgoing changes" row above HEAD
// when there are commits to push and "Incoming changes" above the fork when there are commits
// to pull, each expanding to the files they change together. A commit expands to its files,
// which open as the commit's diff. Every action is a git.* command.

import { h, replaceChildren } from "../../core/dom/index";
import type { ChangedFile, Commit, CommitDetail } from "../../core/ipc/git";
import { clipboardIpc } from "../../core/ipc/system";
import { DisposableStore, MutableDisposable } from "../../core/lifecycle/index";
import { basename, resolveInRoot } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { HoverCards } from "../../ui/HoverCard";
import { fileIcon, icon } from "../../ui/Icon";
import { showContextMenu, showMenu } from "../../ui/Menu";
import { setTooltip } from "../../ui/Tooltip";
import { Tree } from "../../ui/Tree";
import type { WorkbenchServices } from "../../workbench/services";
import { blameAge } from "./cloneBlame";
import type { GitRepo } from "./controller";
import {
  type BranchRefs,
  commitFilesQuery,
  type GraphItem,
  type GraphRow,
  layoutGraph,
  PromiseCache,
  refChipColor,
  refLabelColor,
  type SyncInfo,
  withSyncChanges,
} from "./graph";
import { commitHoverCard, refBadges } from "./graphHover";
import { continuingLanes, graphSvg, type Lane, lanesSvg } from "./graphSvg";
import { letterColor } from "./model";
import { commitUrl, parseRefs, type RefBadge, siteName, webUrl } from "./refs";

export type SyncDirection = "incoming" | "outgoing";

type Node =
  | { kind: "root" }
  | {
      kind: "commit";
      commit: Commit;
      incoming: boolean;
      outgoing: boolean;
      /** The commit's lanes in the graph (git.graph.enabled). */
      graph?: GraphRow;
    }
  /** VS Code's "Incoming changes" / "Outgoing changes" row: what a pull / push would bring. */
  | { kind: "sync"; direction: SyncDirection; count: number; upstream: string; graph?: GraphRow }
  | { kind: "commitFile"; hash: string; file: ChangedFile; lanes?: Lane[] }
  | { kind: "syncFile"; direction: SyncDirection; file: ChangedFile; lanes?: Lane[] }
  /** "Show more commits" at the end. */
  | { kind: "more"; lanes?: Lane[] };

/** Commits listed at first, and added by each "Show more". */
export const HISTORY_PAGE = 50;

/** The sync rows' names, as VS Code's (sentence case). */
export const SYNC_TITLES: Record<SyncDirection, string> = {
  incoming: "Incoming changes",
  outgoing: "Outgoing changes",
};

export class ScmGraphView {
  private readonly store = new DisposableStore();
  private readonly tree: Tree<Node>;
  private readonly treeHost: HTMLElement;
  private readonly empty: HTMLElement;
  /** The open menu (one at a time; replaced, not accumulated). */
  private readonly menuHandle = new MutableDisposable();
  private historyLimit = HISTORY_PAGE;
  /** The page size the end of the list last asked for the next page at (pageOnScroll). */
  private pagedAt = 0;
  /** The last listing and what it was for (HEAD, upstream, behind…): reused until that changes. */
  private history: { key: string; nodes: Node[] } | null = null;
  /** A commit's files and detail never change: read once per commit (the latest 200 kept). */
  private readonly files = new PromiseCache<ChangedFile[]>(200);
  private readonly details = new PromiseCache<CommitDetail>(200);
  /** The latest refresh (revealHead waits for it). */
  private loading: Promise<void> = Promise.resolve();

  constructor(
    host: HTMLElement,
    private readonly services: WorkbenchServices,
    private readonly git: GitRepo,
  ) {
    this.treeHost = h("div", { class: "scm-tree scm-graph-tree" });
    this.empty = h("div", { class: "scm-graph-empty", hidden: true });
    host.append(this.empty, this.treeHost);
    this.tree = this.store.add(
      new Tree<Node>(
        this.treeHost,
        {
          id: (n) =>
            n.kind === "commit"
              ? `${n.incoming ? "in" : "c"}:${n.commit.hash}`
              : n.kind === "sync"
                ? `sync:${n.direction}`
                : n.kind === "commitFile"
                  ? `cf:${n.hash}:${n.file.path}`
                  : n.kind === "syncFile"
                    ? `sf:${n.direction}:${n.file.path}`
                    : n.kind === "more"
                      ? "#more"
                      : "",
          hasChildren: (n) => n.kind === "root" || n.kind === "commit" || n.kind === "sync",
          label: (n) =>
            n.kind === "commit"
              ? n.commit.subject
              : n.kind === "sync"
                ? SYNC_TITLES[n.direction]
                : n.kind === "commitFile" || n.kind === "syncFile"
                  ? basename(n.file.path)
                  : "",
          children: async (n) => {
            if (n.kind === "root") return this.historyNodes();
            const row = n.kind === "commit" || n.kind === "sync" ? n.graph : undefined;
            const lanes = row ? continuingLanes(row) : undefined;
            if (n.kind === "commit") {
              const files = await this.commitFiles(n.commit);
              return files.map((file) => ({
                kind: "commitFile" as const,
                hash: n.commit.hash,
                file,
                ...(lanes && { lanes }),
              }));
            }
            if (n.kind === "sync") {
              const files = await this.syncFiles(n.direction);
              return files.map((file) => ({
                kind: "syncFile" as const,
                direction: n.direction,
                file,
                ...(lanes && { lanes }),
              }));
            }
            return [];
          },
        },
        { render: (n, row, info) => this.renderRow(n, row, info.expanded) },
        { rowHeight: 22, ariaLabel: "Graph", sticky: true },
      ),
    );
    this.store.add(
      this.tree.onDidOpen(({ item }) => {
        if (item.kind === "commitFile")
          this.run("git.openCommitFile", { commit: item.hash, path: item.file.path });
        else if (item.kind === "syncFile")
          this.run(syncCommand(item.direction), { path: item.file.path });
        else if (item.kind === "more") this.run("git.graphShowMore");
      }),
    );
    this.store.add(this.tree.onContextMenu(({ item, x, y }) => item && this.menu(item, x, y)));
    this.store.add(
      new HoverCards(
        this.treeHost,
        ".scm-row[data-commit]",
        (row, store) => this.commitCard(row, store),
        { label: "Commit details" },
      ),
    );
    this.loading = this.tree.setRoot({ kind: "root" }).then(() => this.updateEmpty());
    // What the listing depends on: HEAD, its upstream, ahead / behind, tags; every ref with all
    // branches shown.
    this.store.add(
      effect(() => {
        const repo = git.repo.value;
        git.status.value;
        git.repoState.value;
        services.settings.version.value;
        if (services.settings.peek<boolean | undefined>("git.graph.allBranches") === true)
          git.gitDirVersion.value;
        this.treeHost.hidden = repo === null;
        void this.refresh();
        return undefined;
      }),
    );
  }

  focus(): void {
    this.tree.focus();
  }

  /** Selects HEAD's commit (expanding it); false when it isn't listed. */
  async revealHead(): Promise<boolean> {
    await this.loading;
    const oid = this.git.status.peek()?.branch.oid;
    if (!oid) return false;
    for (const prefix of ["c", "in"]) {
      this.tree.reveal(`${prefix}:${oid}`);
      if (this.tree.selection?.kind === "commit" && this.tree.selection.commit.hash === oid) {
        this.tree.focus();
        return true;
      }
    }
    return false;
  }

  /** Lists another page of commits; returns how many are asked for now. */
  showMoreHistory(): number {
    this.historyLimit += HISTORY_PAGE;
    void this.refresh();
    return this.historyLimit;
  }

  /** What's listed now (ide://git/graph). */
  describe(): {
    commits: number;
    outgoing: number | null;
    incoming: number | null;
    more: boolean;
  } {
    const nodes = this.history?.nodes ?? [];
    const sync = (d: SyncDirection) =>
      nodes.find(
        (n): n is Extract<Node, { kind: "sync" }> => n.kind === "sync" && n.direction === d,
      )?.count ?? null;
    return {
      commits: nodes.filter((n) => n.kind === "commit").length,
      outgoing: sync("outgoing"),
      incoming: sync("incoming"),
      more: nodes.some((n) => n.kind === "more"),
    };
  }

  private refresh(): Promise<void> {
    const run = async () => {
      if (this.store.isDisposed) return;
      const key = this.historyKey();
      if (this.history?.key === key) return;
      await this.tree.refresh();
      this.updateEmpty();
    };
    this.loading = this.loading.then(run, run);
    return this.loading;
  }

  private updateEmpty(): void {
    if (this.store.isDisposed) return;
    const nodes = this.history?.nodes ?? [];
    this.empty.hidden = this.git.repo.peek() === null || nodes.length > 0;
    this.empty.textContent = this.git.status.peek()?.branch.oid
      ? "Nothing to show."
      : "No commits yet. Commit your changes to start the history.";
  }

  /** What the listing depends on (HEAD, upstream, tags, graph settings…). */
  private historyKey(): string {
    const branch = this.git.status.peek()?.branch;
    const settings = this.services.settings;
    const graph = settings.peek<boolean | undefined>("git.graph.enabled") !== false;
    const all = graph && settings.peek<boolean | undefined>("git.graph.allBranches") === true;
    // Refs change without HEAD moving (a tag, a renamed branch): they're part of the key.
    return `${this.git.repo.peek()?.root}|${this.historyLimit}|${branch?.oid}|${branch?.head}|${branch?.upstream}|${branch?.ahead}|${branch?.behind}|${this.git.repoState.peek()?.tags.join(",")}|${this.git.repoState.peek()?.baseBranch ?? ""}|${graph}|${all}|${all ? this.git.gitDirVersion.peek() : ""}`;
  }

  /** The current branch, its upstream and the base branch, for lane and chip colors. */
  private branchRefs(): BranchRefs {
    const b = this.git.status.peek()?.branch;
    return {
      head: b?.head ?? null,
      upstream: b?.upstream ?? null,
      detached: !b?.head,
      base: this.git.repoState.peek()?.baseBranch ?? null,
    };
  }

  private async historyNodes(): Promise<Node[]> {
    const key = this.historyKey();
    if (this.history?.key === key) return this.history.nodes;
    if (!this.git.repo.peek()) return [];
    const b = this.git.status.peek()?.branch;
    const settings = this.services.settings;
    const graph = settings.peek<boolean | undefined>("git.graph.enabled") !== false;
    const all = graph && settings.peek<boolean | undefined>("git.graph.allBranches") === true;
    const ipc = this.git.ipc;
    const behind = b?.upstream ? b.behind : 0;
    const ahead = b?.upstream ? (b.ahead ?? 0) : 0;
    const diverged = !!b?.upstream && (ahead > 0 || behind > 0);
    const range = (r: string, n: number) =>
      n > 0 ? ipc.logRange(r, this.historyLimit).catch(() => [] as Commit[]) : Promise.resolve([]);
    const limit = all ? this.historyLimit * 2 : this.historyLimit;
    const [listed, incoming, outgoing, upstreamTip, fork] = await Promise.all([
      graph
        ? ipc.graph(limit, all).catch(() => [] as Commit[])
        : ipc.log(this.historyLimit).catch(() => [] as Commit[]),
      range("HEAD..@{u}", behind),
      range("@{u}..HEAD", ahead),
      diverged ? ipc.revParse("@{u}").catch(() => null) : Promise.resolve(b?.oid ?? null),
      diverged ? ipc.mergeBaseOf("HEAD", "@{u}").catch(() => null) : Promise.resolve(null),
    ]);
    // Something changed while loading (a setting, HEAD): this listing is stale already.
    if (this.historyKey() !== key) return this.historyNodes();
    const inSet = new Set(incoming.map((c) => c.hash));
    const outSet = new Set(outgoing.map((c) => c.hash));
    const sync: SyncInfo = {
      head: b?.oid ?? null,
      upstream: b?.upstream ? upstreamTip : null,
      mergeBase: fork,
      incoming: inSet,
      ahead,
      behind,
    };
    this.sync = { mergeBase: fork, head: sync.head, upstream: sync.upstream };
    const upstream = b?.upstream ?? "";
    const commitNode = (commit: Commit, row?: GraphRow): Node => ({
      kind: "commit",
      commit,
      incoming: inSet.has(commit.hash),
      outgoing: outSet.has(commit.hash),
      ...(row && { graph: row }),
    });
    const syncNode = (direction: SyncDirection, count: number, row?: GraphRow): Node => ({
      kind: "sync",
      direction,
      count,
      upstream,
      ...(row && { graph: row }),
    });
    let nodes: Node[];
    let lastRow: GraphRow | undefined;
    if (graph) {
      const { items, graph: laid } = withSyncChanges(listed, sync);
      const byHash = new Map(listed.map((c) => [c.hash, c]));
      const branch = this.branchRefs();
      const rows = layoutGraph(laid, {
        labelColor: (hash) => {
          const c = byHash.get(hash);
          return c ? refLabelColor(c.refs, branch) : undefined;
        },
      });
      nodes = items.map((item: GraphItem<Commit>, i) =>
        item.kind === "commit"
          ? commitNode(item.commit, rows[i])
          : syncNode(item.kind, item.count, rows[i]),
      );
      lastRow = rows.at(-1);
    } else {
      // No lanes: what a pull brings first, then the branch with what a push sends on top.
      nodes = [
        ...(incoming.length ? [syncNode("incoming", behind)] : []),
        ...incoming.map((c) => commitNode(c)),
        ...(outgoing.length ? [syncNode("outgoing", ahead)] : []),
        ...listed.map((c) => commitNode(c)),
      ];
    }
    // A full page: there may be more.
    if (listed.length >= (graph ? limit : this.historyLimit))
      nodes.push({ kind: "more", ...(lastRow && { lanes: continuingLanes(lastRow) }) });
    this.history = { key, nodes };
    return nodes;
  }

  /** Where the last listing found HEAD, the upstream and their fork (for the sync rows' files). */
  private sync: { mergeBase: string | null; head: string | null; upstream: string | null } = {
    mergeBase: null,
    head: null,
    upstream: null,
  };

  /** The files a pull (incoming) or a push (outgoing) would change, from the fork. */
  private syncFiles(direction: SyncDirection): Promise<ChangedFile[]> {
    const { mergeBase, head, upstream } = this.sync;
    const tip = direction === "incoming" ? upstream : head;
    if (!mergeBase || !tip) return Promise.resolve([]);
    return this.git.ipc.diffNames(mergeBase, tip).catch(() => []);
  }

  /**
   * A commit's files (D233): one `git diff --name-status` against its first parent, not the
   * commit's detail (that one also diffs every file's content for the line counts: a commit with
   * many files took seconds to expand). A detail the hover card already read is reused.
   */
  private commitFiles(commit: Commit): Promise<ChangedFile[]> {
    return this.files
      .get(commit.hash, () => {
        const query = commitFilesQuery(commit);
        const cached = this.details.peek(commit.hash);
        if (cached) return cached.then((d) => d.files);
        return query.kind === "range"
          ? this.git.ipc.diffNames(query.left, query.right)
          : this.commitDetail(commit.hash).then((d) => d.files);
      })
      .catch(() => []);
  }

  /** A commit's detail (message, files, line counts), read once (the hover card's). */
  private commitDetail(hash: string): Promise<CommitDetail> {
    return this.details.get(hash, () => this.git.ipc.commitDetail(hash));
  }

  private renderRow(n: Node, row: HTMLElement, expanded: boolean): void {
    row.classList.add("scm-row");
    // Rows are reused for other items: only commit rows have a hover card, and a tooltip set
    // for an earlier item mustn't stay.
    delete row.dataset.commit;
    delete row.dataset.tooltip;
    delete row.dataset.tooltipPlacement;
    delete row.dataset.tooltipCommand;
    delete row.dataset.sync;
    row.removeAttribute("aria-label");
    row.classList.remove("is-incoming", "is-outgoing", "is-sync", "is-struck");
    if (n.kind === "commit") {
      this.commitRow(n, row, expanded);
      return;
    }
    if (n.kind === "sync") {
      const title = SYNC_TITLES[n.direction];
      row.classList.add("is-sync");
      row.dataset.sync = n.direction;
      const what = `${n.count} commit${n.count === 1 ? "" : "s"}`;
      setTooltip(
        row,
        n.direction === "outgoing"
          ? `${title}: ${what} not on ${n.upstream} yet. Expand for the files they change; Sync changes pushes them.`
          : `${title}: ${what} on ${n.upstream} not on this branch yet. Expand for the files they change; Sync changes pulls them.`,
        undefined,
        { placement: "right", ariaLabel: false },
      );
      replaceChildren(
        row,
        n.graph ? graphSvg(n.graph, "sync") : null,
        icon(expanded ? "chevron-down" : "chevron-right"),
        n.graph ? null : icon(n.direction === "incoming" ? "arrow-down" : "arrow-up"),
        h("span", { class: "scm-commit-subject scm-sync-title" }, title),
        h("span", { class: "search-count scm-sync-badge" }, String(n.count)),
        h("span", { class: "search-file-dir scm-commit-meta" }, n.upstream),
      );
      return;
    }
    if (n.kind === "more") {
      // Scrolled to the end (the row is rendered: in view or just below it): the next page, once
      // per page (VS Code's scm.graph.pageOnScroll).
      if (
        this.pagedAt !== this.historyLimit &&
        this.services.settings.peek<boolean | undefined>("git.graph.pageOnScroll") !== false
      ) {
        this.pagedAt = this.historyLimit;
        queueMicrotask(() => {
          if (!this.store.isDisposed) this.run("git.graphShowMore");
        });
      }
      replaceChildren(
        row,
        n.lanes ? lanesSvg(n.lanes) : null,
        icon("ellipsis"),
        h("span", { class: "scm-more" }, "Show more commits"),
      );
      setTooltip(row, `List ${HISTORY_PAGE} more`, "git.graphShowMore", {
        placement: "right",
        ariaLabel: false,
      });
      return;
    }
    if (n.kind === "commitFile" || n.kind === "syncFile") {
      const f = n.file;
      const name = basename(f.path);
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
      const color = letterColor(
        f.status === "A" ? "A" : f.status === "D" ? "D" : f.status === "R" ? "R" : "M",
      );
      row.classList.toggle("is-struck", f.status === "D");
      setTooltip(row, f.origPath ? `${f.path} ← ${f.origPath}` : f.path, undefined, {
        placement: "right",
        ariaLabel: false, // a recycled row: its text names it
      });
      replaceChildren(
        row,
        n.lanes ? lanesSvg(n.lanes) : null,
        icon(fileIcon(name)),
        h(
          "span",
          { class: "scm-file-name", style: color ? { color: `var(${color})` } : undefined },
          name,
        ),
        h("span", { class: "search-file-dir" }, dir),
        h(
          "span",
          { class: "scm-badge", style: color ? { color: `var(${color})` } : undefined },
          f.status,
        ),
      );
    }
  }

  private commitRow(
    n: Extract<Node, { kind: "commit" }>,
    row: HTMLElement,
    expanded: boolean,
  ): void {
    const c = n.commit;
    const glyph = n.incoming ? "arrow-down" : n.outgoing ? "arrow-up" : "git-commit-horizontal";
    row.classList.toggle("is-incoming", n.incoming);
    row.classList.toggle("is-outgoing", n.outgoing);
    // The hover card (not a tooltip) tells the rest; it finds the commit by this.
    row.dataset.commit = c.hash;
    const head = c.hash === this.git.status.peek()?.branch.oid;
    const branch = this.branchRefs();
    const all = this.services.settings.peek<boolean | undefined>("git.graph.allBranches") === true;
    const lane = n.graph?.color;
    // Chips in their lane's color in All branches mode, the base branch orange (VS Code's).
    const chipColor = (r: RefBadge) => (lane ? refChipColor(r, branch, lane, all) : null);
    replaceChildren(
      row,
      n.graph ? graphSvg(n.graph, head ? "head" : "commit") : null,
      icon(expanded ? "chevron-down" : "chevron-right"),
      n.graph ? null : icon(glyph),
      h("span", { class: "scm-commit-subject" }, c.subject || "(no message)"),
      h(
        "span",
        { class: "scm-refs" },
        ...refBadges(parseRefs(c.refs, this.git.repoState.peek()?.remotes ?? []), false, chipColor),
      ),
      h("span", { class: "search-file-dir scm-commit-meta" }, `${c.author} · ${blameAge(c.time)}`),
    );
  }

  /** The repository's page on its hosting site: origin's, else the first remote with one. */
  private webUrl(): string | null {
    const urls = this.git.repoState.peek()?.remoteUrls ?? [];
    const ordered = [...urls.filter((u) => u.name === "origin"), ...urls];
    for (const u of ordered) {
      const web = webUrl(u.url);
      if (web) return web;
    }
    return null;
  }

  /** The hover card of the commit row under the pointer. */
  private commitCard(row: HTMLElement, store: DisposableStore): Promise<HTMLElement | null> | null {
    const hash = row.dataset.commit;
    const node = this.history?.nodes.find(
      (n): n is Extract<Node, { kind: "commit" }> => n.kind === "commit" && n.commit.hash === hash,
    );
    if (!node) return null;
    const c = node.commit;
    return commitHoverCard(store, {
      commit: c,
      detail: this.commitDetail(c.hash).catch(() => null),
      refs: parseRefs(c.refs, this.git.repoState.peek()?.remotes ?? []),
      web: this.webUrl(),
      incoming: node.incoming,
      outgoing: node.outgoing,
      head: c.hash === this.git.status.peek()?.branch.oid,
      run: (command, input) => this.run(command, input),
      copy: (text) => {
        void clipboardIpc.writeText(text).then(
          () => this.services.notifications.show("info", "Copied the commit hash."),
          () => {},
        );
      },
    });
  }

  /** Whether a listed commit is in HEAD's history (the all-branches graph has others too). */
  private onCurrentBranch(hash: string): boolean {
    const nodes = this.history?.nodes ?? [];
    const parents = new Map<string, readonly string[]>();
    for (const n of nodes) if (n.kind === "commit") parents.set(n.commit.hash, n.commit.parents);
    const seen = new Set<string>();
    const todo = [this.git.status.peek()?.branch.oid ?? ""];
    while (todo.length) {
      const h = todo.pop() ?? "";
      if (h === hash) return true;
      if (seen.has(h) || !parents.has(h)) continue;
      seen.add(h);
      todo.push(...(parents.get(h) ?? []));
    }
    return false;
  }

  private menu(n: Node, x: number, y: number): void {
    if (n.kind === "commit") {
      this.commitContextMenu(n, x, y);
      return;
    }
    if (n.kind === "sync") {
      const pull = n.direction === "incoming";
      this.menuHandle.value = showContextMenu(x, y, [
        {
          label: "Open changes",
          icon: "git-compare",
          run: () => this.run(syncCommand(n.direction), { all: true }),
        },
        {
          label: "Open one file's changes…",
          icon: "file-diff",
          run: () => this.run(syncCommand(n.direction)),
        },
        {
          label: pull ? "Pull" : "Push",
          icon: pull ? "arrow-down-to-dot" : "arrow-up-from-dot",
          separatorBefore: true,
          run: () => this.run(pull ? "git.pull" : "git.push"),
        },
        { label: "Sync changes", icon: "refresh-cw", run: () => this.run("git.sync") },
      ]);
      return;
    }
    if (n.kind === "commitFile" || n.kind === "syncFile") {
      const open =
        n.kind === "commitFile"
          ? () => this.run("git.openCommitFile", { commit: n.hash, path: n.file.path })
          : () => this.run(syncCommand(n.direction), { path: n.file.path });
      this.menuHandle.value = showContextMenu(x, y, [
        { label: "Open changes", icon: "git-compare", run: open },
        {
          label: "Open file",
          icon: "file-input",
          run: () =>
            this.run("editor.openFile", {
              path: resolveInRoot(this.git.repo.peek()?.root ?? "", n.file.path),
            }),
        },
      ]);
    }
  }

  private commitContextMenu(n: Extract<Node, { kind: "commit" }>, x: number, y: number): void {
    const c = n.commit;
    const isHead = c.hash === this.git.status.peek()?.branch.oid;
    const web = this.webUrl();
    this.menuHandle.value = showContextMenu(x, y, [
      {
        label: "Open changes",
        icon: "git-compare",
        run: () => this.run("git.openCommitChanges", { commit: c.hash }),
      },
      {
        label: "Show commit…",
        icon: "git-commit-horizontal",
        run: () => this.run("git.showCommit", { commit: c.hash }),
      },
      {
        label: "Copy commit hash",
        icon: "copy",
        separatorBefore: true,
        run: () => void clipboardIpc.writeText(c.hash).catch(() => {}),
      },
      {
        label: "Copy commit message",
        icon: "copy",
        run: () => void clipboardIpc.writeText(c.subject).catch(() => {}),
      },
      ...(web
        ? [
            {
              label: `Open on ${siteName(web)}`,
              icon: "external-link" as const,
              run: () => this.run("ui.openLink", { url: commitUrl(web, c.hash) }),
            },
          ]
        : []),
      {
        label: "Checkout (detached)",
        separatorBefore: true,
        run: () => this.run("git.checkoutCommit", { commit: c.hash }),
      },
      {
        label: "Create branch from commit…",
        icon: "git-branch",
        run: () => this.run("git.createBranchFrom", { from: c.hash }),
      },
      ...(n.incoming
        ? []
        : [
            {
              label: "Cherry-pick",
              run: () => this.run("git.cherryPick", { commit: c.hash }),
            },
            {
              label: "Revert commit",
              icon: "undo-2" as const,
              run: () => this.run("git.revertCommit", { commit: c.hash }),
            },
            ...(this.onCurrentBranch(c.hash)
              ? [
                  {
                    label: "Interactive rebase from here…",
                    separatorBefore: true,
                    run: () => this.run("git.rebaseInteractive", { base: c.parents[0] ?? "root" }),
                  },
                ]
              : []),
          ]),
      ...(isHead
        ? [
            {
              label: "Undo last commit",
              icon: "undo-2" as const,
              separatorBefore: true,
              run: () => this.run("git.undoLastCommit"),
            },
          ]
        : []),
    ]);
  }

  /** The section header's branch filter (VS Code's "Auto" / "All"), at `x`, `y`. */
  filterMenu(x: number, y: number): void {
    const all = this.services.settings.peek<boolean | undefined>("git.graph.allBranches") === true;
    this.menuHandle.value = showMenu({ x, y }, [
      {
        label: "Auto (current branch and upstream)",
        checked: !all,
        run: () => this.run("git.toggleGraphAllBranches", { value: false }),
      },
      {
        label: "All branches",
        checked: all,
        run: () => this.run("git.toggleGraphAllBranches", { value: true }),
      },
    ]);
  }

  /**
   * Runs a command; the git.* ones that take `repository` get the Graph's (the selected one),
   * so none asks "Choose a repository" (D220).
   */
  private run(command: string, input: unknown = {}): void {
    const root = this.git.repo.peek()?.root;
    const withRepo =
      root && TAKES_REPOSITORY.has(command) && typeof input === "object" && input !== null
        ? { ...input, repository: root }
        : input;
    void this.services.dispatcher.execute(command, withRepo).catch(() => {});
  }

  dispose(): void {
    this.menuHandle.dispose();
    this.store.dispose();
  }
}

/** The commands the Graph runs that take a `repository` (the rest act on the selected one). */
const TAKES_REPOSITORY = new Set([
  "git.openCommitFile",
  "git.openCommitChanges",
  "git.showCommit",
  "git.checkoutCommit",
  "git.createBranchFrom",
  "git.cherryPick",
  "git.revertCommit",
  "git.rebaseInteractive",
  "git.undoLastCommit",
  "git.pull",
  "git.push",
  "git.sync",
]);

export function syncCommand(direction: SyncDirection): string {
  return direction === "incoming" ? "git.showIncomingChanges" : "git.showOutgoingChanges";
}
