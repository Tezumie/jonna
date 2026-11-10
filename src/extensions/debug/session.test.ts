import assert from "node:assert/strict";
import { test } from "node:test";
import { Emitter } from "../../core/events/index";
import { DapConnection, DapSession } from "./session";

/** A scripted adapter: `answer` decides each request's response (and may send events). */
function fakeAdapter(
  answer: (
    command: string,
    args: Record<string, unknown> | undefined,
    reply: (body?: Record<string, unknown>) => void,
    event: (event: string, body?: Record<string, unknown>) => void,
  ) => void,
) {
  const incoming = new Emitter<string>();
  const sent: { command: string; arguments?: Record<string, unknown> }[] = [];
  let seq = 1000;
  const event = (name: string, body: Record<string, unknown> = {}): void =>
    queueMicrotask(() =>
      incoming.fire(JSON.stringify({ seq: seq++, type: "event", event: name, body })),
    );
  const transport = {
    onMessage: incoming.event,
    send(raw: string): void {
      const msg = JSON.parse(raw) as {
        seq: number;
        type: string;
        command: string;
        arguments?: Record<string, unknown>;
      };
      if (msg.type !== "request") return;
      sent.push({ command: msg.command, ...(msg.arguments ? { arguments: msg.arguments } : {}) });
      answer(
        msg.command,
        msg.arguments,
        (body = {}) =>
          queueMicrotask(() =>
            incoming.fire(
              JSON.stringify({
                seq: seq++,
                type: "response",
                request_seq: msg.seq,
                command: msg.command,
                success: true,
                body,
              }),
            ),
          ),
        event,
      );
    },
  };
  const dap = new DapConnection(transport, async () => ({}));
  return { dap, sent, event };
}

function session(dap: DapConnection, breakpoints = new Map<string, { line: number }[]>()) {
  return new DapSession(dap, {
    adapterId: "test",
    request: "launch",
    arguments: {},
    setup: {
      breakpoints: () => breakpoints,
      exceptionStops: () => ({ uncaught: false, caught: false }),
    },
    kill: async () => {},
  });
}

test("start fails (not hangs) when the adapter exits after launch, before initialized", async () => {
  let s: DapSession | null = null;
  const { dap } = fakeAdapter((command, _args, reply) => {
    reply();
    if (command === "launch") queueMicrotask(() => queueMicrotask(() => s?.adapterExited()));
  });
  s = session(dap);
  await assert.rejects(s.start(), /ended|stopped/);
});

test("start doesn't miss an initialized event that comes in the same tick as initialize's answer", async () => {
  // The answer and the event queued back to back (a channel delivering two messages at once):
  // the event fires before start()'s continuation after the initialize request runs.
  const { dap } = fakeAdapter((command, _args, reply, ev) => {
    reply();
    if (command === "initialize") ev("initialized");
  });
  const s = session(dap);
  const timeout = new Promise<string>((r) => setTimeout(() => r("hung"), 500));
  assert.equal(await Promise.race([s.start().then(() => "started"), timeout]), "started");
});

test("a breakpoint event updates that breakpoint without re-sending the file's list", async () => {
  const { dap, sent, event } = fakeAdapter((command, _args, reply, ev) => {
    if (command === "setBreakpoints")
      reply({
        breakpoints: [
          { id: 1, verified: false, line: 3 },
          { id: 2, verified: false, line: 9 },
        ],
      });
    else reply();
    if (command === "launch") ev("initialized");
  });
  const s = session(dap, new Map([["/a.py", [{ line: 3 }, { line: 9 }]]]));
  const seen: { path: string; results: { verified: boolean; line?: number }[] }[] = [];
  s.onBreakpoints((e) => seen.push(e));
  await s.start();
  const before = sent.filter((m) => m.command === "setBreakpoints").length;
  event("breakpoint", { reason: "changed", breakpoint: { id: 2, verified: true, line: 10 } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent.filter((m) => m.command === "setBreakpoints").length, before);
  assert.deepEqual(seen.at(-1), {
    path: "/a.py",
    results: [
      { verified: false, line: 3 },
      { verified: true, line: 10 },
    ],
  });
});

test("startDebugging: offered only when the client handles it; the reverse request is answered", async () => {
  const { dap, sent } = fakeAdapter((command, _args, reply, ev) => {
    reply();
    if (command === "launch") ev("initialized");
  });
  const s = new DapSession(dap, {
    adapterId: "test",
    request: "launch",
    arguments: {},
    setup: {
      breakpoints: () => new Map(),
      exceptionStops: () => ({ uncaught: false, caught: false }),
    },
    kill: async () => {},
    startDebugging: true,
  });
  await s.start();
  assert.equal(sent[0]?.arguments?.supportsStartDebuggingRequest, true);
  assert.equal(
    sent.find((m) => m.command === "initialize")?.arguments?.supportsStartDebuggingRequest,
    true,
  );
  const plain = fakeAdapter((command, _args, reply, ev) => {
    reply();
    if (command === "launch") ev("initialized");
  });
  await session(plain.dap).start();
  assert.equal(plain.sent[0]?.arguments?.supportsStartDebuggingRequest, false);

  // The adapter's request reaches the handler; its answer (or error) goes back.
  const incoming = new Emitter<string>();
  const out: Record<string, unknown>[] = [];
  const asked: [string, Record<string, unknown>][] = [];
  new DapConnection(
    { onMessage: incoming.event, send: (raw) => out.push(JSON.parse(raw)) },
    async (command, args) => {
      asked.push([command, args]);
      if (command === "bad") throw new Error("no");
      return {};
    },
  );
  incoming.fire(
    JSON.stringify({
      seq: 7,
      type: "request",
      command: "startDebugging",
      arguments: { request: "attach", configuration: { subProcessId: 2 } },
    }),
  );
  incoming.fire(JSON.stringify({ seq: 8, type: "request", command: "bad", arguments: {} }));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(asked[0], [
    "startDebugging",
    { request: "attach", configuration: { subProcessId: 2 } },
  ]);
  assert.deepEqual(
    out.map((m) => [m.request_seq, m.success]),
    [
      [7, true],
      [8, false],
    ],
  );
});

test("instruction stepping and breakpoints go out only where the adapter supports them", async () => {
  let caps: Record<string, unknown> = {};
  const { dap, sent } = fakeAdapter((command, _args, reply, ev) => {
    if (command === "initialize") reply(caps);
    else if (command === "setInstructionBreakpoints") reply({ breakpoints: [{ verified: true }] });
    else reply();
    if (command === "launch") ev("initialized");
  });
  caps = { supportsSteppingGranularity: true, supportsInstructionBreakpoints: true };
  const s = session(dap);
  await s.start();
  assert.equal(s.capabilities().instructionBreakpoints, true);
  assert.equal(s.capabilities().steppingGranularity, true);
  await s.next(1, "instruction");
  await s.stepIn(1);
  assert.deepEqual(sent.find((m) => m.command === "next")?.arguments, {
    threadId: 1,
    granularity: "instruction",
  });
  assert.deepEqual(sent.find((m) => m.command === "stepIn")?.arguments, { threadId: 1 });
  assert.deepEqual(await s.setInstructionBreakpoints([{ instructionReference: "0x10" }]), [
    { verified: true },
  ]);

  const other = fakeAdapter((command, _args, reply, ev) => {
    reply();
    if (command === "launch") ev("initialized");
  });
  const t = session(other.dap);
  await t.start();
  await t.next(1, "instruction");
  assert.deepEqual(other.sent.find((m) => m.command === "next")?.arguments, { threadId: 1 });
  assert.deepEqual(await t.setInstructionBreakpoints([{ instructionReference: "0x10" }]), [
    { verified: false },
  ]);
  assert.equal(
    other.sent.some((m) => m.command === "setInstructionBreakpoints"),
    false,
  );
});

test("hit breakpoints come back as the IDE's ids; step-in targets and restart frame", async () => {
  const { dap, sent, event } = fakeAdapter((command, _args, reply, ev) => {
    if (command === "initialize")
      reply({ supportsStepInTargetsRequest: true, supportsRestartFrame: true });
    else if (command === "setBreakpoints")
      reply({
        breakpoints: [
          { id: 41, verified: true, line: 3 },
          { id: 42, verified: true, line: 9 },
        ],
      });
    else if (command === "stepInTargets")
      reply({ targets: [{ id: 7, label: "inner()", line: 3, column: 9 }, { label: "bad" }] });
    else if (command === "stackTrace")
      reply({ stackFrames: [{ id: 1, name: "f", line: 3, column: 1, canRestart: false }] });
    else reply();
    if (command === "launch") ev("initialized");
  });
  const s = session(
    dap,
    new Map([
      [
        "/a.py",
        [
          { id: 5, line: 3 },
          { id: 6, line: 9 },
        ],
      ],
    ]),
  );
  const stops: { hitBreakpointIds?: number[] }[] = [];
  s.onStopped((e) => stops.push(e));
  await s.start();
  assert.equal(s.capabilities().stepInTargets, true);
  assert.equal(s.capabilities().restartFrame, true);
  // The IDE's ids are never sent.
  const bps = sent.find((m) => m.command === "setBreakpoints")?.arguments?.breakpoints;
  assert.deepEqual(bps, [{ line: 3 }, { line: 9 }]);
  event("stopped", { reason: "breakpoint", threadId: 1, hitBreakpointIds: [42, 99] });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(stops.at(-1)?.hitBreakpointIds, [6]);
  assert.deepEqual(await s.stepInTargets(1), [{ id: 7, label: "inner()", line: 3, column: 9 }]);
  await s.stepInTarget(1, 7);
  assert.deepEqual(sent.at(-1), { command: "stepIn", arguments: { threadId: 1, targetId: 7 } });
  await s.restartFrame(1, 1);
  assert.deepEqual(sent.at(-1), { command: "restartFrame", arguments: { frameId: 1 } });
  assert.equal((await s.stackTrace(1))[0]?.canRestart, false);
});
