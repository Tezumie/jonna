// What syncs, as layers of the sync loop (D435). Each layer reaches this computer through a
// small port, so it runs the same in the app, with no window, and in tests. DOM-free.
//
// One rule runs through all of them: something missing here is never taken to be deleted
// unless its source says so. A settings file that isn't there has no opinion; a file is deleted
// only when a whole scan says it is gone; a chat only when this computer's own list of deleted
// chats names it.
import type { SyncPut, SyncUserFile, SyncUserFiles } from "../ipc/sync";
import type { LayerContext, SyncLayer } from "./engine";
import { isFull, messageOf, stopsPass } from "./errors";
import {
  conflictPath,
  type FileBase,
  fileRecordId,
  isConflictCopy,
  type LocalFile,
  mergeSettings,
  planFiles,
  type RemoteFile,
  type SettingStamp,
  type SettingsRecord,
  stampSettings,
} from "./merge";

// ---------------------------------------------------------------- settings

export interface SettingsPort {
  /**
   * The user settings file's top-level keys and when it changed; null while it can't be read.
   * `missing`: there is no file. That isn't "every setting removed": the account's settings
   * are applied, and nothing is told to the account.
   */
  read(): Promise<{ values: Record<string, unknown>; mtimeMs: number; missing?: boolean } | null>;
  /** Changes the user settings file; a `value` of undefined removes the key. */
  apply(edits: { key: string; value: unknown }[]): Promise<void>;
  /** Settings that stay on this computer. */
  skip(key: string): boolean;
  /**
   * Whether an entry stays on this computer going by its value too: a language block
   * (`"[python]": {…}`) holding a setting that stays. Asked for this computer's value and for
   * the account's; either saying so keeps the entry out of the pass. Absent: `skip` decides.
   */
  skipEntry?(key: string, value: unknown): boolean;
  /** The time now, in ms (absent: the clock's). */
  now?(): number;
}

/**
 * `port.skip`, and the entries whose value (here or in the account) keeps them out: nothing is
 * applied, uploaded or removed for those, on either side.
 */
function settingsSkip(
  port: SettingsPort,
  local: Readonly<Record<string, unknown>>,
  remote: SettingsRecord | null,
): (key: string) => boolean {
  const check = port.skipEntry?.bind(port);
  if (!check) return (key) => port.skip(key);
  const held = new Set<string>();
  for (const [key, value] of Object.entries(local)) if (check(key, value)) held.add(key);
  for (const [key, entry] of Object.entries(remote?.keys ?? {}))
    if (entry && !entry.d && check(key, entry.v)) held.add(key);
  return (key) => held.has(key) || port.skip(key);
}

/** What this computer keeps of its settings' last sync. */
interface SettingsBase {
  /** Key to the canonical JSON of its value at the last sync. */
  keys: Record<string, string>;
  /** This computer has synced its settings: an empty `keys` then says "none", not "never". */
  synced?: true;
  /** When each setting changed here since then was first seen changed. */
  stamps?: Record<string, SettingStamp>;
}

type LocalSettings = { values: Record<string, unknown>; mtimeMs: number; missing?: boolean };

/** The sentence for settings here that gave way to the account's with no history to go by. */
function replacedSentence(replaced: readonly { key: string; value: unknown }[]): string {
  const shown = replaced.slice(0, 8).map(({ key, value }) => {
    const was = JSON.stringify(value) ?? "";
    return was.length <= 40 ? `${key} (was ${was})` : key;
  });
  const more = replaced.length - shown.length;
  return `This computer had no record of an earlier sync, so where its settings differed from the account's, the account's were kept: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`;
}

/** The sentence for settings here that stayed where the account's differed, after a reset. */
function keptSentence(kept: readonly { key: string; value: unknown }[]): string {
  const shown = kept.slice(0, 8).map(({ key }) => key);
  const more = kept.length - shown.length;
  return `The account's sync was set up again, so where this computer's settings differed from the account's, this computer's were kept and sent to the account: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`;
}

export function settingsLayer(port: SettingsPort): SyncLayer {
  const baseOf = (ctx: LayerContext) => ctx.base<SettingsBase>("settings", () => ({ keys: {} }));
  /**
   * Dates what changed here since the last sync, the first time it is seen changed. The
   * settings file's own time isn't a change's time: the app writes the file too.
   */
  const stamp = (
    ctx: LayerContext,
    local: LocalSettings,
    skip: (key: string) => boolean,
  ): SettingsBase => {
    const base = baseOf(ctx);
    // No file has no opinion, and so nothing to date.
    if (local.missing) return base;
    const now = port.now?.() ?? Date.now();
    const next = stampSettings({
      local: local.values,
      base: base.keys,
      stamps: base.stamps ?? {},
      seenAt: local.mtimeMs > 0 && local.mtimeMs <= now ? local.mtimeMs : now,
      skip,
    });
    if (next.changed) {
      base.stamps = next.stamps;
      ctx.changed();
    }
    return base;
  };
  return {
    name: "settings",
    async observe(ctx) {
      const local = await port.read();
      if (local) stamp(ctx, local, settingsSkip(port, local.values, null));
    },
    async run(ctx) {
      const record = ctx.record("settings", "user");
      if (record?.unreadable) return;
      const local = await port.read();
      if (!local) return;
      let remote: SettingsRecord | null = null;
      if (record?.text) {
        const parsed = JSON.parse(record.text) as Partial<SettingsRecord>;
        if (parsed.keys && typeof parsed.keys === "object") remote = { keys: parsed.keys };
      }
      const skip = settingsSkip(port, local.values, remote);
      const base = stamp(ctx, local, skip);
      const localTimes: Record<string, number> = {};
      for (const [key, seen] of Object.entries(base.stamps ?? {})) localTimes[key] = seen.t;
      const result = mergeSettings({
        local: local.missing ? {} : local.values,
        // No file: what was synced before says nothing about now (compared with it, every
        // setting would look removed). With no history, the account's settings just apply.
        base: local.missing ? {} : base.keys,
        remote,
        localTime: local.mtimeMs,
        localTimes,
        hasBase: !local.missing && (base.synced === true || Object.keys(base.keys).length > 0),
        // The account's sync "was set up again": the service's word, so what is here stays.
        keepLocal: ctx.afterReset(),
        skip,
      });
      if (result.apply.length > 0) await port.apply(result.apply);
      // Said once: after this pass the two agree, and there is a record of a sync.
      if (result.replaced.length > 0)
        ctx.note({ kind: "conflict", text: replacedSentence(result.replaced) });
      if (result.kept.length > 0) ctx.note({ kind: "conflict", text: keptSentence(result.kept) });
      if (result.recordChanged) {
        // Readable by the service: how many settings, not which.
        const count = Object.values(result.record.keys).filter((k) => !k.d).length;
        const version = await ctx.put("settings", "user", JSON.stringify(result.record), {
          settings: count,
        });
        // Someone wrote first: merged again at the next pass, against theirs.
        if (version === null) return;
      }
      if (JSON.stringify(base.keys) !== JSON.stringify(result.base) || base.synced !== true) {
        base.keys = result.base;
        base.synced = true;
        ctx.changed();
      }
    },
  };
}

// ---------------------------------------------------------------- the user's files

export interface FilesPort {
  /**
   * The files that sync, the names that are there but can't sync as they are (`kept`), and
   * whether the scan saw everything (`complete`).
   */
  scan(): Promise<SyncUserFiles>;
  read(path: string): Promise<string | null>;
  write(path: string, text: string | null): Promise<SyncUserFile | null>;
  /** Whether this file's kind syncs (keybindings, snippets, skills... each can be off). */
  include(path: string): boolean;
  now(): number;
}

/** A file's record: its name and text, or that it was deleted. */
interface FileRecord {
  path: string;
  text?: string;
  hash?: string;
  mtimeMs: number;
  deleted?: true;
}

const FILES = "files";
/** Past this many conflict copies of one file, the last one is written over. */
const MAX_CONFLICT_COPIES = 99;

export function filesLayer(port: FilesPort): SyncLayer {
  return {
    name: "files",
    async run(ctx) {
      const scan = await port.scan();
      // A file that is there but can't sync as it is (too large, not text, unreadable just
      // now): present and unchanged as far as sync goes. Nothing is done with it, and what was
      // synced of it before stays as it is.
      const kept = new Set(scan.kept);
      // A conflict copy stays beside its file on the computer that made it, whatever the scan
      // or the account lists.
      const out = (path: string) => kept.has(path) || isConflictCopy(path) || !port.include(path);
      const local = new Map<string, LocalFile>();
      for (const f of scan.files) {
        if (!out(f.path)) local.set(f.path, { hash: f.hash, mtimeMs: f.mtimeMs });
      }
      const remote = new Map<string, RemoteFile>();
      const contents = new Map<string, FileRecord>();
      for (const r of ctx.records(FILES)) {
        if (!r.text || r.unreadable) continue;
        const file = JSON.parse(r.text) as FileRecord;
        if (typeof file.path !== "string" || out(file.path)) continue;
        // The id is made from the path: a record under another id isn't this file's.
        if (fileRecordId(file.path) !== r.id) continue;
        contents.set(file.path, file);
        remote.set(file.path, {
          version: r.version,
          deleted: file.deleted === true,
          hash: file.hash,
          mtimeMs: file.mtimeMs,
        });
      }
      const base = ctx.base<{ files: Record<string, FileBase> }>("files", () => ({ files: {} }));
      // A kind switched off keeps its base: switched on again, it picks up where it was.
      const known: Record<string, FileBase> = {};
      for (const [path, b] of Object.entries(base.files)) if (!out(path)) known[path] = b;

      const upload = async (path: string): Promise<void> => {
        const text = await port.read(path);
        const here = local.get(path);
        if (text === null || !here) return;
        const record: FileRecord = { path, text, hash: here.hash, mtimeMs: here.mtimeMs };
        // Readable by the service: the file's name and size, not its text.
        const version = await ctx.put(FILES, fileRecordId(path), JSON.stringify(record), {
          path,
          bytes: text.length,
        });
        if (version !== null) base.files[path] = { hash: here.hash, version };
      };
      const download = async (path: string): Promise<void> => {
        const there = contents.get(path);
        const version = remote.get(path)?.version;
        if (!there || there.text === undefined || version === undefined) return;
        const written = await port.write(path, there.text);
        base.files[path] = { hash: written?.hash ?? there.hash, version };
      };
      /**
       * Keeps the losing side of a conflict beside the file, under the first conflict name
       * that is free (or already holds this very text), so an earlier copy is never written
       * over. Returns the name.
       */
      const keepAside = async (path: string, text: string): Promise<string> => {
        const first = conflictPath(path);
        let aside = first;
        for (let copy = 1; copy <= MAX_CONFLICT_COPIES; copy++) {
          aside = conflictPath(path, copy);
          let there: string | null;
          try {
            there = await port.read(aside);
          } catch (err) {
            // A backend that knows only the first name (it refuses the numbered ones): the
            // copy goes there, as it did before copies were numbered.
            if (copy > 1 && /not a synced file/i.test(messageOf(err))) {
              aside = first;
              break;
            }
            throw err;
          }
          if (there === text) return aside;
          if (there === null) break;
        }
        await port.write(aside, text);
        return aside;
      };

      for (const action of planFiles(local, known, remote)) {
        if (ctx.stopped()) break;
        const path = action.path;
        // No room in the account: nothing is sent (it waits for a later pass), and what the
        // account holds still arrives.
        if (
          ctx.full() &&
          (action.kind === "upload" || (action.kind === "conflict" && action.winner === "local"))
        )
          continue;
        // A scan that didn't see everything can't say a file is gone, and a file it didn't
        // see isn't removed on the account's word either: both wait for a whole scan.
        if (!scan.complete && (action.kind === "deleteRemote" || action.kind === "deleteLocal"))
          continue;
        try {
          switch (action.kind) {
            case "upload":
              await upload(path);
              break;
            case "download":
              await download(path);
              break;
            case "deleteRemote": {
              const record: FileRecord = { path, deleted: true, mtimeMs: port.now() };
              const version = await ctx.put(FILES, fileRecordId(path), JSON.stringify(record), {
                path,
                deleted: true,
              });
              if (version !== null) base.files[path] = { version };
              break;
            }
            case "deleteLocal":
              await port.write(path, null);
              base.files[path] = { version: remote.get(path)?.version ?? 0 };
              break;
            case "adopt":
              base.files[path] = {
                hash: local.get(path)?.hash,
                version: remote.get(path)?.version ?? 0,
              };
              break;
            case "conflict": {
              // The side that loses is kept beside the file, never thrown away.
              let aside = conflictPath(path);
              if (action.winner === "local") {
                const theirs = contents.get(path)?.text;
                if (theirs !== undefined) aside = await keepAside(path, theirs);
                await upload(path);
              } else {
                const mine = await port.read(path);
                if (mine !== null) aside = await keepAside(path, mine);
                await download(path);
              }
              ctx.note({
                kind: "conflict",
                text: `${path} changed on two computers: the ${action.winner === "local" ? "other computer's" : "version that was here"} is kept as ${aside}.`,
              });
              break;
            }
          }
          ctx.changed();
        } catch (err) {
          if (isFull(err)) {
            ctx.noRoom(err);
            continue;
          }
          if (stopsPass(err)) throw err;
          // One file that can't sync doesn't hold up the rest.
          ctx.note({ kind: "failure", text: `${path} couldn't sync: ${messageOf(err)}` });
        }
      }
    },
  };
}

// ---------------------------------------------------------------- chats

export interface LocalChat {
  id: string;
  /** The chat's project folder on this computer (null: none). */
  workspace: string | null;
  /** Changes whenever the chat is saved. */
  stamp: string;
  /** When it was last changed, in ms. */
  updated: number;
}

export interface ChatsPort {
  list(): Promise<LocalChat[]>;
  /**
   * The chats deleted on this computer (ids), as this computer noted when they were deleted.
   * Only these are deleted from the account: a chat that just isn't in `list` is left alone.
   */
  deleted(): Promise<string[]>;
  /** Forgets those deletions: the account knows of them, or there was nothing to tell. */
  clearDeleted(ids: string[]): Promise<void>;
  /** The collection a chat in this folder syncs under; null when its project doesn't sync. */
  collectionOf(workspace: string | null): string | null;
  /**
   * This computer's folder for a chat collection: null for chats with no folder, undefined
   * when that project isn't on this computer (its chats then stay in the account).
   */
  folderOf(collection: string): string | null | undefined;
  push(collection: string, id: string, expect: number | null): Promise<SyncPut | null>;
  /**
   * Saves the account's chat here as `saveAs`. `ifStamp` is the stamp the chat here must still
   * have (null: there must be none): saved meanwhile, nothing is written and the answer is
   * null, as when the record is gone.
   */
  pull(
    collection: string,
    id: string,
    saveAs: string,
    workspace: string | null,
    ifStamp: string | null,
  ): Promise<number | null>;
  remove(id: string): Promise<void>;
  stamp(id: string): Promise<string | null>;
  newId(): string;
  /** A chat being written right now (an answer streaming): left for the next pass. */
  busy(id: string): boolean;
  /** Whether the chat saved here is exactly the one the account has (when the port can tell). */
  same?(collection: string, id: string): Promise<boolean>;
}

interface ChatBase extends FileBase {
  collection: string;
  /**
   * The account's version whose content was already saved here as a chat of its own (a
   * conflict): what is left is to send this computer's, never to fork that version again.
   */
  forked?: number;
}

const CHATS = "chats.";

export function chatsLayer(port: ChatsPort): SyncLayer {
  return {
    name: "chats",
    async run(ctx: LayerContext) {
      const chats = new Map<string, LocalChat>();
      const local = new Map<string, LocalFile>();
      for (const chat of await port.list()) {
        chats.set(chat.id, chat);
        local.set(chat.id, { hash: chat.stamp, mtimeMs: chat.updated });
      }
      const deleted = new Set(await port.deleted());
      const remote = new Map<string, RemoteFile>();
      const where = new Map<string, string>();
      /** Records removed from the account (not deleted as chats): where to write over them. */
      const removed = new Map<string, { collection: string; version: number }>();
      for (const collection of ctx.collections(CHATS)) {
        for (const r of ctx.records(collection)) {
          // A record the service marks deleted, or one that can't be read, says nothing here:
          // a deletion counts only as sealed content, which takes the account's keys to make.
          if (r.deleted) removed.set(r.id, { collection, version: r.version });
          if (r.unreadable || r.deleted || !r.text) continue;
          const entry = JSON.parse(r.text) as { deleted?: unknown; meta?: { updated?: unknown } };
          const updated = typeof entry.meta?.updated === "number" ? entry.meta.updated : 0;
          remote.set(r.id, {
            version: r.version,
            deleted: entry.deleted === true,
            mtimeMs: updated,
          });
          where.set(r.id, collection);
        }
      }
      const base = ctx.base<{ chats: Record<string, ChatBase> }>("chats", () => ({ chats: {} }));
      // A chat this computer synced that the account no longer has (its project was removed
      // from the account): it is sent again, as a chat that was never synced.
      for (const [id, b] of Object.entries(base.chats)) {
        if (b.hash !== undefined && !remote.has(id) && local.has(id)) {
          delete base.chats[id];
          ctx.changed();
        }
      }

      const upload = async (id: string, expect: number | null): Promise<void> => {
        const chat = chats.get(id);
        if (!chat) return;
        // No room in the account: a chat isn't sealed and sent only to be refused. It waits.
        if (ctx.full()) return;
        // Only a chat whose folder syncs from this computer (or one with no folder) is sent:
        // a project that stopped syncing here, or was deleted from the account, isn't
        // uploaded again behind the person's back.
        const here = port.collectionOf(chat.workspace);
        if (!here) return;
        // A chat keeps the collection it was first synced under.
        const gone = removed.get(id);
        const collection = where.get(id) ?? gone?.collection ?? here;
        // Over the marker of a record removed from the account, when there is one.
        const result = await port.push(collection, id, expect ?? gone?.version ?? null);
        if (!result) return;
        if (result.outcome === "done") {
          ctx.wrote(collection, id, result.version, "{}");
          base.chats[id] = { hash: chat.stamp, version: result.version, collection };
          ctx.changed();
          // Kept at once: a window closed before the pass ends doesn't send it again.
          await ctx.flush();
        } else if (result.outcome === "conflict") ctx.saw(result.current, collection, id);
      };
      /** Chats that arrived under their own id this pass. */
      const arrived = new Set<string>();
      const download = async (id: string, saveAs: string): Promise<boolean> => {
        const collection = where.get(id);
        const version = remote.get(id)?.version;
        if (!collection || version === undefined) return false;
        const folder = port.folderOf(collection);
        if (folder === undefined) return false;
        // Only over the chat as this pass saw it: one saved meanwhile waits for the next pass.
        const ifStamp = saveAs === id ? (chats.get(id)?.stamp ?? null) : null;
        const got = await port.pull(collection, id, saveAs, folder, ifStamp);
        if (got === null) return false;
        if (saveAs === id) {
          const stamp = await port.stamp(id);
          base.chats[id] = { hash: stamp ?? undefined, version: got, collection };
          arrived.add(id);
          ctx.changed();
          await ctx.flush();
        }
        return true;
      };

      /** Deletions the account now knows of. */
      const told = new Set<string>();
      for (const action of planFiles(local, base.chats, remote)) {
        if (ctx.stopped()) return;
        const id = action.path;
        if (port.busy(id)) continue;
        try {
          switch (action.kind) {
            case "upload":
              await upload(id, action.expect);
              break;
            case "download":
              await download(id, id);
              break;
            case "deleteRemote": {
              // Not in the list of chats isn't "deleted": the list may be short for a reason
              // of its own. Only a chat this computer noted as deleted is.
              if (!deleted.has(id)) break;
              const collection = where.get(id);
              if (!collection) break;
              const version = await ctx.put(collection, id, JSON.stringify({ deleted: true }), {
                deleted: true,
              });
              if (version !== null) {
                base.chats[id] = { version, collection };
                told.add(id);
                ctx.changed();
              }
              break;
            }
            case "deleteLocal":
              await port.remove(id);
              base.chats[id] = {
                version: remote.get(id)?.version ?? 0,
                collection: where.get(id) ?? "",
              };
              ctx.changed();
              break;
            case "adopt":
              // A chat's content isn't known from its record, so "both sides agree" is only
              // true here when both are gone. Gone here and changed there: it comes back (a
              // delete never beats a change).
              if (!local.has(id) && remote.get(id)?.deleted === false) {
                await download(id, id);
                break;
              }
              base.chats[id] = {
                hash: local.get(id)?.hash,
                version: remote.get(id)?.version ?? 0,
                collection: where.get(id) ?? "",
              };
              ctx.changed();
              break;
            case "conflict": {
              const collection = where.get(id);
              const version = remote.get(id)?.version;
              if (!collection || version === undefined) break;
              const before = base.chats[id];
              // The account's version is a chat of its own here already (an earlier pass
              // made it and then couldn't send): only the sending is left.
              if (before?.forked === version) {
                await upload(id, action.expect);
                break;
              }
              // The same content on both sides is the same chat, not two: asked every time,
              // whatever this computer remembers of having synced it.
              if (await port.same?.(collection, id)) {
                base.chats[id] = { hash: local.get(id)?.hash, version, collection };
                ctx.changed();
                break;
              }
              // Changed on two computers: the other one's version becomes a chat of its own
              // here (and syncs as one); this computer's keeps the chat.
              if (!(await download(id, port.newId()))) break;
              // Remembered before sending, so a failed send is tried again without another
              // copy of the other computer's version.
              base.chats[id] = {
                hash: before?.hash,
                version: before?.version ?? 0,
                collection,
                forked: version,
              };
              ctx.changed();
              await ctx.flush();
              ctx.note({
                kind: "conflict",
                text: "A chat changed on two computers: the other computer's version is kept as a chat of its own.",
              });
              await upload(id, action.expect);
              break;
            }
          }
        } catch (err) {
          // No room: said once by the pass, not once per chat; the chats still to fetch are.
          if (isFull(err)) {
            ctx.noRoom(err);
            continue;
          }
          if (stopsPass(err)) throw err;
          // One chat that can't sync doesn't hold up the rest.
          ctx.note({ kind: "failure", text: `A chat couldn't sync: ${messageOf(err)}` });
        }
      }

      // The deletions with nothing left to tell: the account was told, the chat is here
      // (again), or the account has no chat of that id to mark.
      const settled = [...deleted].filter((id) => {
        if (told.has(id) || local.has(id) || arrived.has(id)) return true;
        const there = remote.get(id);
        return !there || there.deleted;
      });
      if (settled.length > 0) await port.clearDeleted(settled);
    },
  };
}
