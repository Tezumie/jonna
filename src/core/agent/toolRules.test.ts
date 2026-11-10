import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseToolEntry,
  pathPatternMatches,
  patternEntryMatches,
  withoutRefusedResults,
} from "./toolRules";

const ctx = { root: "/w", home: "/home/u" };

test("tool entries: the tool and its pattern", () => {
  assert.deepEqual(parseToolEntry("Read(src/**)"), { tool: "Read", pattern: "src/**" });
  assert.deepEqual(parseToolEntry(" Edit "), { tool: "Edit", pattern: null });
  assert.deepEqual(parseToolEntry("WebFetch(domain:docs.rs)"), {
    tool: "WebFetch",
    pattern: "domain:docs.rs",
  });
  assert.deepEqual(parseToolEntry("Read()"), { tool: "Read", pattern: null });
});

test("path patterns follow gitignore: anywhere, anchored, absolute, home, folders", () => {
  // No slash: the name in any folder.
  assert.ok(pathPatternMatches(".env", "/w/.env", ctx));
  assert.ok(pathPatternMatches(".env", "/w/app/.env", ctx));
  assert.ok(pathPatternMatches("*.md", "/w/docs/a.md", ctx));
  // With a slash: from the folder's root.
  assert.ok(pathPatternMatches("src/**", "/w/src/a/b.ts", ctx));
  assert.ok(!pathPatternMatches("src/**", "/w/lib/src/b.ts", ctx));
  assert.ok(pathPatternMatches("/docs/*.md", "/w/docs/a.md", ctx));
  assert.ok(pathPatternMatches("./docs/*.md", "/w/docs/a.md", ctx));
  // A folder covers what's inside.
  assert.ok(pathPatternMatches("src", "/w/src/x/y.ts", ctx));
  assert.ok(pathPatternMatches("/migrations", "/w/migrations/001.sql", ctx));
  // Absolute and home.
  assert.ok(pathPatternMatches("//etc/hosts", "/etc/hosts", ctx));
  assert.ok(pathPatternMatches("~/notes/*.md", "/home/u/notes/a.md", ctx));
  assert.ok(!pathPatternMatches("~/notes/*.md", "/w/notes/a.md", ctx));
  assert.ok(!pathPatternMatches("~/x", "/home/u/x", { root: "/w" }));
  // Outside the folder: a relative pattern doesn't reach there.
  assert.ok(!pathPatternMatches("src/**", "/other/src/a.ts", ctx));
  // Windows: backslashes and case don't matter.
  const win = { root: "C:\\Work\\App" };
  assert.ok(pathPatternMatches("src/**", "c:/work/app/SRC/a.ts", win));
  assert.ok(pathPatternMatches("//C:/Temp/*.log", "C:/temp/a.log", win));
});

test("calls an entry stands for: file tools by path, web.fetch by domain", () => {
  assert.ok(patternEntryMatches("Read(.env)", "read_file", { path: ".env" }, ctx));
  assert.ok(patternEntryMatches("Read(.env)", "read_file", { path: "/w/api/.env" }, ctx));
  assert.ok(!patternEntryMatches("Read(.env)", "read_file", { path: "a.ts" }, ctx));
  assert.ok(!patternEntryMatches("Read(.env)", "edit_file", { path: ".env" }, ctx));
  assert.ok(patternEntryMatches("Edit(src/**)", "write_file", { path: "src/a.ts" }, ctx));
  assert.ok(patternEntryMatches("Edit(src/**)", "edit_file", { path: "src\\a.ts" }, ctx));
  assert.ok(!patternEntryMatches("Write(src/**)", "edit_file", { path: "src/a.ts" }, ctx));
  assert.ok(patternEntryMatches("Read(src)", "list_dir", { path: "src" }, ctx));
  assert.ok(!patternEntryMatches("Read(src)", "list_dir", {}, ctx));
  // A whole file tool isn't this module's (slash.ts matches it by name).
  assert.ok(!patternEntryMatches("Read", "read_file", { path: "a" }, ctx));
  const fetch = (url: string) => ({ id: "web.fetch", input: { url } });
  assert.ok(patternEntryMatches("WebFetch", "call_command", fetch("https://x.org"), ctx));
  // The web_fetch tool (D292) is the same call.
  assert.ok(patternEntryMatches("WebFetch", "web_fetch", { url: "https://x.org" }, ctx));
  assert.ok(
    patternEntryMatches("WebFetch(domain:docs.rs)", "web_fetch", { url: "https://docs.rs/a" }, ctx),
  );
  assert.ok(
    !patternEntryMatches("WebFetch(domain:docs.rs)", "web_fetch", { url: "https://x.org" }, ctx),
  );
  assert.ok(
    patternEntryMatches(
      "WebFetch(domain:docs.rs)",
      "call_command",
      fetch("https://docs.rs/a"),
      ctx,
    ),
  );
  assert.ok(
    patternEntryMatches(
      "WebFetch(domain:docs.rs)",
      "call_command",
      fetch("https://api.docs.rs/a"),
      ctx,
    ),
  );
  assert.ok(
    !patternEntryMatches(
      "WebFetch(domain:docs.rs)",
      "call_command",
      fetch("https://evil-docs.rs/a"),
      ctx,
    ),
  );
  assert.ok(!patternEntryMatches("WebFetch", "call_command", { id: "git.push", input: {} }, ctx));
  assert.ok(!patternEntryMatches("Grep(src)", "search", { query: "x" }, ctx));
});

test("paths with . and .. are folded before matching; deny rules ignore case (D226 audit)", () => {
  const ctx = { root: "/w" };
  const m = (
    e: string,
    tool: string,
    path: string,
    c: Parameters<typeof patternEntryMatches>[3] = ctx,
  ) => patternEntryMatches(e, tool, { path }, c);
  assert.equal(m("Edit(src/**)", "edit_file", "src/../package.json"), false);
  assert.equal(m("Edit(src/**)", "edit_file", "src\\..\\..\\x"), false);
  assert.equal(m("Edit(src/**)", "edit_file", "src/a/b.ts"), true);
  assert.equal(m("Edit(*.md)", "edit_file", "../../home/u/x.md"), false);
  assert.equal(m("Read(/secret/**)", "read_file", "x/../secret/a"), true);
  assert.equal(m("Read(.env)", "read_file", ".ENV", { ...ctx, foldCase: true }), true);
  assert.equal(
    m("Edit(src/**)", "edit_file", "C:\\w\\src\\..\\..\\Windows\\x", { root: "C:\\w" }),
    false,
  );
});

test("Read rules cover search and find_files (D229, as Claude Code's cover Grep and Glob)", () => {
  // A search limited to a refused folder is the refused read.
  assert.equal(
    patternEntryMatches("Read(secrets/**)", "search", { query: "k", include: ["secrets"] }, ctx),
    true,
  );
  assert.equal(
    patternEntryMatches(
      "Read(secrets/**)",
      "search",
      { query: "k", include: ["secrets", "src"] },
      ctx,
    ),
    false,
  );
  assert.equal(patternEntryMatches("Read(secrets/**)", "search", { query: "k" }, ctx), false);
  // D306: its path argument too.
  assert.equal(
    patternEntryMatches("Read(secrets/**)", "search", { pattern: "k", path: "secrets" }, ctx),
    true,
  );
  assert.equal(
    patternEntryMatches("Read(.env)", "search", { pattern: "k", path: ".env" }, ctx),
    true,
  );
  assert.equal(
    patternEntryMatches("Read(secrets/**)", "search", { pattern: "k", path: "src" }, ctx),
    false,
  );
  // A whole-folder search keeps the refused files' lines out.
  assert.equal(
    withoutRefusedResults(
      ["Read(.env)"],
      "search",
      "src/a.ts:3: KEY\n.env:1: KEY=1\nconfig/.env:2: X",
      ctx,
    ),
    "src/a.ts:3: KEY\n(2 results the command's disallowed-tools refuses left out.)",
  );
  assert.equal(
    withoutRefusedResults(
      ["Read(/dist/**)", "Bash(rm:*)"],
      "find_files",
      "dist/a.js\nsrc/a.ts",
      ctx,
    ),
    "src/a.ts\n(1 result the command's disallowed-tools refuses left out.)",
  );
  // D306: search's context lines, counts and file lists name their files too.
  assert.equal(
    withoutRefusedResults(
      ["Read(.env)"],
      "search",
      "src/a.ts:3: KEY\n.env-1- before\n.env:2: KEY=1\n--\n.env:4\nsrc/a.ts:1\n.env",
      ctx,
    ),
    "src/a.ts:3: KEY\n--\nsrc/a.ts:1\n(4 results the command's disallowed-tools refuses left out.)",
  );
  assert.equal(withoutRefusedResults(["Read(.env)"], "read_file", ".env:1: x", ctx), ".env:1: x");
  assert.equal(withoutRefusedResults([], "search", "a:1: b", ctx), "a:1: b");
});

test("multi-root: patterns are relative to the folder holding the path", () => {
  const multi = {
    root: "/w",
    home: "/home/u",
    folders: [
      { path: "/w", name: "w" },
      { path: "/libs/api", name: "api" },
    ],
  };
  // A path in the second folder, by its name or absolute.
  assert.equal(
    patternEntryMatches("Read(src/**)", "read_file", { path: "api/src/a.ts" }, multi),
    true,
  );
  assert.equal(
    patternEntryMatches("Read(/secrets/**)", "read_file", { path: "/libs/api/secrets/k" }, multi),
    true,
  );
  assert.equal(
    patternEntryMatches("Read(/secrets/**)", "read_file", { path: "api/lib/k" }, multi),
    false,
  );
  // The first folder as before.
  assert.equal(patternEntryMatches("Read(src/**)", "read_file", { path: "src/a.ts" }, multi), true);
  // Outside every folder: a relative pattern doesn't reach it.
  assert.equal(pathPatternMatches("secrets/**", "/other/secrets/k", multi), false);
  // Home and absolute patterns are unchanged.
  assert.equal(pathPatternMatches("~/notes/**", "/home/u/notes/a", multi), true);
  // A refused name in the second folder is left out of results too.
  assert.equal(
    withoutRefusedResults(["Read(.env)"], "find_files", "api/.env\napi/src/a.ts", multi),
    "api/src/a.ts\n(1 result the command's disallowed-tools refuses left out.)",
  );
});

test("multi-root: nested folders match the pattern from either", () => {
  const nested = {
    root: "/repo",
    folders: [
      { path: "/repo", name: "repo" },
      { path: "/repo/packages/pkg", name: "pkg" },
    ],
  };
  assert.equal(
    pathPatternMatches("/packages/pkg/secret", "/repo/packages/pkg/secret", nested),
    true,
  );
  assert.equal(pathPatternMatches("/secret", "/repo/packages/pkg/secret", nested), true);
});
