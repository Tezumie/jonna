import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "../run";
import { permissionAnswer, questionAnswer } from "./asks";
import { diffCounts, unifiedDiff } from "./diffText";
import { accessModeOf } from "./interactive";
import { hostCandidates } from "./launch";
import { EventRenderer, toolBrief } from "./render";
import { ago, chatLines } from "./sessionsCommand";
import { FRONT_COMMANDS, MultiLine, parseLine, pick } from "./slash";
import { makeStyle, PLAIN, stripAnsi } from "./style";

test("the session's own slash commands, by name and by their other names", () => {
  assert.deepEqual(parseLine("/help"), { kind: "front", command: "help", args: "" });
  assert.deepEqual(parseLine("  /model  ollama/qwen3:8b "), {
    kind: "front",
    command: "model",
    args: "ollama/qwen3:8b",
  });
  assert.deepEqual(parseLine("/quit"), { kind: "front", command: "exit", args: "" });
  assert.deepEqual(parseLine("/clear"), { kind: "front", command: "new", args: "" });
  assert.deepEqual(parseLine("/?"), { kind: "front", command: "help", args: "" });
  assert.deepEqual(parseLine("/PERMISSIONS auto"), {
    kind: "front",
    command: "permissions",
    args: "auto",
  });
  for (const name of [
    "help",
    "model",
    "mode",
    "permissions",
    "sessions",
    "resume",
    "new",
    "clear",
    "compact",
    "cost",
    "exit",
  ])
    assert.equal(parseLine(`/${name}`).kind, "front", name);
});

test("any other slash command goes to the agent as typed", () => {
  assert.deepEqual(parseLine("/undo"), { kind: "agent", name: "undo", text: "/undo" });
  assert.deepEqual(parseLine("/review the auth code"), {
    kind: "agent",
    name: "review",
    text: "/review the auth code",
  });
  assert.equal(parseLine("/mcp__github__issue 12").kind, "agent");
  assert.equal(parseLine("/plugin:skill").kind, "agent");
});

test("a path or a lone slash is a message, and an empty line is nothing", () => {
  assert.deepEqual(parseLine("/usr/bin/env is missing"), {
    kind: "message",
    text: "/usr/bin/env is missing",
  });
  assert.equal(parseLine("/").kind, "message");
  assert.equal(parseLine("what does a/b mean").kind, "message");
  assert.equal(parseLine("   ").kind, "empty");
  assert.deepEqual(parseLine("line one\nline two"), {
    kind: "message",
    text: "line one\nline two",
  });
});

test("command names and aliases are unique", () => {
  const names = FRONT_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  assert.equal(new Set(names).size, names.length);
});

test("a trailing backslash continues the message on the next line", () => {
  const multi = new MultiLine();
  assert.equal(multi.add("first \\"), null);
  assert.equal(multi.open, true);
  assert.equal(multi.add("second\\"), null);
  assert.equal(multi.add("third"), "first \nsecond\nthird");
  assert.equal(multi.open, false);
  // Two backslashes are a backslash, not a continuation.
  assert.equal(multi.add("a path\\\\"), "a path\\\\");
  assert.equal(multi.add("partial\\"), null);
  multi.reset();
  assert.equal(multi.add("fresh"), "fresh");
});

test("picking from a numbered list: a number, a name, or a unique part of one", () => {
  const models = ["ollama/qwen3:8b", "ollama/llama3", "claude/sonnet"];
  const names = (m: string) => [m, m.split("/")[1] ?? ""];
  assert.equal(pick("2", models, names), "ollama/llama3");
  assert.equal(pick("9", models, names), null);
  assert.equal(pick("sonnet", models, names), "claude/sonnet");
  assert.equal(pick("QWEN", models, names), "ollama/qwen3:8b");
  assert.equal(pick("ollama", models, names), null); // two match
  assert.equal(pick("", models, names), null);
});

test("a permission's answer as typed", () => {
  assert.equal(permissionAnswer("y", true), "once");
  assert.equal(permissionAnswer("YES", false), "once");
  assert.equal(permissionAnswer("a", true), "always");
  // Always isn't offered: once.
  assert.equal(permissionAnswer("always", false), "once");
  assert.equal(permissionAnswer("n", true), "deny");
  assert.equal(permissionAnswer("", true), "deny");
  assert.equal(permissionAnswer(null, true), "deny");
  // Anything else is asked again, never taken for a yes.
  assert.equal(permissionAnswer("sure why not", true), null);
});

test("a question's answer: numbers pick options, words are the person's own, nothing skips", () => {
  const options = [{ label: "OAuth" }, { label: "API key" }, { label: "None" }];
  assert.equal(questionAnswer("2", options, false), "API key");
  assert.equal(questionAnswer("1, 3", options, true), "OAuth, None");
  assert.equal(questionAnswer("1 3", options, false), "OAuth");
  assert.equal(questionAnswer("use SSO instead", options, false), "use SSO instead");
  assert.equal(questionAnswer("7", options, false), "7");
  assert.equal(questionAnswer("", options, false), "The user skipped this question");
  assert.equal(questionAnswer(null, [], false), "The user skipped this question");
});

test("the access mode the settings and a chat amount to", () => {
  assert.equal(accessModeOf("ask", false), "ask");
  assert.equal(accessModeOf(undefined, true), "accept-edits");
  assert.equal(accessModeOf("auto", true), "auto");
  assert.equal(accessModeOf("full", false), "full-access");
});

test("where the host program is looked for", () => {
  const sep = process.platform === "win32" ? "\\" : "/";
  const exe = process.platform === "win32" ? "ide-host.exe" : "ide-host";
  const bundle = process.platform === "win32" ? "C:\\app\\resources\\cli" : "/app/resources/cli";
  assert.equal(hostCandidates("custom-host", {}, bundle).length, 1);
  assert.equal(hostCandidates(undefined, { IDE_HOST_PATH: "from-env" }, bundle).length, 1);
  const found = hostCandidates(undefined, {}, bundle);
  // Beside the bundle, then beside the app's own program two folders up.
  assert.equal(found[0], `${bundle}${sep}${exe}`);
  assert.ok(found.some((p) => p.endsWith(`app${sep}${exe}`)));
  assert.ok(found.some((p) => p.includes(`src-tauri${sep}target${sep}debug`)));
});

test("a unified diff with context, and its counts", () => {
  const before = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
  const after = "one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\n";
  assert.deepEqual(diffCounts(before, after), { added: 2, removed: 1 });
  assert.deepEqual(diffCounts(null, "a\nb\n"), { added: 2, removed: 0 });
  const diff = unifiedDiff("src/a.ts", before, after, PLAIN, { context: 1 });
  assert.equal(
    diff,
    [
      "--- src/a.ts",
      "+++ src/a.ts",
      "@@ -2,3 +2,3 @@",
      " two",
      "-three",
      "+THREE",
      " four",
      "@@ -8,1 +8,2 @@",
      " eight",
      "+nine",
      "",
    ].join("\n"),
  );
  assert.match(unifiedDiff("new.txt", null, "x\n", PLAIN), /^--- \/dev\/null\n\+\+\+ new\.txt\n/);
  assert.equal(unifiedDiff("same.txt", "x\n", "x\n", PLAIN), "");
  assert.match(
    unifiedDiff("big.txt", "", "a\n".repeat(50), PLAIN, { maxLines: 10 }),
    /… 43 more lines/,
  );
});

test("saved chats as a list", () => {
  const now = 1_700_000_000_000;
  assert.equal(ago(now - 30_000, now), "just now");
  assert.equal(ago(now - 5 * 60_000, now), "5 min ago");
  assert.equal(ago(now - 3 * 3_600_000, now), "3 h ago");
  assert.equal(ago(now - 5 * 86_400_000, now), "5 days ago");
  assert.equal(ago(0, now), "");
  const lines = chatLines(
    [
      { id: "abc", title: "Fix the\nlogin", updated: now - 60_000, workspace: "C:\\w", here: true },
      { id: "defgh", title: "Other", updated: 0, workspace: null, here: false },
    ],
    PLAIN,
    now,
    true,
    100,
  ).split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /^ {2}1 {2}abc {4}1 min ago {4}Fix the login {2}C:\\w$/);
  assert.match(lines[1] ?? "", /^ {2}2 {2}defgh/);
});

test("what a tool call is about, in a few words", () => {
  assert.equal(toolBrief("run_command", { command: "npm test", cwd: "x" }), "npm test");
  assert.equal(toolBrief("write_file", { content: "long text", path: "src/a.ts" }), "src/a.ts");
  assert.equal(toolBrief("search", { pattern: "TODO" }), "TODO");
  assert.equal(toolBrief("mcp__echo__echo", { text: "hello" }), "hello");
  assert.equal(toolBrief("list_things", {}), "");
  assert.equal(toolBrief("x", null), "");
});

test("events as text: the answer, tool calls with their outcome, refusals, notices", () => {
  let out = "";
  const renderer = new EventRenderer(
    (text) => {
      out += text;
    },
    { style: makeStyle(false, false), verbose: false, answer: true, columns: () => 80 },
  );
  const events: SessionEvent[] = [
    { session: "s", type: "turn.start" },
    { session: "s", type: "text", id: "a1", delta: "I'll write " },
    { session: "s", type: "text", id: "a1", delta: "the file." },
    { session: "s", type: "tool.start", id: "t1", callId: "c1", name: "write_file", args: {} },
    {
      session: "s",
      type: "tool.update",
      id: "t1",
      args: { path: "notes.txt", content: "hi" },
    },
    { session: "s", type: "edit", path: "notes.txt", line: 1, state: "applied" },
    {
      session: "s",
      type: "tool.end",
      id: "t1",
      callId: "c1",
      name: "write_file",
      status: "done",
      summary: "+1 -0",
    },
    {
      session: "s",
      type: "tool.start",
      id: "t2",
      callId: "c2",
      name: "run_command",
      args: { command: "git push" },
    },
    {
      session: "s",
      type: "permission.decision",
      title: "Run `git push`",
      code: "git push",
      answer: "deny",
      by: "policy",
      rule: "git push",
    },
    { session: "s", type: "tool.output", id: "t2", delta: "not shown unless verbose" },
    {
      session: "s",
      type: "tool.end",
      id: "t2",
      callId: "c2",
      name: "run_command",
      status: "denied",
    },
    { session: "s", type: "notice", id: "n1", text: "Paused after 3 steps.", tone: "info" },
    { session: "s", type: "text", id: "a2", delta: "Done.\x1b[2J" },
    {
      session: "s",
      type: "turn.end",
      reason: "end",
      text: "Done.",
      usage: {
        context: null,
        totals: { requests: 1, input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
        cost: null,
      },
    },
  ];
  for (const event of events) renderer.handle(event);
  assert.equal(
    stripAnsi(out),
    [
      "I'll write the file.",
      "",
      "* write_file notes.txt",
      "  -> notes.txt:1 written",
      "  -> +1 -0",
      "* run_command git push",
      "  x Refused: git push (denied by git push)",
      "  -> refused",
      "",
      "> Paused after 3 steps.",
      "",
      "Done.",
      "",
    ].join("\n"),
  );
});

test("a one-shot run's progress leaves the answer's text out", () => {
  let out = "";
  const renderer = new EventRenderer(
    (text) => {
      out += text;
    },
    { style: PLAIN, verbose: true, answer: false, columns: () => 80 },
  );
  renderer.handle({ session: "s", type: "text", id: "a1", delta: "the answer" });
  renderer.handle({
    session: "s",
    type: "tool.start",
    id: "t1",
    callId: "c1",
    name: "run_command",
    args: { command: "echo hi" },
  });
  renderer.handle({ session: "s", type: "tool.output", id: "t1", delta: "hi\r\n" });
  renderer.handle({
    session: "s",
    type: "tool.end",
    id: "t1",
    callId: "c1",
    name: "run_command",
    status: "error",
    result: "exit 1\nmore",
  });
  renderer.flush();
  assert.equal(out, "* run_command echo hi\n    hi\n  -> exit 1\n");
});

test("/conflict is the session's own: which version of a chat saved elsewhere to keep", () => {
  assert.deepEqual(parseLine("/conflict mine"), {
    kind: "front",
    command: "conflict",
    args: "mine",
  });
});
