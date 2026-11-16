import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityLine,
  attentionItems,
  backoffMs,
  buildOverview,
  changedCount,
  changedOn,
  countOf,
  dayLabel,
  EMPTY_OVERVIEW,
  type EstimateLike,
  estimateWarning,
  fileKind,
  folderName,
  formatSize,
  groupByDay,
  groupFiles,
  heldSummary,
  isSyncPage,
  LAPSED_ACTIVITY,
  LOG_LIMIT,
  lapsedSentence,
  lapsedUntil,
  type OverviewRecord,
  overviewTiles,
  pageByKey,
  passSentence,
  planSituation,
  planUrl,
  platformLabel,
  projectCounts,
  retentionDate,
  retentionText,
  SYNC_BENEFITS,
  SYNC_PAGE_IDS,
  SYNC_PAGES,
  type SyncOverview,
  snapshotFacts,
  snapshotSize,
  snapshotSpacing,
  statusBarWords,
  storageByProject,
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

test("sync: what the account holds, from its records' sealed text", () => {
  const text = (value: unknown) => ({ text: JSON.stringify(value) });
  const overview = buildOverview(
    [
      record("settings", "user", {
        ...text({ keys: { a: { v: 1 }, b: { v: 2 }, gone: { d: true } } }),
        // A label that disagrees with the sealed text counts for nothing.
        info: { settings: 99 },
        updatedAt: 1_700_000_000_000,
      }),
      record("files", "a", text({ path: "snippets/go.json", text: "x".repeat(120) })),
      record("files", "b", {
        ...text({ path: "keybindings.json", text: "y".repeat(30) }),
        // The service can't hide a file by labelling it deleted, or rename it.
        info: { path: "something/else.json", deleted: true },
      }),
      record("files", "c", text({ path: "skills/old/SKILL.md", deleted: true })),
      record("chats.account", "c1", text({ meta: { updated: 5 } })),
      record("chats.account", "c2", text({ deleted: true })),
      record("projects", "p1", {
        ...text({ name: "site" }),
        info: { name: "not the name" },
        updatedAt: 1_700_000_000_000,
      }),
      record("projects", "p2", text({ name: "api" })),
      record("chats.p1", "c3", { ...text({ meta: { updated: 1_700_000_100_000 } }), device: "d2" }),
      record("chats.p1", "c4", text({ deleted: true })),
      record("snap.p1", "s1", {
        ...text({ time: 1_700_000_200_000, device: "d1", deviceName: "Laptop", bytes: 500 }),
        // The sealed summary says who made it, whatever the service says.
        device: "d2",
        info: { bytes: 1 },
      }),
      record("snap.p1", "s2", text({ time: 1_700_000_050_000, deviceName: "Desk", bytes: 900 })),
      record("snap.p1", "s3", { deleted: true, text: null }),
      record("sys", "devices"),
    ],
    [
      { id: "d1", name: "Laptop (work)" },
      { id: "d2", name: "Desk" },
    ],
    [{ id: "p1", path: "C:\\work\\site" }],
    "d1",
  );
  assert.deepEqual(overview.settings, { count: 2, updatedAt: 1_700_000_000_000 });
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
      lastHere: true,
      here: true,
      folder: "C:\\work\\site",
      folderMissing: false,
    },
    {
      id: "p2",
      name: "api",
      chats: 0,
      snapshots: 0,
      snapshotBytes: 0,
      lastChange: null,
      lastComputer: null,
      lastHere: false,
      here: false,
      folder: null,
      folderMissing: false,
    },
  ]);
  assert.deepEqual(overview.projects.map(projectCounts), [
    "1 chat · 2 snapshots",
    "0 chats · 0 snapshots",
  ]);
  // This computer's own change is "on this computer", whatever the computer is called.
  assert.deepEqual(overview.projects.map(changedOn), ["on this computer", ""]);
});

test("sync: a label stands in only for a record whose text isn't here, and hides nothing", () => {
  const unread = (collection: string, id: string, info: OverviewRecord["info"]) =>
    record(collection, id, { text: null, info });
  const overview = buildOverview(
    [
      unread("settings", "user", { settings: 7 }),
      unread("files", "a", { path: "AGENTS.md", bytes: 5 }),
      // Labelled deleted, text not here: still listed. Only sealed content deletes.
      unread("files", "b", { path: "agents/x.md", deleted: true }),
      unread("chats.account", "c1", { deleted: true }),
      unread("chats.p9", "c2", { updated: 6_000_000_000_000 }),
      unread("snap.p9", "s1", { time: 7_000_000_000_000, computer: "Old", bytes: 64 }),
      record("projects", "p8", { text: "not json" }),
      unread("projects", "p7", { name: "labelled" }),
    ],
    [],
    [{ id: "p8", path: "/home/me/tool/", missing: true }],
  );
  assert.equal(overview.settings?.count, 7);
  assert.deepEqual(
    overview.files.map((f) => [f.path, f.bytes]),
    [
      ["AGENTS.md", 5],
      ["agents/x.md", 0],
    ],
  );
  assert.equal(overview.accountChats, 1);
  // The folder's name stands in for a name the account doesn't have; one on this computer first.
  assert.deepEqual(
    overview.projects.map((p) => [p.id, p.name, p.here, p.folderMissing]),
    [
      ["p8", "tool", true, true],
      ["p7", "labelled", false, false],
      ["p9", "Unnamed project", false, false],
    ],
  );
  const p9 = overview.projects[2];
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

test("sync: where a project changed, and a snapshot without files", () => {
  assert.equal(changedOn({ lastHere: true, lastComputer: "This computer" }), "on this computer");
  assert.equal(changedOn({ lastHere: false, lastComputer: "Laptop" }), "on Laptop");
  assert.equal(changedOn({ lastHere: false, lastComputer: null }), "");
  // Without this computer's id, nothing is taken for its own.
  const other = buildOverview(
    [record("snap.p1", "s1", { text: null, info: { time: 5, computer: "Desk" }, device: "d1" })],
    [{ id: "d1", name: "Desk" }],
    [],
  );
  assert.equal(other.projects[0]?.lastHere, false);
  assert.equal(changedOn(other.projects[0] ?? { lastHere: false, lastComputer: null }), "on Desk");
  assert.equal(snapshotSize(0), "no changed files");
  assert.equal(snapshotSize(2048), "2 KB");
  assert.equal(snapshotFacts(0, 0), "no changed files");
  assert.equal(snapshotFacts(3, 2048), "3 files · 2 KB");
  assert.equal(snapshotFacts(1, 640, ", "), "1 file, 640 B");
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

test("sync: which situation an account is in with the subscription", () => {
  const on = { state: "on", lapsedUntil: null };
  // Nobody signed in: nothing to say.
  assert.equal(planSituation(null, null), "none");
  assert.equal(planSituation(null, on), "none");
  // An account without sync that isn't offered it: as before sync was sold.
  assert.equal(planSituation({ sync: false }, null), "none");
  assert.equal(planSituation({}, { state: "unavailable" }), "none");
  assert.equal(planSituation({ sync: false, syncOffered: false, syncState: "off" }, null), "none");
  // Sync is on sale to it.
  assert.equal(planSituation({ sync: false, syncOffered: true }, null), "offered");
  assert.equal(planSituation({ syncOffered: true }, { state: "unavailable" }), "offered");
  // It has sync (an older server sends no state).
  assert.equal(planSituation({ sync: true }, null), "on");
  assert.equal(planSituation({ sync: true, syncState: "on" }, on), "on");
  assert.equal(planSituation({ sync: true }, { state: "off" }), "on");
  // Having it wins over an offer that was left set.
  assert.equal(planSituation({ sync: true, syncOffered: true }, on), "on");
  // Lapsed: the profile says so until the sync service was asked; then its word counts.
  const lapsed = { sync: true, syncState: "lapsed", syncUntil: 2_000_000_000_000 } as const;
  assert.equal(planSituation(lapsed, null), "lapsed");
  assert.equal(planSituation(lapsed, { state: "signedOut" }), "lapsed");
  assert.equal(planSituation(lapsed, { state: "on", lapsedUntil: 2_000_000_000_000 }), "lapsed");
  assert.equal(planSituation(lapsed, { state: "off", lapsedUntil: 2_000_000_000_000 }), "lapsed");
  // The profile is older than the status: it lapsed since,
  assert.equal(
    planSituation({ sync: true, syncState: "on" }, { state: "on", lapsedUntil: 5e12 }),
    "lapsed",
  );
  // or it was renewed since.
  assert.equal(planSituation(lapsed, on), "on");
  // A status from before the field existed has none.
  assert.equal(planSituation({ sync: true }, { state: "on" }), "on");
  // The sync service not open to the account ends it, whatever the profile said.
  assert.equal(planSituation(lapsed, { state: "unavailable" }), "none");

  // When what is synced is deleted: the status's date first, then the profile's.
  assert.equal(lapsedUntil(lapsed, { state: "on", lapsedUntil: 1_900_000_000_000 }), 1.9e12);
  assert.equal(lapsedUntil(lapsed, null), 2e12);
  assert.equal(lapsedUntil(lapsed, { state: "signedOut", lapsedUntil: 5 }), 2e12);
  assert.equal(lapsedUntil({ sync: true }, on), null);
  assert.equal(lapsedUntil(null, null), null);
  // A time in seconds is one in ms.
  assert.equal(lapsedUntil({ syncUntil: 1_900_000_000 }, null), 1.9e12);
});

test("sync: what a lapsed account is told", () => {
  const now = new Date(2026, 10, 15, 12).getTime();
  const until = new Date(2026, 11, 14, 9).getTime();
  const date = new Date(until).toLocaleDateString(undefined, { day: "numeric", month: "long" });
  assert.equal(retentionDate(until, now), date);
  assert.doesNotMatch(retentionDate(until, now), /2026/);
  // Another year says its year.
  assert.match(retentionDate(new Date(2027, 0, 14, 9).getTime(), now), /2027/);
  assert.equal(
    lapsedSentence(until, now),
    `Your Sync subscription ended. What is synced stays readable until ${date}, then it is deleted. Your computers keep their own files and chats.`,
  );
  // No date known: no date made up.
  assert.equal(
    lapsedSentence(null, now),
    "Your Sync subscription ended. What is synced stays readable for a while, then it is deleted. Your computers keep their own files and chats.",
  );
  // The date has passed and the copy is still there.
  assert.match(lapsedSentence(now - 1, now), /is about to be deleted\. Your computers keep/);

  // The status line, the status bar (quiet: not an error) and what needs attention.
  const lapsed = { state: "lapsed", message: LAPSED_ACTIVITY, at: 5 } as const;
  assert.deepEqual(activityLine(lapsed), {
    text: "Sync ended: nothing syncs until you renew",
    time: null,
  });
  const idle = { state: "idle", message: null, at: 5 } as const;
  for (const words of [
    statusBarWords(true, "on", lapsed),
    statusBarWords(true, "on", idle, true),
  ]) {
    assert.equal(words?.text, "$(cloud) Sync ended");
    assert.equal(words?.error, false);
    assert.match(words?.tooltip ?? "", /subscription ended/);
  }
  // Not on here: no item, lapsed or not.
  assert.equal(statusBarWords(true, "off", idle, true), null);
  assert.equal(statusBarWords(false, "on", idle, true), null);
  assert.equal(statusBarWords(true, "on", idle, false)?.text, "$(cloud) Synced");
  const input = {
    waiting: [{ name: "Laptop" }],
    usage: 99,
    limit: 100,
    activity: idle,
    project: { name: "site", on: false },
  };
  assert.equal(attentionItems(input).length, 3);
  // Nothing of it can be acted on while lapsed: the callout is what there is.
  assert.deepEqual(attentionItems({ ...input, lapsed: true }), []);

  assert.equal(SYNC_BENEFITS.length, 3);
  assert.equal(
    planUrl("https://accounts.example.com"),
    "https://accounts.example.com/account#plan",
  );
  assert.equal(
    planUrl("https://accounts.example.com/"),
    "https://accounts.example.com/account#plan",
  );
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

test("sync: the tab's pages", () => {
  assert.deepEqual(
    SYNC_PAGES.map((p) => p.id),
    [...SYNC_PAGE_IDS],
  );
  assert.equal(isSyncPage("storage"), true);
  assert.equal(isSyncPage("nowhere"), false);
  assert.equal(isSyncPage(3), false);
  assert.equal(pageByKey("overview", "ArrowDown"), "projects");
  assert.equal(pageByKey("overview", "ArrowUp"), "overview");
  assert.equal(pageByKey("activity", "ArrowDown"), "activity");
  assert.equal(pageByKey("content", "Home"), "overview");
  assert.equal(pageByKey("content", "End"), "activity");
  assert.equal(pageByKey("content", "Enter"), null);
});

const held: SyncOverview = {
  settings: { count: 42, updatedAt: null },
  files: [
    { path: "keybindings.json", bytes: 1, updatedAt: null },
    { path: "skills/a/SKILL.md", bytes: 1, updatedAt: null },
    { path: "skills/b/SKILL.md", bytes: 1, updatedAt: null },
  ],
  accountChats: 2,
  projects: [
    {
      id: "p1",
      name: "site",
      chats: 3,
      snapshots: 4,
      snapshotBytes: 100,
      lastChange: null,
      lastComputer: null,
      lastHere: false,
      here: true,
      folder: "/work/site",
      folderMissing: false,
    },
    {
      id: "p2",
      name: "api",
      chats: 0,
      snapshots: 1,
      snapshotBytes: 900,
      lastChange: null,
      lastComputer: null,
      lastHere: false,
      here: false,
      folder: null,
      folderMissing: false,
    },
    {
      id: "p3",
      name: "notes",
      chats: 1,
      snapshots: 0,
      snapshotBytes: 0,
      lastChange: null,
      lastComputer: null,
      lastHere: false,
      here: false,
      folder: null,
      folderMissing: false,
    },
  ],
};

test("sync: the overview's tiles and what the account holds of each kind", () => {
  assert.deepEqual(
    overviewTiles(held, [{ status: "approved" }, { status: "pending" }]).map((t) => [
      t.page,
      t.value,
      t.label,
    ]),
    [
      ["projects", "3", "Projects"],
      ["content", "6", "Chats"],
      ["projects", "5", "Snapshots"],
      ["computers", "1", "Computer"],
    ],
  );
  assert.deepEqual(
    overviewTiles(EMPTY_OVERVIEW, []).map((t) => t.value),
    ["0", "0", "0", "0"],
  );
  assert.equal(heldSummary("sync.settings", held), "42 settings");
  assert.equal(heldSummary("sync.keybindings", held), "1 file");
  assert.equal(heldSummary("sync.skills", held), "2 files");
  assert.equal(heldSummary("sync.rules", held), "Nothing yet");
  assert.equal(heldSummary("sync.chats", held), "2 without a folder · 4 in projects");
  assert.equal(heldSummary("sync.snapshots", held), "5 snapshots in 2 projects");
  assert.equal(heldSummary("sync.settings", EMPTY_OVERVIEW), "Nothing yet");
  assert.equal(heldSummary("sync.chats", EMPTY_OVERVIEW), "Nothing yet");
  // Largest first; a project without snapshots isn't listed.
  assert.deepEqual(
    storageByProject(held).map((p) => [p.name, p.bytes]),
    [
      ["api", 900],
      ["site", 100],
    ],
  );
});

test("sync: what needs attention", () => {
  const idle = { state: "idle", message: null, at: 5 } as const;
  assert.deepEqual(
    attentionItems({ waiting: [], usage: 10, limit: 100, activity: idle, project: null }),
    [],
  );
  assert.deepEqual(
    attentionItems({
      waiting: [],
      usage: 10,
      limit: 100,
      activity: idle,
      project: { name: "site", on: true },
    }),
    [],
  );
  const all = attentionItems({
    waiting: [{ name: "Laptop" }],
    usage: 85,
    limit: 100,
    activity: { state: "error", message: "Storage is full.", at: 5 },
    project: { name: "site", on: false },
  });
  assert.deepEqual(
    all.map((entry) => [entry.kind, entry.action, entry.page ?? entry.command]),
    [
      ["error", "Retry", "sync.syncNow"],
      ["device", "Review", "computers"],
      ["storage", "Open storage", "storage"],
      ["project", "Open projects", "projects"],
    ],
  );
  assert.equal(all[0]?.text, "Storage is full.");
  assert.match(all[1]?.text ?? "", /^Laptop wants to join/);
  assert.equal(all[3]?.text, "site isn't synced yet.");
});

test("sync: snapshots under their day", () => {
  const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 30).getTime();
  const now = at(15, 18);
  assert.equal(dayLabel(at(15, 0), now), "Today");
  assert.equal(dayLabel(at(14, 23), now), "Yesterday");
  assert.notEqual(dayLabel(at(13, 12), now), "Yesterday");
  // The first of a month: yesterday is the last of the month before.
  assert.equal(
    dayLabel(new Date(2026, 9, 31, 9).getTime(), new Date(2026, 10, 1, 9).getTime()),
    "Yesterday",
  );
  // Another year says its year.
  assert.match(dayLabel(new Date(2024, 2, 5, 9).getTime(), now), /2024/);
  const groups = groupByDay(
    [at(15, 17), at(15, 9), at(14, 20), at(10, 8), at(10, 7)],
    (t) => t,
    now,
  );
  assert.deepEqual(
    groups.map((g) => g.rows.length),
    [2, 1, 2],
  );
  assert.deepEqual(
    groups.slice(0, 2).map((g) => g.label),
    ["Today", "Yesterday"],
  );
  assert.deepEqual(
    groupByDay([], (t: number) => t, now),
    [],
  );
});

test("sync: the loop's timing, and the words while keys catch up", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 50].map((n) => backoffMs(n) / 60_000),
    [1, 2, 5, 10, 10, 10],
  );
  assert.equal(backoffMs(0), 60_000);
  const least = 3 * 60_000;
  assert.equal(snapshotSpacing(200, least), least);
  // A look that took 30 s (a huge folder): twenty minutes until the next.
  assert.equal(snapshotSpacing(30_000, least), 20 * 60_000);
  const blocked = { state: "blocked", message: null, at: 5 } as const;
  assert.equal(activityLine(blocked).text, "Waiting for this computer's keys to catch up");
  assert.equal(statusBarWords(true, "on", blocked)?.error, false);
  assert.match(statusBarWords(true, "on", blocked)?.tooltip ?? "", /keys to catch up/);
  assert.equal(
    activityLine({ state: "offline", message: "The service asked to slow down: will retry", at: 5 })
      .text,
    "The service asked to slow down: will retry",
  );
});

test("sync: a large folder without git is asked about before it syncs", () => {
  const folder: EstimateLike = {
    kind: "folder",
    files: 12,
    bytes: 4096,
    tooLarge: 0,
    largest: [],
    truncated: false,
  };
  assert.equal(estimateWarning(folder), null);
  // A git project sends only what differs from its commit, however large it is.
  assert.equal(estimateWarning({ ...folder, kind: "git", files: 90_000, bytes: 9e9 }), null);
  const large = estimateWarning({
    ...folder,
    files: 2_000,
    bytes: 300 * 1024 * 1024,
    tooLarge: 2,
    largest: [
      ["node_modules", 250 * 1024 * 1024, 1800],
      ["video.mp4", 40 * 1024 * 1024, 1],
    ],
  });
  assert.match(large ?? "", /2000 files, 300 MB/);
  assert.match(large ?? "", /node_modules {2}250 MB \(1800 files\)\nvideo\.mp4 {2}40 MB/);
  assert.match(large ?? "", /Files over 100 MB are left out \(2 files here\)/);
  assert.doesNotMatch(large ?? "", /more files than a snapshot holds/);
  assert.match(
    estimateWarning({ ...folder, truncated: true }) ?? "",
    /more files than a snapshot holds/,
  );
  assert.notEqual(estimateWarning({ ...folder, bytes: 200 * 1024 * 1024 }), null);
});

test("sync: small words", () => {
  assert.equal(platformLabel("windows"), "Windows");
  assert.equal(platformLabel("darwin"), "macOS");
  assert.equal(platformLabel("haiku"), "haiku");
  assert.equal(countOf(1, "file"), "1 file");
  assert.equal(countOf(3, "file"), "3 files");
});
