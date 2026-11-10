import assert from "node:assert/strict";
import { test } from "node:test";
import {
  guessWebhookKind,
  parseWebhookSetting,
  safeNotifyMessage,
  webhookRequest,
  webhookUrlIsSecret,
  webhookUrlProblem,
} from "./webhook";

test("the message is one line, without code or secrets, at most 200 characters", () => {
  assert.equal(
    safeNotifyMessage("Build done\n\nall `npm test` green"),
    "Build done all npm test green",
  );
  assert.equal(safeNotifyMessage("see ```\nrm -rf /\n``` now"), "see now");
  assert.equal(safeNotifyMessage("key sk-abcdefghijklmnop123 leaked"), "key [hidden] leaked");
  assert.equal(safeNotifyMessage("token=abc123 set"), "[hidden] set");
  assert.equal(safeNotifyMessage(`id ${"a1".repeat(20)} x`), "id [hidden] x");
  const long = safeNotifyMessage("word ".repeat(100));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith("…"));
});

test("each kind's request", () => {
  const ntfy = webhookRequest("ntfy", "Tests pass", "Fix login – é");
  assert.equal(ntfy.body, "Tests pass");
  assert.match(ntfy.contentType, /^text\/plain/);
  assert.deepEqual(ntfy.headers, { Title: "Fix login", Tags: "robot" });

  const discord = JSON.parse(
    webhookRequest("discord", "Need a decision @everyone", "Chat *1*").body,
  );
  assert.equal(discord.content, "**Chat 1**: Need a decision @everyone");
  assert.deepEqual(discord.allowed_mentions, { parse: [] });

  const slack = JSON.parse(webhookRequest("slack", "a <b> & c", "T").body);
  assert.equal(slack.text, "*T*: a &lt;b&gt; &amp; c");

  const json = webhookRequest("json", "Done", "T", { chat: "s1", folder: "api", at: 0 });
  assert.equal(json.contentType, "application/json");
  assert.deepEqual(JSON.parse(json.body), {
    title: "T",
    message: "Done",
    chat: "s1",
    folder: "api",
    at: "1970-01-01T00:00:00.000Z",
  });
});

test("https only, http to this machine", () => {
  assert.equal(webhookUrlProblem("https://ntfy.sh/topic"), null);
  assert.equal(webhookUrlProblem("http://127.0.0.1:11998/hook"), null);
  assert.equal(webhookUrlProblem("http://localhost/x"), null);
  assert.match(webhookUrlProblem("http://example.com/x") ?? "", /https/);
  assert.match(webhookUrlProblem("ftp://x") ?? "", /https/);
  assert.match(webhookUrlProblem("nope") ?? "", /URL/);
});

test("which URLs are secrets", () => {
  assert.ok(webhookUrlIsSecret("ntfy", "https://ntfy.sh/mytopic"));
  assert.ok(webhookUrlIsSecret("discord", "https://discord.com/api/webhooks/1/abc"));
  assert.ok(webhookUrlIsSecret("json", "https://x.dev/hook?key=1"));
  assert.ok(webhookUrlIsSecret("json", "https://me:pw@x.dev/hook"));
  assert.ok(webhookUrlIsSecret("json", "https://x.dev/hooks/T0001ABCDEFGHIJ1234567"));
  assert.ok(!webhookUrlIsSecret("json", "http://127.0.0.1:11998/hook"));
});

test("the setting and guessing the kind", () => {
  assert.deepEqual(parseWebhookSetting({ kind: "json", url: " http://localhost/h " }), {
    kind: "json",
    url: "http://localhost/h",
  });
  assert.deepEqual(parseWebhookSetting({ kind: "ntfy", secret: true, host: "ntfy.sh" }), {
    kind: "ntfy",
    secret: true,
    host: "ntfy.sh",
  });
  assert.equal(parseWebhookSetting({ kind: "pager", url: "https://x" }), null);
  assert.equal(parseWebhookSetting(null), null);
  assert.equal(guessWebhookKind("https://discord.com/api/webhooks/1/x"), "discord");
  assert.equal(guessWebhookKind("https://hooks.slack.com/services/x"), "slack");
  assert.equal(guessWebhookKind("https://ntfy.sh/t"), "ntfy");
  assert.equal(guessWebhookKind("https://example.com/h"), "json");
});
