import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeIds,
  addItem,
  choiceIds,
  itemId,
  itemsToFetch,
  kindOfPath,
  MAX_TEAM_ITEM_BYTES,
  MAX_TEAM_ITEMS,
  switchOf,
  type TeamItem,
  type TeamKind,
  teamItems,
  turnOffItem,
  validItemId,
  validItemPath,
} from "./items";

const item = (
  id: string,
  kind: TeamKind,
  path: string,
  isDefault = false,
  version = 1,
): TeamItem => ({
  id,
  kind,
  path,
  isDefault,
  version,
  size: 10,
  by: "Ada",
  updatedAt: 1,
});

test("team: an item's id is the same wherever it is made", async () => {
  // base64url of the first 16 bytes of SHA-256 of kind + "\0" + path.
  assert.equal(await itemId("commands", "commands/ship.md"), "c413739evT82VNkEqiR4ew");
  assert.equal(await itemId("rules", "AGENTS.md"), "cCY13xJ_OM-daImf915mVA");
  assert.equal(
    await itemId("commands", "commands/ship.md"),
    await itemId("commands", "commands/ship.md"),
  );
  assert.notEqual(
    await itemId("agents", "agents/ship.md"),
    await itemId("commands", "commands/ship.md"),
  );
  assert.ok(validItemId(await itemId("skills", "skills/review/SKILL.md")));
});

test("team: the names each kind has", () => {
  for (const [kind, path] of [
    ["rules", "AGENTS.md"],
    ["mcp", "mcp.json"],
    ["settings", "settings.json"],
    ["extensions", "extensions.json"],
    ["skills", "skills/review/SKILL.md"],
    ["skills", "skills/review/scripts/run.py"],
    ["skills", "skills/code review/notes on style.md"],
    ["commands", "commands/ship.md"],
    ["agents", "agents/reviewer.md"],
    ["outputStyles", "output-styles/terse.md"],
    ["snippets", "snippets/go.json"],
    ["snippets", "snippets/all.code-snippets"],
  ] as const)
    assert.equal(validItemPath(kind, path), true, `${kind} ${path}`);
  assert.equal(kindOfPath("commands/ship.md"), "commands");
  assert.equal(kindOfPath("skills/review/SKILL.md"), "skills");
  assert.equal(kindOfPath("secrets.json"), null);
});

test("team: names that leave the folder, name a device or fit no kind are refused", () => {
  for (const [kind, path] of [
    ["skills", "skills/../../settings.json"],
    ["skills", "skills/review/../../x"],
    ["commands", "../commands/x.md"],
    ["commands", "/commands/x.md"],
    ["commands", "commands//x.md"],
    ["commands", "C:/commands/x.md"],
    ["commands", "commands\\x.md"],
    ["skills", "skills/review/a..b"],
    ["commands", "commands/NUL.md"],
    ["commands", "commands/con.md"],
    ["skills", "skills/COM1/SKILL.md"],
    ["skills", "skills/review/lpt9.txt"],
    ["skills", "skills/review/.env"],
    ["skills", "skills/review/x.md."],
    ["skills", "skills/review /SKILL.md"],
    ["rules", "CLAUDE.md"],
    ["rules", "rules/AGENTS.md"],
    ["commands", "commands/x.sh"],
    ["commands", "commands/deep/x.md"],
    ["commands", "commands/.md"],
    ["agents", "commands/x.md"],
    ["snippets", "snippets/x.exe"],
    ["skills", "skills/review"],
    ["skills", "skills/a/b/c/d/e/f.md"],
    ["mcp", "secrets.json"],
    ["settings", "keybindings.json"],
    ["providers", "providers.json"],
    ["hooks", "hooks.json"],
    ["rules", ""],
  ] as const)
    assert.equal(validItemPath(kind, path), false, `${kind} ${path}`);
  assert.equal(validItemPath("skills", `skills/${"a".repeat(200)}/SKILL.md`), false);
  for (const id of ["", "a/b", "a.b", "a b", "a".repeat(65), 7, null])
    assert.equal(validItemId(id), false, String(id));
});

test("team: a list keeps only what this build can use", () => {
  const list = teamItems([
    item("a", "rules", "AGENTS.md", true),
    { id: "b", kind: "providers", path: "providers.json" },
    { id: "c", kind: "skills", path: "skills/../../x" },
    { id: "../d", kind: "commands", path: "commands/d.md" },
    { id: "a", kind: "commands", path: "commands/again.md" },
    "not an item",
    null,
    { id: "e", kind: "commands", path: "commands/e.md", isDefault: "yes", version: "2" },
  ]);
  assert.deepEqual(
    list.map((x) => x.id),
    ["a", "e"],
  );
  // Anything that isn't plainly true or a number is not taken for one.
  assert.equal(list[1]?.isDefault, false);
  assert.equal(list[1]?.version, 0);
  assert.deepEqual(teamItems("nothing"), []);
});

test("team: on here = a default not turned off, or one that was added", () => {
  const items = [
    item("r", "rules", "AGENTS.md", true),
    item("c1", "commands", "commands/ship.md", true),
    item("c2", "commands", "commands/extra.md", false),
    item("a1", "agents", "agents/reviewer.md", false),
  ];
  assert.deepEqual([...activeIds(items, { added: [], off: [] })].sort(), ["c1", "r"]);
  assert.deepEqual([...activeIds(items, { added: ["c2"], off: ["c1"] })].sort(), ["c2", "r"]);
  // An id that isn't in the library changes nothing.
  assert.deepEqual([...activeIds(items, { added: ["gone"], off: ["gone"] })].sort(), ["c1", "r"]);
  // Added wins over turned off, should both name it.
  assert.ok(activeIds(items, { added: ["c1"], off: ["c1"] }).has("c1"));
});

test("team: a skill is switched whole, by its SKILL.md", () => {
  const items = [
    item("s1", "skills", "skills/review/SKILL.md", true),
    item("s2", "skills", "skills/review/scripts/run.py", false),
    item("t1", "skills", "skills/tests/SKILL.md", false),
    item("t2", "skills", "skills/tests/notes.md", true),
    // Files of a skill without a SKILL.md in the library aren't a skill: never on.
    item("o1", "skills", "skills/orphan/notes.md", true),
  ];
  const second = items[1] as TeamItem;
  const fourth = items[3] as TeamItem;
  const orphan = items[4] as TeamItem;
  assert.equal(switchOf(second, items)?.id, "s1");
  assert.equal(switchOf(orphan, items), null);
  // The files follow the SKILL.md, whatever their own flag says.
  assert.deepEqual([...activeIds(items, { added: [], off: [] })].sort(), ["s1", "s2"]);
  assert.deepEqual([...activeIds(items, { added: ["o1"], off: [] })].sort(), ["s1", "s2"]);
  // Adding by any file adds the skill; turning off by any file turns the skill off.
  const added = addItem(fourth, items, { added: [], off: [] });
  assert.deepEqual(added, { added: ["t1"], off: [] });
  assert.deepEqual([...activeIds(items, added)].sort(), ["s1", "s2", "t1", "t2"]);
  const off = turnOffItem(second, items, added);
  assert.deepEqual(off, { added: ["t1"], off: ["s1"] });
  assert.deepEqual([...activeIds(items, off)].sort(), ["t1", "t2"]);
  assert.throws(() => addItem(orphan, items, { added: [], off: [] }), /no SKILL\.md/);
});

test("team: adding and turning off keep the two lists to what they mean", () => {
  const items = [
    item("d", "commands", "commands/default.md", true),
    item("x", "commands", "commands/extra.md", false),
  ];
  const d = items[0] as TeamItem;
  const x = items[1] as TeamItem;
  // A default turned off, then on again: back to nothing chosen.
  const off = turnOffItem(d, items, { added: [], off: [] });
  assert.deepEqual(off, { added: [], off: ["d"] });
  assert.deepEqual(addItem(d, items, off), { added: [], off: [] });
  // An extra added, then turned off: back to nothing chosen.
  const added = addItem(x, items, { added: [], off: [] });
  assert.deepEqual(added, { added: ["x"], off: [] });
  assert.deepEqual(turnOffItem(x, items, added), { added: [], off: [] });
  // Twice is once.
  assert.deepEqual(addItem(x, items, added), added);
  assert.deepEqual(choiceIds(["a", "a", 7, "../b", null, "c"]), ["a", "c"]);
  assert.deepEqual(choiceIds("a"), []);
});

test("team: what is downloaded given the list and the cache", () => {
  const items = [
    item("same", "commands", "commands/a.md", true, 3),
    item("newer", "commands", "commands/b.md", true, 4),
    // Not on here: its text is kept all the same, to look at before adding.
    item("missing", "commands", "commands/c.md", false, 1),
    { ...item("huge", "commands", "commands/d.md"), size: MAX_TEAM_ITEM_BYTES + 1 },
  ];
  assert.deepEqual(itemsToFetch(items, { same: 3, newer: 2, gone: 9 }), ["newer", "missing"]);
  assert.deepEqual(itemsToFetch(items, { same: 3, newer: 4, missing: 1 }), []);
  // A hostile or oversized list: only so many items, only so many bytes.
  const many = Array.from({ length: MAX_TEAM_ITEMS + 20 }, (_, n) =>
    item(`i${n}`, "commands", `commands/c${n}.md`),
  );
  assert.equal(itemsToFetch(many, {}).length, MAX_TEAM_ITEMS);
  const heavy = Array.from({ length: 200 }, (_, n) => ({
    ...item(`i${n}`, "commands", `commands/c${n}.md`),
    size: MAX_TEAM_ITEM_BYTES,
  }));
  assert.equal(itemsToFetch(heavy, {}).length, 80);
});
