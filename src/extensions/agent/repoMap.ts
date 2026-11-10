// The repository map the agent starts each chat with (D174; core/agent/repoMap.ts ranks and
// draws it). Files come from the workspace index (it honors .gitignore); each file's symbols are
// cached by size and modification time, so a rebuild reads only what changed. It's warmed a few
// seconds after a folder opens, refreshed after the IDE writes files (and at most every two
// minutes otherwise), and a chat that starts before it's ready waits a moment, then goes without.
// D251: a multi-root workspace's map covers every folder (the index lists them all), its paths
// as the workspace writes them ("api/src/x.ts"); adding or removing a folder rebuilds it.
import {
  type FileSymbols,
  fileSymbols,
  mapsLanguage,
  renderRepoMap,
  skippedPath,
} from "../../core/agent/repoMap";
import { fsIpc, indexIpc } from "../../core/ipc/fs";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { joinPath } from "../../core/paths/index";
import type { WorkbenchServices } from "../../workbench/services";

/** Files read at most (the most shallow first: a monorepo's top-level code over deep tests). */
const MAX_FILES = 2000;
/** Larger files are generated or data: left out. */
const MAX_FILE_BYTES = 300_000;
const STALE_MS = 120_000;
const WARM_DELAY_MS = 4000;
/** How long a chat's first request waits for a map still being built. */
const WAIT_MS = 2500;
const PARALLEL = 12;

export class RepoMapService implements Disposable {
  private readonly store = new DisposableStore();
  private readonly cache = new Map<string, { size: number; mtime: number; symbols: FileSymbols }>();
  private files: FileSymbols[] | null = null;
  private builtFor: string | null = null;
  private builtAt = 0;
  private dirty = true;
  private building: Promise<void> | null = null;
  private buildingFor: string | null = null;
  private warmTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly services: WorkbenchServices) {
    const { workspace, events } = services;
    const reset = () => {
      this.files = null;
      this.builtFor = null;
      this.cache.clear();
      this.dirty = true;
    };
    this.store.add(workspace.onDidClose(reset));
    // Another set of folders: the next map is built for it (the cache of unchanged files stays).
    this.store.add(
      workspace.onDidChangeFolders(() => {
        this.dirty = true;
        this.warm();
      }),
    );
    this.store.add(
      workspace.onDidOpen(() => {
        reset();
        this.warm();
      }),
    );
    for (const name of [
      "files.didSave",
      "files.didCreate",
      "files.didRename",
      "files.didDelete",
      "files.didChange",
    ] as const)
      this.store.add(events.on(name, () => (this.dirty = true)));
    this.store.add(toDisposable(() => clearTimeout(this.warmTimer)));
    if (workspace.root.peek()) this.warm();
  }

  /**
   * What a map is built for: the workspace's folders with their names (the map's paths start
   * with them, so a rename rebuilds it); the first folder alone with one.
   */
  private key(): string | null {
    const root = this.services.workspace.root.peek();
    if (!root) return null;
    const folders = this.services.workspace.folders.peek();
    return folders.length > 1 ? folders.map((f) => `${f.path}\u0001${f.name}`).join("\0") : root;
  }

  private enabled(): boolean {
    return this.services.settings.peek<boolean>("agent.repoMap.enabled") !== false;
  }

  /** Builds it in the background once the folder has settled (the index fills first). */
  private warm(): void {
    clearTimeout(this.warmTimer);
    this.warmTimer = setTimeout(() => {
      if (this.enabled()) void this.refresh();
    }, WARM_DELAY_MS);
  }

  /**
   * The map's text for a new chat, ranked toward `focus` (open files, relative paths), within
   * `budget` characters; "" with no folder, no code, or the map turned off.
   */
  async text(focus: readonly string[], budget: number): Promise<string> {
    const root = this.key();
    if (!root || !this.enabled() || budget <= 0) return "";
    const stale = this.dirty || Date.now() - this.builtAt > STALE_MS || this.builtFor !== root;
    if (stale) {
      const pending = this.refresh();
      // A map from before (a few files behind) is still worth sending; none yet: wait a little.
      if (!this.files || this.builtFor !== root)
        await Promise.race([pending, new Promise((r) => setTimeout(r, WAIT_MS))]);
    }
    if (!this.files || this.builtFor !== root) return "";
    return renderRepoMap(this.files, { budget, focus });
  }

  /**
   * Rebuilds (one at a time); files that didn't change come from the cache. A build still
   * running for a folder that was closed is waited out, then this folder's starts.
   */
  refresh(): Promise<void> {
    const root = this.key();
    if (this.building && this.buildingFor !== root) return this.building.then(() => this.refresh());
    if (!this.building) {
      this.buildingFor = root;
      this.building = this.build().finally(() => {
        this.building = null;
        this.buildingFor = null;
      });
    }
    return this.building;
  }

  private async build(): Promise<void> {
    const root = this.key();
    const primary = this.services.workspace.root.peek();
    if (!root || !primary) return;
    this.dirty = false;
    const listed = await indexIpc.query("", 50_000).catch(() => null);
    if (!listed || this.key() !== root) return;
    // Still listing the folder (it just opened): nothing to keep yet; try again shortly rather
    // than store an empty map as if it were the project's.
    if (listed.indexing && !listed.items.length) {
      this.dirty = true;
      this.warm();
      return;
    }
    // Each file by its workspace path ("src/x.ts"; "api/src/x.ts" with several folders) and where
    // it is on disk (the index gives the folder of those outside the first).
    const several = this.services.workspace.folders.peek().length > 1;
    const where = new Map<string, string>();
    for (const i of listed.items) {
      if (!mapsLanguage(i.path) || skippedPath(i.path) || /\.(test|spec)\.[^.]+$/.test(i.path))
        continue;
      const abs = joinPath(i.root ?? primary, i.path);
      where.set(several ? this.services.workspace.relative(abs) : i.path, abs);
    }
    const paths = [...where.keys()]
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
      .slice(0, MAX_FILES);
    const out: FileSymbols[] = [];
    const seen = new Set<string>();
    let next = 0;
    const worker = async () => {
      while (next < paths.length) {
        const rel = paths[next++] as string;
        seen.add(rel);
        const symbols = await this.fileFor(where.get(rel) ?? joinPath(primary, rel), rel);
        if (symbols) out.push(symbols);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    // The folder changed while this ran: don't keep a map of the old one.
    if (this.key() !== root) return;
    for (const key of [...this.cache.keys()]) if (!seen.has(key)) this.cache.delete(key);
    this.files = out;
    this.builtFor = root;
    this.builtAt = Date.now();
    // The index was still filling: good for now, built again next time.
    if (listed.indexing) {
      this.dirty = true;
      this.warm();
    }
  }

  private async fileFor(abs: string, rel: string): Promise<FileSymbols | null> {
    try {
      const stat = await fsIpc.stat(abs);
      if (stat.kind !== "file" || stat.size > MAX_FILE_BYTES) return null;
      const cached = this.cache.get(rel);
      if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs)
        return cached.symbols;
      const bytes = await fsIpc.read(abs);
      // Binary (a NUL in the first 8 KB) isn't code.
      if (bytes.subarray(0, 8192).includes(0)) return null;
      const symbols = fileSymbols(rel, new TextDecoder().decode(bytes));
      this.cache.set(rel, { size: stat.size, mtime: stat.mtimeMs, symbols });
      return symbols;
    } catch {
      return null;
    }
  }

  /**
   * Definitions whose name contains `query` (case-insensitive), exact and prefix matches first:
   * the @-mention's symbol search (D200). Builds the map first when there's none yet.
   */
  async symbols(
    query: string,
    limit = 30,
  ): Promise<{ path: string; name: string; line: number; signature: string }[]> {
    const root = this.key();
    const q = query.trim().toLowerCase();
    if (!root || !q) return [];
    if (!this.files || this.builtFor !== root || this.dirty)
      await Promise.race([this.refresh(), new Promise((r) => setTimeout(r, WAIT_MS))]);
    const hits: { path: string; name: string; line: number; signature: string; rank: number }[] =
      [];
    for (const f of this.files ?? [])
      for (const d of f.defs) {
        const name = d.name.toLowerCase();
        const at = name.indexOf(q);
        if (at < 0) continue;
        const rank = (name === q ? 0 : at === 0 ? 1 : 2) + (d.member ? 0.5 : 0);
        hits.push({ path: f.path, name: d.name, line: d.line, signature: d.signature, rank });
      }
    return hits
      .sort(
        (a, b) => a.rank - b.rank || a.name.length - b.name.length || a.path.localeCompare(b.path),
      )
      .slice(0, limit)
      .map(({ rank: _rank, ...h }) => h);
  }

  /** For ide://agent/repoMap: what it holds. */
  info(): { files: number; builtAt: number | null; building: boolean } {
    return {
      files: this.files?.length ?? 0,
      builtAt: this.builtAt || null,
      building: this.building !== null,
    };
  }

  dispose(): void {
    this.store.dispose();
  }
}

const services_ = new WeakMap<WorkbenchServices, RepoMapService>();

/** The agent extension's map (registered on activation); undefined before. */
export function repoMapFor(services: WorkbenchServices): RepoMapService | undefined {
  return services_.get(services);
}

export function registerRepoMap(services: WorkbenchServices): RepoMapService {
  const map = new RepoMapService(services);
  services_.set(services, map);
  return map;
}
