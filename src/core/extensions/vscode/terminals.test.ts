// The shim's terminals (terminals.ts) with a fake host: created unshown, the host's events
// (process id, active, typing, closing, shell integration and its commands) as VS Code's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerApi, type FromWorker, type RequestMessage, type ToWorker } from "../rpc";
import { toTerminalEvent } from "../rpcTerminals";
import { createTerminals } from "./terminals";
import { EventEmitter, TerminalExitReason } from "./types";

const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeHost(answers: Record<string, (p: Record<string, unknown>) => unknown> = {}) {
  const sent: FromWorker[] = [];
  let deliver: (m: ToWorker) => void = () => {};
  let callId = 7000;
  const { api } = createWorkerApi(
    {
      post: (m) => {
        sent.push(m);
        if (m.t === "req") {
          const value = answers[m.method]?.(m.params as Record<string, unknown>) ?? null;
          queueMicrotask(() => deliver({ t: "res", id: m.id, ok: true, value }));
        }
      },
      onMessage: (h) => (deliver = h),
    },
    { id: "acme.term", version: "1.0.0" },
  );
  const requests = (method: string) =>
    sent
      .filter((m): m is RequestMessage => m.t === "req" && m.method === method)
      .map((m) => m.params as Record<string, unknown>);
  const send = async (target: string, args: unknown) => {
    deliver({ t: "call", id: ++callId, kind: "provider", target, args });
    await tick();
  };
  return { api, requests, send };
}

test("toTerminalEvent: checks what the host sends", () => {
  assert.deepEqual(toTerminalEvent({ kind: "closed", reason: 3, code: 1 }), {
    kind: "closed",
    reason: 3,
    code: 1,
  });
  assert.deepEqual(toTerminalEvent({ kind: "started", pid: "x" }), { kind: "started", pid: null });
  assert.equal(toTerminalEvent({ kind: "nope" }), null);
});

test("createTerminal: unshown until show(); pid, active, typing and the user closing it", async () => {
  const h = fakeHost();
  const t = createTerminals(h.api, () => {});
  const opened: unknown[] = [];
  const closed: unknown[] = [];
  const actives: unknown[] = [];
  const states: unknown[] = [];
  t.onDidOpenTerminal((x) => opened.push(x));
  t.onDidCloseTerminal((x) => closed.push(x));
  t.onDidChangeActiveTerminal((x) => actives.push(x));
  t.onDidChangeTerminalState((x) => states.push(x));
  const term = t.createTerminal("Build");
  await tick();
  assert.equal(opened[0], term);
  const create = h.requests("terminals.create")[0];
  assert.equal(create?.background, true);
  assert.equal(create?.events, true);
  const id = String(create?.id);
  term.show();
  await tick();
  assert.equal(h.requests("terminals.show").length, 1);

  await h.send(`terminal.${id}`, { kind: "started", pid: 4242 });
  assert.equal(await term.processId, 4242);
  await h.send(`terminal.${id}`, { kind: "active", active: true });
  assert.equal(t.activeTerminal, term);
  assert.deepEqual(actives, [term]);
  await h.send(`terminal.${id}`, { kind: "interacted" });
  await h.send(`terminal.${id}`, { kind: "interacted" });
  assert.equal(term.state.isInteractedWith, true);
  assert.equal(states.length, 1);

  await h.send(`terminal.${id}`, { kind: "closed", reason: TerminalExitReason.User });
  assert.deepEqual(term.exitStatus, { code: undefined, reason: TerminalExitReason.User });
  assert.deepEqual(closed, [term]);
  assert.equal(t.terminals.length, 0);
  assert.equal(t.activeTerminal, undefined);
});

test("shell integration: executeCommand types the line; start and end events", async () => {
  const h = fakeHost();
  const t = createTerminals(h.api, () => {});
  const term = t.createTerminal({ name: "Shell" });
  await tick();
  const id = String(h.requests("terminals.create")[0]?.id);
  let changed = 0;
  t.onDidChangeTerminalShellIntegration(() => changed++);
  const before = term.shellIntegration;
  assert.equal(before, undefined);
  await h.send(`terminal.${id}`, { kind: "shellIntegration", cwd: "/ws" });
  assert.equal(changed, 1);
  const si = term.shellIntegration;
  assert.ok(si);
  const starts: unknown[] = [];
  const ends: { exitCode: number | undefined; execution: unknown }[] = [];
  t.onDidStartTerminalShellExecution((e) => starts.push(e.execution));
  t.onDidEndTerminalShellExecution((e) => ends.push(e));
  const run = si.executeCommand("npm", ["test"]);
  await tick();
  assert.equal(h.requests("terminals.sendText").at(-1)?.text, "npm test");
  assert.equal(run.commandLine.value, "npm test");
  await h.send(`terminal.${id}`, { kind: "commandStart", commandLine: "npm test", cwd: "/ws" });
  assert.equal(starts[0], run);
  const reading = (async () => {
    const chunks: string[] = [];
    for await (const c of run.read()) chunks.push(c);
    return chunks;
  })();
  await h.send(`terminal.${id}`, { kind: "commandEnd", commandLine: "npm test", exitCode: 1 });
  assert.equal(ends[0]?.execution, run);
  assert.equal(ends[0]?.exitCode, 1);
  assert.deepEqual(await reading, []);
  // A command the user typed: a new execution, its text as reported.
  await h.send(`terminal.${id}`, { kind: "commandStart", commandLine: "ls", cwd: "/ws" });
  const typed = starts[1] as { commandLine: { value: string; confidence: number } };
  assert.equal(typed.commandLine.value, "ls");
  assert.equal(typed.commandLine.confidence, 1);
});

test("a pseudoterminal closing itself ends the terminal (reason Extension)", async () => {
  const h = fakeHost();
  const t = createTerminals(h.api, () => {});
  const write = new EventEmitter<string>();
  const close = new EventEmitter<number | undefined>();
  const term = t.createTerminal({
    name: "Pty",
    pty: { onDidWrite: write.event, onDidClose: close.event, open() {}, close() {} },
  });
  await tick();
  const id = String(h.requests("terminals.create")[0]?.id);
  await h.send("pty.open", { ptyId: "x1", terminal: id, columns: 80, rows: 24 });
  close.fire(7);
  await tick();
  assert.deepEqual(term.exitStatus, { code: 7, reason: TerminalExitReason.Extension });
  assert.equal(t.terminals.length, 0);
  // dispose() later does nothing more.
  term.dispose();
  assert.equal(h.requests("terminals.dispose").length, 1);
});

test("the user's terminals are listed too; one opened later fires onDidOpenTerminal", async () => {
  const h = fakeHost({ "terminals.watchOthers": () => [{ id: "u1", name: "pwsh" }] });
  const t = createTerminals(h.api, () => {});
  const opened: { name: string }[] = [];
  t.onDidOpenTerminal((x) => opened.push(x as { name: string }));
  await tick();
  await tick();
  assert.deepEqual(
    t.terminals.map((x) => (x as { name: string }).name),
    ["pwsh"],
  );
  assert.equal(opened.length, 0);
  await h.send("terminals.others", { id: "u2", name: "bash" });
  assert.deepEqual(
    opened.map((x) => x.name),
    ["bash"],
  );
  const bash = opened[0] as unknown as { sendText(t: string): void; processId: Promise<unknown> };
  await h.send("terminal.u2", { kind: "started", pid: 77 });
  assert.equal(await bash.processId, 77);
  bash.sendText("echo hi");
  await tick();
  assert.deepEqual(h.requests("terminals.sendText").at(-1), {
    id: "u2",
    text: "echo hi",
    addNewLine: true,
  });
  // The user closes it.
  await h.send("terminal.u2", { kind: "closed", reason: TerminalExitReason.User });
  assert.equal(t.terminals.length, 1);
});

test("an execution's read(): what it printed so far, then the rest until it ends", async () => {
  const h = fakeHost({ "terminals.watchOthers": () => [{ id: "u1", name: "pwsh" }] });
  const t = createTerminals(h.api, () => {});
  await tick();
  await tick();
  const runs: { read(): AsyncIterable<string> }[] = [];
  t.onDidStartTerminalShellExecution((e) => runs.push(e.execution as (typeof runs)[number]));
  await h.send("terminal.u1", { kind: "shellIntegration", cwd: "/ws" });
  await h.send("terminal.u1", { kind: "commandStart", commandLine: "npm test", cwd: "/ws" });
  const run = runs[0];
  assert.ok(run);
  const reading = (async () => {
    const chunks: string[] = [];
    for await (const c of run.read()) chunks.push(c);
    return chunks;
  })();
  await tick();
  assert.deepEqual(h.requests("terminals.read").at(-1), { id: "u1" });
  await h.send("terminal.u1", { kind: "output", text: "ok 1" });
  await h.send("terminal.u1", { kind: "commandEnd", commandLine: "npm test", exitCode: 0 });
  assert.deepEqual(await reading, ["ok 1"]);
});
