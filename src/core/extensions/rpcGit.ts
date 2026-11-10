// The worker's `ide.git` and `ide.github` (D208): read-only git through the IDE's own git
// commands and repository routing ("git"), and GitHub notifications through the user's gh
// sign-in ("github"). Each call is a request the host checks (runtimeGit.ts). DOM-free.
import type { Disposable } from "./rpc";

/** Every call may name `repository` (its root, folder-relative path or folder name). */
export interface RepositoryOption {
  repository?: string;
}

export interface GitRepository {
  root: string;
  name: string;
  /** "workspace", "submodule" or "nested". */
  kind: string;
  selected: boolean;
  branch: string | null;
}

export interface GitBlameHunk {
  /** 1-based, inclusive. */
  start: number;
  end: number;
  commit: {
    hash: string;
    author: string;
    authorMail: string;
    /** Seconds since the epoch. */
    time: number;
    summary: string;
    uncommitted: boolean;
    filename: string;
    previous: string | null;
  };
}

export interface GitLineLogEntry {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  subject: string;
  /** The file's path in that commit (repository-relative). */
  path: string | null;
  diff: string;
  added: number;
  removed: number;
}

export interface GitChangedFile {
  /** A, M, D, R… */
  status: string;
  /** Repository-relative. */
  path: string;
  origPath: string | null;
}

export interface GitBranch {
  name: string;
  remote: boolean;
  current: boolean;
  upstream: string | null;
  commit: string;
  subject: string;
}

export interface GitStash {
  index: number;
  message: string;
  time: number;
}

export interface GitApi {
  repositories(): Promise<GitRepository[]>;
  /** Who last changed each line (the editor's unsaved text unless `useEditorText: false`). */
  blame(
    path: string,
    options?: RepositoryOption & { useEditorText?: boolean },
  ): Promise<GitBlameHunk[]>;
  /** The commits that changed lines start..end (git log -L), newest first; `limit` ≤ 200. */
  lineLog(
    path: string,
    startLine: number,
    endLine: number,
    options?: RepositoryOption & { limit?: number },
  ): Promise<GitLineLogEntry[]>;
  /** The files that differ from `left` to `right` (default HEAD); `mergeBase`: since they forked. */
  diffNames(
    left: string,
    right?: string,
    options?: RepositoryOption & { mergeBase?: boolean },
  ): Promise<GitChangedFile[]>;
  revParse(rev: string, options?: RepositoryOption): Promise<string>;
  mergeBase(left: string, right: string, options?: RepositoryOption): Promise<string>;
  refs(options?: RepositoryOption): Promise<{ branches: GitBranch[]; tags: string[] }>;
  stashes(options?: RepositoryOption): Promise<GitStash[]>;
  /** A file's text at `rev` ("" the index, "HEAD" or a commit hash); null when it isn't there. */
  show(path: string, rev?: string, options?: RepositoryOption): Promise<string | null>;
  /** A repository's HEAD, index or refs changed (`root`; "" when the list or selection changed). */
  onDidChange(listener: (event: { root: string }) => void): Disposable;
}

export interface GitHubNotification {
  id: string;
  unread: boolean;
  reason: string;
  updated_at: string;
  subject: { title: string; type: string; url: string | null };
  repository: { full_name: string; html_url: string };
}

export interface GitHubApi {
  /** `gh api notifications` (unread; `all`: read ones too). */
  notifications(options?: { all?: boolean }): Promise<GitHubNotification[]>;
  markNotificationRead(id: string): Promise<void>;
  markAllNotificationsRead(): Promise<void>;
}

type Request = <T>(method: string, params?: unknown) => Promise<T>;
type On = (type: string, listener: (payload: unknown) => void) => Disposable;

export function createGitApi(request: Request, on: On): { git: GitApi; github: GitHubApi } {
  const git: GitApi = {
    repositories: () => request("git.repositories"),
    blame: (path, options = {}) => request("git.blame", { path, ...options }),
    lineLog: (path, startLine, endLine, options = {}) =>
      request("git.lineLog", { path, startLine, endLine, ...options }),
    diffNames: (left, right, options = {}) =>
      request("git.diffNames", { left, ...(right !== undefined && { right }), ...options }),
    revParse: (rev, options = {}) => request("git.revParse", { rev, ...options }),
    mergeBase: (left, right, options = {}) => request("git.mergeBase", { left, right, ...options }),
    refs: (options = {}) => request("git.refs", options),
    stashes: (options = {}) => request("git.stashes", options),
    show: (path, rev, options = {}) =>
      request("git.show", { path, ...(rev !== undefined && { rev }), ...options }),
    onDidChange: (listener) =>
      on("git.didChange", (p) => listener({ root: String((p as { root?: unknown })?.root ?? "") })),
  };
  const github: GitHubApi = {
    notifications: async (options = {}) => {
      const list = await request<unknown>("github.notifications", { all: options.all === true });
      return Array.isArray(list) ? (list as GitHubNotification[]) : [];
    },
    markNotificationRead: (id) => request("github.markNotificationRead", { id }),
    markAllNotificationsRead: () => request("github.markNotificationRead", { all: true }),
  };
  return { git, github };
}
