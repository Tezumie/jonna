// VS Code's built-in Git extension's API (D257) for VS Code extensions that use it
// (`extensions.getExtension("vscode.git").exports.getAPI(1)`), on the IDE's own git (`ide.git`
// and ide://git/status): repositories with their HEAD, branches, remotes and changes (kept current
// from the IDE's git events), a file's text at a revision, and `git:` Uris (toGitUri) readable
// through openTextDocument. Changing a repository (commit, checkout, push…) isn't offered here;
// the IDE's git.* commands do it. DOM-free and unit-tested.

import type { WorkerApi } from "../rpc";
import { pathKey } from "./document";
import { EventEmitter, Uri } from "./types";
import type { ContentProviders } from "./workbench";

/** VS Code's git Status for the IDE's status letters (index or working tree). */
const STATUS = {
  index: { M: 0, A: 1, D: 2, R: 3, C: 4 } as Record<string, number>,
  tree: { M: 5, D: 6, "?": 7, U: 7, "!": 8, A: 9 } as Record<string, number>,
};

type Change = { uri: Uri; originalUri: Uri; renameUri: Uri | undefined; status: number };
type StatusFile = { path: string; status: string };

export function createGitExtension(
  ide: WorkerApi,
  absolute: (path: string) => string,
  contentProviders: ContentProviders,
  unsupported: (name: string) => void,
) {
  const repos = new Map<string, ReturnType<typeof repository>>();
  const onDidOpenRepository = new EventEmitter<unknown>();
  const onDidCloseRepository = new EventEmitter<unknown>();
  const onDidChangeState = new EventEmitter<string>();
  let state: "uninitialized" | "initialized" = "uninitialized";

  function repository(root: string) {
    const onDidChange = new EventEmitter<void>();
    const onDidChangeUi = new EventEmitter<void>();
    const repoState = {
      HEAD: undefined as
        | {
            type: number;
            name?: string;
            commit?: string;
            upstream?: unknown;
            ahead?: number;
            behind?: number;
          }
        | undefined,
      refs: [] as { type: number; name: string; commit?: string; remote?: string }[],
      remotes: [] as { name: string; fetchUrl?: string; pushUrl?: string; isReadOnly: boolean }[],
      submodules: [] as unknown[],
      rebaseCommit: undefined,
      mergeChanges: [] as Change[],
      indexChanges: [] as Change[],
      workingTreeChanges: [] as Change[],
      untrackedChanges: [] as Change[],
      onDidChange: onDidChange.event,
    };
    const option = { repository: root };
    const unsupportedWrite = (name: string) => () => {
      unsupported(`git Repository.${name}`);
      return Promise.reject(new Error(`Use the IDE's git commands to ${name}.`));
    };
    return {
      rootUri: Uri.file(root),
      inputBox: { value: "" },
      state: repoState,
      ui: { selected: false, onDidChange: onDidChangeUi.event },
      fire: () => onDidChange.fire(),
      show: async (ref: string, path: string) => (await ide.git.show(path, ref, option)) ?? "",
      getCommit: async (ref: string) => {
        const hash = await ide.git.revParse(ref, option);
        return {
          hash,
          message: "",
          parents: [] as string[],
          authorDate: undefined,
          authorName: undefined,
          authorEmail: undefined,
        };
      },
      getBranches: async () => repoState.refs.filter((r) => r.type !== 2),
      getRefs: async () => repoState.refs,
      getMergeBase: (a: string, b: string) => ide.git.mergeBase(a, b, option),
      diffBetween: async (a: string, b: string) =>
        (await ide.git.diffNames(a, b, option)).map((f) => ({
          uri: Uri.file(absolute(`${root}/${f.path}`)),
          originalUri: Uri.file(absolute(`${root}/${f.path}`)),
          renameUri: undefined,
          status: STATUS.index[f.status[0] ?? "M"] ?? 0,
        })),
      blame: async (path: string) => {
        const hunks = await ide.git.blame(path, option);
        return hunks
          .map((h) => `${h.commit.hash} (${h.commit.author} ${h.start}) ${h.commit.summary}`)
          .join("\n");
      },
      status: () => refresh(),
      log: () => {
        unsupported("git Repository.log");
        return Promise.resolve([]);
      },
      getConfig: () => Promise.resolve(""),
      getConfigs: () => Promise.resolve([]),
      diffWithHEAD: unsupportedWrite("diffWithHEAD"),
      add: unsupportedWrite("add"),
      revert: unsupportedWrite("revert"),
      clean: unsupportedWrite("clean"),
      commit: unsupportedWrite("commit"),
      checkout: unsupportedWrite("checkout"),
      createBranch: unsupportedWrite("createBranch"),
      deleteBranch: unsupportedWrite("deleteBranch"),
      fetch: unsupportedWrite("fetch"),
      pull: unsupportedWrite("pull"),
      push: unsupportedWrite("push"),
    };
  }

  const changeOf = (f: StatusFile, index: boolean): Change => {
    const uri = Uri.file(absolute(f.path));
    const letter = f.status[0] ?? "M";
    return {
      uri,
      originalUri: uri,
      renameUri: undefined,
      status: (index ? STATUS.index[letter] : STATUS.tree[letter]) ?? (index ? 0 : 5),
    };
  };

  let refreshing: Promise<void> | null = null;
  /** A change came while a refresh ran (it may have read the state before it): once more after. */
  let again = false;
  async function refresh(): Promise<void> {
    if (refreshing) {
      again = true;
      return refreshing;
    }
    refreshing = (async () => {
      do {
        again = false;
        await refreshOnce();
      } while (again);
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }
  async function refreshOnce(): Promise<void> {
    const list = await ide.git.repositories().catch(() => []);
    const status = (await ide.state.get("ide://git/status").catch(() => null)) as {
      root: string;
      staged?: StatusFile[];
      changes?: StatusFile[];
      conflicts?: StatusFile[];
    } | null;
    const seen = new Set<string>();
    for (const r of list) {
      const key = pathKey(r.root);
      seen.add(key);
      let repo = repos.get(key);
      const added = !repo;
      repo ??= repository(r.root);
      repos.set(key, repo);
      repo.ui.selected = r.selected;
      const option = { repository: r.root };
      const refs = await ide.git.refs(option).catch(() => ({ branches: [], tags: [] }));
      const head = refs.branches.find((b) => b.current && !b.remote);
      repo.state.HEAD = head
        ? {
            type: 0,
            name: head.name,
            commit: head.commit,
            ...(head.upstream && { upstream: { name: head.upstream } }),
          }
        : { type: 0, commit: await ide.git.revParse("HEAD", option).catch(() => undefined) };
      repo.state.refs = [
        ...refs.branches.map((b) => ({
          type: b.remote ? 1 : 0,
          name: b.name,
          commit: b.commit,
          ...(b.remote && { remote: b.name.split("/")[0] }),
        })),
        ...refs.tags.map((t) => ({ type: 2, name: t })),
      ];
      const remoteNames = [
        ...new Set(refs.branches.filter((b) => b.remote).map((b) => b.name.split("/")[0] ?? "")),
      ];
      repo.state.remotes = remoteNames.filter(Boolean).map((name) => ({ name, isReadOnly: true }));
      if (status && pathKey(status.root) === key) {
        repo.state.indexChanges = (status.staged ?? []).map((f) => changeOf(f, true));
        repo.state.workingTreeChanges = (status.changes ?? []).map((f) => changeOf(f, false));
        repo.state.mergeChanges = (status.conflicts ?? []).map((f) => changeOf(f, false));
      }
      if (added) onDidOpenRepository.fire(repo);
      repo.fire();
    }
    for (const [key, repo] of [...repos]) {
      if (seen.has(key)) continue;
      repos.delete(key);
      onDidCloseRepository.fire(repo);
    }
    if (state === "uninitialized") {
      state = "initialized";
      onDidChangeState.fire(state);
    }
  }

  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    void refresh();
    ide.git.onDidChange(() => void refresh());
    let timer: ReturnType<typeof setTimeout> | undefined;
    for (const event of ["files.didSave", "files.didCreate", "files.didDelete", "files.didRename"])
      ide.events.on(event, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void refresh(), 500);
      });
  };

  // `git:` Uris (toGitUri): a file's text at a ref ("" the index, "~" too, as VS Code's).
  contentProviders.set("git", {
    provideTextDocumentContent: async (uri) => {
      let q: { path?: string; ref?: string } = {};
      try {
        q = JSON.parse(uri.query) as typeof q;
      } catch {
        q = { path: uri.fsPath, ref: "HEAD" };
      }
      const ref = q.ref === "~" ? "" : (q.ref ?? "HEAD");
      return (await ide.git.show(q.path ?? uri.fsPath, ref).catch(() => null)) ?? "";
    },
  });

  const api = {
    get state() {
      return state;
    },
    onDidChangeState: onDidChangeState.event,
    onDidOpenRepository: onDidOpenRepository.event,
    onDidCloseRepository: onDidCloseRepository.event,
    onDidPublish: new EventEmitter<unknown>().event,
    get repositories() {
      return [...repos.values()];
    },
    getRepository: (uri: Uri) => {
      const p = pathKey(uri.fsPath);
      let best: ReturnType<typeof repository> | null = null;
      for (const [key, repo] of repos)
        if (
          (p === key || p.startsWith(`${key}/`)) &&
          (!best || key.length > pathKey(best.rootUri.fsPath).length)
        )
          best = repo;
      return best;
    },
    toGitUri: (uri: Uri, ref: string) =>
      uri.with({ scheme: "git", path: uri.path, query: JSON.stringify({ path: uri.fsPath, ref }) }),
    git: { path: "git" },
    registerRemoteSourceProvider: () => ({ dispose() {} }),
    registerCredentialsProvider: () => ({ dispose() {} }),
    registerPushErrorHandler: () => ({ dispose() {} }),
  };

  const exportsValue = {
    enabled: true,
    onDidChangeEnablement: new EventEmitter<boolean>().event,
    getAPI: (_version: number) => {
      start();
      return api;
    },
  };

  return {
    id: "vscode.git",
    extensionUri: Uri.file(""),
    extensionPath: "",
    isActive: true,
    packageJSON: { name: "git", publisher: "vscode", displayName: "Git", version: "1.0.0" },
    extensionKind: 2,
    exports: exportsValue,
    activate: () => Promise.resolve(exportsValue),
  };
}
