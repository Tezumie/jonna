// What syncs, as layers of the sync loop (D435). Each layer reaches this computer through a
// small port, so it runs the same in the app, with no window, and in tests. DOM-free.
import type { SyncPut, SyncUserFile } from "../ipc/sync";
import type { LayerContext, SyncLayer } from "./engine";
import {
  conflictPath,
  type FileBase,
  fileRecordId,
  type LocalFile,
  mergeSettings,
  planFiles,
  type RemoteFile,
  type SettingsRecord,
} from "./merge";

// ---------------------------------------------------------------- settings

export interface SettingsPort {
  /** The user settings file's top-level keys and when it changed; null while it can't be read. */
  read(): Promise<{ values: Record<string, unknown>; mtimeMs: number } | null>;
  /** Changes the user settings file; a `value` of undefined removes the key. */
  apply(edits: { key: string; value: unknown }[]): Promise<void>;
  /** Settings that stay on this computer. */
  skip(key: string): boolean;
}

export function settingsLayer(port: SettingsPort): SyncLayer {
  return {
    name: "settings",
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
      const base = ctx.base<{ keys: Record<string, string> }>("settings", () => ({ keys: {} }));
      const result = mergeSettings({
        local: local.values,
        base: base.keys,
        remote,
        localTime: local.mtimeMs,
        skip: port.skip,
      });
      if (result.apply.length > 0) await port.apply(result.apply);
      if (result.recordChanged) {
        // Readable by the service: how many settings, not which.
        const count = Object.values(result.record.keys).filter((k) => !k.d).length;
        const version = await ctx.put("settings", "user", JSON.stringify(result.record), {
          settings: count,
        });
        // Someone wrote first: merged again at the next pass, against theirs.
        if (version === null) return;
      }
      if (JSON.stringify(base.keys) !== JSON.stringify(result.base)) {
        base.keys = result.base;
        ctx.changed();
      }
    },
  };
}

// ---------------------------------------------------------------- the user's files

export interface FilesPort {
  scan(): Promise<SyncUserFile[]>;
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

export function filesLayer(port: FilesPort): SyncLayer {
  return {
    name: "files",
    async run(ctx) {
      const local = new Map<string, LocalFile>();
      for (const f of await port.scan()) {
        if (port.include(f.path)) local.set(f.path, { hash: f.hash, mtimeMs: f.mtimeMs });
      }
      const remote = new Map<string, RemoteFile>();
      const contents = new Map<string, FileRecord>();
      for (const r of ctx.records(FILES)) {
        if (!r.text || r.unreadable) continue;
        const file = JSON.parse(r.text) as FileRecord;
        if (typeof file.path !== "string" || !port.include(file.path)) continue;
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
      for (const [path, b] of Object.entries(base.files)) if (port.include(path)) known[path] = b;

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

      for (const action of planFiles(local, known, remote)) {
        const path = action.path;
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
            if (action.winner === "local") {
              const theirs = contents.get(path)?.text;
              if (theirs !== undefined) await port.write(conflictPath(path), theirs);
              await upload(path);
            } else {
              const mine = await port.read(path);
              if (mine !== null) await port.write(conflictPath(path), mine);
              await download(path);
            }
            break;
          }
        }
        ctx.changed();
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
  /** The collection a chat in this folder syncs under; null when its project doesn't sync. */
  collectionOf(workspace: string | null): string | null;
  /**
   * This computer's folder for a chat collection: null for chats with no folder, undefined
   * when that project isn't on this computer (its chats then stay in the account).
   */
  folderOf(collection: string): string | null | undefined;
  push(collection: string, id: string, expect: number | null): Promise<SyncPut | null>;
  pull(
    collection: string,
    id: string,
    saveAs: string,
    workspace: string | null,
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
      const remote = new Map<string, RemoteFile>();
      const where = new Map<string, string>();
      for (const collection of ctx.collections(CHATS)) {
        for (const r of ctx.records(collection)) {
          // A record the service marks deleted, or one that can't be read, says nothing here:
          // a deletion counts only as sealed content, which takes the account's keys to make.
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

      const upload = async (id: string, expect: number | null): Promise<void> => {
        const chat = chats.get(id);
        if (!chat) return;
        // A chat keeps the collection it was first synced under.
        const collection = where.get(id) ?? port.collectionOf(chat.workspace);
        if (!collection) return;
        const result = await port.push(collection, id, expect);
        if (!result) return;
        if (result.outcome === "done") {
          ctx.wrote(collection, id, result.version, "{}");
          base.chats[id] = { hash: chat.stamp, version: result.version, collection };
          ctx.changed();
        } else if (result.outcome === "conflict") ctx.saw(result.current, collection, id);
      };
      const download = async (id: string, saveAs: string): Promise<boolean> => {
        const collection = where.get(id);
        const version = remote.get(id)?.version;
        if (!collection || version === undefined) return false;
        const folder = port.folderOf(collection);
        if (folder === undefined) return false;
        const got = await port.pull(collection, id, saveAs, folder);
        if (got === null) return false;
        if (saveAs === id) {
          const stamp = await port.stamp(id);
          base.chats[id] = { hash: stamp ?? undefined, version: got, collection };
          ctx.changed();
        }
        return true;
      };

      for (const action of planFiles(local, base.chats, remote)) {
        const id = action.path;
        if (port.busy(id)) continue;
        switch (action.kind) {
          case "upload":
            await upload(id, action.expect);
            break;
          case "download":
            await download(id, id);
            break;
          case "deleteRemote": {
            const collection = where.get(id);
            if (!collection) break;
            const version = await ctx.put(collection, id, JSON.stringify({ deleted: true }), {
              deleted: true,
            });
            if (version !== null) {
              base.chats[id] = { version, collection };
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
            base.chats[id] = {
              hash: local.get(id)?.hash,
              version: remote.get(id)?.version ?? 0,
              collection: where.get(id) ?? "",
            };
            ctx.changed();
            break;
          case "conflict": {
            // No record here of ever syncing it (this computer lost what it kept): the same
            // content on both sides is the same chat, not two.
            const collection = where.get(id);
            if (!base.chats[id] && collection && (await port.same?.(collection, id))) {
              base.chats[id] = {
                hash: local.get(id)?.hash,
                version: remote.get(id)?.version ?? 0,
                collection,
              };
              ctx.changed();
              break;
            }
            // Changed on two computers: the other one's version becomes a chat of its own
            // here (and syncs as one); this computer's keeps the chat.
            if (await download(id, port.newId())) await upload(id, action.expect);
            break;
          }
        }
      }
    },
  };
}
