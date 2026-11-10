import assert from "node:assert/strict";
import { test } from "node:test";
import { type AuthorizeRequest, createM2Policy } from "./index";

const req = (over: Partial<AuthorizeRequest>): AuthorizeRequest => ({
  caller: { kind: "mcp", client: "claude" },
  commandId: "x.y",
  title: "X",
  effects: [],
  confirmMessage: undefined,
  agent: "core",
  ...over,
});

test("MCP: reads allowed, writes ask, session grants stick, hidden denied", async () => {
  const asked: string[] = [];
  let answer: "once" | "session" | "deny" = "session";
  const policy = createM2Policy({
    confirm: async () => true,
    askMcp: async (r) => {
      asked.push(r.commandId);
      return answer;
    },
    testMode: () => false,
  });
  assert.equal(await policy.authorize(req({ effects: ["read"] })), "allow");
  assert.equal(await policy.authorize(req({ effects: ["write"] })), "allow");
  assert.equal(await policy.authorize(req({ effects: ["write"] })), "allow");
  assert.deepEqual(asked, ["x.y"]); // remembered for the session
  answer = "deny";
  assert.equal(await policy.authorize(req({ commandId: "a.b", effects: ["exec"] })), "deny");
  assert.equal(await policy.authorize(req({ agent: "hidden" })), "deny");
  assert.equal(await policy.authorize(req({ caller: { kind: "test" } })), "deny");
});

test("test callers are allowed only in test mode", async () => {
  const policy = createM2Policy({
    confirm: async () => false,
    askMcp: async () => "deny",
    testMode: () => true,
  });
  assert.equal(
    await policy.authorize(req({ caller: { kind: "test" }, effects: ["destructive"] })),
    "allow",
  );
});

test("agents: read and UI-only allowed, changes ask in the conversation, destructive every time", async () => {
  const asked: string[] = [];
  const policy = createM2Policy({
    confirm: async () => true,
    askMcp: async () => "deny",
    testMode: () => false,
    askAgent: async (r) => {
      asked.push(`${r.session}:${r.commandId}`);
      return "session";
    },
  });
  const agent = { caller: { kind: "agent" as const, session: "s1" } };
  assert.equal(await policy.authorize(req({ ...agent, effects: ["read"] })), "allow");
  assert.equal(await policy.authorize(req({ ...agent, effects: [] })), "allow");
  assert.equal(await policy.authorize(req({ ...agent, effects: ["write"] })), "allow");
  assert.equal(await policy.authorize(req({ ...agent, effects: ["write"] })), "allow");
  assert.equal(
    await policy.authorize(req({ ...agent, commandId: "d", effects: ["destructive"] })),
    "allow",
  );
  assert.equal(
    await policy.authorize(req({ ...agent, commandId: "d", effects: ["destructive"] })),
    "allow",
  );
  assert.deepEqual(asked, ["s1:x.y", "s1:d", "s1:d"]);
  assert.equal(await policy.authorize(req({ ...agent, agent: "hidden" })), "deny");
  const strict = createM2Policy({
    confirm: async () => true,
    askMcp: async () => "deny",
    testMode: () => false,
  });
  assert.equal(await strict.authorize(req({ ...agent, effects: ["write"] })), "deny");
});

test("agents changing the IDE itself ask, and one 'this chat' covers all of it (D176)", async () => {
  const asked: { id: string; ide: boolean }[] = [];
  let answer: "once" | "session" | "deny" = "once";
  const policy = createM2Policy({
    confirm: async () => true,
    askMcp: async () => "deny",
    testMode: () => false,
    askAgent: async (r) => {
      asked.push({ id: r.commandId, ide: r.ideControl === true });
      return answer;
    },
  });
  const agent = { caller: { kind: "agent" as const, session: "s1" } };
  // UI-only commands elsewhere don't ask; layout ones do, even with no effects.
  assert.equal(await policy.authorize(req({ ...agent, commandId: "editor.openFile" })), "allow");
  assert.equal(await policy.authorize(req({ ...agent, commandId: "view.show" })), "allow");
  assert.equal(
    await policy.authorize(req({ ...agent, commandId: "layout.moveToNewWindow" })),
    "allow",
  );
  assert.deepEqual(asked, [{ id: "layout.moveToNewWindow", ide: true }]);
  // Reading the IDE's extensions never asks.
  assert.equal(
    await policy.authorize(req({ ...agent, commandId: "extensions.readFile", effects: ["read"] })),
    "allow",
  );
  answer = "session";
  await policy.authorize(req({ ...agent, commandId: "settings.set", effects: ["write"] }));
  // Granted for the chat: other IDE changes go ahead; another chat asks again.
  await policy.authorize(req({ ...agent, commandId: "extensions.create", effects: ["write"] }));
  await policy.authorize(req({ ...agent, commandId: "layout.togglePanel" }));
  assert.equal(asked.length, 2);
  answer = "deny";
  assert.equal(
    await policy.authorize(
      req({ caller: { kind: "agent", session: "s2" }, commandId: "layout.togglePanel" }),
    ),
    "deny",
  );
  assert.equal(asked.length, 3);
});
