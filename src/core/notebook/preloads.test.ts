// D295: VS Code's notebookPreload contributions, controllers' output pages and their messages,
// and Jupyter widgets drawn by an extension's renderer only in such a page.
import assert from "node:assert/strict";
import { test } from "node:test";
import { notebookPreloads } from "./preloads";
import { NotebookProviders, type NotebookRenderer, WIDGET_VIEW } from "./providers";

test("D295: notebookPreload contributions are read from a package.json", () => {
  const list = notebookPreloads({
    contributes: {
      notebookPreload: [
        {
          type: "jupyter-notebook",
          entrypoint: "./dist/webviews/kernel.js",
          localResourceRoots: ["./temp", "../outside"],
        },
        { type: "interactive", entrypoint: "out\\preload.js" },
        { type: "x", entrypoint: "../escape.js" },
        { type: "x", entrypoint: "C:/abs.js" },
        { entrypoint: "no-type.js" },
        "junk",
      ],
    },
  });
  assert.deepEqual(list, [
    {
      type: "jupyter-notebook",
      entrypoint: "dist/webviews/kernel.js",
      localResourceRoots: ["temp"],
    },
    { type: "interactive", entrypoint: "out/preload.js", localResourceRoots: [] },
  ]);
  assert.deepEqual(notebookPreloads({}), []);
  assert.deepEqual(notebookPreloads(null), []);
});

const renderer = (id: string, mimeTypes: string[]): NotebookRenderer => ({
  id,
  owner: "acme",
  displayName: id,
  mimeTypes,
  code: async () => "",
  network: () => "none",
  receive: () => {},
});

test("D295: widget outputs go to an extension's renderer only in a controller's page", () => {
  const p = new NotebookProviders();
  p.registerRenderer(renderer("jupyter-ipywidget-renderer", [WIDGET_VIEW]));
  p.registerRenderer(renderer("images", ["image/png"]));
  const mimes = ["text/plain", WIDGET_VIEW];
  assert.equal(p.rendererFor(mimes), undefined);
  assert.equal(p.rendererFor(mimes, { widgets: true })?.renderer.id, "jupyter-ipywidget-renderer");
  assert.equal(p.rendererFor(["image/png"])?.mime, "image/png");
  assert.equal(p.renderer("images")?.id, "images");
});

test("D295: a controller's messages reach its notebooks' pages (one notebook's with a path)", () => {
  const p = new NotebookProviders();
  const got: string[] = [];
  const page = (name: string, source: string | null, path: string) =>
    p.registerKernelPage({
      source: () => source,
      path: () => path,
      post: (m) => {
        got.push(`${name}:${String(m)}`);
        return true;
      },
    });
  page("a", "ms-toolsai.jupyter/k", "/w/a.ipynb");
  page("b", "ms-toolsai.jupyter/k", "/w/b.ipynb");
  const other = page("c", "bundled.jupyter/jupyter", "/w/c.ipynb");
  assert.equal(p.postToKernelPages("ms-toolsai.jupyter/k", "all"), true);
  assert.equal(p.postToKernelPages("ms-toolsai.jupyter/k", "one", "/w/b.ipynb"), true);
  assert.equal(p.postToKernelPages("nobody/k", "none"), false);
  other.dispose();
  assert.equal(p.postToKernelPages("bundled.jupyter/jupyter", "gone"), false);
  assert.deepEqual(got, ["a:all", "b:all", "b:one"]);
});

test("D295: every extension's preloads for a notebook type, a failing one left out", async () => {
  const p = new NotebookProviders();
  const preload = (id: string) => ({
    id,
    owner: "x",
    notebookType: "jupyter.notebook",
    code: async () => id,
    network: () => "any" as const,
  });
  p.registerPreloadSource({ owner: "a", preloads: async () => [preload("a/k.js")] });
  p.registerPreloadSource({
    owner: "b",
    preloads: async () => {
      throw new Error("broken package.json");
    },
  });
  const c = p.registerPreloadSource({
    owner: "c",
    preloads: async (type) => (type === "jupyter.notebook" ? [preload("c/w7.js")] : []),
  });
  assert.deepEqual(
    (await p.preloadsFor("jupyter.notebook")).map((x) => x.id),
    ["a/k.js", "c/w7.js"],
  );
  c.dispose();
  assert.deepEqual(
    (await p.preloadsFor("jupyter.notebook")).map((x) => x.id),
    ["a/k.js"],
  );
});
