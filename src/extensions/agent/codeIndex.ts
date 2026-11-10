// The codebase index (D227, core/agent/codeIndex.ts): with agent.codebaseIndex.enabled and an
// embedding model (agent.codebaseIndex.model, e.g. ollama/nomic-embed-text), the open folder's
// source files are embedded in batches and kept in the app's data folder, one index per folder;
// saved files are embedded again after a pause. The agent's `codebase_search` tool and the
// `agent.codebaseSearch` command find code by meaning. Off by default (it sends the code to the
// embedding model's provider): AGENTS.md rule 8.
// D251: a multi-root workspace has one index, stored under its workspace file, its files named as
// the workspace names them ("api/src/x.ts"); a single folder's index is stored as before (by the
// folder), so nothing is embedded again.
import {
  chunkText,
  dequantize,
  embedText,
  indexable,
  MAX_FILE_BYTES,
  planUpdate,
  quantize,
  type SearchHit,
  type StoredIndex,
  searchIndex,
  textHash,
} from "../../core/agent/codeIndex";
import { aiIpc, docsIndexIpc, type ProviderRef } from "../../core/ipc/agent";
import { fsIpc, indexIpc } from "../../core/ipc/fs";
import type { DisposableStore } from "../../core/lifecycle/index";
import { joinPath, pathKey, relativePath, samePath } from "../../core/paths/index";
import { signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { agentIgnoredRel, agentIgnoreReady } from "./ignore";
import type { ProviderRegistry } from "./providers";
import type { AgentTool } from "./tools";

const MAX_FILES = 4000;
const MAX_CHUNKS = 20_000;
const BATCH = 64;
const UPDATE_DELAY_MS = 15_000;
/**
 * The saved index's size, below what app data takes for one index (docs.rs, 32 MB): at OpenAI's
 * 1536 dimensions a chunk is about 2 KB as JSON, so 20,000 chunks wouldn't fit. Past it, files
 * aren't added (said in the status).
 */
const MAX_SAVED_CHARS = 30 * 1024 * 1024;
/** Saved every so many batches: an error late in a long first run keeps what was done. */
const SAVE_EVERY_BATCHES = 40;

export interface CodeIndexStatus {
  state: "off" | "idle" | "indexing" | "ready" | "error";
  files: number;
  chunks: number;
  /** While indexing: files embedded so far / to embed. */
  done?: number;
  total?: number;
  error?: string;
  model?: string;
}

/** A stored index's name (a file in app data): one per folder. */
function storeName(root: string): string {
  let h = 0x811c9dc5;
  // The same folder under another case (C:\Proj, c:\proj) is one index on Windows only.
  const key = pathKey(root);
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `code-${(h >>> 0).toString(36)}`;
}

export class CodeIndex {
  readonly status = signal<CodeIndexStatus>({ state: "off", files: 0, chunks: 0 });
  private index: StoredIndex | null = null;
  private vectors = new Map<string, Float32Array>();
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly services: WorkbenchServices,
    private readonly providers: ProviderRegistry,
  ) {}

  enabled(): boolean {
    return this.services.settings.peek<boolean>("agent.codebaseIndex.enabled") === true;
  }

  private model(): { provider: ProviderRef; model: string; key: string } {
    const key = (this.services.settings.peek<string>("agent.codebaseIndex.model") ?? "").trim();
    const slash = key.indexOf("/");
    if (slash <= 0)
      throw new Error(
        "Set agent.codebaseIndex.model to an embedding model as provider/model (ollama/nomic-embed-text, openai/text-embedding-3-small…).",
      );
    const id = key.slice(0, slash);
    const status = this.providers.statuses.peek().find((p) => p.id === id);
    if (!status) throw new Error(`No provider ${id} (agent.codebaseIndex.model).`);
    return {
      provider: { id: status.id, kind: status.kind, baseUrl: status.baseUrl },
      model: key.slice(slash + 1),
      key,
    };
  }

  /**
   * What the index is stored under: the folder, or a multi-root workspace's file (D251). Null with
   * nothing open.
   */
  private storeKey(): string | null {
    const { workspace } = this.services;
    const root = workspace.root.peek();
    if (!root) return null;
    return workspace.folders.peek().length > 1 ? (workspace.file.peek() ?? root) : root;
  }

  /** Several folders: paths carry the folder's name ("api/src/x.ts"). */
  private multi(): boolean {
    return this.services.workspace.folders.peek().length > 1;
  }

  /** A stored path's file on disk. */
  private absOf(root: string, rel: string): string {
    return this.multi() ? this.services.workspace.resolve(rel) : joinPath(root, rel);
  }

  /** The stored index for the open folder (read once per folder). */
  private async load(root: string, model: string): Promise<StoredIndex | null> {
    if (this.index && samePath(this.index.root, root) && this.index.model === model)
      return this.index;
    this.index = null;
    this.vectors.clear();
    const text = await docsIndexIpc.load(storeName(root)).catch(() => null);
    if (!text) return null;
    try {
      const stored = JSON.parse(text) as StoredIndex;
      // Another model's vectors can't be compared with this one's: start over.
      if (stored.version !== 1 || !samePath(stored.root, root) || stored.model !== model)
        return null;
      stored.root = root;
      this.index = stored;
      return stored;
    } catch {
      return null;
    }
  }

  /** Files changed since the last run (saves, creations, deletions); null: look at all of them. */
  private changed: Set<string> | null = null;
  /** A change that needs the whole folder looked at (a folder moved or deleted). */
  private wholeFolder = false;

  /** Brings the index up to date (one run at a time; a request meanwhile runs once more). */
  update(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const changed = this.wholeFolder ? null : this.changed;
    this.changed = null;
    this.wholeFolder = false;
    this.running = this.run(changed)
      .catch((err: unknown) => {
        // What's in memory may be half done: the saved index is read again next time.
        this.index = null;
        this.vectors.clear();
        this.status.value = {
          ...this.status.peek(),
          state: "error",
          error: err instanceof Error ? err.message : String(err),
        };
      })
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          void this.update();
        }
      });
    return this.running;
  }

  /**
   * After a file changes: an update of the changed files once things are quiet. Null: something
   * that isn't one file (a folder renamed or deleted), so the whole folder is looked at.
   */
  scheduleUpdate(rel: string | null): void {
    if (!this.enabled()) return;
    // With an index in memory only the changed files are read again; else the whole folder.
    if (rel === null) this.wholeFolder = true;
    else if (this.index && !this.wholeFolder) {
      if (!this.changed) this.changed = new Set();
      this.changed.add(rel);
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(), UPDATE_DELAY_MS);
  }

  /** Another folder: the last one's changed files say nothing about this one. */
  folderChanged(): void {
    this.changed = null;
    this.wholeFolder = false;
    clearTimeout(this.timer);
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  private wanted(rel: string): boolean {
    return indexable(rel) && !agentIgnoredRel(this.services, rel);
  }

  private async run(changed: Set<string> | null): Promise<void> {
    const root = this.storeKey();
    const primary = this.services.workspace.root.peek();
    if (!this.enabled() || !root || !primary) {
      this.status.value = { state: "off", files: 0, chunks: 0 };
      return;
    }
    const { provider, model, key } = this.model();
    // The folder's .aiignore first: an excluded file mustn't go to the provider meanwhile.
    await agentIgnoreReady(this.services);
    const loaded = await this.load(root, key);
    // A copy: a file's entry changes only once all its chunks are embedded, so a failed run
    // leaves nothing marked done that isn't.
    const stored: StoredIndex = loaded
      ? { ...loaded, files: { ...loaded.files } }
      : { version: 1, model: key, root, files: {} };
    // A save changed a few files: only those are read again. Otherwise the whole folder.
    const partial = loaded && changed ? [...changed] : null;
    let listing: string[] = [];
    if (!partial) {
      const listed = await indexIpc.query("", 50_000);
      // Still listing the folder: a partial list would drop every file not in it yet.
      if (listed.indexing) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.update(), 5000);
        return;
      }
      // Every folder's files (the index names the folder of those outside the first, D251).
      listing = this.multi()
        ? listed.items.map((i) =>
            this.services.workspace.relative(joinPath(i.root ?? primary, i.path)),
          )
        : listed.items.map((i) => i.path);
    }
    const paths = partial
      ? partial.filter((rel) => this.wanted(rel))
      : listing
          .filter((rel) => this.wanted(rel))
          .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
          .slice(0, MAX_FILES);
    const texts = new Map<string, string>();
    const hashes = new Map<string, string>();
    for (const rel of paths) {
      try {
        // The size first: a huge file (a SQL dump) isn't read at all.
        const stat = await fsIpc.stat(this.absOf(primary, rel));
        if (stat.kind !== "file" || stat.size > MAX_FILE_BYTES) continue;
        const bytes = await fsIpc.read(this.absOf(primary, rel));
        if (bytes.length > MAX_FILE_BYTES || bytes.subarray(0, 4096).includes(0)) continue;
        const text = new TextDecoder().decode(bytes);
        texts.set(rel, text);
        hashes.set(rel, textHash(text));
      } catch {
        // Gone or unreadable meanwhile.
      }
    }
    // The changed files only: each is embedded again if its text changed, dropped if it's gone
    // (or no longer wanted). Otherwise the folder against the stored index.
    const plan = partial
      ? {
          embed: [...hashes].filter(([p, h]) => stored.files[p]?.hash !== h).map(([p]) => p),
          drop: partial.filter((p) => !hashes.has(p) && stored.files[p]),
        }
      : planUpdate(stored, hashes);
    for (const p of plan.drop) delete stored.files[p];
    let chunkCount = Object.values(stored.files).reduce((n, f) => n + f.chunks.length, 0);
    // About what the saved JSON takes: each chunk's vector text and its few fields.
    const chunkChars = (f: StoredIndex["files"][string]) =>
      f.chunks.reduce((n, c) => n + c.v.length + 40, 0);
    let savedChars = Object.values(stored.files).reduce((n, f) => n + chunkChars(f), 0);
    // Set from the embedding loop (a closure: an object, so the check below isn't narrowed away).
    const limit = { full: false };
    let batches = 0;
    this.status.value = {
      state: "indexing",
      files: Object.keys(stored.files).length,
      chunks: chunkCount,
      done: 0,
      total: plan.embed.length,
      model: key,
    };
    // Chunks go in batches across files; a file is put in the index when its last chunk is in.
    const building = new Map<
      string,
      { hash: string; need: number; chunks: StoredIndex["files"][string]["chunks"] }
    >();
    let pending: { rel: string; start: number; end: number; text: string }[] = [];
    const flush = async () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      const vectors = await aiIpc.embed(
        provider,
        model,
        batch.map((c) => c.text),
      );
      batch.forEach((c, i) => {
        const v = vectors[i];
        const file = building.get(c.rel);
        if (!v || !file) return;
        file.chunks.push({ start: c.start, end: c.end, v: quantize(v) });
        if (file.chunks.length === file.need) {
          const before = stored.files[c.rel];
          const entry = { hash: file.hash, chunks: file.chunks };
          stored.files[c.rel] = entry;
          savedChars += chunkChars(entry) - (before ? chunkChars(before) : 0);
          building.delete(c.rel);
        }
      });
      if (++batches % SAVE_EVERY_BATCHES === 0 && this.current(root))
        await docsIndexIpc.save(storeName(root), JSON.stringify(stored));
    };
    const save = () => docsIndexIpc.save(storeName(root), JSON.stringify(stored));
    try {
      await this.embedFiles(plan.embed, stored, root, {
        texts,
        hashes,
        building,
        pending: (c) => pending.push(c),
        pendingCount: () => pending.length,
        flush,
        chunkCount: () => chunkCount,
        addChunks: (n) => {
          chunkCount += n;
        },
        full: () => savedChars > MAX_SAVED_CHARS,
        onFull: () => {
          limit.full = true;
        },
        progress: (done) => {
          this.status.value = { ...this.status.peek(), done, chunks: chunkCount };
        },
      });
      await flush();
    } catch (err) {
      // What's complete is kept: the next run goes on from there instead of starting over.
      if (this.current(root)) await save().catch(() => {});
      throw err;
    }
    // Turned off or another folder meanwhile: nothing is saved or shown as ready.
    if (!this.current(root)) return;
    this.index = stored;
    this.vectors.clear();
    if (plan.embed.length || plan.drop.length) await save();
    this.status.value = {
      state: "ready",
      files: Object.keys(stored.files).length,
      chunks: Object.values(stored.files).reduce((n, f) => n + f.chunks.length, 0),
      model: key,
      ...(limit.full && { error: "The index is full: the rest of the folder isn't in it." }),
    };
  }

  /** Still the folder (and the index still on) that a run started for. */
  private current(root: string): boolean {
    return this.storeKey() === root && this.enabled();
  }

  /** Chunks the files and queues their chunks for embedding, a batch at a time. */
  private async embedFiles(
    files: readonly string[],
    stored: StoredIndex,
    root: string,
    io: {
      texts: Map<string, string>;
      hashes: Map<string, string>;
      building: Map<
        string,
        { hash: string; need: number; chunks: StoredIndex["files"][string]["chunks"] }
      >;
      pending: (c: { rel: string; start: number; end: number; text: string }) => void;
      pendingCount: () => number;
      flush: () => Promise<void>;
      chunkCount: () => number;
      addChunks: (n: number) => void;
      full: () => boolean;
      onFull: () => void;
      progress: (done: number) => void;
    },
  ): Promise<void> {
    let doneFiles = 0;
    for (const rel of files) {
      if (!this.current(root)) return;
      if (io.full()) {
        io.onFull();
        return;
      }
      const chunks = chunkText(io.texts.get(rel) ?? "");
      const old = stored.files[rel]?.chunks.length ?? 0;
      if (io.chunkCount() - old + chunks.length > MAX_CHUNKS) continue;
      io.addChunks(chunks.length - old);
      if (!chunks.length) {
        stored.files[rel] = { hash: io.hashes.get(rel) ?? "", chunks: [] };
        continue;
      }
      io.building.set(rel, { hash: io.hashes.get(rel) ?? "", need: chunks.length, chunks: [] });
      for (const c of chunks) {
        io.pending({ rel, start: c.start, end: c.end, text: embedText(rel, c) });
        if (io.pendingCount() >= BATCH) await io.flush();
      }
      doneFiles++;
      if (doneFiles % 20 === 0) io.progress(doneFiles);
    }
  }

  /** The chunks closest to `query`, with their text. */
  async search(query: string, limit = 10): Promise<(SearchHit & { text: string })[]> {
    if (!this.enabled())
      throw new Error(
        "The codebase index is off (agent.codebaseIndex.enabled). Use search or find_files instead.",
      );
    const root = this.storeKey();
    const primary = this.services.workspace.root.peek();
    if (!root || !primary) throw new Error("Open a folder first.");
    const { provider, model, key } = this.model();
    const index = await this.load(root, key);
    // Not built yet: started (or still going), and said at once rather than waited for.
    if (!index || !Object.keys(index.files).length) {
      if (!this.running) void this.update();
      throw new Error(
        "The codebase index is being built (ide://agent/codebaseIndex shows how far): use search or find_files meanwhile.",
      );
    }
    if (!this.vectors.size)
      for (const f of Object.values(index.files))
        for (const c of f.chunks) this.vectors.set(c.v, dequantize(c.v));
    const [q] = await aiIpc.embed(provider, model, [query]);
    if (!q) throw new Error("The embedding model gave no vector for the question.");
    // Files the user excluded since they were indexed stay out.
    const hits = searchIndex(index, this.vectors, dequantize(quantize(q)), limit * 2)
      .filter((h) => this.wanted(h.path))
      .slice(0, limit);
    const out: (SearchHit & { text: string })[] = [];
    for (const h of hits) {
      const text = await fsIpc
        .read(this.absOf(primary, h.path))
        .then((b) =>
          new TextDecoder()
            .decode(b)
            .replace(/\r\n?/g, "\n")
            .split("\n")
            .slice(h.start - 1, h.end)
            .join("\n"),
        )
        .catch(() => "");
      out.push({ ...h, text });
    }
    return out;
  }
}

const format = (hits: (SearchHit & { text: string })[]): string =>
  hits.length
    ? hits
        .map(
          (h) =>
            `${h.path}:${h.start}-${h.end} (score ${h.score.toFixed(2)})\n${h.text.slice(0, 1500)}`,
        )
        .join("\n\n---\n\n")
    : "Nothing close found.";

export function codebaseSearchTool(index: CodeIndex): AgentTool {
  return {
    spec: {
      name: "codebase_search",
      description:
        'Find code by meaning in the open folder (an embeddings index): "where are uploads retried", "the code that parses the config". Returns the closest chunks with path:lines and their text. For an exact name or string, search is faster and complete.',
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What the code does, in words" },
          limit: { type: "integer", description: "How many chunks (default 8, at most 20)" },
        },
        required: ["query"],
      },
    },
    readOnly: true,
    verb: "Searched the codebase",
    target: (a) => String(a.query ?? ""),
    async run(args) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return { result: '"query" is required (a string).', isError: true };
      const limit = Math.min(20, Math.max(1, Math.floor(Number(args.limit) || 8)));
      try {
        const hits = await index.search(query, limit);
        return {
          result: format(hits),
          summary: `${hits.length} chunk${hits.length === 1 ? "" : "s"}`,
          detail: hits.map((h) => `${h.path}:${h.start}-${h.end}`).join("\n"),
        };
      } catch (err) {
        return {
          result: `Error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
          summary: "index unavailable",
        };
      }
    },
  };
}

export function registerCodeIndex(
  sub: DisposableStore,
  services: WorkbenchServices,
  providers: ProviderRegistry,
): CodeIndex {
  const { dispatcher, settings, workspace, state } = services;
  const index = new CodeIndex(services, providers);
  sub.add({ dispose: () => index.dispose() });
  const start = () => {
    // Its commands show only when it's on (D172).
    services.context.set("aiCodebaseIndex", index.enabled());
    if (index.enabled() && workspace.root.peek()) void index.update();
    else index.status.value = { state: "off", files: 0, chunks: 0 };
  };
  sub.add(
    workspace.onDidOpen(() => {
      index.folderChanged();
      start();
    }),
  );
  // Folders added or removed (D251): the index is another workspace's, or its files change.
  sub.add(
    workspace.onDidChangeFolders(() => {
      index.folderChanged();
      start();
    }),
  );
  sub.add(
    settings.model.onDidChange((keys) => {
      if (keys.some((k) => k.startsWith("agent.codebaseIndex"))) start();
    }),
  );
  // After the providers are listed (the model's provider must be known).
  const first = setTimeout(start, 3000);
  sub.add({ dispose: () => clearTimeout(first) });
  // A file of any folder of the workspace (D251), as the index names it.
  const relOf = (path: string) => {
    const root = workspace.root.peek();
    if (!root || !workspace.contains(path)) return null;
    return workspace.folders.peek().length > 1
      ? workspace.relative(path)
      : relativePath(root, path);
  };
  const inFolder = (path: string) => {
    const rel = relOf(path);
    const owner = workspace.folderOf(path);
    return rel !== null && indexable(owner ? relativePath(owner.path, path) : rel);
  };
  const changedPath = (path: string) => {
    const rel = relOf(path);
    if (rel === null) return;
    // A folder (renamed, deleted): the files under it are found by a scan of the whole folder.
    if (inFolder(path)) index.scheduleUpdate(rel);
    else index.scheduleUpdate(null);
  };
  for (const event of [
    "files.didSave",
    "files.didCreate",
    "files.didDelete",
    "files.didChange",
  ] as const)
    sub.add(services.events.on(event, ({ path }) => changedPath(path)));
  sub.add(
    services.events.on("files.didRename", ({ from, to }) => {
      changedPath(from);
      changedPath(to);
    }),
  );

  sub.add(
    state.register("ide://agent/codebaseIndex", {
      description:
        "The codebase index (agent.codebaseIndex.enabled, D227): state (off, indexing, ready, error), files and chunks indexed, progress, the embedding model, the last error.",
      get: () => index.status.peek(),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.rebuildCodebaseIndex",
      title: "Update codebase index",
      category: "Agent",
      description:
        "Brings the codebase index up to date now (files changed since are embedded again). Needs agent.codebaseIndex.enabled and agent.codebaseIndex.model.",
      input: s.empty(),
      effects: ["network"],
      run: async () => {
        if (!index.enabled())
          throw new Error("Turn on the codebase index first (agent.codebaseIndex.enabled).");
        await index.update();
        return index.status.peek();
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.codebaseSearch",
      title: "Search the codebase by meaning…",
      category: "Agent",
      description:
        "Finds code by meaning with the codebase index (agent.codebaseIndex): the closest chunks, as path, lines, score and text.",
      input: s.object({
        query: s.string().describe("What the code does, in words"),
        limit: s.integer({ min: 1, max: 20 }).optional(),
      }),
      effects: ["read", "network"],
      agent: "discoverable",
      when: "aiCodebaseIndex",
      run: async ({ query, limit }) => {
        const hits = await index.search(query, limit ?? 8);
        return hits.map((h) => ({
          path: h.path,
          start: h.start,
          end: h.end,
          score: Math.round(h.score * 1000) / 1000,
          text: h.text,
        }));
      },
    }),
  );
  return index;
}
