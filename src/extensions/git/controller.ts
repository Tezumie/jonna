// Keeps one repository's git state fresh: the workspace's own (found when a folder opens) or one
// found inside it (D204: nested, submodule). Watches its git directory, refreshes status
// (coalesced) after saves, file operations, window focus, files changing on disk (D220: the file
// index's watcher, routed here by repositories.ts) and on a slow fallback poll while the window
// is focused, and keeps its file decorations. repositories.ts holds all of them and routes paths.
import {
  createGithubIpc,
  createGitIpc,
  type FoundRepo,
  type GitIpc,
  type GitStatus,
  githubIpc,
  gitIpc,
  type RepoInfo,
  type RepoState,
} from "../../core/ipc/git";
import { IpcError } from "../../core/ipc/invoke";
import { DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { basename, isWithin, pathKey } from "../../core/paths/index";
import {
  computed,
  effect,
  type ReadonlySignal,
  type Signal,
  signal,
} from "../../core/reactive/index";
import type { FileDecoration, WorkbenchServices } from "../../workbench/services";
import { buildDecorations, type GroupedChanges, groupChanges } from "./model";
import { repositoryFolderName, statusPollMs } from "./repoPaths";

const EVENT_DEBOUNCE_MS = 300;
/** Files changing on disk: one status read once they've been quiet this long (VS Code's 1 s). */
const DISK_DEBOUNCE_MS = 1000;

// "folder": another folder's repository in a multi-root workspace (D251).
export type RepoKind = "workspace" | "submodule" | "nested" | "folder";

/** What the git commands and views use of a repository (a controller, or the selected one). */
export interface GitRepo {
  readonly ipc: GitIpc;
  readonly github: ReturnType<typeof createGithubIpc>;
  readonly repo: Signal<RepoInfo | null>;
  readonly status: Signal<GitStatus | null>;
  readonly problem: Signal<string | null>;
  /** The IDE's git is paused: the settings changed after a sandboxed command (D392). */
  readonly paused: Signal<boolean>;
  readonly busy: Signal<string | null>;
  readonly progress: Signal<string>;
  readonly repoState: Signal<RepoState | null>;
  readonly gitDirVersion: Signal<number>;
  readonly groups: ReadonlySignal<GroupedChanges>;
  open(): Promise<RepoInfo | null>;
  refresh(repoState?: boolean): Promise<void>;
  schedule(delay: number): void;
}

export class GitController implements GitRepo {
  private readonly store = new DisposableStore();
  /** Per opened repository (watcher, poll). */
  private readonly repoScope = this.store.add(new DisposableStore());
  readonly ipc: GitIpc;
  readonly github: ReturnType<typeof createGithubIpc>;
  readonly kind: RepoKind;
  readonly repo = signal<RepoInfo | null>(null);
  readonly status = signal<GitStatus | null>(null);
  /** "git is not installed" and similar; null when fine. */
  readonly problem = signal<string | null>(null);
  /**
   * The repository's git settings changed after an agent's sandboxed command ran there, so the
   * IDE's git is paused for it until the user trusts them (git.trustSettings, D392).
   */
  readonly paused = signal(false);
  /** A running remote operation ("Pushing…"), for the progress line and status bar. */
  readonly busy = signal<string | null>(null);
  /** The last progress line of a remote operation. */
  readonly progress = signal<string>("");
  /** Remotes, tags and the operation in progress (merge, rebase…), refreshed with the status. */
  readonly repoState = signal<RepoState | null>(null);
  /** Bumped when the git directory changes (refs may have moved: the all-branches graph). */
  readonly gitDirVersion = signal(0);
  readonly groups: ReadonlySignal<GroupedChanges> = computed(() => {
    const repo = this.repo.value;
    const status = this.status.value;
    return repo && status
      ? groupChanges(repo.root, status)
      : { merge: [], staged: [], changes: [] };
  });
  private decorations = buildDecorations(
    { root: "", gitDir: "" },
    { merge: [], staged: [], changes: [] },
  );
  private refreshing: Promise<void> | null = null;
  private mergeBaseCache: { version: number; hash: Promise<string | null> } | null = null;
  /** Bumped by each open() and close(); an open() that was overtaken drops its results. */
  private openGeneration = 0;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private diskTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * `found`: a repository inside the workspace; without it, the workspace's own. `watched`:
   * whether the file watcher reports changes on disk (then the poll is only a slow fallback).
   */
  constructor(
    private readonly services: WorkbenchServices,
    private readonly found?: FoundRepo,
    private readonly watched?: ReadonlySignal<boolean>,
  ) {
    this.kind = found?.kind ?? "workspace";
    this.ipc = found ? createGitIpc(found.root) : gitIpc;
    this.github = found ? createGithubIpc(found.root) : githubIpc;
    const { workspace, events } = services;
    if (!found) {
      this.store.add(workspace.onDidOpen(() => void this.open()));
      this.store.add(workspace.onDidClose(() => this.close()));
      if (workspace.root.peek()) void this.open();
      // Trusted or restricted later: git starts, or stops reading the repository.
      let restricted = services.trust.state.peek() === "restricted";
      this.store.add(
        effect(() => {
          const now = services.trust.state.value === "restricted";
          if (now !== restricted) {
            restricted = now;
            if (workspace.root.peek()) void this.open();
          }
          return undefined;
        }),
      );
    } else {
      void this.open();
    }
    // A repository found inside the folder reads its status only for its own files: a save
    // elsewhere would otherwise run `git status` in every nested repository and submodule.
    const mine = (path: string) => !found || isWithin(found.root, path);
    const soon = (e: { path: string } | { from: string; to: string }) => {
      const touched = "path" in e ? mine(e.path) : mine(e.from) || mine(e.to);
      if (touched) this.schedule(EVENT_DEBOUNCE_MS);
    };
    for (const name of [
      "files.didSave",
      "files.didCreate",
      "files.didRename",
      "files.didDelete",
      "files.didChange",
    ] as const)
      this.store.add(events.on(name, soon));
    const onFocus = () => this.schedule(0);
    window.addEventListener("focus", onFocus);
    this.store.add(toDisposable(() => window.removeEventListener("focus", onFocus)));
    this.store.add({
      dispose: () => {
        clearTimeout(this.timer);
        clearTimeout(this.diskTimer);
      },
    });
  }

  /**
   * Files of this repository changed on disk (the file watcher, D220): one status read once
   * they've been quiet for a second, so a build or a checkout writing many files costs one.
   */
  changedOnDisk(): void {
    if (!this.repo.peek()) return;
    clearTimeout(this.diskTimer);
    this.diskTimer = setTimeout(() => this.schedule(0), DISK_DEBOUNCE_MS);
  }

  /**
   * The folder's name, as Source control lists it: in a multi-root workspace a folder's
   * repository goes by the folder's name (D251).
   */
  get name(): string {
    const root = this.repo.peek()?.root ?? this.found?.root ?? "";
    const named =
      this.kind === "workspace" || this.kind === "folder"
        ? repositoryFolderName(this.services.workspace.folders.peek(), root)
        : undefined;
    return named ?? (basename(root) || root);
  }

  /** Its decoration of `path` (a file or folder), if it has one. */
  decorate(path: string, kind: "file" | "dir"): FileDecoration | undefined {
    return (kind === "dir" ? this.decorations.dirs : this.decorations.files).get(pathKey(path));
  }

  /** The base text the change bars compare `path` with (D200: index, HEAD or the merge base). */
  async original(path: string, base: "index" | "head" | "mergeBase"): Promise<string | null> {
    if (base === "mergeBase") {
      // Once per state of the refs (a commit, a fetch or a checkout moves it).
      const version = this.gitDirVersion.peek();
      if (this.mergeBaseCache?.version !== version)
        this.mergeBaseCache = {
          version,
          hash: this.ipc.mergeBase().catch(() => null),
        };
      const hash = await this.mergeBaseCache.hash;
      return this.ipc.show(hash ?? "HEAD", path).catch(() => null);
    }
    return this.ipc.show(base === "head" ? "HEAD" : "", path).catch(() => null);
  }

  /** Finds the repository (again, e.g. after `git init`). */
  async open(): Promise<RepoInfo | null> {
    // Opens overlap (folder open + `git init`) and close() can land mid-await: only the latest
    // call may set state or keep what it creates, or watchers / polls pile up and a closed
    // folder's repo comes back.
    const generation = ++this.openGeneration;
    this.repoScope.clear();
    this.stateStale = true;
    let repo: RepoInfo | null = null;
    let problem: string | null = null;
    let paused = false;
    // Restricted mode (D207 audit, VS Code's way): git runs the repository's own config —
    // core.fsmonitor, filters, hooks, sshCommand — so it's off until the folder is trusted.
    if (this.services.trust.state.peek() === "restricted") {
      this.problem.value =
        "Git is off in restricted mode: it would run this repository's own settings. Trust the folder (Manage workspace trust) to use it.";
      this.paused.value = false;
      this.repo.value = null;
      this.status.value = null;
      this.applyDecorations();
      return null;
    }
    try {
      repo = this.found
        ? { root: this.found.root, gitDir: this.found.gitDir }
        : await this.ipc.open();
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
      paused = err instanceof IpcError && err.code === "GitSettingsChanged";
    }
    if (generation !== this.openGeneration) return null;
    this.problem.value = problem;
    this.paused.value = paused;
    this.repo.value = repo;
    if (!repo) {
      this.status.value = null;
      this.applyDecorations();
      return null;
    }
    try {
      // The git dir changed (refs, HEAD, a merge starting): remotes, tags and the operation in
      // progress may have too.
      const watcher = await this.ipc.watch(() => {
        this.stateStale = true;
        this.gitDirVersion.value++;
        this.schedule(0);
      });
      if (generation !== this.openGeneration) {
        watcher.dispose();
        return null;
      }
      this.repoScope.add(watcher);
    } catch (err) {
      console.warn("git watching unavailable", err);
    }
    if (generation !== this.openGeneration) return null;
    // The fallback poll: 5 s without a file watcher, a minute with one (it catches what a watcher
    // misses: network drives, WSL folders). Its period follows `watched`.
    let poll: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      poll = setTimeout(
        () => {
          if (document.hasFocus() && !document.hidden) this.schedule(0);
          next();
        },
        statusPollMs(this.watched?.peek() === true),
      );
    };
    next();
    this.repoScope.add(toDisposable(() => clearTimeout(poll)));
    await this.refresh();
    return repo;
  }

  private close(): void {
    this.openGeneration++; // an open() still awaiting gives up
    this.repoScope.clear();
    this.repoState.value = null;
    this.repo.value = null;
    this.status.value = null;
    this.applyDecorations();
  }

  schedule(delay: number): void {
    if (!this.repo.peek()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), delay);
  }

  /** Remotes, tags and the operation in progress need reloading (D138: not on every save). */
  private stateStale = true;

  /**
   * Reloads status (and, after git-dir changes or with `repoState`, remotes / tags / the
   * operation in progress); concurrent calls share one run plus at most one follow-up.
   */
  refresh(repoState = false): Promise<void> {
    if (repoState) this.stateStale = true;
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.again = false;
        if (!this.repo.peek()) break;
        const loadState = this.stateStale;
        this.stateStale = false;
        // A folder switch (or close) while reading: the result is the previous repo's.
        const generation = this.openGeneration;
        const stale = () => {
          if (generation === this.openGeneration) return false;
          this.stateStale ||= loadState;
          // The new repo (if any) gets its own read.
          if (this.repo.peek()) this.again = true;
          return true;
        };
        try {
          const [next, state] = await Promise.all([
            this.ipc.status(),
            loadState ? this.ipc.repoState().catch(() => null) : Promise.resolve(undefined),
          ]);
          if (stale()) continue;
          // Couldn't be read: try again on the next refresh.
          if (state === null) this.stateStale = true;
          else if (
            state !== undefined &&
            JSON.stringify(state) !== JSON.stringify(this.repoState.peek())
          )
            this.repoState.value = state;
          if (!sameStatus(this.status.peek(), next)) {
            this.status.value = next;
            this.applyDecorations();
            this.services.quickDiff.changed();
          }
        } catch (err) {
          if (stale()) continue;
          // Status failed (the index locked mid-merge…): the repo state is reloaded next time.
          this.stateStale ||= loadState;
          // The repository vanished (folder deleted, .git removed): look again.
          if (err instanceof IpcError && err.code === "GitSettingsChanged") {
            // Paused (D392): said in the view, which offers to trust the settings.
            this.problem.value = err.message;
            this.paused.value = true;
            this.repo.value = null;
            this.status.value = null;
            this.applyDecorations();
          } else if (err instanceof IpcError && err.code === "Git" && !this.again) {
            this.repo.value = null;
            this.status.value = null;
            this.applyDecorations();
          }
        }
      } while (this.again);
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private applyDecorations(): void {
    const repo = this.repo.peek();
    this.decorations = repo
      ? buildDecorations(repo, this.groups.peek())
      : buildDecorations({ root: "", gitDir: "" }, { merge: [], staged: [], changes: [] });
    this.services.decorations.changed();
  }

  dispose(): void {
    this.store.dispose();
  }
}

function sameStatus(a: GitStatus | null, b: GitStatus): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}
