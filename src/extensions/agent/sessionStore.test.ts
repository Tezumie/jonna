import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "../../core/agent/conversation";
import { agentStoreIpc } from "../../core/ipc/agent";
import { signal } from "../../core/reactive/index";
import type { AgentSession } from "./session";
import { loadSaved, saveSessionNow, updateSavedMeta } from "./sessionStore";

/** What loadSaved touches of a session (no Tauri, no workbench in tests). */
function fakeSession() {
  const noop = () => {};
  return {
    id: "s-test",
    savedVersion: null as string | null,
    attachedRules: new Map<string, number>(),
    toldSkills: new Map<string, number>(),
    title: signal(""),
    updated: 0,
    pinned: false,
    archived: false,
    room: null as string | null,
    parent: null,
    workspaceRoot: null as string | null,
    model: signal<string | null>(null),
    items: [] as Item[],
    textProtocol: false,
    turn: 0,
    autoApply: signal(false),
    services: { settings: { peek: () => undefined } },
    chatMode: signal("agent"),
    workMode: signal<string | null>(null),
    checkpoints: [] as number[],
    toolLimit: null as string[] | null,
    members: signal<string[]>([]),
    pullRequest: signal(null),
    changeset: {
      restoreSeen: noop,
      restore: noop,
      restoreApplied: noop,
      restoreRejected: noop,
    },
    plan: signal([]),
    cost: signal(0),
    budgetAllowed: false,
    acpResume: null,
    externalSeen: null,
    version: signal(0),
  };
}

async function load(saved: unknown) {
  const real = { version: agentStoreIpc.version, load: agentStoreIpc.load };
  Object.assign(agentStoreIpc, {
    version: async () => "v1",
    load: async () => JSON.stringify(saved),
  });
  try {
    const session = fakeSession();
    assert.ok(await loadSaved(session as unknown as AgentSession));
    return session;
  } finally {
    Object.assign(agentStoreIpc, real);
  }
}

test("loadSaved: an answer cut off mid-stream by the IDE closing says so, with Continue", async () => {
  const session = await load({
    meta: { title: "Chat" },
    items: [
      { type: "user", id: "u1", text: "Write it", turn: 1 },
      { type: "assistant", id: "a1", text: "Here is the first ha", thinking: "", streaming: true },
    ],
    turn: 1,
  });
  const answer = session.items[1];
  assert.equal(answer?.type === "assistant" && answer.streaming, false);
  const last = session.items[session.items.length - 1];
  assert.equal(last?.type, "notice");
  assert.ok(last?.type === "notice" && last.actions?.includes("continue"));
});

test("loadSaved: a finished answer gets no interrupted notice", async () => {
  const session = await load({
    meta: { title: "Chat" },
    items: [
      { type: "user", id: "u1", text: "Hi", turn: 1 },
      { type: "assistant", id: "a1", text: "Hello.", thinking: "", streaming: false },
    ],
    turn: 1,
  });
  assert.equal(session.items.length, 2);
  assert.equal(session.items[1]?.type, "assistant");
});

/** The transcript store as the backend keeps it: a save with `expect` only over that version. */
function fakeStore() {
  const files = new Map<string, { json: string; version: string }>();
  let writes = 0;
  const real = { ...agentStoreIpc };
  Object.assign(agentStoreIpc, {
    version: async (id: string) => files.get(id)?.version ?? null,
    load: async (id: string) => files.get(id)?.json ?? null,
    save: async (id: string, json: string, expect?: string | null) => {
      const now = files.get(id);
      if (expect != null && now && now.version !== expect)
        return { version: now.version, conflict: true };
      const version = `v${++writes}`;
      files.set(id, { json, version });
      return { version, conflict: false };
    },
  });
  return { files, restore: () => Object.assign(agentStoreIpc, real) };
}

/** A chat as one process holds it, with what a save touches. */
function savingSession(text: string) {
  const session = {
    ...fakeSession(),
    deleted: false,
    conflict: signal(false),
    bump: () => {},
    toJSON(): unknown {
      return { meta: { title: text }, items: session.items };
    },
  };
  return session;
}

test("saveSessionNow: a chat opened by an id nobody had saved doesn't replace one saved under it meanwhile", async () => {
  const store = fakeStore();
  try {
    // Two processes open the same id before either saved (a run given --session-id twice).
    const first = savingSession("first");
    const second = savingSession("second");
    assert.equal(await loadSaved(first as unknown as AgentSession), false);
    assert.equal(await loadSaved(second as unknown as AgentSession), false);
    first.items.push({ type: "user", id: "u1", text: "from the first", turn: 1 } as Item);
    second.items.push({ type: "user", id: "u2", text: "from the second", turn: 1 } as Item);
    await saveSessionNow(first as unknown as AgentSession);
    assert.equal(first.conflict.peek(), false, "nothing saved yet: the first save writes");
    await saveSessionNow(second as unknown as AgentSession);
    assert.equal(second.conflict.peek(), true, "the second is told, and writes nothing");
    assert.match(store.files.get("s-test")?.json ?? "", /from the first/);
    // The first goes on saving over its own version.
    first.items.push({ type: "user", id: "u3", text: "more", turn: 2 } as Item);
    await saveSessionNow(first as unknown as AgentSession);
    assert.equal(first.conflict.peek(), false);
    assert.match(store.files.get("s-test")?.json ?? "", /more/);
  } finally {
    store.restore();
  }
});

test("saveSessionNow: two saves of one chat started together aren't a conflict with itself", async () => {
  const store = fakeStore();
  try {
    // A title's save and the turn's save, started in the same moment by one process.
    const chat = savingSession("one");
    assert.equal(await loadSaved(chat as unknown as AgentSession), false);
    chat.items.push({ type: "user", id: "u1", text: "hello", turn: 1 } as Item);
    const first = saveSessionNow(chat as unknown as AgentSession);
    chat.items.push({ type: "user", id: "u2", text: "and the title", turn: 1 } as Item);
    const second = saveSessionNow(chat as unknown as AgentSession);
    await Promise.all([first, second]);
    assert.equal(chat.conflict.peek(), false);
    assert.match(store.files.get("s-test")?.json ?? "", /and the title/);
  } finally {
    store.restore();
  }
});

test("updateSavedMeta: a rename doesn't put an older transcript back over a turn saved meanwhile", async () => {
  const store = fakeStore();
  try {
    await agentStoreIpc.save("c1", JSON.stringify({ meta: { title: "Old" }, items: ["one"] }));
    // Another process saves its turn between this one's read and its write.
    const load = agentStoreIpc.load;
    let raced = false;
    agentStoreIpc.load = async (id) => {
      const text = await load(id);
      if (!raced) {
        raced = true;
        await agentStoreIpc.save(
          id,
          JSON.stringify({ meta: { title: "Old" }, items: ["one", "two"] }),
        );
      }
      return text;
    };
    const meta = await updateSavedMeta<{ title?: string }>("c1", (m) => {
      m.title = "New";
    });
    assert.equal(meta.title, "New");
    assert.deepEqual(JSON.parse(store.files.get("c1")?.json ?? "{}"), {
      meta: { title: "New" },
      items: ["one", "two"],
    });
  } finally {
    store.restore();
  }
});
