// D295: the shared host's registry and `vscode.extensions`: live exports, isActive, onDidChange,
// whose file is whose, and the vscode.ipynb stand-in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SharedExtensionRegistry, stackFiles } from "./extensionRegistry";
import { createExtensionsApi, createIpynbExtension, type ShimExtension } from "./extensionsApi";
import { NotebookCellData, NotebookData } from "./workbenchTypes";

test("D295: whose folder a file is in (the deepest), case-folded on Windows", () => {
  const r = new SharedExtensionRegistry("win32");
  r.setInstalled([
    { id: "ms-python.python", path: "C:\\exts\\ms-python.python-2025.1.0", hasCode: true },
    { id: "acme.nested", path: "C:\\exts\\ms-python.python-2025.1.0\\nested", hasCode: true },
  ]);
  assert.equal(r.ownerOf("c:/EXTS/ms-python.python-2025.1.0/out/client.js"), "ms-python.python");
  assert.equal(r.ownerOf("C:\\exts\\ms-python.python-2025.1.0\\nested\\a.js"), "acme.nested");
  assert.equal(r.ownerOf("C:\\exts\\ms-python.python-2025.1.0x\\a.js"), undefined);
  const posix = new SharedExtensionRegistry("linux");
  posix.addRunning("acme.a", "/home/u/.ext/acme.a");
  assert.equal(posix.ownerOf("/home/u/.ext/acme.a/out/x.js"), "acme.a");
  assert.equal(posix.ownerOf("/home/u/.ext/ACME.a/out/x.js"), undefined);
  // A folder given with ".." (loaded from "…/sample/../extensions/x"): stacks name the real path.
  const dotted = new SharedExtensionRegistry("win32");
  dotted.addRunning("acme.hello", "C:\\tmp\\ui\\sample/../extensions/vscodehello");
  assert.equal(dotted.ownerOf("C:\\tmp\\ui\\extensions\\vscodehello\\extension.js"), "acme.hello");
  assert.equal(dotted.ownerOf("C:\\tmp\\ui\\sample\\extension.js"), undefined);
});

test("D295: the files on a V8 stack trace", () => {
  const stack = [
    "Error",
    "    at log (C:\\data\\extension-host\\host.js:10:5)",
    "    at Object.activate (C:\\exts\\acme.a\\out\\extension.js:3:9)",
    "    at /home/u/.ext/acme.b/main.js:1:2",
    "    at new Promise (<anonymous>)",
  ].join("\n");
  assert.deepEqual(stackFiles(stack), [
    "C:\\data\\extension-host\\host.js",
    "C:\\exts\\acme.a\\out\\extension.js",
    "/home/u/.ext/acme.b/main.js",
  ]);
  const r = new SharedExtensionRegistry("win32");
  r.setInstalled([{ id: "acme.a", path: "C:\\exts\\acme.a", hasCode: true }]);
  assert.equal(r.ownerOfStack(stack), "acme.a");
});

function api(registry: SharedExtensionRegistry, activated: string[] = []) {
  return createExtensionsApi({
    selfId: "acme.self",
    selfPath: "/ext/self",
    selfPackage: { publisher: "Acme", name: "self" },
    registry,
    readPackage: (path) => ({ publisher: "Acme", name: path.split("/").pop() }),
    activate: async (id) => {
      activated.push(id);
      // The IDE starts it in the shared host: its activate returns its exports.
      registry.setActive(id, { api: `${id} api`, sync: () => 42 });
    },
    builtIns: { "vscode.ipynb": createIpynbExtension() },
  });
}

test("D295: another extension's exports are its live object once active", async () => {
  const registry = new SharedExtensionRegistry("linux");
  registry.setInstalled([
    { id: "acme.self", path: "/ext/self", hasCode: true },
    { id: "acme.other", path: "/ext/other", hasCode: true },
    { id: "acme.themes", path: "/ext/themes", hasCode: false },
  ]);
  const activated: string[] = [];
  const { api: extensions, self } = api(registry, activated);
  let changes = 0;
  extensions.onDidChange(() => changes++);
  const other = extensions.getExtension("Acme.Other") as ShimExtension;
  assert.equal(other.id, "Acme.other");
  assert.equal(other.isActive, false);
  assert.equal(other.exports, undefined);
  assert.equal(other.extensionKind, 1);
  const exports = (await other.activate()) as { sync(): number };
  assert.deepEqual(activated, ["acme.other"]);
  // The same object, with synchronous functions.
  assert.equal(exports.sync(), 42);
  assert.equal(other.exports, exports);
  assert.equal(other.isActive, true);
  assert.ok(changes >= 1);
  // Active already: no second activation.
  await other.activate();
  assert.deepEqual(activated, ["acme.other"]);
  // One without code is active as soon as asked.
  const themes = extensions.getExtension("acme.themes") as ShimExtension;
  assert.equal(await themes.activate(), undefined);
  assert.equal(themes.isActive, true);
  assert.deepEqual(activated, ["acme.other"]);
  // Every installed one, itself first, the built-ins too; one not installed is undefined.
  const ids = extensions.all.map((e) => (e as { id: string }).id);
  assert.deepEqual(ids, ["Acme.self", "vscode.ipynb", "Acme.other", "Acme.themes"]);
  assert.equal(extensions.getExtension("acme.missing"), undefined);
  assert.equal(extensions.getExtension("acme.self"), self);
  // Its own: active once its activate returned.
  assert.equal(self.isActive, false);
  registry.setActive("acme.self", { mine: true });
  assert.deepEqual(self.exports, { mine: true });
  // Uninstalled: gone from the list.
  registry.setInstalled([{ id: "acme.self", path: "/ext/self", hasCode: true }]);
  assert.equal(extensions.getExtension("acme.other"), undefined);
});

test("D295: vscode.ipynb exports a notebook as the IDE writes .ipynb", async () => {
  const ipynb = createIpynbExtension() as {
    exports: { dropCustomMetadata: boolean; exportNotebook(d: NotebookData): Promise<string> };
  };
  assert.equal(ipynb.exports.dropCustomMetadata, true);
  const code = new NotebookCellData(2, "print(1)\nprint(2)", "python");
  code.metadata = { tags: ["x"] };
  code.executionSummary = { executionOrder: 3 };
  const md = new NotebookCellData(1, "# Title", "markdown");
  const data = new NotebookData([code, md]);
  data.metadata = { kernelspec: { name: "python3" }, language_info: { name: "python" } };
  const text = await ipynb.exports.exportNotebook(data);
  const json = JSON.parse(text) as {
    cells: { cell_type: string; source: string[]; metadata: unknown; execution_count?: number }[];
    metadata: { kernelspec: { name: string } };
    nbformat: number;
  };
  assert.equal(json.nbformat, 4);
  assert.equal(json.metadata.kernelspec.name, "python3");
  assert.equal(json.cells[0]?.cell_type, "code");
  assert.deepEqual(json.cells[0]?.source, ["print(1)\n", "print(2)"]);
  assert.deepEqual(json.cells[0]?.metadata, { tags: ["x"] });
  assert.equal(json.cells[0]?.execution_count, 3);
  assert.equal(json.cells[1]?.cell_type, "markdown");
});
