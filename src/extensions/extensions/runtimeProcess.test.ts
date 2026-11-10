// A process an extension asks for while the trust question is up doesn't start for a worker that
// is gone (D391).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { signal } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { ExtensionProcesses } from "./runtimeProcess";

test("a spawn waiting for the trust question doesn't start once its worker went", async () => {
  let answer: () => void = () => {};
  const services = {
    workspace: {
      root: signal<string | null>("/ws"),
      onDidClose: () => ({ dispose() {} }),
      resolve: (p: string) => p,
      contains: () => true,
      folders: signal([]),
    },
    trust: {
      state: signal("trusted"),
      require: () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    },
  } as unknown as WorkbenchServices;
  const processes = new ExtensionProcesses({
    manifest: { id: "demo.ext", displayName: "Demo" } as ThirdPartyManifest,
    services,
    root: "/ext",
    need: () => {},
    post: () => {},
  });
  const spawned = processes.handle("process.spawn", { id: "p1", command: "node" }) as Promise<void>;
  // The worker crashes while the user is asked; the new one counts from p1 again.
  processes.killAll(true);
  answer();
  await assert.rejects(spawned, /has stopped/);
  assert.equal(processes.count, 0);
  processes.dispose();
});
