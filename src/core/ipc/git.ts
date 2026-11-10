// Git (Rust: src-tauri/src/git, via the git CLI). Paths are repo-relative with "/" (absolute paths
// inside the repository are accepted as input too). Texts are in working-tree form.
import { type Disposable, toDisposable } from "../lifecycle/index";
import { Channel, call as invokeCall } from "./invoke";

export interface RepoInfo {
  /** Absolute repository root. */
  root: string;
  gitDir: string;
}

export interface BranchInfo {
  /** null when detached. */
  head: string | null;
  /** null before the first commit. */
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

/** Porcelain v2 letters: ".", "M", "A", "D", "R", "C", "T", "U", "?" (untracked), "!" (ignored). */
export interface FileStatus {
  path: string;
  origPath: string | null;
  index: string;
  worktree: string;
  conflict: boolean;
}

export interface GitStatus {
  branch: BranchInfo;
  files: FileStatus[];
}

export interface Branch {
  name: string;
  remote: boolean;
  current: boolean;
  upstream: string | null;
  commit: string;
  subject: string;
}

export interface Commit {
  hash: string;
  author: string;
  email: string;
  /** Seconds since the epoch. */
  time: number;
  subject: string;
  /** Parent hashes (two or more for a merge). */
  parents: string[];
  /** Branches and tags pointing here ("HEAD -> main", "origin/main", "tag: v1"). */
  refs: string[];
}

/** A file a commit changed (A, M, D, R, C, T). */
export interface ChangedFile {
  status: string;
  path: string;
  origPath: string | null;
}

export interface CommitDetail {
  hash: string;
  /** The first parent; null for a root commit. */
  parent: string | null;
  author: string;
  email: string;
  time: number;
  message: string;
  files: ChangedFile[];
  /** Lines added and removed. */
  insertions: number;
  deletions: number;
}

/** Fixed-argument repository operations (src-tauri ops::repo_op). */
export type RepoOp =
  | "deleteBranch"
  | "forceDeleteBranch"
  | "renameBranch"
  | "createBranchFrom"
  | "merge"
  | "mergeAbort"
  | "mergeContinue"
  | "rebase"
  | "rebaseAbort"
  | "rebaseContinue"
  | "cherryPick"
  | "cherryPickAbort"
  | "cherryPickContinue"
  | "revertAbort"
  | "revertContinue"
  | "revertCommit"
  | "tag"
  | "deleteTag"
  | "undoCommit"
  | "addRemote"
  | "removeRemote"
  | "checkoutDetached";

export interface RepoState {
  remotes: string[];
  /** Each remote's fetch URL. */
  remoteUrls: { name: string; url: string }[];
  tags: string[];
  /** What the repository is in the middle of. */
  operation: "merge" | "rebase" | "cherryPick" | "revert" | null;
  /** The branch the current one is compared with (origin's HEAD, else main / master; D220). */
  baseBranch?: string | null;
}

export type RemoteOp =
  | "fetch"
  | "pull"
  | "pullRebase"
  | "pullMerge"
  | "push"
  | "pushForce"
  | "pushTags";

export interface BlameLine {
  hash: string;
  author: string;
  authorMail: string;
  /** Seconds since the Unix epoch. */
  time: number;
  summary: string;
  committed: boolean;
}

/** A `git stash list` entry. */
export interface Stash {
  /** 0 for stash@{0}. */
  index: number;
  message: string;
  /** Seconds since the epoch. */
  time: number;
}

/** A repository found inside the workspace (D204). */
export interface FoundRepo {
  root: string;
  gitDir: string;
  /** "folder": the repository of another folder of a multi-root workspace. */
  kind: "submodule" | "nested" | "folder";
}

/**
 * The git calls for one repository: `repo` is its root (one `discover` found), or undefined for
 * the workspace's own (D204).
 */
export function createGitIpc(repo?: string) {
  const call = <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> =>
    invokeCall<T>(cmd, { ...args, repo: repo ?? null });
  return {
    /** The root this talks to; undefined: the workspace's repository. */
    repo,
    open: (): Promise<RepoInfo | null> => invokeCall<RepoInfo | null>("git_open"),
    /**
     * Creates a repository in a workspace folder (`folder`; none: the root). The root's becomes
     * the workspace's repository; another folder's is one of the found ones (name it as `repo`).
     */
    init: (folder?: string): Promise<RepoInfo | null> =>
      invokeCall<RepoInfo | null>("git_init", { folder: folder ?? null }),
    /** The repositories inside the workspace besides its own (D204). */
    discover: (maxDepth: number, ignored: string[], submodules: boolean): Promise<FoundRepo[]> =>
      invokeCall<FoundRepo[]>("git_discover", { maxDepth, ignored, submodules }),
    /** Notifies (debounced) when HEAD, the index or refs change. Dispose to stop listening. */
    watch: async (onChange: () => void): Promise<Disposable> => {
      const channel = new Channel<null>(() => onChange());
      await call<void>("git_watch", { onChange: channel });
      return toDisposable(() => {
        channel.onmessage = () => {};
      });
    },
    status: (): Promise<GitStatus> => call<GitStatus>("git_status"),
    /**
     * Accepts the repository's git settings as they are now, after they changed while an
     * agent's sandboxed commands ran there: the IDE's git runs in it again (D392).
     */
    trustSettings: (): Promise<void> => call<void>("git_trust_settings"),
    /** The commit HEAD branched from the default branch (D200), or null. */
    mergeBase: (): Promise<string | null> => call<string | null>("git_merge_base"),
    /**
     * "" the index, "HEAD", a commit hash (file history), or a conflict's stage ":1" base,
     * ":2" ours, ":3" theirs (D204). null if the file isn't there.
     */
    show: (rev: string, path: string): Promise<string | null> =>
      call<string | null>("git_show", { rev, path }),
    /** The whole file's `git blame --porcelain` (D204); `contents`: the unsaved text. */
    blameFile: (path: string, contents?: string): Promise<string> =>
      call<string>("git_blame_file", { path, contents: contents ?? null }),
    /** `git log -L start,end:path` output (lens.ts parseLineLog). */
    logLines: (path: string, start: number, end: number, limit: number): Promise<string> =>
      call<string>("git_log_lines", { path, start, end, limit }),
    /** The files that differ between two refs (`mergeBase`: since they forked). */
    diffNames: (left: string, right: string, mergeBase = false): Promise<ChangedFile[]> =>
      call<ChangedFile[]>("git_diff_names", { left, right, mergeBase }),
    /** The full hash of the commit `rev` names. */
    revParse: (rev: string): Promise<string> => call<string>("git_rev_parse", { rev }),
    /** Where two refs forked (`git merge-base`). */
    mergeBaseOf: (left: string, right: string): Promise<string> =>
      call<string>("git_merge_base_of", { left, right }),
    writeIndex: (path: string, text: string): Promise<void> =>
      call<void>("git_write_index", { path, text }),
    stage: (paths: string[]): Promise<void> => call<void>("git_stage", { paths }),
    unstage: (paths: string[]): Promise<void> => call<void>("git_unstage", { paths }),
    discard: (tracked: string[], untracked: string[]): Promise<void> =>
      call<void>("git_discard", { tracked, untracked }),
    /** Returns the new commit's short hash. */
    commit: (
      message: string,
      amend: boolean,
      all: boolean,
      signing: { sign?: boolean; signoff?: boolean } = {},
    ): Promise<string> =>
      call<string>("git_commit", {
        message,
        amend,
        all,
        sign: signing.sign ?? false,
        signoff: signing.signoff ?? false,
      }),
    branches: (): Promise<Branch[]> => call<Branch[]>("git_branches"),
    checkout: (name: string, create: boolean, remote: boolean): Promise<void> =>
      call<void>("git_checkout", { name, create, remote }),
    log: (limit: number, path?: string): Promise<Commit[]> =>
      call<Commit[]>("git_log", { limit, path: path ?? null }),
    /** Commits of a range such as "HEAD..@{u}" (incoming); empty without an upstream. */
    logRange: (range: string, limit: number): Promise<Commit[]> =>
      call<Commit[]>("git_log_range", { range, limit }),
    commitDetail: (rev: string): Promise<CommitDetail> =>
      call<CommitDetail>("git_commit_detail", { rev }),
    /** Returns git's output. */
    repoOp: (op: RepoOp, name = "", target = ""): Promise<string> =>
      call<string>("git_repo_op", { op, name, target }),
    repoState: (): Promise<RepoState> => call<RepoState>("git_repo_state"),
    /** The staged (or working-tree) diff, cut at `max` bytes. */
    diff: (staged: boolean, max: number): Promise<string> =>
      call<string>("git_diff", { staged, max }),
    /** The diff of a range ("main...HEAD"; "HEAD": everything uncommitted), cut at `max` bytes. */
    diffRange: (range: string, max: number): Promise<string> =>
      call<string>("git_diff_range", { range, max }),
    remote: (op: RemoteOp, onLine: (line: string) => void): Promise<void> =>
      call<void>("git_remote", { op, onLine: new Channel<string>(onLine) }),
    /** Who last changed `line` (1-based); `contents`: the editor's unsaved text. */
    blame: (path: string, line: number, contents?: string): Promise<BlameLine> =>
      call<BlameLine>("git_blame", { path, line, contents: contents ?? null }),
    /** Clones `url` into a new folder in `parent`; returns the new folder's path. */
    stashList: (): Promise<Stash[]> => call<Stash[]>("git_stash_list"),
    stash: (
      op: "push" | "apply" | "pop" | "drop",
      options: { index?: number; message?: string; untracked?: boolean } = {},
    ): Promise<void> =>
      call<void>("git_stash", {
        op,
        index: options.index ?? null,
        message: options.message ?? null,
        untracked: options.untracked ?? null,
      }),
    clone: (url: string, parent: string, onLine: (line: string) => void): Promise<string> =>
      invokeCall<string>("git_clone", { url, parent, onLine: new Channel<string>(onLine) }),
    /** Commits for the graph, children first: HEAD and its upstream, or every ref with `all`. */
    graph: (limit: number, all: boolean): Promise<Commit[]> =>
      call<Commit[]>("git_graph", { limit, all }),
    worktrees: (): Promise<Worktree[]> => call<Worktree[]>("git_worktrees"),
    worktreeOp: (op: WorktreeOp, path = "", branch = "", base = ""): Promise<string> =>
      call<string>("git_worktree_op", { op, path, branch, base }),
    /** Commits a rebase onto `base` would replay, oldest first ("root": all). */
    rebasePlan: (base: string): Promise<Commit[]> => call<Commit[]>("git_rebase_plan", { base }),
    rebaseInteractive: (base: string, steps: RebaseStep[]): Promise<string> =>
      call<string>("git_rebase_interactive", { base, steps }),
    /** Sign-in prompts from git and ssh come to `onRequest`; answer with askpassReply. */
    askpassListen: (onRequest: (request: AskpassRequest) => void): Promise<void> =>
      invokeCall<void>("git_askpass_listen", { onRequest: new Channel<AskpassRequest>(onRequest) }),
    askpassReply: (id: number, value: string | null): Promise<void> =>
      invokeCall<void>("git_askpass_reply", { id, value }),
  };
}

export type GitIpc = ReturnType<typeof createGitIpc>;

/** The workspace's own repository. */
export const gitIpc: GitIpc = createGitIpc();

export interface Worktree {
  path: string;
  head: string;
  /** null when detached or bare. */
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  /** Its folder is gone (prune removes the entry). */
  prunable: boolean;
  /** The repository's main worktree. */
  main: boolean;
}

export type WorktreeOp = "add" | "remove" | "forceRemove" | "prune" | "lock" | "unlock";

export type RebaseAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";

export interface RebaseStep {
  action: RebaseAction;
  hash: string;
  /** The new message (reword). */
  message?: string;
}

export interface AskpassRequest {
  id: number;
  /** "cancel": git stopped waiting; close the prompt. */
  kind: "ask" | "cancel";
  prompt: string;
  /** Mask the input. */
  secret: boolean;
}

export type GhOp =
  | "authStatus"
  | "prList"
  | "prView"
  | "prCheckout"
  | "prCreate"
  | "prMerge"
  | "issueList"
  | "repoCreate"
  // D204: pull request review and notifications.
  | "prMeta"
  | "prFiles"
  | "compareBase"
  | "fileAt"
  | "prThreads"
  | "prReply"
  | "prComment"
  | "prResolve"
  | "notifications"
  | "notificationRead"
  | "notificationsReadAll"
  // D352: auto-merge (on, off) and whether the repository allows it.
  | "prAutoMerge"
  | "prAutoMergeOff"
  | "repoAutoMerge";

export interface GhArgs {
  number?: number;
  state?: "open" | "closed" | "merged" | "all";
  title?: string;
  body?: string;
  base?: string;
  draft?: boolean;
  method?: "merge" | "squash" | "rebase";
  /** repoCreate: `name` or `owner/name`. */
  name?: string;
  visibility?: "private" | "public";
  /** A repository path (fileAt, prComment). */
  path?: string;
  /** A commit hash (fileAt, compareBase base, prComment). */
  rev?: string;
  /** compareBase: the head commit. */
  head?: string;
  /** A review thread's node id (prResolve) or a notification thread id. */
  thread?: string;
  /** A review comment's id (prReply). */
  comment?: number;
  line?: number;
  /** notifications: read ones too. */
  all?: boolean;
  /** prResolve: false unresolves. */
  resolved?: boolean;
}

/** GitHub through the user's `gh` CLI (src-tauri/src/git/github.rs), in repository `repo`. */
export function createGithubIpc(repo?: string) {
  return {
    run: (op: GhOp, args: GhArgs = {}): Promise<string> =>
      invokeCall<string>("github_cli", { op, args, repo: repo ?? null }),
    json: async <T>(op: GhOp, args: GhArgs = {}): Promise<T> =>
      JSON.parse(await invokeCall<string>("github_cli", { op, args, repo: repo ?? null })) as T,
  };
}

// GitHub through the user's `gh` CLI (src-tauri/src/git/github.rs). Lists and views are JSON.
export const githubIpc = createGithubIpc();
