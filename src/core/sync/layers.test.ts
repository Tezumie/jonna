import assert from "node:assert/strict";
import { test } from "node:test";
import type { SyncChanges, SyncPut, SyncRecord, SyncUserFile } from "../ipc/sync";
import { type SyncBackend, SyncEngine, type SyncNote, type SyncStore } from "./engine";
import { codeOf } from "./errors";
import {
  type ChatsPort,
  chatsLayer,
  type FilesPort,
  filesLayer,
  type LocalChat,
  type SettingsPort,
  settingsLayer,
} from "./layers";

/** The account as the service keeps it: versions, a change counter, conflicts. */
class FakeAccount {
  epoch = 1;
  seq = 0;
  readonly records = new Map<string, SyncRecord>();
  /** Records (by "collection/id") sealed with keys the reader doesn't hold yet. */
  readonly sealed = new Set<string>();

  backend(): SyncBackend {
    return {
      changes: async (since): Promise<SyncChanges> => ({
        epoch: this.epoch,
        seq: this.seq,
        gcEpoch: 0,
        more: false,
        records: [...this.records.values()]
          .filter((r) => r.seq > since)
          .sort((a, b) => a.seq - b.seq)
          .map((r) =>
            this.sealed.has(`${r.collection}/${r.id}`)
              ? { ...r, text: null, unreadable: true }
              : { ...r },
          ),
      }),
      put: async (collection, id, expect, text): Promise<SyncPut> =>
        this.put(collection, id, expect, text),
    };
  }

  put(collection: string, id: string, expect: number | null, text: string | null): SyncPut {
    const key = `${collection}/${id}`;
    const now = this.records.get(key);
    if ((now?.version ?? null) !== expect) {
      return { outcome: "conflict", current: now ? { ...now } : null };
    }
    const record: SyncRecord = {
      collection,
      id,
      version: (now?.version ?? 0) + 1,
      seq: ++this.seq,
      deleted: text === null,
      text,
      unreadable: false,
      refs: 0,
      device: null,
      updatedAt: null,
    };
    this.records.set(key, record);
    return { outcome: "done", version: record.version, seq: record.seq };
  }

  reset(): void {
    this.epoch++;
    this.seq = 0;
    this.records.clear();
  }
}

function memoryStore(): SyncStore & { text: string | null } {
  const store = {
    text: null as string | null,
    load: async () => store.text,
    save: async (text: string) => {
      store.text = text;
    },
  };
  return store;
}

/** A computer's settings file. */
function settingsPort(values: Record<string, unknown>, clock: { now: number }) {
  const port: SettingsPort & {
    values: Record<string, unknown>;
    mtimeMs: number;
    /** The settings file isn't there. */
    missing: boolean;
  } = {
    values,
    mtimeMs: clock.now,
    missing: false,
    read: async () => ({
      values: { ...port.values },
      mtimeMs: port.mtimeMs,
      ...(port.missing && { missing: true }),
    }),
    apply: async (edits) => {
      for (const { key, value } of edits) {
        if (value === undefined) delete port.values[key];
        else port.values[key] = value;
      }
    },
    skip: (key) => key === "accounts.serverUrl",
  };
  return port;
}

const hashOf = (text: string) => `h:${text}`;

/** A computer's synced files. */
function filesPort(files: Record<string, string>, clock: { now: number }) {
  const times = new Map<string, number>(Object.keys(files).map((p) => [p, clock.now]));
  const entry = (path: string): SyncUserFile => ({
    path,
    hash: hashOf(files[path] ?? ""),
    mtimeMs: times.get(path) ?? 0,
  });
  const port: FilesPort & {
    files: Record<string, string>;
    edit(path: string, text: string | null): void;
    off: Set<string>;
    /** There, but can't sync as they are. */
    kept: Set<string>;
    /** Missed by the scan (with `complete` false: a scan cut short). */
    hidden: Set<string>;
    complete: boolean;
    /** Reading these fails. */
    failRead: Set<string>;
  } = {
    files,
    off: new Set(),
    kept: new Set(),
    hidden: new Set(),
    complete: true,
    failRead: new Set(),
    edit(path, text) {
      if (text === null) delete files[path];
      else files[path] = text;
      times.set(path, clock.now);
    },
    scan: async () => ({
      files: Object.keys(files)
        .filter((p) => !p.includes(".conflict") && !port.kept.has(p) && !port.hidden.has(p))
        .sort()
        .map(entry),
      kept: [...port.kept].filter((p) => p in files),
      complete: port.complete,
    }),
    read: async (path) => {
      if (port.failRead.has(path)) throw new Error("the file is in use");
      return files[path] ?? null;
    },
    write: async (path, text) => {
      port.edit(path, text);
      return text === null ? null : entry(path);
    },
    include: (path) => !port.off.has(path.split("/")[0] ?? ""),
    now: () => clock.now,
  };
  return port;
}

test("settings: two computers converge, each keeping what only it changed", async () => {
  const account = new FakeAccount();
  const clock = { now: 100 };
  const a = settingsPort({ theme: "dark", "accounts.serverUrl": "http://a" }, clock);
  const b = settingsPort({ fontSize: 14 }, clock);
  const engineA = new SyncEngine(account.backend(), memoryStore(), [settingsLayer(a)]);
  const engineB = new SyncEngine(account.backend(), memoryStore(), [settingsLayer(b)]);
  await engineA.tick();
  await engineB.tick();
  await engineA.tick();
  assert.deepEqual(
    { ...a.values },
    { theme: "dark", fontSize: 14, "accounts.serverUrl": "http://a" },
  );
  assert.deepEqual({ ...b.values }, { fontSize: 14, theme: "dark" });

  // Each changes a different setting.
  clock.now = 200;
  a.values.theme = "light";
  a.mtimeMs = 200;
  b.values.fontSize = 16;
  b.mtimeMs = 200;
  await engineA.tick();
  await engineB.tick();
  await engineA.tick();
  assert.equal(a.values.fontSize, 16);
  assert.equal(b.values.theme, "light");

  // Both change the same one: the later change wins everywhere.
  a.values.tabSize = 2;
  a.mtimeMs = 300;
  b.values.tabSize = 8;
  b.mtimeMs = 310;
  await engineA.tick();
  await engineB.tick();
  await engineA.tick();
  assert.equal(a.values.tabSize, 8);
  assert.equal(b.values.tabSize, 8);

  // Removed on one, removed on the other.
  delete b.values.theme;
  b.mtimeMs = 400;
  await engineB.tick();
  await engineA.tick();
  assert.equal("theme" in a.values, false);
  const writes = account.seq;
  await engineA.tick();
  await engineB.tick();
  assert.equal(account.seq, writes, "nothing changed: nothing written");
});

test("settings: a write that loses the race is merged at the next pass", async () => {
  const account = new FakeAccount();
  const clock = { now: 100 };
  const a = settingsPort({ a: 1 }, clock);
  const engineA = new SyncEngine(account.backend(), memoryStore(), [settingsLayer(a)]);
  // Someone writes between this computer's read and its write.
  const backend = account.backend();
  let raced = false;
  const racing: SyncBackend = {
    changes: backend.changes,
    put: async (collection, id, expect, text) => {
      if (!raced) {
        raced = true;
        account.put("settings", "user", null, JSON.stringify({ keys: { b: { v: 2, t: 50 } } }));
      }
      return backend.put(collection, id, expect, text);
    },
  };
  const engine = new SyncEngine(racing, memoryStore(), [settingsLayer(a)]);
  await engine.tick();
  assert.deepEqual({ ...a.values }, { a: 1 }, "nothing applied from a write it never saw");
  await engine.tick();
  assert.deepEqual({ ...a.values }, { a: 1, b: 2 });
  const record = JSON.parse(account.records.get("settings/user")?.text ?? "{}");
  assert.deepEqual(Object.keys(record.keys).sort(), ["a", "b"]);
  void engineA;
});

test("files: created, changed, deleted and in conflict", async () => {
  const account = new FakeAccount();
  const clock = { now: 100 };
  const a = filesPort({ "keybindings.json": "[1]", "snippets/go.json": "{}" }, clock);
  const b = filesPort({}, clock);
  const engineA = new SyncEngine(account.backend(), memoryStore(), [filesLayer(a)]);
  const engineB = new SyncEngine(account.backend(), memoryStore(), [filesLayer(b)]);
  const both = async () => {
    await engineA.tick();
    await engineB.tick();
    await engineA.tick();
  };
  await both();
  assert.deepEqual({ ...b.files }, { "keybindings.json": "[1]", "snippets/go.json": "{}" });

  clock.now = 200;
  b.edit("snippets/go.json", '{"x":1}');
  b.edit("skills/review/SKILL.md", "# Review");
  a.edit("keybindings.json", null);
  await both();
  assert.deepEqual(
    { ...a.files },
    {
      "snippets/go.json": '{"x":1}',
      "skills/review/SKILL.md": "# Review",
    },
  );
  assert.deepEqual({ ...b.files }, a.files);

  // Both change the same file: the later change is the file, the other is kept beside it.
  clock.now = 300;
  a.edit("skills/review/SKILL.md", "# A's");
  clock.now = 310;
  b.edit("skills/review/SKILL.md", "# B's");
  await both();
  await engineB.tick();
  assert.equal(a.files["skills/review/SKILL.md"], "# B's");
  assert.equal(b.files["skills/review/SKILL.md"], "# B's");
  // B saw both versions: it keeps the one that lost beside the file.
  assert.equal(b.files["skills/review/SKILL.conflict.md"], "# A's", "the loser is kept");
  assert.equal(a.files["skills/review/SKILL.conflict.md"], undefined, "and isn't synced");

  // A deleted file made again comes back everywhere.
  clock.now = 400;
  b.edit("keybindings.json", "[2]");
  await both();
  assert.equal(a.files["keybindings.json"], "[2]");

  const writes = account.seq;
  await both();
  assert.equal(account.seq, writes, "settled: nothing written");
});

test("files: a kind switched off stays on this computer, and catches up when switched on", async () => {
  const account = new FakeAccount();
  const clock = { now: 100 };
  const a = filesPort({ "snippets/go.json": "{}" }, clock);
  const b = filesPort({}, clock);
  b.off.add("snippets");
  const engineA = new SyncEngine(account.backend(), memoryStore(), [filesLayer(a)]);
  const engineB = new SyncEngine(account.backend(), memoryStore(), [filesLayer(b)]);
  await engineA.tick();
  await engineB.tick();
  assert.deepEqual({ ...b.files }, {});
  b.off.clear();
  await engineB.tick();
  assert.deepEqual({ ...b.files }, { "snippets/go.json": "{}" });
});

/** A computer's chats, with the transfer done by copying between computers through the account. */
function chatsPort(name: string, account: FakeAccount, contents: Map<string, string>) {
  const chats = new Map<string, { workspace: string | null; text: string; updated: number }>();
  let copies = 0;
  const stampOf = (c: { text: string; updated: number }) =>
    `${c.text.length}:${c.updated}:${c.text}`;
  const port: ChatsPort & {
    chats: typeof chats;
    projects: Map<string, string>;
    busyIds: Set<string>;
    /** Chats this computer noted as deleted. */
    deletedIds: Set<string>;
    /** Uploads of these fail. */
    failPush: Set<string>;
    /** Uploads of these never come back. */
    hangPush: Set<string>;
    /** How often each chat was uploaded. */
    pushes: Map<string, number>;
    /** Runs right before a fetch lands (a chat saved meanwhile). */
    beforePull: (() => void) | null;
    /** What every upload fails with (the account has no room), when set. */
    pushError: (() => unknown) | null;
  } = {
    pushError: null,
    chats,
    /** Folder to collection for the projects that sync here. */
    projects: new Map(),
    busyIds: new Set(),
    deletedIds: new Set(),
    failPush: new Set(),
    hangPush: new Set(),
    pushes: new Map(),
    beforePull: null,
    deleted: async () => [...port.deletedIds],
    clearDeleted: async (ids) => {
      for (const id of ids) port.deletedIds.delete(id);
    },
    same: async (collection, id) => {
      const record = account.records.get(`${collection}/${id}`);
      const chat = chats.get(id);
      if (!record || record.deleted || !chat) return false;
      return contents.get(`${collection}/${id}@${record.version}`) === chat.text;
    },
    list: async (): Promise<LocalChat[]> =>
      [...chats].map(([id, c]) => ({
        id,
        workspace: c.workspace,
        stamp: `${c.text.length}:${c.updated}:${c.text}`,
        updated: c.updated,
      })),
    collectionOf: (workspace) =>
      workspace === null ? "chats.account" : (port.projects.get(workspace) ?? null),
    folderOf: (collection) => {
      if (collection === "chats.account") return null;
      for (const [folder, c] of port.projects) if (c === collection) return folder;
      return undefined;
    },
    push: async (collection, id, expect) => {
      const chat = chats.get(id);
      if (!chat) return null;
      port.pushes.set(id, (port.pushes.get(id) ?? 0) + 1);
      if (port.hangPush.has(id)) return new Promise<never>(() => {});
      if (port.failPush.has(id)) throw new Error("the upload failed");
      if (port.pushError) throw port.pushError();
      const result = account.put(
        collection,
        id,
        expect,
        JSON.stringify({ meta: { updated: chat.updated } }),
      );
      if (result.outcome === "done")
        contents.set(`${collection}/${id}@${result.version}`, chat.text);
      return result;
    },
    pull: async (collection, id, saveAs, workspace, ifStamp) => {
      const record = account.records.get(`${collection}/${id}`);
      if (!record || record.deleted) return null;
      port.beforePull?.();
      const now = chats.get(saveAs);
      if ((now ? stampOf(now) : null) !== ifStamp) return null;
      const text = contents.get(`${collection}/${id}@${record.version}`) ?? "";
      const updated = (JSON.parse(record.text ?? "{}") as { meta: { updated: number } }).meta
        .updated;
      chats.set(saveAs, { workspace, text, updated });
      return record.version;
    },
    remove: async (id) => {
      chats.delete(id);
    },
    stamp: async (id) => {
      const c = chats.get(id);
      return c ? `${c.text.length}:${c.updated}:${c.text}` : null;
    },
    newId: () => `${name}-copy-${++copies}`,
    busy: (id) => port.busyIds.has(id),
  };
  return port;
}

test("chats: a project's chats appear on the other computer, in its folder", async () => {
  const account = new FakeAccount();
  const contents = new Map<string, string>();
  const a = chatsPort("a", account, contents);
  const b = chatsPort("b", account, contents);
  a.projects.set("C:\\work\\app", "chats.p1");
  b.projects.set("/home/me/app", "chats.p1");
  a.chats.set("c1", { workspace: "C:\\work\\app", text: "hello", updated: 10 });
  a.chats.set("free", { workspace: null, text: "no folder", updated: 11 });
  a.chats.set("other", { workspace: "C:\\work\\unsynced", text: "stays", updated: 12 });
  const engineA = new SyncEngine(account.backend(), memoryStore(), [chatsLayer(a)]);
  const engineB = new SyncEngine(account.backend(), memoryStore(), [chatsLayer(b)]);
  await engineA.tick();
  await engineB.tick();
  assert.deepEqual(b.chats.get("c1"), { workspace: "/home/me/app", text: "hello", updated: 10 });
  assert.deepEqual(b.chats.get("free"), { workspace: null, text: "no folder", updated: 11 });
  assert.equal(b.chats.has("other"), false, "a project that doesn't sync stays put");
  assert.equal(account.records.has("chats.p1/other"), false);

  // Continued on B, then read on A.
  b.chats.set("c1", { workspace: "/home/me/app", text: "hello, more", updated: 20 });
  await engineB.tick();
  await engineA.tick();
  assert.equal(a.chats.get("c1")?.text, "hello, more");
  assert.equal(a.chats.get("c1")?.workspace, "C:\\work\\app");

  // Deleted on A: gone on B.
  a.chats.delete("free");
  a.deletedIds.add("free");
  await engineA.tick();
  await engineB.tick();
  assert.equal(b.chats.has("free"), false);
  const writes = account.seq;
  await engineA.tick();
  await engineB.tick();
  assert.equal(account.seq, writes, "settled");
});

test("chats: a project deleted from the account and stopped here isn't uploaded again", async () => {
  const account = new FakeAccount();
  const contents = new Map<string, string>();
  const a = chatsPort("a", account, contents);
  a.projects.set("C:workapp", "chats.p1");
  a.chats.set("c1", { workspace: "C:workapp", text: "hello", updated: 10 });
  const engineA = new SyncEngine(account.backend(), memoryStore(), [chatsLayer(a)]);
  await engineA.tick();
  assert.equal(account.records.get("chats.p1/c1")?.deleted, false);
  // The folder stops syncing from here, then the project is deleted from the account (the
  // record is removed as a record, not as a deleted chat).
  a.projects.clear();
  account.put("chats.p1", "c1", account.records.get("chats.p1/c1")?.version ?? null, null);
  const pushes = a.pushes.get("c1");
  await engineA.tick();
  await engineA.tick();
  assert.equal(a.pushes.get("c1"), pushes, "not sent again");
  assert.equal(account.records.get("chats.p1/c1")?.deleted, true);
  assert.equal(a.chats.get("c1")?.text, "hello", "the chat here stays");
  // Synced again from here: it is uploaded afresh.
  a.projects.set("C:workapp", "chats.p1");
  await engineA.tick();
  assert.equal(account.records.get("chats.p1/c1")?.deleted, false);
});

test("chats: changed on both computers, nothing is lost", async () => {
  const account = new FakeAccount();
  const contents = new Map<string, string>();
  const a = chatsPort("a", account, contents);
  const b = chatsPort("b", account, contents);
  a.chats.set("c1", { workspace: null, text: "start", updated: 10 });
  const engineA = new SyncEngine(account.backend(), memoryStore(), [chatsLayer(a)]);
  const engineB = new SyncEngine(account.backend(), memoryStore(), [chatsLayer(b)]);
  await engineA.tick();
  await engineB.tick();
  a.chats.set("c1", { workspace: null, text: "start + A", updated: 20 });
  b.chats.set("c1", { workspace: null, text: "start + B", updated: 21 });
  await engineA.tick();
  await engineB.tick(); // sees A's version and its own change: forks
  await engineA.tick();
  await engineB.tick();
  await engineA.tick();
  const texts = (port: typeof a) => [...port.chats.values()].map((c) => c.text).sort();
  assert.deepEqual(texts(b), ["start + A", "start + B"]);
  assert.deepEqual(texts(a), ["start + A", "start + B"]);
  assert.equal(b.chats.get("c1")?.text, "start + B", "this computer's keeps the chat");
});

test("chats: one being written is left for the next pass; a project not here stays in the account", async () => {
  const account = new FakeAccount();
  const contents = new Map<string, string>();
  const a = chatsPort("a", account, contents);
  const b = chatsPort("b", account, contents);
  a.projects.set("/a/app", "chats.p1");
  a.chats.set("c1", { workspace: "/a/app", text: "x", updated: 1 });
  a.busyIds.add("c1");
  const engineA = new SyncEngine(account.backend(), memoryStore(), [chatsLayer(a)]);
  const engineB = new SyncEngine(account.backend(), memoryStore(), [chatsLayer(b)]);
  await engineA.tick();
  assert.equal(account.records.size, 0);
  a.busyIds.clear();
  await engineA.tick();
  assert.equal(account.records.size, 1);
  await engineB.tick();
  assert.equal(b.chats.size, 0, "the project isn't on B");
  // The project arrives on B later.
  b.projects.set("/b/app", "chats.p1");
  await engineB.tick();
  assert.equal(b.chats.get("c1")?.workspace, "/b/app");
});

test("engine: a reset account starts every layer afresh, and what is here is sent again", async () => {
  const account = new FakeAccount();
  const clock = { now: 100 };
  const a = filesPort({ "AGENTS.md": "rules" }, clock);
  const store = memoryStore();
  const engine = new SyncEngine(account.backend(), store, [filesLayer(a)]);
  await engine.tick();
  assert.equal(account.records.size, 1);
  account.reset();
  await engine.tick();
  assert.equal(account.records.size, 1, "uploaded again");
  assert.equal(a.files["AGENTS.md"], "rules", "and not deleted here");
  // A new engine with the same store (the app restarted) settles without writing.
  const again = new SyncEngine(account.backend(), store, [filesLayer(a)]);
  const writes = account.seq;
  await again.tick();
  assert.equal(account.seq, writes);
});

test("engine: a layer that fails doesn't stop the others, and the pass reports it", async () => {
  const account = new FakeAccount();
  const clock = { now: 100 };
  const a = filesPort({ "AGENTS.md": "rules" }, clock);
  const engine = new SyncEngine(account.backend(), memoryStore(), [
    {
      name: "broken",
      run: async () => {
        throw new Error("boom");
      },
    },
    filesLayer(a),
  ]);
  await assert.rejects(engine.tick(), /boom/);
  assert.equal(account.records.size, 1);
});

// ---------------------------------------------------------------- nothing is deleted on absence

test("settings: a settings file that is missing removes nothing from the account", async () => {
  const account = new FakeAccount();
  const clock = { now: 100 };
  const a = settingsPort({ theme: "dark", fontSize: 14 }, clock);
  const b = settingsPort({}, clock);
  const engineA = new SyncEngine(account.backend(), memoryStore(), [settingsLayer(a)]);
  const engineB = new SyncEngine(account.backend(), memoryStore(), [settingsLayer(b)]);
  await engineA.tick();
  await engineB.tick();
  assert.deepEqual({ ...b.values }, { theme: "dark", fontSize: 14 });

  // B's settings file is gone (a new profile, a restore that missed it).
  b.values = {};
  b.missing = true;
  clock.now = 200;
  b.mtimeMs = 0;
  const writes = account.seq;
  await engineB.tick();
  assert.equal(account.seq, writes, "nothing told to the account");
  const record = JSON.parse(account.records.get("settings/user")?.text ?? "{}");
  assert.equal(record.keys.theme.d, undefined);
  assert.deepEqual({ ...b.values }, { theme: "dark", fontSize: 14 }, "the account's apply");
  await engineA.tick();
  assert.deepEqual({ ...a.values }, { theme: "dark", fontSize: 14 }, "and A keeps its settings");

  // With the file there, removing a key still travels.
  b.missing = false;
  b.mtimeMs = 300;
  await engineB.tick();
  delete b.values.theme;
  b.mtimeMs = 400;
  await engineB.tick();
  await engineA.tick();
  assert.equal("theme" in a.values, false);
});

test("files: a file the scan couldn't take, or a scan cut short, deletes nothing", async () => {
  const account = new FakeAccount();
  const clock = { now: 100 };
  const a = filesPort({ "keybindings.json": "[1]", "snippets/go.json": "{}" }, clock);
  const b = filesPort({}, clock);
  const engineA = new SyncEngine(account.backend(), memoryStore(), [filesLayer(a)]);
  const engineB = new SyncEngine(account.backend(), memoryStore(), [filesLayer(b)]);
  await engineA.tick();
  await engineB.tick();

  // A's snippets file is there but can't be read as it is: named as kept, not listed.
  a.kept.add("snippets/go.json");
  clock.now = 200;
  b.edit("snippets/go.json", '{"b":1}');
  await engineA.tick();
  await engineB.tick();
  await engineA.tick();
  assert.equal(b.files["snippets/go.json"], '{"b":1}', "not deleted on B");
  assert.equal(a.files["snippets/go.json"], "{}", "and not written over on A while it is kept");
  assert.equal(
    JSON.parse(account.records.get("files/snippets__go.json")?.text ?? "{}").deleted,
    undefined,
  );
  a.kept.clear();
  await engineA.tick();
  assert.equal(a.files["snippets/go.json"], '{"b":1}', "caught up once it can sync again");

  // A scan cut short misses a file: neither side deletes on that pass.
  a.hidden.add("keybindings.json");
  a.complete = false;
  await engineA.tick();
  await engineB.tick();
  assert.equal(b.files["keybindings.json"], "[1]");
  // And what the account says is deleted isn't removed here on a partial scan either.
  b.edit("snippets/go.json", null);
  await engineB.tick();
  await engineA.tick();
  assert.equal(a.files["snippets/go.json"], '{"b":1}', "waits for a whole scan");
  a.hidden.clear();
  a.complete = true;
  await engineA.tick();
  assert.equal("snippets/go.json" in a.files, false, "a whole scan: the deletion applies");
  assert.equal(a.files["keybindings.json"], "[1]");
});

test("files: one file that fails doesn't hold up the others, and is reported", async () => {
  const account = new FakeAccount();
  const clock = { now: 100 };
  const a = filesPort({ "agents/a.md": "A", "agents/b.md": "B", "agents/c.md": "C" }, clock);
  a.failRead.add("agents/b.md");
  const notes: SyncNote[] = [];
  const engine = new SyncEngine(account.backend(), memoryStore(), [filesLayer(a)], {
    note: (event) => notes.push(event),
  });
  await engine.tick();
  assert.deepEqual([...account.records.keys()].sort(), [
    "files/agents__a.md",
    "files/agents__c.md",
  ]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.kind, "failure");
  assert.match(notes[0]?.text ?? "", /^agents\/b\.md couldn't sync: /);
  a.failRead.clear();
  await engine.tick();
  assert.equal(account.records.size, 3);
});

test("files: a conflict is reported with the name of the copy kept", async () => {
  const account = new FakeAccount();
  const clock = { now: 100 };
  const a = filesPort({ "AGENTS.md": "one" }, clock);
  const b = filesPort({}, clock);
  const notes: SyncNote[] = [];
  const engineA = new SyncEngine(account.backend(), memoryStore(), [filesLayer(a)]);
  const engineB = new SyncEngine(account.backend(), memoryStore(), [filesLayer(b)], {
    note: (event) => notes.push(event),
  });
  await engineA.tick();
  await engineB.tick();
  clock.now = 200;
  a.edit("AGENTS.md", "A's");
  clock.now = 210;
  b.edit("AGENTS.md", "B's");
  await engineA.tick();
  await engineB.tick();
  assert.equal(b.files["AGENTS.conflict.md"], "A's");
  assert.deepEqual(
    notes.map((n) => n.kind),
    ["conflict"],
  );
  assert.match(notes[0]?.text ?? "", /AGENTS\.md .* AGENTS\.conflict\.md/);
});

test("chats: a chat missing from the list is not deleted from the account", async () => {
  const account = new FakeAccount();
  const contents = new Map<string, string>();
  const a = chatsPort("a", account, contents);
  const b = chatsPort("b", account, contents);
  a.chats.set("c1", { workspace: null, text: "one", updated: 10 });
  a.chats.set("c2", { workspace: null, text: "two", updated: 11 });
  const engineA = new SyncEngine(account.backend(), memoryStore(), [chatsLayer(a)]);
  const engineB = new SyncEngine(account.backend(), memoryStore(), [chatsLayer(b)]);
  await engineA.tick();
  await engineB.tick();
  assert.equal(b.chats.size, 2);

  // A's list comes back empty (the store couldn't be read, chats were switched off and on).
  const kept = new Map(a.chats);
  a.chats.clear();
  const writes = account.seq;
  await engineA.tick();
  await engineA.tick();
  assert.equal(account.seq, writes, "nothing written: no deletion markers");
  await engineB.tick();
  assert.equal(b.chats.size, 2, "B keeps both");
  // The chats are back on A: nothing to do, nothing lost.
  for (const [id, chat] of kept) a.chats.set(id, chat);
  await engineA.tick();
  assert.equal(account.seq, writes);

  // Deleted for real: this computer says so, and only then the account is told.
  a.chats.delete("c1");
  a.deletedIds.add("c1");
  await engineA.tick();
  assert.equal(JSON.parse(account.records.get("chats.account/c1")?.text ?? "{}").deleted, true);
  assert.equal(a.deletedIds.size, 0, "forgotten once the account knows");
  await engineB.tick();
  assert.deepEqual([...b.chats.keys()], ["c2"]);

  // A deletion of a chat the account never had is just forgotten.
  a.deletedIds.add("never-synced");
  await engineA.tick();
  assert.equal(a.deletedIds.size, 0);
});

test("chats: a deleted chat that was continued elsewhere comes back instead", async () => {
  const account = new FakeAccount();
  const contents = new Map<string, string>();
  const a = chatsPort("a", account, contents);
  const b = chatsPort("b", account, contents);
  a.chats.set("c1", { workspace: null, text: "one", updated: 10 });
  const engineA = new SyncEngine(account.backend(), memoryStore(), [chatsLayer(a)]);
  const engineB = new SyncEngine(account.backend(), memoryStore(), [chatsLayer(b)]);
  await engineA.tick();
  await engineB.tick();
  b.chats.set("c1", { workspace: null, text: "one, and more", updated: 20 });
  await engineB.tick();
  a.chats.delete("c1");
  a.deletedIds.add("c1");
  await engineA.tick();
  assert.equal(a.chats.get("c1")?.text, "one, and more", "a delete never beats a change");
  assert.equal(a.deletedIds.size, 0);
  assert.equal(
    JSON.parse(account.records.get("chats.account/c1")?.text ?? "{}").deleted,
    undefined,
  );
});

test("chats: a conflict forks once, however often the upload after it fails", async () => {
  const account = new FakeAccount();
  const contents = new Map<string, string>();
  const a = chatsPort("a", account, contents);
  const b = chatsPort("b", account, contents);
  a.chats.set("c1", { workspace: null, text: "start", updated: 10 });
  const engineA = new SyncEngine(account.backend(), memoryStore(), [chatsLayer(a)]);
  const store = memoryStore();
  const notes: SyncNote[] = [];
  const engineB = new SyncEngine(account.backend(), store, [chatsLayer(b)], {
    note: (event) => notes.push(event),
  });
  await engineA.tick();
  await engineB.tick();
  a.chats.set("c1", { workspace: null, text: "start + A", updated: 20 });
  b.chats.set("c1", { workspace: null, text: "start + B", updated: 21 });
  await engineA.tick();
  // B's upload of its own version keeps failing.
  b.failPush.add("c1");
  await engineB.tick();
  await engineB.tick();
  await engineB.tick();
  const copies = () => [...b.chats.keys()].filter((id) => id.startsWith("b-copy-"));
  assert.equal(copies().length, 1, "one copy of the other computer's version, not one per pass");
  assert.equal(notes.filter((n) => n.kind === "conflict").length, 1);
  // Also across a restart: a new engine over the same saved bases.
  const again = new SyncEngine(account.backend(), store, [chatsLayer(b)]);
  await again.tick();
  assert.equal(copies().length, 1);
  b.failPush.clear();
  await again.tick();
  await engineA.tick();
  assert.equal(copies().length, 1);
  assert.equal(a.chats.get("c1")?.text, "start + B");
  const texts = (port: typeof a) => [...port.chats.values()].map((c) => c.text).sort();
  assert.deepEqual(texts(a), ["start + A", "start + B"]);
});

test("chats: the same chat on two computers that never synced it is one chat", async () => {
  const account = new FakeAccount();
  const contents = new Map<string, string>();
  const a = chatsPort("a", account, contents);
  const b = chatsPort("b", account, contents);
  // Both have the chat already (copied over by hand, or the bases were lost).
  a.chats.set("c1", { workspace: null, text: "same", updated: 10 });
  b.chats.set("c1", { workspace: null, text: "same", updated: 10 });
  // Both read the account before either wrote: each thinks the chat is new.
  let engineB: SyncEngine | null = null;
  let raced = false;
  const backendA = account.backend();
  const engineA = new SyncEngine(
    {
      changes: async (since) => {
        const page = await backendA.changes(since);
        if (!raced) {
          raced = true;
          // B's whole pass happens between A's read and A's push.
          await engineB?.tick();
        }
        return page;
      },
      put: backendA.put,
    },
    memoryStore(),
    [chatsLayer(a)],
  );
  engineB = new SyncEngine(account.backend(), memoryStore(), [chatsLayer(b)]);
  await engineA.tick(); // loses the race: the account has B's
  await engineA.tick();
  await engineB.tick();
  await engineA.tick();
  assert.deepEqual([...a.chats.keys()], ["c1"]);
  assert.deepEqual([...b.chats.keys()], ["c1"]);
  assert.equal(account.records.size, 1);
  const writes = account.seq;
  await engineA.tick();
  await engineB.tick();
  assert.equal(account.seq, writes, "settled");
});

test("chats: a chat saved while it was being fetched isn't written over", async () => {
  const account = new FakeAccount();
  const contents = new Map<string, string>();
  const a = chatsPort("a", account, contents);
  const b = chatsPort("b", account, contents);
  a.chats.set("c1", { workspace: null, text: "one", updated: 10 });
  const engineA = new SyncEngine(account.backend(), memoryStore(), [chatsLayer(a)]);
  const engineB = new SyncEngine(account.backend(), memoryStore(), [chatsLayer(b)]);
  await engineA.tick();
  await engineB.tick();
  a.chats.set("c1", { workspace: null, text: "one, from A", updated: 20 });
  await engineA.tick();
  // B's chat is saved after the pass listed it and before the fetch lands.
  b.beforePull = () => {
    b.chats.set("c1", { workspace: null, text: "one, typed on B just now", updated: 30 });
    b.beforePull = null;
  };
  await engineB.tick();
  assert.equal(b.chats.get("c1")?.text, "one, typed on B just now", "kept");
  // The next pass sees both changed, and nothing is lost.
  await engineB.tick();
  const texts = [...b.chats.values()].map((c) => c.text).sort();
  assert.deepEqual(texts, ["one, from A", "one, typed on B just now"]);
});

test("engine: a window closed in the middle of a pass doesn't send its chats again", async () => {
  const account = new FakeAccount();
  const contents = new Map<string, string>();
  const a = chatsPort("a", account, contents);
  a.chats.set("c1", { workspace: null, text: "one", updated: 10 });
  a.chats.set("c2", { workspace: null, text: "two", updated: 11 });
  const store = memoryStore();
  // The second chat's upload never comes back: the pass never reaches its end.
  a.hangPush.add("c2");
  const first = new SyncEngine(account.backend(), store, [chatsLayer(a)]);
  void first.tick();
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(a.pushes.get("c1"), 1);
  assert.notEqual(store.text, null, "the first chat's transfer was saved when it was done");

  // The app starts again: a new engine over what was saved.
  a.hangPush.clear();
  const second = new SyncEngine(account.backend(), store, [chatsLayer(a)]);
  await second.tick();
  assert.equal(a.pushes.get("c1"), 1, "not sent again");
  assert.equal(a.pushes.get("c2"), 2);
  assert.equal(account.records.size, 2);
});

test("engine: a record this computer can't read yet stops the reading, and isn't written over", async () => {
  const account = new FakeAccount();
  const clock = { now: 100 };
  const a = filesPort({ "AGENTS.md": "A's rules" }, clock);
  const b = filesPort({}, clock);
  const engineA = new SyncEngine(account.backend(), memoryStore(), [filesLayer(a)]);
  const engineB = new SyncEngine(account.backend(), memoryStore(), [filesLayer(b)]);
  await engineA.tick();
  await engineB.tick();
  assert.equal(engineB.blocked, false);

  // A writes with new keys B doesn't hold yet; a later record is readable.
  clock.now = 200;
  a.edit("AGENTS.md", "A's new rules");
  a.edit("snippets/go.json", "{}");
  await engineA.tick();
  account.sealed.add("files/AGENTS.md");
  // B changed the same file meanwhile: it must not replace what it can't read.
  clock.now = 210;
  b.edit("AGENTS.md", "B's rules");
  const writes = account.seq;
  await engineB.tick();
  await engineB.tick();
  assert.equal(engineB.blocked, true);
  assert.equal(account.seq, writes, "nothing written while the account can't be read whole");
  assert.equal("snippets/go.json" in b.files, false, "nothing past the unreadable record yet");
  assert.equal(b.files["AGENTS.md"], "B's rules");

  // The keys arrive: the record is read at last, and the two changes meet as a conflict.
  account.sealed.clear();
  await engineB.tick();
  assert.equal(engineB.blocked, false);
  assert.equal(b.files["snippets/go.json"], "{}");
  assert.equal(b.files["AGENTS.md"], "B's rules", "the later change is the file");
  assert.equal(b.files["AGENTS.conflict.md"], "A's new rules", "and A's is kept beside it");
});

// ---------------------------------------------------------------- settings: whose change is later

const offlineError = () => Object.assign(new Error("No connection."), { code: "SyncOffline" });

test("settings: an old change here doesn't win because the file was rewritten since", async () => {
  const account = new FakeAccount();
  const clock = { now: 100 };
  const a = settingsPort({ tabSize: 4 }, clock);
  const b = settingsPort({}, clock);
  const inner = account.backend();
  let offline = false;
  const engineA = new SyncEngine(account.backend(), memoryStore(), [settingsLayer(a)]);
  const engineB = new SyncEngine(
    {
      changes: async (since) => {
        if (offline) throw offlineError();
        return inner.changes(since);
      },
      put: inner.put,
    },
    memoryStore(),
    [settingsLayer(b)],
  );
  await engineA.tick();
  await engineB.tick();
  assert.equal(b.values.tabSize, 4);

  // B, offline, changes the setting at 200: the pass fails, and still notes when.
  offline = true;
  b.values.tabSize = 2;
  b.mtimeMs = 200;
  await assert.rejects(engineB.tick(), /No connection/);
  // A changes it later, at 300.
  a.values.tabSize = 8;
  a.mtimeMs = 300;
  await engineA.tick();
  // B's settings file is written again at 400 for a reason of the app's own.
  b.mtimeMs = 400;
  await assert.rejects(engineB.tick(), /No connection/);
  offline = false;
  await engineB.tick();
  assert.equal(b.values.tabSize, 8, "A's later change stands");
  await engineA.tick();
  assert.equal(a.values.tabSize, 8);

  // And a change here that is the later one still wins, with its own date.
  b.values.tabSize = 3;
  b.mtimeMs = 500;
  a.values.tabSize = 9;
  a.mtimeMs = 450;
  await engineA.tick();
  await engineB.tick();
  await engineA.tick();
  assert.equal(a.values.tabSize, 3);
  const record = JSON.parse(account.records.get("settings/user")?.text ?? "{}");
  assert.equal(record.keys.tabSize.t, 500);
});

test("settings: a computer that joins takes the account's values where they differ, and says so", async () => {
  const account = new FakeAccount();
  const clock = { now: 100 };
  const a = settingsPort({ theme: "dark", tabSize: 4 }, clock);
  const engineA = new SyncEngine(account.backend(), memoryStore(), [settingsLayer(a)]);
  await engineA.tick();
  // B's file is the newer one, which says nothing about which value is newer.
  clock.now = 900;
  const b = settingsPort({ theme: "light", tabSize: 4, own: 1 }, clock);
  const notes: SyncNote[] = [];
  const engineB = new SyncEngine(account.backend(), memoryStore(), [settingsLayer(b)], {
    note: (event) => notes.push(event),
  });
  await engineB.tick();
  assert.deepEqual({ ...b.values }, { theme: "dark", tabSize: 4, own: 1 });
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.kind, "conflict");
  assert.match(notes[0]?.text ?? "", /the account's were kept: theme \(was "light"\)\.$/);
  await engineA.tick();
  assert.deepEqual({ ...a.values }, { theme: "dark", tabSize: 4, own: 1 });
  // From here on B remembers its sync: its own changes win as any computer's do.
  b.values.theme = "solarized";
  b.mtimeMs = 950;
  await engineB.tick();
  await engineA.tick();
  assert.equal(a.values.theme, "solarized");
  assert.equal(notes.length, 1, "said once");
});

test("settings: a computer that lost what it kept doesn't bring back a setting removed elsewhere", async () => {
  const account = new FakeAccount();
  const clock = { now: 100 };
  const a = settingsPort({ old: "x", keep: 1 }, clock);
  const b = settingsPort({}, clock);
  const engineA = new SyncEngine(account.backend(), memoryStore(), [settingsLayer(a)]);
  await engineA.tick();
  await new SyncEngine(account.backend(), memoryStore(), [settingsLayer(b)]).tick();
  assert.deepEqual({ ...b.values }, { old: "x", keep: 1 });
  delete a.values.old;
  a.mtimeMs = 200;
  await engineA.tick();
  // B starts again with nothing kept (its state file is gone) and a newer settings file.
  b.mtimeMs = 900;
  const notes: SyncNote[] = [];
  const again = new SyncEngine(account.backend(), memoryStore(), [settingsLayer(b)], {
    note: (event) => notes.push(event),
  });
  const writes = account.seq;
  await again.tick();
  assert.deepEqual({ ...b.values }, { keep: 1 });
  assert.equal(account.seq, writes, "nothing told to the account");
  assert.match(notes[0]?.text ?? "", /old \(was "x"\)/);
  await engineA.tick();
  assert.equal("old" in a.values, false, "and it stays removed on A");
});

// ---------------------------------------------------------------- files: conflict copies

test("files: a second conflict keeps the first copy", async () => {
  const account = new FakeAccount();
  const clock = { now: 100 };
  const a = filesPort({ "AGENTS.md": "one" }, clock);
  const b = filesPort({}, clock);
  const notes: SyncNote[] = [];
  const engineA = new SyncEngine(account.backend(), memoryStore(), [filesLayer(a)]);
  const engineB = new SyncEngine(account.backend(), memoryStore(), [filesLayer(b)], {
    note: (event) => notes.push(event),
  });
  await engineA.tick();
  await engineB.tick();
  const clash = async (at: number, mine: string, theirs: string) => {
    clock.now = at;
    a.edit("AGENTS.md", theirs);
    clock.now = at + 10;
    b.edit("AGENTS.md", mine);
    await engineA.tick();
    await engineB.tick();
    await engineA.tick();
  };
  await clash(200, "B's first", "A's first");
  await clash(300, "B's second", "A's second");
  await clash(400, "B's third", "A's third");
  assert.equal(b.files["AGENTS.conflict.md"], "A's first", "not written over");
  assert.equal(b.files["AGENTS.conflict-2.md"], "A's second");
  assert.equal(b.files["AGENTS.conflict-3.md"], "A's third");
  assert.match(notes[1]?.text ?? "", /kept as AGENTS\.conflict-2\.md\.$/);
  // The copies stay on the computer that made them.
  assert.deepEqual(Object.keys(a.files), ["AGENTS.md"]);
  assert.deepEqual([...account.records.keys()], ["files/AGENTS.md"]);
  // The same losing text again takes no new name.
  clock.now = 500;
  a.edit("AGENTS.md", "A's first");
  clock.now = 510;
  b.edit("AGENTS.md", "B's fourth");
  await engineA.tick();
  await engineB.tick();
  assert.equal(b.files["AGENTS.conflict-4.md"], undefined);
  assert.match(notes[3]?.text ?? "", /kept as AGENTS\.conflict\.md\.$/);
});

test("files: a conflict copy the scan or the account lists is never synced", async () => {
  const account = new FakeAccount();
  const clock = { now: 100 };
  const a = filesPort({ "snippets/go.json": "{}" }, clock);
  const b = filesPort({}, clock);
  // A scan that doesn't know the numbered names lists them as files.
  const scan = a.scan;
  a.scan = async () => {
    const found = await scan();
    const extra = Object.keys(a.files)
      .filter((p) => p.includes(".conflict"))
      .map((path) => ({ path, hash: hashOf(a.files[path] ?? ""), mtimeMs: 1 }));
    return { ...found, files: [...found.files, ...extra] };
  };
  a.files["snippets/go.conflict-2.json"] = "{ old }";
  a.files["snippets/go.conflict.json"] = "{ older }";
  await new SyncEngine(account.backend(), memoryStore(), [filesLayer(a)]).tick();
  assert.deepEqual([...account.records.keys()], ["files/snippets__go.json"]);
  // One that reached the account anyway (an older build) isn't fetched.
  account.put(
    "files",
    "snippets__go.conflict-3.json",
    null,
    JSON.stringify({ path: "snippets/go.conflict-3.json", text: "x", hash: "h", mtimeMs: 1 }),
  );
  await new SyncEngine(account.backend(), memoryStore(), [filesLayer(b)]).tick();
  assert.deepEqual(Object.keys(b.files), ["snippets/go.json"]);
});

test("files: where only the first conflict name can be written, the copy goes there", async () => {
  const account = new FakeAccount();
  const clock = { now: 100 };
  const a = filesPort({ "AGENTS.md": "one" }, clock);
  const b = filesPort({}, clock);
  const read = b.read;
  b.read = async (path) => {
    if (/\.conflict-\d+/.test(path)) throw new Error(`not a synced file: ${path}`);
    return read(path);
  };
  const engineA = new SyncEngine(account.backend(), memoryStore(), [filesLayer(a)]);
  const engineB = new SyncEngine(account.backend(), memoryStore(), [filesLayer(b)]);
  await engineA.tick();
  await engineB.tick();
  for (const [at, text] of [
    [200, "first"],
    [300, "second"],
  ] as const) {
    clock.now = at;
    a.edit("AGENTS.md", `A's ${text}`);
    clock.now = at + 10;
    b.edit("AGENTS.md", `B's ${text}`);
    await engineA.tick();
    await engineB.tick();
    await engineA.tick();
  }
  assert.equal(b.files["AGENTS.md"], "B's second", "the conflict still settles");
  assert.equal(b.files["AGENTS.conflict.md"], "A's second");
});

// ---------------------------------------------------------------- the engine's reading

test("engine: an answer with no epoch is not a reset: nothing is forgotten", async () => {
  const account = new FakeAccount();
  const clock = { now: 100 };
  const a = filesPort({ "AGENTS.md": "rules" }, clock);
  const store = memoryStore();
  const inner = account.backend();
  let answer: "good" | "zero" | "none" | "null" | "noRecords" | "text" = "good";
  const engine = new SyncEngine(
    {
      changes: async (since) => {
        const page = await inner.changes(since);
        const odd: Record<typeof answer, unknown> = {
          good: page,
          zero: { ...page, epoch: 0 },
          none: { seq: page.seq, gcEpoch: 0, more: false, records: [] },
          null: null,
          noRecords: { ...page, records: undefined },
          text: { ...page, epoch: "2" },
        };
        return odd[answer] as SyncChanges;
      },
      put: inner.put,
    },
    store,
    [filesLayer(a)],
  );
  await engine.tick();
  const saved = store.text;
  const writes = account.seq;
  for (const bad of ["zero", "none", "null", "noRecords", "text"] as const) {
    answer = bad;
    await assert.rejects(engine.tick(), /couldn't be read/, bad);
    assert.equal(engine.records("files").length, 1, `${bad}: what was read is kept`);
    assert.equal(store.text, saved, `${bad}: and what was kept on disk`);
  }
  answer = "good";
  await engine.tick();
  assert.equal(account.seq, writes, "nothing sent again");
  assert.equal(JSON.parse(store.text ?? "{}").epoch, 1);
  // A real reset (another epoch, a positive number) is still believed.
  account.reset();
  await engine.tick();
  assert.equal(account.records.size, 1, "uploaded again");
  assert.equal(JSON.parse(store.text ?? "{}").epoch, 2);
});

test("engine: 'more' without moving on ends the pass instead of asking for ever", async () => {
  const account = new FakeAccount();
  for (const id of ["a", "b", "c"]) account.put("notes", id, null, id);
  const inner = account.backend();
  let asked = 0;
  let stuck = true;
  const engine = new SyncEngine(
    {
      changes: async (since) => {
        asked++;
        const page = await inner.changes(since);
        // A page at a time; stuck, the same empty page with "more" every time.
        return stuck
          ? { ...page, more: true, records: [] }
          : { ...page, more: page.records.length > 1, records: page.records.slice(0, 1) };
      },
      put: inner.put,
    },
    memoryStore(),
    [],
  );
  await assert.rejects(engine.tick(), /didn't move on/);
  assert.equal(asked, 1);
  // Pages that do move on are all read.
  stuck = false;
  await engine.tick();
  assert.deepEqual(
    engine.records("notes").map((r) => r.id),
    ["a", "b", "c"],
  );
  assert.equal(asked, 4);
});

// ---------------------------------------------------------------- an account with no room

const fullError = () => Object.assign(new Error("Storage is full."), { code: "SyncFull" });

test("chats: with no room, one upload is tried a pass, nothing is said per chat, and chats still arrive", async () => {
  const account = new FakeAccount();
  const contents = new Map<string, string>();
  const a = chatsPort("a", account, contents);
  const b = chatsPort("b", account, contents);
  b.chats.set("z-from-b", { workspace: null, text: "from B", updated: 5 });
  await new SyncEngine(account.backend(), memoryStore(), [chatsLayer(b)]).tick();
  for (const id of ["c1", "c2", "c3"]) a.chats.set(id, { workspace: null, text: id, updated: 10 });
  const notes: SyncNote[] = [];
  let known = false;
  const engine = new SyncEngine(account.backend(), memoryStore(), [chatsLayer(a)], {
    note: (event) => notes.push(event),
    full: () => known,
  });
  const pushes = () => [...a.pushes.values()].reduce((sum, n) => sum + n, 0);

  a.pushError = fullError;
  await assert.rejects(engine.tick(), (err) => codeOf(err) === "SyncFull");
  assert.equal(pushes(), 1, "not one refused upload per chat");
  assert.deepEqual(notes, [], "the pass says it once, by failing with it");
  assert.equal(a.chats.get("z-from-b")?.text, "from B", "being full doesn't stop reading");

  // Known to be full (the status says so): nothing is sealed and sent at all, and the pass
  // itself goes through.
  known = true;
  await engine.tick();
  await engine.tick();
  assert.equal(pushes(), 1);
  // B's chat changes meanwhile: it still arrives.
  b.chats.set("z-from-b", { workspace: null, text: "from B, more", updated: 6 });
  await new SyncEngine(account.backend(), memoryStore(), [chatsLayer(b)]).tick();
  await engine.tick();
  assert.equal(a.chats.get("z-from-b")?.text, "from B, more");
  assert.equal(pushes(), 1);
  assert.deepEqual(notes, []);

  // Room again: everything that waited is sent.
  known = false;
  a.pushError = null;
  await engine.tick();
  assert.equal(account.records.size, 4);
  assert.equal(pushes(), 4);
});

test("files and settings: a write refused for want of room ends the sending, not the fetching", async () => {
  const account = new FakeAccount();
  const clock = { now: 100 };
  const b = filesPort({ "agents/z.md": "from B" }, clock);
  await new SyncEngine(account.backend(), memoryStore(), [filesLayer(b)]).tick();
  const a = filesPort({ "agents/a.md": "A", "agents/b.md": "B", "agents/c.md": "C" }, clock);
  const settings = settingsPort({ theme: "dark" }, clock);
  const inner = account.backend();
  let room = false;
  let refusals = 0;
  const notes: SyncNote[] = [];
  const engine = new SyncEngine(
    {
      changes: inner.changes,
      put: async (collection, id, expect, text) => {
        // Removing a record takes no room; anything else is refused.
        if (!room && text !== null) {
          refusals++;
          throw fullError();
        }
        return inner.put(collection, id, expect, text);
      },
    },
    memoryStore(),
    [settingsLayer(settings), filesLayer(a)],
    { note: (event) => notes.push(event) },
  );
  await assert.rejects(engine.tick(), (err) => codeOf(err) === "SyncFull");
  assert.equal(refusals, 1, "asked once a pass, not once per item");
  assert.deepEqual(notes, []);
  assert.equal(a.files["agents/z.md"], "from B", "what the account holds still arrives");
  assert.equal(account.records.size, 1);
  await assert.rejects(engine.tick(), (err) => codeOf(err) === "SyncFull");
  assert.equal(refusals, 2);
  room = true;
  await engine.tick();
  assert.equal(account.records.size, 5, "the settings and the three files, once there is room");
});
