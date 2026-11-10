// D269: the command palette's order.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyMatch } from "../../ui/fuzzy";
import { matchTier, rankCommands } from "./commandRank";

const COMMANDS = [
  ["git.mergeKeepDelete", "Git: Keep or delete the file in merge editor"],
  ["ui.selectColorTheme", "Preferences: Color theme…"],
  ["extensions.setColorTheme", "Extensions: Set color theme"],
  ["ui.selectFileIconTheme", "Preferences: File icon theme…"],
  ["terminal.new", "Terminal: New terminal"],
  ["layout.toggleSidebar", "View: Toggle sidebar"],
] as const;

const rank = (query: string, recent: string[] = []) =>
  rankCommands(
    query,
    COMMANDS.flatMap(([id, text]) => {
      const match = fuzzyMatch(query, text);
      return match ? [{ id, text, match }] : [];
    }),
    recent,
  ).map((c) => c.id);

test("a start of 'theme' puts Color theme first, even over recently used commands", () => {
  for (const q of ["t", "th", "the", "them", "theme"])
    assert.equal(rank(q, ["git.mergeKeepDelete", "terminal.new"])[0], "ui.selectColorTheme", q);
});

test("whole-word matches come before scattered letters, recently used or not", () => {
  // "theme" is only scattered letters in the merge editor's label.
  const order = rank("icon", ["git.mergeKeepDelete"]);
  assert.equal(order[0], "ui.selectFileIconTheme");
  const themes = rank("theme", ["git.mergeKeepDelete"]);
  assert.equal(themes.at(-1), "git.mergeKeepDelete");
});

test("within the same kind of match, the recently used one first", () => {
  assert.deepEqual(rank("term", ["terminal.new"]).slice(0, 1), ["terminal.new"]);
  assert.equal(rank("set color", ["extensions.setColorTheme"])[0], "extensions.setColorTheme");
});

test("match tiers", () => {
  const tier = (q: string, t: string) =>
    matchTier(fuzzyMatch(q, t) ?? { score: 0, positions: [] }, t);
  assert.equal(tier("theme", "Preferences: Color theme…"), 0);
  assert.equal(tier("colortheme", "Preferences: Color theme…"), 0);
  assert.equal(tier("heme", "Preferences: Color theme…"), 1);
  assert.equal(tier("theme", "Git: Keep or delete the file in merge editor"), 2);
});
