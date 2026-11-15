import assert from "node:assert/strict";
import { test } from "node:test";
import type { SyncChanges, SyncPut, SyncRecord, SyncUserFile } from "../ipc/sync";
import { type SyncBackend, SyncEngine, type SyncStore } from "./engine";
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
          .map((r) => ({ ...r })),
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
  const port: SettingsPort & { values: Record<string, unknown>; mtimeMs: number } = {
    values,
    mtimeMs: clock.now,
    read: async () => ({ values: { ...port.values }, mtimeMs: port.mtimeMs }),
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
  } = {
    files,
    off: new Set(),
    edit(path, text) {
      if (text === null) delete files[path];
      else files[path] = text;
      times.set(path, clock.now);
    },
    scan: async () =>
      Object.keys(files)
        .filter((p) => !p.includes(".conflict"))
        .sort()
        .map(entry),
    read: async (path) => files[path] ?? null,
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
  assert.deepEqual(a.values, { theme: "dark", fontSize: 14, "accounts.serverUrl": "http://a" });
  assert.deepEqual(b.values, { fontSize: 14, theme: "dark" });

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
  assert.deepEqual(a.values, { a: 1 }, "nothing applied from a write it never saw");
  await engine.tick();
  assert.deepEqual(a.values, { a: 1, b: 2 });
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
  assert.deepEqual(b.files, { "keybindings.json": "[1]", "snippets/go.json": "{}" });

  clock.now = 200;
  b.edit("snippets/go.json", '{"x":1}');
  b.edit("skills/review/SKILL.md", "# Review");
  a.edit("keybindings.json", null);
  await both();
  assert.deepEqual(a.files, {
    "snippets/go.json": '{"x":1}',
    "skills/review/SKILL.md": "# Review",
  });
  assert.deepEqual(b.files, a.files);

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
  assert.deepEqual(b.files, {});
  b.off.clear();
  await engineB.tick();
  assert.deepEqual(b.files, { "snippets/go.json": "{}" });
});

/** A computer's chats, with the transfer done by copying between computers through the account. */
function chatsPort(name: string, account: FakeAccount, contents: Map<string, string>) {
  const chats = new Map<string, { workspace: string | null; text: string; updated: number }>();
  let copies = 0;
  const port: ChatsPort & {
    chats: typeof chats;
    projects: Map<string, string>;
    busyIds: Set<string>;
  } = {
    chats,
    /** Folder to collection for the projects that sync here. */
    projects: new Map(),
    busyIds: new Set(),
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
    pull: async (collection, id, saveAs, workspace) => {
      const record = account.records.get(`${collection}/${id}`);
      if (!record || record.deleted) return null;
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
  await engineA.tick();
  await engineB.tick();
  assert.equal(b.chats.has("free"), false);
  const writes = account.seq;
  await engineA.tick();
  await engineB.tick();
  assert.equal(account.seq, writes, "settled");
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
