import assert from "node:assert/strict";
import { test } from "node:test";
import type { SyncChanges, SyncPut, SyncRecord, SyncUserFile } from "../ipc/sync";
import { type SyncBackend, SyncEngine, type SyncNote, type SyncStore } from "./engine";
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
  } = {
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
