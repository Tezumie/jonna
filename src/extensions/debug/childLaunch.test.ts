// D229: DAP startDebugging's child configuration, instruction breakpoints.
import assert from "node:assert/strict";
import { test } from "node:test";
import { childLaunchConfig, dapLaunchArguments, toConfig } from "./launch";
import { OtherBreakpoints, sameAddress } from "./otherBreakpoints";

const v = { workspaceFolder: "/w", pathSeparator: "/" };

test("startDebugging: the adapter's configuration as it is, with the parent's type and adapter", () => {
  const parent = toConfig(
    {
      name: "App",
      type: "debugpy",
      request: "launch",
      program: "/w/app.py",
      python: "/venv/bin/python",
      args: ["--x"],
      subProcess: true,
    },
    "launch.json",
    v,
  );
  if (!parent) throw new Error("no parent");
  const child = childLaunchConfig(
    parent,
    {
      name: "Subprocess 4242",
      connect: { host: "127.0.0.1", port: 5678 },
      subProcessId: 4242,
      cwd: "${workspaceFolder}",
    },
    "attach",
  );
  assert.equal(child.type, "debugpy");
  assert.equal(child.request, "attach");
  assert.equal(child.name, "Subprocess 4242");
  assert.equal(child.verbatim, true);
  // The adapter's values aren't variables to fill; the IDE's defaults aren't added.
  assert.deepEqual(dapLaunchArguments(child), {
    python: "/venv/bin/python",
    name: "Subprocess 4242",
    connect: { host: "127.0.0.1", port: 5678 },
    subProcessId: 4242,
    cwd: "${workspaceFolder}",
    type: "debugpy",
    request: "attach",
  });
  // A custom adapter goes to the child too (not as an argument); a nameless child is named.
  const custom = toConfig(
    { name: "Mine", type: "mydbg", request: "launch", debugAdapter: { command: "mydbg-dap" } },
    "launch.json",
    v,
  );
  if (!custom) throw new Error("no config");
  const c2 = childLaunchConfig(custom, { __pendingTargetId: "t1" }, "launch");
  assert.equal(c2.name, "Mine: child");
  assert.deepEqual(c2.debugAdapter, { command: "mydbg-dap", args: [] });
  assert.equal("debugAdapter" in dapLaunchArguments(c2), false);
  // A launch.json configuration still gets the IDE's defaults.
  assert.deepEqual(dapLaunchArguments(parent).args, ["--x"]);
});

test("instruction breakpoints: toggled by address, same address in any spelling", () => {
  assert.equal(sameAddress("0x00401A2C", "0x401a2c"), true);
  assert.equal(sameAddress("0x10", "0x11"), false);
  assert.equal(sameAddress("main+4", "MAIN+4"), true);
  const o = new OtherBreakpoints();
  assert.equal(o.toggleInstruction("0x401a2c"), true);
  assert.equal(o.instructions.peek().length, 1);
  const id = o.instructions.peek()[0]?.id ?? -1;
  o.updateInstruction(id, { verified: true });
  o.clearVerification();
  assert.equal(o.instructions.peek()[0]?.verified, undefined);
  assert.equal(o.toggleInstruction("0x00401A2C"), false);
  assert.equal(o.instructions.peek().length, 0);
  assert.throws(() => o.toggleInstruction("  "));
});
