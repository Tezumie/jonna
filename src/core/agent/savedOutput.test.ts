import assert from "node:assert/strict";
import { test } from "node:test";
import { readSaved, SavedOutputs } from "./savedOutput";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

test("D311: a cut output is kept per chat by id and read back by line", () => {
  const s = new SavedOutputs();
  const id = s.save("chat1", "npm test", `${lines(1000)}\n`);
  assert.equal(id, "out1");
  assert.equal(s.get("chat2", id), undefined);
  const o = s.get("chat1", id);
  assert.ok(o);
  const first = readSaved(o, {}, null);
  assert.match(first, /^out1: the whole output of `npm test` \(1000 lines\)\n {5}1\| line 1\n/);
  assert.match(first, / {3}300\| line 300\n… 700 more lines \(offset 301\)$/);
  const page = readSaved(o, { offset: 990, limit: 5 }, null);
  assert.match(page, / {3}990\| line 990\n(.*\n){4}… 6 more lines \(offset 995\)$/);
  assert.match(readSaved(o, { offset: 2000 }, null), /past the end/);
});

test("D311: filter picks lines and keeps their numbers", () => {
  const s = new SavedOutputs();
  const o = s.get("c", s.save("c", "build", "ok\nerror: one\nok\nerror: two\n"));
  assert.ok(o);
  assert.equal(
    readSaved(o, {}, /error/),
    "out1: the whole output of `build` (4 lines), 2 lines match the filter\n     2| error: one\n     4| error: two",
  );
  assert.match(readSaved(o, {}, /nothing/), /no matching lines/);
});

test("D311: a chat keeps its last five; a chat's outputs go with it", () => {
  const s = new SavedOutputs();
  for (let i = 0; i < 7; i++) s.save("c", `cmd${i}`, "x");
  s.save("d", "other", "y");
  assert.deepEqual(s.ids("c"), ["out3", "out4", "out5", "out6", "out7"]);
  s.forget("c");
  assert.deepEqual(s.ids("c"), []);
  assert.deepEqual(s.ids("d"), ["out8"]);
  const dropped = s.get("d", "out8");
  assert.ok(dropped);
  assert.match(
    readSaved({ ...dropped, dropped: 500 }, {}, null),
    /first 500 characters weren't kept/,
  );
});
