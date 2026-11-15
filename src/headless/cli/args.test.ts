import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CliArgs,
  closest,
  decideMode,
  editDistance,
  FLAGS,
  flagsOf,
  mayAsk,
  parseArgs,
  UsageError,
} from "./args";
import { helpText } from "./help";

const usage = (argv: string[], pattern: RegExp) =>
  assert.throws(
    () => parseArgs(argv),
    (err: unknown) => err instanceof UsageError && pattern.test(err.message),
    `${argv.join(" ")} should be a usage error matching ${pattern}`,
  );

test("a prompt is positional words, -p, or exec", () => {
  assert.equal(parseArgs(["fix", "the", "bug"]).prompt, "fix the bug");
  const p = parseArgs(["-p", "fix the bug"]);
  assert.equal(p.prompt, "fix the bug");
  assert.equal(p.promptFlag, true);
  const exec = parseArgs(["exec", "fix it", "--max-steps", "3"]);
  assert.equal(exec.command, "exec");
  assert.equal(exec.prompt, "fix it");
  assert.equal(exec.maxSteps, 3);
  assert.equal(parseArgs(["--prompt=--weird start"]).prompt, "--weird start");
  // Everything after -- is the prompt, dashes and all.
  assert.equal(parseArgs(["--", "--not-a-flag", "x"]).prompt, "--not-a-flag x");
});

test("-p alone and - read the prompt from standard input", () => {
  const alone = parseArgs(["-p"]);
  assert.equal(alone.promptFlag, true);
  assert.equal(alone.prompt, undefined);
  const before = parseArgs(["-p", "--output-format", "json"]);
  assert.equal(before.prompt, undefined);
  assert.equal(before.outputFormat, "json");
  assert.equal(parseArgs(["-"]).stdinPrompt, true);
  assert.equal(parseArgs(["exec", "-"]).stdinPrompt, true);
});

test("every flag of the specification parses", () => {
  const a = parseArgs([
    "-p",
    "go",
    "--cwd",
    "C:\\work dir\\proj",
    "--add-dir",
    "../lib",
    "--add-dir=../docs",
    "--model",
    "ollama/qwen3:8b",
    "--agent",
    "Reviewer",
    "--effort",
    "high",
    "--mode",
    "plan",
    "--permission-mode",
    "accept-edits",
    "--allow",
    "npm test",
    "--allow",
    "write_file",
    "--deny",
    "git push",
    "--non-interactive",
    "--output-format",
    "stream-json",
    "--max-steps",
    "12",
    "--max-cost",
    "0.5",
    "--timeout",
    "90",
    "--review",
    "--user-data-dir",
    "D:\\profiles\\x",
    "--host",
    "C:\\bin\\ide-host.exe",
    "--verbose",
  ]);
  const expected: Partial<CliArgs> = {
    command: "main",
    prompt: "go",
    cwd: "C:\\work dir\\proj",
    addDirs: ["../lib", "../docs"],
    model: "ollama/qwen3:8b",
    agent: "Reviewer",
    effort: "high",
    mode: "plan",
    permissionMode: "accept-edits",
    allow: ["npm test", "write_file"],
    deny: ["git push"],
    nonInteractive: true,
    outputFormat: "stream-json",
    maxSteps: 12,
    maxCost: 0.5,
    timeout: 90,
    review: true,
    userDataDir: "D:\\profiles\\x",
    host: "C:\\bin\\ide-host.exe",
    verbose: true,
  };
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(a[key as keyof CliArgs], value, key);
});

test("which chat: --continue, --resume, --session-id, one at a time", () => {
  assert.equal(parseArgs(["-c"]).continue, true);
  assert.equal(parseArgs(["--resume", "abc123"]).resume, "abc123");
  assert.equal(parseArgs(["-r"]).resume, true);
  assert.equal(parseArgs(["--session-id", "my-run_1"]).sessionId, "my-run_1");
  usage(["-c", "--resume", "x"], /one of --continue/);
  usage(["--session-id", "has space"], /letters, digits/);
});

test("an unknown option is an error with the nearest one", () => {
  usage(["--modle", "x"], /Unknown option --modle\. Did you mean --mode/);
  usage(["--permision-mode", "ask"], /Did you mean --permission-mode\?/);
  usage(["--outputformat", "json"], /Did you mean --output-format\?/);
  usage(["-x"], /Unknown option -x/);
  usage(["--zzzzzz"], /Unknown option --zzzzzz\.$/);
  // An option of another subcommand says where it belongs.
  usage(["--port", "1"], /--port belongs to: serve/);
  usage(["serve", "--continue"], /--continue isn't an option of serve/);
});

test("values are checked", () => {
  usage(["--model"], /--model needs a value/);
  usage(["--max-steps", "many"], /needs a number/);
  usage(["--max-steps", "0"], /1 or more/);
  usage(["--timeout", "0"], /above 0/);
  usage(["--permission-mode", "yolo"], /one of ask, accept-edits, auto, full-access/);
  usage(["--output-format", "jsno"], /Did you mean json\?/);
  usage(["--mode", "agnt"], /Did you mean agent\?/);
  usage(["--verbose=yes"], /takes no value/);
  usage(["-p", "a", "b"], /given twice/);
  usage(["--prompt-file", "t.md", "also"], /not both/);
  usage(["-i", "-p", "x"], /--interactive starts a session/);
  usage(["-i", "--non-interactive"], /exclude each other/);
});

test("subcommands", () => {
  assert.deepEqual(
    [parseArgs(["sessions"]).sessionsAction, parseArgs(["sessions", "list", "--all"]).all],
    ["list", true],
  );
  const show = parseArgs(["sessions", "show", "abc", "--json"]);
  assert.deepEqual([show.sessionsAction, show.sessionsId, show.json], ["show", "abc", true]);
  usage(["sessions", "show"], /needs a chat's id/);
  usage(["sessions", "lst"], /Did you mean list\?/);
  usage(["serve", "hello"], /serve takes no prompt/);
  const serve = parseArgs(["serve", "--port", "4100", "--token", "s3cret"]);
  assert.deepEqual([serve.command, serve.port, serve.token], ["serve", 4100, "s3cret"]);
  assert.equal(parseArgs(["acp", "--permission-mode", "auto"]).permissionMode, "auto");
});

test("help and version, for the tool and per subcommand", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--version"]).version, true);
  const topic = parseArgs(["help", "sessions"]);
  assert.deepEqual([topic.help, topic.command], [true, "sessions"]);
  assert.deepEqual(
    [parseArgs(["serve", "--help"]).help, parseArgs(["serve", "--help"]).command],
    [true, "serve"],
  );
  usage(["help", "nothing"], /No command named nothing/);
  // Help wins over a missing argument.
  assert.equal(parseArgs(["sessions", "show", "--help"]).help, true);
  for (const command of ["main", "exec", "sessions", "serve", "acp"] as const) {
    const text = helpText("tool", command);
    assert.match(text, /Usage:/);
    assert.ok(!/undefined/.test(text), `${command} help mentions undefined`);
    // Every flag the subcommand takes is in its help.
    for (const flag of flagsOf(command)) assert.ok(text.includes(`--${flag.name}`), flag.name);
  }
  assert.match(helpText("tool", "main"), /Exit codes:[\s\S]*130/);
});

test("flag names and short names are unique", () => {
  const names = FLAGS.map((f) => f.name);
  assert.equal(new Set(names).size, names.length);
  const shorts = FLAGS.flatMap((f) => (f.short ? [f.short] : []));
  assert.equal(new Set(shorts).size, shorts.length);
});

test("the mode: a session at a terminal, one shot otherwise", () => {
  const terminal = { stdin: true, stdout: true };
  const piped = { stdin: false, stdout: true };
  assert.equal(decideMode(parseArgs([]), terminal), "interactive");
  assert.equal(decideMode(parseArgs(["start here"]), terminal), "interactive");
  assert.equal(decideMode(parseArgs(["-p", "x"]), terminal), "run");
  assert.equal(decideMode(parseArgs(["exec", "x"]), terminal), "run");
  assert.equal(decideMode(parseArgs(["--prompt-file", "t.md"]), terminal), "run");
  assert.equal(decideMode(parseArgs(["x"]), piped), "run");
  assert.equal(decideMode(parseArgs([]), piped), "run");
  assert.equal(decideMode(parseArgs(["-"]), terminal), "run");
  assert.equal(decideMode(parseArgs(["x"]), { stdin: true, stdout: false }), "run");
  assert.equal(decideMode(parseArgs(["-i"]), piped), "interactive");
  assert.equal(decideMode(parseArgs(["serve"]), terminal), "serve");
  assert.equal(decideMode(parseArgs(["acp"]), piped), "acp");
  assert.equal(decideMode(parseArgs(["sessions"]), piped), "sessions");
  assert.throws(() => decideMode(parseArgs([]), { stdin: true, stdout: false }), UsageError);
});

test("a one shot asks only with a terminal to type at, and never with --non-interactive", () => {
  const terminal = { stdin: true, stdout: true };
  const piped = { stdin: false, stdout: true };
  assert.equal(mayAsk(parseArgs(["-p", "x"]), "run", terminal), true);
  assert.equal(mayAsk(parseArgs(["-p", "x"]), "run", piped), false);
  assert.equal(mayAsk(parseArgs(["-p", "x", "--non-interactive"]), "run", terminal), false);
  assert.equal(mayAsk(parseArgs(["-p", "x", "--output-format", "json"]), "run", terminal), false);
  assert.equal(mayAsk(parseArgs([]), "interactive", piped), true);
  assert.equal(mayAsk(parseArgs(["serve"]), "serve", terminal), false);
});

test("edit distance and the nearest word", () => {
  assert.equal(editDistance("kitten", "sitting"), 3);
  assert.equal(editDistance("", "abc"), 3);
  assert.equal(closest("verbos", ["verbose", "version"]), "verbose");
  assert.equal(closest("xyz", ["verbose", "version"]), undefined);
  // The start of a longer name is what was meant.
  assert.equal(closest("perm", ["permission-mode", "prompt"]), "permission-mode");
});
