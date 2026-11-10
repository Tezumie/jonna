// The source control sidebar view (Ctrl/Cmd+Shift+G): the commit box (commitForm.ts), then the
// changes as a tree of sections (merge conflicts, staged, changes) with per-row and per-section
// actions on hover. Clicking a file opens its diff in a preview tab. The Graph is its own section
// below (graphView.ts, D210). Without a repository: Initialize or Publish to GitHub. Every action
// is a git.* command. D204: with several repositories in the folder, a list of them heads the view
// (VS Code's Source control repositories); the rest shows the selected one. A conflicted file has
// Resolve in merge editor. D220: with scm.repositories.selectionMode "multiple" (VS Code's), every
// repository's changes are in the one tree, each under a row of its own. D229: in that mode each
// shown repository has its own commit box, and the list's checkboxes choose which ones show.

import { h, on, replaceChildren } from "../../core/dom/index";
import { DisposableStore, MutableDisposable } from "../../core/lifecycle/index";
import { basename } from "../../core/paths/index";
import { effect, untracked } from "../../core/reactive/index";
import { fileIcon, type IconName, icon } from "../../ui/Icon";
import { showContextMenu } from "../../ui/Menu";
import { setTooltip } from "../../ui/Tooltip";
import { Tree } from "../../ui/Tree";
import type { WorkbenchServices } from "../../workbench/services";
import { CommitForm, type CommitText } from "./commitForm";
import type { GitController, GitRepo } from "./controller";
import {
  type Change,
  type ChangeGroup,
  changeColor,
  changeName,
  mergeEditorHandles,
} from "./model";
import type { GitRepositories } from "./repositories";

type Node =
  | { kind: "root" }
  /** A repository's row, in "multiple" mode. */
  | { kind: "repo"; repo: GitController }
  | { kind: "group"; group: ChangeGroup; repo: GitRepo }
  | { kind: "file"; change: Change; repo: GitRepo };

const GROUPS = ["merge", "staged", "changes"] as const;
const SECTIONS = GROUPS.map((g) => `#${g}`);

const GROUP_TITLES: Record<ChangeGroup, string> = {
  merge: "Merge changes",
  staged: "Staged changes",
  changes: "Changes",
};

/** The message boxes' texts, one per repository (`repo` default: the selected one). */
export interface CommitTexts {
  get(repo?: GitController): string;
  set(value: string, repo?: GitController): void;
  onChange(fn: () => void): { dispose(): void };
}

export class ScmView {
  private readonly store = new DisposableStore();
  private readonly tree: Tree<Node>;
  private readonly empty: HTMLElement;
  /** The commit box of the selected repository (single mode). */
  private readonly form: CommitForm;
  /** "multiple" mode: a commit box per shown repository. */
  private readonly forms: HTMLElement;
  private readonly repoForms = new Map<GitController, CommitForm>();
  private readonly treeHost: HTMLElement;
  /** The open menu (one at a time; replaced, not accumulated). */
  private readonly menuHandle = new MutableDisposable();

  constructor(
    host: HTMLElement,
    private readonly services: WorkbenchServices,
    private readonly git: GitRepo,
    private readonly texts: CommitTexts,
    private readonly repos?: GitRepositories,
  ) {
    const selectedText: CommitText = {
      get: () => texts.get(),
      set: (value) => texts.set(value),
      onChange: (fn) => texts.onChange(fn),
    };
    this.form = this.store.add(new CommitForm(services, git, selectedText));
    this.forms = h("div", { class: "scm-forms", hidden: true });
    this.store.add({
      dispose: () => {
        for (const f of this.repoForms.values()) f.dispose();
        this.repoForms.clear();
      },
    });
    this.treeHost = h("div", { class: "scm-tree" });
    const initButton = h(
      "button",
      { class: "button button-primary scm-empty-button", type: "button" },
      icon("git-branch"),
      "Initialize repository",
    );
    const publishButton = h(
      "button",
      { class: "button button-secondary scm-empty-button", type: "button" },
      icon("cloud-upload"),
      "Publish to GitHub",
    );
    const emptyText = h("div", { class: "empty-state-text" });
    // D392: the IDE's git is paused for this repository until its settings are trusted.
    const trustButton = h(
      "button",
      { class: "button button-primary scm-empty-button", type: "button", hidden: true },
      icon("shield"),
      "Trust git settings",
    );
    const publishText = h(
      "div",
      { class: "empty-state-text" },
      "Or publish it straight to a new GitHub repository: it's initialized, committed and pushed in one go.",
    );
    this.empty = h(
      "div",
      { class: "empty-state scm-empty" },
      h("span", { class: "empty-state-icon" }, icon("git-branch")),
      h("div", { class: "empty-state-title" }, "No repository"),
      emptyText,
      trustButton,
      initButton,
      publishText,
      publishButton,
    );
    this.repoList = h("div", {
      class: "scm-repos",
      role: "list",
      "aria-label": "Source control repositories",
      hidden: true,
    });
    host.append(this.repoList, this.empty, this.form.element, this.forms, this.treeHost);
    this.store.add(
      effect(() => {
        const all = this.repos?.all.value ?? [];
        const selected = this.repos?.selected.value;
        const shown = this.repos?.shown.value ?? [];
        services.settings.version.value;
        for (const r of all) {
          r.status.value;
          r.groups.value;
        }
        this.renderRepos(all, selected, shown);
        return undefined;
      }),
    );

    this.store.add(on(initButton, "click", () => this.run("git.init")));
    this.store.add(on(trustButton, "click", () => this.run("git.trustSettings")));
    this.store.add(on(publishButton, "click", () => this.run("git.publish")));

    this.tree = this.store.add(
      new Tree<Node>(
        this.treeHost,
        {
          id: (n) =>
            n.kind === "repo"
              ? `repo:${n.repo.repo.peek()?.root ?? ""}`
              : n.kind === "group"
                ? `${this.prefix(n.repo)}#${n.group}`
                : n.kind === "file"
                  ? `${this.prefix(n.repo)}${n.change.group}:${n.change.rel}`
                  : "",
          hasChildren: (n) => n.kind !== "file",
          children: async (n) => {
            if (n.kind === "root") {
              if (this.multiple()) return this.listed().map((repo) => ({ kind: "repo", repo }));
              return this.groupNodes(this.git);
            }
            if (n.kind === "repo") return this.groupNodes(n.repo);
            if (n.kind === "group")
              return n.repo.groups
                .peek()
                [n.group].map((change) => ({ kind: "file" as const, change, repo: n.repo }));
            return [];
          },
        },
        { render: (n, row, info) => this.renderRow(n, row, info.expanded) },
        { rowHeight: 22, ariaLabel: "Source control changes", sticky: true },
      ),
    );
    this.store.add(
      this.tree.onDidOpen(({ item, preserveFocus, preview }) => {
        if (item.kind !== "file") return;
        this.openDiff(item.change, preserveFocus, preview);
      }),
    );
    this.store.add(this.tree.onContextMenu(({ item, x, y }) => item && this.menu(item, x, y)));
    // "multiple" mode: selecting a repository's row (click, keys) makes it the selected one —
    // the message box commits there (VS Code's active repository).
    this.store.add(
      this.tree.onDidChangeSelection((item) => {
        if (item?.kind !== "repo" || item.repo === this.repos?.selected.peek()) return;
        const root = item.repo.repo.peek()?.root;
        if (root) this.run("git.selectRepository", { repository: root, show: false });
      }),
    );
    // Sections the user closes stay closed across refreshes; one that wasn't there yet (merge
    // changes) opens when it appears.
    let open = new Set<string>();
    this.store.add(
      this.tree.onDidChangeExpansion(() => {
        const now = new Set(this.tree.expandedIds());
        for (const id of this.sectionIds()) {
          if (now.has(id)) this.collapsed.delete(id);
          else if (open.has(id)) this.collapsed.add(id);
        }
        open = now;
      }),
    );

    this.store.add(
      effect(() => {
        const repo = git.repo.value;
        const problem = git.problem.value;
        const hasRoot = services.workspace.root.value !== null;
        services.settings.version.value;
        this.repos?.all.value;
        this.empty.hidden = repo !== null;
        // "multiple" mode: the boxes per repository instead of the selected one's.
        const multiple = this.multiple();
        this.form.element.hidden = repo === null || multiple;
        this.forms.hidden = repo === null || !multiple;
        this.treeHost.hidden = repo === null;
        emptyText.textContent = problem
          ? problem
          : hasRoot
            ? services.workspace.folders.value.length > 1
              ? "None of the workspace's folders has a git repository yet. Initialize one to track its changes, commit and branch."
              : "The open folder doesn't have a git repository yet. Initialize one to track its changes, commit and branch."
            : "Open a folder to see its changes.";
        initButton.hidden = !hasRoot || problem !== null;
        trustButton.hidden = !git.paused.value;
        publishButton.hidden = initButton.hidden;
        publishText.hidden = initButton.hidden;
        return undefined;
      }),
    );
    // The selected repository's changes refresh the tree.
    this.store.add(
      effect(() => {
        git.groups.value;
        void this.refreshTree();
        return undefined;
      }),
    );
    // "multiple" mode: every shown repository's changes (and the mode itself) refresh the tree,
    // and each shown repository gets its commit box.
    this.store.add(
      effect(() => {
        services.settings.version.value;
        const shown = this.repos?.shown.value ?? [];
        this.repos?.all.value;
        const multiple = this.multiple();
        if (multiple) for (const r of shown) r.groups.value;
        this.repos?.selected.value;
        // The boxes' own effects mustn't subscribe this one.
        untracked(() => this.syncForms(multiple ? shown : []));
        if (multiple !== this.wasMultiple) {
          this.wasMultiple = multiple;
          void this.tree.setRoot({ kind: "root" }, this.sectionIds());
        } else if (multiple) void this.refreshTree();
        return undefined;
      }),
    );
    void this.tree.setRoot({ kind: "root" }, this.sectionIds());
  }

  private wasMultiple = false;

  /**
   * "multiple" mode's commit boxes, one per shown repository in the list's order. Boxes of
   * repositories still shown are kept (a refresh mustn't take the caret out of one).
   */
  private syncForms(shown: readonly GitController[]): void {
    for (const [repo, form] of this.repoForms)
      if (!shown.includes(repo)) {
        form.dispose();
        form.element.remove();
        this.repoForms.delete(repo);
      }
    const elements: HTMLElement[] = [];
    for (const repo of shown) {
      let form = this.repoForms.get(repo);
      if (!form) {
        const text: CommitText = {
          get: () => this.texts.get(repo),
          set: (value) => this.texts.set(value, repo),
          onChange: (fn) => this.texts.onChange(fn),
        };
        form = new CommitForm(this.services, repo, text, {
          title: repo.name,
          activate: () => this.select(repo),
        });
        this.repoForms.set(repo, form);
      }
      elements.push(form.element);
    }
    // Reordered only when it changed: moving the focused box would blur it.
    const now = [...this.forms.children];
    if (now.length !== elements.length || now.some((el, i) => el !== elements[i]))
      this.forms.replaceChildren(...elements);
  }

  /** Makes `repo` the selected one (without showing the view again). */
  private async select(repo: GitController): Promise<void> {
    const root = repo.repo.peek()?.root;
    if (!root || repo === this.repos?.selected.peek()) return;
    await this.services.dispatcher
      .execute("git.selectRepository", { repository: root, show: false })
      .catch(() => {});
  }

  /**
   * VS Code's scm.repositories.selectionMode "multiple" with more than one repository: every
   * repository's changes in the tree, each under its own row.
   */
  private multiple(): boolean {
    return (
      this.services.settings.peek<string | undefined>("scm.repositories.selectionMode") ===
        "multiple" && (this.repos?.all.peek().length ?? 0) > 1
    );
  }

  /** The repositories the tree lists in "multiple" mode: the ticked ones. */
  private listed(): readonly GitController[] {
    return this.repos?.shown.peek() ?? [];
  }

  /** Tree ids are per repository in "multiple" mode (two repositories have a "Changes" each). */
  private prefix(repo: GitRepo): string {
    return this.multiple() ? (repo.repo.peek()?.root ?? "") : "";
  }

  /** The ids that start expanded and keep their collapsed state: sections (and repositories). */
  private sectionIds(): string[] {
    if (!this.multiple()) return SECTIONS;
    return this.listed().flatMap((r) => {
      const root = r.repo.peek()?.root ?? "";
      return [`repo:${root}`, ...SECTIONS.map((s) => `${root}${s}`)];
    });
  }

  private groupNodes(repo: GitRepo): Node[] {
    const g = repo.groups.peek();
    return GROUPS.filter((k) => g[k].length > 0 || k === "changes").map((group) => ({
      kind: "group" as const,
      group,
      repo,
    }));
  }
  private readonly repoList: HTMLElement;
  private readonly repoRows = this.store.add(new DisposableStore());

  /**
   * The repositories list (only with more than one): name, branch, changes; a click selects. In
   * "multiple" mode each has a checkbox: whether the tree and the commit boxes show it (VS Code's
   * selection in its Repositories view).
   */
  private renderRepos(
    all: readonly GitController[],
    selected: GitController | undefined,
    shown: readonly GitController[],
  ): void {
    this.repoRows.clear();
    const multiple =
      this.services.settings.peek<string | undefined>("scm.repositories.selectionMode") ===
      "multiple";
    this.repoList.hidden = all.length < 2;
    this.repoList.classList.toggle("is-multiple", multiple);
    if (all.length < 2) {
      this.repoList.replaceChildren();
      return;
    }
    const rows = all.map((r) => {
      const root = r.repo.peek()?.root ?? "";
      const b = r.status.peek()?.branch;
      const g = r.groups.peek();
      const n = g.staged.length + g.changes.length + g.merge.length;
      const branch = b?.head ?? (b?.oid ? `${b.oid.slice(0, 7)}` : "");
      const sync = b?.upstream && (b.ahead || b.behind) ? ` ↓${b.behind} ↑${b.ahead}` : "";
      const isSelected = r === selected;
      const isShown = shown.includes(r);
      let check: HTMLInputElement | null = null;
      if (multiple) {
        check = h("input", {
          type: "checkbox",
          class: "checkbox scm-repo-check",
          "aria-label": `Show ${r.name} in source control`,
        });
        check.checked = isShown;
        const box = check;
        setTooltip(box, isShown ? `Hide ${r.name}'s changes` : `Show ${r.name}'s changes`);
        this.repoRows.add(on(box, "click", (e) => e.stopPropagation()));
        this.repoRows.add(
          on(box, "change", () =>
            this.run("git.toggleRepositoryShown", { repository: root, shown: box.checked }),
          ),
        );
      }
      const row = h(
        "div",
        {
          class: `scm-repo-row${isSelected ? " is-selected" : ""}${multiple && !isShown ? " is-hidden-repo" : ""}`,
          role: "listitem",
          tabindex: "0",
          "aria-current": isSelected ? "true" : "false",
          "data-repo": root,
        },
        check,
        icon(r.kind === "submodule" ? "box" : "git-branch"),
        h("span", { class: "scm-repo-name" }, r.name),
        h("span", { class: "scm-repo-branch" }, `${branch}${sync}`),
        n ? h("span", { class: "search-count" }, String(n)) : null,
      );
      setTooltip(
        row,
        `${root}${r.kind !== "workspace" ? ` (${r.kind})` : ""} · ${branch || "no branch"}${n ? ` · ${n} pending` : ""}`,
      );
      // "multiple" mode: selecting keeps focus here (the tree and the boxes show it already).
      const select = () =>
        this.run("git.selectRepository", { repository: root, ...(multiple && { show: false }) });
      this.repoRows.add(on(row, "click", select));
      this.repoRows.add(on(row, "keydown", (e) => e.key === "Enter" && select()));
      this.repoRows.add(
        on(row, "contextmenu", (e) => {
          e.preventDefault();
          const input = { repository: root };
          this.menuHandle.value = showContextMenu(e.clientX, e.clientY, [
            { label: "Pull", icon: "arrow-down", run: () => this.run("git.pull", input) },
            { label: "Push", icon: "arrow-up", run: () => this.run("git.push", input) },
            { label: "Fetch", icon: "cloud-download", run: () => this.run("git.fetch", input) },
            {
              label: "Checkout branch…",
              icon: "git-branch",
              separatorBefore: true,
              run: () => this.run("git.checkout", input),
            },
            { label: "Refresh", icon: "refresh-cw", run: () => this.run("git.refresh", input) },
            ...(multiple
              ? [
                  {
                    label: isShown ? "Hide in source control" : "Show in source control",
                    icon: (isShown ? "eye-off" : "eye") as IconName,
                    separatorBefore: true,
                    run: () =>
                      this.run("git.toggleRepositoryShown", { repository: root, shown: !isShown }),
                  },
                ]
              : []),
          ]);
        }),
      );
      return row;
    });
    this.repoList.replaceChildren(h("div", { class: "scm-repos-title" }, "Repositories"), ...rows);
  }

  /** Focuses the selected repository's message box. */
  focus(): void {
    if (!this.form.element.hidden) {
      this.form.focus();
      return;
    }
    const selected = this.repos?.selected.peek();
    const form = (selected && this.repoForms.get(selected)) ?? [...this.repoForms.values()][0];
    form?.focus();
  }

  private async refreshTree(): Promise<void> {
    const expanded = new Set(this.tree.expandedIds());
    await this.tree.refresh();
    // New sections start expanded.
    await this.tree.expandMany(
      this.sectionIds().filter((id) => !expanded.has(id) && !this.collapsed.has(id)),
    );
  }

  /** Sections the user collapsed (kept collapsed across refreshes). */
  private readonly collapsed = new Set<string>();

  private openDiff(change: Change, preserveFocus = false, preview = true): void {
    // Both deleted: there's no file to show (staging confirms the deletion).
    if (change.conflict === "bothDeleted") return;
    if (change.conflict) {
      this.run("editor.openFile", { path: change.path, preserveFocus, preview });
      return;
    }
    if (change.untracked || change.letter === "D") {
      if (change.letter !== "D")
        this.run("editor.openFile", { path: change.path, preserveFocus, preview });
      else
        this.run("editor.openDiff", { path: change.path, staged: false, preserveFocus, preview });
      return;
    }
    this.run("editor.openDiff", {
      path: change.path,
      staged: change.group === "staged",
      preserveFocus,
      preview,
    });
  }

  private actionButton(
    name: IconName,
    title: string,
    command: string,
    input: unknown,
  ): HTMLElement {
    const b = h("button", { class: "icon-button scm-row-action", type: "button" }, icon(name));
    setTooltip(b, title, command);
    // The tree acts on mousedown (select, toggle) and re-renders the row, which would swallow
    // the click: keep the press to the button.
    b.addEventListener("mousedown", (e) => e.stopPropagation());
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      this.run(command, input);
    });
    return b;
  }

  private renderRow(n: Node, row: HTMLElement, expanded: boolean): void {
    row.classList.add("scm-row");
    // Rows are reused for other items: only commit rows have a hover card, and a tooltip set
    // for an earlier item mustn't stay.
    delete row.dataset.commit;
    delete row.dataset.tooltip;
    delete row.dataset.tooltipPlacement;
    delete row.dataset.tooltipCommand;
    row.removeAttribute("aria-label");
    delete row.dataset.repo;
    row.classList.remove("scm-repo-node", "is-selected");
    if (n.kind === "repo") {
      const r = n.repo;
      const root = r.repo.peek()?.root ?? "";
      const b = r.status.peek()?.branch;
      const g = r.groups.peek();
      const count = g.staged.length + g.changes.length + g.merge.length;
      const branch = b?.head ?? (b?.oid ? b.oid.slice(0, 7) : "");
      const sync = b?.upstream && (b.ahead || b.behind) ? ` ↓${b.behind} ↑${b.ahead}` : "";
      const selected = r === this.repos?.selected.peek();
      row.classList.add("scm-group-row", "scm-repo-node");
      row.classList.toggle("is-selected", selected);
      row.dataset.repo = root;
      setTooltip(
        row,
        `${root} · ${branch || "no branch"}${selected ? " · the message box commits here" : " · click to commit here"}`,
        undefined,
        { placement: "right", ariaLabel: false },
      );
      replaceChildren(
        row,
        icon(expanded ? "chevron-down" : "chevron-right"),
        icon(r.kind === "submodule" ? "box" : "git-branch"),
        h("span", { class: "scm-group-title scm-repo-name" }, r.name),
        h("span", { class: "search-file-dir scm-repo-branch" }, `${branch}${sync}`),
        h(
          "span",
          { class: "scm-row-actions" },
          this.actionButton("refresh-cw", "Refresh", "git.refresh", { repository: root }),
        ),
        count ? h("span", { class: "search-count" }, String(count)) : null,
      );
      return;
    }
    if (n.kind === "group") {
      const items = n.repo.groups.peek()[n.group];
      const paths = items.map((c) => c.path);
      const root = n.repo.repo.peek()?.root;
      // The group's own repository (not the selected one, in "multiple" mode).
      const repository = root ? { repository: root } : {};
      const actions =
        n.group === "staged"
          ? [
              this.actionButton(
                "git-compare",
                "View staged changes",
                "git.viewStagedChanges",
                repository,
              ),
              this.actionButton("minus", "Unstage all changes", "git.unstage", repository),
            ]
          : n.group === "merge"
            ? [
                this.actionButton("plus", "Stage all merge changes", "git.stage", {
                  paths,
                  ...repository,
                }),
              ]
            : items.length
              ? [
                  // VS Code's View all changes: one multi-file diff tab (D229).
                  this.actionButton(
                    "git-compare",
                    "View all changes",
                    "git.viewChanges",
                    repository,
                  ),
                  this.actionButton("undo-2", "Discard all changes", "git.discard", repository),
                  this.actionButton("plus", "Stage all changes", "git.stage", repository),
                ]
              : [];
      row.classList.add("scm-group-row");
      replaceChildren(
        row,
        icon(expanded ? "chevron-down" : "chevron-right"),
        h("span", { class: "scm-group-title" }, GROUP_TITLES[n.group]),
        h("span", { class: "scm-row-actions" }, ...actions),
        h("span", { class: "search-count" }, String(items.length)),
      );
      return;
    }
    if (n.kind !== "file") return;
    const c = n.change;
    const name = basename(c.path);
    const glyph = icon(fileIcon(name));
    const color = changeColor(c);
    // The merge editor for two versions or a delete / modify conflict (D209); both deleted and
    // added by one side (git's rename / rename) have nothing to merge: staging resolves them.
    const merges = c.conflict !== null && mergeEditorHandles(c.conflict);
    const dir = c.rel.includes("/") ? c.rel.slice(0, c.rel.lastIndexOf("/")) : "";
    const actions =
      c.group === "staged"
        ? [this.actionButton("minus", "Unstage changes", "git.unstage", { paths: [c.path] })]
        : c.group === "merge"
          ? [
              ...(merges
                ? [
                    this.actionButton(
                      "git-merge",
                      "Resolve in merge editor",
                      "git.openMergeEditor",
                      { path: c.path },
                    ),
                  ]
                : []),
              ...(c.conflict !== "bothDeleted"
                ? [this.actionButton("file", "Open file", "editor.openFile", { path: c.path })]
                : []),
              this.actionButton(
                "plus",
                c.conflict === "bothDeleted"
                  ? "Stage the deletion (mark resolved)"
                  : "Stage changes (mark resolved)",
                "git.stage",
                { paths: [c.path] },
              ),
            ]
          : [
              this.actionButton("file", "Open file", "editor.openFile", { path: c.path }),
              this.actionButton("undo-2", "Discard changes", "git.discard", { paths: [c.path] }),
              this.actionButton("plus", "Stage changes", "git.stage", { paths: [c.path] }),
            ];
    row.classList.toggle("is-struck", c.letter === "D");
    setTooltip(row, `${c.rel}${c.origRel ? ` ← ${c.origRel}` : ""} · ${changeName(c)}`, undefined, {
      placement: "right",
    });
    replaceChildren(
      row,
      glyph,
      h(
        "span",
        { class: "scm-file-name", style: color ? { color: `var(${color})` } : undefined },
        name,
      ),
      h("span", { class: "search-file-dir" }, dir),
      h("span", { class: "scm-row-actions" }, ...actions),
      h(
        "span",
        { class: "scm-badge", style: color ? { color: `var(${color})` } : undefined },
        c.letter,
      ),
    );
  }

  private menu(n: Node, x: number, y: number): void {
    if (n.kind !== "file") return;
    const c = n.change;
    const paths = [c.path];
    this.menuHandle.value = showContextMenu(x, y, [
      ...(c.conflict && mergeEditorHandles(c.conflict)
        ? [
            {
              label: "Resolve in merge editor",
              icon: "git-merge" as const,
              run: () => this.run("git.openMergeEditor", { path: c.path }),
            },
          ]
        : []),
      ...(c.conflict
        ? []
        : [
            {
              label: "Open changes",
              icon: "git-compare" as const,
              run: () => this.openDiff(c, false, false),
            },
          ]),
      ...(c.conflict === "bothDeleted"
        ? []
        : [
            {
              label: "Open file",
              icon: "file-input" as const,
              run: () => this.run("editor.openFile", { path: c.path }),
            },
          ]),
      c.group === "staged"
        ? {
            label: "Unstage changes",
            icon: "minus",
            separatorBefore: true,
            run: () => this.run("git.unstage", { paths }),
          }
        : {
            label: "Stage changes",
            icon: "plus",
            separatorBefore: true,
            run: () => this.run("git.stage", { paths }),
          },
      ...(c.group === "staged"
        ? []
        : [
            {
              label: "Discard changes",
              icon: "undo-2" as const,
              destructive: true,
              run: () => this.run("git.discard", { paths }),
            },
          ]),
      {
        label: "Reveal in explorer",
        icon: "locate",
        separatorBefore: true,
        run: () => this.run("explorer.reveal", { path: c.path }),
      },
      ...(c.untracked
        ? [
            {
              label: "Add to .gitignore",
              icon: "eye-off" as const,
              run: () => this.run("git.ignore", { paths }),
            },
          ]
        : []),
    ]);
  }

  private run(command: string, input: unknown = {}): void {
    void this.services.dispatcher.execute(command, input).catch(() => {});
  }

  dispose(): void {
    this.menuHandle.dispose();
    this.store.dispose();
  }
}
