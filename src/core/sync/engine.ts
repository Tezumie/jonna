// The sync loop (D435), DOM-free. One pass: read what changed in the account since the last
// pass, then let each layer (settings, files, chats...) compare three things and act: what this
// computer has, what it had when it last synced (its base, kept on disk), and what the account
// has (a mirror of the records, kept in memory and rebuilt from the account at each start).
import type { SyncChanges, SyncInfo, SyncPut, SyncRecord } from "../ipc/sync";
import { isFull } from "./errors";

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

/** Something a layer did that the person may want to know: said, not guessed from the records. */
export interface SyncNote {
  /** "conflict": both sides changed and one was kept aside; "failure": one item couldn't sync. */
  kind: "conflict" | "failure";
  text: string;
}

export interface SyncEngineOptions {
  /** Hears what the layers report (the app's activity log). */
  note?(event: SyncNote): void;
  /** True once this pass should end early (the claim on the loop was lost). */
  stopped?(): boolean;
  /**
   * True while the account is known to have no room (its usage is at its limit): content isn't
   * sent, so nothing is sealed and posted only to be refused. Reading goes on.
   */
  full?(): boolean;
}

export interface LayerContext {
  /** The account's records of a collection, tombstones included. */
  records(collection: string): SyncRecord[];
  /** Collections that start with `prefix`. */
  collections(prefix: string): string[];
  record(collection: string, id: string): SyncRecord | undefined;
  /**
   * Writes a record over the version the mirror has (`text` null deletes it). Returns the new
   * version, or null when nothing was written: someone else wrote first (the mirror then has
   * theirs, and the layer sees it at its next run), or the record there can't be read yet.
   */
  put(
    collection: string,
    id: string,
    text: string | null,
    info?: SyncInfo | null,
  ): Promise<number | null>;
  /** Tells the mirror about a record written another way (a chat upload). */
  wrote(
    collection: string,
    id: string,
    version: number,
    text: string | null,
    info?: SyncInfo | null,
  ): void;
  /** A conflict another call reported: the record as the account has it. */
  saw(record: SyncRecord | null, collection: string, id: string): void;
  /** This layer's base: an object kept on disk; call `changed()` after changing it. */
  base<T extends object>(name: string, initial: () => T): T;
  changed(): void;
  /**
   * Saves the bases now when they changed, not only at the end of the pass: after a transfer
   * that must not be done again should the window close before the pass ends.
   */
  flush(): Promise<void>;
  /** Reports a conflict or one item's failure. */
  note(event: SyncNote): void;
  /**
   * Whether the bases were dropped because the account's sync says it was set up again
   * (another epoch than the one the bases were of), and no pass has completed since. Not true
   * for a computer that never synced. A layer then keeps what this computer has where the
   * account's differs, instead of taking the account's side: the epoch is the service's word.
   */
  afterReset(): boolean;
  /** Whether the pass should end after the action under way. */
  stopped(): boolean;
  /**
   * Whether the account has no room: known before the pass, or said by the service during it.
   * A layer sends nothing more while it is true, and goes on fetching.
   */
  full(): boolean;
  /**
   * The service refused a write for want of room (`err`): nothing more is sent this pass, and
   * the pass ends as failed with that error, once, after everything else was done.
   */
  noRoom(err: unknown): void;
}

export interface SyncLayer {
  name: string;
  /**
   * Looks at this computer only, before the account is read, so it runs (and what it notes in
   * its base is saved) also when the account can't be reached: when a setting was changed here
   * is noted while it is still known.
   */
  observe?(ctx: LayerContext): Promise<void>;
  run(ctx: LayerContext): Promise<void>;
}

interface Stored {
  epoch: number;
  bases: Record<string, object>;
  /** The bases were dropped for another epoch; cleared by the first pass that completes. */
  afterReset?: boolean;
  /**
   * How far the account was read when this was saved. Kept with the bases for whoever reads the
   * file; a start still reads the account from the beginning, since the records themselves
   * (the mirror) are only in memory.
   */
  cursor?: number;
}

const key = (collection: string, id: string) => `${collection}/${id}`;

export class SyncEngine {
  private readonly mirror = new Map<string, SyncRecord>();
  private cursor = 0;
  private stored: Stored | null = null;
  private dirty = false;
  private running: Promise<void> | null = null;
  private waitingForKeys = false;
  /** The service's "no room" of the pass under way (null: it had room). */
  private refused: unknown = null;
  /** Records already reported as older copies (once each while the window lives). */
  private readonly staleSaid = new Set<string>();

  constructor(
    private readonly backend: SyncBackend,
    private readonly store: SyncStore,
    private readonly layers: readonly SyncLayer[],
    private readonly options: SyncEngineOptions = {},
  ) {}

  /** One pass; a second call while one runs waits for it and runs nothing more. */
  tick(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /**
   * True while the account holds a record sealed with keys this computer doesn't have yet. The
   * reading stops at that record (it is asked for again at the next pass) and the layers don't
   * run: acting on half of what the account holds, or writing over what can't be read, is how
   * things get lost. The device's keys catch up when its status is read.
   */
  get blocked(): boolean {
    return this.waitingForKeys;
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
    this.waitingForKeys = false;
  }

  /**
   * Reads the bases from disk again at the next pass, keeping what was read of the account:
   * for a window that takes the loop over from another, whose saved bases are newer than this
   * window's copy.
   */
  reloadBases(): void {
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
        if (parsed.afterReset === true) stored.afterReset = true;
      }
    } catch {
      // A damaged file: start from nothing; the layers then compare content, not history.
    }
    this.stored = stored;
    return stored;
  }

  private async save(stored: Stored): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    stored.cursor = this.cursor;
    await this.store.save(JSON.stringify(stored));
  }

  private async pull(stored: Stored): Promise<void> {
    this.waitingForKeys = false;
    let wasReset = false;
    for (;;) {
      const from = this.cursor;
      const page: SyncChanges | null | undefined = await this.backend.changes(from);
      // An answer that isn't one (no epoch, no list of records) says nothing about the account:
      // least of all that it was reset. The pass fails and is tried again; nothing is forgotten.
      const epoch = page?.epoch;
      if (
        !page ||
        typeof epoch !== "number" ||
        !Number.isFinite(epoch) ||
        epoch <= 0 ||
        !Array.isArray(page.records)
      ) {
        throw new Error("The account's answer couldn't be read. Sync will try again.");
      }
      if (stored.epoch !== epoch) {
        // A second reset within one reading is an answer that can't be trusted either.
        if (wasReset) throw new Error("The account's answer kept changing. Sync will try again.");
        wasReset = true;
        // The account's sync was reset and set up again: nothing kept refers to it.
        this.mirror.clear();
        const fresh = this.cursor === 0;
        this.cursor = 0;
        // Bases of another epoch are dropped on the service's word alone: remembered, so
        // the layers keep what this computer has (`LayerContext.afterReset`). A computer
        // with no bases at all (it joins, epoch 0 here) has nothing to keep against.
        if (stored.epoch > 0) stored.afterReset = true;
        stored.epoch = epoch;
        stored.bases = {};
        this.dirty = true;
        if (!fresh) continue;
      }
      for (const record of [...page.records].sort((a, b) => a.seq - b.seq)) {
        this.mirror.set(key(record.collection, record.id), record);
        // An older copy than this computer has seen (the backend refused its content): it
        // counts as having none, so nothing here is replaced or removed for it. Said once.
        if (record.stale) this.sayStale(record.collection, record.id);
        if (record.unreadable) {
          // Not read past: it is asked for again once this computer's keys caught up. Until
          // then the mirror says "can't be read", so nothing is written over it.
          this.waitingForKeys = true;
          return;
        }
        this.cursor = Math.max(this.cursor, record.seq);
      }
      if (!page.more) return;
      // "There is more" with nothing new to ask from: asking again would get the same page,
      // for ever. The pass fails here and is tried again later.
      if (this.cursor <= from) {
        throw new Error("The account's changes didn't move on. Sync will try again.");
      }
    }
  }

  private sayStale(collection: string, id: string): void {
    const name = key(collection, id);
    if (this.staleSaid.has(name)) return;
    this.staleSaid.add(name);
    this.options.note?.({
      kind: "failure",
      text: "The account gave back an older copy of a synced item than this computer has seen. It wasn't used, and nothing here was changed for it.",
    });
  }

  private async pass(): Promise<void> {
    const stored = await this.load();
    this.refused = null;
    const ctx = this.context(stored);
    // What each layer notes of this computer, kept whether or not the account answers.
    for (const layer of this.layers) {
      if (!layer.observe || ctx.stopped()) continue;
      try {
        await layer.observe(ctx);
      } catch {
        // Not noted this time: the layer's run does without.
      }
    }
    try {
      await this.save(stored);
    } catch {
      // Saved with the rest at the end of the pass.
      this.dirty = true;
    }
    await this.pull(stored);
    if (this.waitingForKeys) {
      await this.save(stored);
      return;
    }
    let failure: unknown = null;
    for (const layer of this.layers) {
      if (ctx.stopped()) break;
      try {
        await layer.run(ctx);
      } catch (error) {
        // One layer failing doesn't stop the others; the pass still reports it.
        failure ??= error;
      }
    }
    // Every layer ran: what differed was settled with this computer's side kept.
    if (!failure && !ctx.stopped() && stored.afterReset) {
      stored.afterReset = undefined;
      this.dirty = true;
    }
    await this.save(stored);
    if (failure) throw failure;
    // No room in the account: everything that could be done was, and the pass says so once.
    if (this.refused) throw this.refused;
  }

  private context(stored: Stored): LayerContext {
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
        // Never over what this computer can't read: it would replace someone's change unseen.
        if (now?.unreadable) return null;
        // The service said "no room" a moment ago: not asked again and again within the pass.
        // (Removing a record takes no room.)
        if (this.refused && text !== null) return null;
        let result: SyncPut;
        try {
          result = await this.backend.put(
            collection,
            id,
            now ? now.version : null,
            text,
            info ?? null,
          );
        } catch (err) {
          if (!isFull(err)) throw err;
          // Not written: tried again at a later pass, like a write that lost a race.
          this.refused ??= err;
          return null;
        }
        if (result.outcome === "done") {
          ctx.wrote(collection, id, result.version, text, info ?? null);
          return result.version;
        }
        if (result.outcome === "conflict") ctx.saw(result.current, collection, id);
        return null;
      },
      wrote: (collection, id, version, text, info) => {
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
          device: before?.device ?? null,
          updatedAt: before?.updatedAt ?? null,
          // Kept for the views until the next read brings the record back whole.
          info: info ?? before?.info ?? null,
        });
      },
      saw: (record, collection, id) => {
        if (record?.stale) this.sayStale(collection, id);
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
      flush: () => this.save(stored),
      note: (event) => this.options.note?.(event),
      afterReset: () => stored.afterReset === true,
      stopped: () => this.options.stopped?.() === true,
      full: () => this.refused !== null || this.options.full?.() === true,
      noRoom: (err) => {
        this.refused ??= err;
      },
    };
    return ctx;
  }
}
