// The open workspace: one folder, or several (D251, VS Code's multi-root workspaces, kept in a
// `.code-workspace` file). Opening goes: will-close participants (may veto, e.g. unsaved
// editors) → save old state → Rust re-scopes fs access → restore the new workspace's state.
//
// `root` is the FIRST folder (the primary) in both cases, so everything that works on "the
// folder" keeps working; `folders` lists them all, `file` is the workspace file (null for a
// single folder). Folders after the first are added and removed live (`onDidChangeFolders`);
// a change of the first folder reopens the workspace, since so much is keyed to it.
import type { ContextKeyService } from "../core/context/index";
import { Emitter } from "../core/events/index";
import { fsIpc } from "../core/ipc/fs";
import { appIpc } from "../core/ipc/system";
import { type Disposable, toDisposable } from "../core/lifecycle/index";
import {
  basename,
  dirname,
  isAbsolute,
  isWithin,
  joinPath,
  pathKey,
  relativePath,
  resolveInRoot,
  samePath,
} from "../core/paths/index";
import { product } from "../core/product";
import { batch, computed, type ReadonlySignal, type Signal, signal } from "../core/reactive/index";
import {
  authorityString,
  formatRemoteLocation,
  parseRemoteLocation,
  type RemoteAuthority,
  remoteLabel,
} from "../core/workspace/remoteLocation";
import {
  folderOf,
  isWorkspaceFile,
  newWorkspaceText,
  parseWorkspaceFile,
  resolveFolders,
  type WorkspaceFileData,
  type WorkspaceFolder,
  withFolders,
  withWorkspaceSetting,
  workspaceFileName,
  workspaceRelative,
} from "../core/workspace/workspaceFile";
import type { GlobalState, PersistenceService } from "./persistence";
import {
  forgetWorkspaceFolderOf,
  resolveWorkspaceFolder,
  resolveWorkspaceFolderOf,
} from "./workspaceFolder";

export type { WorkspaceFolder } from "../core/workspace/workspaceFile";

/** Returns false to cancel closing the current workspace. */
/** Why the folder closes: switching or closing the folder, or the whole window (hot exit). */
export type CloseReason = "folder" | "window";
export type WillCloseParticipant = (reason: CloseReason) => Promise<boolean>;
/**
 * Asked before a folder opens (D213: the risky-folder caution); false cancels the open. Called
 * again with the canonical path when it differs (`requested`: the path first asked about).
 */
export type OpenGuard = (path: string, requested?: string) => Promise<boolean>;
/**
 * Asked before folders the user didn't pick join the workspace (D251 audit): ones a workspace
 * file lists when it changes on disk (anything that can write it could otherwise widen what the
 * agent and extensions reach), network folders a workspace file names (opening one sends the
 * user's sign-in to that host). False leaves them out.
 */
export type AddConfirm = (paths: readonly string[], why: "file" | "network") => Promise<boolean>;
/** Asked before folders join a trusted workspace (trust.ts): false cancels the add. */
export type TrustGuard = (paths: readonly string[], answer?: boolean) => Promise<boolean>;

const isNetworkPath = (p: string) => /^[\\/]{2}/.test(p);

/** Folders added or taken out of the open workspace (not on open or close). */
export interface FoldersChange {
  added: readonly WorkspaceFolder[];
  removed: readonly WorkspaceFolder[];
}

/** A folder the workspace file lists that isn't there (moved, a drive not connected). */
export interface MissingFolder {
  path: string;
  name: string;
  error: string;
}

const MAX_RECENT = 10;

/** An untitled workspace's file (the app's data folder, `workspace_untitled_path`). */
export function isUntitledWorkspace(file: string | null): boolean {
  return !!file && /[\\/]workspaces[\\/]untitled[\\/][^\\/]+\.code-workspace$/i.test(file);
}

/** How a workspace location (a folder, or a workspace file) is named in lists and titles. */
export function locationLabel(location: string): string {
  // A remote one (D252): its name with the host, "app [SSH: box]".
  const remote = parseRemoteLocation(location);
  if (remote)
    return `${locationLabel(remote.path === "/" ? "/" : remote.path)} [${remoteLabel(remote.authority)}]`;
  if (!isWorkspaceFile(location)) return basename(location) || location;
  return isUntitledWorkspace(location)
    ? "Untitled (Workspace)"
    : `${workspaceFileName(location)} (Workspace)`;
}

export class WorkspaceService implements Disposable {
  readonly root: Signal<string | null> = signal<string | null>(null);
  /** Every folder of the workspace, the first (`root`) first. Empty with nothing open. */
  readonly folders: Signal<readonly WorkspaceFolder[]> = signal<readonly WorkspaceFolder[]>([]);
  /** The `.code-workspace` file of a multi-root workspace; null for a single folder. */
  readonly file: Signal<string | null> = signal<string | null>(null);
  /** The workspace file's contents as last read (settings, launch, tasks); null without one. */
  readonly fileData: Signal<WorkspaceFileData | null> = signal<WorkspaceFileData | null>(null);
  /** Folders the workspace file lists that couldn't be opened. */
  readonly missing: Signal<readonly MissingFolder[]> = signal<readonly MissingFolder[]>([]);
  /** Recently opened folders and workspace files, newest first (set from global state at startup). */
  readonly recent: Signal<readonly string[]> = signal<readonly string[]>([]);
  /** Folders pinned at the top of the recent list (D192): never dropped as others are opened. */
  readonly pinned: Signal<readonly string[]> = signal<readonly string[]>([]);
  /** The remote this window works on (D252: set by the remote extension); null when local. */
  readonly remote: Signal<RemoteAuthority | null> = signal<RemoteAuthority | null>(null);
  /**
   * What reopens this workspace: the workspace file, else the folder; a remote window's as a
   * remote location ("ssh://box/home/me/app").
   */
  readonly location: ReadonlySignal<string | null> = computed(() => {
    const local = this.file.value ?? this.root.value;
    const remote = this.remote.value;
    return local && remote ? formatRemoteLocation({ authority: remote, path: local }) : local;
  });

  /** Pinned folders first, then the rest of the recent ones (newest first). */
  recentOrdered(): string[] {
    const pinned = this.pinned.peek();
    return [...pinned, ...this.recent.peek().filter((p) => !pinned.some((q) => samePath(p, q)))];
  }

  async setPinned(path: string, pinned: boolean): Promise<void> {
    await this.persistence.saveGlobal((current) => {
      this.adoptLists(current);
      const rest = this.pinned.peek().filter((p) => !samePath(p, path));
      this.pinned.value = pinned ? [...rest, path] : rest;
      if (pinned && !this.recent.peek().some((p) => samePath(p, path)))
        this.recent.value = [path, ...this.recent.peek()];
      return {
        pinnedFolders: [...this.pinned.peek()],
        recentFolders: [...this.recent.peek()],
      };
    });
  }

  /**
   * Reads the recent and pinned lists again (D273): each window kept its own copy, so a folder
   * opened in another window was missing from this one's welcome page until it wrote the list.
   */
  async refreshLists(): Promise<void> {
    const current = await this.persistence.refreshGlobal();
    // Unchanged (most focus changes): nothing re-renders.
    const same = (a: readonly string[] | undefined, b: readonly string[]) =>
      !a || JSON.stringify(a) === JSON.stringify(b);
    if (
      same(current.recentFolders, this.recent.peek()) &&
      same(current.pinnedFolders, this.pinned.peek())
    )
      return;
    batch(() => this.adoptLists(current));
  }

  /** The recent and pinned lists as another window may have left them on disk. */
  private adoptLists(current: Readonly<GlobalState>): void {
    if (current.recentFolders) this.recent.value = current.recentFolders;
    if (current.pinnedFolders) this.pinned.value = current.pinnedFolders;
  }
  /** The folder or workspace file being opened right now (D169): the title bar and welcome page show it. */
  readonly opening: Signal<string | null> = signal<string | null>(null);
  /** The workspace's name: the folder's, or the workspace file's with "(Workspace)". */
  readonly name: ReadonlySignal<string | null> = computed(() => {
    const file = this.file.value;
    if (file) return locationLabel(file);
    const root = this.root.value;
    return root ? basename(root) || root : null;
  });
  private readonly participants = new Set<WillCloseParticipant>();
  private openGuard: OpenGuard | null = null;
  private addConfirm: AddConfirm | null = null;
  private trustGuard: TrustGuard | null = null;
  /** Folders the workspace file lists that the user said no to this time it's open. */
  private declined = new Set<string>();
  /** The newest requested open, so a repeat request for the same folder joins it. */
  private pendingOpen: { path: string; promise: Promise<string | null> } | null = null;
  /** The end of the open queue: each open starts after the previous one settled. */
  private openQueue: Promise<unknown> = Promise.resolve();
  /** Folder changes run one at a time, after any open. */
  private changeQueue: Promise<unknown> = Promise.resolve();
  private readonly opened = new Emitter<string>();
  private readonly closed = new Emitter<void>();
  private readonly foldersChanged = new Emitter<FoldersChange>();
  /** Fires after a folder is open and its saved state restored. */
  readonly onDidOpen = this.opened.event;
  /** Fires when the current folder is being closed (before the next opens). */
  readonly onDidClose = this.closed.event;
  /** Fires after folders were added to or removed from the open workspace (D251). */
  readonly onDidChangeFolders = this.foldersChanged.event;

  constructor(
    private readonly context: ContextKeyService,
    private readonly persistence: PersistenceService,
  ) {}

  onWillClose(participant: WillCloseParticipant): Disposable {
    this.participants.add(participant);
    return toDisposable(() => this.participants.delete(participant));
  }

  /** The check before every open (Open folder, recent, the command line, a drop). */
  setOpenGuard(guard: OpenGuard | null): Disposable {
    this.openGuard = guard;
    return toDisposable(() => {
      if (this.openGuard === guard) this.openGuard = null;
    });
  }

  setAddConfirm(confirm: AddConfirm | null): Disposable {
    this.addConfirm = confirm;
    return toDisposable(() => {
      if (this.addConfirm === confirm) this.addConfirm = null;
    });
  }

  setTrustGuard(guard: TrustGuard | null): Disposable {
    this.trustGuard = guard;
    return toDisposable(() => {
      if (this.trustGuard === guard) this.trustGuard = null;
    });
  }

  /**
   * Folders Rust opened under another name (a link, another spelling) get the risky-folder
   * question as the folder they are; the ones refused are taken out again. Returns the requested
   * paths refused.
   */
  private async guardCanonical(
    pairs: readonly { requested: string; canonical: string }[],
  ): Promise<Set<string>> {
    const refused = new Set<string>();
    if (!this.openGuard) return refused;
    for (const { requested, canonical } of pairs)
      if (!samePath(requested, canonical) && !(await this.openGuard(canonical, requested)))
        refused.add(pathKey(requested));
    return refused;
  }

  private async confirmAdd(paths: readonly string[], why: "file" | "network"): Promise<boolean> {
    if (!paths.length) return true;
    return this.addConfirm ? this.addConfirm(paths, why).catch(() => false) : false;
  }

  /** Runs will-close participants; false if any vetoed. */
  async confirmClose(reason: CloseReason = "folder"): Promise<boolean> {
    for (const participant of this.participants) {
      if (!(await participant(reason))) return false;
    }
    return true;
  }

  /** Whether the window has a multi-root workspace (a workspace file) open. */
  isMultiRoot(): boolean {
    return this.file.peek() !== null;
  }

  /** The folder that holds `path` (the innermost when folders nest), if any. */
  folderOf(path: string): WorkspaceFolder | undefined {
    return folderOf(this.folders.peek(), path);
  }

  /** Every folder's path, the first first (empty with nothing open). */
  folderPaths(): string[] {
    return this.folders.peek().map((f) => f.path);
  }

  /**
   * Whether `path` is in one of the workspace's folders (or is one): what `isWithin(root, path)`
   * was with one folder (D251).
   */
  contains(path: string): boolean {
    const folders = this.folders.peek();
    if (!folders.length) {
      const root = this.root.peek();
      return !!root && isWithin(root, path);
    }
    return folders.some((f) => isWithin(f.path, path));
  }

  /**
   * A path given by the user, an agent or an extension, made absolute: `resolveInRoot(root, …)`
   * with one folder. In a multi-root workspace a relative path may start with a folder's name
   * ("api/src/main.ts", as `relative` writes it); otherwise it's relative to the first folder.
   * An absolute path inside a folder is spelled with that folder's case.
   */
  resolve(path: string): string {
    const root = this.root.peek() ?? "";
    const folders = this.folders.peek();
    if (folders.length <= 1 || isAbsolute(path)) {
      const owner = isAbsolute(path) ? this.folderOf(path) : undefined;
      return resolveInRoot(owner?.path ?? root, path);
    }
    const clean = path.replace(/^\.?[\\/]+/, "");
    const [head, ...rest] = clean.split(/[\\/]/);
    const named = folders.find((f) => f.name === head);
    if (named) return rest.length ? resolveInRoot(named.path, rest.join("/")) : named.path;
    return resolveInRoot(root, path);
  }

  /**
   * `path` as the workspace shows and stores it: relative to its folder, with the folder's name in
   * front when there are several ("api/src/main.ts"); `relativePath(root, …)` with one folder.
   * `resolve` reads it back. A path outside every folder comes back unchanged.
   */
  relative(path: string): string {
    const folders = this.folders.peek();
    if (folders.length <= 1) {
      const root = this.root.peek();
      return root ? relativePath(root, path) : path;
    }
    return workspaceRelative(folders, path, true);
  }

  /**
   * Opens `path` as the workspace: a folder, or a `.code-workspace` file (D251). Returns the
   * canonical first folder, or null if cancelled. Opens never overlap (a double-click on a
   * recent folder would otherwise close, re-scope and restore twice, interleaved): the same
   * location again joins the pending open, another one waits its turn.
   */
  open(path: string): Promise<string | null> {
    const pending = this.pendingOpen;
    if (pending && samePath(pending.path, path)) return pending.promise;
    // The previous open's failure is reported to its own caller; it doesn't block this one. A
    // folder change in progress finishes first (one queue for both, so neither sees the other's
    // half-done state).
    const promise = Promise.all([
      this.openQueue.catch(() => {}),
      this.changeQueue.catch(() => {}),
    ]).then(() => this.openNow(path));
    const entry = { path, promise };
    this.pendingOpen = entry;
    this.openQueue = promise;
    promise
      .finally(() => {
        if (this.pendingOpen === entry) this.pendingOpen = null;
      })
      .catch(() => {}); // the caller handles the rejection; this chain only clears the slot
    return promise;
  }

  private async openNow(path: string): Promise<string | null> {
    // A remote location (D252): this window's remote opens its path here; another remote (or a
    // local window) gets a window of its own.
    const remote = parseRemoteLocation(path);
    if (remote) {
      const here = this.remote.peek();
      if (!here || authorityString(here) !== authorityString(remote.authority)) {
        await appIpc.newRemoteWindow(remote.path, authorityString(remote.authority));
        return null;
      }
      path = remote.path;
    } else if (this.remote.peek() && /^[A-Za-z]:|^\\\\/.test(path)) {
      // A local folder from a remote window: a local window of its own.
      await appIpc.newWindow(path);
      return null;
    }
    // "a/../x.code-workspace" as the file it names (Rust takes no "..").
    if (isWorkspaceFile(path) && isAbsolute(path)) path = resolveInRoot(path, path);
    try {
      if (!isWorkspaceFile(path)) return await this.openSteps(path);
      try {
        return await this.openFileSteps(path);
      } catch (err) {
        // A folder whose name ends in .code-workspace opens as the folder it is.
        if (/not a \.code-workspace file/.test(errorText(err))) return await this.openSteps(path);
        throw err;
      }
    } finally {
      this.opening.value = null;
    }
  }

  /** Closes what's open (after the participants agreed), so the next can open. */
  private async closeCurrent(): Promise<boolean> {
    if (this.root.peek() === null) return true;
    if (!(await this.confirmClose())) return false;
    await this.persistence.flush();
    this.persistence.closeWorkspace();
    this.closed.fire();
    return true;
  }

  /** The window has nothing open (after a failed open, the old folder already closed). */
  private markClosed(): void {
    if (this.root.peek() !== null || this.file.peek() !== null) {
      batch(() => {
        this.root.value = null;
        this.folders.value = [];
        this.file.value = null;
        this.fileData.value = null;
        this.missing.value = [];
      });
      this.syncContext();
    }
  }

  private async openSteps(path: string): Promise<string | null> {
    // Before anything closes: a cancelled caution leaves the current folder as it was.
    if (this.openGuard && !(await this.openGuard(path))) return null;
    if (!(await this.closeCurrent())) return null;
    // Shown once the unsaved-files question (if any) is answered.
    this.opening.value = path;
    let canonical: string;
    try {
      canonical = await fsIpc.openWorkspace(path);
    } catch (err) {
      // The old folder is already closed: say so instead of looking half-open.
      this.markClosed();
      throw err;
    }
    // A link into a risky folder (D213) is asked about as the folder it is.
    if (this.openGuard && !samePath(canonical, path) && !(await this.openGuard(canonical, path))) {
      this.markClosed();
      await fsIpc.closeWorkspace().catch(() => {});
      return null;
    }
    await migrateWorkspaceFolder(canonical);
    // The workspace folders the project already has (the legacy folder name, .vscode; D177),
    // before anything reads from them.
    await resolveWorkspaceFolder(canonical);
    this.declined.clear();
    batch(() => {
      this.file.value = null;
      this.fileData.value = null;
      this.missing.value = [];
      this.folders.value = [{ path: canonical, name: basename(canonical) || canonical, index: 0 }];
      this.root.value = canonical;
    });
    this.syncContext();
    await this.persistence.restoreWorkspace();
    await this.remember(canonical);
    this.opened.fire(canonical);
    return canonical;
  }

  /**
   * Opens a `.code-workspace` file (D251): its first folder that exists is the primary, the
   * others are added; folders that can't be opened are listed in `missing`.
   */
  private async openFileSteps(file: string): Promise<string | null> {
    if (this.remote.peek())
      throw new Error("Workspace files can't be opened in a remote window yet: open a folder.");
    const data = await this.readFile(file);
    const all = resolveFolders(file, data.folders);
    if (!this.pendingReopen) this.declined.clear();
    // Network folders a workspace file names: opening one connects to that host with the user's
    // sign-in (D161), so they're asked about first.
    const network = all.filter((f) => isNetworkPath(f.path) && !this.declined.has(pathKey(f.path)));
    if (
      network.length &&
      !this.pendingReopen &&
      !(await this.confirmAdd(
        network.map((f) => f.path),
        "network",
      ))
    )
      for (const f of network) this.declined.add(pathKey(f.path));
    const listed = all.filter((f) => !this.declined.has(pathKey(f.path)));
    if (!listed.length)
      throw new Error(
        `${locationLabel(file)} has no folders: add one to its "folders" list, or open a folder.`,
      );
    // Each folder it lists, and the folder the file itself is in (it brings settings, tasks and
    // launch configurations of its own); not again when the workspace reopens for a change.
    if (!this.pendingReopen && this.openGuard) {
      const asked = [
        ...listed.map((f) => f.path),
        ...(isUntitledWorkspace(file) ? [] : [dirname(file)]),
      ];
      for (const p of asked) if (!(await this.openGuard(p))) return null;
    }
    if (!(await this.closeCurrent())) return null;
    this.opening.value = file;
    let primary: string | null = null;
    let primaryIndex = -1;
    const missing: MissingFolder[] = all
      .filter((f) => this.declined.has(pathKey(f.path)))
      .map((f) => ({ path: f.path, name: f.name, error: DECLINED }));
    for (const [i, f] of listed.entries()) {
      try {
        primary = await fsIpc.openWorkspace(f.path);
        primaryIndex = i;
        break;
      } catch (err) {
        missing.push({ path: f.path, name: f.name, error: errorText(err) });
      }
    }
    if (primary === null) {
      this.markClosed();
      throw new Error(`None of the folders of ${locationLabel(file)} could be opened.`);
    }
    // The file as Rust keeps it (canonical): what the recent list and the window registry say.
    let canonicalFile = file;
    try {
      canonicalFile = (await fsIpc.workspaceSetFile(file)) ?? file;
    } catch (err) {
      this.markClosed();
      await fsIpc.closeWorkspace().catch(() => {});
      throw err;
    }
    const first = listed[primaryIndex];
    const others = listed.slice(primaryIndex + 1);
    const statuses = others.length
      ? await fsIpc.workspaceFoldersSet(others.map((f) => f.path))
      : [];
    const raw: WorkspaceFolder[] = [
      { path: primary, name: first?.name ?? basename(primary), index: 0 },
    ];
    // Others that opened under another name are asked about as the folder they are.
    const refused = this.pendingReopen
      ? new Set<string>()
      : await this.guardCanonical(
          others.flatMap((f, i) => {
            const c = statuses[i]?.canonical;
            return c ? [{ requested: f.path, canonical: c }] : [];
          }),
        );
    for (const [i, f] of others.entries()) {
      const s = statuses[i];
      if (refused.has(pathKey(f.path)))
        missing.push({ path: f.path, name: f.name, error: DECLINED });
      else if (s?.canonical && !raw.some((x) => samePath(x.path, s.canonical as string)))
        raw.push({ path: s.canonical, name: f.name, index: raw.length });
      else if (!s?.canonical)
        missing.push({ path: f.path, name: f.name, error: s?.error ?? "not found" });
    }
    if (refused.size)
      await fsIpc.workspaceFoldersSet(raw.slice(1).map((f) => f.path)).catch(() => []);
    const folders = this.withUniqueNames(raw);
    // A workspace file outside its folders can be opened, edited and saved like one of them.
    await fsIpc.allowFile(canonicalFile).catch(() => {});
    await migrateWorkspaceFolder(primary);
    await resolveWorkspaceFolder(primary);
    await Promise.all(folders.slice(1).map((f) => prepareOtherFolder(f.path)));
    batch(() => {
      this.file.value = canonicalFile;
      this.fileData.value = data;
      this.missing.value = missing;
      this.folders.value = folders;
      this.root.value = primary;
    });
    this.syncContext();
    await this.persistence.restoreWorkspace();
    await this.remember(canonicalFile);
    this.opened.fire(primary);
    return primary;
  }

  /** The workspace file's contents (throws a readable error for a broken one). */
  private async readFile(file: string): Promise<WorkspaceFileData> {
    const parsed = parseWorkspaceFile(await fsIpc.workspaceFileRead(file));
    if (!parsed.ok) throw new Error(`${locationLabel(file)}: ${parsed.error}`);
    return parsed.data;
  }

  /** The workspace file's text as it is on disk now (empty when it's gone). */
  private async fileText(file: string): Promise<string> {
    return fsIpc.workspaceFileRead(file).catch(() => "");
  }

  /** Adds `location` to the recent list and makes it the folder the next start reopens. */
  private async remember(local: string): Promise<void> {
    // A remote window's folders are remembered with their host (D252).
    const remote = this.remote.peek();
    const location = remote ? formatRemoteLocation({ authority: remote, path: local }) : local;
    // From the lists on disk: another window may have opened or pinned folders since.
    await this.persistence.saveGlobal((current) => {
      this.adoptLists(current);
      const recent = [location, ...this.recent.peek().filter((p) => !samePath(p, location))];
      // Pinned folders don't count toward the limit and are never trimmed (D192).
      const pinned = this.pinned.peek();
      const isPinned = (p: string) => pinned.some((q) => samePath(p, q));
      this.recent.value = [
        ...recent.filter((p) => !isPinned(p)).slice(0, MAX_RECENT),
        ...recent.filter(isPinned),
      ];
      return { lastFolder: location, recentFolders: [...this.recent.peek()] };
    });
  }

  private syncContext(): void {
    const folders = this.folders.peek().length;
    this.context.set("workspaceOpen", this.root.peek() !== null);
    // VS Code's: "empty", "folder" or "workspace" (a workspace file), and how many folders.
    this.context.set(
      "workbenchState",
      this.root.peek() === null ? "empty" : this.file.peek() ? "workspace" : "folder",
    );
    this.context.set("workspaceFolderCount", folders);
  }

  // ---- Folders of a multi-root workspace (D251) -------------------------------------------

  /**
   * Adds folders to the workspace (VS Code's "Add Folder to Workspace…"). A window with one
   * folder becomes an untitled multi-root workspace (no reload: its state moves with it); with
   * nothing open, the first opens as the folder. Folders already in the workspace are skipped.
   * Returns the folders added.
   */
  addFolders(
    paths: readonly string[],
    options: { trust?: boolean } = {},
  ): Promise<WorkspaceFolder[]> {
    return this.queueChange(async () => {
      const wanted = paths.filter((p) => !this.folders.peek().some((f) => samePath(f.path, p)));
      if (!wanted.length) return [];
      if (this.root.peek() === null) {
        const [first, ...rest] = wanted;
        if (!first) return [];
        // Already in the queue: the open runs here, not behind ourselves.
        const opened = await this.openNow(first);
        if (!opened || !rest.length) return opened ? [...this.folders.peek()] : [];
        return this.addFoldersNow(rest, options.trust);
      }
      return this.addFoldersNow(wanted, options.trust);
    });
  }

  private async addFoldersNow(
    wanted: readonly string[],
    trust?: boolean,
  ): Promise<WorkspaceFolder[]> {
    // A remote window's workspace file would have to live on the remote (VS Code keeps it there);
    // not built yet (D252).
    if (this.remote.peek())
      throw new Error(
        "A remote window has one folder for now: open another folder in a new window.",
      );
    for (const p of wanted) if (this.openGuard && !(await this.openGuard(p))) return [];
    // Joining a trusted workspace: their authors are asked about first (VS Code).
    if (this.trustGuard && !(await this.trustGuard(wanted, trust))) return [];
    if (!this.file.peek()) await this.becomeWorkspace();
    const before = this.folders.peek();
    const list = [
      ...before.map((f) => ({ path: f.path, name: f.name })),
      ...wanted.map((path) => ({ path })),
    ];
    await this.applyFolderList(list);
    return this.folders.peek().filter((f) => !before.some((b) => samePath(b.path, f.path)));
  }

  /**
   * Takes a folder out of the workspace. The last one can't be (close the workspace instead);
   * taking out the first reopens the workspace with the next one first.
   */
  removeFolder(path: string): Promise<boolean> {
    return this.queueChange(async () => {
      const folders = this.folders.peek();
      const target = folders.find((f) => samePath(f.path, path));
      const missing = this.missing.peek().find((m) => samePath(m.path, path));
      if (!target && !missing) return false;
      if (missing) {
        // A missing folder only leaves the file's list.
        this.missing.value = this.missing.peek().filter((m) => m !== missing);
        await this.writeFolderList(folders.map((f) => ({ path: f.path, name: f.name })));
        return true;
      }
      if (folders.length <= 1)
        throw new Error("A workspace keeps at least one folder: close the workspace instead.");
      if (!this.file.peek()) return false;
      const list = folders.filter((f) => f !== target).map((f) => ({ path: f.path, name: f.name }));
      await this.applyFolderList(list);
      return true;
    });
  }

  /** Renames a folder as the workspace shows it (the file's `name`; "" for the folder's own). */
  renameFolder(path: string, name: string): Promise<void> {
    return this.queueChange(async () => {
      if (!this.file.peek())
        throw new Error("Only a multi-root workspace's folders have names of their own.");
      const folders = this.folders.peek();
      if (!folders.some((f) => samePath(f.path, path)))
        throw new Error(`${path} isn't in the workspace.`);
      const trimmed = name.trim();
      this.autoNamed.delete(pathKey(path));
      this.folders.value = this.withUniqueNames(
        folders.map((f) =>
          samePath(f.path, path) ? { ...f, name: trimmed || basename(f.path) } : f,
        ),
      );
      await this.writeFolderList(this.folders.peek().map((f) => ({ path: f.path, name: f.name })));
      // Nothing added or removed, but the explorer and the others show the new name.
      this.foldersChanged.fire({ added: [], removed: [] });
    });
  }

  /**
   * Saves the workspace as a file (VS Code's "Save Workspace As…"): an untitled one, or a single
   * folder made into a workspace. Its state moves with it.
   */
  saveAs(given: string): Promise<string> {
    // "a/../x.code-workspace" as the file it names (Rust takes no "..").
    const target = isAbsolute(given) ? resolveInRoot(given, given) : given;
    return this.queueChange(async () => {
      if (this.remote.peek())
        throw new Error("A remote window's workspace can't be saved as a file yet.");
      if (!isWorkspaceFile(target))
        throw new Error("A workspace file's name ends in .code-workspace.");
      if (this.root.peek() === null) throw new Error("Open a folder first.");
      const folders = this.folders.peek().map((f) => ({ path: f.path, name: f.name }));
      const current = this.file.peek();
      // The rest of the file (settings, launch, tasks, comments) comes along.
      const text = current ? await this.fileText(current) : "";
      const next = text.trim()
        ? withFolders(text, target, folders)
        : newWorkspaceText(target, folders);
      await fsIpc.workspaceFileWrite(target, next);
      await this.switchFile(target);
      this.fileData.value = this.parsedOrEmpty(next);
      await this.forget(current && isUntitledWorkspace(current) ? current : null);
      const saved = this.file.peek() ?? target;
      await this.remember(saved);
      // A single folder became a workspace: its settings now come from the workspace file and its
      // folder layer, the explorer shows the workspace (nothing added or removed).
      if (!current) this.foldersChanged.fire({ added: [], removed: [] });
      return saved;
    });
  }

  /**
   * Sets a workspace setting in the workspace file (D251: the workspace's settings layer). The
   * settings service calls this for the workspace scope of a multi-root workspace.
   */
  writeSetting(key: string, value: unknown | ((current: unknown) => unknown)): Promise<void> {
    return this.queueChange(async () => {
      const file = this.file.peek();
      if (!file) throw new Error("Not a multi-root workspace.");
      const text = await this.fileText(file);
      // A function computes the value from the file as it is now (a language block's other keys).
      const resolved =
        typeof value === "function"
          ? (value as (current: unknown) => unknown)(this.parsedOrEmpty(text).settings[key])
          : value;
      const next = withWorkspaceSetting(text, key, resolved);
      await fsIpc.workspaceFileWrite(file, next);
      if (this.file.peek() === file) this.fileData.value = this.parsedOrEmpty(next);
    });
  }

  /**
   * Reads the workspace file again (it was saved in an editor, or changed on disk): its settings
   * and launch / tasks take effect, and a changed folder list is applied.
   */
  reloadFile(): Promise<void> {
    return this.queueChange(async () => {
      const file = this.file.peek();
      if (!file) return;
      let data: WorkspaceFileData;
      try {
        data = await this.readFile(file);
      } catch {
        // Mid-edit (a syntax error): keep what was read last.
        return;
      }
      // Another workspace opened while the file was read.
      if (this.file.peek() !== file) return;
      const before = this.fileData.peek();
      this.fileData.value = data;
      const listed = resolveFolders(file, data.folders);
      // The same folders in the same order, the same names: only its settings, tasks or launch
      // configurations changed.
      const was = before ? resolveFolders(file, before.folders) : [];
      const sameList =
        listed.length === was.length &&
        listed.every((f, i) => samePath(f.path, was[i]?.path ?? "") && f.name === was[i]?.name);
      if (sameList || !listed.length) return;
      // Folders the file now lists that the window doesn't have: something wrote the file (an
      // edit in an editor, a git pull, an extension, the agent). The user says whether they join.
      const known = (p: string) =>
        this.folders.peek().some((f) => samePath(f.path, p)) ||
        this.missing.peek().some((m) => samePath(m.path, p));
      const fresh = listed.filter((f) => !known(f.path) && !this.declined.has(pathKey(f.path)));
      if (fresh.length) {
        const paths = fresh.map((f) => f.path);
        const ok =
          (await this.confirmAdd(
            paths,
            fresh.some((f) => isNetworkPath(f.path)) ? "network" : "file",
          )) &&
          (!this.openGuard || (await everyAsync(paths, (p) => (this.openGuard as OpenGuard)(p)))) &&
          (!this.trustGuard || (await this.trustGuard(paths)));
        if (!ok) for (const p of paths) this.declined.add(pathKey(p));
      }
      if (this.file.peek() !== file) return;
      await this.applyFolderList(
        listed
          .filter((f) => !this.declined.has(pathKey(f.path)))
          .map((f) => ({ path: f.path, name: f.name })),
        false,
      );
      // The declined ones stay listed in the file, shown as not added.
      const declined = listed.filter((f) => this.declined.has(pathKey(f.path)));
      if (declined.length)
        this.missing.value = [
          ...this.missing.peek().filter((m) => !declined.some((d) => samePath(d.path, m.path))),
          ...declined.map((f) => ({ path: f.path, name: f.name, error: DECLINED })),
        ];
    });
  }

  /** Runs folder changes one after another (and after any open in progress). */
  private queueChange<T>(run: () => Promise<T>): Promise<T> {
    const next = Promise.all([
      this.openQueue.catch(() => {}),
      this.changeQueue.catch(() => {}),
    ]).then(run);
    this.changeQueue = next;
    return next;
  }

  /** A single-folder window becomes an untitled multi-root workspace (D251), in place. */
  private async becomeWorkspace(): Promise<void> {
    const root = this.root.peek();
    if (!root) throw new Error("Open a folder first.");
    const file = await fsIpc.workspaceUntitledPath();
    const text = newWorkspaceText(file, [{ path: root }]);
    await fsIpc.workspaceFileWrite(file, text);
    await this.switchFile(file);
    this.fileData.value = this.parsedOrEmpty(text);
    await this.remember(this.file.peek() ?? file);
  }

  /**
   * Makes `file` the workspace's file: Rust keys the window's state and its place among windows
   * by it from now on, so the state is written there at once.
   */
  private async switchFile(file: string): Promise<void> {
    this.file.value = (await fsIpc.workspaceSetFile(file)) ?? file;
    // Outside its folders, it's still the window's own file to open, edit and save.
    await fsIpc.allowFile(this.file.peek() ?? file).catch(() => {});
    this.syncContext();
    await this.persistence.flush();
  }

  /** Folders whose name the workspace made unique ("app (2)"): their file entry has no name. */
  private readonly autoNamed = new Set<string>();

  /**
   * Names as paths can use them (D251: `relative` writes "<name>/…" and `resolve` reads it): no
   * slashes, and unique — a second "app" (another checkout) is "app (2)", as VS Code tells them
   * apart. The file keeps what the user wrote.
   */
  private withUniqueNames(folders: readonly WorkspaceFolder[]): WorkspaceFolder[] {
    const taken = new Set<string>();
    return folders.map((f, index) => {
      const base = f.name.replace(/[\\/]+/g, "-").trim() || basename(f.path) || f.path;
      let name = base;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})`;
      taken.add(name.toLowerCase());
      if (name !== f.name) this.autoNamed.add(pathKey(f.path));
      else this.autoNamed.delete(pathKey(f.path));
      return { path: f.path, name, index };
    });
  }

  private parsedOrEmpty(text: string): WorkspaceFileData {
    const parsed = parseWorkspaceFile(text);
    return parsed.ok
      ? parsed.data
      : { folders: [], settings: {}, launch: null, tasks: null, skipped: [] };
  }

  /** Drops a location from the recent list (an untitled workspace saved under a name). */
  private async forget(location: string | null): Promise<void> {
    if (location) await this.removeRecent(location);
  }

  /** Writes the folder list into the workspace file (the missing ones stay listed). */
  private async writeFolderList(list: readonly { path: string; name?: string }[]): Promise<void> {
    const file = this.file.peek();
    if (!file) return;
    // A name the workspace made up to tell two folders apart isn't written.
    const named = (f: { path: string; name?: string }) =>
      this.autoNamed.has(pathKey(f.path)) ? { path: f.path } : f;
    const missing = this.missing.peek().map((m) => ({ path: m.path, name: m.name }));
    // In the file's order: a missing folder stays where it was (the first one stays first when
    // its drive comes back); folders new to the list go at the end.
    const previous = resolveFolders(file, this.fileData.peek()?.folders ?? []);
    const wanted = [...list, ...missing];
    const ordered: { path: string; name?: string }[] = [];
    for (const p of previous) {
      const hit = wanted.find((w) => samePath(w.path, p.path));
      if (hit && !ordered.some((o) => samePath(o.path, hit.path))) ordered.push(hit);
    }
    for (const w of wanted) if (!ordered.some((o) => samePath(o.path, w.path))) ordered.push(w);
    // The first folder must stay first unless the list says otherwise (a removal of the first).
    const head = list[0];
    const sorted = head ? [head, ...ordered.filter((o) => !samePath(o.path, head.path))] : ordered;
    const text = await this.fileText(file);
    const next = withFolders(text, file, sorted.map(named));
    await fsIpc.workspaceFileWrite(file, next);
    this.fileData.value = this.parsedOrEmpty(next);
  }

  /**
   * Makes the workspace's folders `list` (the first is the primary): written to the file (when
   * `write`), then applied live, or by reopening when the first folder changes.
   */
  private async applyFolderList(
    list: readonly { path: string; name?: string }[],
    write = true,
  ): Promise<void> {
    const file = this.file.peek();
    const root = this.root.peek();
    if (!file || !root || !list.length) return;
    const previousText = write ? await this.fileText(file) : null;
    if (write) await this.writeFolderList(list);
    // The first folder that's there (a missing one listed first doesn't make the next one change).
    const knownMissing = (p: string) => this.missing.peek().some((m) => samePath(m.path, p));
    const first = list.find((f) => !knownMissing(f.path)) ?? list[0];
    if (first && !samePath(first.path, root)) {
      // The primary changes: everything keyed to it starts over, as when the workspace opens.
      const before = this.folders.peek();
      this.pendingReopen = true;
      let reopened: string | null = null;
      try {
        reopened = await this.openFileSteps(file);
      } finally {
        this.pendingReopen = false;
        this.opening.value = null;
      }
      if (reopened === null) {
        // Cancelled (an unsaved file the user kept): the file says what the window has again.
        if (previousText !== null) {
          await fsIpc.workspaceFileWrite(file, previousText).catch(() => {});
          this.fileData.value = this.parsedOrEmpty(previousText);
        }
        return;
      }
      // The folders that left: their tabs (restored with the window's state) close now.
      const removed = before.filter(
        (b) => !this.folders.peek().some((f) => samePath(f.path, b.path)),
      );
      if (removed.length) this.foldersChanged.fire({ added: [], removed });
      return;
    }
    const before = this.folders.peek();
    const others = list.filter((f) => !samePath(f.path, root));
    let statuses = await fsIpc.workspaceFoldersSet(others.map((f) => f.path));
    // Another workspace opened meanwhile: this change belonged to the old one.
    if (this.file.peek() !== file || this.root.peek() !== root) return;
    // New folders that opened under another name: asked about as the folder they are.
    const isNew = (p: string) => !this.folders.peek().some((f) => samePath(f.path, p));
    const refused = await this.guardCanonical(
      others.flatMap((f, i) => {
        const c = statuses[i]?.canonical;
        return c && isNew(c) ? [{ requested: f.path, canonical: c }] : [];
      }),
    );
    if (refused.size) {
      for (const k of refused) this.declined.add(k);
      const kept = others.filter((f) => !refused.has(pathKey(f.path)));
      statuses = await fsIpc.workspaceFoldersSet(kept.map((f) => f.path));
      others.splice(0, others.length, ...kept);
    }
    const firstEntry = list.find((f) => samePath(f.path, root));
    const raw: WorkspaceFolder[] = [
      { path: root, name: firstEntry?.name ?? basename(root), index: 0 },
    ];
    const missing: MissingFolder[] = [];
    for (const [i, f] of others.entries()) {
      const s = statuses[i];
      const name = f.name ?? basename(f.path);
      if (s?.canonical) {
        if (!raw.some((x) => samePath(x.path, s.canonical as string)))
          raw.push({
            path: s.canonical,
            name: f.name ?? basename(s.canonical),
            index: raw.length,
          });
      } else missing.push({ path: f.path, name, error: s?.error ?? "not found" });
    }
    // A list built from the open folders (an add, a removal) doesn't name the missing ones: they
    // stay missing, and listed.
    if (write)
      for (const m of this.missing.peek())
        if (
          !list.some((f) => samePath(f.path, m.path)) &&
          !missing.some((x) => samePath(x.path, m.path))
        )
          missing.push(m);
    const folders = this.withUniqueNames(raw);
    const added = folders.filter((f) => !before.some((b) => samePath(b.path, f.path)));
    const removed = before.filter((b) => !folders.some((f) => samePath(f.path, b.path)));
    // Each folder its own .vscode and IDE folder, before anything reads them (D251).
    await Promise.all(added.map((f) => prepareOtherFolder(f.path)));
    for (const f of removed) forgetWorkspaceFolderOf(f.path);
    batch(() => {
      this.missing.value = missing;
      this.folders.value = folders;
    });
    this.syncContext();
    const renamed = folders.some(
      (f) => before.find((b) => samePath(b.path, f.path))?.name !== f.name,
    );
    if (added.length || removed.length || renamed) this.foldersChanged.fire({ added, removed });
  }

  /** Set while a folder change reopens the workspace (nothing asks the user then). */
  private pendingReopen = false;

  /** Whether the workspace is being reopened for a change of its first folder. */
  isReopening(): boolean {
    return this.pendingReopen;
  }

  /**
   * Closes the folder (unsaved editors are confirmed first). False if cancelled. It waits for an
   * open or a folder change in progress (one queue, D293): closing in the middle of one let the
   * open go on with no folder and the folder's scope already closed.
   */
  close(): Promise<boolean> {
    const next = Promise.all([
      this.openQueue.catch(() => {}),
      this.changeQueue.catch(() => {}),
    ]).then(() => this.closeNow());
    this.openQueue = next;
    return next;
  }

  private async closeNow(): Promise<boolean> {
    if (this.root.peek() === null) return true;
    if (!(await this.confirmClose())) return false;
    await this.persistence.flush();
    this.persistence.closeWorkspace();
    this.closed.fire();
    this.markClosed();
    void resolveWorkspaceFolder(null);
    await fsIpc.closeWorkspace().catch(() => {});
    await this.persistence.saveGlobal({ lastFolder: undefined });
    return true;
  }

  /** Forgets a folder from the recent list (the welcome page's ×). */
  async removeRecent(path: string): Promise<void> {
    await this.persistence.saveGlobal((current) => {
      this.adoptLists(current);
      this.recent.value = this.recent.peek().filter((p) => !samePath(p, path));
      this.pinned.value = this.pinned.peek().filter((p) => !samePath(p, path));
      return {
        recentFolders: [...this.recent.peek()],
        pinnedFolders: [...this.pinned.peek()],
      };
    });
  }

  dispose(): void {
    this.opened.dispose();
    this.closed.dispose();
    this.foldersChanged.dispose();
    this.participants.clear();
  }
}

/** A folder besides the first, as it joins the workspace: its legacy folder renamed, its folders found. */
async function prepareOtherFolder(path: string): Promise<void> {
  await migrateWorkspaceFolder(path);
  await resolveWorkspaceFolderOf(path);
}

/** A folder the user said no to (it stays listed in the workspace file). */
const DECLINED = "Not added: you declined it. Add it with Add folder to workspace.";

async function everyAsync<T>(
  items: readonly T[],
  test: (item: T) => Promise<boolean>,
): Promise<boolean> {
  for (const item of items) if (!(await test(item))) return false;
  return true;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Earlier names of the folder's settings folder (D121: the product was renamed). */
const LEGACY_FOLDERS = [".ide"];
/** What only this app puts there: a legacy folder holding one of these is ours to rename. */
const OUR_ENTRIES = new Set([
  "settings.json",
  "keybindings.json",
  "tasks.json",
  "memory",
  "extensions",
  "commands",
  "snippets",
  "screenshots",
]);

/**
 * A folder last opened with the old name keeps its settings, memory, extensions… : the legacy
 * folder is renamed to the current one (when that doesn't exist yet). Nothing else is touched.
 */
async function migrateWorkspaceFolder(root: string): Promise<void> {
  const current = joinPath(root, product.workspaceFolderName);
  for (const legacy of LEGACY_FOLDERS) {
    if (legacy === product.workspaceFolderName) continue;
    try {
      const entries = await fsIpc.listDir(joinPath(root, legacy));
      if (!entries.some((e) => OUR_ENTRIES.has(e.name))) continue;
      const exists = await fsIpc
        .stat(current)
        .then(() => true)
        .catch(() => false);
      if (exists) continue;
      await fsIpc.rename(joinPath(root, legacy), product.workspaceFolderName);
    } catch {
      // No legacy folder (the usual case), or it can't be renamed: leave it.
    }
  }
}
