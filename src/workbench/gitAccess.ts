// Read-only git for extensions (D208): the git extension provides it, the extensions host serves it
// to third-party code (`ide.git.*`, checked against the "git" permission) — the Git tools
// extension's line history, compare, stashes and file blame are built on it. Routing follows the
// git extension's: a named repository, else the one a path is in, else the selected one. DOM-free.
import type { Branch, ChangedFile, Stash } from "../core/ipc/git";
import { type Disposable, toDisposable } from "../core/lifecycle/index";

/** One commit of a blame (`git blame --porcelain`). */
export interface BlameCommit {
  hash: string;
  author: string;
  authorMail: string;
  /** Seconds since the epoch. */
  time: number;
  summary: string;
  /** The line isn't committed yet (all-zero hash). */
  uncommitted: boolean;
  /** The file's path in that commit (renames). */
  filename: string;
  /** The parent's hash, when the porcelain names it (`previous`). */
  previous: string | null;
}

/** Lines start..end (1-based, inclusive) last changed by `commit`. */
export interface BlameHunk {
  start: number;
  end: number;
  commit: BlameCommit;
}

/** One commit of `git log -L` (the history of a range of lines). */
export interface LineLogEntry {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  subject: string;
  /** The file's path in that commit (it may have been renamed since). */
  path: string | null;
  /** The commit's diff of the lines followed. */
  diff: string;
  added: number;
  removed: number;
}

export interface GitRepositorySummary {
  root: string;
  name: string;
  kind: string;
  selected: boolean;
  branch: string | null;
}

/** One repository's read-only operations. */
export interface GitAccessRepository {
  readonly root: string;
  readonly name: string;
  /** `contents`: the editor's text, blamed instead of the file on disk (unsaved edits). */
  blame(path: string, contents?: string): Promise<BlameHunk[]>;
  lineLog(path: string, start: number, end: number, limit: number): Promise<LineLogEntry[]>;
  diffNames(left: string, right: string): Promise<ChangedFile[]>;
  revParse(rev: string): Promise<string>;
  mergeBase(left: string, right: string): Promise<string>;
  refs(): Promise<{ branches: Branch[]; tags: string[] }>;
  stashes(): Promise<Stash[]>;
  /** A file's text at `rev` ("" the index, "HEAD", a hash); null when it isn't there. */
  show(rev: string, path: string): Promise<string | null>;
}

/** The user's `gh` (src-tauri/src/git/github.rs ops that need no repository). */
export interface GitAccessGithub {
  notifications(all: boolean): Promise<unknown>;
  markRead(thread: string | null): Promise<void>;
}

export interface GitAccessProvider {
  repositories(): GitRepositorySummary[];
  /**
   * `repository` (its root; a workspace-relative path, which in a multi-root workspace starts
   * with a folder's name; a workspace folder's name; or the repository folder's name), else the
   * one `path` (absolute or workspace-relative) is in, else the selected one.
   */
  repository(repository?: string, path?: string): GitAccessRepository | null;
  readonly github: GitAccessGithub;
  /** HEAD, the index or refs changed in a repository (its root), or the list of them changed (""). */
  onDidChange(listener: (root: string) => void): Disposable;
}

/** The slot the git extension fills; empty while it's off (restricted mode) or not started. */
export class GitAccess {
  private provider: GitAccessProvider | null = null;
  private readonly waiting = new Set<(p: GitAccessProvider | null) => void>();

  provide(provider: GitAccessProvider): Disposable {
    this.provider = provider;
    for (const l of this.waiting) l(provider);
    return toDisposable(() => {
      if (this.provider !== provider) return;
      this.provider = null;
      for (const l of this.waiting) l(null);
    });
  }

  get(): GitAccessProvider | null {
    return this.provider;
  }

  /** Called whenever the provider comes or goes (null: gone). */
  onDidChangeProvider(listener: (p: GitAccessProvider | null) => void): Disposable {
    this.waiting.add(listener);
    return toDisposable(() => this.waiting.delete(listener));
  }
}
