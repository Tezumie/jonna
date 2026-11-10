// DockService with fake views (no DOM): lifecycle, welcome fallback, persistence, regions.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Json } from "../../core/dock/index";
import { DockService } from "./service";
import { type DockView, DockViewRegistry } from "./views";

interface FakeView extends DockView {
  disposed: boolean;
  state: Json;
}

function setup(options: { dirtyAsk?: () => Promise<boolean> } = {}) {
  const created: FakeView[] = [];
  const views = new DockViewRegistry();
  const make = (type: string, extra: object = {}) =>
    views.register({
      type,
      title: () => type,
      icon: () => "file",
      ...extra,
      create: (state) => {
        const view: FakeView = {
          element: {} as HTMLElement,
          disposed: false,
          state,
          serialize: () => view.state,
          ...(type === "editor" && options.dirtyAsk && { confirmClose: options.dirtyAsk }),
          dispose: () => {
            view.disposed = true;
          },
        };
        created.push(view);
        return view;
      },
    });
  make("editor", { editorLike: true, defaultPlacement: "main", duplicate: (s: Json) => s });
  make("welcome", { editorLike: true, singleton: true });
  make("terminal", { defaultPlacement: "bottom" });
  make("agent", { singleton: true, defaultPlacement: "right" });
  make("room", { defaultPlacement: "right", previewKind: "room" });
  make("thread", { defaultPlacement: "right", previewKind: "thread" });
  const dock = new DockService(views);
  dock.resetToDefault(["welcome"], ["terminal"], ["agent"]);
  return { dock, created };
}

const types = (dock: DockService) => dock.tabs().map((t) => t.viewType);

test("default arrangement; views are created lazily and kept across moves", () => {
  const { dock, created } = setup();
  assert.deepEqual(types(dock).sort(), ["agent", "terminal", "welcome"]);
  assert.equal(created.length, 0);
  const terminal = dock.tabs("terminal")[0];
  assert.ok(terminal);
  const view = dock.view(terminal);
  dock.moveTab(terminal.id, { groupId: "main" });
  assert.equal(dock.view(terminal), view, "moving a tab must not recreate its view");
  assert.equal(created.length, 1);
  assert.equal(dock.findGroup("bottom"), undefined, "the emptied group collapses");
});

test("singletons are reused; placement hints create missing regions", () => {
  const { dock } = setup();
  const agent = dock.openView("agent");
  assert.equal(dock.tabs("agent").length, 1);
  assert.equal(dock.tabs("agent")[0]?.id, agent);
  void dock.closeTab(agent);
  const again = dock.openView("agent", null, "right");
  assert.equal(dock.regionGroups("right")[0]?.tabs[0]?.id, again);
});

test("closing the last editor-like tab shows welcome; closing disposes the view", async () => {
  const { dock, created } = setup();
  const editor = dock.openView("editor", { path: "/a.ts" }, "main");
  for (const w of dock.tabs("welcome")) await dock.closeTab(w.id, true);
  assert.deepEqual(
    types(dock).filter((t) => t !== "terminal" && t !== "agent"),
    ["editor"],
  );
  const ref = dock.tabs("editor")[0];
  assert.ok(ref);
  dock.view(ref);
  assert.equal(await dock.closeTab(editor), true);
  assert.equal(created[0]?.disposed, true);
  assert.deepEqual(dock.tabs("welcome").length, 1);
});

test("Welcome closes beside a chat; the next file gets an editor area of its own (D368)", async () => {
  const { dock } = setup();
  for (const w of dock.tabs("welcome")) await dock.closeTab(w.id, true);
  assert.equal(dock.tabs("welcome").length, 0);
  const agentGroup = dock.findTab(dock.tabs("agent")[0]?.id ?? "")?.group.id;
  const terminalGroup = dock.findTab(dock.tabs("terminal")[0]?.id ?? "")?.group.id;
  const editor = dock.openView("editor", { path: "/a.ts" });
  const group = dock.findTab(editor)?.group;
  assert.ok(group);
  assert.notEqual(group.id, agentGroup);
  assert.notEqual(group.id, terminalGroup);
  assert.deepEqual(
    group.tabs.map((t) => t.viewType),
    ["editor"],
  );
  // With nothing else on screen, Welcome still fills the dock.
  for (const t of [...dock.tabs("terminal"), ...dock.tabs("agent"), ...dock.tabs("editor")])
    await dock.closeTab(t.id, true);
  assert.equal(dock.tabs("welcome").length, 1);
});

test("a view can veto closing (unsaved changes)", async () => {
  const { dock } = setup({ dirtyAsk: async () => false });
  const editor = dock.openView("editor", { path: "/a.ts" });
  const ref = dock.tabs("editor")[0];
  assert.ok(ref);
  dock.view(ref);
  assert.equal(await dock.closeTab(editor), false);
  assert.ok(dock.findTab(editor));
  assert.equal(await dock.closeTab(editor, true), true);
});

test("serialize keeps live view state; restore round-trips and drops unknown views", () => {
  const { dock } = setup();
  const id = dock.openView("editor", { path: "/a.ts" });
  const ref = dock.findTab(id)?.group.tabs.find((t) => t.id === id);
  assert.ok(ref);
  const view = dock.view(ref) as FakeView;
  view.state = { path: "/renamed.ts" };
  const saved = JSON.parse(JSON.stringify(dock.serialize()));
  const { dock: other } = setup();
  assert.equal(other.restore(saved), true);
  assert.deepEqual(other.tabs("editor")[0]?.viewState, { path: "/renamed.ts" });
  const unknown = {
    ...saved,
    root: {
      kind: "group",
      id: "x",
      tabs: [{ id: "t1", viewType: "nope", viewState: null }],
      activeTabId: "t1",
    },
  };
  assert.equal(other.restore(unknown), true);
  assert.deepEqual(types(other), ["welcome"], "unknown view types are dropped; welcome fills main");
  assert.equal(other.restore({ version: 99 }), false);
});

test("regions hide and restore at the same size; never hide everything", () => {
  const { dock } = setup();
  dock.setSplitSizes([0], [0.6, 0.4]);
  assert.equal(dock.toggleRegion("bottom"), true);
  assert.equal(dock.findGroup("bottom")?.hidden, true);
  assert.equal(dock.toggleRegion("bottom"), true);
  assert.notEqual(dock.findGroup("bottom")?.hidden, true);
  const column = dock.root.peek().kind === "split" ? dock.root.peek() : null;
  assert.deepEqual(
    column?.kind === "split" && column.children[0]?.kind === "split"
      ? column.children[0].sizes
      : null,
    [0.6, 0.4],
  );
  dock.setGroupsHidden(["main", "bottom", "right"], true);
  assert.ok(dock.tabs().length > 0 && dock.findGroup("main")?.hidden !== true);
});

test("split duplicates via the descriptor; maximize toggles", () => {
  const { dock } = setup();
  const id = dock.openView("editor", { path: "/a.ts" });
  const dup = dock.openView("editor", { path: "/a.ts" }, { groupId: "main", split: "right" });
  assert.notEqual(dock.findTab(id)?.group.id, dock.findTab(dup)?.group.id);
  dock.toggleMaximize(dock.findTab(dup)?.group.id);
  assert.equal(dock.maximizedGroupId(), dock.findTab(dup)?.group.id);
  dock.toggleMaximize(dock.findTab(dup)?.group.id);
  assert.equal(dock.maximizedGroupId(), null);
});

test("a maximized group takes what opens; showing a tab behind it restores the layout", () => {
  const { dock } = setup();
  const agentGroup = dock.findTab(dock.tabs("agent")[0]?.id ?? "")?.group.id;
  dock.toggleMaximize(agentGroup);
  // An editor (default placement main) opens in the maximized group, still maximized.
  const editor = dock.openView("editor", { path: "/a.ts" });
  assert.equal(dock.findTab(editor)?.group.id, agentGroup);
  assert.equal(dock.maximizedGroupId(), agentGroup);
  // A tab in another group comes forward: the layout is restored.
  const terminal = dock.tabs("terminal")[0];
  assert.ok(terminal);
  dock.activateTab(terminal.id);
  assert.equal(dock.maximizedGroupId(), null);
});

test("a file opened in the editor area while a group is maximized goes in that group (D398)", () => {
  const { dock } = setup();
  const agentGroup = dock.findTab(dock.tabs("agent")[0]?.id ?? "")?.group.id;
  dock.toggleMaximize(agentGroup);
  // As the explorer's single click: placement "main", the focus kept where it is.
  const editor = dock.openView("editor", { path: "/b.ts" }, "main", false);
  assert.equal(dock.findTab(editor)?.group.id, agentGroup);
  assert.equal(dock.maximizedGroupId(), agentGroup);
  // A named region still goes to its place.
  const panel = dock.openView("terminal", null, "bottom", true);
  assert.notEqual(dock.findTab(panel)?.group.id, agentGroup);
  assert.equal(dock.maximizedGroupId(), null);
});

test("preview tabs are replaced by the next preview and survive once pinned", () => {
  const { dock } = setup();
  const a = dock.openView("editor", { path: "/a.ts" }, "main", true, { preview: true });
  const b = dock.openView("editor", { path: "/b.ts" }, "main", true, { preview: true });
  assert.equal(dock.findTab(a), undefined, "the first preview was replaced");
  dock.pinTab(b);
  const c = dock.openView("editor", { path: "/c.ts" }, "main", true, { preview: true });
  assert.ok(dock.findTab(b) && dock.findTab(c));
  const saved = JSON.parse(JSON.stringify(dock.serialize()));
  const { dock: other } = setup();
  other.restore(saved);
  assert.equal(
    other
      .tabs("editor")
      .find((t) => t.viewState && (t.viewState as { path: string }).path === "/c.ts")?.preview,
    true,
  );
});

test("a preview replaces only previews of its own kind (D244: a channel and its thread)", () => {
  const { dock } = setup();
  const room = dock.openView("room", { room: "general" }, "right", true, { preview: true });
  const group = dock.findTab(room)?.group.id ?? "";
  const thread = dock.openView("thread", { session: "s1" }, { groupId: group }, true, {
    preview: true,
  });
  assert.ok(dock.findTab(room), "the channel stays");
  assert.ok(dock.findTab(thread));
  const next = dock.openView("thread", { session: "s2" }, { groupId: group }, true, {
    preview: true,
  });
  assert.equal(dock.findTab(thread), undefined, "a thread replaces the thread");
  assert.ok(dock.findTab(room) && dock.findTab(next));
});

test("a tab opened in the background stays behind its group's active tab (D269)", () => {
  const { dock } = setup();
  const agent = dock.tabs("agent")[0]?.id;
  const room = dock.openView("room", null, undefined, false, { background: true });
  const group = dock.regionGroups("right")[0];
  assert.deepEqual(
    group?.tabs.map((t) => t.id),
    [agent, room],
  );
  assert.equal(group?.activeTabId, agent);
  // Opened again normally: it comes forward.
  dock.openView("room", null, { groupId: group?.id ?? "" });
  assert.notEqual(dock.regionGroups("right")[0]?.activeTabId, agent);
});

test("a view whose tab left the tree some other way is disposed after the change (D379)", async () => {
  const { dock, created } = setup();
  const welcome = dock.tabs("welcome")[0];
  assert.ok(welcome);
  // A layout restored without that tab (a folder opened); a render in between made its view
  // again for the old tree.
  const saved = JSON.parse(JSON.stringify(dock.serialize()));
  dock.openView("editor", { path: "/a.ts" }, "main");
  assert.equal(dock.restore(saved), true);
  const stale = { ...welcome, id: "t999" };
  dock.view(stale);
  const view = created[created.length - 1];
  assert.equal(view?.disposed, false);
  await Promise.resolve();
  dock.openView("terminal");
  await Promise.resolve();
  assert.equal(view?.disposed, true, "its tab isn't in the tree: the view goes");
  // Views of tabs that are there stay.
  const live = dock.tabs("terminal")[0];
  assert.ok(live);
  const kept = dock.view(live);
  dock.openView("editor", { path: "/b.ts" }, "main");
  await Promise.resolve();
  assert.equal((kept as FakeView | undefined)?.disposed, false);
});
