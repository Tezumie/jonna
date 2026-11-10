import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyRangeEdit,
  completionColumns,
  ExtensionFeatures,
  resourceContext,
  terminalEnvVars,
  toHoverAnswer,
} from "./extensionFeatures";

test("range edits: columns, whole lines, clamping, CRLF (D176)", () => {
  const text = "alpha\nbeta\ngamma";
  assert.equal(
    applyRangeEdit(text, { startLine: 2, startColumn: 1, endColumn: 5 }, "BETA"),
    "alpha\nBETA\ngamma",
  );
  assert.equal(applyRangeEdit(text, { startLine: 1, endLine: 2 }, "x"), "x\ngamma");
  assert.equal(applyRangeEdit(text, { startLine: 3, startColumn: 6 }, "!"), "alpha\nbeta\ngamma!");
  assert.equal(
    applyRangeEdit(text, { startLine: 99, startColumn: 99 }, "!"),
    "alpha\nbeta\ngamma!",
  );
  assert.equal(applyRangeEdit("a\r\nb\r\n", { startLine: 1 }, "A"), "A\r\nb\r\n");
  assert.equal(applyRangeEdit("", { startLine: 1 }, "new"), "new");
});

test("extension features: decorations replaced per key, menus filtered by when (D176)", () => {
  const f = new ExtensionFeatures();
  const ranges = [{ startLine: 1 }];
  f.setDecorations({ owner: "a.b", key: "k", path: "/x", style: "highlight", ranges });
  f.setDecorations({ owner: "a.b", key: "k", path: "/x", style: "warning", ranges });
  f.setDecorations({ owner: "c.d", key: "k", path: "/x", style: "info", ranges });
  assert.deepEqual(
    f.decorations.peek().map((d) => [d.owner, d.style]),
    [
      ["a.b", "warning"],
      ["c.d", "info"],
    ],
  );
  f.setDecorations({ owner: "a.b", key: "k", path: "/x", style: "warning", ranges: [] });
  assert.equal(f.decorations.peek().length, 1);
  f.clearDecorations("c.d");
  assert.equal(f.decorations.peek().length, 0);
  const off = f.addMenus([
    {
      owner: "a.b",
      location: "explorer/context",
      command: "b.one",
      title: "One",
      when: "explorerResourceIsFolder",
    },
    {
      owner: "a.b",
      location: "explorer/context",
      command: "b.two",
      title: "Two",
      when: "bad &&& when",
    },
    { owner: "a.b", location: "editor/context", command: "b.three", title: "Three" },
  ]);
  const ctx = resourceContext("/w/src", true);
  const items = f.menuItems(
    "explorer/context",
    (when) =>
      !when ||
      Boolean(ctx[when as keyof typeof ctx]) ||
      (() => {
        throw new Error("bad");
      })(),
  );
  assert.deepEqual(
    items.map((i) => i.command),
    ["b.one"],
  );
  off.dispose();
  assert.equal(f.menus.peek().length, 0);
  assert.deepEqual(resourceContext("/w/a.TS", false, "typescript"), {
    explorerResourceIsFolder: false,
    resourceFilename: "a.TS",
    resourceExtname: ".ts",
    resourceLangId: "typescript",
    resourcePath: "/w/a.TS",
  });
});

test("menu when clauses from the docs and template parse (D176)", async () => {
  const { matchesWhen } = await import("../core/context/index");
  const keys: Record<string, unknown> = {
    ...resourceContext("/p/a.txt", false, "plaintext"),
    view: "myTool.items",
  };
  const look = (k: string) => keys[k] as never;
  assert.equal(matchesWhen("resourceExtname == .txt", look), true);
  assert.equal(matchesWhen("resourceExtname == .ts", look), false);
  assert.equal(matchesWhen("view == myTool.items", look), true);
  assert.equal(matchesWhen("!explorerResourceIsFolder", look), true);
});

test("extension tools: views and View-menu commands, by extension, `when` respected (D181)", () => {
  const f = new ExtensionFeatures();
  f.contribute(f.openers, [
    { owner: "z.canvas", extension: "Canvas", title: "Canvases", command: "view.show" },
  ]);
  f.contribute(f.openers, [
    { owner: "a.todo", extension: "TODO", title: "TODO tree", command: "view.show" },
  ]);
  f.addMenus([
    { owner: "z.canvas", location: "menubar/view", command: "canvas.open", title: "Canvas" },
    {
      owner: "z.canvas",
      location: "menubar/view",
      command: "canvas.hidden",
      title: "Hidden",
      when: "never",
    },
    { owner: "z.canvas", location: "view/title", command: "canvas.new", title: "New" },
  ]);
  const all = f.allOpeners((when) => when !== "never");
  assert.deepEqual(
    all.map((o) => o.title),
    ["TODO tree", "Canvases", "Canvas"],
  );
  assert.deepEqual(
    f.allOpeners(() => true, "z.canvas").map((o) => o.command),
    ["view.show", "canvas.open", "canvas.hidden"],
  );
});

test("D261: a completion's own replace range, when it's on the cursor's line around the cursor", () => {
  assert.deepEqual(
    completionColumns({ startLine: 3, startColumn: 5, endLine: 3, endColumn: 9 }, 3, 9),
    [5, 9],
  );
  assert.equal(
    completionColumns({ startLine: 2, startColumn: 5, endLine: 3, endColumn: 9 }, 3, 9),
    null,
  );
  assert.equal(
    completionColumns({ startLine: 3, startColumn: 10, endLine: 3, endColumn: 12 }, 3, 9),
    null,
  );
  assert.equal(
    completionColumns({ startLine: 3, startColumn: 1, endLine: 3, endColumn: 4 }, 3, 9),
    null,
  );
  assert.equal(completionColumns(undefined, 3, 9), null);
});

test("D264: new terminals' variables from extensions' changes", () => {
  const vars = terminalEnvVars(
    new Map([
      [
        "a.one",
        [
          { variable: "PORT", value: "1", type: "replace" as const },
          { variable: "PATH", value: "/a:", type: "prepend" as const },
        ],
      ],
      [
        "b.two",
        [
          { variable: "PATH", value: ":/b", type: "append" as const },
          { variable: "PORT", value: "2", type: "replace" as const },
        ],
      ],
    ]),
  );
  assert.deepEqual(vars, { PORT: "2", PATH: "/a:${env:PATH}:/b" });
});

test("hover answers: text, a range of their own, bad ranges dropped", () => {
  assert.equal(toHoverAnswer("**x**"), "**x**");
  assert.equal(toHoverAnswer(""), null);
  assert.equal(toHoverAnswer(42), null);
  assert.equal(toHoverAnswer({ contents: "" }), null);
  const range = { startLine: 2, startColumn: 3, endLine: 2, endColumn: 9 };
  assert.deepEqual(toHoverAnswer({ contents: "a", range }), { contents: "a", range });
  // Backwards, zero or fractional: the text stays, the range goes (the word is used).
  assert.deepEqual(toHoverAnswer({ contents: "a", range: { ...range, endColumn: 1 } }), {
    contents: "a",
  });
  assert.deepEqual(toHoverAnswer({ contents: "a", range: { ...range, startLine: 0 } }), {
    contents: "a",
  });
  assert.deepEqual(toHoverAnswer({ contents: "a", range: { ...range, endLine: 2.5 } }), {
    contents: "a",
  });
});
