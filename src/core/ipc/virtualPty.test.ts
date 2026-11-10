import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasVirtualPty,
  isVirtualPty,
  killVirtualPty,
  registerVirtualPty,
  resizeVirtualPty,
  spawnVirtualPty,
  VIRTUAL_PTY_BASE,
  writeVirtualPty,
} from "./virtualPty";

test("virtual pty: spawn, output, input, resize and kill go to the session", async () => {
  const log: string[] = [];
  let out = (_text: string): void => {};
  const off = registerVirtualPty(
    "k1",
    (size, handlers) => {
      log.push(`open ${size.cols}x${size.rows}`);
      out = (text) => handlers.onData(new TextEncoder().encode(text));
      return {
        input: (d) => log.push(`in ${d}`),
        resize: (c, r) => log.push(`size ${c}x${r}`),
        close: () => log.push("close"),
      };
    },
    "Echo",
  );
  const received: string[] = [];
  const info = await spawnVirtualPty("k1", 80, 24, {
    onData: (b) => received.push(new TextDecoder().decode(b)),
    onExit: () => received.push("exit"),
  });
  assert.ok(isVirtualPty(info.id));
  assert.ok(info.id > VIRTUAL_PTY_BASE);
  assert.equal(info.shell, "Echo");
  assert.equal(info.integration, false);
  out("hi");
  writeVirtualPty(info.id, "x");
  resizeVirtualPty(info.id, 100, 30);
  killVirtualPty(info.id);
  // After the kill, nothing reaches the session.
  writeVirtualPty(info.id, "y");
  assert.deepEqual(log, ["open 80x24", "in x", "size 100x30", "close"]);
  assert.deepEqual(received, ["hi"]);
  off.dispose();
  assert.equal(hasVirtualPty("k1"), false);
  await assert.rejects(spawnVirtualPty("k1", 80, 24, { onData: () => {}, onExit: () => {} }));
});

test("virtual pty: an exit ends the session once; output after it is dropped", async () => {
  let handlersOf: { onData(b: Uint8Array): void; onExit(c: number): void } | null = null;
  const off = registerVirtualPty("k2", (_size, handlers) => {
    handlersOf = handlers;
    return { input: () => {}, resize: () => {}, close: () => {} };
  });
  const events: string[] = [];
  await spawnVirtualPty("k2", 80, 24, {
    onData: () => events.push("data"),
    onExit: (code) => events.push(`exit ${code}`),
  });
  const h = handlersOf as unknown as { onData(b: Uint8Array): void; onExit(c: number): void };
  h.onExit(2);
  h.onExit(3);
  h.onData(new Uint8Array([65]));
  assert.deepEqual(events, ["exit 2"]);
  off.dispose();
});
