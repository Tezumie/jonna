import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseBlamePorcelain,
  parseLineLog,
  threadLine,
  threadSummary,
  threadsByPath,
  threadsOf,
} from "./lens";

const A = "dd29473c9af4f201f9195016c24ee7eb3aa6eb0e";
const B = "0bd48fc5b5480a4eda4abe21d680b627076b7403";
// Real `git blame --porcelain` output: B changed line 2 and added line 4.
const PORCELAIN = [
  `${A} 1 1 1`,
  "author Ann Author",
  "author-mail <a@b.c>",
  "author-time 1700000000",
  "author-tz -0600",
  "committer Ann Author",
  "summary First",
  "boundary",
  "filename f.txt",
  "\tone",
  `${B} 2 2 1`,
  "author Bob",
  "author-mail <b@b.c>",
  "author-time 1700086400",
  "summary Second",
  `previous ${A} f.txt`,
  "filename f.txt",
  "\tTWO",
  `${A} 3 3 1`,
  "\tthree",
  `${B} 4 4 1`,
  "\tfour",
  "",
].join("\n");

test("blame porcelain becomes hunks with each commit's details once", () => {
  const hunks = parseBlamePorcelain(PORCELAIN);
  assert.deepEqual(
    hunks.map((h) => [h.start, h.end, h.commit.author]),
    [
      [1, 1, "Ann Author"],
      [2, 2, "Bob"],
      [3, 3, "Ann Author"],
      [4, 4, "Bob"],
    ],
  );
  assert.equal(hunks[1]?.commit.previous, A);
  assert.equal(hunks[1]?.commit.authorMail, "b@b.c");
  assert.equal(hunks[0]?.commit, hunks[2]?.commit);
});

test("consecutive lines of one commit merge, uncommitted lines are marked", () => {
  const zero = "0".repeat(40);
  const text = [
    `${A} 1 1 2`,
    "author Ann",
    "author-time 1700000000",
    "summary x",
    "filename f",
    "\ta",
    `${A} 2 2`,
    "\tb",
    `${zero} 3 3 1`,
    "author Not Committed Yet",
    "author-time 1800000000",
    "summary Version of f from f",
    "filename f",
    "\tc",
  ].join("\r\n");
  const hunks = parseBlamePorcelain(text);
  assert.deepEqual(
    hunks.map((h) => [h.start, h.end, h.commit.uncommitted]),
    [
      [1, 2, false],
      [3, 3, true],
    ],
  );
});

test("log -L output becomes commits with their line diffs", () => {
  const text = [
    `\x1e${B}\0${A}\0Bob\0b@b.c\x001700086400\0Second`,
    "",
    "diff --git a/f.txt b/f.txt",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -2,2 +2,2 @@",
    "-two",
    "+TWO",
    " three",
    `\x1e${A}\0\0Ann Author\0a@b.c\x001700000000\0First`,
    "",
    "diff --git a/old.txt b/old.txt",
    "--- /dev/null",
    "+++ b/old.txt",
    "@@ -0,0 +2,2 @@",
    "+two",
    "+three",
    "",
  ].join("\n");
  const log = parseLineLog(text);
  assert.equal(log.length, 2);
  assert.deepEqual(
    log.map((e) => [e.hash, e.author, e.subject, e.added, e.removed, e.path]),
    [
      [B, "Bob", "Second", 1, 1, "f.txt"],
      [A, "Ann Author", "First", 2, 0, "old.txt"],
    ],
  );
  assert.deepEqual(log[0]?.parents, [A]);
  assert.deepEqual(log[1]?.parents, []);
  assert.match(log[0]?.diff ?? "", /^diff --git/);
  assert.deepEqual(parseLineLog(""), []);
});

test("review threads from GraphQL, placed by line", () => {
  const reply = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: "T2",
                isResolved: false,
                isOutdated: false,
                path: "a.ts",
                line: 9,
                originalLine: 8,
                comments: {
                  nodes: [
                    {
                      databaseId: 2,
                      body: "Rename this?",
                      createdAt: "2026-01-01T00:00:00Z",
                      url: "u",
                      author: { login: "rev" },
                    },
                  ],
                },
              },
              {
                id: "T1",
                isResolved: true,
                isOutdated: true,
                path: "a.ts",
                line: null,
                originalLine: 3,
                comments: { nodes: [] },
              },
            ],
          },
        },
      },
    },
  };
  const threads = threadsOf(reply);
  assert.equal(threads.length, 2);
  assert.equal(threadLine(threads[1] as (typeof threads)[number]), 3);
  const byPath = threadsByPath(threads);
  assert.deepEqual(
    byPath.get("a.ts")?.map((t) => t.id),
    ["T1", "T2"],
  );
  assert.equal(threadSummary(threads[0] as (typeof threads)[number]), "rev: Rename this?");
  assert.match(threadSummary(threads[1] as (typeof threads)[number]), /^Resolved · Outdated/);
  assert.deepEqual(threadsOf({ errors: [] }), []);
});
