import assert from "node:assert/strict";
import { test } from "node:test";
import { activeRowAfter, blocksAccept, filterItems, titleText } from "./quickInputModel";

const items = [
  { label: "Python 3.12", description: "~/.venv", separator: "Recommended" },
  { label: "Python 3.13", detail: "/usr/bin/python3.13" },
  { label: "Enter interpreter path…", alwaysShow: true },
  { label: "Conda base", description: "python 3.11" },
];

test("filterItems: all items with their group lines while nothing is typed", () => {
  const rows = filterItems(items, "");
  assert.deepEqual(
    rows.map((r) => r.index),
    [0, 1, 2, 3],
  );
  assert.equal(rows[0]?.separator, "Recommended");
});

test("filterItems: labels first, description / detail when asked, alwaysShow kept", () => {
  assert.deepEqual(
    filterItems(items, "313").map((r) => r.index),
    [1, 2],
  );
  assert.deepEqual(
    filterItems(items, "venv", { matchOnDescription: true }).map((r) => r.index),
    [0, 2],
  );
  assert.deepEqual(
    filterItems(items, "usr", { matchOnDetail: true }).map((r) => r.index),
    [1, 2],
  );
  // A label match ranks above a description match.
  assert.deepEqual(
    filterItems(items, "python", { matchOnDescription: true }).map((r) => r.index),
    [0, 1, 3, 2],
  );
  assert.equal(filterItems(items, "zzz").length, 1, "only the alwaysShow item");
  assert.equal(filterItems(items, "py")[0]?.separator, undefined, "no group lines while typing");
});

test("filterItems: sortByLabel false keeps the given order", () => {
  const list = [{ label: "beta" }, { label: "b" }];
  assert.deepEqual(
    filterItems(list, "b").map((r) => r.index),
    [1, 0],
  );
  assert.deepEqual(
    filterItems(list, "b", { sortByLabel: false }).map((r) => r.index),
    [0, 1],
  );
});

test("activeRowAfter: wanted items, then the kept one, then the first", () => {
  const rows = [{ index: 4 }, { index: 7 }, { index: 9 }];
  assert.equal(activeRowAfter(rows, [9], 7, true), 2);
  assert.equal(activeRowAfter(rows, [5], 7, true), 1);
  assert.equal(activeRowAfter(rows, undefined, 7, false), 0);
  assert.equal(activeRowAfter([], [1], 1, true), -1);
});

test("blocksAccept and titleText", () => {
  assert.equal(blocksAccept({ message: "x", severity: "error" }), true);
  assert.equal(blocksAccept({ message: "x", severity: "warning" }), false);
  assert.equal(blocksAccept(null), false);
  assert.equal(titleText("Select kernel", 2, 3), "Select kernel (2/3)");
  assert.equal(titleText(undefined, 1), "1");
  assert.equal(titleText("T"), "T");
  assert.equal(titleText(undefined), "");
});
