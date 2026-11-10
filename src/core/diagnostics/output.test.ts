import assert from "node:assert/strict";
import { test } from "node:test";
import {
  atLeast,
  type ChannelEntry,
  formatRecord,
  OutputService,
  parseChannelLevels,
  parseLevel,
} from "./output";
import {
  filterLines,
  gitCallRecord,
  gitCommandLine,
  gitReadsOnly,
  gitSubcommand,
  matchesFilter,
  parseOutputFilter,
} from "./outputText";

test("levels: what's kept under each threshold", () => {
  assert.equal(atLeast("error", "warn"), true);
  assert.equal(atLeast("info", "warn"), false);
  assert.equal(atLeast("trace", "trace"), true);
  assert.equal(parseLevel("debug"), "debug");
  assert.equal(parseLevel("verbose"), "info");
  assert.equal(parseLevel(undefined), "info");
});

test("channels keep records, sorted builtins first, files get all but the window's", async () => {
  const out = new OutputService(() => 0, 0);
  const written: ChannelEntry[] = [];
  out.setSink((e) => {
    written.push(...e);
  });
  out.append("window", "error", "boom");
  out.append("lsp.pyright", "info", "started", "Language server: Pyright", "lsp");
  out.append("git", "debug", "too quiet");
  out.setLevel("debug");
  out.append("git", "debug", "git_status 3 ms");
  assert.deepEqual(
    out.list().map((c) => c.id),
    ["window", "exthost", "git", "tasks", "agent", "lsp.pyright"],
  );
  assert.equal(out.label("lsp.pyright"), "Language server: Pyright");
  assert.equal(out.records("git").length, 1, "below the level wasn't kept");
  await out.flush();
  assert.deepEqual(
    written.map((e) => [e.channel, e.source, e.message]),
    [
      ["lsp.pyright", "lsp", "started"],
      ["git", "git", "git_status 3 ms"],
    ],
  );
  out.clear("git");
  assert.equal(out.text("git"), "");
  assert.match(
    formatRecord({ time: 0, level: "warn", text: "x" }),
    /^\d\d:\d\d:\d\d\.\d{3} \[warn\] x$/,
  );
  out.dispose();
});

test("a channel keeps its last records, long ones cut", () => {
  const out = new OutputService(() => 0, 0);
  for (let i = 0; i < 5100; i++) out.append("tasks", "info", `line ${i}`);
  assert.equal(out.records("tasks").length, 5000);
  assert.equal(out.records("tasks")[0]?.text, "line 100");
  out.append("tasks", "info", "x".repeat(9000));
  assert.ok((out.records("tasks").at(-1)?.text.length ?? 0) < 8100);
  out.dispose();
});

test("channels' own levels (log.channelLevels) over the default", () => {
  const out = new OutputService(() => 0, 0);
  out.setLevel("warn");
  out.setChannelLevels(parseChannelLevels({ git: "trace", tasks: "nope", agent: 3 }));
  assert.equal(out.levelOf("git"), "trace");
  assert.equal(out.levelOf("tasks"), "warn", "not a level: the default");
  assert.equal(out.ownLevel("agent"), undefined);
  assert.equal(out.append("git", "trace", "> git status"), true);
  assert.equal(out.append("exthost", "info", "quiet"), false);
  assert.equal(out.enabled("info"), false, "the Window channel follows the default");
  assert.equal(out.enabled("debug", "git"), true);
  const git = out.list().find((c) => c.id === "git");
  assert.deepEqual([git?.level, git?.ownLevel], ["trace", true]);
  out.setChannelLevels({});
  assert.equal(out.levelOf("git"), "warn");
  assert.deepEqual(parseChannelLevels(["x"]), {});
  out.dispose();
});

test("the Output tab's filter: any of the terms, none of the !excluded", () => {
  const f = parseOutputFilter(" Error, warn , !timeout,!, ");
  assert.deepEqual(f, { include: ["error", "warn"], exclude: ["timeout"] });
  assert.equal(matchesFilter("12:00 [error] boom", f), true);
  assert.equal(matchesFilter("12:00 [warn] request timeout", f), false);
  assert.equal(matchesFilter("12:00 [info] fine", f), false);
  assert.equal(matchesFilter("anything", parseOutputFilter("")), true);
  assert.deepEqual(filterLines(["a x", "b", "c x"], parseOutputFilter("!x")), ["b"]);
});

test("git calls as command lines: quoted, reads at trace, changes at info, failures warn", () => {
  assert.equal(
    gitCommandLine(["commit", "-m", 'say "hi"', "--", "C:\\w\\a b.ts", "C:\\w\\c.ts", ""]),
    'git commit -m "say \\"hi\\"" -- "C:\\w\\a b.ts" C:\\w\\c.ts ""',
  );
  assert.equal(gitSubcommand(["-c", "x=y", "-C", "dir", "status", "-z"]), "status");
  for (const args of [
    ["status", "-z"],
    ["rev-parse", "--show-toplevel"],
    ["branch", "-a", "--format=%(refname)"],
    ["tag", "--sort=-creatordate"],
    ["config", "--get", "user.name"],
    ["remote", "-v"],
    ["stash", "list"],
  ])
    assert.equal(gitReadsOnly(args), true, args.join(" "));
  for (const args of [
    ["commit", "-F", "-"],
    ["branch", "feature"],
    ["branch", "-D", "old"],
    ["tag", "-a", "v1", "-m", "x"],
    ["config", "user.name", "Ada"],
    ["remote", "add", "o", "url"],
    ["stash", "push"],
    ["push"],
  ])
    assert.equal(gitReadsOnly(args), false, args.join(" "));
  assert.deepEqual(gitCallRecord({ args: ["status"], ms: 3.4, error: null }), {
    level: "trace",
    text: "> git status [3 ms]",
  });
  assert.deepEqual(gitCallRecord({ args: ["push"], ms: 900, error: "rejected" }), {
    level: "warn",
    text: "> git push [900 ms]\nrejected",
  });
});
