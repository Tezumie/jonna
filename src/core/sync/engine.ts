// The sync loop (D435), DOM-free. One pass: read what changed in the account since the last
// pass, then let each layer (settings, files, chats...) compare three things and act: what this
// computer has, what it had when it last synced (its base, kept on disk), and what the account
// has (a mirror of the records, kept in memory and rebuilt from the account at each start).
import type { SyncChanges, SyncInfo, SyncPut, SyncRecord } from "../ipc/sync";

/** What the engine needs of the backend (the IPC wrapper in the app; a fake in tests). */
export interface SyncBackend {
  changes(since: number): Promise<SyncChanges>;
  put(
    collection: string,
    id: string,
    expect: number | null,
    text: string | null,
    info?: SyncInfo | null,
  ): Promise<SyncPut>;
}

/** Where the bases are kept between runs (one JSON text). */
export interface SyncStore {
  load(): Promise<string | null>;
  save(text: string): Promise<void>;
}

export interface LayerContext {
  /** The account's records of a collection, tombstones included. */
  records(collection: string): SyncRecord[];
  /** Collections that start with `prefix`. */
  collections(prefix: string): string[];
  record(collection: string, id: string): SyncRecord | undefined;
  /**
   * Writes a record over the version the mirror has (`text` null deletes it). Returns the new
   * version, or null when someone else wrote first: the mirror then has theirs, and the layer
   * sees it at its next run.
   */
  put(
    collection: string,
    id: string,
    text: string | null,
    info?: SyncInfo | null,
  ): Promise<number | null>;
  /** Tells the mirror about a record written another way (a chat upload). */
  wrote(collection: string, id: string, version: number, text: string | null): void;
  /** A conflict another call reported: the record as the account has it. */
  saw(record: SyncRecord | null, collection: string, id: string): void;
  /** This layer's base: an object kept on disk; call `changed()` after changing it. */
  base<T extends object>(name: string, initial: () => T): T;
  changed(): void;
}

export interface SyncLayer {
  name: string;
  run(ctx: LayerContext): Promise<void>;
}

interface Stored {
  epoch: number;
  bases: Record<string, object>;
}

const key = (collection: string, id: string) => `${collection}/${id}`;

export class SyncEngine {
  private readonly mirror = new Map<string, SyncRecord>();
  private cursor = 0;
  private stored: Stored | null = null;
  private dirty = false;
  private running: Promise<void> | null = null;

  constructor(
    private readonly backend: SyncBackend,
    private readonly store: SyncStore,
    private readonly layers: readonly SyncLayer[],
  ) {}

  /** One pass; a second call while one runs waits for it and runs nothing more. */
  tick(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** The account's records as last read (for views: snapshots, the account's projects). */
  records(collection: string): SyncRecord[] {
    return [...this.mirror.values()].filter((r) => r.collection === collection);
  }

  /** Every record of the account as last read (for views of what the account holds). */
  allRecords(): SyncRecord[] {
    return [...this.mirror.values()];
  }

  /** Forgets everything read so far (sync went off, or another account signed in). */
  reset(): void {
    this.mirror.clear();
    this.cursor = 0;
    this.stored = null;
    this.dirty = false;
  }

  private async load(): Promise<Stored> {
    if (this.stored) return this.stored;
    let stored: Stored = { epoch: 0, bases: {} };
    try {
      const parsed = JSON.parse((await this.store.load()) ?? "null") as Partial<Stored> | null;
      if (parsed && typeof parsed.epoch === "number" && parsed.bases) {
        stored = { epoch: parsed.epoch, bases: parsed.bases };
      }
    } catch {
      // A damaged file: start from nothing; the layers then compare content, not history.
    }
    this.stored = stored;
    return stored;
  }

  private async pull(stored: Stored): Promise<void> {
    for (;;) {
      const page = await this.backend.changes(this.cursor);
      if (stored.epoch !== page.epoch) {
        // The account's sync was reset and set up again: nothing kept refers to it.
        this.mirror.clear();
        const fresh = this.cursor === 0;
        this.cursor = 0;
        stored.epoch = page.epoch;
        stored.bases = {};
        this.dirty = true;
        if (!fresh) continue;
      }
      for (const record of page.records) {
        this.mirror.set(key(record.collection, record.id), record);
        this.cursor = Math.max(this.cursor, record.seq);
      }
      if (!page.more) return;
    }
  }

  private async pass(): Promise<void> {
    const stored = await this.load();
    await this.pull(stored);
    const ctx: LayerContext = {
      records: (collection) => this.records(collection),
      collections: (prefix) => [
        ...new Set(
          [...this.mirror.values()].map((r) => r.collection).filter((c) => c.startsWith(prefix)),
        ),
      ],
      record: (collection, id) => this.mirror.get(key(collection, id)),
      put: async (collection, id, text, info) => {
        const now = this.mirror.get(key(collection, id));
        const result = await this.backend.put(
          collection,
          id,
          now ? now.version : null,
          text,
          info ?? null,
        );
        if (result.outcome === "done") {
          ctx.wrote(collection, id, result.version, text);
          return result.version;
        }
        if (result.outcome === "conflict") ctx.saw(result.current, collection, id);
        return null;
      },
      wrote: (collection, id, version, text) => {
        const before = this.mirror.get(key(collection, id));
        this.mirror.set(key(collection, id), {
          collection,
          id,
          version,
          seq: before?.seq ?? 0,
          deleted: text === null,
          text,
          unreadable: false,
          refs: before?.refs ?? 0,
          device: null,
          updatedAt: null,
        });
      },
      saw: (record, collection, id) => {
        if (record) this.mirror.set(key(collection, id), record);
        else this.mirror.delete(key(collection, id));
      },
      base: <T extends object>(name: string, initial: () => T): T => {
        stored.bases[name] ??= initial();
        return stored.bases[name] as T;
      },
      changed: () => {
        this.dirty = true;
      },
    };
    let failure: unknown = null;
    for (const layer of this.layers) {
      try {
        await layer.run(ctx);
      } catch (error) {
        // One layer failing doesn't stop the others; the pass still reports it.
        failure ??= error;
      }
    }
    if (this.dirty) {
      this.dirty = false;
      await this.store.save(JSON.stringify(stored));
    }
    if (failure) throw failure;
  }
}
