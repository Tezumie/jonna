// The shared Node host's lifecycle with a fake process (D295): one extension unloaded in place,
// one with native addons ending the process (planned) before its stop resolves, the last one
// ending it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FromWorker, Tagged, ToWorker } from "../../core/extensions/rpc";
import { SharedNodeHost } from "./sharedHost";
import type { HostTransport } from "./workerHost";

interface FakeProcess extends HostTransport {
  posted: Tagged<ToWorker>[];
  emit(message: Tagged<FromWorker>): void;
  terminated: boolean;
  /** Resolves the terminate() in progress (the process exited). */
  exit(): void;
}

function fakeProcess(): FakeProcess {
  const handlers: ((m: FromWorker) => void)[] = [];
  let exited: (() => void) | null = null;
  const fake: FakeProcess = {
    posted: [],
    terminated: false,
    post: (m) => fake.posted.push(m as Tagged<ToWorker>),
    onMessage: (h) => handlers.push(h),
    onError: () => {},
    terminate: () => {
      fake.terminated = true;
      return new Promise<void>((resolve) => {
        exited = resolve;
      });
    },
    emit: (m) => {
      for (const h of handlers) h(m as FromWorker);
    },
    exit: () => exited?.(),
  };
  return fake;
}

function hostWith(processes: FakeProcess[]) {
  const started: FakeProcess[] = [];
  const host = new SharedNodeHost(
    () => {},
    async () => {
      const next = processes.shift() ?? fakeProcess();
      started.push(next);
      return next;
    },
  );
  return { host, started };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("an extension without native addons unloads in place; the others stay", async () => {
  const { host, started } = hostWith([fakeProcess()]);
  const a = await host.connect("a.one", "node", "/exts/a.one");
  await host.connect("b.two", "node", "/exts/b.two");
  const crashes: boolean[] = [];
  host.onDidCrash((_e, planned) => crashes.push(planned));
  const stopped = a.terminate();
  const proc = started[0];
  assert.ok(proc);
  assert.ok(proc.posted.some((m) => m.t === "unload" && m.x === "a.one"));
  proc.emit({ t: "unloaded", x: "a.one" } as Tagged<FromWorker>);
  await stopped;
  assert.equal(proc.terminated, false);
  assert.deepEqual(crashes, []);
  assert.equal(host.size, 1);
  host.dispose();
});

test("native addons end the process (planned) before the stop resolves; the others are told", async () => {
  const { host, started } = hostWith([fakeProcess()]);
  const a = await host.connect("a.one", "node", "/exts/a.one");
  const b = await host.connect("b.two", "node", "/exts/b.two");
  const bErrors: string[] = [];
  b.onError((e) => bErrors.push(e));
  const crashes: boolean[] = [];
  host.onDidCrash((_e, planned) => crashes.push(planned));
  let resolved = false;
  const stopped = a.terminate()?.then(() => {
    resolved = true;
  });
  const proc = started[0];
  assert.ok(proc);
  proc.emit({ t: "unloaded", x: "a.one", native: ["C:/ext/a.one/x.node"] } as Tagged<FromWorker>);
  await settle();
  assert.equal(proc.terminated, true);
  assert.deepEqual(crashes, [true]);
  assert.equal(bErrors.length, 1);
  // Not before the old process exited (its files are locked until then).
  assert.equal(resolved, false);
  proc.exit();
  await stopped;
  assert.equal(resolved, true);
  // The others start again in a new process.
  await host.connect("b.two", "node", "/exts/b.two");
  assert.equal(started.length, 2);
  host.dispose();
});

test("the last extension leaving ends the process", async () => {
  const { host, started } = hostWith([fakeProcess()]);
  const a = await host.connect("a.one", "node", "/exts/a.one");
  const stopped = a.terminate();
  const proc = started[0];
  assert.ok(proc);
  proc.emit({ t: "unloaded", x: "a.one" } as Tagged<FromWorker>);
  await settle();
  assert.equal(proc.terminated, true);
  proc.exit();
  await stopped;
  assert.equal(host.size, 0);
  host.dispose();
});
