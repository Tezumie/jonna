import assert from "node:assert/strict";
import { test } from "node:test";
import { chatMessageText, idleNoteText, readChatMessage } from "./chatMessages";
import {
  decodeMail,
  encodeMail,
  otherWindowChats,
  parseWindowChats,
  shouldRepublish,
  type WindowChats,
} from "./windowChats";

const win = (pid: number, folder: string, at: number, ids: string[]): WindowChats => ({
  pid,
  folder,
  at,
  chats: ids.map((id) => ({ id, title: `T ${id}`, agent: "agent", status: "idle" })),
});

test("other windows' chats: not this window's, not ones loaded here, each once", () => {
  const list = otherWindowChats(
    [
      win(1, "C:\\work\\api", 100, ["a", "b"]),
      win(2, "/home/me/web/", 200, ["c", "b"]),
      win(3, "", 50, ["d"]),
      win(9, "C:\\mine", 300, ["own"]),
    ],
    9,
    new Set(["a"]),
  );
  const byId = new Map(list.map((c) => [c.id, c]));
  assert.deepEqual([...byId.keys()].sort(), ["b", "c", "d"]);
  // b is in two windows: the newer record's.
  assert.equal(byId.get("b")?.window, "web");
  assert.equal(byId.get("c")?.folderPath, "/home/me/web/");
  assert.equal(byId.get("d")?.window, "");
});

test("a window's record is checked", () => {
  const r = parseWindowChats(
    JSON.stringify({
      pid: 4,
      folder: "/x",
      at: 5,
      chats: [
        { id: "s1", title: "One", agent: "agent", status: "working" },
        { id: "../bad", title: "x" },
        { id: "s2", status: "weird" },
      ],
    }),
  );
  assert.ok(r);
  assert.deepEqual(
    r.chats.map((c) => [c.id, c.status, c.title]),
    [
      ["s1", "working", "One"],
      ["s2", "idle", "Chat"],
    ],
  );
  assert.equal(parseWindowChats("nope"), null);
  assert.equal(parseWindowChats('{"chats": []}'), null);
});

test("mail round-trips; anything else is dropped", () => {
  const mail = {
    kind: "message" as const,
    to: "s2",
    from: { id: "s1", title: "Fix login", window: "api" },
    text: "Run the tests",
    notify: true,
  };
  assert.deepEqual(decodeMail(encodeMail(mail)), mail);
  assert.equal(decodeMail('{"kind":"other"}'), null);
  assert.equal(decodeMail("{"), null);
  const idle = decodeMail(
    JSON.stringify({ kind: "idle", to: "s1", from: { id: "s2", title: "T" }, text: "done" }),
  );
  assert.deepEqual(idle?.from, { id: "s2", title: "T", window: "" });
  assert.equal(idle?.notify, undefined);
});

test("a message from another window names it, and reads back", () => {
  const text = chatMessageText({ id: "s1", title: "Fix login", window: "api" }, "Hello", false);
  assert.match(text, /^Message from chat "Fix login" \(s1\) in window "api"\n\nHello\n/);
  assert.deepEqual(readChatMessage(text), {
    title: "Fix login",
    id: "s1",
    body: "Hello",
    window: "api",
  });
  assert.match(
    idleNoteText({ id: "s2", title: "Docs", window: "web" }, "ok"),
    /^Chat "Docs" \(s2\) in window "web" is idle now/,
  );
});

test("republish when the chats change or the record gets old", () => {
  assert.ok(shouldRepublish(null, "a", 0, 1000));
  assert.ok(!shouldRepublish({ text: "a", at: 0 }, "a", 500, 1000));
  assert.ok(shouldRepublish({ text: "a", at: 0 }, "b", 500, 1000));
  assert.ok(shouldRepublish({ text: "a", at: 0 }, "a", 1000, 1000));
});
