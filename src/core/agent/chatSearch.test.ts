import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chatMessagesOf,
  hitsText,
  parseQuery,
  type SearchableChat,
  scoreText,
  searchChats,
  snippetOf,
} from "./chatSearch";
import type { Item } from "./conversation";

test("parseQuery drops common words and short ones", () => {
  assert.deepEqual(parseQuery("How do I fix the Login bug"), {
    terms: ["fix", "login", "bug"],
    phrase: "how do i fix the login bug",
  });
  assert.deepEqual(parseQuery("the").terms, ["the"]);
  assert.deepEqual(parseQuery("  ").terms, []);
  assert.equal(parseQuery("webpack").phrase, null);
});

test("scoreText: more of the words beats one word repeated; the phrase counts most", () => {
  const q = parseQuery("login bug");
  const both = scoreText("the login bug is back", q);
  const repeated = scoreText("login login login login", q);
  assert.ok(both > repeated);
  assert.ok(scoreText("a bug in login", q) < both);
  assert.equal(scoreText("nothing here", q), 0);
});

test("snippetOf shows the text around the first match", () => {
  const long = `${"x ".repeat(200)}the login bug ${"y ".repeat(200)}`;
  const s = snippetOf(long, parseQuery("login"), 60);
  assert.ok(s.startsWith("…") && s.endsWith("…"));
  assert.ok(s.includes("login"));
  assert.equal(snippetOf("short text", parseQuery("zzz")), "short text");
});

test("chatMessagesOf numbers the messages and leaves tools and harness notes out", () => {
  const items = [
    { type: "user", id: "u1", text: "fix login" },
    { type: "tool", id: "t1", name: "read_file", args: {}, status: "done", result: "login" },
    { type: "assistant", id: "a0", text: "", thinking: "" },
    { type: "assistant", id: "a1", text: "Fixed it", thinking: "" },
    { type: "user", id: "u2", text: "carry on", auto: "continue" },
    { type: "user", id: "u3", text: "Scheduled", auto: "schedule" },
  ] as Item[];
  assert.deepEqual(
    chatMessagesOf(items).map((m) => [m.n, m.item, m.role]),
    [
      [1, "u1", "user"],
      [2, "a1", "agent"],
      [3, "u3", "user"],
    ],
  );
});

test("searchChats ranks by title and best messages, newest on a tie", () => {
  const now = Date.UTC(2026, 10, 6);
  const msg = (n: number, text: string, role: "user" | "agent" = "user") => ({
    n,
    item: `i${n}`,
    role,
    text,
  });
  const chats: SearchableChat[] = [
    { id: "a", title: "Refactor", updated: now - 1000, messages: [msg(1, "the login bug again")] },
    { id: "b", title: "Login bug", updated: now - 5000, messages: [msg(1, "hello")] },
    { id: "c", title: "Other", updated: now, messages: [msg(1, "nothing")] },
    { id: "d", title: "Refactor", updated: now, messages: [msg(1, "the login bug again")] },
  ];
  const hits = searchChats(chats, "login bug", 10, now);
  assert.deepEqual(
    hits.map((h) => h.id),
    ["b", "d", "a"],
  );
  assert.equal(hits[1]?.matches[0]?.n, 1);
  assert.equal(searchChats(chats, "login bug", 1, now).length, 1);
  assert.deepEqual(searchChats(chats, "", 5, now), []);
  const text = hitsText(hits.slice(1, 2));
  assert.match(text, /^d · "Refactor" · 2026-11-06\n {2}#1 \(user\): the login bug again$/);
});
