// What an external agent changed in a turn (D208). Codex, Claude Code and Gemini CLI write files
// themselves rather than through ACP's fs/write_text_file, so nothing reached the changeset. A
// TurnWatch reads the folder when the turn starts (git: the dirty files' texts and HEAD) and again
// when it ends; what differs goes into the chat's changeset as already-written changes, so the
// usual review shows them (diff, accept, reject = put back, checkpoint restore). Without git only
// the files the agent's steps named are compared, read when first named (or the step's diff).
// D223: a step that finishes is compared at once (its card shows the change while the turn goes
// on, the end compares it again); a file a step names before it runs is read then (so an ignored
// file, or one git would show with other line endings, is compared with what it really held); a
// file the user saves in the IDE during the turn is compared from that save on, so their own edit
// isn't credited to the agent; up to 1000 dirty files (64 MB) are read at the start.
// D233: without git the folder is listed with sizes and times at the start and at the end
// (`agent_tree_stats`: .gitignore'd files, dependency and build folders left out, 20 000 files),
// and small files are read at the start (400 files, 8 MB), so a change no step named is found
// too (a file not read then shows as changed, without a diff). Git-ignored files no step names
// (build output) stay out, with git or without, as in VS Code's changes. A file the user saves
// during the turn after a step of the agent's changed it keeps the turn's start as its baseline
// (the agent's edit is credited; the chat says the diff includes the user's save); saved before
// any such step, it's compared from the save on, as before.
// D251: in a multi-root workspace every folder is watched (`TurnWatch` holds one `FolderWatch`
// per folder; a file belongs to the innermost folder holding it). The first folder uses the
// workspace's repository as before; another folder uses git when it is a repository's root, and
// the listing otherwise.

import {
  baselineAfterSave,
  bulkCreatedFolders,
  candidates,
  compareSnaps,
  type FileSnap,
  ignoredPath,
  joinPath,
  relativeTo,
  type TextChange,
  type TreeStat,
  treeChanges,
} from "../../core/acp/turnChanges";
import { agentStoreIpc } from "../../core/ipc/agent";
import { fsIpc } from "../../core/ipc/fs";
import { createGitIpc, gitIpc } from "../../core/ipc/git";
import type { Disposable } from "../../core/lifecycle/index";
import { pathKey, samePath } from "../../core/paths/index";
import { folderOf } from "../../core/workspace/workspaceFile";
import type { WorkbenchServices } from "../../workbench/services";
import { readDiskForAgent } from "./changeset";

/** Bigger files are compared by size and time, not text (and not offered for review). */
const SNAP_MAX_BYTES = 1024 * 1024;
/** At most this many dirty files are read at the start (a huge untracked tree isn't)… */
const START_MAX_FILES = 1000;
/** …and at most this much text in all. */
const START_MAX_BYTES = 64 * 1024 * 1024;
/** At most this many files are compared at the end. */
const COMPARE_MAX_FILES = 1000;
/** Without git (D233): the folder's listing, at most this many files… */
const TREE_MAX_FILES = 20_000;
/** …of which files this small are read at the start, at most this many and this much text. */
const TREE_READ_MAX_BYTES = 256 * 1024;
const TREE_READ_MAX_FILES = 400;
const TREE_READ_BUDGET = 8 * 1024 * 1024;

async function snap(path: string): Promise<FileSnap> {
  const read = await readDiskForAgent(path, SNAP_MAX_BYTES);
  if (read.kind === "text") return { kind: "text", text: read.text };
  if (read.kind === "missing") return { kind: "missing" };
  const stat = await fsIpc.stat(path).catch(() => null);
  return { kind: "other", sig: stat ? `${stat.size}:${stat.mtimeMs}` : read.kind };
}

const snapSize = (s: FileSnap) => (s.kind === "text" ? s.text.length : 0);

export interface TurnResult {
  /** Text files: what they held before the turn and after it. */
  changes: TextChange[];
  /** Changed files that aren't compared as text (binary, large). */
  others: string[];
  /** The agent made commits during the turn (HEAD moved). */
  committed: boolean;
  /** Dirty files left out by the caps (not compared). */
  skipped: number;
  /** Files the user saved in the IDE during the turn (compared from their save on). */
  userSaved: string[];
  /**
   * Files the user saved after a step of the agent's changed them (D233): compared from the
   * turn's start, so the agent's edit counts; the diff includes the user's save.
   */
  savedOverAgent: string[];
  /** Folders a command filled in bulk (a clone, a download): not compared file by file (D294). */
  bulk: { folder: string; files: number }[];
}

type Git = ReturnType<typeof createGitIpc>;

/** One folder's look before and after a turn. */
class FolderWatch {
  private readonly windows: boolean;
  private repo: string | null = null;
  private head: string | null = null;
  /** Each path's text when the turn began (or when first named), by pathKey. */
  private readonly before = new Map<string, { path: string; snap: Promise<FileSnap> }>();
  /** Dirty at the start (git). */
  private dirtyBefore: string[] = [];
  private named: string[] = [];
  /** Dirty files not read at the start (over the caps). */
  private skipped = 0;
  /** What the user saved during the turn, by pathKey (D223), and when. */
  private readonly saved = new Map<string, { path: string; snap: Promise<FileSnap>; at: number }>();
  /** When a step of the agent's was last seen changing each file (D233), by pathKey. */
  private readonly agentWrote = new Map<string, number>();
  /** Without git (D233): the folder's listing at the start. */
  private tree: { files: TreeStat[]; truncated: boolean } | null = null;
  /** Files compared when a step finished (D223): compared again at the end. */
  private readonly live = new Set<string>();
  private readonly listening: Disposable;

  constructor(
    services: WorkbenchServices,
    private readonly root: string,
    /** Whether the IDE itself wrote `path` this turn (an ACP fs write, a review): not the user. */
    private readonly writtenByIde: (path: string) => boolean = () => false,
    /**
     * The repository to use: the workspace's (`gitIpc`, found with `git_open`), or another
     * folder's own (its root is the folder; none when it isn't a repository's root).
     */
    private readonly git: Git = gitIpc,
    private readonly workspaceRepo = true,
    /** Whether a file inside `root` is this watch's (not a nested folder's own watch's). */
    private readonly owns: (path: string) => boolean = () => true,
  ) {
    this.windows = services.platform === "windows";
    this.listening = services.events.on("files.didSave", ({ path }) => {
      if (!this.inside(path) || this.writtenByIde(path)) return;
      const key = pathKey(path);
      // The first save after the agent's write is what matters (D233): later saves don't move it.
      const earlier = this.saved.get(key);
      this.saved.set(key, { path, snap: snap(path), at: earlier?.at ?? Date.now() });
    });
  }

  /** Whether `path` is in this folder and this watch's to compare. */
  inside(path: string): boolean {
    return relativeTo(this.root, path, this.windows) !== null && this.owns(path);
  }

  /** Reads the folder as it is before the turn. Never throws (no git: only named files). */
  async start(): Promise<void> {
    try {
      if (this.workspaceRepo) {
        const info = await this.git.open();
        // The workspace's repository, when the agent's folder is it or inside it.
        if (
          info &&
          (samePath(info.root, this.root) ||
            relativeTo(info.root, this.root, this.windows) !== null)
        )
          this.repo = info.root;
      } else {
        // Another folder: a repository when git answers for it as one.
        this.repo = await this.git.status().then(
          () => this.root,
          () => null,
        );
      }
      if (!this.repo) return await this.startWithoutGit();
      const status = await this.git.status();
      this.head = status.branch.oid;
      this.dirtyBefore = this.statusPaths(status.files);
      let bytes = 0;
      let read = 0;
      for (const path of this.dirtyBefore) {
        if (read >= START_MAX_FILES || bytes >= START_MAX_BYTES) {
          this.skipped++;
          continue;
        }
        const s = snap(path);
        this.before.set(pathKey(path), { path, snap: s });
        read++;
        // In batches, so the byte budget counts what was read.
        if (read % 50 === 0)
          bytes += (await Promise.all([...this.before.values()].map((b) => b.snap)))
            .slice(-50)
            .reduce((n, x) => n + snapSize(x), 0);
      }
      await Promise.all([...this.before.values()].map((b) => b.snap));
    } catch {
      this.repo = null;
    }
  }

  /**
   * Without git (D233): the folder's listing, and small files read (most recently changed first,
   * the likeliest to be edited again), so a change no step names is found at the end.
   */
  private async startWithoutGit(): Promise<void> {
    const listed = await agentStoreIpc.treeStats(this.root, TREE_MAX_FILES).catch(() => null);
    if (!listed) return;
    this.tree = listed;
    const small = listed.files
      .filter((f) => f.size <= TREE_READ_MAX_BYTES && !ignoredPath(f.path))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    let bytes = 0;
    let read = 0;
    for (const f of small) {
      if (read >= TREE_READ_MAX_FILES || bytes + f.size > TREE_READ_BUDGET) break;
      const path = joinPath(this.root, f.path, this.windows);
      if (!this.owns(path)) continue;
      const key = pathKey(path);
      if (this.before.has(key)) continue;
      this.before.set(key, { path, snap: snap(path) });
      bytes += f.size;
      read++;
    }
    await Promise.all([...this.before.values()].map((b) => b.snap));
  }

  private statusPaths(files: readonly { path: string }[]): string[] {
    if (!this.repo) return [];
    const repo = this.repo;
    return files
      .filter((f) => !ignoredPath(f.path))
      .map((f) => joinPath(repo, f.path, this.windows))
      .filter((p) => this.inside(p));
  }

  /**
   * A step named `path` (its location, or a diff with the old text). A step that hasn't run yet
   * (`ran` false) is read now: that is the file before the agent touches it, ignored by git or
   * not. One already done is compared with HEAD at the end (with git), or read now (without).
   */
  note(path: string, oldText?: string | null, ran = false): void {
    if (!path || !this.inside(path)) return;
    const key = pathKey(path);
    if (!this.named.some((p) => pathKey(p) === key)) this.named.push(path);
    if (this.before.has(key)) return;
    let known: FileSnap | undefined;
    if (oldText === null) known = { kind: "missing" };
    // Not run yet: the file as it is now is what it held before. (A diff's old text may be only
    // the edited snippet, as Claude Code's is, so the file itself is read.)
    else if (!ran) known = undefined;
    // Git knows a file that was clean at the start: HEAD's text, read at the end.
    else if (this.repo) return;
    // Without git, after the step: the diff's old text is the best guess (D208).
    else if (typeof oldText === "string") known = { kind: "text", text: oldText };
    this.before.set(key, { path, snap: known ? Promise.resolve(known) : snap(path) });
  }

  /** What the file held before the turn (or the user's last save in it), if known. */
  private async beforeOf(path: string, dirty: ReadonlySet<string>): Promise<FileSnap | undefined> {
    const key = pathKey(path);
    const saved = this.saved.get(key);
    // Saved by the user after the agent changed it: the agent's edit still counts (D233).
    if (saved && baselineAfterSave(this.agentWrote.get(key), saved.at) === "save")
      return saved.snap;
    let before: FileSnap | undefined = await this.before.get(key)?.snap;
    // Clean at the start: what HEAD has (a file git doesn't know was created).
    if (!before && this.repo && !dirty.has(key)) {
      const text = await this.git.show("HEAD", path).catch(() => undefined);
      if (text !== undefined) before = text === null ? { kind: "missing" } : { kind: "text", text };
    }
    return before;
  }

  /**
   * The files a finished step named, compared now (D223): its card shows what it changed while
   * the turn goes on. The end of the turn compares them again (a later step may change more).
   */
  async step(paths: readonly string[]): Promise<Pick<TurnResult, "changes" | "others">> {
    const out: Pick<TurnResult, "changes" | "others"> = { changes: [], others: [] };
    const dirty = new Set(this.dirtyBefore.map(pathKey));
    for (const path of candidates([paths], this.windows, 50)) {
      if (!this.inside(path)) continue;
      const key = pathKey(path);
      this.live.add(key);
      const change = compareSnaps(path, await this.beforeOf(path, dirty), await snap(path));
      // The agent's own write, seen now (D233): a later save by the user doesn't hide it.
      if (change && !this.agentWrote.has(key)) this.agentWrote.set(key, Date.now());
      if (change?.kind === "text") out.changes.push(change.change);
      else if (change) out.others.push(change.path);
    }
    return out;
  }

  /** Whether a step's comparison already took `path` this turn (the end compares it again). */
  comparedLive(path: string): boolean {
    return this.live.has(pathKey(path));
  }

  /**
   * Compares the folder with the start: the turn's changes (`skip`: ones already reviewed).
   * `stopped`: the user pressed Stop meanwhile: what's left isn't compared (D294).
   */
  async finish(
    skip: (path: string) => boolean,
    stopped: () => boolean = () => false,
  ): Promise<TurnResult> {
    this.listening.dispose();
    const result: TurnResult = {
      changes: [],
      others: [],
      committed: false,
      skipped: this.skipped,
      userSaved: [],
      savedOverAgent: [],
      bulk: [],
    };
    for (const [key, s] of this.saved)
      (baselineAfterSave(this.agentWrote.get(key), s.at) === "start"
        ? result.savedOverAgent
        : result.userSaved
      ).push(s.path);
    let dirtyAfter: string[] = [];
    if (this.repo) {
      try {
        const status = await this.git.status();
        dirtyAfter = this.statusPaths(status.files);
        result.committed = this.head !== null && status.branch.oid !== this.head;
      } catch {
        // The repository went away: only what was read at the start is compared.
      }
    }
    // Without git (D233): what the folder's listing says changed, beside what steps named.
    let listedChanges: string[] = [];
    const startTree = this.tree;
    if (!this.repo && startTree) {
      const now = await agentStoreIpc.treeStats(this.root, TREE_MAX_FILES).catch(() => null);
      const known = new Set(startTree.files.map((f) => f.path));
      if (now) {
        const changedRel = treeChanges(startTree.files, now.files, startTree.truncated).filter(
          (rel) => !ignoredPath(rel),
        );
        // A folder a command made and filled (a clone, a download): left out, and said (D294).
        const bulk = startTree.truncated
          ? new Map<string, number>()
          : bulkCreatedFolders(
              startTree.files,
              changedRel.filter((rel) => !known.has(rel)),
            );
        const inBulk = (rel: string) => {
          const norm = rel.split(/[\\/]/).join("/");
          for (const dir of bulk.keys()) if (norm.startsWith(`${dir}/`)) return true;
          return false;
        };
        result.bulk = [...bulk].map(([folder, files]) => ({ folder, files }));
        listedChanges = changedRel
          .filter((rel) => !inBulk(rel))
          .map((rel) => joinPath(this.root, rel, this.windows))
          .filter((p) => this.owns(p));
      }
      // A file the start's listing didn't have was created (when the listing was whole).
      if (!startTree.truncated)
        for (const path of listedChanges) {
          const rel = relativeTo(this.root, path, this.windows);
          const key = pathKey(path);
          if (rel !== null && !known.has(rel) && !this.before.has(key))
            this.before.set(key, { path, snap: Promise.resolve({ kind: "missing" }) });
        }
    }
    const dirty = new Set(this.dirtyBefore.map(pathKey));
    const all = candidates(
      [this.named, this.dirtyBefore, dirtyAfter, listedChanges],
      this.windows,
      Infinity,
    );
    const listed = new Set(listedChanges.map(pathKey));
    result.skipped += Math.max(0, all.length - COMPARE_MAX_FILES);
    const compared = all.slice(0, COMPARE_MAX_FILES);
    for (const [i, path] of compared.entries()) {
      if (stopped()) {
        result.skipped += compared.length - i;
        break;
      }
      if (skip(path)) continue;
      const before = await this.beforeOf(path, dirty);
      const after = await snap(path);
      const change = compareSnaps(path, before, after);
      if (change?.kind === "text") result.changes.push(change.change);
      else if (change) result.others.push(change.path);
      // Changed by its listing but not read at the start (over the caps): no diff to show.
      else if (!before && listed.has(pathKey(path))) result.others.push(path);
      else if (this.live.has(pathKey(path)) && before && before.kind !== "other") {
        // A step's change (shown already) that a later step put back: the same before and
        // after takes it out of the review.
        const text = before.kind === "text" ? before.text : null;
        result.changes.push({ path, before: text, after: text });
      }
    }
    return result;
  }

  /** The turn ended before finish (an error): stop listening for saves. */
  dispose(): void {
    this.listening.dispose();
  }
}

/**
 * What an external agent changed in a turn, across the workspace's folders (D251): `root` is the
 * folder the agent works in; when it is the workspace's first folder, every folder of the
 * workspace is watched (the agent may read and write in any of them).
 */
export class TurnWatch {
  private readonly watches: { root: string; watch: FolderWatch }[];

  constructor(
    services: WorkbenchServices,
    root: string,
    writtenByIde: (path: string) => boolean = () => false,
  ) {
    const primary = services.workspace.root.peek();
    const folders =
      primary && samePath(primary, root) && services.workspace.folders.peek().length > 1
        ? services.workspace.folderPaths()
        : [root];
    const list = folders.map((path) => ({ path }));
    // A file is the innermost folder's (a package folder inside a repository folder).
    const ownedBy = (folder: string) => (path: string) =>
      samePath(folderOf(list, path)?.path ?? folder, folder);
    this.watches = folders.map((folder, i) => ({
      root: folder,
      watch:
        i === 0
          ? new FolderWatch(
              services,
              folder,
              writtenByIde,
              gitIpc,
              true,
              folders.length > 1 ? ownedBy(folder) : undefined,
            )
          : new FolderWatch(
              services,
              folder,
              writtenByIde,
              createGitIpc(folder),
              false,
              ownedBy(folder),
            ),
    }));
  }

  private ownerOf(path: string): FolderWatch | undefined {
    return this.watches.find((w) => w.watch.inside(path))?.watch;
  }

  /** Reads every folder as it is before the turn. Never throws. */
  async start(): Promise<void> {
    await Promise.all(this.watches.map((w) => w.watch.start()));
  }

  /** A step named `path` (see FolderWatch.note): the folder holding it notes it. */
  note(path: string, oldText?: string | null, ran = false): void {
    if (path) this.ownerOf(path)?.note(path, oldText, ran);
  }

  /** The files a finished step named, compared now, each by its own folder. */
  async step(paths: readonly string[]): Promise<Pick<TurnResult, "changes" | "others">> {
    const out: Pick<TurnResult, "changes" | "others"> = { changes: [], others: [] };
    for (const { watch } of this.watches) {
      const mine = paths.filter((p) => watch.inside(p));
      if (!mine.length) continue;
      const r = await watch.step(mine);
      out.changes.push(...r.changes);
      out.others.push(...r.others);
    }
    return out;
  }

  /** Whether a step's comparison already took `path` this turn. */
  comparedLive(path: string): boolean {
    return this.watches.some((w) => w.watch.comparedLive(path));
  }

  /** Compares every folder with the start: the turn's changes (`stopped`: Stop was pressed). */
  async finish(
    skip: (path: string) => boolean,
    stopped: () => boolean = () => false,
  ): Promise<TurnResult> {
    const results = await Promise.all(this.watches.map((w) => w.watch.finish(skip, stopped)));
    const all: TurnResult = {
      changes: [],
      others: [],
      committed: false,
      skipped: 0,
      userSaved: [],
      savedOverAgent: [],
      bulk: [],
    };
    for (const r of results) {
      all.changes.push(...r.changes);
      all.others.push(...r.others);
      all.committed ||= r.committed;
      all.skipped += r.skipped;
      all.userSaved.push(...r.userSaved);
      all.savedOverAgent.push(...r.savedOverAgent);
      all.bulk.push(...r.bulk);
    }
    return all;
  }

  dispose(): void {
    for (const w of this.watches) w.watch.dispose();
  }
}
