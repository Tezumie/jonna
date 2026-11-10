import assert from "node:assert/strict";
import { test } from "node:test";
import type { SearchEvent, SearchOptions } from "../../core/ipc/fs";
import {
  chainSearches,
  folderOptions,
  planSearch,
  type SearchRun,
  splitFolderGlob,
} from "./folders";

const web = { path: "/w/web", name: "web" };
const api = { path: "/x/api", name: "api" };
const folders = [web, api];

const base: SearchOptions = {
  query: "x",
  isRegex: false,
  matchCase: false,
  wholeWord: false,
  include: [],
  exclude: [],
  maxResults: 100,
};

test("a glob starting with a folder's name means that folder", () => {
  assert.deepEqual(splitFolderGlob("api/**", folders), { folder: api, rest: "**" });
  assert.deepEqual(splitFolderGlob("./api/src/*.ts", folders), { folder: api, rest: "src/*.ts" });
  assert.deepEqual(splitFolderGlob("api", folders), { folder: api, rest: "" });
  assert.deepEqual(splitFolderGlob(".\\api\\src", folders), { folder: api, rest: "src" });
  assert.equal(splitFolderGlob("src/**", folders), null);
  assert.equal(splitFolderGlob("*.ts", folders), null);
  // One folder: globs are as before.
  assert.equal(splitFolderGlob("web/**", [web]), null);
});

test("a folder's options keep its globs and the general ones", () => {
  const o = { ...base, include: ["api/**"] };
  assert.deepEqual(folderOptions(o, api, folders)?.include, ["**"]);
  // Named another folder only: not searched.
  assert.equal(folderOptions(o, web, folders), null);
  // General globs apply everywhere; with a named folder they're OR-ed.
  const mixed = { ...base, include: ["api/src/**", "*.md"] };
  assert.deepEqual(folderOptions(mixed, api, folders)?.include, ["src/**", "*.md"]);
  assert.deepEqual(folderOptions(mixed, web, folders)?.include, ["*.md"]);
  // The bare folder name: all of it.
  assert.deepEqual(folderOptions({ ...base, include: ["api", "*.md"] }, api, folders)?.include, []);
  // Excludes: a folder's own lose its name, others' are dropped; the whole folder: skipped.
  const ex = { ...base, exclude: ["api/dist/**", "web/tmp/**", "**/*.log"] };
  assert.deepEqual(folderOptions(ex, api, folders)?.exclude, ["dist/**", "**/*.log"]);
  assert.deepEqual(folderOptions(ex, web, folders)?.exclude, ["tmp/**", "**/*.log"]);
  assert.equal(folderOptions({ ...base, exclude: ["./api"] }, api, folders), null);
});

test("a search becomes one run unless folders differ", () => {
  // Same options everywhere: the whole workspace in one call.
  assert.deepEqual(
    planSearch(folders, () => base),
    [{ options: base }],
  );
  // A folder-named include: only that folder.
  assert.deepEqual(
    planSearch(folders, () => ({ ...base, include: ["./api/**"] })),
    [{ roots: [api.path], options: { ...base, include: ["**"] } }],
  );
  // Per-folder search.exclude: one run per folder.
  const runs = planSearch(folders, (f) => ({
    ...base,
    exclude: f === web ? ["dist/**"] : [],
  }));
  assert.deepEqual(
    runs.map((r) => [r.roots, r.options.exclude]),
    [
      [[web.path], ["dist/**"]],
      [[api.path], []],
    ],
  );
});

test("chained runs report one result set and share the result limit", async () => {
  const runs: SearchRun[] = [
    { roots: ["/a"], options: { ...base, maxResults: 5 } },
    { roots: ["/b"], options: { ...base, maxResults: 5 } },
  ];
  const events: SearchEvent[] = [];
  const asked: { roots: string[] | undefined; max: number | undefined }[] = [];
  await new Promise<void>((resolve) => {
    void chainSearches(
      runs,
      (e) => {
        events.push(e);
        if (e.kind === "done") resolve();
      },
      async (options, onEvent, roots) => {
        asked.push({ roots, max: options.maxResults });
        setTimeout(() => {
          onEvent({ kind: "file", path: `${roots?.[0]}/f`, rel: "f", matches: [] });
          onEvent({
            kind: "done",
            files: 1,
            matches: 2,
            truncated: false,
            cancelled: false,
            durationMs: 3,
          });
        }, 0);
      },
      { isCurrent: () => true, onError: () => {} },
    );
  });
  assert.deepEqual(asked, [
    { roots: ["/a"], max: 5 },
    { roots: ["/b"], max: 3 },
  ]);
  assert.deepEqual(
    events.map((e) => (e.kind === "file" ? e.path : `done ${e.files}/${e.matches}`)),
    ["/a/f", "/b/f", "done 2/4"],
  );
});

test("a cancelled run ends the chain", async () => {
  const runs: SearchRun[] = [
    { roots: ["/a"], options: base },
    { roots: ["/b"], options: base },
  ];
  let started = 0;
  const done = await new Promise<SearchEvent>((resolve) => {
    void chainSearches(
      runs,
      (e) => {
        if (e.kind === "done") resolve(e);
      },
      async (_o, onEvent) => {
        started++;
        setTimeout(
          () =>
            onEvent({
              kind: "done",
              files: 0,
              matches: 0,
              truncated: false,
              cancelled: true,
              durationMs: 1,
            }),
          0,
        );
      },
      { isCurrent: () => true, onError: () => {} },
    );
  });
  assert.equal(started, 1);
  assert.equal(done.kind === "done" && done.cancelled, true);
});
