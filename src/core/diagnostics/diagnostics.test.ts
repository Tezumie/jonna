import assert from "node:assert/strict";
import { test } from "node:test";
import { describeError, LogBuffer } from "./logBuffer";
import { redactText, redactValue } from "./redact";
import { parseReleaseNotes, shouldShowReleaseNotes } from "./releaseNotes";
import { issueLink, MAX_ISSUE_URL, reportBody } from "./report";

test("redact: keys, tokens, passwords in URLs and pairs", () => {
  const t = redactText(
    "using sk-or-v1-0123456789abcdef0123 and github_pat_11ABCDEFG0123456789_abcdefghijkl",
  );
  assert.equal(t, "using <redacted> and <redacted>");
  assert.ok(!redactText("Authorization: Bearer eyJhbGciOi.abc").includes("eyJhbGciOi"));
  assert.equal(redactText('{"apiKey": "abcdef123"}'), '{"apiKey": "<redacted>"}');
  assert.equal(redactText("password=hunter22 rest"), "password=<redacted> rest");
  assert.equal(
    redactText("https://ada:pw123@git.example.com/repo.git"),
    "https://<redacted>@git.example.com/repo.git",
  );
  assert.equal(
    redactText("failed: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"),
    "failed: <redacted>",
  );
  assert.equal(
    redactText("x -----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY----- y"),
    "x -----BEGIN RSA PRIVATE KEY----- <redacted> y",
  );
  // Ordinary text stays.
  const plain = "editor.tabSize: 4, tokens: 120, author: Ada";
  assert.equal(redactText(plain), plain);
});

test("redact: home folders and user names", () => {
  assert.equal(
    redactText("C:\\Users\\Ada\\p\\a.ts and c:/users/ada/p/b.ts", "C:\\Users\\Ada"),
    "~\\p\\a.ts and ~/p/b.ts",
  );
  assert.equal(redactText("/home/bob/x /Users/eve/y"), "/home/<user>/x /Users/<user>/y");
  assert.equal(redactText("E:\\Users\\carol\\z"), "E:\\Users\\<user>\\z");
});

test("redact: state values lose secrets and file contents", () => {
  const value = {
    root: "/home/ada/proj",
    editors: [{ path: "/home/ada/proj/a.ts", text: "const secret = 1;", dirty: true }],
    settings: { "agent.openai.apiKey": "sk-abcdefghijklmnopqrstuvwx", "editor.tabSize": 2 },
    hasToken: true,
    note: "x".repeat(500),
    lines: ["a", "b"],
  };
  const out = redactValue(value, { home: "/home/ada" }) as Record<string, unknown>;
  assert.deepEqual(out, {
    root: "~/proj",
    editors: [{ path: "~/proj/a.ts", text: "<17 characters>", dirty: true }],
    settings: { "agent.openai.apiKey": "<redacted>", "editor.tabSize": 2 },
    hasToken: true,
    note: "<long text, 500 characters>",
    lines: "<2 items>",
  });
  // The input is untouched.
  assert.equal(value.editors[0]?.text, "const secret = 1;");
  const long = redactValue(Array.from({ length: 60 }, (_, i) => i)) as unknown[];
  assert.equal(long.length, 51);
  assert.equal(long[50], "<10 more>");
});

test("log buffer: batches, collapses repeats, caps a flood, keeps recent errors", () => {
  let now = 1_000_000;
  const log = new LogBuffer({ perMinute: 5, recentSize: 3, now: () => now });
  log.push("error", "window", "boom");
  log.push("error", "window", "boom");
  log.push("error", "window", "boom");
  log.push("info", "app", "hello");
  assert.deepEqual(
    log.drain().map((r) => r.message),
    ["boom (repeated 2 more times)", "hello"],
  );
  assert.equal(log.size, 0);
  assert.equal(log.push("warn", "ipc:fs_read", "denied"), true);
  assert.equal(log.push("error", "x", "six"), false); // the sixth this minute
  now += 60_000;
  log.push("error", "y", "later");
  const drained = log.drain();
  assert.ok(drained.some((r) => r.message.includes("1 more records were dropped")));
  // Recent errors: no infos, no repeats, at most 3.
  assert.deepEqual(
    log.recent().map((r) => r.message),
    ["boom", "denied", "later"],
  );
});

test("log buffer: errors described with their stack", () => {
  const e = new Error("bad thing");
  const text = describeError(e, 2);
  assert.ok(text.startsWith("Error: bad thing"));
  assert.ok(text.split("\n").length <= 3);
  assert.equal(describeError({ a: 1 }), '{"a":1}');
  assert.equal(describeError("plain"), "plain");
});

test("report: body and issue link, cut to fit with a note", () => {
  const body = reportBody("It crashed.", [
    { id: "system", title: "System", text: "Version: 1.0", included: true },
    { id: "state", title: "State", text: "{}", included: false },
    { id: "errors", title: "Recent errors", text: "has ``` fences", included: true },
  ]);
  assert.ok(body.includes("### What happened\n\nIt crashed."));
  assert.ok(body.includes("### System\n\n```\nVersion: 1.0\n```"));
  assert.ok(!body.includes("### State"));
  assert.ok(body.includes("````\nhas ``` fences\n````"));
  const short = issueLink("https://github.com/o/r/issues/", "Bug: x", body);
  assert.equal(short.truncated, false);
  assert.ok(short.url.startsWith("https://github.com/o/r/issues/new?title=Bug%3A%20x&body="));
  assert.equal(decodeURIComponent(short.url.split("&body=")[1] ?? ""), body);
  const huge = `${"é😀 line\n".repeat(2000)}`;
  const long = issueLink("https://github.com/o/r/issues", "t", huge);
  assert.equal(long.truncated, true);
  assert.ok(long.url.length <= MAX_ISSUE_URL);
  assert.ok(decodeURIComponent(long.url).includes("full report is on your clipboard"));
  // A very long title doesn't push the link past the limit.
  const titled = issueLink("https://github.com/o/r/issues", "😀".repeat(5000), huge);
  assert.ok(titled.url.length <= MAX_ISSUE_URL);
});

test("release notes: parsed by release, shown after an update only", () => {
  const notes = parseReleaseNotes(
    "# What's new\n\nintro\n\n## m7.5 — Report a problem\n\n- One\n\n## m7.4 - Jupyter\n- Two\n",
  );
  assert.deepEqual(
    notes.map((n) => [n.id, n.title, n.body]),
    [
      ["m7.5", "Report a problem", "- One"],
      ["m7.4", "Jupyter", "- Two"],
    ],
  );
  assert.equal(shouldShowReleaseNotes(null, "0.2.0", true), false);
  assert.equal(shouldShowReleaseNotes("0.1.0", "0.1.0", true), false);
  assert.equal(shouldShowReleaseNotes("0.1.0", "0.2.0", true), true);
  assert.equal(shouldShowReleaseNotes("0.1.0", "0.2.0", false), false);
});

test("redact: a long run of name characters takes linear time", () => {
  const started = performance.now();
  redactText("token".repeat(4_000)); // 20 KB: minutes before the name parts were bounded
  redactText("A".repeat(100_000));
  assert.ok(performance.now() - started < 2_000);
  assert.equal(redactText("my_api_key=abcdef123456"), "my_api_key=<redacted>");
});
