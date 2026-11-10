import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bashAllowed,
  callDisallowed,
  canonicalSlash,
  commandFileFor,
  commandNameFor,
  commandTools,
  expandArguments,
  fileRefs,
  inlineShell,
  lineDisallowed,
  mergeTurnTools,
  parseCommandFile,
  parseSlash,
  preApprovedCall,
  rankSlashCommands,
  shellRefs,
  splitArgs,
  turnToolsFor,
} from "./slash";

test("command file: front matter and body", () => {
  const f = parseCommandFile(
    "---\ndescription: Fix an issue\nargument-hint: [issue] [priority]\nmodel: ollama/qwen3:8b\nallowed-tools: Bash(git add:*), Bash(git status), Read\n---\nFix issue $1\n",
  );
  assert.equal(f.description, "Fix an issue");
  assert.equal(f.argumentHint, "[issue] [priority]");
  assert.equal(f.model, "ollama/qwen3:8b");
  assert.deepEqual(f.allowedTools, ["Bash(git add:*)", "Bash(git status)", "Read"]);
  assert.equal(f.body, "Fix issue $1");
  assert.deepEqual(parseCommandFile("Just a prompt").allowedTools, []);
});

test("slash message and arguments", () => {
  assert.deepEqual(parseSlash("/fix  the bug "), { name: "fix", args: "the bug" });
  assert.deepEqual(parseSlash("/compact"), { name: "compact", args: "" });
  assert.equal(parseSlash("not /a command"), null);
  assert.deepEqual(splitArgs(`123 "high priority" 'x y' z`), ["123", "high priority", "x y", "z"]);
  assert.equal(
    expandArguments("Fix $1 at $2 ($ARGUMENTS)", `42 "now please"`),
    `Fix 42 at now please (42 "now please")`,
  );
  assert.equal(expandArguments("Missing $3.", "a"), "Missing .");
  assert.equal(
    expandArguments("Review the code.", "auth module"),
    "Review the code.\n\nArguments: auth module",
  );
  assert.equal(expandArguments("Review the code.", ""), "Review the code.");
  assert.equal(expandArguments("Price $10", "x"), "Price $10\n\nArguments: x");
});

test("shell lines and files", () => {
  const body = "Status: !`git status`\nDiff: !`git diff HEAD`\nAgain !`git status`\nSee @src/a.ts";
  assert.deepEqual(shellRefs(body), ["git status", "git diff HEAD"]);
  const out = inlineShell(body, new Map([["git status", "clean\n"]]));
  assert.match(out, /```\n\$ git status\nclean\n```/);
  assert.match(out, /!`git diff HEAD`/);
  assert.deepEqual(fileRefs(body), ["src/a.ts"]);
});

test("allowed-tools: Bash patterns approve shell lines", () => {
  const tools = ["Bash(git status:*)", "Bash(npm test)", "Read"];
  assert.ok(bashAllowed(tools, "git status"));
  assert.ok(bashAllowed(tools, "git status --short"));
  assert.ok(!bashAllowed(tools, "git statusx"));
  assert.ok(bashAllowed(tools, "npm test"));
  assert.ok(!bashAllowed(tools, "npm test -- --watch"));
  assert.ok(!bashAllowed(tools, "git status; rm -rf /"));
  assert.ok(!bashAllowed(tools, "git status && curl x"));
  assert.ok(bashAllowed(["Bash"], "ls"));
  assert.ok(!bashAllowed(["Bash"], "ls | sh"));
  assert.ok(!bashAllowed(["Read"], "ls"));
  // A newline is a second command, though the line is compared with it as a space.
  assert.ok(!bashAllowed(tools, "git status\nrm -rf ~"));
  assert.ok(!bashAllowed(["Bash"], "ls\r\ncurl x"));
});

test("commands in subfolders are folder:name (D203)", () => {
  assert.equal(commandNameFor("test.md"), "test");
  assert.equal(commandNameFor("frontend/test.md"), "frontend:test");
  assert.equal(commandNameFor("frontend/forms/check.md"), "frontend:forms:check");
  assert.equal(commandNameFor("a/b/c/d.md"), null);
  assert.equal(commandNameFor("front end/test.md"), null);
  assert.equal(commandNameFor("frontend/notes.txt"), null);
  assert.equal(commandFileFor("frontend:test"), "frontend/test.md");
  assert.equal(commandFileFor("test"), "test.md");
  assert.equal(commandFileFor("a:b:c:d"), null);
  assert.equal(commandFileFor("a::b"), null);
  assert.deepEqual(parseSlash("/frontend:test the form"), {
    name: "frontend:test",
    args: "the form",
  });
  assert.equal(parseSlash("/frontend:"), null);
});

test("allowed-tools narrows the turn's tools, read-only ones stay (D203)", () => {
  // Spaces separate tools too (Claude Code's other spelling), not inside a pattern.
  assert.deepEqual(
    parseCommandFile("---\nallowed-tools: Bash(git add *) Bash(git commit *) Read\n---\nx")
      .allowedTools,
    ["Bash(git add *)", "Bash(git commit *)", "Read"],
  );
  const available = [
    { name: "read_file", readOnly: true },
    { name: "search", readOnly: true },
    { name: "edit_file", readOnly: false },
    { name: "write_file", readOnly: false },
    { name: "run_command", readOnly: false },
    { name: "call_command", readOnly: false },
    { name: "mcp__github__create_issue", readOnly: false },
    { name: "mcp__jira__create", readOnly: false },
  ];
  assert.equal(commandTools([], available), null);
  assert.deepEqual(commandTools(["Bash(git diff:*)"], available), [
    "read_file",
    "search",
    "run_command",
  ]);
  assert.deepEqual(commandTools(["Edit", "write_file", "mcp__github"], available), [
    "read_file",
    "search",
    "edit_file",
    "write_file",
    "mcp__github__create_issue",
  ]);
  assert.deepEqual(commandTools(["mcp__jira__create"], available), [
    "read_file",
    "search",
    "mcp__jira__create",
  ]);
  // Names it doesn't know leave the read-only tools.
  assert.deepEqual(commandTools(["NotATool"], available), ["read_file", "search"]);
  // WebFetch keeps call_command (web.fetch goes through it, D221).
  assert.deepEqual(commandTools(["WebFetch(domain:docs.rs)"], available), [
    "read_file",
    "search",
    "call_command",
  ]);
});

test("disallowed-tools and pre-approval from the user's own commands (D207)", () => {
  const f = parseCommandFile(
    "---\nallowed-tools: Bash(git status:*), Edit, mcp__github\ndisallowed-tools: [WebSearch, Bash(git push:*)]\n---\nGo",
  );
  assert.deepEqual(f.disallowedTools, ["WebSearch", "Bash(git push:*)"]);
  assert.deepEqual(parseCommandFile("---\ndisallowedTools: Write\n---\nx").disallowedTools, [
    "Write",
  ]);
  // A project's file narrows only; the user's own also pre-approves.
  assert.deepEqual(turnToolsFor(f, false)?.preApproved, []);
  assert.deepEqual(turnToolsFor(f, true)?.preApproved, f.allowedTools);
  assert.equal(turnToolsFor(parseCommandFile("plain"), true), null);
  const available = [
    { name: "read_file", readOnly: true },
    { name: "web_search", readOnly: true },
    { name: "edit_file", readOnly: false },
    { name: "write_file", readOnly: false },
    { name: "run_command", readOnly: false },
  ];
  // Disallowed whole tools go (read-only ones too); a Bash pattern doesn't take run_command away.
  assert.deepEqual(commandTools([], available, ["WebSearch", "Bash(git push:*)"]), [
    "read_file",
    "edit_file",
    "write_file",
    "run_command",
  ]);
  assert.deepEqual(commandTools(["Edit", "Write"], available, ["Write"]), [
    "read_file",
    "web_search",
    "edit_file",
  ]);
  assert.equal(commandTools([], available, ["Bash(rm:*)"]), null);
  assert.ok(lineDisallowed(["Bash(git push:*)"], "git push origin main"));
  assert.ok(lineDisallowed(["Bash(git push:*)"], "git status && git  push"));
  assert.ok(!lineDisallowed(["Bash(git push:*)"], "git pushx"));
  assert.ok(lineDisallowed(["Bash(git push:*)"], "GIT Push origin"));
  assert.ok(lineDisallowed(["Bash(Npm Publish)"], "npm publish"));
  assert.ok(lineDisallowed(["Bash(npm publish)"], "npm publish"));
  assert.ok(!lineDisallowed(["Bash"], "ls"));
  // Pre-approval: Bash by its patterns, other tools by name, a server's tools by its prefix.
  const pre = ["Bash(git status:*)", "Edit", "mcp__github", "Read(src/**)"];
  assert.ok(preApprovedCall(pre, "run_command", { command: "git status --short" }));
  assert.ok(!preApprovedCall(pre, "run_command", { command: "git status; rm -rf x" }));
  assert.ok(!preApprovedCall(pre, "run_command", { command: "npm test" }));
  assert.ok(preApprovedCall(pre, "edit_file", { path: "a.ts" }));
  assert.ok(preApprovedCall(pre, "mcp__github__create_issue", {}));
  // Without a folder a relative pattern covers nothing.
  assert.ok(!preApprovedCall(pre, "read_file", { path: "src/a.ts" }));
  assert.ok(!preApprovedCall([], "edit_file", {}));
});

test("patterns on other tools (D221): paths and domains, pre-approved and disallowed", () => {
  const ctx = { root: "/w" };
  const pre = ["Edit(src/**)", "WebFetch(domain:docs.rs)", "Read(src/**)"];
  assert.ok(preApprovedCall(pre, "edit_file", { path: "src/a.ts" }, ctx));
  assert.ok(preApprovedCall(pre, "write_file", { path: "/w/src/b.ts" }, ctx));
  assert.ok(!preApprovedCall(pre, "edit_file", { path: "package.json" }, ctx));
  assert.ok(preApprovedCall(pre, "read_file", { path: "src/a.ts" }, ctx));
  const fetch = (url: string) => ({ id: "web.fetch", input: { url } });
  assert.ok(preApprovedCall(pre, "call_command", fetch("https://docs.rs/x"), ctx));
  assert.ok(!preApprovedCall(pre, "call_command", fetch("https://example.com"), ctx));
  // WebFetch alone is web.fetch only, never every IDE command.
  assert.ok(preApprovedCall(["WebFetch"], "call_command", fetch("https://a.b"), ctx));
  assert.ok(!preApprovedCall(["WebFetch"], "call_command", { id: "git.push", input: {} }, ctx));
  // disallowed-tools: lines, files and sites.
  const no = ["Bash(git push:*)", "Read(.env)", "Edit(/migrations/**)", "WebFetch"];
  assert.ok(callDisallowed(no, "run_command", { command: "git push" }, ctx));
  assert.ok(!callDisallowed(no, "run_command", { command: "git status" }, ctx));
  assert.ok(callDisallowed(no, "read_file", { path: "api/.env" }, ctx));
  assert.ok(!callDisallowed(no, "read_file", { path: "api/env.ts" }, ctx));
  assert.ok(callDisallowed(no, "write_file", { path: "migrations/1.sql" }, ctx));
  assert.ok(!callDisallowed(no, "write_file", { path: "src/migrations/1.sql" }, ctx));
  assert.ok(callDisallowed(no, "call_command", fetch("https://x.y"), ctx));
  assert.ok(!callDisallowed(no, "call_command", { id: "git.status" }, ctx));
  assert.ok(!callDisallowed([], "read_file", { path: ".env" }, ctx));
  // A disallowed WebFetch doesn't take call_command away from the turn.
  const available = [
    { name: "read_file", readOnly: true },
    { name: "call_command", readOnly: false },
  ];
  assert.equal(commandTools([], available, ["WebFetch"]), null);
});

test("turn tools merged: a skill adds pre-approvals, never widens a command's narrowing", () => {
  assert.equal(mergeTurnTools(null, null), null);
  assert.equal(mergeTurnTools(null, { preApproved: [] }), null);
  assert.deepEqual(mergeTurnTools(null, { preApproved: ["Bash(npm test)"] }), {
    allowed: [],
    disallowed: [],
    preApproved: ["Bash(npm test)"],
  });
  const command = { allowed: ["Read"], disallowed: ["Write"], preApproved: ["Read"] };
  assert.deepEqual(mergeTurnTools(command, { preApproved: ["Edit", "Read"] }), {
    allowed: ["Read"],
    disallowed: ["Write"],
    preApproved: ["Read", "Edit"],
  });
});

test("a nested skill's /folder:name parses; WebSearch(…) is the whole tool (D229)", () => {
  assert.deepEqual(parseSlash("/apps/web:deploy now"), { name: "apps/web:deploy", args: "now" });
  const available = [
    { name: "web_search", readOnly: true },
    { name: "read_file", readOnly: true },
  ];
  assert.deepEqual(commandTools([], available, ["WebSearch(anything)"]), ["read_file"]);
});

test("rankSlashCommands: name prefix, then an alias, then contains, then the description (D389)", () => {
  const commands = [
    { name: "clear", description: "Start a new chat", aliases: ["new", "reset"] },
    { name: "compact", description: "Summarize the conversation so far" },
    { name: "undo", description: "Put back the files the last turn changed" },
    { name: "context", description: "How full the context is" },
    { name: "review", description: "Review the uncommitted changes" },
  ];
  const names = (q: string) => rankSlashCommands(q, commands).map((c) => c.name);
  assert.deepEqual(names(""), ["clear", "compact", "undo", "context", "review"]);
  assert.deepEqual(names("co"), ["compact", "context"]);
  assert.deepEqual(names("/NEW"), ["clear"]);
  assert.deepEqual(names("do"), ["undo"]);
  assert.deepEqual(names("files"), ["undo"]);
  assert.deepEqual(names("uncommitted changes"), ["review"]);
  assert.deepEqual(names("zzz"), []);
});

test("canonicalSlash: another name runs its command; others stay as they are (D389)", () => {
  const commands = [{ name: "clear", description: "", aliases: ["new", "reset"] }];
  assert.equal(canonicalSlash("/new", commands), "/clear");
  assert.equal(canonicalSlash("/reset now", commands), "/clear now");
  assert.equal(canonicalSlash("/clear", commands), "/clear");
  assert.equal(canonicalSlash("/newsletter", commands), "/newsletter");
  assert.equal(canonicalSlash("hello /new", commands), "hello /new");
});
