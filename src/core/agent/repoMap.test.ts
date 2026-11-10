import assert from "node:assert/strict";
import { test } from "node:test";
import { fileSymbols, mapsLanguage, rankFiles, renderRepoMap, skippedPath } from "./repoMap";

test("repo map: symbols per language (D174)", () => {
  const ts = fileSymbols(
    "src/auth.ts",
    [
      "import { db } from './db';",
      "// a comment function fake() {}",
      "export async function signIn(user: string, password: string): Promise<Session> {",
      "  return db.find(user);",
      "}",
      "export class SessionStore {",
      "  private cache = new Map();",
      "  async refresh(token: string) {",
      "  }",
      "}",
      "export interface Session { id: string }",
      "export type Role = 'admin' | 'user';",
      "const helper = (x: number) => x * 2;",
      "if (x) {",
    ].join("\n"),
  );
  assert.deepEqual(
    ts.defs.map((d) => [d.name, d.line]),
    [
      ["signIn", 3],
      ["SessionStore", 6],
      ["refresh", 8],
      ["Session", 11],
      ["Role", 12],
      ["helper", 13],
    ],
  );
  assert.equal(
    ts.defs[0]?.signature,
    "export async function signIn(user: string, password: string): Promise<Session>",
  );
  assert.ok(ts.refs.has("SessionStore") && !ts.refs.has("return"));
  const py = fileSymbols(
    "app/models.py",
    "class User:\n    def save(self):\n        pass\n\ndef load(id):\n    pass\nMAX_USERS = 10\n",
  );
  assert.deepEqual(
    py.defs.map((d) => d.name),
    ["User", "save", "load", "MAX_USERS"],
  );
  const rs = fileSymbols(
    "src/lib.rs",
    "pub struct Index;\nimpl Index {\n    pub fn query(&self) -> Vec<u8> {\n    }\n}\nfn helper() {}\n#[test]\nfn works() {}",
  );
  assert.deepEqual(
    rs.defs.map((d) => d.name),
    ["Index", "query", "helper", "works"],
  );
  const go = fileSymbols(
    "main.go",
    "func (s *Server) Start() error {\n}\ntype Server struct {\n}\nfunc main() {}",
  );
  assert.deepEqual(
    go.defs.map((d) => d.name),
    ["Start", "Server"],
  );
  assert.ok(mapsLanguage("src/a.tsx") && !mapsLanguage("dist/a.min.js") && !mapsLanguage("x.d.ts"));
  assert.ok(
    skippedPath("node_modules/x/a.js") &&
      skippedPath("src-tauri/target/a.rs") &&
      !skippedPath("src/build.ts"),
  );
});

test("repo map: files ranked by references, personalized, cut to a budget (D174)", () => {
  const core = fileSymbols(
    "src/core.ts",
    "export function computeTotals(items) {}\nexport class Ledger {}",
  );
  const ui = fileSymbols(
    "src/ui.ts",
    "import { computeTotals, Ledger } from './core';\nexport function renderInvoice() { computeTotals(); new Ledger(); }",
  );
  const api = fileSymbols(
    "src/api.ts",
    "import { Ledger } from './core';\nexport function handleRequest() { new Ledger(); }",
  );
  const lonely = fileSymbols("src/lonely.ts", "export function unusedThing() {}");
  const files = [core, ui, api, lonely];
  const rank = rankFiles(files);
  // Used by two files: first.
  const order = [...rank.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  assert.equal(order[0], "src/core.ts");
  // Focus on the lonely file lifts it.
  const focused = rankFiles(files, { focus: ["src/lonely.ts"] });
  assert.ok((focused.get("src/lonely.ts") ?? 0) > (rank.get("src/lonely.ts") ?? 0));
  const map = renderRepoMap(files, { budget: 10_000 });
  assert.match(
    map,
    /^src\/core\.ts:\n│export function computeTotals\(items\)\n│export class Ledger/,
  );
  assert.ok(map.includes("src/lonely.ts:\n│export function unusedThing()"));
  // A small budget keeps the top files, then names only.
  const small = renderRepoMap(files, { budget: 110 });
  assert.ok(small.length <= 110, small);
  assert.match(small, /^src\/core\.ts:/);
  assert.equal(renderRepoMap([], { budget: 100 }), "");
});

test("repo map: calls aren't definitions; constants without their values (D174 audit)", () => {
  const js = fileSymbols(
    "server.js",
    "export function startServer() {\n  setupRoutes(app)\n  connectDatabase()\n}\nexport const STRIPE_KEY = 'sk_live_123'\nexport const handler = async (req, res) => res.end()\n",
  );
  assert.deepEqual(
    js.defs.map((d) => d.signature),
    [
      "export function startServer()",
      "export const STRIPE_KEY",
      "export const handler = async (req, res) =>",
    ],
  );
  const py = fileSymbols("settings.py", "SECRET_KEY = 'abc123'\n");
  assert.deepEqual(
    py.defs.map((d) => d.signature),
    ["SECRET_KEY"],
  );
  const rs = fileSymbols("lib.rs", 'pub const TOKEN: &str = "secret";\n');
  assert.deepEqual(
    rs.defs.map((d) => d.signature),
    [],
  );
});
