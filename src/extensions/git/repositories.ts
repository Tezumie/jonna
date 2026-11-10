// Several repositories in one folder (D204, VS Code's "Source control repositories"): the
// workspace's own plus the nested repositories and submodules found inside it, and in a multi-root
// workspace (D251) every other folder's repository and the ones inside it
// (git.repositoryScanMaxDepth, git.detectSubmodules). Each has its own controller; a path belongs
// to the deepest repository containing it (decorations, change bars, staging route by it). One
// repository is selected — it follows the active editor's file, or a click in the list — and the
// Source control view, the status bar and commands without a `repository` act on it. D220: the
// file index's watcher reports files changed on disk; each batch starts `git status` in the
// repositories it touches (VS Code watches files instead of polling).
import type { Caller } from "../../core/dispatcher/index";
import { Emitter } from "../../core/events/index";
import { indexIpc } from "../../core/ipc/fs";
import { gitIpc, type RepoInfo } from "../../core/ipc/git";
import type { Disposable } from "../../core/lifecycle/index";
import { DisposableStore, MutableDisposable } from "../../core/lifecycle/index";
import { isWithin, samePath } from "../../core/paths/index";
import { computed, effect, type ReadonlySignal, signal } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { GitController, type GitRepo } from "./controller";
import {
  deepestRoot,
  foldersWithoutRepository,
  matchRepository,
  pickerOrder,
  repositoriesTouched,
  repositoryFolderName,
  shownRepositories,
} from "./repoPaths";

export class GitRepositories implements Disposable {
  private readonly store = new DisposableStore();
  readonly primary: GitController;
  private readonly nested = signal<readonly GitController[]>([]);
  /** Every repository with an open repo, the workspace's first. */
  readonly all: ReadonlySignal<readonly GitController[]>;
  private readonly chosen = signal<GitController | null>(null);
  /** The repository the view, the status bar and commands act on. */
  readonly selected: ReadonlySignal<GitController>;
  /** The selected repository as one object whose signals follow the selection. */
  readonly current: GitRepo;
  private readonly discovered = this.store.add(new Emitter<void>());
  readonly onDidDiscover = this.discovered.event;
  private discoverToken = 0;
  /** Whether the file watcher reports this folder's changes (ide://git/repositories). */
  readonly watching = signal(false);
  private readonly diskListener = this.store.add(new MutableDisposable());
  private listenToken = 0;
  /**
   * Repositories the user unticked in "multiple" mode (VS Code's selection in its Repositories
   * view), by workspace-relative path ("." the folder's own); kept with the folder's state.
   */
  private readonly hidden = signal<ReadonlySet<string>>(new Set());
  /** The repositories Source control lists in "multiple" mode (never none). */
  readonly shown: ReadonlySignal<readonly GitController[]>;

  constructor(private readonly services: WorkbenchServices) {
    this.primary = this.store.add(new GitController(services, undefined, this.watching));
    this.all = computed(() => {
      const list: GitController[] = [];
      if (this.primary.repo.value) list.push(this.primary);
      for (const c of this.nested.value) if (c.repo.value) list.push(c);
      return list;
    });
    this.selected = computed(() => {
      const chosen = this.chosen.value;
      const all = this.all.value;
      if (chosen && all.includes(chosen)) return chosen;
      return all[0] ?? this.primary;
    });
    this.current = selectedRepository(this);
    this.shown = computed(() =>
      shownRepositories(
        this.all.value,
        this.hidden.value,
        (c) => this.keyOf(c),
        this.selected.value,
      ),
    );
    this.store.add(
      services.persistence.register("git.hiddenRepositories", {
        save: () => [...this.hidden.peek()],
        restore: (data) => {
          this.hidden.value = new Set(
            Array.isArray(data) ? data.filter((d): d is string => typeof d === "string") : [],
          );
        },
      }),
    );
    const { workspace, decorations, quickDiff, settings, events, dock } = services;
    this.store.add(
      decorations.register({
        decorate: (path, kind) => this.forPath(path)?.decorate(path, kind),
      }),
    );
    this.store.add(
      quickDiff.setProvider({
        original: async (path, base) => {
          const repo = this.forPath(path);
          const info = repo?.repo.peek();
          if (!repo || !info || isWithin(info.gitDir, path)) return null;
          return repo.original(path, base);
        },
      }),
    );
    // Found again when the folder or its repository changes, the settings change, or a
    // repository appears (`git init` in a subfolder).
    this.store.add(
      workspace.onDidOpen(() => {
        void this.listen();
        void this.discover();
      }),
    );
    this.store.add(workspace.onDidClose(() => (this.watching.value = false)));
    // D251: a folder added or removed live: its repositories come or go (the watcher covers the
    // new set of folders).
    this.store.add(
      workspace.onDidChangeFolders(() => {
        void this.listen();
        void this.discover();
      }),
    );
    this.store.add({ dispose: () => clearTimeout(this.discoverTimer) });
    if (workspace.root.peek()) void this.listen();
    // Nested repositories are looked for once the folder is trusted (git is off in restricted mode).
    let restricted = services.trust.state.peek() === "restricted";
    this.store.add(
      effect(() => {
        const now = services.trust.state.value === "restricted";
        if (now !== restricted) {
          restricted = now;
          void this.discover();
        }
        return undefined;
      }),
    );
    this.store.add(workspace.onDidClose(() => this.clearNested()));
    let lastPrimary: string | null | undefined;
    this.store.add(
      effect(() => {
        const root = this.primary.repo.value?.root ?? null;
        if (root !== lastPrimary) {
          lastPrimary = root;
          void this.discover();
        }
        return undefined;
      }),
    );
    this.store.add(
      settings.model.onDidChange((keys) => {
        if (
          keys.some(
            (k) =>
              k === "git.repositoryScanMaxDepth" ||
              k === "git.detectSubmodules" ||
              k === "git.repositoryScanIgnoredFolders",
          )
        )
          void this.discover();
      }),
    );
    this.store.add(
      events.on("files.didCreate", ({ path }) => {
        if (/[\\/]\.git$/.test(path)) void this.discover();
      }),
    );
    // The selection follows the active editor's file (VS Code's active repository).
    this.store.add(
      effect(() => {
        const tab = dock.activeTab();
        dock.root.value;
        const p = (tab?.viewState as { path?: unknown } | null)?.path;
        if (typeof p !== "string" || !p) return undefined;
        const repo = this.forPath(p);
        if (repo && repo !== this.selected.peek()) this.chosen.value = repo;
        return undefined;
      }),
    );
    this.store.add({ dispose: () => this.clearNested() });
  }

  /**
   * Hears the file index's watcher for the open folder (again after each folder open: the
   * folder is watched once it's open). Without it (no folder, watching failed, a browser
   * build), the controllers keep their 5 s poll.
   */
  /** A discovery after changes on disk: at most one every few seconds (it walks the folders). */
  private discoverTimer: ReturnType<typeof setTimeout> | undefined;
  private discoverSoon(): void {
    if (this.discoverTimer !== undefined || this.store.isDisposed) return;
    this.discoverTimer = setTimeout(() => {
      this.discoverTimer = undefined;
      if (!this.store.isDisposed) void this.discover();
    }, 3000);
  }

  private listening: Promise<void> = Promise.resolve();

  /**
   * One registration at a time: the file index keeps the last listener it was given, and two
   * in flight together (opening a folder fires both onDidOpen and onDidChangeFolders) could land
   * in either order. With the stale one last, Rust kept a listener this side had muted, and
   * Source control stopped hearing changes on disk (a deleted file stayed listed).
   */
  private listen(): Promise<void> {
    this.listening = this.listening.then(() => this.listenNow());
    return this.listening;
  }

  private async listenNow(): Promise<void> {
    const token = ++this.listenToken;
    try {
      const { watching, listener } = await indexIpc.watch((changes) => {
        const list = [this.primary, ...this.nested.peek()];
        const roots = list.map((c) => c.repo.peek()?.root ?? "");
        for (const i of repositoriesTouched(roots, changes)) list[i]?.changedOnDisk();
        // Files changed outside every nested repository (or more than listed): one may have
        // appeared (`git init` in a terminal; the watcher leaves `.git` itself out), D264.
        const nestedRoots = roots.slice(1).filter(Boolean);
        if (changes.overflow || changes.paths.some((p) => !nestedRoots.some((r) => isWithin(r, p))))
          this.discoverSoon();
      });
      if (token !== this.listenToken || this.store.isDisposed) {
        listener.dispose();
        return;
      }
      this.diskListener.value = listener;
      this.watching.value = watching;
    } catch {
      if (token === this.listenToken) this.watching.value = false;
    }
  }

  /**
   * The repository a user's command acts on when it names none (VS Code's "Choose a
   * repository"): with one repository, it; for the user with several, a picker (the selected
   * one first); for other callers (agents), the selected one. Null: the picker was dismissed.
   */
  async choose(
    repository: string | undefined,
    caller: Caller,
    placeholder = "Choose a repository",
  ): Promise<GitController | null> {
    if (repository) return this.pick(repository);
    const all = this.all.peek();
    if (all.length < 2 || caller.kind !== "user") return this.selected.peek();
    const ordered = pickerOrder(all, this.selected.peek());
    const picked = await this.services.quickInput.pick(
      ordered.map((c) => {
        const info = c.repo.peek();
        const b = c.status.peek()?.branch;
        return {
          id: info?.root ?? "",
          label: c.name,
          description: `${this.pathOf(info?.root ?? "")}${b?.head ? ` · ${b.head}` : ""}`,
          icon: (c.kind === "submodule" ? "box" : "git-branch") as "box" | "git-branch",
        };
      }),
      { placeholder },
    );
    if (!picked) return null;
    return all.find((c) => c.repo.peek()?.root === picked.id) ?? null;
  }

  /**
   * No nested repositories (the folder closed, or disposed): a discovery still under way is
   * dropped, or it would bring back the old folder's controllers (and nothing would dispose them).
   */
  private clearNested(): void {
    this.discoverToken++;
    this.setNested([]);
  }

  /** Looks for the repositories inside the folder again. */
  async discover(): Promise<readonly GitController[]> {
    const token = ++this.discoverToken;
    const { settings, workspace } = this.services;
    if (!workspace.root.peek() || this.services.trust.state.peek() === "restricted") {
      this.setNested([]);
      return this.nested.peek();
    }
    const depth = settings.peek<number | undefined>("git.repositoryScanMaxDepth") ?? 1;
    const ignored = settings.peek<string[] | undefined>("git.repositoryScanIgnoredFolders") ?? [
      "node_modules",
    ];
    const submodules = settings.peek<boolean | undefined>("git.detectSubmodules") !== false;
    let found: Awaited<ReturnType<typeof gitIpc.discover>> = [];
    try {
      found = await gitIpc.discover(Math.max(0, Math.floor(depth)), ignored, submodules);
    } catch {
      found = [];
    }
    if (token !== this.discoverToken) return this.nested.peek();
    const before = this.nested.peek();
    const kept: GitController[] = [];
    for (const f of found) {
      const existing = before.find((c) => c.ipc.repo && samePath(c.ipc.repo, f.root));
      kept.push(existing ?? new GitController(this.services, f, this.watching));
    }
    this.setNested(kept);
    this.discovered.fire();
    return kept;
  }

  private setNested(next: readonly GitController[]): void {
    for (const c of this.nested.peek()) if (!next.includes(c)) c.dispose();
    this.nested.value = next;
  }

  /** The repository `path` belongs to (the deepest one containing it). */
  forPath(path: string): GitController | undefined {
    const list = [this.primary, ...this.nested.peek()];
    const roots = list.map((c) => c.repo.peek()?.root ?? "");
    const i = deepestRoot(roots, path);
    return i < 0 ? undefined : list[i];
  }

  /**
   * The repository a command acts on: `repository` (its root, workspace-relative path or folder
   * name), else the one `path` is in, else the selected one.
   */
  pick(repository?: string, path?: string): GitController {
    if (repository) {
      const all = this.all.peek();
      const { workspace } = this.services;
      const i = matchRepository(
        all.map((c) => ({ root: c.repo.peek()?.root ?? "", name: c.name })),
        workspace.root.peek() ?? "",
        repository,
        { folders: workspace.folders.peek(), resolve: (p) => workspace.resolve(p) },
      );
      const hit = all[i];
      if (!hit)
        throw new Error(`There is no repository "${repository}" here (see git.repositories).`);
      return hit;
    }
    if (path) {
      const byPath = this.forPath(this.services.workspace.resolve(path));
      if (byPath) return byPath;
    }
    return this.selected.peek();
  }

  select(repo: GitController): void {
    this.chosen.value = repo;
  }

  /**
   * A repository root as the picker and the state tree show it: workspace-relative ("." the
   * folder's own; in a multi-root workspace it starts with the folder's name, D251).
   */
  private pathOf(root: string): string {
    return this.services.workspace.relative(root) || ".";
  }

  /** A repository's key for the hidden list: its workspace-relative path ("." the folder's own). */
  private keyOf(repo: GitController): string {
    return this.pathOf(repo.repo.peek()?.root ?? "");
  }

  /** Whether "multiple" mode lists `repo` (the ticked ones). */
  isShown(repo: GitController): boolean {
    return this.shown.peek().includes(repo);
  }

  /** Ticks or unticks a repository in "multiple" mode. */
  setShown(repo: GitController, shown: boolean): void {
    const next = new Set(this.hidden.peek());
    const key = this.keyOf(repo);
    if (shown) next.delete(key);
    else next.add(key);
    this.hidden.value = next;
    this.services.persistence.scheduleSave();
  }

  /** The repositories as the state tree and git.repositories show them. */
  describe(): {
    root: string;
    name: string;
    path: string;
    /** The workspace folder holding it (multi-root workspaces only, D251). */
    folder?: string;
    kind: string;
    selected: boolean;
    shown: boolean;
    branch: string | null;
    ahead: number;
    behind: number;
    changes: number;
  }[] {
    const { workspace } = this.services;
    const multi = workspace.folders.peek().length > 1;
    const selected = this.selected.peek();
    const shown = this.shown.peek();
    return this.all.peek().map((c) => {
      const info = c.repo.peek() as RepoInfo;
      const g = c.groups.peek();
      const b = c.status.peek()?.branch;
      return {
        root: info.root,
        name: c.name,
        path: this.pathOf(info.root),
        ...(multi && {
          folder:
            workspace.folderOf(info.root)?.name ??
            repositoryFolderName(workspace.folders.peek(), info.root),
        }),
        kind: c.kind,
        selected: c === selected,
        shown: shown.includes(c),
        branch: b?.head ?? (b?.oid ? `${b.oid.slice(0, 7)} (detached)` : null),
        ahead: b?.ahead ?? 0,
        behind: b?.behind ?? 0,
        changes: g.staged.length + g.changes.length + g.merge.length,
      };
    });
  }

  dispose(): void {
    this.store.dispose();
  }
}

/**
 * The workspace folder "Initialize repository" creates a repository in (D251): `folder` (a
 * workspace folder's path or name) when given; with one folder, undefined (the open folder, as
 * before); else the folder without a repository, the active editor's when several have none, else
 * a person picks (others must name it). Null: the picker was dismissed.
 */
export async function initFolder(
  services: WorkbenchServices,
  repos: GitRepositories,
  folder: string | undefined,
  user: boolean,
): Promise<string | null | undefined> {
  const { workspace, dock, quickInput } = services;
  const folders = workspace.folders.peek();
  if (folder) {
    if (folders.length < 2) return undefined;
    const abs = workspace.resolve(folder);
    const hit =
      folders.find((f) => samePath(f.path, abs)) ?? folders.find((f) => f.name === folder.trim());
    if (!hit) throw new Error(`"${folder}" isn't a folder of the workspace.`);
    return hit.path;
  }
  if (folders.length < 2) return undefined;
  const roots = repos.all.peek().map((c) => c.repo.peek()?.root ?? "");
  const bare = foldersWithoutRepository(folders, roots);
  const only = bare.length === 1 ? bare[0] : undefined;
  if (only) return only.path;
  if (!bare.length) throw new Error("Every folder of the workspace has a repository already.");
  const p = (dock.activeTab()?.viewState as { path?: unknown } | null)?.path;
  const active = typeof p === "string" && p ? workspace.folderOf(p) : undefined;
  if (active && bare.some((f) => samePath(f.path, active.path))) return active.path;
  if (!user)
    throw new Error(
      `Name the \`folder\`: ${bare.map((f) => f.name).join(", ")} have no repository.`,
    );
  const picked = await quickInput.pick(
    bare.map((f) => ({ id: f.path, label: f.name, description: f.path, icon: "folder" as const })),
    { placeholder: "Choose a folder to initialize a repository in" },
  );
  return picked?.id ?? null;
}

/**
 * One object whose fields are the selected repository's: reading `status.value` in an effect
 * also tracks the selection, so views and status bar items follow it.
 */
function selectedRepository(repos: GitRepositories): GitRepo {
  const sel = () => repos.selected.value;
  return {
    get ipc() {
      return sel().ipc;
    },
    get github() {
      return sel().github;
    },
    get repo() {
      return sel().repo;
    },
    get status() {
      return sel().status;
    },
    get problem() {
      return sel().problem;
    },
    get paused() {
      return sel().paused;
    },
    get busy() {
      return sel().busy;
    },
    get progress() {
      return sel().progress;
    },
    get repoState() {
      return sel().repoState;
    },
    get gitDirVersion() {
      return sel().gitDirVersion;
    },
    get groups() {
      return sel().groups;
    },
    open: async () => {
      const repo = repos.selected.peek();
      const info = await repo.open();
      if (repo === repos.primary) await repos.discover();
      return info;
    },
    refresh: (repoState?: boolean) => repos.selected.peek().refresh(repoState),
    schedule: (delay: number) => repos.selected.peek().schedule(delay),
  };
}
