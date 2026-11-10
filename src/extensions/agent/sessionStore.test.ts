import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "../../core/agent/conversation";
import { agentStoreIpc } from "../../core/ipc/agent";
import { signal } from "../../core/reactive/index";
import type { AgentSession } from "./session";
import { loadSaved } from "./sessionStore";

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
