import assert from "node:assert/strict";
import { test } from "node:test";
import { type KernelSource, NotebookProviders, type NotebookSerializer } from "./providers";

const serializer: NotebookSerializer = {
  deserialize: () => ({ cells: [], metadata: {}, nbformat: 4, nbformatMinor: 5, extra: {} }),
  serialize: () => "",
};

const source = (id: string, types?: string[], fail = false): KernelSource => ({
  id,
  label: id,
  ...(types && { notebookTypes: types }),
  find: async () => {
    if (fail) throw new Error("no");
    return [{ source: "ignored", id: `${id}-1`, label: `${id} kernel`, detail: "", language: "x" }];
  },
  create: () => {
    throw new Error("not in this test");
  },
});

test("notebook types by file extension (D202)", () => {
  const p = new NotebookProviders();
  let changes = 0;
  p.onDidChange(() => changes++);
  const a = p.registerType({
    id: "jupyter-notebook",
    label: "Jupyter",
    extensions: [".ipynb"],
    serializer,
    owner: "builtin",
    opensByDefault: true,
  });
  p.registerType({
    id: "toy",
    label: "Toy",
    extensions: [".toynb"],
    serializer,
    owner: "ext",
    opensByDefault: false,
  });
  // Another type can't take .ipynb files.
  assert.throws(
    () =>
      p.registerType({
        id: "grab",
        label: "",
        extensions: [".IPYNB".toLowerCase()],
        serializer,
        owner: "x",
        opensByDefault: true,
      }),
    /already belong/,
  );
  assert.equal(p.typeFor("/a/b/Report.IPYNB")?.id, "jupyter-notebook");
  assert.equal(p.typeFor("C:\\x\\q.toynb")?.id, "toy");
  assert.equal(p.typeFor("/a/.ipynb"), undefined);
  assert.equal(p.typeFor("/a/readme"), undefined);
  assert.throws(() =>
    p.registerType({
      id: "toy",
      label: "",
      extensions: [],
      serializer,
      owner: "x",
      opensByDefault: false,
    }),
  );
  a.dispose();
  assert.equal(p.typeFor("/a.ipynb"), undefined);
  assert.equal(changes, 3);
});

test("kernels from the sources for a notebook type; a failing source is skipped", async () => {
  const p = new NotebookProviders();
  p.registerKernelSource(source("everywhere"));
  p.registerKernelSource(source("jupyter", ["jupyter-notebook"]));
  p.registerKernelSource(source("broken", undefined, true));
  const ctx = { root: "/r", path: "/r/a.ipynb", notebookType: "jupyter-notebook" };
  const found = await p.findKernels(ctx);
  assert.deepEqual(
    found.map((k) => [k.source, k.id]),
    [
      ["jupyter", "jupyter-1"],
      ["everywhere", "everywhere-1"],
    ],
  );
  const toy = await p.findKernels({ ...ctx, notebookType: "toy" });
  assert.deepEqual(
    toy.map((k) => k.source),
    ["everywhere"],
  );
  assert.throws(() => p.registerKernelSource(source("jupyter")));
});

test("D204: the longest file ending wins; renderers by mime; cell status items", async () => {
  const p = new NotebookProviders();
  const type = (id: string, extensions: string[]) =>
    p.registerType({ id, label: id, extensions, serializer, owner: "x", opensByDefault: false });
  type("py-notebook", [".nb.py"]);
  type("plain", [".py"]);
  assert.equal(p.typeFor("/r/a.nb.py")?.id, "py-notebook");
  assert.equal(p.typeFor("/r/a.py")?.id, "plain");
  assert.equal(p.typeFor("/r/.nb.py")?.id, "plain");

  const renderer = (id: string, mimeTypes: string[]) => ({
    id,
    owner: "acme.x",
    displayName: id,
    mimeTypes,
    code: async () => "",
    network: () => "none" as const,
    receive: () => {},
  });
  const r = p.registerRenderer(renderer("acme.x.chart", ["application/vnd.acme+json"]));
  assert.throws(() => p.registerRenderer(renderer("acme.x.chart", [])), /already/);
  assert.equal(
    p.rendererFor(["text/plain", "application/vnd.acme+json"])?.mime,
    "application/vnd.acme+json",
  );
  assert.equal(p.rendererFor(["text/html"]), undefined);
  const posts: unknown[] = [];
  p.onRendererMessage((m) => posts.push(m));
  p.postToRenderer("acme.x.chart", { hi: 1 }, "/r/a.ipynb");
  assert.deepEqual(posts, [{ renderer: "acme.x.chart", message: { hi: 1 }, path: "/r/a.ipynb" }]);
  r.dispose();
  assert.equal(p.rendererFor(["application/vnd.acme+json"]), undefined);

  let asked = 0;
  p.onDidChangeStatusProviders(() => asked++);
  const context = {
    path: "/r/a.ipynb",
    notebookType: "jupyter.notebook",
    cell: {
      id: "c",
      index: 0,
      kind: "code",
      language: "python",
      source: "",
      metadata: {},
      executionCount: null,
      outputs: 0,
    },
  };
  p.registerCellStatusProvider({ owner: "a", provide: async () => [{ text: "everywhere" }] });
  p.registerCellStatusProvider({
    owner: "b",
    notebookTypes: ["other"],
    provide: async () => [{ text: "not here" }],
  });
  p.registerCellStatusProvider({
    owner: "c",
    provide: async () => {
      throw new Error("broken");
    },
  });
  assert.deepEqual(
    (await p.cellStatusItems(context)).map((i) => i.text),
    ["everywhere"],
  );
  assert.equal(asked, 3);
});

test("an open notebook's cells are found by id (extensions' diagnostics for cells)", () => {
  const p = new NotebookProviders();
  assert.equal(p.cellIndex("/n.ipynb", "a"), undefined);
  const located = p.registerCellLocator((path, id) =>
    path === "/n.ipynb" ? ["a", "b"].indexOf(id) : undefined,
  );
  assert.equal(p.cellIndex("/n.ipynb", "b"), 1);
  located.dispose();
  assert.equal(p.cellIndex("/n.ipynb", "b"), undefined);
});
