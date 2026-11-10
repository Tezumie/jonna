import assert from "node:assert/strict";
import { test } from "node:test";
import { groupByExtension, isLink, pageSections, pagesFor } from "./pages";

test("settings pages: merged categories, extension pages last, empty pages hidden (D179)", () => {
  const { groups, pageOf } = pagesFor(["Workbench", "Window", "Agent", "TODO tree", "Editor"]);
  assert.equal(pageOf("Window")?.title, "Appearance");
  assert.equal(pageOf("Workbench")?.id, "appearance");
  assert.equal(pageOf("TODO tree")?.title, "TODO tree");
  const titles = groups.map((g) => g.items.map((i) => i.title));
  // No Search or Terminal settings here: no such pages; links always show.
  assert.ok(!titles.flat().includes("Search"));
  assert.ok(titles.flat().includes("Keyboard shortcuts"));
  // The extension's page sits in the last group, before its links.
  const last = groups[groups.length - 1];
  assert.equal(last?.items[0]?.title, "TODO tree");
  assert.ok(last && isLink(last.items[last.items.length - 1] ?? ({ command: "" } as never)));
});

test("page sections: by category order, then the setting's own section", () => {
  const page = { id: "p", title: "P", icon: "box" as const, categories: ["Workbench", "Window"] };
  const sections = pageSections(page, [
    { key: "window.zoomLevel", category: "Window" },
    { key: "workbench.a", category: "Workbench", section: "Theme" },
    { key: "workbench.b", category: "Workbench" },
    { key: "workbench.c", category: "Workbench", section: "Theme" },
  ]);
  assert.deepEqual(
    sections.map((s) => [s.title, s.settings.map((x) => x.key)]),
    [
      ["Theme", ["workbench.a", "workbench.c"]],
      ["Workbench", ["workbench.b"]],
      ["Window", ["window.zoomLevel"]],
    ],
  );
});

test("an extension's settings share one page, its configuration titles as sections", () => {
  type S = { key: string; category: string; section?: string; extension?: string };
  const out = groupByExtension<S>([
    { key: "gitlens.codeLens.enabled", category: "Code Lens", extension: "eamodio.gitlens" },
    { key: "gitlens.currentLine.enabled", category: "Inline Blame", extension: "eamodio.gitlens" },
    { key: "gitlens.mode", category: "General", extension: "eamodio.gitlens" },
    { key: "prettier.semi", category: "Prettier", extension: "esbenp.prettier-vscode" },
    { key: "editor.fontSize", category: "Editor", extension: "builtin.editor" },
    { key: "todo.highlight", category: "Editor", extension: "acme.todo" },
    { key: "a.x", category: "General", extension: "one.a" },
    { key: "a.y", category: "Other", extension: "one.a" },
    { key: "b.x", category: "General", extension: "two.b" },
    { key: "b.y", category: "More", extension: "two.b" },
  ]);
  const by = (key: string) => out.find((s) => s.key === key);
  assert.equal(by("gitlens.mode")?.category, "Gitlens");
  assert.equal(by("gitlens.mode")?.section, "General");
  assert.equal(by("gitlens.codeLens.enabled")?.section, "Code Lens");
  // One configuration title: its page as before.
  assert.deepEqual(by("prettier.semi"), {
    key: "prettier.semi",
    category: "Prettier",
    extension: "esbenp.prettier-vscode",
  });
  // The IDE's own, and a claimed page's, stay.
  assert.equal(by("editor.fontSize")?.category, "Editor");
  assert.equal(by("todo.highlight")?.category, "Editor");
  assert.equal(by("a.x")?.category, "A");
  assert.equal(by("b.y")?.category, "B");
});
