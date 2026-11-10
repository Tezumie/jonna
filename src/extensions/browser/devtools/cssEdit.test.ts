import assert from "node:assert/strict";
import { test } from "node:test";
import { bumpNumber, byPrecedence, colorTokens, overridden } from "./cssEdit";

test("arrow keys step the number at the caret", () => {
  assert.equal(bumpNumber("10px", 2, 1)?.value, "11px");
  assert.equal(bumpNumber("10px 4px", 6, -10)?.value, "10px -6px");
  assert.equal(bumpNumber("0.5", 0, 0.1)?.value, "0.6");
  assert.equal(bumpNumber("1.25rem", 0, 1)?.value, "2.25rem");
  assert.equal(bumpNumber("translate(-2px, 3px)", 0, 1)?.value, "translate(-1px, 3px)");
  assert.equal(bumpNumber("h1", 1, 1), null);
  assert.equal(bumpNumber("#a1b2c3", 3, 1), null);
  assert.equal(bumpNumber("auto", 0, 1), null);
});

test("colors in a value", () => {
  assert.deepEqual(
    colorTokens("1px solid #ff0000").map((t) => t.text),
    ["#ff0000"],
  );
  assert.deepEqual(
    colorTokens("linear-gradient(red, rgba(0, 0, 0, 0.5))").map((t) => t.text),
    ["red", "rgba(0, 0, 0, 0.5)"],
  );
  assert.deepEqual(colorTokens("solid 2px"), []);
  assert.deepEqual(colorTokens("#12345").length, 0);
});

test("the cascade: specificity, order, !important, switched off", () => {
  const rules = byPrecedence([
    { id: "a", specificity: [0, 0, 1], order: 0, props: [["color", "red", false, true]] },
    {
      id: "b",
      specificity: [0, 1, 0],
      order: 1,
      props: [
        ["color", "blue", false, true],
        ["margin", "0", false, true],
      ],
    },
    { id: "c", specificity: [0, 1, 0], order: 2, props: [["margin", "4px", false, false]] },
    { id: "inline", specificity: [1, 0, 0], order: -1, props: [["margin", "8px", false, true]] },
    { id: "d", specificity: [0, 0, 1], order: 3, props: [["color", "green", true, true]] },
  ] as never);
  assert.deepEqual(
    rules.map((r) => r.id),
    ["inline", "c", "b", "d", "a"],
  );
  // color: d's !important wins over b (more specific); a loses; margin: inline wins, c is off.
  assert.deepEqual([...overridden(rules)].sort(), ["a:0", "b:0", "b:1"]);
});
