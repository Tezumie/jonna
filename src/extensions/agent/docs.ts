// @docs (D204, Cursor's @Docs): documentation sites crawled into a local index for the agent.
// A source is a name and a URL in `agent.docs.sources`; "Add" or "Refresh" crawls the site
// within its prefix (core/agent/docsIndex.ts: bounded pages, robots.txt, a pause between
// requests) through the agent's web fetch path (Rust `web_fetch`), splits the pages into
// chunks and keeps a lexical index in app data (`docs_index_*`). `@docs:<name>` in a message
// attaches the chunks that best match the message (or the words after the mention); the agent
// can search too (`agent.searchDocs`). The Docs page is docsPage.ts.
// D207: sitemap.xml seeds the crawl; pages that need JavaScript are counted and listed (they
// can't be read: the IDE has no headless browser); `agent.docs.refreshDays` (default 7) reads
// a source again when its index is older, checked a minute after start and every six hours
// (agent.refreshStaleDocs runs the check now). No model is involved unless the next applies.
// D233: with agent.docs.embeddings.enabled (off by default: it sends the passages to a model,
// AGENTS.md rule 8) a source's chunks are embedded when it's read (the model in
// agent.docs.embeddings.model, else the codebase index's) and a question is matched by words and
// meaning (hybridSearch); without vectors, with another model, or when the model can't be reached,
// by words. With agent.docs.renderJavaScript, pages that need JavaScript are rendered in a hidden
// window (Rust `docs_render`) instead of being skipped.
import { dequantize, quantize } from "../../core/agent/codeIndex";
import {
  buildIndex,
  chunkPage,
  crawl,
  type DocHit,
  type DocsIndex,
  hybridSearch,
  NEEDS_JAVASCRIPT,
  renderDocHits,
  searchIndex,
  staleDocs,
} from "../../core/agent/docsIndex";
import { htmlTitle, htmlToText, normalizeUrl } from "../../core/agent/webText";
import { SizedCache, stringBytes } from "../../core/cache/index";
import { aiIpc, docsIndexIpc, type ProviderRef } from "../../core/ipc/agent";
import type { DisposableStore } from "../../core/lifecycle/index";
import { signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { confirmAction } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import { registerMentionSource } from "./composerExtras";
import type { ProviderRegistry } from "./providers";

export interface DocsSource {
  name: string;
  url: string;
  maxPages?: number;
}

export interface DocsStatus {
  name: string;
  state: "new" | "crawling" | "ready" | "failed";
  pages: number;
  chunks: number;
  crawledAt?: number;
  error?: string;
  /** While crawling: pages read so far, and the last one. */
  progress?: { done: number; url: string };
  skipped?: number;
  /** Pages skipped because they show nothing without JavaScript (D207). */
  needsJavaScript?: number;
  /** The embedding model its chunks were embedded with (D233), when they were. */
  embeddedWith?: string;
  /** Why they weren't, when search by meaning is on (the model couldn't be reached…). */
  embedError?: string;
}

/** What's stored per source. */
interface StoredDocs {
  version: 1;
  url: string;
  crawledAt: number;
  pages: { url: string; title: string }[];
  skipped: { url: string; why: string }[];
  index: DocsIndex;
  /** D233: the chunks' unit vectors (codeIndex's `quantize`), in `index.chunks` order. */
  vectors?: { model: string; v: (string | null)[] };
}

/** Chunks per embedding request. */
const EMBED_BATCH = 64;

/**
 * Read indexes and their decoded vectors kept in memory, by size (D416): a 500-page source with
 * vectors is tens of megabytes, a small one a few hundred kilobytes. One evicted (or too big) is
 * read from app data again on its next search.
 */
const INDEX_CACHE_BYTES = 48 * 1024 * 1024;
const VECTOR_CACHE_BYTES = 64 * 1024 * 1024;

const DEFAULT_PAGES = 60;
const MAX_PAGES = 500;

export const validDocsName = (name: string) => /^[A-Za-z0-9_-]{1,64}$/.test(name);

/** A name from a URL: "https://nextjs.org/docs" → "nextjs". */
export function docsNameFor(url: string): string {
  try {
    const host = new URL(normalizeUrl(url)).hostname.replace(/^(www|docs)\./, "");
    return (host.split(".")[0] ?? "docs").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "docs";
  } catch {
    return "docs";
  }
}

const jsPages = (skipped: readonly { why: string }[]) =>
  skipped.filter((x) => x.why === NEEDS_JAVASCRIPT).length;

export class DocsService {
  readonly statuses = signal<readonly DocsStatus[]>([]);
  /** Read indexes by source, with their size as saved (the JSON's length). */
  private readonly cache = new SizedCache<string, { stored: StoredDocs; bytes: number }>({
    maxBytes: INDEX_CACHE_BYTES,
    maxEntryBytes: INDEX_CACHE_BYTES,
    sizeOf: (v) => v.bytes,
  });
  private readonly running = new Map<string, { cancelled: boolean }>();
  /** Decoded vectors per source. */
  private readonly decoded = new SizedCache<string, (Float32Array | null)[]>({
    maxBytes: VECTOR_CACHE_BYTES,
    maxEntryBytes: VECTOR_CACHE_BYTES,
    sizeOf: (v) => v.reduce((sum, x) => sum + (x?.byteLength ?? 0) + 16, 0),
  });

  constructor(
    private readonly services: WorkbenchServices,
    private readonly providers?: ProviderRegistry,
  ) {}

  /** The embedding model for @docs when search by meaning is on (D233), else null. */
  private embedModel(): { provider: ProviderRef; model: string; key: string } | null {
    const settings = this.services.settings;
    if (settings.peek<boolean>("agent.docs.embeddings.enabled") !== true || !this.providers)
      return null;
    const key = (
      settings.peek<string>("agent.docs.embeddings.model") ||
      settings.peek<string>("agent.codebaseIndex.model") ||
      ""
    ).trim();
    const slash = key.indexOf("/");
    if (slash <= 0)
      throw new Error(
        "Set agent.docs.embeddings.model to an embedding model as provider/model (ollama/nomic-embed-text…).",
      );
    const id = key.slice(0, slash);
    const status = this.providers.statuses.peek().find((p) => p.id === id);
    if (!status) throw new Error(`No provider ${id} (agent.docs.embeddings.model).`);
    return {
      provider: { id: status.id, kind: status.kind, baseUrl: status.baseUrl },
      model: key.slice(slash + 1),
      key,
    };
  }

  /** The chunks' vectors (D233), in batches; throws when the model can't be reached. */
  private async embedChunks(
    index: DocsIndex,
    model: { provider: ProviderRef; model: string; key: string },
    cancelled: () => boolean,
  ): Promise<{ model: string; v: (string | null)[] }> {
    const v: (string | null)[] = [];
    for (let i = 0; i < index.chunks.length; i += EMBED_BATCH) {
      if (cancelled()) throw new Error("Stopped.");
      const batch = index.chunks.slice(i, i + EMBED_BATCH);
      const vectors = await aiIpc.embed(
        model.provider,
        model.model,
        batch.map((c) =>
          `${c.title}${c.heading ? ` › ${c.heading}` : ""}\n${c.text}`.slice(0, 8000),
        ),
      );
      batch.forEach((_, j) => {
        const vector = vectors[j];
        v.push(vector?.length ? quantize(vector) : null);
      });
    }
    return { model: model.key, v };
  }

  sources(): DocsSource[] {
    const raw = this.services.settings.peek<unknown>("agent.docs.sources");
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((x) => {
      if (!x || typeof x !== "object") return [];
      const { name, url, maxPages } = x as Record<string, unknown>;
      if (typeof name !== "string" || typeof url !== "string" || !validDocsName(name)) return [];
      return [
        {
          name,
          url,
          ...(typeof maxPages === "number" && maxPages > 0 && { maxPages: Math.floor(maxPages) }),
        },
      ];
    });
  }

  private setStatus(next: DocsStatus): void {
    this.statuses.value = [...this.statuses.peek().filter((x) => x.name !== next.name), next];
  }

  status(name: string): DocsStatus {
    return (
      this.statuses.peek().find((x) => x.name === name) ?? {
        name,
        state: "new",
        pages: 0,
        chunks: 0,
      }
    );
  }

  /** The stored index (read once, then kept while there's room). */
  async load(name: string): Promise<StoredDocs | null> {
    const cached = this.cache.get(name);
    if (cached) return cached.stored;
    const text = await docsIndexIpc.load(name).catch(() => null);
    if (!text) return null;
    try {
      const stored = JSON.parse(text) as StoredDocs;
      if (stored.version !== 1 || !stored.index) return null;
      this.cache.set(name, { stored, bytes: stringBytes(text) });
      return stored;
    } catch {
      return null;
    }
  }

  /** Reads what's stored for every source (the page and the state show it). */
  async refreshStatuses(): Promise<void> {
    const names = new Set(this.sources().map((x) => x.name));
    for (const src of this.sources()) {
      if (this.running.has(src.name)) continue;
      const stored = await this.load(src.name);
      this.setStatus(
        stored
          ? {
              name: src.name,
              state: "ready",
              pages: stored.pages.length,
              chunks: stored.index.chunks.length,
              crawledAt: stored.crawledAt,
              skipped: stored.skipped.length,
              ...(jsPages(stored.skipped) && { needsJavaScript: jsPages(stored.skipped) }),
              ...(stored.vectors && { embeddedWith: stored.vectors.model }),
            }
          : {
              ...this.status(src.name),
              state: this.status(src.name).state === "failed" ? "failed" : "new",
            },
      );
    }
    this.statuses.value = this.statuses.peek().filter((x) => names.has(x.name));
  }

  /** Crawls a source and replaces its index. */
  async crawl(name: string): Promise<DocsStatus> {
    const src = this.sources().find((x) => x.name === name);
    if (!src) throw new Error(`No docs source ${name} (agent.docs.sources).`);
    if (this.running.has(name)) return this.status(name);
    const flag = { cancelled: false };
    this.running.set(name, flag);
    const settings = this.services.settings;
    const maxPages = Math.min(
      MAX_PAGES,
      src.maxPages ?? settings.peek<number>("agent.docs.maxPages") ?? DEFAULT_PAGES,
    );
    const delayMs = Math.max(0, settings.peek<number>("agent.docs.delayMs") ?? 500);
    this.setStatus({
      name,
      state: "crawling",
      pages: 0,
      chunks: 0,
      progress: { done: 0, url: src.url },
    });
    try {
      const start = normalizeUrl(src.url);
      const render = settings.peek<boolean>("agent.docs.renderJavaScript") === true;
      const result = await crawl(
        start,
        { maxPages, delayMs },
        {
          fetch: (url) => aiIpc.webFetch(url),
          toText: (html, url) => ({ title: htmlTitle(html), text: htmlToText(html, url) }),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          cancelled: () => flag.cancelled,
          ...(render && {
            render: async (url: string) => {
              const page = await docsIndexIpc.render(url);
              return page ? { title: page.title, text: page.text } : null;
            },
          }),
          progress: (done, url) =>
            this.setStatus({
              name,
              state: "crawling",
              pages: done,
              chunks: 0,
              progress: { done, url },
            }),
        },
      );
      if (flag.cancelled) throw new Error("Stopped.");
      if (!result.pages.length)
        throw new Error(
          result.skipped[0]
            ? `no pages could be read (${result.skipped[0].url}: ${result.skipped[0].why})`
            : "no pages could be read",
        );
      const chunks = result.pages.flatMap((p) => chunkPage(p));
      const stored: StoredDocs = {
        version: 1,
        url: start,
        crawledAt: Date.now(),
        pages: result.pages.map((p) => ({ url: p.url, title: p.title })),
        skipped: result.skipped.slice(0, 200),
        index: buildIndex(chunks),
      };
      // Search by meaning (D233): a failure leaves the source searchable by words.
      let embedError: string | undefined;
      try {
        const model = this.embedModel();
        if (model) {
          this.setStatus({
            name,
            state: "crawling",
            pages: stored.pages.length,
            chunks: 0,
            progress: { done: stored.pages.length, url: `embedding with ${model.key}` },
          });
          stored.vectors = await this.embedChunks(stored.index, model, () => flag.cancelled);
        }
      } catch (err) {
        if (flag.cancelled) throw err;
        embedError = err instanceof Error ? err.message : String(err);
      }
      const json = JSON.stringify(stored);
      await docsIndexIpc.save(name, json);
      this.cache.set(name, { stored, bytes: stringBytes(json) });
      this.decoded.delete(name);
      const done: DocsStatus = {
        name,
        state: "ready",
        pages: stored.pages.length,
        chunks: chunks.length,
        crawledAt: stored.crawledAt,
        skipped: result.skipped.length,
        ...(jsPages(result.skipped) && { needsJavaScript: jsPages(result.skipped) }),
        ...(stored.vectors && { embeddedWith: stored.vectors.model }),
        ...(embedError && { embedError }),
      };
      this.setStatus(done);
      return done;
    } catch (err) {
      const failed: DocsStatus = {
        ...this.status(name),
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
      delete failed.progress;
      // A refresh that failed keeps the index it had.
      const kept = await this.load(name);
      if (kept) {
        failed.pages = kept.pages.length;
        failed.chunks = kept.index.chunks.length;
        failed.crawledAt = kept.crawledAt;
      }
      this.setStatus(failed);
      return failed;
    } finally {
      this.running.delete(name);
    }
  }

  stop(name: string): boolean {
    const r = this.running.get(name);
    if (r) r.cancelled = true;
    return !!r;
  }

  async forget(name: string): Promise<void> {
    this.stop(name);
    this.cache.delete(name);
    this.decoded.delete(name);
    await docsIndexIpc.delete(name).catch(() => {});
    this.statuses.value = this.statuses.peek().filter((x) => x.name !== name);
  }

  async search(name: string, query: string, limit = 5): Promise<DocHit[]> {
    const stored = await this.load(name);
    if (!stored) throw new Error(`Docs ${name} aren't indexed yet: refresh them on the Docs page.`);
    // By meaning too (D233) when it's on and the source was embedded with the model set now;
    // anything failing falls back to words.
    try {
      const model = this.embedModel();
      const vectors = stored.vectors;
      if (model && vectors?.model === model.key && query.trim()) {
        let decoded = this.decoded.get(name);
        if (!decoded) {
          decoded = vectors.v.map((x) => (x ? dequantize(x) : null));
          this.decoded.set(name, decoded);
        }
        const [q] = await aiIpc.embed(model.provider, model.model, [query]);
        if (q?.length)
          return hybridSearch(stored.index, query, decoded, dequantize(quantize(q)), limit);
      }
    } catch {
      // Lexical below.
    }
    return searchIndex(stored.index, query, limit);
  }

  /** Pages of a source skipped because they need JavaScript (the first `max`). */
  async javaScriptPages(name: string, max = 20): Promise<string[]> {
    const stored = await this.load(name);
    return (stored?.skipped ?? [])
      .filter((x) => x.why === NEEDS_JAVASCRIPT)
      .slice(0, max)
      .map((x) => x.url);
  }

  /** Reads again, one at a time, the sources older than `agent.docs.refreshDays` (D207). */
  async refreshStale(now = Date.now()): Promise<string[]> {
    const days = this.services.settings.peek<number>("agent.docs.refreshDays") ?? 7;
    await this.refreshStatuses();
    const due = staleDocs(
      this.sources().map((x) => {
        const at = this.status(x.name).crawledAt;
        return { name: x.name, ...(at !== undefined && { crawledAt: at }) };
      }),
      days,
      now,
    ).filter((n) => !this.running.has(n));
    for (const name of due) await this.crawl(name);
    return due;
  }

  dispose(): void {
    for (const r of this.running.values()) r.cancelled = true;
  }
}

export function registerDocs(
  sub: DisposableStore,
  services: WorkbenchServices,
  providers?: ProviderRegistry,
): DocsService {
  const docs = new DocsService(services, providers);
  sub.add({ dispose: () => docs.dispose() });
  void docs.refreshStatuses();
  sub.add(
    services.settings.model.onDidChange((keys) => {
      if (keys.includes("agent.docs.sources")) void docs.refreshStatuses();
    }),
  );
  const { dispatcher, state, quickInput, notifications } = services;
  // The scheduled refresh (D207): a minute after start, then every six hours.
  const check = () => void docs.refreshStale().catch(() => {});
  const first = setTimeout(check, 60_000);
  const every = setInterval(check, 6 * 3_600_000);
  sub.add({
    dispose: () => {
      clearTimeout(first);
      clearInterval(every);
    },
  });
  const writeSources = (list: DocsSource[]) =>
    services.settings.update("agent.docs.sources", list, "user");

  // `@docs:<name>` (and `@docs:<name> words`): the best chunks for the words, or the message.
  sub.add(
    registerMentionSource({
      prefix: "@docs:",
      icon: "book-open",
      items: (query) => {
        const q = query
          .trim()
          .toLowerCase()
          .replace(/^@/, "")
          .replace(/^docs:?/, "");
        return docs
          .sources()
          .filter((x) => !q || `${x.name} ${x.url}`.toLowerCase().includes(q))
          .map((x) => ({
            id: `@docs:${x.name}`,
            label: `Docs: ${x.name}`,
            description: `${x.url} · ${docs.status(x.name).state === "ready" ? `${docs.status(x.name).pages} pages` : docs.status(x.name).state}`,
            icon: "book-open" as const,
          }));
      },
      label: (mention) => {
        const m = /^@docs:([\w-]+)(?:\s+(.+))?$/.exec(mention);
        return m ? `Docs: ${m[1]}${m[2] ? ` — ${m[2]}` : ""}` : mention;
      },
      context: async (mention, _session, message) => {
        const m = /^@docs:([\w-]+)(?:\s+([\s\S]+))?$/.exec(mention.trim());
        if (!m?.[1]) return `${mention}: not a docs mention (@docs:<name>).`;
        const name = m[1];
        const query = (m[2] ?? message ?? "").trim();
        try {
          const hits = await docs.search(name, query, 6);
          return renderDocHits(name, query, hits);
        } catch (err) {
          return `Docs ${name}: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  );

  sub.add(
    state.register("ide://agent/docs", {
      description:
        "Documentation sites indexed for @docs mentions (D204): each source's name, URL, state (new, crawling, ready, failed), pages and chunks indexed, when it was crawled, how many pages were skipped, the pages that need JavaScript (not read, D207; read when agent.docs.renderJavaScript is on, D233), and the embedding model its passages were embedded with for search by meaning (embeddedWith, or embedError; agent.docs.embeddings.enabled, D233).",
      get: async () =>
        Promise.all(
          docs.sources().map(async (x) => {
            const status = docs.status(x.name);
            return {
              ...x,
              ...status,
              name: x.name,
              ...(status.needsJavaScript && {
                javaScriptPages: await docs.javaScriptPages(x.name, 10),
              }),
            };
          }),
        ),
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.addDocs",
      title: "Add documentation for @docs…",
      category: "Agent",
      description:
        "Adds a documentation site for @docs mentions: `url` (its start page; pages under the same folder are read), `name` (default from the address), `maxPages` (default agent.docs.maxPages). It's crawled at once (robots.txt followed, a pause between pages) and indexed on this computer.",
      input: s.object({
        url: s.string().optional(),
        name: s.string().optional(),
        maxPages: s.integer({ min: 1, max: MAX_PAGES }).optional(),
        crawl: s.boolean().describe("Crawl now (default true)").optional(),
      }),
      effects: ["write", "network"],
      agent: "discoverable",
      run: async ({ url, name, maxPages, crawl: now }, ctx) => {
        let address = url?.trim();
        if (!address && ctx.caller.kind === "user")
          address = (
            await quickInput.prompt({ prompt: "Documentation address (its start page)" })
          )?.trim();
        if (!address) return { added: null };
        const start = normalizeUrl(address);
        const wanted = (name?.trim() || docsNameFor(start)).replace(/[^A-Za-z0-9_-]/g, "-");
        if (!validDocsName(wanted)) throw new Error("Use letters, digits, - and _ in the name.");
        const list = docs.sources().filter((x) => x.name !== wanted);
        await writeSources([...list, { name: wanted, url: start, ...(maxPages && { maxPages }) }]);
        if (now === false) return { added: wanted };
        const status = await docs.crawl(wanted);
        if (status.state === "failed")
          notifications.show("warning", `Docs ${wanted}: ${status.error ?? "failed"}`);
        return { added: wanted, ...status };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.refreshDocs",
      title: "Refresh @docs",
      category: "Agent",
      description:
        "Crawls a documentation source again (or every one without `name`) and replaces its index; `stop` true stops a crawl under way.",
      input: s.object({ name: s.string().optional(), stop: s.boolean().optional() }),
      effects: ["network"],
      agent: "hidden",
      run: async ({ name, stop }) => {
        if (stop && name) return { stopped: docs.stop(name) };
        const names = name ? [name] : docs.sources().map((x) => x.name);
        const out: DocsStatus[] = [];
        for (const n of names) out.push(await docs.crawl(n));
        return { sources: out };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.refreshStaleDocs",
      title: "Refresh old @docs",
      category: "Agent",
      description:
        "Reads again the documentation sources whose index is older than agent.docs.refreshDays (default 7; 0 never). The IDE does this by itself a minute after start and every six hours; this runs the check now. Returns the sources read.",
      input: s.empty(),
      effects: ["network"],
      agent: "hidden",
      palette: false,
      run: async () => ({ refreshed: await docs.refreshStale() }),
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.removeDocs",
      title: "Remove @docs source",
      category: "Agent",
      description:
        "Removes a documentation source and its index (asks first when a person runs it).",
      input: s.object({ name: s.string() }),
      effects: ["write"],
      agent: "hidden",
      palette: false,
      run: async ({ name }, ctx) => {
        if (
          ctx.caller.kind === "user" &&
          !(await confirmAction(
            `Remove docs ${name}?`,
            "Its index on this computer is deleted.",
            "Remove",
          ))
        )
          return { removed: false };
        await writeSources(docs.sources().filter((x) => x.name !== name));
        await docs.forget(name);
        return { removed: name };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.searchDocs",
      title: "Search indexed docs",
      category: "Agent",
      description:
        "Searches an indexed documentation source (see ide://agent/docs) for `query` and returns the best-matching passages with their pages' addresses. Without `name`, every source.",
      input: s.object({
        query: s.string(),
        name: s.string().optional(),
        limit: s.integer({ min: 1, max: 20 }).optional(),
      }),
      effects: ["read"],
      agent: "discoverable",
      run: async ({ query, name, limit }) => {
        const names = name ? [name] : docs.sources().map((x) => x.name);
        const parts: string[] = [];
        for (const n of names) {
          const hits = await docs.search(n, query, limit ?? 5).catch(() => null);
          if (hits) parts.push(renderDocHits(n, query, hits));
        }
        return { text: parts.join("\n\n") || "No docs are indexed yet (agent.addDocs)." };
      },
    }),
  );
  return docs;
}
