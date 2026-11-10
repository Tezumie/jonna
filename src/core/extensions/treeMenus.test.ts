// Tree rows' context menus (`menus["view/item/context"]`, VS Code's): parsing, `when` on `view`
// and `viewItem`, groups and order, inline buttons, and the command's `{ item }` input.
import assert from "node:assert/strict";
import { test } from "node:test";
import { commandInputSchema } from "./commandInput";
import { parseManifest } from "./thirdParty";
import { treeItemMenu, treeMenuInput } from "./treeMenus";

const commands = [
  { id: "todo.open", title: "Open" },
  { id: "todo.done", title: "Mark done" },
  { id: "todo.rename", title: "Rename" },
  { id: "todo.delete", title: "Delete" },
  { id: "todo.copy", title: "Copy" },
];

function manifest() {
  const m = parseManifest(
    {
      id: "acme.todo",
      version: "1.0.0",
      displayName: "Todo",
      main: "main.js",
      contributes: {
        commands,
        views: [{ id: "todo.list", title: "Todo", location: "sidebar", type: "tree" }],
        menus: {
          "view/item/context": [
            { command: "todo.copy", when: "view == todo.list" },
            { command: "todo.delete", group: "9_danger", when: "viewItem == task" },
            { command: "todo.rename", group: "2_edit@2", when: "viewItem == task" },
            { command: "todo.done", group: "2_edit@1", when: "viewItem == task" },
            { command: "todo.open", group: "navigation", when: "view == todo.list" },
            {
              command: "todo.done",
              group: "inline",
              icon: "check",
              when: "view == todo.list && viewItem == task",
            },
            { command: "todo.open", when: "viewItem =~ /(/" },
          ],
        },
      },
    },
    "extension.json",
  );
  return m;
}

test("view/item/context parses, with groups", () => {
  const m = manifest();
  assert.throws(
    () =>
      parseManifest(
        {
          id: "acme.x",
          version: "1.0.0",
          contributes: {
            commands,
            menus: { "view/item/context": [{ command: "editor.save" }] },
          },
        },
        "extension.json",
      ),
    /isn't one of the extension's commands/,
  );
  const items = m.contributes.menus.filter((x) => x.location === "view/item/context");
  assert.equal(items.length, 7);
  assert.equal(items[2]?.group, "2_edit@2");
});

test("a task row: navigation, then groups by name, ungrouped last; inline as buttons", () => {
  const m = manifest();
  const titleOf = (id: string) => commands.find((c) => c.id === id)?.title ?? id;
  const menu = treeItemMenu(
    m.contributes.menus,
    "todo.list",
    { contextValue: "task" },
    () => undefined,
    titleOf,
  );
  assert.deepEqual(
    menu.groups.map((g) => g.map((e) => e.title)),
    [["Open"], ["Mark done", "Rename"], ["Delete"], ["Copy"]],
  );
  assert.deepEqual(menu.inline, [{ command: "todo.done", title: "Mark done", icon: "check" }]);
  // Another kind of row: only what its `when` allows (the bad regex hides its item).
  const other = treeItemMenu(
    m.contributes.menus,
    "todo.list",
    { contextValue: "folder" },
    () => undefined,
    titleOf,
  );
  assert.deepEqual(
    other.groups.map((g) => g.map((e) => e.command)),
    [["todo.open"], ["todo.copy"]],
  );
  assert.deepEqual(other.inline, []);
  // Another view: nothing.
  const elsewhere = treeItemMenu(m.contributes.menus, "x.other", {}, () => undefined, titleOf);
  assert.deepEqual(elsewhere, { inline: [], groups: [] });
});

test("context keys reach the when clause; a non-string contextValue is ignored", () => {
  const menus = [
    { location: "view/item/context" as const, command: "a", when: "acme.todo.editing" },
    { location: "view/item/context" as const, command: "b", when: "viewItem" },
  ];
  const menu = treeItemMenu(
    menus,
    "v",
    { contextValue: 3 as unknown as string },
    (k) => k === "acme.todo.editing",
    (c) => c,
  );
  assert.deepEqual(
    menu.groups.flat().map((e) => e.command),
    ["a"],
  );
});

test("a menu item runs its command with { item }, which its input schema accepts", () => {
  const input = treeMenuInput("todo.list", {
    id: "t1",
    label: "Write tests",
    contextValue: "task",
    description: "today",
    command: { id: "todo.open" },
  });
  assert.deepEqual(input, {
    item: {
      id: "t1",
      label: "Write tests",
      view: "todo.list",
      contextValue: "task",
      description: "today",
    },
  });
  const raw = { type: "object", properties: { force: { type: "boolean" } } };
  const strict = commandInputSchema(raw).schema;
  assert.equal(strict.validate(input).ok, false);
  const withItem = commandInputSchema(raw, { treeItem: true }).schema;
  assert.ok(withItem.validate(input).ok);
  assert.ok(withItem.validate({ force: true }).ok);
  assert.ok(withItem.validate({ path: "a.txt" }).ok);
});
