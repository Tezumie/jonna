import assert from "node:assert/strict";
import { test } from "node:test";
import { type BuiltinExtension, ExtensionHost, validateManifest } from "./index";

type Services = { registered: Set<string> };

const ext = (
  id: string,
  commands: string[],
  register: string[],
  fail = false,
): BuiltinExtension<Services> => ({
  manifest: {
    id,
    version: "1.0.0",
    activation: ["*"],
    contributes: {
      commands: commands.map((c) => ({ id: c, title: c })),
      keybindings: [{ key: "ctrl+x", command: commands[0] ?? "none" }],
    },
  },
  activate: ({ services }) => {
    if (fail) throw new Error("boom");
    for (const c of register) services.registered.add(c);
  },
});

test("validates manifests", () => {
  assert.throws(
    () => validateManifest({ id: "NoDot", version: "1", activation: [] }),
    /invalid id/,
  );
  assert.throws(() => validateManifest({ id: "a.b", activation: [] }), /missing version/);
  assert.equal(
    validateManifest({ id: "builtin.explorer", version: "1", activation: ["*"] }).id,
    "builtin.explorer",
  );
});

test("activates in order, isolates failures and checks contributed commands", async () => {
  const services: Services = { registered: new Set() };
  const host = new ExtensionHost(services, (id) => services.registered.has(id));
  const all = [
    ext("builtin.good", ["good.run"], ["good.run"]),
    ext("builtin.liar", ["liar.run"], []),
    ext("builtin.broken", ["broken.run"], [], true),
  ];
  const status = await host.activateAll(all);
  assert.deepEqual(
    status.map((s) => [s.id, s.error === undefined]),
    [
      ["builtin.good", true],
      ["builtin.liar", false],
      ["builtin.broken", false],
    ],
  );
  assert.match(status[1]?.error ?? "", /did not register: liar\.run/);
  assert.equal(host.keybindings(all).length, 3);
  await assert.rejects(host.activateAll([ext("builtin.good", [], [])]), /Duplicate/);
});
