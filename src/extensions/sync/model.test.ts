import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityLine,
  buildOverview,
  changedCount,
  countOf,
  fileKind,
  folderName,
  formatSize,
  groupFiles,
  LOG_LIMIT,
  type OverviewRecord,
  passSentence,
  platformLabel,
  projectCounts,
  retentionText,
  statusBarWords,
  storageNotice,
  storageShare,
  storageText,
  withEvent,
} from "./model";

test("sync: sizes and storage (D435)", () => {
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(640), "640 B");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(12 * 1024), "12 KB");
  assert.equal(formatSize(1024 ** 3), "1 GB");
  assert.equal(storageText(1.2 * 1024 ** 3, 50 * 1024 ** 3), "1.2 GB of 50 GB");
  assert.equal(storageText(2048, 0), "2 KB");
  assert.equal(storageShare(5, 10), 0.5);
  assert.equal(storageShare(50, 10), 1);
  assert.equal(storageShare(5, 0), 0);
});

test("sync: the status line", () => {
  assert.deepEqual(activityLine({ state: "idle", message: null, at: 5 }), {
    text: "Synced",
    time: 5,
  });
  assert.equal(activityLine({ state: "idle", message: null, at: null }).time, null);
  assert.equal(activityLine({ state: "syncing", message: null, at: 5 }).text, "Syncing…");
  assert.equal(activityLine({ state: "offline", message: "x", at: 5 }).text, "Offline: will retry");
  assert.equal(
    activityLine({ state: "error", message: "Storage is full.", at: 5 }).text,
    "Storage is full.",
  );
  assert.equal(
    activityLine({ state: "other", message: null, at: 5 }).text,
    "Another window is syncing",
  );
});

const record = (
  collection: string,
  id: string,
  more: Partial<OverviewRecord> = {},
): OverviewRecord => ({
  collection,
  id,
  deleted: false,
  text: "{}",
  device: null,
  updatedAt: null,
  ...more,
});

test("sync: what the account holds, from its records' labels", () => {
  const overview = buildOverview(
    [
      record("settings", "user", { info: { settings: 42 }, updatedAt: 1_700_000_000_000 }),
      record("files", "a", { info: { path: "snippets/go.json", bytes: 120 } }),
      record("files", "b", { info: { path: "keybindings.json", bytes: 30 } }),
      record("files", "c", { info: { path: "skills/old/SKILL.md", deleted: true } }),
      record("chats.account", "c1", { info: { updated: 5, bytes: 9 } }),
      record("chats.account", "c2", { info: { deleted: true }, text: '{"deleted":true}' }),
      record("projects", "p1", { info: { name: "site" }, updatedAt: 1_700_000_000_000 }),
      record("projects", "p2", { info: { name: "api" } }),
      record("chats.p1", "c3", { info: { updated: 1_700_000_100_000, bytes: 9 }, device: "d2" }),
      record("chats.p1", "c4", { info: { deleted: true } }),
      record("snap.p1", "s1", {
        info: { time: 1_700_000_200_000, computer: "Laptop", kind: "git", files: 3, bytes: 500 },
        device: "d1",
      }),
      record("snap.p1", "s2", {
        info: { time: 1_700_000_050_000, computer: "Desk", kind: "git", files: 2, bytes: 900 },
      }),
      record("snap.p1", "s3", { deleted: true, text: null }),
      record("sys", "devices"),
    ],
    [
      { id: "d1", name: "Laptop (work)" },
      { id: "d2", name: "Desk" },
    ],
    [{ id: "p1", path: "C:\\work\\site" }],
  );
  assert.deepEqual(overview.settings, { count: 42, updatedAt: 1_700_000_000_000 });
  assert.deepEqual(
    overview.files.map((f) => [f.path, f.bytes]),
    [
      ["keybindings.json", 30],
      ["snippets/go.json", 120],
    ],
  );
  assert.equal(overview.accountChats, 1);
  assert.deepEqual(overview.projects, [
    {
      id: "p1",
      name: "site",
      chats: 1,
      snapshots: 2,
      // The latest snapshot's size, not the sum.
      snapshotBytes: 500,
      lastChange: 1_700_000_200_000,
      // The device's name now, over the name the label was written with.
      lastComputer: "Laptop (work)",
      here: true,
      folder: "C:\\work\\site",
    },
    {
      id: "p2",
      name: "api",
      chats: 0,
      snapshots: 0,
      snapshotBytes: 0,
      lastChange: null,
      lastComputer: null,
      here: false,
      folder: null,
    },
  ]);
  assert.deepEqual(overview.projects.map(projectCounts), [
    "1 chat · 2 snapshots · latest snapshot 500 B",
    "0 chats · 0 snapshots",
  ]);
});

test("sync: records without a label are read from their text", () => {
  const overview = buildOverview(
    [
      record("settings", "user", {
        text: JSON.stringify({ keys: { a: { v: 1 }, b: { d: true }, c: { v: 2 } } }),
      }),
      record("files", "a", { text: JSON.stringify({ path: "AGENTS.md", text: "hello" }) }),
      record("files", "b", { text: JSON.stringify({ path: "agents/x.md", deleted: true }) }),
      record("chats.account", "c1", { text: '{"deleted":true}' }),
      record("chats.p9", "c2"),
      record("snap.p9", "s1", {
        text: JSON.stringify({ time: 7_000_000_000_000, deviceName: "Old", bytes: 64 }),
        device: "gone",
      }),
      record("projects", "p8", { text: "not json" }),
    ],
    [],
    [{ id: "p8", path: "/home/me/tool/" }],
  );
  assert.equal(overview.settings?.count, 2);
  assert.deepEqual(overview.files, [{ path: "AGENTS.md", bytes: 5, updatedAt: null }]);
  assert.equal(overview.accountChats, 0);
  // The folder's name stands in for a name the account doesn't have; one on this computer first.
  assert.deepEqual(
    overview.projects.map((p) => [p.id, p.name, p.here]),
    [
      ["p8", "tool", true],
      ["p9", "Unnamed project", false],
    ],
  );
  const p9 = overview.projects[1];
  assert.equal(p9?.chats, 1);
  assert.equal(p9?.snapshotBytes, 64);
  assert.equal(p9?.lastComputer, "Old");
  assert.deepEqual(buildOverview([], [], []), {
    settings: null,
    files: [],
    accountChats: 0,
    projects: [],
  });
});

test("sync: the user's files by kind", () => {
  const file = (path: string) => ({ path, bytes: 1, updatedAt: null });
  assert.equal(fileKind("keybindings.json"), "keybindings");
  assert.equal(fileKind("AGENTS.md"), "rules");
  assert.equal(fileKind("output-styles/terse.md"), "outputStyles");
  assert.equal(fileKind("skills/a/SKILL.md"), "skills");
  assert.deepEqual(
    groupFiles([
      file("skills/a/SKILL.md"),
      file("strange.txt"),
      file("keybindings.json"),
      file("skills/b/SKILL.md"),
    ]).map((g) => [g.label, g.files.length]),
    [
      ["Keyboard shortcuts", 1],
      ["Skills", 2],
      ["Other", 1],
    ],
  );
  assert.equal(folderName("C:\\work\\site"), "site");
  assert.equal(folderName(null), "");
});

test("sync: storage filling up, and how long history is kept", () => {
  assert.equal(storageNotice(79, 100), null);
  assert.deepEqual(storageNotice(80, 100), { level: 80, text: "Storage is 80% full." });
  assert.equal(storageNotice(96, 100)?.level, 95);
  assert.match(storageNotice(96, 100)?.text ?? "", /^Storage is 96% full\. .*new snapshots stop/);
  assert.equal(storageNotice(500, 0), null);
  assert.equal(retentionText(30), "Keeps the last 30 days this project was worked on");
  assert.equal(retentionText(1), "Keeps the last day this project was worked on");
  assert.equal(retentionText(0), "Keeps every snapshot");
});

test("sync: the status bar item", () => {
  const idle = { state: "idle", message: null, at: 5 } as const;
  assert.equal(statusBarWords(false, "on", idle), null);
  assert.equal(statusBarWords(true, "off", idle), null);
  assert.equal(statusBarWords(true, "signedOut", idle), null);
  assert.equal(statusBarWords(true, null, idle), null);
  assert.equal(statusBarWords(true, "on", idle)?.text, "$(cloud) Synced");
  assert.equal(statusBarWords(true, "pending", idle)?.tooltip, "Sync: waiting for approval");
  assert.equal(statusBarWords(true, "on", { ...idle, state: "offline" })?.text, "$(cloud) Offline");
  assert.equal(
    statusBarWords(true, "on", { ...idle, state: "other" })?.tooltip,
    "Sync: another window is syncing",
  );
  const failed = statusBarWords(true, "on", { state: "error", message: "Storage is full.", at: 5 });
  assert.equal(failed?.error, true);
  assert.equal(failed?.tooltip, "Sync: Storage is full.");
  assert.equal(statusBarWords(true, "on", idle)?.error, false);
});

test("sync: recent activity", () => {
  let log = withEvent([], { at: 1, text: "a", error: false });
  log = withEvent(log, { at: 2, text: "b", error: true });
  // The same sentence again takes the earlier one's place.
  log = withEvent(log, { at: 3, text: "b", error: true });
  assert.deepEqual(
    log.map((e) => [e.at, e.text]),
    [
      [3, "b"],
      [1, "a"],
    ],
  );
  for (let i = 0; i < LOG_LIMIT + 5; i++)
    log = withEvent(log, { at: i, text: `e${i}`, error: false });
  assert.equal(log.length, LOG_LIMIT);
  assert.equal(log[0]?.text, `e${LOG_LIMIT + 4}`);
  assert.equal(passSentence(0), null);
  assert.equal(passSentence(1), "Synced: 1 item changed.");
  assert.equal(
    changedCount(
      new Map([
        ["a", 1],
        ["b", 1],
      ]),
      new Map([
        ["a", 1],
        ["b", 2],
        ["c", 1],
      ]),
    ),
    2,
  );
});

test("sync: small words", () => {
  assert.equal(platformLabel("windows"), "Windows");
  assert.equal(platformLabel("darwin"), "macOS");
  assert.equal(platformLabel("haiku"), "haiku");
  assert.equal(countOf(1, "file"), "1 file");
  assert.equal(countOf(3, "file"), "3 files");
});
