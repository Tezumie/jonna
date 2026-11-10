// VS Code packages' shared registries (D295), split from the manager: one command registry,
// shared view containers, the `vscode.extensions` list.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThirdPartyManifest } from "../../core/extensions/thirdParty";
import {
  CodeCommandOwners,
  findViewContainer,
  type LoadedExtension,
  routeVscodeCommand,
  vscodePackageList,
} from "./crossExtension";

function manifest(id: string, extra: Record<string, unknown> = {}): ThirdPartyManifest {
  return {
    id,
    format: "vscode",
    main: "out/extension.js",
    contributes: { commands: [], viewContainers: [] },
    ...extra,
  } as unknown as ThirdPartyManifest;
}

function loaded(m: ThirdPartyManifest, ran: string[] = []): LoadedExtension {
  return {
    manifest: m,
    root: `/ext/${m.id}`,
    runCodeCommand: async (id) => {
      ran.push(`${m.id}:${id}`);
      return id;
    },
  };
}

test("a declared command by its VS Code id, one registered in code through its owner", async () => {
  const ran: string[] = [];
  const jupyter = manifest("ms-toolsai.jupyter", {
    contributes: {
      commands: [{ id: "ms-toolsai.jupyter.run", vscodeId: "jupyter.run" }],
      viewContainers: [],
    },
  });
  const python = manifest("ms-python.python");
  const map = new Map([
    [jupyter.id, loaded(jupyter, ran)],
    [python.id, loaded(python, ran)],
  ]);
  const owners = new CodeCommandOwners();
  owners.announce(python.id, "python.hidden", () => true);
  // A second owner while the first runs is refused (VS Code's), and `_` ids aren't announced.
  owners.announce(jupyter.id, "python.hidden", (id) => map.has(id));
  owners.announce(python.id, "_private", () => true);
  assert.equal(owners.ownerOf("python.hidden"), python.id);
  assert.equal(owners.ownerOf("_private"), undefined);

  assert.deepEqual(routeVscodeCommand(map, owners, python.id, "jupyter.run", [1]), {
    command: "ms-toolsai.jupyter.run",
    input: { arguments: [1] },
  });
  const route = routeVscodeCommand(map, owners, jupyter.id, "python.hidden", []);
  assert.ok(route && "run" in route);
  await route.run();
  assert.deepEqual(ran, ["ms-python.python:python.hidden"]);
  // Its own command isn't routed back to the caller; unknown ids aren't anyone's.
  assert.equal(routeVscodeCommand(map, owners, python.id, "python.hidden", []), undefined);
  assert.equal(routeVscodeCommand(map, owners, python.id, "nobody.has", []), undefined);
  owners.forget(python.id);
  assert.equal(owners.ownerOf("python.hidden"), undefined);
});

test("view containers of other enabled packages, loaded or being read", () => {
  const jupyter = manifest("ms-toolsai.jupyter", {
    contributes: { commands: [], viewContainers: [{ id: "jupyter", title: "Jupyter" }] },
  });
  const tags = manifest("ms-toolsai.cell-tags");
  assert.equal(findViewContainer([loaded(jupyter)], [], [], tags.id, "jupyter")?.id, "jupyter");
  const reading = [{ id: jupyter.id, root: "/ext/j", status: "active", manifest: jupyter }];
  assert.equal(findViewContainer([], reading, [], tags.id, "jupyter")?.id, "jupyter");
  // Disabled, or the caller's own: not found here.
  assert.equal(findViewContainer([], reading, [jupyter.id], tags.id, "jupyter"), undefined);
  assert.equal(findViewContainer([loaded(jupyter)], [], [], jupyter.id, "jupyter"), undefined);
});

test("vscode.extensions lists enabled packages and those starting", () => {
  const a = manifest("a.one");
  const b = manifest("b.two", { main: undefined });
  const ownFormat = manifest("c.three", { format: "ide" });
  const records = [
    { id: "a.one", root: "/ext/a", status: "active", manifest: a },
    { id: "x.off", root: "/ext/x", status: "disabled", manifest: manifest("x.off") },
    { id: "c.three", root: "/ext/c", status: "active", manifest: ownFormat },
  ];
  assert.deepEqual(vscodePackageList(records, [loaded(b)]), [
    { id: "a.one", path: "/ext/a", hasCode: true },
    { id: "b.two", path: "/ext/b.two", hasCode: false },
  ]);
});
