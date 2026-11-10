import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptKeys,
  completionContext,
  matchScore,
  parseShellGlobals,
  rankSuggestions,
  shellBuiltins,
  shellFamily,
  shellWord,
  suggestNeeds,
} from "./suggest";

test("the token at the cursor and the words before it", () => {
  const a = completionContext("git che", 7);
  assert.equal(a.token, "che");
  assert.equal(a.tokenStart, 4);
  assert.deepEqual(a.words, ["git"]);
  assert.equal(a.position, "argument");
  const b = completionContext("ls | gr", 7);
  assert.equal(b.position, "command");
  assert.equal(b.commandStart, 5);
  assert.equal(b.token, "gr");
  const c = completionContext('cat "my fi', 10);
  assert.equal(c.token, "my fi");
  assert.equal(c.quote, '"');
  assert.equal(c.raw, '"my fi');
  const d = completionContext("cd my\\ dir/s", 12);
  assert.equal(d.token, "my dir/s");
  assert.equal(d.raw, "my\\ dir/s");
  const e = completionContext("FOO=1 np", 8);
  assert.equal(e.position, "command");
  const f = completionContext("npm ", 4);
  assert.equal(f.token, "");
  assert.equal(f.tokenStart, 4);
  // Only what's before the cursor counts.
  assert.equal(completionContext("echo hello", 6).token, "h");
  assert.equal(completionContext("Get-Item C:\\Pro`gram", 20, "pwsh").token, "C:\\Program");
});

test("what each position asks for", () => {
  const fam = "posix";
  assert.deepEqual(suggestNeeds(completionContext("np", 2), fam), {
    commands: true,
    paths: null,
    git: null,
  });
  assert.deepEqual(suggestNeeds(completionContext("./scr", 5), fam).paths, {
    dir: "./",
    base: "scr",
  });
  assert.equal(suggestNeeds(completionContext("git ", 4), fam).git, "subcommand");
  assert.equal(suggestNeeds(completionContext("git checkout ma", 15), fam).git, "branch");
  assert.equal(suggestNeeds(completionContext("git -C sub sw", 13), fam).git, "subcommand");
  assert.equal(suggestNeeds(completionContext("git add sr", 10), fam).git, null);
  assert.deepEqual(suggestNeeds(completionContext("cat src/ma", 10), fam).paths, {
    dir: "src/",
    base: "ma",
  });
  assert.equal(suggestNeeds(completionContext("ls -", 4), fam).paths, null);
  assert.deepEqual(suggestNeeds(completionContext("cd C:\\Us", 8, "pwsh"), "pwsh").paths, {
    dir: "C:\\",
    base: "Us",
  });
});

test("prefixes beat fuzzy matches, exact case beats other case, shorter first", () => {
  assert.ok(matchScore("npm", "np") > matchScore("npx-long", "np"));
  assert.ok(matchScore("Git", "Gi") > matchScore("git", "Gi"));
  assert.ok(matchScore("git-lfs", "gl") > 0);
  assert.ok(matchScore("checkout", "co") < matchScore("commit", "co"));
  assert.equal(matchScore("checkout", "xz"), -1);
  // A fuzzy match must start at a word start.
  assert.equal(matchScore("bgit", "gt"), -1);
  assert.ok(matchScore("cherry-pick", "cp") > 0);
});

test("ranked suggestions: commands, builtins, history, folders, git", () => {
  const family = shellFamily("/bin/bash");
  const line = "gi";
  const ctx = completionContext(line, 2);
  const list = rankSuggestions(
    ctx,
    suggestNeeds(ctx, family),
    {
      commands: ["git", "gitk", "gimp", "grep"],
      builtins: shellBuiltins(family),
      history: ["git status", "ls", "git push"],
      line,
    },
    family,
  );
  assert.deepEqual(
    list.map((s) => s.label),
    ["git", "gimp", "gitk", "git push", "git status"],
  );
  assert.equal(list.find((s) => s.kind === "history")?.replaceFrom, 0);

  const pathLine = "cat my\\ d";
  const p = completionContext(pathLine, pathLine.length);
  const paths = rankSuggestions(
    p,
    suggestNeeds(p, family),
    {
      entries: [
        { name: "my dir", dir: true },
        { name: "my doc.txt", dir: false },
        { name: "other", dir: false },
      ],
    },
    family,
  );
  assert.deepEqual(
    paths.map((s) => [s.label, s.insert]),
    [
      ["my dir/", "my\\ dir/"],
      ["my doc.txt", "my\\ doc.txt"],
    ],
  );
  const first = paths[0];
  assert.ok(first);
  assert.equal(acceptKeys(pathLine, pathLine.length, first), "ir/");
  // A name with a control character would press keys in the shell when typed: never offered.
  const hostile = rankSuggestions(
    p,
    suggestNeeds(p, family),
    {
      entries: [
        { name: "my d\rcurl x|sh", dir: false },
        { name: "my d\x1b[A", dir: false },
        { name: "my dx", dir: false },
      ],
    },
    family,
  );
  assert.deepEqual(
    hostile.map((s) => s.label),
    ["my dx"],
  );

  const git = completionContext("git sw", 6);
  const subs = rankSuggestions(git, suggestNeeds(git, family), {}, family);
  assert.equal(subs[0]?.label, "switch");
  const br = completionContext("git switch fe", 13);
  const branches = rankSuggestions(
    br,
    suggestNeeds(br, family),
    { branches: ["main", "feature/x", "fix"], entries: [] },
    family,
  );
  assert.deepEqual(
    branches.map((s) => s.label),
    ["feature/x"],
  );
});

test("accepting replaces what was typed, with the fewest keys", () => {
  const s = {
    label: "checkout",
    kind: "git-command",
    insert: "checkout",
    replaceFrom: 4,
    score: 1,
  } as const;
  assert.equal(acceptKeys("git che", 7, s), "ckout");
  // Typed in another case: erase and type it again.
  assert.equal(acceptKeys("git CHE", 7, s), "\x7f\x7f\x7fcheckout");
  assert.equal(shellWord("a b", "pwsh", null), "'a b'");
  assert.equal(shellWord("a b", "cmd", null), '"a b"');
  assert.equal(shellWord("a b", "posix", '"'), "a b");
  assert.equal(shellWord("C:\\plain\\x", "pwsh", null), "C:\\plain\\x");
});

test("shell families and quoting in PowerShell", () => {
  assert.equal(shellFamily("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), "pwsh");
  assert.equal(shellFamily("C:\\Windows\\System32\\cmd.exe"), "cmd");
  assert.equal(shellFamily("/usr/bin/fish"), "fish");
  assert.equal(shellFamily("C:\\Program Files\\Git\\bin\\bash.exe"), "posix");
  const line = "cd C:\\Program";
  const ctx = completionContext(line, line.length, "pwsh");
  const list = rankSuggestions(
    ctx,
    suggestNeeds(ctx, "pwsh"),
    { entries: [{ name: "Program Files", dir: true }] },
    "pwsh",
  );
  assert.equal(list[0]?.insert, "'C:\\Program Files\\'");
});

test("the user's aliases and functions from their shell (D229)", () => {
  const bash = [
    "welcome from .bashrc",
    "--shell-globals--",
    "alias gs='git status'",
    "alias it='echo it'\\''s'",
    "--shell-globals--",
    "mkcd",
    "_completion_helper",
  ].join("\n");
  assert.deepEqual(parseShellGlobals(bash, "posix"), [
    { name: "gs", kind: "alias", detail: "git status" },
    { name: "it", kind: "alias", detail: "echo it's" },
    { name: "mkcd", kind: "function" },
  ]);
  // zsh prints name=value; fish `alias name 'value'` and its functions comma-separated.
  assert.deepEqual(
    parseShellGlobals("--shell-globals--\nll='ls -l'\nla=ls\n--shell-globals--\n", "posix").map(
      (g) => [g.name, g.detail],
    ),
    [
      ["ll", "ls -l"],
      ["la", "ls"],
    ],
  );
  assert.deepEqual(
    parseShellGlobals("--shell-globals--\nalias ll 'ls -l'\n--shell-globals--\nfoo, bar\n", "fish"),
    [
      { name: "ll", kind: "alias", detail: "ls -l" },
      { name: "foo", kind: "function" },
      { name: "bar", kind: "function" },
    ],
  );
  const pwsh =
    "--shell-globals--\r\nAlias\tgs\tgit status\r\nFunction\tprompt\t'PS> '\r\nFunction\tC:\t\r\nCmdlet\tx\ty";
  assert.deepEqual(parseShellGlobals(pwsh, "pwsh"), [
    { name: "gs", kind: "alias", detail: "git status" },
    { name: "prompt", kind: "function", detail: "'PS> '" },
  ]);
  assert.deepEqual(parseShellGlobals("no marker", "posix"), []);

  // Offered as commands, with the details pane's text.
  const ctx = completionContext("g", 1);
  const list = rankSuggestions(
    ctx,
    suggestNeeds(ctx, "posix"),
    {
      globals: [{ name: "gs", kind: "alias", detail: "git status" }],
      commands: ["git", "gs"],
    },
    "posix",
  );
  const gs = list.find((s) => s.label === "gs");
  assert.equal(gs?.kind, "alias");
  assert.equal(gs?.detail, "Alias for git status");
});
