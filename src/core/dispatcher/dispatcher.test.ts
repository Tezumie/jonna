import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextKeyService } from "../context/index";
import { EventBus } from "../events/index";
import { ALLOW_ALL, createM1Policy, type PermissionPolicy } from "../permissions/index";
import { s } from "../schema/index";
import {
  type AuditEntry,
  CommandError,
  type CommandExecutedEvent,
  Dispatcher,
  type DispatcherEvents,
} from "./index";

function setup(permissions: PermissionPolicy = ALLOW_ALL) {
  const context = new ContextKeyService();
  const events = new EventBus<DispatcherEvents>();
  const audit: AuditEntry[] = [];
  const executed: CommandExecutedEvent[] = [];
  events.on("command.executed", (e) => executed.push(e));
  const dispatcher = new Dispatcher({
    context,
    permissions,
    events,
    audit: (e) => {
      audit.push(e);
    },
    validateOutput: true,
  });
  return { dispatcher, context, audit, executed };
}

const greet = {
  id: "test.greet",
  title: "Greet",
  description: "Returns a greeting for `name`.",
  input: s.object({ name: s.string() }),
  output: s.string(),
  effects: [] as const,
  run: ({ name }: { name: string }) => `hi ${name}`,
};

test("runs commands, audits and emits command.executed", async () => {
  const { dispatcher, audit, executed } = setup();
  dispatcher.register({ ...greet, effects: [] });
  assert.equal(await dispatcher.execute("test.greet", { name: "a" }), "hi a");
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.status, "ok");
  assert.equal(audit[0]?.caller, "user");
  assert.deepEqual(audit[0]?.input, { name: "a" });
  assert.equal(audit[0]?.output, "hi a");
  assert.equal(executed[0]?.id, "test.greet");
});

test("rejects bad ids, duplicates and missing descriptions", () => {
  const { dispatcher } = setup();
  assert.throws(() => dispatcher.register({ ...greet, effects: [], id: "noNamespace" }));
  assert.throws(() => dispatcher.register({ ...greet, effects: [], id: "Bad.id" }));
  assert.throws(() => dispatcher.register({ ...greet, effects: [], description: " " }));
  dispatcher.register({ ...greet, effects: [] });
  assert.throws(() => dispatcher.register({ ...greet, effects: [] }), /already registered/);
});

test("unknown, disabled, invalid input and failures are typed errors and still audited", async () => {
  const { dispatcher, context, audit } = setup();
  dispatcher.register({ ...greet, effects: [], when: "ready" });
  dispatcher.register({
    id: "test.boom",
    title: "Boom",
    description: "Always fails.",
    input: s.empty(),
    effects: [],
    run: () => {
      throw new Error("kaput");
    },
  });
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return "none";
    } catch (err) {
      assert.ok(err instanceof CommandError);
      return err.code;
    }
  };
  assert.equal(await code(dispatcher.execute("test.nope")), "NotFound");
  assert.equal(await code(dispatcher.execute("test.greet", { name: "x" })), "Disabled");
  context.set("ready", true);
  assert.equal(await code(dispatcher.execute("test.greet", { name: 1 })), "InvalidInput");
  assert.equal(
    await code(dispatcher.execute("test.greet", { name: "x", extra: true })),
    "InvalidInput",
  );
  assert.equal(await code(dispatcher.execute("test.boom")), "Failed");
  assert.deepEqual(
    audit.map((a) => a.status),
    ["notFound", "disabled", "invalid", "invalid", "error"],
  );
});

test("dev builds validate outputs", async () => {
  const { dispatcher } = setup();
  dispatcher.register({ ...greet, effects: [], run: () => 42 as unknown as string });
  await assert.rejects(dispatcher.execute("test.greet", { name: "a" }), /Invalid output/);
});

test("M1 policy: user allowed, destructive confirmed, everyone else denied", async () => {
  const confirms: string[] = [];
  let answer = true;
  const { dispatcher, audit } = setup(
    createM1Policy(async (message) => {
      confirms.push(message);
      return answer;
    }),
  );
  let deleted = 0;
  dispatcher.register({
    id: "test.delete",
    title: "Delete",
    description: "Deletes a thing.",
    input: s.object({ name: s.string() }),
    effects: ["write", "destructive"],
    confirm: ({ name }) => `Delete '${name}'?`,
    run: () => {
      deleted++;
    },
  });
  await dispatcher.execute("test.delete", { name: "a.ts" });
  assert.deepEqual(confirms, ["Delete 'a.ts'?"]);
  answer = false;
  await assert.rejects(dispatcher.execute("test.delete", { name: "b.ts" }), /Not permitted/);
  await assert.rejects(
    dispatcher.execute("test.delete", { name: "c.ts" }, { kind: "agent", session: "s1" }),
    /agent:s1/,
  );
  assert.equal(deleted, 1);
  assert.deepEqual(
    audit.map((a) => `${a.caller}:${a.status}`),
    ["user:ok", "user:denied", "agent:s1:denied"],
  );
});

test("nested commands run as the same caller; list() reports enabled state", async () => {
  const callers: string[] = [];
  const { dispatcher, context } = setup();
  dispatcher.register({
    id: "test.inner",
    title: "Inner",
    description: "Records its caller.",
    input: s.empty(),
    effects: [],
    when: "innerOk",
    run: (_input, ctx) => {
      callers.push(ctx.caller.kind);
    },
  });
  dispatcher.register({
    id: "test.outer",
    title: "Outer",
    description: "Calls test.inner.",
    input: s.empty(),
    effects: [],
    run: (_input, ctx) => ctx.execute("test.inner"),
  });
  context.set("innerOk", true);
  await dispatcher.execute("test.outer", {}, { kind: "test" });
  assert.deepEqual(callers, ["test"]);
  context.set("innerOk", false);
  const inner = dispatcher.list().find((c) => c.id === "test.inner");
  assert.equal(inner?.enabled, false);
  assert.equal(dispatcher.acceptsEmptyInput("test.inner"), true);
});

test("caller checks refuse what only the user may ask, before the policy is asked", async () => {
  let asked = 0;
  const { dispatcher, audit } = setup({
    authorize: async () => {
      asked++;
      return "allow";
    },
  });
  let ran = 0;
  dispatcher.register({
    id: "editor.runAction",
    title: "Run editor action",
    description: "Runs an engine action.",
    input: s.object({ action: s.string() }),
    effects: ["write"],
    run: () => ++ran,
  });
  const agent = { kind: "agent", session: "s" } as const;
  await assert.rejects(
    dispatcher.execute("editor.runAction", { action: "ext.other.run.1" }, agent),
    (err: unknown) =>
      err instanceof CommandError && err.code === "Denied" && /Only you/.test(err.message),
  );
  assert.equal(asked, 0);
  assert.equal(ran, 0);
  assert.equal(audit.at(-1)?.status, "denied");
  // The engine's own action goes on to the policy; the user isn't limited.
  await dispatcher.execute("editor.runAction", { action: "editor.action.formatDocument" }, agent);
  await dispatcher.execute("editor.runAction", { action: "ext.other.run.1" });
  assert.equal(asked, 2);
  assert.equal(ran, 2);
});

test("a policy or confirm message that throws is a typed, audited failure", async () => {
  const broken: PermissionPolicy = {
    authorize: () => Promise.reject(new Error("the asking panel closed")),
  };
  const { dispatcher, audit, executed } = setup(broken);
  dispatcher.register({ ...greet, effects: ["write"] });
  await assert.rejects(dispatcher.execute("test.greet", { name: "a" }), (err: unknown) => {
    assert.ok(err instanceof CommandError);
    assert.equal(err.code, "Denied");
    assert.match(err.message, /the asking panel closed/);
    return true;
  });
  assert.equal(audit[0]?.status, "denied");
  assert.equal(executed[0]?.status, "denied");

  const other = setup();
  other.dispatcher.register({
    ...greet,
    id: "test.confirmed",
    effects: ["destructive"],
    confirm: () => {
      throw new Error("bad message");
    },
  });
  await assert.rejects(other.dispatcher.execute("test.confirmed", { name: "a" }), CommandError);
  assert.equal(other.executed[0]?.status, "denied");
});
