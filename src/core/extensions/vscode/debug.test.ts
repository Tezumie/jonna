// D295: the shim's debug namespace as VS Code's: one DebugSession per session id (the factory's
// is activeDebugSession's and customRequest goes to that id), custom events, the active stack
// item, both resolve steps apart, startDebugging's options, function breakpoints.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerApi, type FromWorker, type RequestMessage, type ToWorker } from "../rpc";
import { startOptionsOf } from "./debug";
import { createVscodeShim, type ShimFileSystem } from "./index";

const tick = () => new Promise((r) => setTimeout(r, 0));

function harness(answers: Record<string, (p: Record<string, unknown>) => unknown> = {}) {
  const sent: FromWorker[] = [];
  let deliver: (m: ToWorker) => void = () => {};
  const defaults: Record<string, (p: Record<string, unknown>) => unknown> = {
    "settings.get": () => null,
    "state.get": () => ({ documents: [] }),
    "workspace.isTrusted": () => true,
  };
  const { api } = createWorkerApi(
    {
      post: (m) => {
        sent.push(m);
        if (m.t === "req") {
          const answer = answers[m.method] ?? defaults[m.method];
          queueMicrotask(() =>
            deliver({
              t: "res",
              id: m.id,
              ok: true,
              value: answer ? answer(m.params as Record<string, unknown>) : null,
            }),
          );
        }
      },
      onMessage: (h) => (deliver = h),
    },
    {
      id: "acme.debugger",
      version: "1.0.0",
      path: "/ext",
      appName: "Studio",
      workspace: { folders: [{ path: "/ws", name: "ws", index: 0 }], name: "ws", file: null },
    },
  );
  const requests = (method?: string) =>
    sent.filter((m): m is RequestMessage => m.t === "req" && (!method || m.method === method));
  let callId = 1000;
  const call = async (kind: "provider", target: string, args?: unknown) => {
    const id = ++callId;
    deliver({ t: "call", id, kind, target, args });
    for (let i = 0; i < 20; i++) {
      await tick();
      const res = sent.find((m) => m.t === "res" && m.id === id);
      if (res && res.t === "res") {
        if (!res.ok) throw new Error(res.error);
        return res.value;
      }
    }
    throw new Error(`no answer to ${target}`);
  };
  const fire = (type: string, payload: unknown) => {
    for (const r of requests("events.subscribe"))
      if ((r.params as { type: string }).type === type)
        deliver({
          t: "call",
          id: ++callId,
          kind: "event",
          target: String((r.params as { sub: string }).sub),
          args: payload,
        });
  };
  const fs: ShimFileSystem = {
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    stat: async () => ({ type: 1, ctime: 0, mtime: 0, size: 0 }),
    readDirectory: async () => [],
    createDirectory: async () => {},
    delete: async () => {},
    rename: async () => {},
    copy: async () => {},
  };
  const shim = createVscodeShim({
    ide: api,
    init: { commands: [], shimCommand: "", settings: [] },
    packageJSON: {
      publisher: "Acme",
      name: "debugger",
      contributes: { debuggers: [{ type: "mock", label: "Mock" }] },
    },
    extensionPath: "/ext",
    globalStoragePath: "/data/global",
    logPath: "/data/logs",
    fs,
    shell: "/bin/sh",
    log: () => {},
  });
  return { shim, vscode: shim.vscode, requests, call, fire };
}

type DebugSession = {
  id: string;
  name: string;
  configuration: Record<string, unknown>;
  parentSession: unknown;
  customRequest(command: string, args?: unknown): Promise<unknown>;
};

test("D295: the factory's session is the session of every event, and customRequest names it", async () => {
  const runs: Record<string, unknown>[] = [];
  const h = harness({
    "commands.execute": (p) => {
      runs.push(p);
      return { ok: true };
    },
  });
  await h.shim.ready();
  const v = h.vscode as unknown as {
    debug: {
      registerDebugAdapterDescriptorFactory(type: string, f: unknown): unknown;
      onDidStartDebugSession(l: (s: DebugSession) => void): unknown;
      onDidReceiveDebugSessionCustomEvent(
        l: (e: { session: DebugSession; event: string; body: unknown }) => void,
      ): unknown;
      onDidChangeActiveStackItem(l: (i: unknown) => void): unknown;
      readonly activeDebugSession: DebugSession | undefined;
      readonly activeStackItem:
        | { session: unknown; threadId: number; frameId?: number }
        | undefined;
    };
    DebugAdapterServer: new (port: number) => unknown;
    DebugStackFrame: new (...a: unknown[]) => unknown;
  };
  let fromFactory: DebugSession | undefined;
  v.debug.registerDebugAdapterDescriptorFactory("mock", {
    createDebugAdapterDescriptor: (s: DebugSession) => {
      fromFactory = s;
      return new v.DebugAdapterServer(4711);
    },
  });
  const started: DebugSession[] = [];
  v.debug.onDidStartDebugSession((s) => started.push(s));
  const custom: { session: DebugSession; event: string }[] = [];
  v.debug.onDidReceiveDebugSessionCustomEvent((e) => custom.push(e));
  await tick();
  const registration = h.requests("debug.register")[0];
  assert.ok(registration, "the factory registered");
  const factoryId = (registration.params as { id: string }).id;
  const configuration = { type: "mock", name: "Run", request: "launch", program: "/ws/a" };
  await h.call("provider", factoryId, {
    sessionId: "s4",
    session: { id: "s4", type: "mock", name: "Run", configuration },
  });
  assert.equal(fromFactory?.id, "s4");
  assert.deepEqual(fromFactory?.configuration, configuration);
  await tick();
  h.fire("debug.didStartSession", { id: "s4", name: "Run", type: "mock", configuration });
  h.fire("debug.didChangeActiveSession", { id: "s4", name: "Run", type: "mock" });
  h.fire("debug.didReceiveCustomEvent", {
    session: { id: "s4", name: "Run", type: "mock" },
    event: "debugpyAttach",
    body: { port: 1 },
  });
  h.fire("debug.didChangeActiveStackItem", {
    session: { id: "s4", name: "Run", type: "mock" },
    threadId: 1,
    frameId: 9,
  });
  for (let i = 0; i < 10 && !custom.length; i++) await tick();
  assert.equal(started[0], fromFactory);
  assert.equal(v.debug.activeDebugSession, fromFactory);
  assert.equal(custom[0]?.session, fromFactory);
  assert.equal(custom[0]?.event, "debugpyAttach");
  assert.ok(v.debug.activeStackItem instanceof v.DebugStackFrame);
  assert.equal(v.debug.activeStackItem?.session, fromFactory);
  assert.equal(v.debug.activeStackItem?.frameId, 9);
  await fromFactory?.customRequest("evaluate", { expression: "1" });
  assert.deepEqual(runs.at(-1), {
    id: "debug.customRequest",
    input: { command: "evaluate", arguments: { expression: "1" }, session: "s4" },
  });
});

test("D295: a provider's two resolve steps are asked apart, with the folder", async () => {
  const h = harness();
  await h.shim.ready();
  const v = h.vscode as unknown as {
    debug: { registerDebugConfigurationProvider(type: string, p: unknown): unknown };
  };
  const seen: string[] = [];
  v.debug.registerDebugConfigurationProvider("*", {
    resolveDebugConfiguration: (folder: { name: string } | undefined, c: object) => {
      seen.push(`resolve ${folder?.name}`);
      return { ...c, first: true };
    },
    resolveDebugConfigurationWithSubstitutedVariables: (_f: unknown, c: object) => {
      seen.push("substituted");
      return { ...c, second: true };
    },
  });
  await tick();
  const reg = h.requests("debug.registerConfigurationProvider")[0]?.params as {
    id: string;
    type: string;
    resolves: boolean;
    resolvesSubstituted: boolean;
  };
  assert.equal(reg.type, "*");
  assert.equal(reg.resolves, true);
  assert.equal(reg.resolvesSubstituted, true);
  const first = await h.call("provider", reg.id, {
    op: "resolve",
    configuration: { type: "x" },
    folder: "/ws",
  });
  assert.deepEqual(first, { type: "x", first: true });
  const second = await h.call("provider", reg.id, {
    op: "resolveSubstituted",
    configuration: { type: "x" },
    folder: "/ws",
  });
  assert.deepEqual(second, { type: "x", second: true });
  assert.deepEqual(seen, ["resolve ws", "substituted"]);
});

test("D295: startDebugging's options and function breakpoints", async () => {
  const runs: Record<string, unknown>[] = [];
  const functions: { name: string; enabled: boolean }[] = [];
  const h = harness({
    "commands.execute": (p) => {
      runs.push(p);
      const input = p.input as { name?: string };
      if (p.id === "debug.addFunctionBreakpoint")
        functions.push({ name: String(input.name), enabled: true });
      if (p.id === "debug.start") return { session: "s9" };
      return null;
    },
    "state.get": (p) =>
      p.path === "ide://debug" ? { breakpoints: [], functionBreakpoints: functions } : {},
  });
  await h.shim.ready();
  const v = h.vscode as unknown as {
    debug: {
      startDebugging(folder: unknown, c: unknown, o?: unknown): Promise<boolean>;
      addBreakpoints(list: unknown[]): void;
      readonly breakpoints: readonly unknown[];
    };
    FunctionBreakpoint: new (name: string) => unknown;
  };
  const parent = { id: "s1", customRequest: () => Promise.resolve() };
  assert.equal(
    await v.debug.startDebugging(
      undefined,
      { type: "x", name: "c" },
      {
        parentSession: parent,
        consoleMode: 1,
        lifecycleManagedByParent: true,
      },
    ),
    true,
  );
  assert.deepEqual(runs.at(-1), {
    id: "debug.start",
    input: {
      configuration: { type: "x", name: "c" },
      parentSession: "s1",
      lifecycleManagedByParent: true,
      consoleMode: "mergeWithParent",
    },
  });
  assert.deepEqual(startOptionsOf(parent), { parentSession: "s1" });
  const bp = new v.FunctionBreakpoint("render");
  v.debug.addBreakpoints([bp]);
  for (let i = 0; i < 20 && !v.debug.breakpoints.length; i++) await tick();
  assert.equal(v.debug.breakpoints[0], bp);
});

test("audit: a session first seen without its configuration gets it when an event brings it", async () => {
  const h = harness();
  await h.shim.ready();
  const v = h.vscode as unknown as {
    debug: { readonly activeDebugSession: DebugSession | undefined };
  };
  // The active session changes before the start event (or a tracker saw it first): a stand-in.
  h.fire("debug.didChangeActiveSession", { id: "s9", name: "Run", type: "mock" });
  await tick();
  assert.equal(v.debug.activeDebugSession?.configuration.request, "launch");
  const configuration = { type: "mock", name: "Run", request: "attach", port: 5678 };
  h.fire("debug.didStartSession", { id: "s9", name: "Run", type: "mock", configuration });
  await tick();
  assert.deepEqual(v.debug.activeDebugSession?.configuration, configuration);
});
