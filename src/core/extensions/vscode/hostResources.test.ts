// An extension's timers and native addons in the shared Node host (D295): its timers are cleared
// when it's unloaded, others' keep running; its native addons are reported (the host restarts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { promisify } from "node:util";
import { ExtensionResources, type TimerGlobals } from "./hostResources";

function globalsFor(): TimerGlobals {
  return {
    setTimeout: setTimeout as unknown as TimerGlobals["setTimeout"],
    clearTimeout: clearTimeout as unknown as TimerGlobals["clearTimeout"],
    setInterval: setInterval as unknown as TimerGlobals["setInterval"],
    clearInterval: clearInterval as unknown as TimerGlobals["clearInterval"],
    setImmediate: setImmediate as unknown as TimerGlobals["setImmediate"],
    clearImmediate: clearImmediate as unknown as TimerGlobals["clearImmediate"],
  };
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("an unloaded extension's timers stop; another's keep running", async () => {
  const resources = new ExtensionResources();
  const globals = globalsFor();
  let owner: string | undefined = "a.one";
  const restore = resources.trackTimers(globals, () => owner);
  try {
    let aFired = 0;
    let bFired = 0;
    globals.setInterval(() => aFired++, 5);
    globals.setTimeout(() => aFired++, 20);
    owner = "b.two";
    const b = globals.setInterval(() => bFired++, 5);
    owner = undefined;
    // Not an extension's (the host's own): not tracked.
    let hostFired = false;
    globals.setTimeout(() => {
      hostFired = true;
    }, 1);
    assert.equal(resources.timerCount("A.One"), 2);
    assert.deepEqual(resources.release("a.one"), { native: [], timers: 2 });
    const before = aFired;
    await tick(40);
    assert.equal(aFired, before, "a's timers were cleared");
    assert.ok(bFired > 0, "b's interval runs on");
    assert.ok(hostFired);
    globals.clearInterval(b);
    assert.equal(resources.timerCount("b.two"), 0);
  } finally {
    restore();
  }
});

test("a timer that ran is forgotten; promisified setTimeout still works", async () => {
  const resources = new ExtensionResources();
  const globals = globalsFor();
  const restore = resources.trackTimers(globals, () => "a.one");
  try {
    let fired = false;
    globals.setTimeout(() => {
      fired = true;
    }, 1);
    globals.setImmediate?.(() => {});
    await tick(10);
    assert.ok(fired);
    assert.equal(resources.timerCount("a.one"), 0);
    // Node's promisify.custom is kept on the replacement.
    const wait = promisify(globals.setTimeout as unknown as typeof setTimeout);
    assert.equal(await wait(1, "done"), "done");
  } finally {
    restore();
  }
});

test("native addons are remembered by extension and reported on release", () => {
  const resources = new ExtensionResources();
  resources.addNative("Pub.Native", "C:/ext/pub.native/build/addon.node");
  resources.addNative(undefined, "C:/elsewhere/x.node");
  assert.deepEqual(resources.nativeOf("pub.native"), ["C:/ext/pub.native/build/addon.node"]);
  assert.deepEqual(resources.release("pub.native"), {
    native: ["C:/ext/pub.native/build/addon.node"],
    timers: 0,
  });
  assert.deepEqual(resources.nativeOf("pub.native"), []);
});
