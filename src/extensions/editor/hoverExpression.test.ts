import assert from "node:assert/strict";
import { test } from "node:test";
import { hoverExpression } from "./hoverExpression";

test("debug hover expressions", () => {
  const line = "  total = add(user.profile.name, this.items?.length) + 42;";
  const at = (text: string) => line.indexOf(text) + 1;
  assert.equal(hoverExpression(line, at("total"))?.expression, "total");
  assert.equal(hoverExpression(line, at("name") + 2)?.expression, "user.profile.name");
  assert.equal(hoverExpression(line, at("profile"))?.expression, "user.profile");
  assert.equal(hoverExpression(line, at("length"))?.expression, "this.items?.length");
  assert.equal(hoverExpression(line, at("42")), null);
  assert.equal(hoverExpression(line, at(") +") + 1), null);
  assert.equal(hoverExpression("  return x;", 4), null);
  // Just past the end of a word still counts.
  assert.deepEqual(hoverExpression("foo + 1", 4), { expression: "foo", start: 1, end: 4 });
});
