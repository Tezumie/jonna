import assert from "node:assert/strict";
import { test } from "node:test";
import {
  looksSandboxBlocked,
  planSandbox,
  readSandboxSetting,
  type SandboxInfo,
  sandboxResultNote,
  sandboxStartError,
} from "./sandbox";

const windows: SandboxInfo = {
  mechanism: "low-integrity",
  limitsWrites: true,
  limitsNetwork: false,
  note: "Windows: low integrity.",
};
const none: SandboxInfo = {
  mechanism: null,
  limitsWrites: false,
  limitsNetwork: false,
  note: "Linux without bubblewrap (bwrap): commands run with your full rights.",
};

test("D336: agent.sandbox is auto unless it says off", () => {
  assert.equal(readSandboxSetting(undefined), "off");
  assert.equal(readSandboxSetting("off"), "off");
  assert.equal(readSandboxSetting("weird"), "off");
  assert.equal(readSandboxSetting("auto"), "auto");
});

test("D336: a command runs sandboxed where the system has a sandbox", () => {
  const p = planSandbox({ setting: "auto", info: windows, requested: undefined, remote: false });
  assert.equal(p.sandboxed, true);
  assert.equal(p.outsideAsked, false);
  assert.match(p.card, /^In the sandbox: writes only in the folder.*network isn't limited/);
});

test("D336: sandbox: false runs outside and is asked; off and no sandbox run as before", () => {
  const out = planSandbox({ setting: "auto", info: windows, requested: false, remote: false });
  assert.deepEqual([out.sandboxed, out.outsideAsked], [false, true]);
  assert.match(out.card, /Outside the sandbox/);
  const off = planSandbox({ setting: "off", info: windows, requested: false, remote: false });
  assert.deepEqual([off.sandboxed, off.outsideAsked, off.card], [false, false, ""]);
  // No sandbox here: nothing to ask about, but the card says so.
  const no = planSandbox({ setting: "auto", info: none, requested: false, remote: false });
  assert.deepEqual([no.sandboxed, no.outsideAsked], [false, false]);
  assert.match(no.card, /^Not sandboxed: Linux without bubblewrap/);
  const remote = planSandbox({ setting: "auto", info: windows, requested: true, remote: true });
  assert.equal(remote.sandboxed, false);
  assert.match(remote.card, /remote or in WSL/);
  // Not known yet: run as before, say nothing.
  const unknown = planSandbox({ setting: "auto", info: null, requested: true, remote: false });
  assert.deepEqual([unknown.sandboxed, unknown.card], [false, ""]);
});

test("D336: a failure that looks like the sandbox's says how to run outside", () => {
  assert.equal(
    looksSandboxBlocked("Set-Content : Access to the path 'C:\\x\\y.txt' is denied."),
    true,
  );
  assert.equal(looksSandboxBlocked("touch: /etc/x: Read-only file system"), true);
  assert.equal(looksSandboxBlocked("npm ERR! code EPERM"), true);
  assert.equal(looksSandboxBlocked("1 test failed: expected 2, got 3"), false);
  const blocked = sandboxResultNote({
    info: windows,
    failed: true,
    output: "Access is denied.",
  });
  assert.match(blocked, /^\n\[sandboxed: /);
  assert.match(blocked, /sandbox: false — the user is asked first/);
  assert.doesNotMatch(blocked, /or the network/);
  const ok = sandboxResultNote({ info: windows, failed: false, output: "Access is denied." });
  assert.doesNotMatch(ok, /sandbox: false/);
  const failedOtherwise = sandboxResultNote({
    info: windows,
    failed: true,
    output: "tests failed",
  });
  assert.doesNotMatch(failedOtherwise, /sandbox: false/);
  assert.match(sandboxStartError("no LocalLow"), /didn't run: no LocalLow\n.*sandbox: false/);
});
