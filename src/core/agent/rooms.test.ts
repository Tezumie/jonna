import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "./conversation";
import {
  boardColumns,
  defaultRooms,
  dmAgent,
  dmRoomId,
  inboxGroups,
  isUnread,
  mostUsedModel,
  newRoomId,
  type Room,
  recentChats,
  roomActivity,
  roomBriefLine,
  roomMembers,
  roomName,
  roomNameProblem,
  shortAge,
  type ThreadRow,
  taskRoomName,
  threadRoom,
  threadStatus,
  threadsByMessage,
  withNewTeam,
  withNote,
} from "./rooms";

const room = (id: string, members: string[]): Room => ({
  id,
  name: id,
  members,
  purpose: "",
  created: 0,
});

test("roomName: Slack's channel names", () => {
  assert.equal(roomName("  #Front End!! "), "front-end");
  assert.equal(roomName("API_v2"), "api_v2");
  assert.equal(roomName("---"), "");
  assert.equal(roomName("x".repeat(60)).length, 40);
});

test("roomNameProblem: empty and taken names; an archived channel's name is free", () => {
  const rooms = [room("general", ["agent"]), { ...room("old", ["agent"]), archived: true }];
  assert.match(roomNameProblem("", rooms) ?? "", /needs a name/);
  assert.match(roomNameProblem("inbox", rooms) ?? "", /Inbox/, "the Inbox's name (D244)");
  assert.match(roomNameProblem("general", rooms) ?? "", /already exists/);
  assert.equal(roomNameProblem("general", rooms, "general"), null, "renaming to itself");
  assert.equal(roomNameProblem("old", rooms), null);
});

test("roomMembers: known names once, at least the main agent", () => {
  const known = (n: string) => ["agent", "builder", "reviewer"].includes(n);
  assert.deepEqual(roomMembers(["builder", "nope", "builder", "reviewer"], known), [
    "builder",
    "reviewer",
  ]);
  assert.deepEqual(roomMembers(["nope"], known), ["agent"]);
});

test("dm ids", () => {
  assert.equal(dmRoomId("builder"), "dm:builder");
  assert.equal(dmAgent("dm:builder"), "builder");
  assert.equal(dmAgent("general"), null);
});

test("threadRoom: its own room, else the DM of its agent, older group chats by members", () => {
  const rooms = [room("team", ["agent", "reviewer"])];
  const base: ThreadRow = { id: "s", title: "t", speaker: "agent", updated: 0 };
  assert.equal(threadRoom({ ...base, room: "x" }, rooms), "x");
  assert.equal(threadRoom({ ...base, speaker: "builder" }, rooms), "dm:builder");
  assert.equal(threadRoom({ ...base, members: ["reviewer", "agent"] }, rooms), "team");
  assert.equal(threadRoom({ ...base, members: ["reviewer", "builder"] }, rooms), "dm:agent");
});

test("inboxGroups: needs you, working, failed, done, newest first", () => {
  const rows: ThreadRow[] = [
    { id: "a", title: "a", speaker: "agent", updated: 1 },
    { id: "b", title: "b", speaker: "agent", updated: 5, running: true },
    { id: "c", title: "c", speaker: "agent", updated: 2, waiting: true, running: true },
    { id: "d", title: "d", speaker: "agent", updated: 3, failed: true },
  ];
  const groups = inboxGroups(rows);
  assert.deepEqual(
    groups.map((g) => [g.status, g.rows.map((r) => r.id)]),
    [
      ["needs-you", ["c"]],
      ["working", ["b"]],
      ["failed", ["d"]],
      ["done", ["a"]],
    ],
  );
  assert.equal(threadStatus(rows[2] as ThreadRow), "needs-you");
});

test("roomActivity", () => {
  const rooms = [room("general", ["agent", "builder"])];
  const rows: ThreadRow[] = [
    { id: "a", title: "a", speaker: "agent", room: "general", updated: 3, running: true },
    { id: "b", title: "b", speaker: "agent", room: "general", updated: 1, unread: true },
    { id: "c", title: "c", speaker: "builder", updated: 2, waiting: true },
  ];
  const act = roomActivity(rows, rooms);
  assert.deepEqual(act.get("general"), { needsYou: 0, working: 1, unread: 1 });
  assert.deepEqual(act.get("dm:builder"), { needsYou: 1, working: 0, unread: 0 });
});

test("defaultRooms and newRoomId", () => {
  const [general] = defaultRooms(["builder", "reviewer", "tester"], 7);
  assert.deepEqual(general?.members, ["agent", "builder", "reviewer", "tester"]);
  assert.equal(newRoomId("general", [room("general", [])]), "general-2");
  assert.equal(newRoomId("", []), "channel");
});

test("boardColumns: four columns, each newest first", () => {
  const rows: ThreadRow[] = [
    { id: "a", title: "a", speaker: "agent", updated: 1 },
    { id: "b", title: "b", speaker: "agent", updated: 2, failed: true },
    { id: "c", title: "c", speaker: "agent", updated: 3 },
  ];
  assert.deepEqual(
    boardColumns(rows).map((c) => [c.status, c.rows.map((r) => r.id)]),
    [
      ["needs-you", []],
      ["working", []],
      ["failed", ["b"]],
      ["done", ["c", "a"]],
    ],
  );
});

test("threadsByMessage: a conversation's threads under the messages they answer", () => {
  const parent = (item: string) => ({ session: "main", item, author: "You", text: "x" });
  const rows: ThreadRow[] = [
    { id: "t2", title: "", speaker: "agent", updated: 5, parent: parent("m1") },
    { id: "t1", title: "", speaker: "agent", updated: 1, parent: parent("m1") },
    { id: "t3", title: "", speaker: "agent", updated: 2, parent: parent("m2") },
    { id: "x", title: "", speaker: "agent", updated: 2 },
  ];
  const by = threadsByMessage(rows, "main");
  assert.deepEqual(
    by.get("m1")?.map((r) => r.id),
    ["t1", "t2"],
  );
  assert.equal(by.get("m2")?.length, 1);
  assert.equal(by.size, 2);
});

test("isUnread: replies newer than the last look", () => {
  assert.equal(isUnread({ updated: 5, replies: 0 }, undefined), false);
  assert.equal(isUnread({ updated: 5, replies: 1 }, undefined), true);
  assert.equal(isUnread({ updated: 5, replies: 1 }, 5), false);
  assert.equal(isUnread({ updated: 6, replies: 1 }, 5), true);
  assert.equal(isUnread({ updated: 6, replies: 1 }, undefined, 10), false, "older than tracking");
});

test("withNote: trimmed, no repeats, the oldest dropped past the limit", () => {
  assert.deepEqual(withNote(undefined, "  use  tabs "), ["use tabs"]);
  assert.deepEqual(withNote(["use tabs"], "use tabs"), ["use tabs"]);
  assert.deepEqual(withNote(["a"], "   "), ["a"]);
  const many = Array.from({ length: 30 }, (_, i) => `n${i}`);
  assert.deepEqual(withNote(many, "new").slice(-2), ["n29", "new"]);
  assert.equal(withNote(many, "new").length, 30);
});

test("roomBriefLine: the channel, its purpose, task and notes; a thread's parent", () => {
  const room: Room = {
    id: "web",
    name: "web",
    members: ["agent"],
    purpose: "The site.",
    created: 0,
    memory: ["We use Tailwind."],
    task: { status: "open" },
  };
  const parent = { session: "s", item: "i", author: "Builder", text: "Done.\nOk" };
  const line = roomBriefLine(room, parent) ?? "";
  assert.match(line, /^\[Channel\] You're in the #web channel\./);
  assert.match(line, /It's for: The site\./);
  assert.match(line, /that one task/);
  assert.match(line, /- We use Tailwind\./);
  assert.match(line, /message by Builder:\n> Done\.\n> Ok/);
  assert.equal(roomBriefLine(null, null), null);
});

test("taskRoomName: task- and the first words, unique", () => {
  assert.equal(
    taskRoomName("Fix the login page redirect bug now please", []),
    "task-fix-the-login-page-redirect",
  );
  const taken = [{ id: "x", name: "task-fix-it", members: [], purpose: "", created: 0 }];
  assert.equal(taskRoomName("fix it", taken), "task-fix-it-2");
});

test("the Recent list: this folder's chats first, then others'; all by time with none open (D245)", () => {
  const here = [
    { id: "a", updated: 1 },
    { id: "b", updated: 5 },
  ];
  const others = [
    { id: "x", updated: 9 },
    { id: "y", updated: 3 },
  ];
  assert.deepEqual(
    recentChats(here, others, true, 10).map((r) => r.id),
    ["b", "a", "x", "y"],
  );
  assert.deepEqual(
    recentChats(here, others, false, 10).map((r) => r.id),
    ["x", "b", "y", "a"],
  );
  assert.deepEqual(
    recentChats(here, others, true, 3).map((r) => r.id),
    ["b", "a", "x"],
  );
  assert.equal(shortAge(1000, 1000 + 5 * 60_000), "5 min");
  assert.equal(shortAge(1000, 1000), "now");
});

test("a #general the first team left as it was gets the new team (D245)", () => {
  const first = ["builder", "reviewer", "tester"];
  const team = ["planner", "builder", "chat"];
  const old = defaultRooms(first, 1)[0] as Room;
  const old2: Room = {
    ...old,
    purpose:
      "The whole team. Ask anything; the main agent takes it or hands parts to the builder, reviewer and tester.",
  };
  const [general] = withNewTeam([old2], first, team);
  assert.deepEqual(general?.members, ["agent", "planner", "builder", "chat", "reviewer", "tester"]);
  assert.match(general?.purpose ?? "", /planner/);
  // Changed by the user: left alone.
  const mine: Room = { ...old, members: ["agent", "builder"] };
  assert.deepEqual(withNewTeam([mine], first, team)[0]?.members, ["agent", "builder"]);
});

test("a chat's logo is the model that wrote most of its replies, the latest on a tie (D364)", () => {
  const reply = (id: string, modelKey?: string): Item => ({
    type: "assistant",
    id,
    text: "x",
    thinking: "",
    streaming: false,
    ...(modelKey && { modelKey }),
  });
  assert.equal(mostUsedModel([]), undefined);
  assert.equal(mostUsedModel([reply("a")]), undefined);
  assert.equal(
    mostUsedModel([reply("a", "openai/gpt"), reply("b", "acp/claude"), reply("c", "openai/gpt")]),
    "openai/gpt",
  );
  assert.equal(mostUsedModel([reply("a", "openai/gpt"), reply("b", "acp/claude")]), "acp/claude");
  // Saved without a key (D405): an external agent's name on the reply gives it one.
  const named: Item = { ...reply("c"), model: "Codex" } as Item;
  const keyOf = (m: string) => (m === "Codex" ? "acp/Codex" : undefined);
  assert.equal(mostUsedModel([named], keyOf), "acp/Codex");
  assert.equal(mostUsedModel([{ ...reply("d"), model: "gpt-5" } as Item], keyOf), undefined);
});
