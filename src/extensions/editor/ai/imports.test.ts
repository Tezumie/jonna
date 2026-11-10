import assert from "node:assert/strict";
import { test } from "node:test";
import { rankSnippets } from "./context";
import { buildFimPrompt } from "./fim";
import {
  aliasBases,
  declarationFromDefinition,
  declarationsAt,
  ImportGraph,
  importSites,
  importSnippetText,
  namespaceMembers,
  packageSpec,
  parseImports,
  positionAt,
  resolveImport,
  tsconfigAliases,
} from "./imports";

test("imports of TypeScript / JavaScript files (D224)", () => {
  const text = [
    'import { add, type Sum, mul as times } from "./math";',
    'import Widget from "../ui/widget.js";',
    'import * as paths from "./paths";',
    'import "./side-effect";',
    'import { readFile } from "node:fs/promises";',
    'export { helper } from "./helpers";',
    "export const x = 1;",
    'const legacy = require("./legacy");',
  ].join("\n");
  assert.deepEqual(parseImports(text, "typescript"), [
    { spec: "./math", names: ["add", "Sum", "mul"] },
    { spec: "../ui/widget.js", names: ["default"] },
    { spec: "./paths", names: [], namespace: "paths" },
    { spec: "./side-effect", names: [] },
    { spec: "node:fs/promises", names: ["readFile"] },
    { spec: "./helpers", names: ["helper"], reexport: true },
    { spec: "./legacy", names: [] },
  ]);
  // Packages aren't followed; "./x.js" is x.ts first (TypeScript's ESM style).
  assert.deepEqual(
    resolveImport("/w/src/a.ts", { spec: "react", names: [] }, "typescript", "/w"),
    [],
  );
  const js = resolveImport(
    "/w/src/a.ts",
    { spec: "../ui/widget.js", names: [] },
    "typescript",
    "/w",
  );
  assert.equal(js[0], "/w/ui/widget.ts");
  assert.ok(js.includes("/w/ui/widget.js"));
  const plain = resolveImport("/w/src/a.ts", { spec: "./math", names: [] }, "typescript", "/w");
  assert.deepEqual(plain.slice(0, 2), ["/w/src/math.ts", "/w/src/math.tsx"]);
  assert.ok(plain.includes("/w/src/math/index.ts"));
  // Windows paths keep their separators.
  assert.equal(
    resolveImport("C:\\w\\src\\a.ts", { spec: "./math", names: [] }, "typescript", "C:\\w")[0],
    "C:\\w\\src\\math.ts",
  );
});

test("imports of Python, Rust and C files", () => {
  const py = [
    "import os",
    "from .models import User, Group as G",
    "from ..core.db import (",
    "    connect,",
    "    close,",
    ")",
    "from app.util import *",
    "import app.helpers as h",
  ].join("\n");
  assert.deepEqual(parseImports(py, "python"), [
    { spec: ".models", names: ["User", "Group"] },
    { spec: "..core.db", names: ["connect", "close"] },
    { spec: "app.util", names: [] },
    { spec: "os", names: [], namespace: "os" },
    { spec: "app.helpers", names: [], namespace: "h" },
  ]);
  assert.deepEqual(
    resolveImport("/w/app/api/views.py", { spec: ".models", names: [] }, "python", "/w"),
    ["/w/app/api/models.py", "/w/app/api/models/__init__.py"],
  );
  assert.deepEqual(
    resolveImport("/w/app/api/views.py", { spec: "..core.db", names: [] }, "python", "/w")[0],
    "/w/app/core/db.py",
  );
  assert.ok(
    resolveImport("/w/app/api/views.py", { spec: "app.util", names: [] }, "python", "/w").includes(
      "/w/app/util.py",
    ),
  );
  assert.deepEqual(parseImports("mod config;\npub mod net;\nmod tests {\n}", "rust"), [
    { spec: "config", names: [], namespace: "config" },
    { spec: "net", names: [], namespace: "net" },
  ]);
  assert.deepEqual(resolveImport("/w/src/main.rs", { spec: "config", names: [] }, "rust", "/w"), [
    "/w/src/config.rs",
    "/w/src/config/mod.rs",
  ]);
  assert.deepEqual(resolveImport("/w/src/net.rs", { spec: "tcp", names: [] }, "rust", "/w"), [
    "/w/src/net/tcp.rs",
    "/w/src/net/tcp/mod.rs",
  ]);
  assert.deepEqual(parseImports('#include "util.h"\n#include <stdio.h>', "c"), [
    { spec: "util.h", names: [] },
  ]);
  assert.deepEqual(parseImports("package main", "go"), []);
});

test("an imported file's declarations of the names used", () => {
  const math = [
    "// Math helpers.",
    "export function add(a: number, b: number): number {",
    "  return a + b;",
    "}",
    "",
    "export type Sum = { total: number };",
    "export function unused() {",
    "  return 0;",
    "}",
    "export default class Calculator {",
    "  run() {}",
    "}",
  ].join("\n");
  assert.equal(
    importSnippetText(math, ["add", "Sum"]),
    "export function add(a: number, b: number): number {\n  return a + b;\n}\nexport type Sum = { total: number };",
  );
  assert.equal(
    importSnippetText(math, ["default"]),
    "export default class Calculator {\n  run() {}\n}",
  );
  // No names (or none found): the outline of top-level declarations.
  assert.equal(
    importSnippetText(math, []),
    "export function add(a: number, b: number): number\nexport type Sum = { total: number };\nexport function unused()\nexport default class Calculator",
  );
  const py = "class User:\n    name: str\n\n    def greet(self):\n        return 1\n\nX = 1\n";
  assert.equal(
    importSnippetText(py, ["User"]),
    "class User:\n    name: str\n\n    def greet(self):\n        return 1",
  );
  assert.equal(importSnippetText("just text", ["x"]), null);
  assert.deepEqual(namespaceMembers("paths.join(a); paths.dirname(b); xpaths.no()", "paths"), [
    "join",
    "dirname",
  ]);
});

test("the import graph reads each file once and ranks used names first", async () => {
  const disk: Record<string, string> = {
    "/w/src/util.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    "/w/src/other.ts": "export const other = 1;\n",
  };
  const reads: string[] = [];
  const graph = new ImportGraph(async (p) => {
    reads.push(p);
    return disk[p] ?? null;
  });
  const text = 'import { add } from "./util";\nimport { other } from "./other";\n\nconst x = add(';
  const input = {
    path: "/w/src/main.ts",
    languageId: "typescript",
    text,
    prefix: text,
    root: "/w",
    now: 0,
  };
  const snippets = await graph.snippets(input);
  assert.deepEqual(
    snippets.map((s) => [s.path, s.kind, s.score]),
    [
      ["/w/src/util.ts", "import", 0.6],
      ["/w/src/other.ts", "import", 0.3],
    ],
  );
  // The folder's tsconfig.json / jsconfig.json (path aliases, D229) are looked for first.
  assert.deepEqual(reads, [
    "/w/tsconfig.json",
    "/w/jsconfig.json",
    "/w/src/util.ts",
    "/w/src/other.ts",
  ]);
  await graph.snippets({ ...input, now: 1000 });
  assert.equal(reads.length, 4); // cached
  graph.invalidate("/w/src/util.ts");
  await graph.snippets({ ...input, now: 2000 });
  assert.deepEqual(reads.slice(4), ["/w/src/util.ts"]);
  // Ignored files (agent ignore rules) are neither read nor sent.
  const skipped = await graph.snippets({ ...input, skip: (p) => p.endsWith("util.ts") });
  assert.deepEqual(
    skipped.map((s) => s.path),
    ["/w/src/other.ts"],
  );
  // Missing candidates are remembered until a file appears.
  const missing = new ImportGraph(async () => null);
  await missing.snippets(input);
  missing.forgetMissing();

  // In the prompt, inside the budget, introduced as imported.
  const ranked = rankSnippets({
    current: { path: input.path, prefix: text },
    documents: [],
    edits: [],
    imports: snippets,
  });
  const { prompt } = buildFimPrompt(
    {
      path: "src/main.ts",
      languageId: "typescript",
      prefix: text,
      suffix: "",
      snippets: ranked.map((s) => ({ ...s, path: "src/util.ts" })),
    },
    1536,
  );
  assert.ok(prompt.startsWith("// Imported from src/util.ts:\n// export function add("));
});

test("an open file's window that holds the declaration isn't sent twice", () => {
  const util = "export function add(a: number, b: number): number {\n  return a + b;\n}";
  const ranked = rankSnippets({
    current: { path: "/w/main.ts", prefix: "const t = add(a: number, b: number)" },
    documents: [{ path: "/w/util.ts", text: util }],
    edits: [],
    imports: [{ path: "/w/util.ts", text: util, kind: "import", score: 0.6 }],
  });
  assert.deepEqual(
    ranked.map((s) => s.kind),
    ["open"],
  );
});

test("path aliases, packages' typings and re-exports are followed (D229)", async () => {
  const aliases = tsconfigAliases(
    '{\n  // comments allowed\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "lib": ["src/lib/index.ts"] } },\n}',
    "/w",
  );
  assert.deepEqual(aliasBases("@/ui/button", aliases), ["/w/src/ui/button"]);
  assert.deepEqual(aliasBases("lib", aliases), ["/w/src/lib/index.ts"]);
  assert.deepEqual(aliasBases("react", aliases), []);
  assert.ok(
    resolveImport(
      "/w/src/a.ts",
      { spec: "@/ui/button", names: [] },
      "typescript",
      "/w",
      aliases,
    ).includes("/w/src/ui/button.ts"),
  );
  assert.deepEqual(packageSpec("@scope/pkg/sub/x"), { name: "@scope/pkg", subpath: "sub/x" });
  assert.deepEqual(packageSpec("zod"), { name: "zod", subpath: "" });
  assert.equal(packageSpec("./x"), null);
  assert.equal(
    parseImports('export * from "./a";\nimport { b } from "./b";', "typescript")[0]?.reexport,
    true,
  );

  const disk: Record<string, string> = {
    "/w/tsconfig.json": '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
    "/w/src/ui/index.ts": 'export * from "./button";\nexport { Card } from "./card";\n',
    "/w/src/ui/button.ts": "export function Button(props: Props) {\n  return null;\n}\n",
    "/w/src/ui/card.ts": "export class Card {}\n",
    "/w/node_modules/zod/package.json": '{ "name": "zod", "types": "./lib/index.d.ts" }',
    "/w/node_modules/zod/lib/index.d.ts": "export declare function string(): ZodString;\n",
  };
  const graph = new ImportGraph(async (path) => disk[path] ?? null);
  const text = 'import { Button } from "@/ui";\nimport { string } from "zod";\n\nButton(';
  const snippets = await graph.snippets({
    path: "/w/src/app.ts",
    languageId: "typescript",
    text,
    prefix: text,
    root: "/w",
    now: 0,
  });
  assert.deepEqual(
    snippets.map((x) => [x.path, x.score]),
    [
      ["/w/node_modules/zod/lib/index.d.ts", 0.3],
      ["/w/src/ui/button.ts", 0.3],
    ],
  );
  assert.match(snippets[1]?.text ?? "", /export function Button/);
});

test("import sites: where to ask a language server about each imported name (m7.12)", () => {
  const ts = [
    'import Widget, { add, mul as times } from "./math";',
    "import {",
    "  type Sum,",
    '} from "./types";',
    'import * as paths from "./paths";',
    "const p = paths.join(a);",
  ].join("\n");
  const refs = parseImports(ts, "typescript");
  const [math, types, ns] = refs;
  assert.ok(math && types && ns);
  assert.deepEqual(importSites(ts, "typescript", math, ["default", "add", "mul"]), [
    { name: "default", line: 0, character: 7 },
    { name: "add", line: 0, character: 17 },
    { name: "mul", line: 0, character: 22 },
  ]);
  assert.deepEqual(importSites(ts, "typescript", types, ["Sum"]), [
    { name: "Sum", line: 2, character: 7 },
  ]);
  // A namespace's members: where the file uses them.
  assert.deepEqual(importSites(ts, "typescript", ns, ["join"]), [
    { name: "join", line: 5, character: 16 },
  ]);
  // Python: the name after `import`, not the module's part of the same name.
  const py = "from .models import models, User\n";
  const [models] = parseImports(py, "python");
  assert.ok(models);
  assert.deepEqual(importSites(py, "python", models, ["models", "User"]), [
    { name: "models", line: 0, character: 20 },
    { name: "User", line: 0, character: 28 },
  ]);
  assert.deepEqual(positionAt("ab\ncd\r\nef", 8), { line: 2, character: 1 });
});

test("definition answers: Location, a list, LocationLink (m7.12)", () => {
  const range = { start: { line: 4, character: 2 }, end: { line: 4, character: 5 } };
  assert.deepEqual(declarationFromDefinition({ uri: "file:///w/a.ts", range }), {
    path: "/w/a.ts",
    line: 4,
  });
  assert.deepEqual(declarationFromDefinition([{ uri: "file:///c%3A/w/a.py", range }]), {
    path: "C:\\w\\a.py",
    line: 4,
  });
  assert.deepEqual(
    declarationFromDefinition([
      {
        targetUri: "file:///w/b.ts",
        targetRange: { start: { line: 1, character: 0 }, end: { line: 9, character: 1 } },
        targetSelectionRange: range,
      },
    ]),
    { path: "/w/b.ts", line: 4 },
  );
  assert.equal(declarationFromDefinition(null), null);
  assert.equal(declarationFromDefinition([]), null);
  assert.equal(declarationFromDefinition({ uri: "untitled:1", range }), null);
  assert.equal(
    declarationsAt("a\nexport function f(x) {\n  return x;\n}\nconst y = 1;\n", [1, 4]),
    "export function f(x) {\n  return x;\n}\nconst y = 1;",
  );
});

test("import graph: the language server places names first, the regex fills in (m7.12)", async () => {
  const disk: Record<string, string> = {
    // Where the server says `add` is (an alias the regex can't follow).
    "/w/lib/math/impl.ts":
      "// math\nexport function add(a: number, b: number) {\n  return a + b;\n}\n",
    "/w/src/other.ts": "export const other = 1;\n",
  };
  const graph = new ImportGraph(async (p) => disk[p] ?? null);
  const text = 'import { add } from "@m/math";\nimport { other } from "./other";\n\nconst x = add(';
  const asked: string[] = [];
  const snippets = await graph.snippets({
    path: "/w/src/main.ts",
    languageId: "typescript",
    text,
    prefix: text,
    root: "/w",
    now: 0,
    definitions: async (sites) => {
      asked.push(...sites.map((s) => `${s.name}@${s.line}:${s.character}`));
      // The server knows `add`; for `other` it has no answer.
      return sites.map((s) => (s.name === "add" ? { path: "/w/lib/math/impl.ts", line: 1 } : null));
    },
  });
  assert.deepEqual(asked, ["add@0:9", "other@1:9"]);
  assert.deepEqual(
    snippets.map((s) => [s.path, s.score]),
    [
      ["/w/lib/math/impl.ts", 0.6],
      ["/w/src/other.ts", 0.3],
    ],
  );
  assert.match(snippets[0]?.text ?? "", /^export function add\(a: number, b: number\) \{/);
  // No server answer at all: the regex alone, as before.
  const fallback = await new ImportGraph(async (p) => disk[p] ?? null).snippets({
    path: "/w/src/main.ts",
    languageId: "typescript",
    text,
    prefix: text,
    root: "/w",
    now: 0,
    definitions: async () => null,
  });
  assert.deepEqual(
    fallback.map((s) => s.path),
    ["/w/src/other.ts"],
  );
});
