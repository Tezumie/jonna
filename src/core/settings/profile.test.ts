import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProfile, PROFILE_FORMAT, parseProfile, profileSummary } from "./profile";

test("profiles: round trip, summary, empty parts left out", () => {
  const p = buildProfile(
    "App",
    {
      settings: '{ // mine\n "editor.fontSize": 15 }',
      keybindings: " ",
      snippets: { "ts.json": "{}" },
    },
    new Date("2026-10-19T00:00:00Z"),
  );
  assert.equal(p.keybindings, undefined);
  assert.equal(p.exported, "2026-10-19T00:00:00.000Z");
  const back = parseProfile(JSON.stringify(p));
  assert.deepEqual(back, p);
  assert.equal(profileSummary(back), "settings and 1 snippet file");
  assert.equal(
    profileSummary({
      ...back,
      keybindings: "[]",
      snippets: { "a.json": "", "b.code-snippets": "" },
    }),
    "settings, keybindings and 2 snippet files",
  );
});

test("profiles: other files are refused, unsafe snippet names dropped", () => {
  assert.throws(() => parseProfile("not json"), /not JSON/);
  assert.throws(() => parseProfile('{"a":1}'), /isn't a settings profile/);
  assert.throws(
    () => parseProfile(JSON.stringify({ format: PROFILE_FORMAT, version: 2 })),
    /version 2/,
  );
  const p = parseProfile(
    JSON.stringify({
      format: PROFILE_FORMAT,
      version: 1,
      snippets: {
        "../x.json": "{}",
        "ok.json": "{}",
        "run.sh": "x",
        ".hidden.json": "{}",
        "n.json": 5,
      },
    }),
  );
  assert.deepEqual(p.snippets, { "ok.json": "{}" });
  assert.equal(profileSummary({ ...p, snippets: {} }), "nothing");
});
