import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextKeyService } from "./index";
import { evaluateWhen, matchesWhen, parseWhen, WhenParseError } from "./when";

const ctx: Record<string, unknown> = {
  editorFocus: true,
  terminalFocus: false,
  resourceExtname: ".ts",
  resourceFilename: "Main.TS",
  openEditors: 3,
  supported: ["typescript", "rust"],
  lang: "rust",
  map: { a: 1 },
  k: "a",
};
const lookup = (key: string) => ctx[key];
const when = (src: string) => matchesWhen(src, lookup);

test("keys, negation, and/or precedence, parentheses", () => {
  assert.equal(when("editorFocus"), true);
  assert.equal(when("!editorFocus"), false);
  assert.equal(when("missingKey"), false);
  assert.equal(when("editorFocus && terminalFocus"), false);
  assert.equal(when("terminalFocus || editorFocus"), true);
  assert.equal(when("terminalFocus && editorFocus || editorFocus"), true, "&& binds tighter");
  assert.equal(when("terminalFocus && (editorFocus || editorFocus)"), false);
  assert.equal(when("!(terminalFocus || !editorFocus)"), true);
  assert.equal(when(""), true);
  assert.equal(matchesWhen(undefined, lookup), true);
});

test("comparisons, regex, in / not in", () => {
  assert.equal(when("resourceExtname == .ts"), true);
  assert.equal(when("resourceExtname == '.rs'"), false);
  assert.equal(when("resourceExtname != .rs"), true);
  assert.equal(when("resourceExtname === '.ts'"), true);
  assert.equal(when("openEditors > 2 && openEditors <= 3"), true);
  assert.equal(when("openEditors < 1"), false);
  assert.equal(when("resourceFilename =~ /^main\\.ts$/i"), true);
  assert.equal(when("lang in supported"), true);
  assert.equal(when("lang not in supported"), false);
  assert.equal(when("k in map"), true);
  assert.equal(when("editorFocus == true"), true);
});

test("syntax errors are reported with offsets", () => {
  assert.throws(() => parseWhen("a &&"), WhenParseError);
  assert.throws(() => parseWhen("(a || b"), WhenParseError);
  assert.throws(() => parseWhen("a == "), WhenParseError);
  assert.throws(() => parseWhen("a 'x'"), WhenParseError);
  assert.throws(() => parseWhen("x =~ /unterminated"), WhenParseError);
  assert.equal(evaluateWhen(parseWhen("true && !false"), lookup), true);
});

test("ContextKeyService fires changes and evaluates", () => {
  const service = new ContextKeyService();
  const changes: string[][] = [];
  service.onDidChange((keys) => changes.push([...keys]));
  service.set("workspaceOpen", true);
  service.set("workspaceOpen", true); // no-op
  service.setMany({ a: 1, b: 2, workspaceOpen: true });
  assert.deepEqual(changes, [["workspaceOpen"], ["a", "b"]]);
  assert.equal(service.matches("workspaceOpen && a == 1"), true);
  service.set("a", undefined);
  assert.deepEqual(Object.keys(service.snapshot()).sort(), ["b", "workspaceOpen"]);
  service.dispose();
});

test("D262: a fallback answers keys nothing set (config.<setting>), and announces changes", () => {
  const settings: Record<string, unknown> = { "claudeCode.useTerminal": false };
  const ctx = new ContextKeyService((k) =>
    k.startsWith("config.") ? (settings[k.slice(7)] as boolean | undefined) : undefined,
  );
  assert.equal(ctx.matches("!config.claudeCode.useTerminal"), true);
  ctx.set("config.claudeCode.useTerminal", true);
  assert.equal(ctx.matches("!config.claudeCode.useTerminal"), false);
  const fired: string[] = [];
  ctx.onDidChange((keys) => fired.push(...keys));
  ctx.changedOutside(["config.a"]);
  assert.deepEqual(fired, ["config.a"]);
});

test("a when clause that can't be read never holds (and doesn't throw at the caller)", () => {
  const ctx = new ContextKeyService();
  ctx.set("editorFocus", true);
  assert.equal(ctx.matches("editorFocus &&"), false);
  assert.equal(ctx.matches("(editorFocus"), false);
  assert.equal(ctx.matches("editorFocus"), true);
});
