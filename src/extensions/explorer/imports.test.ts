import assert from "node:assert/strict";
import { test } from "node:test";
import { movedPath, normalize, relativeSpecifier, rewriteImports } from "./imports";

/** A file system before the moves; `existedBefore` as the explorer computes it. */
const world = (files: string[]) => {
  const set = new Set(files);
  return async (p: string) => set.has(p);
};

test("paths and specifiers", () => {
  assert.equal(normalize("/a/b/../c/./d"), "/a/c/d");
  assert.equal(relativeSpecifier("/w/src", "/w/src/util"), "./util");
  assert.equal(relativeSpecifier("/w/src/a", "/w/lib/x"), "../../lib/x");
  assert.equal(movedPath("/w/src/x/y.ts", [{ from: "/w/src/x", to: "/w/lib/x" }]), "/w/lib/x/y.ts");
  assert.equal(movedPath("/w/src/xy.ts", [{ from: "/w/src/x", to: "/w/lib/x" }]), "/w/src/xy.ts");
});

test("a renamed file: importers follow, keeping their style", async () => {
  const before = world(["/w/src/util.ts", "/w/src/main.ts", "/w/src/deep/a.ts"]);
  const moves = [{ from: "/w/src/util.ts", to: "/w/src/helpers.ts" }];
  const main = `import { add } from "./util";\nimport x from './util.js';\nconst y = require("./util.ts");\nimport "./other";`;
  const r = await rewriteImports(main, "/w/src/main.ts", moves, before);
  assert.equal(
    r?.text,
    `import { add } from "./helpers";\nimport x from './helpers.js';\nconst y = require("./helpers.ts");\nimport "./other";`,
  );
  assert.equal(r?.count, 3);
  const deep = await rewriteImports(`export * from "../util";`, "/w/src/deep/a.ts", moves, before);
  assert.equal(deep?.text, `export * from "../helpers";`);
  assert.equal(await rewriteImports(`import "react";`, "/w/src/main.ts", moves, before), null);
});

test("a moved file fixes its own imports; a moved folder keeps index imports", async () => {
  const before = world(["/w/src/util.ts", "/w/src/a.ts", "/w/src/comp/index.tsx", "/w/src/app.ts"]);
  const moved = await rewriteImports(
    `import { u } from "./util";`,
    "/w/src/sub/a.ts",
    [{ from: "/w/src/a.ts", to: "/w/src/sub/a.ts" }],
    before,
  );
  assert.equal(moved?.text, `import { u } from "../util";`);
  const folder = [{ from: "/w/src/comp", to: "/w/src/ui/comp" }];
  const app = await rewriteImports(`import C from "./comp";`, "/w/src/app.ts", folder, before);
  assert.equal(app?.text, `import C from "./ui/comp";`);
});

test("commented-out imports are left alone", async () => {
  const before = world(["/w/src/util.ts"]);
  const moves = [{ from: "/w/src/util.ts", to: "/w/src/helpers.ts" }];
  const text = `// import { a } from "./util";\n/*\n * import "./util";\n */\nimport "./util";`;
  const r = await rewriteImports(text, "/w/src/main.ts", moves, before);
  assert.equal(r?.count, 1);
  assert.ok(r?.text.endsWith(`import "./helpers";`));
  assert.ok(r?.text.startsWith(`// import { a } from "./util";`));
});
