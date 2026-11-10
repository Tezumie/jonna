import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "./conversation";
import { parseSuggestion, suggestionRefusal, suggestionResult } from "./extensionSuggest";

const card = (detail: object): Item => ({
  type: "tool",
  id: "t1",
  callId: "c1",
  name: "suggest_extension",
  args: { query: "prisma" },
  status: "done",
  detail: JSON.stringify(detail),
});
const user = (text: string): Item => ({ type: "user", id: `u${text.length}`, text });
const one = {
  reason: "Highlights .prisma files",
  items: [{ id: "prisma.prisma", displayName: "Prisma", publisher: "prisma", description: "" }],
};

test("suggest_extension: the card's data kept in the call's detail (D314)", () => {
  assert.deepEqual(parseSuggestion(JSON.stringify(one)), one);
  assert.equal(parseSuggestion("not json"), null);
  assert.equal(parseSuggestion(JSON.stringify({ items: [] })), null);
  assert.equal(parseSuggestion(undefined), null);
  assert.match(suggestionResult(one), /prisma\.prisma.*don't describe/);
});

test("suggest_extension: once per conversation unless the user takes it up", () => {
  assert.equal(suggestionRefusal([user("fix the schema")]), null);
  const shown = [user("fix the schema"), card(one)];
  assert.match(suggestionRefusal(shown) ?? "", /already suggested/);
  assert.match(suggestionRefusal([...shown, user("ok go on")]) ?? "", /already suggested/);
  assert.equal(suggestionRefusal([...shown, user("any other extension for this?")]), null);
  assert.equal(suggestionRefusal([user("x"), card({ ...one, engaged: true })]), null);
  // A failed call didn't show anything.
  assert.equal(suggestionRefusal([{ ...card(one), status: "error" } as Item]), null);
});
