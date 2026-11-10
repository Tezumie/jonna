import assert from "node:assert/strict";
import { test } from "node:test";
import {
  declarationRegex,
  extensionSymbols,
  lspKindName,
  parseDeclaration,
} from "./workspaceSymbols";

test("declarationRegex matches declarations whose name has the query in order", () => {
  const re = new RegExp(declarationRegex("qo") ?? "", "i");
  assert.ok(re.test("export function quickOpen() {"));
  assert.ok(re.test("  def query_open(self):"));
  assert.ok(re.test("pub(crate) fn quick_open() {"));
  assert.ok(re.test("export const QUICK_OPEN = 1;"));
  assert.ok(re.test("func (s *Server) QueryOne() {"));
  assert.ok(!re.test("  const quickOpen = 1;"), "indented const is a local");
  assert.ok(!re.test("quickOpen();"));
  assert.equal(declarationRegex("  ::"), null);
});

test("parseDeclaration finds the name, kind and column", () => {
  assert.deepEqual(parseDeclaration("export class Dock {"), {
    name: "Dock",
    kind: "class",
    column: 14,
  });
  assert.deepEqual(parseDeclaration("    async def run(self):"), {
    name: "run",
    kind: "function",
    column: 15,
  });
  assert.deepEqual(parseDeclaration("const MAX = 3;"), {
    name: "MAX",
    kind: "constant",
    column: 7,
  });
  assert.deepEqual(parseDeclaration("pub struct Point {"), {
    name: "Point",
    kind: "struct",
    column: 12,
  });
  assert.equal(parseDeclaration("return x;"), null);
});

test("lspKindName maps SymbolKind numbers", () => {
  assert.equal(lspKindName(5), "class");
  assert.equal(lspKindName(12), "function");
  assert.equal(lspKindName(99), "variable");
});

test("extension symbols in every folder of a multi-root workspace are kept", () => {
  const folders = [
    { path: "/w", name: "web" },
    { path: "/x/api", name: "api" },
  ];
  const scope = {
    contains: (p: string) => folders.some((f) => p === f.path || p.startsWith(`${f.path}/`)),
    relative: (p: string) => {
      const f = folders.find((x) => p.startsWith(`${x.path}/`));
      return f ? `${f.name}/${p.slice(f.path.length + 1)}` : p;
    },
    multi: true,
  };
  const sym = (path: string) => ({ name: "makeThing", kind: "function", path, line: 1, column: 1 });
  const found = extensionSymbols("make", scope, [
    sym("/x/api/src/a.ts"),
    sym("/w/b.ts"),
    sym("/else/c.ts"),
  ]);
  assert.deepEqual(
    found.map((s) => [s.rel, s.path]),
    [
      ["api/src/a.ts", "/x/api/src/a.ts"],
      ["web/b.ts", "/w/b.ts"],
    ],
  );
  // A folder's root works as before.
  assert.deepEqual(
    extensionSymbols("make", "/w", [sym("/w/b.ts"), sym("/x/api/a.ts")]).map((s) => s.rel),
    ["b.ts"],
  );
});
