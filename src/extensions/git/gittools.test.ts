// The bundled Git tools extension's model (D208): src-tauri/bundled-extensions/gittools/main.js
// is a plain worker script, so it's loaded here as the worker would, and its `model` export
// tested — with the git extension's blame parser, which serves it `ide.git.blame`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseManifest } from "../../core/extensions/thirdParty";
import { type BlameHunk, parseBlamePorcelain } from "./lens";

interface Annotation {
  line: number;
  text: string;
  heat: number;
  hash: string;
  hover: string;
}
interface Repo {
  root: string;
  name: string;
  selected: boolean;
}
interface Model {
  BLAME_WIDTH: number;
  shortAge(seconds: number, now?: number): string;
  longAge(seconds: number, now?: number): string;
  heatBucket(time: number, oldest: number, newest: number): number;
  blameAnnotations(hunks: BlameHunk[], now?: number): Annotation[];
  stashLabel(st: { index: number; message: string; time: number }, now?: number): string;
  notificationUrl(n: unknown): string;
  isWithin(root: string, path: string, fold: boolean): boolean;
  relativeTo(root: string, path: string, fold: boolean): string;
  joinPath(root: string, rel: string): string;
  pickRepository(list: Repo[], path?: string, named?: string, fold?: boolean): Repo | null;
}

const source = readFileSync(
  join(process.cwd(), "src-tauri/bundled-extensions/gittools/main.js"),
  "utf8",
);
const exportsObject: { model?: Model } = {};
new Function("exports", source)(exportsObject);
const model = exportsObject.model as Model;

const A = "dd29473c9af4f201f9195016c24ee7eb3aa6eb0e";
const B = "0bd48fc5b5480a4eda4abe21d680b627076b7403";
const PORCELAIN = [
  `${A} 1 1 1`,
  "author Ann Author",
  "author-mail <a@b.c>",
  "author-time 1700000000",
  "summary First",
  "filename f.txt",
  "\tone",
  `${B} 2 2 1`,
  "author Bob",
  "author-mail <b@b.c>",
  "author-time 1700086400",
  "summary Second",
  "filename f.txt",
  "\tTWO",
  `${A} 3 3 1`,
  "\tthree",
  `${B} 4 4 1`,
  "\tfour",
  "",
].join("\n");

test("git tools: annotations name author and age on a hunk's first line, one width, heat by age", () => {
  const now = 1700086400 + 3 * 86400;
  const notes = model.blameAnnotations(parseBlamePorcelain(PORCELAIN), now);
  assert.equal(notes.length, 4);
  for (const n of notes) assert.equal(n.text.length, model.BLAME_WIDTH);
  assert.match(notes[0]?.text ?? "", /^Ann Author +4 d$/);
  assert.match(notes[1]?.text ?? "", /^Bob +3 d$/);
  assert.equal(notes[1]?.heat, 0);
  assert.equal(notes[0]?.heat, 4);
  assert.match(notes[1]?.hover ?? "", /Second/);
  // A long name is cut to fit.
  const long = parseBlamePorcelain(PORCELAIN.replace("author Bob", `author ${"B".repeat(40)}`));
  assert.equal(model.blameAnnotations(long, now)[1]?.text.length, model.BLAME_WIDTH);
});

test("git tools: ages, heat buckets, stash labels", () => {
  assert.equal(model.shortAge(0, 59), "now");
  assert.equal(model.shortAge(0, 3 * 3600), "3 h");
  assert.equal(model.shortAge(0, 400 * 86400), "1 yr");
  assert.equal(model.longAge(0, 86400), "1 day ago");
  assert.equal(model.heatBucket(10, 10, 10), 0);
  assert.equal(model.heatBucket(100, 0, 100), 0);
  assert.equal(model.heatBucket(0, 0, 100), 4);
  assert.equal(model.heatBucket(50, 0, 100), 2);
  assert.equal(
    model.stashLabel({ index: 0, message: "On main: wip notes", time: 0 }, 2 * 86400),
    "wip notes · 2 days ago",
  );
});

test("git tools: a notification's web page from its API URL", () => {
  const n = (url: string | null) => ({
    subject: { url },
    repository: { html_url: "https://github.com/o/r" },
  });
  assert.equal(
    model.notificationUrl(n("https://api.github.com/repos/o/r/pulls/7")),
    "https://github.com/o/r/pull/7",
  );
  assert.equal(
    model.notificationUrl(n("https://api.github.com/repos/o/r/issues/3")),
    "https://github.com/o/r/issues/3",
  );
  assert.equal(model.notificationUrl(n(null)), "https://github.com/o/r");
});

test("git tools: the shipped manifest parses, keeps the old ids and is a Source control section", () => {
  const m = parseManifest(
    JSON.parse(
      readFileSync(
        join(process.cwd(), "src-tauri/bundled-extensions/gittools/extension.json"),
        "utf8",
      ),
    ),
    "extension.json",
  );
  const ids = m.contributes.commands.map((c) => c.id);
  for (const id of [
    "git.toggleFileBlame",
    "git.lineHistory",
    "git.compareBranches",
    "git.compareSwap",
    "git.showStashes",
    "github.notifications",
    "github.markNotificationRead",
    "github.markAllNotificationsRead",
  ])
    assert.ok(ids.includes(id), id);
  assert.deepEqual(
    m.contributes.views.map((v) => [v.id, v.sectionOf]),
    [
      ["git.stashesView", "scm.view"],
      ["git.lineHistoryView", "scm.view"],
      ["git.compareView", "scm.view"],
      ["github.notificationsView", "scm.view"],
    ],
  );
  // Every command the code registers is declared (and the other way round).
  const registered = [...source.matchAll(/ide\.commands\.register\(\s*"([\w.]+)"/g)].map(
    (x) => x[1],
  );
  assert.deepEqual([...registered].sort(), [...ids].sort());
});

test("git tools: paths and the repository a file belongs to (Windows too)", () => {
  assert.equal(model.joinPath("C:\\work\\repo", "src/a.ts"), "C:\\work\\repo\\src\\a.ts");
  assert.equal(model.joinPath("/w/repo/", "src/a.ts"), "/w/repo/src/a.ts");
  assert.ok(model.isWithin("C:\\Work\\Repo", "c:/work/repo/a.txt", true));
  assert.ok(!model.isWithin("/w/repo", "/w/repo2/a.txt", false));
  assert.equal(model.relativeTo("C:\\w\\repo", "C:\\w\\repo\\src\\a.ts", true), "src/a.ts");
  const list: Repo[] = [
    { root: "/w", name: "w", selected: true },
    { root: "/w/inner", name: "inner", selected: false },
  ];
  assert.equal(model.pickRepository(list, "/w/inner/x.txt", undefined, false)?.name, "inner");
  assert.equal(model.pickRepository(list, "/w/x.txt", undefined, false)?.name, "w");
  assert.equal(model.pickRepository(list, undefined, "inner", false)?.root, "/w/inner");
  assert.equal(model.pickRepository(list, undefined, undefined, false)?.name, "w");
  assert.equal(model.pickRepository([], undefined, undefined, false), null);
});
