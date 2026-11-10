import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCompounds } from "./compounds";
import { parsePresentation, startsGroup, visibleAndSorted } from "./presentation";

test("presentation: parsed from launch.json, junk ignored (D207)", () => {
  assert.equal(parsePresentation(undefined), undefined);
  assert.equal(parsePresentation([1]), undefined);
  assert.deepEqual(parsePresentation({ hidden: true, group: " servers ", order: 2 }), {
    hidden: true,
    group: "servers",
    order: 2,
  });
  assert.deepEqual(parsePresentation({ hidden: "yes", group: "", order: "1" }), {});
  const [c] = parseCompounds(
    {
      compounds: [
        { name: "Both", configurations: ["a", "b"], presentation: { group: "x", order: 1 } },
      ],
    },
    "launch.json",
  );
  assert.deepEqual(c?.presentation, { group: "x", order: 1 });
});

test("presentation: VS Code's picker order — groups by name, then order, the rest last", () => {
  const items = [
    { name: "plain 1" },
    { name: "z2", presentation: { group: "z", order: 2 } },
    { name: "hidden", presentation: { hidden: true, group: "a" } },
    { name: "ordered", presentation: { order: 1 } },
    { name: "a-none", presentation: { group: "a" } },
    { name: "z1", presentation: { group: "z", order: 1 } },
    { name: "a1", presentation: { group: "a", order: 1 } },
    { name: "plain 2" },
    { name: "unordered", presentation: {} },
  ];
  const sorted = visibleAndSorted(items);
  assert.deepEqual(
    sorted.map((i) => i.name),
    ["a1", "a-none", "z1", "z2", "ordered", "unordered", "plain 1", "plain 2"],
  );
  assert.deepEqual(
    sorted.map((_, i) => startsGroup(sorted, i)),
    [false, false, true, false, true, false, false, false],
  );
});
