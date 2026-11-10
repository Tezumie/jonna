import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chatAgentOf,
  chatMessageText,
  idleNoteText,
  readChatMessage,
  SendLimiter,
  wentIdle,
} from "./chatMessages";

test("the message says where it's from and reads back for the chat's card", () => {
  const text = chatMessageText({ id: "s1", title: "Fix login" }, "Can you check\nthe tests?", true);
  assert.match(text, /^Message from chat "Fix login" \(s1\)\n\nCan you check\nthe tests\?\n\n/);
  assert.match(text, /not typed by the user/);
  assert.deepEqual(readChatMessage(text), {
    title: "Fix login",
    id: "s1",
    body: "Can you check\nthe tests?",
  });
  assert.equal(readChatMessage("hello"), null);
});

test("the idle note carries the answer's first lines", () => {
  const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const note = idleNoteText({ id: "s2", title: "Docs" }, long);
  assert.match(note, /^Chat "Docs" \(s2\) is idle now\n\nIts last answer begins:\nline 0\n/);
  assert.match(note, /line 7$/);
  assert.match(idleNoteText({ id: "s2", title: "Docs" }, "Done."), /Its last answer:\nDone\.$/);
  assert.match(idleNoteText({ id: "s2", title: "Docs" }, ""), /didn't answer in words/);
});

test("a sender may send so many in a window", () => {
  const limit = new SendLimiter(2, 1000);
  assert.ok(limit.take("a", 0));
  assert.ok(limit.take("a", 10));
  assert.ok(!limit.take("a", 20));
  assert.ok(limit.take("b", 20));
  assert.ok(limit.take("a", 1500));
});

test("idle after the message was taken and answered", () => {
  const items = [
    { type: "user", id: "u1", text: "hi" },
    { type: "assistant", id: "a1", text: "old answer" },
  ];
  // Not taken yet (still waiting in the chat's queue).
  assert.equal(wentIdle(items, "m", "idle", false).done, false);
  const taken = [...items, { type: "user", id: "m", text: "msg" }];
  assert.equal(wentIdle(taken, "m", "idle", false).done, false);
  assert.equal(wentIdle(taken, "m", "running", true).done, false);
  // Ran and ended without words (a stop, an error): still news.
  assert.deepEqual(wentIdle(taken, "m", "idle", true), { done: true, answer: "" });
  const answered = [...taken, { type: "assistant", id: "a2", text: "new answer" }];
  assert.deepEqual(wentIdle(answered, "m", "idle", true), { done: true, answer: "new answer" });
});

test("which agent a chat is with", () => {
  assert.equal(chatAgentOf({}), "agent");
  assert.equal(chatAgentOf({ mode: "custom:reviewer" }), "reviewer");
  assert.equal(chatAgentOf({ members: ["agent", "scout"] }), "agent, scout");
});
