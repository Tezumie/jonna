import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveBindings, type SourcedRule } from "./effective";
import { KeybindingResolver } from "./index";
import {
  platformConstants,
  removalMatches,
  whenAlwaysHolds,
  whensCanOverlap,
  whensEqual,
} from "./whenLogic";

test("overlap: regex, in, != and numeric tests (D219)", () => {
  // Regex against a value.
  assert.equal(whensCanOverlap("resourceExtname =~ /\\.ts$/", "resourceExtname == '.md'"), false);
  assert.equal(whensCanOverlap("resourceExtname =~ /\\.ts$/", "resourceExtname == '.ts'"), true);
  assert.equal(whensCanOverlap("x =~ /a/", "!(x =~ /a/)"), false);
  assert.equal(whensCanOverlap("x =~ /a/", "x =~ /b/"), true);
  // A falsy key fails a regex that needs characters.
  assert.equal(whensCanOverlap("!x", "x =~ /a/"), false);
  assert.equal(whensCanOverlap("!x", "x =~ /^$/"), true);
  // `in` and `not in`.
  assert.equal(whensCanOverlap("a in list", "a not in list"), false);
  assert.equal(whensCanOverlap("a in list", "!(a in list)"), false);
  assert.equal(whensCanOverlap("a in list", "a in other"), true);
  // == / != and !key.
  assert.equal(whensCanOverlap("view == 'x'", "view != 'x'"), false);
  assert.equal(whensCanOverlap("view == 'x'", "view != 'y'"), true);
  assert.equal(whensCanOverlap("view == 'x'", "!view"), false);
  assert.equal(whensCanOverlap("count == 0", "!count"), true);
  // Numeric ranges.
  assert.equal(whensCanOverlap("n < 2", "n >= 5"), false);
  assert.equal(whensCanOverlap("n <= 2", "n >= 2"), true);
  assert.equal(whensCanOverlap("n < 2", "n >= 2"), false);
  assert.equal(whensCanOverlap("n > 3", "n == 1"), false);
  assert.equal(whensCanOverlap("n > 3", "n == 4"), true);
  assert.equal(whensCanOverlap("n > 3", "!n"), false);
  assert.equal(whensCanOverlap("n < 3", "!n"), true);
  // Negations of whole clauses (De Morgan).
  assert.equal(whensCanOverlap("a && b", "!(a && b)"), false);
  assert.equal(whensCanOverlap("a || b", "!a && !b"), false);
  assert.equal(whensCanOverlap("a || b", "!a"), true);
  // A clause that can never hold overlaps nothing.
  assert.equal(whensCanOverlap("a && !a", "b"), false);
  // Still unknowns: assumed to overlap.
  assert.equal(whensCanOverlap("x =~ /a/", "x =~ /b/"), true);
  assert.equal(whensCanOverlap("x =~ /a/", "y"), true);
});

test("the same when clause written differently", () => {
  assert.equal(whensEqual("a && b", "b&&a"), true);
  assert.equal(whensEqual("a && (b && c)", "c && b && a"), true);
  assert.equal(whensEqual("x == 'one'", 'x == "one"'), true);
  assert.equal(whensEqual("a || b", "a && b"), false);
  assert.equal(whensEqual("", undefined), true);
  assert.equal(whensEqual("!a", "a"), false);
});

test("a removal with a when takes only the binding with that clause (VS Code's rule)", () => {
  const b = (when?: string) => ({ command: "x", chords: "ctrl+e", when });
  assert.equal(removalMatches({ command: "x", chords: null, when: undefined }, b("a")), true);
  assert.equal(removalMatches({ command: "x", chords: "ctrl+e", when: "a" }, b("a")), true);
  assert.equal(removalMatches({ command: "x", chords: null, when: "b && a" }, b("a && b")), true);
  assert.equal(removalMatches({ command: "x", chords: null, when: "b" }, b("a")), false);
  // A when on the removal never takes a binding without one.
  assert.equal(removalMatches({ command: "x", chords: null, when: "a" }, b()), false);
  assert.equal(removalMatches({ command: "x", chords: "ctrl+f", when: "a" }, b("a")), false);
  assert.equal(removalMatches({ command: "y", chords: null, when: undefined }, b()), false);

  const rules: SourcedRule[] = [
    { key: "ctrl+e", command: "x", when: "editorFocus", source: "default" },
    { key: "ctrl+e", command: "x", when: "explorerFocus", source: "default" },
    { key: "", command: "-x", when: "explorerFocus", source: "user" },
  ];
  const table = effectiveBindings(rules, "linux");
  assert.deepEqual(
    table.map((r) => r.when),
    ["editorFocus"],
  );
  // The resolver applies the same rule.
  const resolver = new KeybindingResolver(rules, "linux");
  const ctx = new Set(["explorerFocus"]);
  assert.deepEqual(
    resolver.resolve("ctrl+e", (w) => !w || ctx.has(w)),
    { kind: "none" },
  );
  ctx.clear();
  ctx.add("editorFocus");
  assert.equal(
    (resolver.resolve("ctrl+e", (w) => !w || ctx.has(w)) as { command?: string }).command,
    "x",
  );
});

test("conflicts are judged with the wider rules", () => {
  const table = effectiveBindings(
    [
      { key: "ctrl+e", command: "a", when: "resourceExtname == '.md'", source: "default" },
      { key: "ctrl+e", command: "b", when: "resourceExtname =~ /\\.tsx?$/", source: "default" },
      { key: "ctrl+e", command: "c", source: "default" },
    ],
    "linux",
  );
  const by = Object.fromEntries(table.map((r) => [r.command, r.conflicts]));
  assert.deepEqual(by.a, ["c"]);
  assert.deepEqual(by.b, ["c"]);
});

test("negated numeric tests and regex against regex", () => {
  // `!(n < 2)` holds for n >= 2 or a value that isn't a number.
  assert.equal(whensCanOverlap("!(n < 2)", "n < 1"), false);
  assert.equal(whensCanOverlap("!(n < 2)", "n < 3"), true);
  assert.equal(whensCanOverlap("!(n < 2)", "n == 1"), false);
  assert.equal(whensCanOverlap("!(n < 2)", "n == 'abc'"), true);
  assert.equal(whensCanOverlap("!(n < 2)", "!n"), true);
  assert.equal(whensCanOverlap("!(n < 2)", "!(n > 5)"), true);
  assert.equal(whensCanOverlap("!(n <= 2)", "n <= 2"), false);
  // Anchored ends and literal sets.
  const raw = String.raw;
  assert.equal(whensCanOverlap(raw`x =~ /\.ts$/`, raw`x =~ /\.md$/`), false);
  assert.equal(whensCanOverlap(raw`x =~ /\.ts$/`, raw`x =~ /\.d\.ts$/`), true);
  assert.equal(whensCanOverlap(raw`x =~ /^src\//`, raw`x =~ /^test\//`), false);
  assert.equal(whensCanOverlap("x =~ /^(ts|js)$/", "x =~ /^(md|txt)$/"), false);
  assert.equal(whensCanOverlap("x =~ /^(ts|js)$/", "x =~ /s$/"), true);
  assert.equal(whensCanOverlap("x =~ /^(ts|js)$/", "!(x =~ /s$/)"), false);
  assert.equal(whensCanOverlap(raw`x =~ /\.TS$/i`, raw`x =~ /\.ts$/`), true);
  assert.equal(whensCanOverlap(raw`x =~ /a|\.ts$/`, raw`x =~ /\.md$/`), true);
  assert.equal(whensCanOverlap(raw`x =~ /\.tsx?$/`, raw`x =~ /\.ts$/`), true);
  assert.equal(whensCanOverlap(raw`x =~ /^\.(ts|js)$/`, raw`x =~ /\.js$/`), true);
});

test("constants are substituted (VS Code's isMac / isWindows)", () => {
  const win = platformConstants("windows");
  assert.equal(whensCanOverlap("isMac", "editorFocus", win), false);
  assert.equal(whensCanOverlap("isMac && editorFocus", undefined, win), false);
  assert.equal(whensCanOverlap("isWindows && editorFocus", "editorFocus", win), true);
  assert.equal(whensCanOverlap("!isWeb", "editorFocus", win), true);
  assert.equal(whensCanOverlap("isMac || editorFocus", "explorerFocus", win), false);
  assert.equal(whensCanOverlap("isMac", "editorFocus"), true);
  assert.equal(whenAlwaysHolds("isWindows", win), true);
  assert.equal(whenAlwaysHolds("isWindows == true", win), true);
  assert.equal(whenAlwaysHolds("isLinux", win), false);
  assert.equal(whensEqual("isWindows && editorFocus", "editorFocus", win), true);

  const table = effectiveBindings(
    [
      { key: "ctrl+e", command: "mac.only", when: "isMac", source: "default" },
      { key: "ctrl+e", command: "everywhere", source: "default" },
      { key: "ctrl+e", command: "win.editor", when: "isWindows && editorFocus", source: "default" },
      { key: "ctrl+e", command: "editor", when: "editorFocus", source: "default" },
    ],
    "windows",
  );
  const by = Object.fromEntries(table.map((b) => [b.command, b.conflicts]));
  assert.deepEqual(by["mac.only"], []);
  assert.deepEqual(by.everywhere, ["win.editor", "editor"]);
  assert.deepEqual(by["win.editor"], ["everywhere", "editor"]);
});
