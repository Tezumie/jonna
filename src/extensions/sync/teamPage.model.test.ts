import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyLibraryWords,
  FILTER_FROM,
  filterGroups,
  hasFilter,
  kindHeading,
  lapsedLibraryLine,
  modeActions,
  modeChoices,
  modeInput,
  modeTag,
  NO_LIBRARY,
  ownItems,
  publishFailure,
  publishOutcome,
  publishReport,
  requiredWords,
  roleWords,
  rowCount,
  rowFacts,
  TEAM_GROUPS,
  TEAM_PRECEDENCE,
  type TeamLibrary,
  type TeamLibraryItem,
  teamAbilities,
  teamGroups,
  teamLibraryOf,
  toggleCommand,
} from "./teamPage.model";

const entry = (
  id: string,
  kind: TeamLibraryItem["kind"],
  path: string,
  more: Partial<TeamLibraryItem> = {},
): TeamLibraryItem => ({
  id,
  kind,
  path,
  isDefault: false,
  required: false,
  active: false,
  version: 1,
  by: "Ada",
  updatedAt: 1_000,
  ...more,
});

const libraryOf = (more: Partial<TeamLibrary> = {}): TeamLibrary => ({
  team: { name: "Studio", role: "member", publisher: false },
  state: "on",
  items: [],
  lastRefresh: 5,
  problem: null,
  ...more,
});

test("team page: the state is narrowed, whatever it holds", () => {
  assert.deepEqual(teamLibraryOf(null), NO_LIBRARY);
  assert.deepEqual(teamLibraryOf("x"), NO_LIBRARY);
  const read = teamLibraryOf({
    team: { name: " Studio ", role: "owner", publisher: true, members: ["x"] },
    state: "lapsed",
    items: [
      { id: "a", kind: "commands", path: "commands/ship.md", isDefault: true, active: true },
      { id: "b", kind: "providers", path: "providers.json" },
      { id: 3, kind: "rules", path: "AGENTS.md" },
      "junk",
    ],
    lastRefresh: 9,
    problem: "",
  });
  assert.deepEqual(read.team, { name: "Studio", role: "owner", publisher: true });
  assert.equal(read.state, "lapsed");
  assert.deepEqual(read.items, [
    {
      id: "a",
      kind: "commands",
      path: "commands/ship.md",
      isDefault: true,
      required: false,
      active: true,
      version: 0,
      by: "",
      updatedAt: null,
    },
  ]);
  assert.equal(read.lastRefresh, 9);
  assert.equal(read.problem, null);
  // Anything but "owner" is a member; a team without a name still has one to show.
  assert.deepEqual(teamLibraryOf({ team: { name: "", role: "admin" } }).team, {
    name: "Your team",
    role: "member",
    publisher: false,
  });
});

test("team page: the library by kind, in the page's order, empty kinds left out", () => {
  assert.deepEqual(
    TEAM_GROUPS.map((group) => group.heading),
    [
      "Rules",
      "Skills",
      "Commands",
      "Agents",
      "Output styles",
      "Snippets",
      "MCP servers",
      "Default settings",
      "Recommended extensions",
    ],
  );
  const groups = teamGroups([
    entry("x", "extensions", "extensions.json"),
    entry("s", "settings", "settings.json"),
    entry("c2", "commands", "commands/ship.md"),
    entry("c1", "commands", "commands/audit.md"),
    entry("r", "rules", "AGENTS.md"),
    entry("o", "outputStyles", "output-styles/terse.md"),
    entry("n", "snippets", "snippets/ts.code-snippets"),
  ]);
  assert.deepEqual(
    groups.map((group) => group.heading),
    [
      "Rules",
      "Commands",
      "Output styles",
      "Snippets",
      "Default settings",
      "Recommended extensions",
    ],
  );
  // Rows by name; a file's name without .md where the kind is Markdown files.
  assert.deepEqual(
    groups[1]?.rows.map((row) => row.name),
    ["audit", "ship"],
  );
  assert.equal(groups[0]?.rows[0]?.name, "AGENTS.md");
  assert.equal(groups[2]?.rows[0]?.name, "terse");
  assert.equal(groups[3]?.rows[0]?.name, "ts.code-snippets");
  assert.equal(groups[4]?.rows[0]?.name, "settings.json");
  assert.deepEqual(teamGroups([]), []);
  assert.equal(kindHeading("mcp"), "MCP servers");
  // What is said under a heading.
  const note = (kind: string) => TEAM_GROUPS.find((group) => group.kind === kind)?.note;
  assert.equal(note("skills"), note("commands"));
  assert.match(note("settings") ?? "", /^Defaults, not locks: your own settings win\./);
  assert.match(note("mcp") ?? "", /ask before they start/);
  // Keys are each member's own, and never in the library.
  assert.match(note("mcp") ?? "", /signs in to a server themselves: keys are never in the library/);
  assert.equal(note("rules"), null);
});

test("team page: a skill is one row, switched by its SKILL.md", () => {
  const groups = teamGroups([
    entry("f2", "skills", "skills/review/scripts/run.py", { by: "Bo", updatedAt: 3_000 }),
    entry("main", "skills", "skills/review/SKILL.md", { isDefault: true, active: true }),
    entry("f1", "skills", "skills/review/notes.md", { active: true }),
    entry("lone", "skills", "skills/draft/a.md"),
  ]);
  assert.equal(groups.length, 1);
  const [draft, review] = groups[0]?.rows ?? [];
  assert.equal(review?.name, "review");
  // The switch, the menu and the preview act on the SKILL.md.
  assert.equal(review?.id, "main");
  assert.equal(review?.path, "skills/review/SKILL.md");
  assert.equal(review?.files, 3);
  assert.deepEqual(review?.others, ["notes.md", "scripts/run.py"]);
  assert.equal(review?.isDefault, true);
  assert.equal(review?.on, true);
  assert.equal(review?.switchable, true);
  // The newest file says who changed it last.
  assert.equal(review?.by, "Bo");
  assert.equal(review?.updatedAt, 3_000);
  assert.equal(review && rowFacts(review), "Published by Bo · 3 files");
  // Files without a SKILL.md aren't a skill: listed, never on, no switch.
  assert.equal(draft?.name, "draft");
  assert.equal(draft?.id, "lone");
  assert.equal(draft?.switchable, false);
  assert.equal(draft?.on, false);
  assert.equal(draft && rowFacts(draft), "Published by Ada · 1 file");
});

test("team page: a row is on or off as the state says, default or not", () => {
  const rows = teamGroups([
    entry("a", "commands", "commands/a.md", { isDefault: true, active: true }),
    entry("b", "commands", "commands/b.md", { isDefault: true, active: false }),
    entry("c", "commands", "commands/c.md", { isDefault: false, active: true }),
    entry("d", "commands", "commands/d.md", { isDefault: false, active: false, by: "" }),
  ])[0]?.rows;
  assert.deepEqual(
    rows?.map((row) => [row.name, row.isDefault, row.on]),
    [
      ["a", true, true],
      ["b", true, false],
      ["c", false, true],
      ["d", false, false],
    ],
  );
  const last = rows?.[3];
  assert.equal(last && rowFacts(last), "Published");
});

test("team page: what a switch runs in each of the four cases", () => {
  // A default that is on → turned off; one this person turned off → turned back on.
  assert.equal(toggleCommand({ isDefault: true }, false), "team.turnOffItem");
  assert.equal(toggleCommand({ isDefault: true }, true), "team.turnOnItem");
  // Not a default: added, and taken out again.
  assert.equal(toggleCommand({ isDefault: false }, true), "team.addItem");
  assert.equal(toggleCommand({ isDefault: false }, false), "team.turnOffItem");
});

test("team page: who may do what", () => {
  const publisher = { name: "Studio", role: "member" as const, publisher: true };
  const owner = { name: "Studio", role: "owner" as const, publisher: true };
  // A member chooses what is on here, and can't change the library.
  assert.deepEqual(teamAbilities(libraryOf()), {
    choose: true,
    publish: false,
    decide: false,
    lapsed: false,
  });
  // A member who can publish publishes; what is on for everyone is the owner's to say.
  assert.deepEqual(teamAbilities(libraryOf({ team: publisher })), {
    choose: true,
    publish: true,
    decide: false,
    lapsed: false,
  });
  assert.deepEqual(teamAbilities(libraryOf({ team: owner })), {
    choose: true,
    publish: true,
    decide: true,
    lapsed: false,
  });
  // Lapsed: the library stays and what is on can still be chosen; nobody publishes.
  assert.deepEqual(teamAbilities(libraryOf({ team: owner, state: "lapsed" })), {
    choose: true,
    publish: false,
    decide: false,
    lapsed: true,
  });
  assert.deepEqual(teamAbilities(libraryOf({ team: publisher }), true), {
    choose: true,
    publish: false,
    decide: false,
    lapsed: true,
  });
  // In no team: nothing.
  assert.deepEqual(teamAbilities(NO_LIBRARY, true), {
    choose: false,
    publish: false,
    decide: false,
    lapsed: false,
  });
  assert.equal(roleWords(owner), "You own this team");
  assert.equal(roleWords(publisher), "Member · Can publish");
  assert.equal(roleWords({ ...publisher, publisher: false }), "Member");
  assert.match(lapsedLibraryLine(true), /once you renew it\.$/);
  assert.match(lapsedLibraryLine(false), /until the team's owner renews it\.$/);
  assert.match(emptyLibraryWords(true), /Choose Publish/);
  assert.doesNotMatch(emptyLibraryWords(false), /Choose Publish/);
});

test("team page: what of the user's own can be published", () => {
  const files = [
    "AGENTS.md",
    "keybindings.json",
    "commands/ship.md",
    "commands/notes.txt",
    "agents/reviewer.md",
    "output-styles/terse.md",
    "snippets/ts.json",
    "skills/review/SKILL.md",
    "skills/review/run.py",
    "skills/draft/a.md",
  ];
  assert.deepEqual(ownItems("rules", files), [{ path: "AGENTS.md", label: "AGENTS.md" }]);
  assert.deepEqual(ownItems("rules", ["commands/ship.md"]), []);
  // A skill whole, and only one with a SKILL.md.
  assert.deepEqual(ownItems("skills", files), [{ path: "skills/review", label: "review" }]);
  assert.deepEqual(ownItems("commands", files), [{ path: "commands/ship.md", label: "ship" }]);
  assert.deepEqual(ownItems("agents", files), [{ path: "agents/reviewer.md", label: "reviewer" }]);
  assert.deepEqual(ownItems("outputStyles", files), [
    { path: "output-styles/terse.md", label: "terse" },
  ]);
  assert.deepEqual(ownItems("snippets", files), [{ path: "snippets/ts.json", label: "ts.json" }]);
  // These come from elsewhere (the settings, mcp.json, the installed extensions).
  assert.deepEqual(ownItems("settings", files), []);
  assert.deepEqual(ownItems("mcp", files), []);
  assert.deepEqual(ownItems("extensions", files), []);
});

test("team page: what a publish came to, in one sentence", () => {
  const ok = publishOutcome("commands/ship.md", {
    published: [{ id: "a", path: "commands/ship.md", version: 2 }],
    conflicts: [],
  });
  assert.deepEqual(ok, { published: ["commands/ship.md"], refused: [] });
  assert.equal(
    publishReport([ok], "Studio").message,
    "Published to the library of Studio: commands/ship.md.",
  );
  const mixed = publishOutcome("skills/review", {
    published: [{ path: "skills/review/SKILL.md" }],
    conflicts: [{ path: "skills/review/a.md", version: 4, by: "Bo" }],
    skipped: ["skills/review/.env"],
    refused: ["agent.autoApprove"],
    failed: "skills/review/big.md: too large for the library.",
  });
  assert.deepEqual(mixed.published, ["skills/review/SKILL.md"]);
  assert.deepEqual(mixed.refused, [
    { what: "skills/review/a.md", why: "Bo published a newer version meanwhile" },
    { what: "skills/review/.env", why: "not a file the library takes" },
    { what: "agent.autoApprove", why: "not something a team's library takes" },
    { what: "skills/review/big.md", why: "too large for the library." },
  ]);
  const refused = publishFailure(
    "mcp.json",
    new Error("The MCP server db has a secret written out (env TOKEN)."),
  );
  const report = publishReport([ok, refused], "");
  assert.deepEqual(report.published, ["commands/ship.md"]);
  assert.equal(
    report.message,
    "Published to your team's library: commands/ship.md. Not published: mcp.json (The MCP server db has a secret written out (env TOKEN)).",
  );
  assert.equal(
    publishReport([refused], "Studio").message,
    "Nothing was published. Not published: mcp.json (The MCP server db has a secret written out (env TOKEN)).",
  );
  // Many files are counted, not listed.
  const many = { published: ["a", "b", "c", "d"], refused: [] };
  assert.equal(
    publishReport([many], "Studio").message,
    "Published 4 files to the library of Studio.",
  );
  assert.deepEqual(publishOutcome("x", null).refused, [{ what: "x", why: "nothing came back" }]);
});

test("team page: a row's mode, its tag, and what its owner can make it", () => {
  const read = teamLibraryOf({
    team: { name: "Studio", role: "owner", publisher: true },
    items: [
      { id: "a", kind: "commands", path: "commands/a.md", isDefault: true, required: true },
      { id: "b", kind: "commands", path: "commands/b.md", isDefault: true, required: "yes" },
    ],
  });
  assert.deepEqual(
    read.items.map((item) => item.required),
    [true, false],
  );
  const groups = teamGroups([
    entry("req", "commands", "commands/a.md", { isDefault: true, required: true, active: true }),
    entry("def", "commands", "commands/b.md", { isDefault: true, active: true }),
    entry("opt", "commands", "commands/c.md"),
    // A skill is on as its SKILL.md says, whatever its other files carry.
    entry("main", "skills", "skills/review/SKILL.md", { required: true, active: true }),
    entry("file", "skills", "skills/review/run.py"),
    entry("lone", "skills", "skills/draft/a.md", { required: true }),
  ]);
  const modes = (kind: string) =>
    groups.find((group) => group.kind === kind)?.rows.map((row) => [row.name, row.mode]);
  assert.deepEqual(modes("commands"), [
    ["a", "required"],
    ["b", "default"],
    ["c", "optional"],
  ]);
  assert.deepEqual(modes("skills"), [
    ["draft", "optional"],
    ["review", "required"],
  ]);
  assert.equal(modeTag("required"), "Required");
  assert.equal(modeTag("default"), "Default");
  assert.equal(modeTag("optional"), null);
  // The owner's menu: the two modes the row isn't in, as team.setMode takes them.
  assert.deepEqual(modeActions("optional"), [
    { mode: "default", label: "Make a default" },
    { mode: "required", label: "Make required" },
  ]);
  assert.deepEqual(modeActions("default"), [
    { mode: "optional", label: "Make optional" },
    { mode: "required", label: "Make required" },
  ]);
  assert.deepEqual(modeActions("required"), [
    { mode: "optional", label: "Make optional" },
    { mode: "default", label: "Make a default" },
  ]);
  // In place of a required row's switch.
  assert.equal(
    requiredWords("commands"),
    "Your team requires this item, so it can't be switched off here.",
  );
  assert.match(
    requiredWords("settings"),
    /still defaults: where you set a value of your own, yours wins\.$/,
  );
  assert.equal(
    TEAM_PRECEDENCE,
    "Your own files and settings win over the team's. Required items are always on.",
  );
});

test("team page: who published a row, and when", () => {
  const rows = teamGroups([
    entry("a", "commands", "commands/a.md", { by: "Ada Lovelace", updatedAt: 7_000 }),
    entry("b", "commands", "commands/b.md", { by: "", updatedAt: null }),
  ])[0]?.rows;
  const [a, b] = rows ?? [];
  // The time is the row's own (the page draws it so it stays current).
  assert.equal(a && rowFacts(a), "Published by Ada Lovelace");
  assert.equal(a?.updatedAt, 7_000);
  // A service that names nobody: the date alone.
  assert.equal(b && rowFacts(b), "Published");
  assert.equal(b?.updatedAt, null);
});

test("team page: the filter, by name and kind", () => {
  const few = teamGroups([
    entry("c1", "commands", "commands/ship.md"),
    entry("c2", "commands", "commands/Audit.md"),
    entry("a1", "agents", "agents/shipper.md"),
    entry("m", "mcp", "mcp.json"),
    entry("o", "outputStyles", "output-styles/terse.md"),
    entry("s1", "skills", "skills/review/SKILL.md"),
    entry("s2", "skills", "skills/review/run.py"),
  ]);
  // A skill is one row however many files it is.
  assert.equal(rowCount(few), 6);
  assert.equal(hasFilter(few), false);
  // A box only above a library of more than a dozen rows.
  const library = (rows: number) =>
    teamGroups(
      Array.from({ length: rows }, (_, n) => entry(`c${n}`, "commands", `commands/c${n}.md`)),
    );
  assert.equal(hasFilter(library(FILTER_FROM)), false);
  assert.equal(hasFilter(library(FILTER_FROM + 1)), true);

  const names = (query: string) =>
    filterGroups(few, query).map((group) => [group.kind, group.rows.map((row) => row.name)]);
  // Nothing typed (or only spaces): everything, as it was.
  assert.deepEqual(filterGroups(few, ""), few);
  assert.deepEqual(filterGroups(few, "   "), few);
  // By name, whatever the case; groups without a match are left out.
  assert.deepEqual(names("SHIP"), [
    ["commands", ["ship"]],
    ["agents", ["shipper"]],
  ]);
  assert.deepEqual(names("audit"), [["commands", ["Audit"]]]);
  // By kind: the heading's words, or the kind's own.
  assert.deepEqual(names("commands"), [["commands", ["Audit", "ship"]]]);
  assert.deepEqual(names("servers"), [["mcp", ["mcp.json"]]]);
  assert.deepEqual(names("output styles"), [["outputStyles", ["terse"]]]);
  assert.deepEqual(names("outputstyles"), [["outputStyles", ["terse"]]]);
  // Every word must be found: a kind and a name narrow each other.
  assert.deepEqual(names("commands ship"), [["commands", ["ship"]]]);
  assert.deepEqual(names("agents audit"), []);
  // Nothing matches.
  assert.deepEqual(names("zzz"), []);
});

test("team page: what the publish picker asks about who it is on for", () => {
  // The owner chooses; "keep" only for what is in the library already.
  assert.deepEqual(
    modeChoices(true, false)?.map((choice) => [choice.id, choice.label]),
    [
      ["optional", "Optional (members add it)"],
      ["default", "On by default (members can switch it off)"],
      ["required", "Required (always on)"],
    ],
  );
  assert.deepEqual(
    modeChoices(true, true)?.map((choice) => choice.id),
    ["keep", "optional", "default", "required"],
  );
  assert.equal(modeChoices(true, true)?.[0]?.label, "Keep as it is");
  // A member who can publish isn't asked: optional.
  assert.equal(modeChoices(false, false), null);
  assert.equal(modeChoices(false, true), null);
  assert.deepEqual(modeInput(null), { mode: "optional" });
  assert.deepEqual(modeInput("keep"), {});
  assert.deepEqual(modeInput("required"), { mode: "required" });
  assert.deepEqual(modeInput("default"), { mode: "default" });
});
