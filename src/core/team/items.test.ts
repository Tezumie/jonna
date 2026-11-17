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
  modeAt,
  modeFlags,
  modeGiven,
  modeOf,
  OWNER_DECIDES,
  ownerOnlyRefusal,
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
  required: false,
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
  assert.equal(list[0]?.required, false);
  const [must, not] = teamItems([
    { id: "m", kind: "commands", path: "commands/m.md", isDefault: true, required: true },
    { id: "n", kind: "commands", path: "commands/n.md", required: "yes" },
  ]);
  assert.equal(must?.required, true);
  assert.equal(not?.required, false);
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

const required = (id: string, kind: TeamKind, path: string): TeamItem => ({
  ...item(id, kind, path, true),
  required: true,
});

test("team: an item's mode, and what a mode carries", () => {
  assert.equal(modeOf(item("a", "commands", "commands/a.md")), "optional");
  assert.equal(modeOf(item("a", "commands", "commands/a.md", true)), "default");
  assert.equal(modeOf(required("a", "commands", "commands/a.md")), "required");
  // Required without the default flag is required all the same.
  assert.equal(modeOf({ isDefault: false, required: true }), "required");
  assert.deepEqual(modeFlags("optional"), { isDefault: false, required: false });
  assert.deepEqual(modeFlags("default"), { isDefault: true, required: false });
  // A required item is a default too, for a build that doesn't know the word.
  assert.deepEqual(modeFlags("required"), { isDefault: true, required: true });
  // The older `isDefault` still says a mode; `mode` wins over it.
  assert.equal(modeGiven(undefined, undefined), undefined);
  assert.equal(modeGiven(undefined, true), "default");
  assert.equal(modeGiven(undefined, false), "optional");
  assert.equal(modeGiven("required", false), "required");
});

test("team: a required item is on whatever this person chose", () => {
  const items = [
    required("r", "rules", "AGENTS.md"),
    { ...item("q", "commands", "commands/q.md", false), required: true },
    item("d", "commands", "commands/d.md", true),
    item("x", "commands", "commands/x.md", false),
  ];
  const r = items[0] as TeamItem;
  assert.deepEqual([...activeIds(items, { added: [], off: [] })].sort(), ["d", "q", "r"]);
  // Turned off in the settings file by hand: still on.
  assert.deepEqual([...activeIds(items, { added: [], off: ["r", "q", "d"] })].sort(), ["q", "r"]);
  // It never goes into the list of what is off, and the choices stay as they were.
  const before = { added: ["x"], off: ["d"] };
  assert.deepEqual(turnOffItem(r, items, before), before);
  // Turning it "on" tidies a stale entry away, and never adds it.
  assert.deepEqual(addItem(r, items, { added: ["r"], off: ["r"] }), { added: [], off: [] });
});

test("team: a skill is required as its SKILL.md is", () => {
  const items = [
    required("s1", "skills", "skills/review/SKILL.md"),
    item("s2", "skills", "skills/review/run.py", false),
    item("t1", "skills", "skills/tests/SKILL.md", false),
    // A file's own flag says nothing: its skill's SKILL.md does.
    required("t2", "skills", "skills/tests/notes.md"),
  ];
  const file = items[1] as TeamItem;
  assert.deepEqual([...activeIds(items, { added: [], off: ["s1"] })].sort(), ["s1", "s2"]);
  assert.equal(modeOf(switchOf(file, items) ?? file), "required");
  assert.deepEqual(turnOffItem(file, items, { added: [], off: [] }), { added: [], off: [] });
  assert.equal(modeOf(switchOf(items[3] as TeamItem, items) ?? file), "optional");
});

test("team: the mode of what a publish would change", () => {
  const items = [
    item("c", "commands", "commands/ship.md", true),
    item("o", "commands", "commands/extra.md", false),
    required("s1", "skills", "skills/review/SKILL.md"),
    item("s2", "skills", "skills/review/run.py", false),
    item("t1", "skills", "skills/tests/SKILL.md", false),
    item("t2", "skills", "skills/tests/notes.md", true),
    // An agent of the same file name is another item.
    required("a", "agents", "agents/ship.md"),
  ];
  assert.equal(modeAt(items, "commands", "commands/ship.md"), "default");
  assert.equal(modeAt(items, "commands", "commands/extra.md"), "optional");
  assert.equal(modeAt(items, "commands", "commands/new.md"), null);
  assert.equal(modeAt(items, "commands", "commands/ship"), null);
  // A skill's folder: every file of it. A skill's file: its SKILL.md too, also for a new file.
  assert.equal(modeAt(items, "skills", "skills/review"), "required");
  assert.equal(modeAt(items, "skills", "skills/review/run.py"), "required");
  assert.equal(modeAt(items, "skills", "skills/review/new.md"), "required");
  assert.equal(modeAt(items, "skills", "skills/tests"), "default");
  assert.equal(modeAt(items, "skills", "skills/tests/SKILL.md"), "optional");
  assert.equal(modeAt(items, "skills", "skills/rev"), null);
});

test("team: only the owner decides what is on for everyone", () => {
  // The owner: anything.
  for (const wanted of [undefined, "optional", "default", "required"] as const)
    for (const existing of [null, "optional", "default", "required"] as const)
      assert.equal(ownerOnlyRefusal(true, wanted, existing), null);
  // A member who can publish: optional items, new or there.
  assert.equal(ownerOnlyRefusal(false, undefined, null), null);
  assert.equal(ownerOnlyRefusal(false, "optional", null), null);
  assert.equal(ownerOnlyRefusal(false, undefined, "optional"), null);
  assert.equal(ownerOnlyRefusal(false, "optional", "optional"), null);
  // Not as a default or required, and not over one (nor to make one optional).
  assert.equal(ownerOnlyRefusal(false, "default", null), OWNER_DECIDES);
  assert.equal(ownerOnlyRefusal(false, "required", "optional"), OWNER_DECIDES);
  assert.equal(ownerOnlyRefusal(false, undefined, "default"), OWNER_DECIDES);
  assert.equal(ownerOnlyRefusal(false, "optional", "required"), OWNER_DECIDES);
  assert.equal(
    OWNER_DECIDES,
    "Only the team's owner can change what is on for everyone. You can publish this as an optional item.",
  );
});
