import assert from "node:assert/strict";
import { test } from "node:test";
import type { SharedSnapshot } from "../../core/ipc/share";
import {
  latestFacts,
  newestFirst,
  ShareLook,
  sharedFileTitle,
  sharedLabel,
  sharedPath,
  sharedSnapshotFacts,
} from "./shareView.model";
import { snapshotLabel } from "./snapshotView.model";

const snapshot = (id: string, time: number, over: Partial<SharedSnapshot["summary"]> = {}) =>
  ({
    id,
    summary: {
      v: 1,
      device: "d1",
      deviceName: "Ana's laptop",
      time,
      kind: "git",
      head: "abc",
      branch: "main",
      files: 2,
      deleted: 0,
      bytes: 2048,
      skipped: 0,
      fingerprint: "f",
      ...over,
    },
  }) satisfies SharedSnapshot;

test("a share's snapshots are listed newest first", () => {
  const rows = newestFirst([snapshot("a", 10), snapshot("c", 30), snapshot("b", 20)]);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["c", "b", "a"],
  );
  // Two of one time keep one order.
  assert.deepEqual(
    newestFirst([snapshot("x", 5), snapshot("y", 5)]).map((row) => row.id),
    ["y", "x"],
  );
});

test("a share's row: its newest snapshot's facts", () => {
  assert.equal(latestFacts(null), null);
  assert.deepEqual(
    latestFacts({
      time: 1_700_000_000_000,
      computer: "Ana's laptop",
      kind: "git",
      files: 12,
      bytes: 3 * 1024 * 1024,
      branch: "main",
    }),
    { time: 1_700_000_000_000, facts: "Ana's laptop · main · 12 files · 3 MB" },
  );
  // A time in seconds (the service's) reads in ms; no branch, no computer: left out.
  assert.deepEqual(
    latestFacts({
      time: 1_700_000_000,
      computer: " ",
      kind: "folder",
      files: 1,
      bytes: 10,
      branch: null,
    }),
    { time: 1_700_000_000_000, facts: "1 file · 10 B" },
  );
  assert.deepEqual(
    latestFacts({ time: null, computer: "pc", kind: "folder", files: 0, bytes: 0, branch: null }),
    { time: null, facts: "pc · no changed files" },
  );
  assert.equal(sharedSnapshotFacts(snapshot("a", 10)), "Ana's laptop · main · 2 files · 2 KB");
  assert.equal(
    sharedSnapshotFacts(snapshot("a", 10, { branch: null, deviceName: "" })),
    "2 files · 2 KB",
  );
});

test("a shared file's labels: whose snapshot it is, and a title that ends in the file's name", () => {
  const time = new Date(2026, 10, 17, 14, 5).getTime();
  const label = snapshotLabel(time);
  const when = label.replace(/^Snapshot /, "");
  assert.equal(sharedLabel("Ana", time, false), `Ana's snapshot ${when}`);
  assert.equal(sharedLabel("Ana", time, true), `Shared snapshot ${when}`);
  assert.equal(sharedLabel(" ", time, false), `Shared snapshot ${when}`);

  assert.equal(sharedFileTitle("notes", time, "README.md"), `notes (${when}) · README.md`);
  const nested = sharedFileTitle("notes", time, "src/core/a.ts");
  assert.equal(nested, `notes (${when}) · src › core › a.ts`);
  // The tab picks the language by the title's ending; a title has no slash.
  assert.ok(nested.endsWith("a.ts"));
  assert.equal(nested.includes("/"), false);
  // Two files of one name keep titles of their own.
  assert.notEqual(nested, sharedFileTitle("notes", time, "src/ui/a.ts"));
  assert.ok(sharedFileTitle("", time, "a.ts").startsWith("Shared project ("));
});

test("a path asked for stays inside the snapshot", () => {
  assert.equal(sharedPath("src/a.ts"), "src/a.ts");
  assert.equal(sharedPath("./src/a.ts"), "src/a.ts");
  assert.equal(sharedPath("/src/a.ts"), "src/a.ts");
  assert.equal(sharedPath("src\\a.ts"), "src/a.ts");
  assert.equal(sharedPath("../secret"), "");
  assert.equal(sharedPath("src/../../secret"), "");
  assert.equal(sharedPath(""), "");
});

test("the share being looked at: loading, read, read again, a snapshot inside it, closed", () => {
  const look = new ShareLook();
  assert.equal(look.opened.peek(), null);

  const first = look.begin("u.p");
  assert.deepEqual(look.opened.peek(), {
    id: "u.p",
    phase: "loading",
    error: null,
    snapshots: 0,
    refreshing: false,
    chats: 0,
  });
  const chat = (id: string, updated: number) => ({
    id,
    title: id,
    updated,
    bytes: 1,
    images: 0,
    imageBytes: 0,
  });
  assert.equal(
    look.finish(first, [snapshot("a", 10), snapshot("b", 20)], [chat("x", 1), chat("y", 5)]),
    true,
  );
  // Its shared chats, newest first.
  assert.equal(look.opened.peek()?.chats, 2);
  assert.deepEqual(
    look.chats.map((row) => row.id),
    ["y", "x"],
  );
  assert.equal(look.opened.peek()?.phase, "ready");
  assert.equal(look.opened.peek()?.snapshots, 2);
  assert.deepEqual(
    look.rows.map((row) => row.id),
    ["b", "a"],
  );

  // A snapshot of it is looked at, uncompared (the open folder is another project).
  const files = look.snapshot.begin("a", false);
  look.snapshot.finish(files, {
    files: [{ path: "a.ts", size: 1, deleted: false, state: "unknown" }],
    truncated: 0,
    skipped: [[".env", "a key file"]],
  });
  assert.equal(look.snapshot.opened.peek()?.compared, false);
  assert.deepEqual(look.snapshot.skipped, [[".env", "a key file"]]);

  // Read again: the list stays in view, and so does the snapshot while it is still there.
  const again = look.begin("u.p");
  assert.equal(look.opened.peek()?.refreshing, true);
  assert.equal(look.rows.length, 2);
  assert.equal(look.finish(again, [snapshot("a", 10), snapshot("c", 30)]), true);
  assert.equal(look.snapshot.opened.peek()?.id, "a");

  // The share dropped that snapshot (it keeps its latest ten): it isn't looked at any more.
  const dropped = look.begin("u.p");
  look.finish(dropped, [snapshot("c", 30)]);
  assert.equal(look.snapshot.opened.peek(), null);

  // Reading again failed: what was read stays.
  const failing = look.begin("u.p");
  look.fail(failing, "offline");
  assert.deepEqual(
    [look.opened.peek()?.phase, look.opened.peek()?.error, look.opened.peek()?.refreshing],
    ["ready", null, false],
  );

  // Another share: a result for the one before is dropped.
  const stale = look.begin("u.p");
  const other = look.begin("v.q");
  assert.equal(look.opened.peek()?.id, "v.q");
  assert.equal(look.rows.length, 0);
  assert.equal(look.finish(stale, [snapshot("a", 10)]), false);
  look.fail(other, "The keys for this project haven't reached you yet.");
  assert.deepEqual(
    [look.opened.peek()?.phase, look.opened.peek()?.error],
    ["error", "The keys for this project haven't reached you yet."],
  );

  look.close();
  assert.equal(look.opened.peek(), null);
  assert.equal(look.snapshot.opened.peek(), null);
  // A result that arrives after closing changes nothing.
  assert.equal(look.finish(other, [snapshot("a", 10)]), false);
  assert.equal(look.opened.peek(), null);
});
