// Read-only git, GitHub notifications and line annotations for extensions (D208), beside
// runtime.ts: `ide.git.*` ("git": the repositories, blame, line history, the files that differ
// between refs, refs, stashes, a file at a revision, a change event), `ide.github.*` ("github":
// notifications through the user's gh sign-in) and `ide.editor.setLineAnnotations` ("fs.read":
// text before each line, like a blame gutter). Backed by services.gitAccess, which the git
// extension provides with its repository routing; what changes a repository stays a git.*
// command (permission-checked like any other). Everything it adds goes when the extension stops.
import type { ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { isWithin, pathKey } from "../../core/paths/index";
import type { GitAccessGithub, GitAccessRepository } from "../../workbench/gitAccess";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";

const MAX_ANNOTATED_FILES = 50;
const MAX_ANNOTATIONS = 20000;
const MAX_LINE_LOG = 200;
/** Unsaved text larger than this is blamed as saved (the IPC carries it whole). */
const MAX_BLAME_TEXT = 2 * 1024 * 1024;

export interface GitHostDeps {
  manifest: ThirdPartyManifest;
  services: WorkbenchServices;
  need(permission: string, what: string): void;
  workspacePath(path: unknown): string;
}

const int = (v: unknown, name: string, min = 1): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min)
    throw new Error(`${name} must be an integer of at least ${min}.`);
  return v;
};
const text = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v || v.length > 500) throw new Error(`${name} must be a string.`);
  return v;
};
const optional = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v.slice(0, 500) : undefined;

export class ExtensionGitHost implements Disposable {
  private readonly store = new DisposableStore();
  /** pathKey → path, of files it annotated. */
  private readonly annotated = new Map<string, string>();

  constructor(private readonly deps: GitHostDeps) {}

  /** The repository a request names (`repository`), else the one its `path` is in, else the selected one. */
  private repo(p: Record<string, unknown>, path?: string): GitAccessRepository {
    this.deps.need("git", "use git");
    const provider = this.deps.services.gitAccess.get();
    if (!provider)
      throw new Error("Git isn't available here (no git, or the folder is restricted).");
    const repo = provider.repository(optional(p.repository), path);
    if (!repo) throw new Error("This folder isn't a git repository.");
    if (path && !isWithin(repo.root, path)) throw new Error("The file isn't in a git repository.");
    return repo;
  }

  /** `git.didChange`: a repository's HEAD, index or refs moved ({ root }; "" when the list changed). */
  subscribe(listener: (payload: { root: string }) => void): Disposable {
    this.deps.need("git", "follow git changes");
    let inner: Disposable | null = null;
    const attach = () => {
      inner?.dispose();
      const provider = this.deps.services.gitAccess.get();
      inner = provider ? provider.onDidChange((root) => listener({ root })) : null;
    };
    attach();
    const off = this.deps.services.gitAccess.onDidChangeProvider(() => {
      attach();
      listener({ root: "" });
    });
    return {
      dispose: () => {
        off.dispose();
        inner?.dispose();
      },
    };
  }

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    switch (method) {
      case "git.repositories": {
        this.deps.need("git", "use git");
        return Promise.resolve(this.deps.services.gitAccess.get()?.repositories() ?? []);
      }
      case "git.blame":
        return this.blame(p);
      case "git.lineLog": {
        // The diffs are the file's text: reading files is "fs.read" too.
        this.deps.need("fs.read", "read the history of a file's lines");
        const path = this.deps.workspacePath(p.path);
        const start = int(p.startLine, "startLine");
        const end = Math.max(start, int(p.endLine ?? start, "endLine"));
        const limit = Math.min(
          MAX_LINE_LOG,
          typeof p.limit === "number" ? Math.max(1, p.limit) : 50,
        );
        return this.repo(p, path).lineLog(path, start, end, Math.floor(limit));
      }
      case "git.diffNames":
        return this.diffNames(p);
      case "git.revParse":
        return this.repo(p).revParse(text(p.rev, "rev"));
      case "git.mergeBase":
        return this.repo(p).mergeBase(text(p.left, "left"), text(p.right, "right"));
      case "git.refs":
        return this.repo(p).refs();
      case "git.stashes":
        return this.repo(p).stashes();
      case "git.show": {
        this.deps.need("fs.read", "read a file at a revision");
        const path = this.deps.workspacePath(p.path);
        const repo = this.repo(p, path);
        // "" the index, "HEAD", or a commit hash (git_show refuses anything else).
        const rev = typeof p.rev === "string" ? p.rev.slice(0, 64) : "HEAD";
        return repo.show(rev, path);
      }
      case "github.notifications": {
        this.deps.need("github", "read your GitHub notifications");
        return this.github().notifications(p.all === true);
      }
      case "github.markNotificationRead": {
        this.deps.need("github", "mark GitHub notifications as read");
        const id = p.all === true ? null : text(p.id, "id");
        if (id !== null && !/^\d{1,20}$/.test(id)) throw new Error("Not a notification id.");
        return this.github().markRead(id);
      }
      case "editor.setLineAnnotations":
        return Promise.resolve(this.annotate(p));
      default:
        return UNHANDLED;
    }
  }

  /** The user's gh (notifications are the user's, not a repository's). */
  private github(): GitAccessGithub {
    const provider = this.deps.services.gitAccess.get();
    if (!provider) throw new Error("GitHub needs git and the GitHub CLI (gh).");
    return provider.github;
  }

  private async blame(p: Record<string, unknown>): Promise<unknown> {
    const path = this.deps.workspacePath(p.path);
    const repo = this.repo(p, path);
    let contents: string | undefined;
    if (p.useEditorText !== false) {
      const live = this.deps.services.documents.text(path);
      if (live !== null && live.length <= MAX_BLAME_TEXT) contents = live;
    }
    return repo.blame(path, contents);
  }

  private async diffNames(p: Record<string, unknown>): Promise<unknown> {
    const repo = this.repo(p);
    const left = text(p.left, "left");
    const right = optional(p.right) ?? "HEAD";
    const base = p.mergeBase === true ? await repo.mergeBase(left, right) : left;
    return repo.diffNames(base, right);
  }

  private annotate(p: Record<string, unknown>): void {
    this.deps.need("fs.read", "annotate lines");
    const path = this.deps.workspacePath(p.path);
    const key = pathKey(path);
    const { gutterMarks } = this.deps.services;
    if (!Array.isArray(p.annotations) || !p.annotations.length) {
      if (this.annotated.delete(key)) gutterMarks.annotate(path, null);
      return;
    }
    if (!this.annotated.has(key) && this.annotated.size >= MAX_ANNOTATED_FILES)
      throw new Error(`An extension can annotate at most ${MAX_ANNOTATED_FILES} files.`);
    const list = (p.annotations as unknown[]).slice(0, MAX_ANNOTATIONS).flatMap((raw) => {
      const a = (raw ?? {}) as Record<string, unknown>;
      if (typeof a.line !== "number" || !Number.isInteger(a.line) || a.line < 1) return [];
      const tone =
        typeof a.tone === "number" && Number.isInteger(a.tone)
          ? Math.max(0, Math.min(4, a.tone))
          : 4;
      // Plain text, one line; spaces kept (no-break) so every line's text keeps its width.
      const shown = String(a.text ?? "")
        // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what's removed
        .replace(/[\u0000-\u001f]/g, " ")
        .slice(0, 80)
        .replaceAll(" ", " ");
      return [
        {
          line: a.line,
          text: `${shown}  `,
          className: `line-annotation line-annotation-tone-${tone}`,
          ...(typeof a.hover === "string" && { hover: a.hover.slice(0, 2000) }),
        },
      ];
    });
    this.annotated.set(key, path);
    gutterMarks.annotate(path, list);
  }

  dispose(): void {
    for (const path of this.annotated.values()) this.deps.services.gutterMarks.annotate(path, null);
    this.annotated.clear();
    this.store.dispose();
  }
}
