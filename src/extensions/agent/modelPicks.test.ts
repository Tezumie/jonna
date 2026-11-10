import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentPickKey,
  parsePick,
  pickList,
  priceLabel,
  toggledFavorite,
  withRecent,
} from "./modelPicks";

test("pick keys: provider models and external agents' own models", () => {
  assert.deepEqual(parsePick("openai/gpt-5"), { model: "openai/gpt-5" });
  assert.deepEqual(parsePick("acp/Codex"), { model: "acp/Codex" });
  assert.deepEqual(parsePick(agentPickKey("Codex", "gpt-5.1")), {
    model: "acp/Codex",
    agentModel: "gpt-5.1",
  });
  // A provider model with "#" in its name stays whole.
  assert.deepEqual(parsePick("ollama/x#1"), { model: "ollama/x#1" });
});

test("recents: newest first, no repeats, capped", () => {
  assert.deepEqual(withRecent(["a", "b"], "b"), ["b", "a"]);
  assert.deepEqual(withRecent(null, "a"), ["a"]);
  assert.deepEqual(withRecent(["1", "2", "3", "4", "5", "6"], "7").length, 6);
  assert.deepEqual(pickList(["a", 3, "", "b"]), ["a", "b"]);
});

test("priceLabel: free, or in / out per million", () => {
  assert.equal(priceLabel(undefined), "");
  assert.equal(priceLabel({ input: 0, output: 0 }), "free");
  assert.equal(priceLabel({ input: 3, output: 15 }), "$3 / $15 per M");
  assert.equal(priceLabel({ input: 0.25, output: 2 }), "$0.25 / $2 per M");
});

test("favorites toggle", () => {
  assert.deepEqual(toggledFavorite(["a"], "b"), ["a", "b"]);
  assert.deepEqual(toggledFavorite(["a", "b"], "a"), ["b"]);
});
