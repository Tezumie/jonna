import assert from "node:assert/strict";
import { test } from "node:test";
import { NeedsScreenError } from "../core/dispatcher/screen";
import type { TrustFolderRequest } from "../workbench/trust";
import {
  HeadlessNotifications,
  HeadlessQuickInput,
  HeadlessStatusBar,
  HeadlessTheme,
  noAuxWindows,
  noIframes,
  policyTrustPrompts,
} from "./services";

/** Lets the microtasks the services queue (a notice's close, a session's hide) run. */
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("notifications: kept as history and told as events instead of shown", async () => {
  const notifications = new HeadlessNotifications();
  const told: string[] = [];
  notifications.onDidShow((n) => told.push(`${n.kind}: ${n.message}`));
  notifications.show("info", "Saved.");
  notifications.show("error", "It failed.", { title: "Build" });
  assert.deepEqual(told, ["info: Saved.", "error: It failed."]);
  const history = notifications.history.peek();
  assert.deepEqual(
    history.map((n) => [n.kind, n.message, n.title]),
    [
      ["error", "It failed.", "Build"],
      ["info", "Saved.", undefined],
    ],
  );
  assert.equal(notifications.unread.peek(), 2);
  notifications.markRead();
  assert.equal(notifications.unread.peek(), 0);
  // The same notice again is one entry with a count, as in the window's list.
  notifications.show("error", "It failed.", { title: "Build" });
  assert.equal(notifications.history.peek().length, 2);
  assert.equal(notifications.history.peek()[0]?.count, 2);
  notifications.clearHistory();
  assert.deepEqual(notifications.history.peek(), []);
  await settled();
});

test("notifications: a notice with buttons is closed unanswered, or answered by the policy", async () => {
  const closed: string[] = [];
  const ran: string[] = [];
  const unanswered = new HeadlessNotifications();
  unanswered.show("info", "Install the recommended extension?", {
    actions: [
      { label: "Install", run: () => ran.push("install") },
      { label: "Not now", run: () => ran.push("not now") },
    ],
    onClose: () => closed.push("closed"),
  });
  assert.deepEqual(unanswered.history.peek()[0]?.choices, ["Install", "Not now"]);
  await settled();
  assert.deepEqual([closed, ran], [["closed"], []]);

  const answered = new HeadlessNotifications({
    choose: (notice) => (notice.choices.includes("Not now") ? "Not now" : undefined),
  });
  answered.show("info", "Install the recommended extension?", {
    actions: [
      { label: "Install", run: () => ran.push("install") },
      { label: "Not now", run: () => ran.push("not now") },
    ],
    onClose: () => closed.push("closed again"),
  });
  await settled();
  assert.deepEqual([closed, ran], [["closed"], ["not now"]]);
  assert.equal(answered.history.peek()[0]?.chosen, "Not now");
});

test("notifications: work under way is listed while it runs", () => {
  const notifications = new HeadlessNotifications();
  let cancelled = false;
  const work = notifications.progress("Indexing…", {
    title: "Search",
    onCancel: () => (cancelled = true),
  });
  work.update("Indexing 40 files", 250);
  const [entry] = notifications.activeProgress.peek();
  assert.deepEqual(
    [entry?.message, entry?.title, entry?.percent],
    ["Indexing 40 files", "Search", 100],
  );
  entry?.cancel?.();
  assert.equal(cancelled, true);
  work.close();
  assert.deepEqual(notifications.activeProgress.peek(), []);
  // Progress isn't news: it never enters the history.
  assert.deepEqual(notifications.history.peek(), []);
});

test("quick input: without a policy every question is refused, by name", async () => {
  const quickInput = new HeadlessQuickInput();
  await assert.rejects(
    quickInput.pick([{ id: "a", label: "A" }], { placeholder: "Select the task to run" }),
    (err: unknown) =>
      err instanceof NeedsScreenError && /Select the task to run.*needs a screen/.test(err.message),
  );
  await assert.rejects(quickInput.prompt({ prompt: "New file name" }), NeedsScreenError);
  await assert.rejects(
    quickInput.pickDynamic({
      placeholder: "Search files by name",
      load: async () => ({ items: [] }),
    }),
    NeedsScreenError,
  );
  assert.deepEqual(
    quickInput.asked.map((q) => (q.kind === "pick" ? q.placeholder : q.options.prompt)),
    ["Select the task to run", "New file name", "Search files by name"],
  );
  assert.equal(quickInput.visible.peek(), false);
  assert.equal(quickInput.moveActive(), false);
});

test("quick input: a policy chooses an item, cancels, or enters text", async () => {
  const quickInput = new HeadlessQuickInput({
    pick: ({ placeholder, items }) =>
      placeholder === "Cancel me" ? undefined : (items.find((i) => i.label === "Build")?.id ?? "?"),
    prompt: (options) => (options.prompt === "Name" ? "notes.md" : ""),
  });
  const items = [
    { id: "test", label: "Test" },
    { id: "build", label: "Build" },
  ];
  assert.deepEqual(await quickInput.pick(items, { placeholder: "Task" }), items[1]);
  assert.equal(await quickInput.pick(items, { placeholder: "Cancel me" }), undefined);
  // An answer that isn't in the list is a mistake in the policy, not a cancel.
  await assert.rejects(
    quickInput.pick([{ id: "x", label: "X" }], { placeholder: "Other" }),
    /not in the list/,
  );
  await assert.rejects(
    quickInput.pick([{ id: "build", label: "Build", disabled: true }], { placeholder: "Off" }),
    /can't be chosen/,
  );
  assert.deepEqual(
    await quickInput.pickDynamic({
      placeholder: "Files",
      value: "bu",
      load: async (query) => ({ items: query === "bu" ? items : [] }),
    }),
    items[1],
  );
  assert.equal(await quickInput.prompt({ prompt: "Name" }), "notes.md");
  // The box's own check still applies to a policy's answer.
  await assert.rejects(
    quickInput.prompt({ prompt: "Port", validate: (v) => (v ? undefined : "Enter a number") }),
    /Enter a number/,
  );
});

test("quick input: a session an extension opens is dismissed at once, once", async () => {
  const quickInput = new HeadlessQuickInput();
  let hidden = 0;
  const session = quickInput.openSession(
    "pick",
    { items: [] } as never,
    { hide: () => hidden++ } as never,
  );
  await settled();
  session.hide();
  assert.equal(hidden, 1);
});

test("trust without dialogs: everything is declined unless the policy says otherwise", async () => {
  const request: TrustFolderRequest = {
    root: "/ws",
    folders: [{ name: "ws", path: "/ws" }],
    workspaceName: "ws",
    what: "Task “build”",
    signal: new AbortController().signal,
  };
  const declined = policyTrustPrompts();
  assert.deepEqual(await declined.folder(request), { answer: "cancel", trustParent: false });
  assert.equal(await declined.addFolders(["/other"]), "cancel");
  assert.equal(await declined.confirmAdd(["/other"], "file"), false);

  const fixed = policyTrustPrompts({ folder: "trust", addFolders: "restrict", confirmAdd: true });
  assert.deepEqual(await fixed.folder(request), { answer: "trust", trustParent: false });
  assert.equal(await fixed.addFolders(["/other"]), "restrict");
  assert.equal(await fixed.confirmAdd(["/other"], "network"), true);

  const perFolder = policyTrustPrompts({
    folder: (r) => (r.root.startsWith("/home/me/") ? "trust" : "restrict"),
  });
  assert.equal((await perFolder.folder(request)).answer, "restrict");
  assert.equal((await perFolder.folder({ ...request, root: "/home/me/app" })).answer, "trust");
});

test("status bar: items are listed, not drawn", () => {
  const statusBar = new HeadlessStatusBar();
  const item = { id: "git.branch", alignment: "left" as const, priority: 90, text: () => "main" };
  const added = statusBar.add(item);
  assert.deepEqual(
    statusBar.items.peek().map((i) => [i.id, i.text()]),
    [["git.branch", "main"]],
  );
  added.dispose();
  assert.deepEqual(statusBar.items.peek(), []);
});

test("theme: the look is held; colors are a page's to resolve", () => {
  const theme = new HeadlessTheme();
  let changes = 0;
  theme.onDidChange(() => changes++);
  theme.apply({ theme: "light", density: "compact" });
  assert.deepEqual(
    [theme.theme.peek(), theme.density.peek(), theme.preferences.panels],
    ["light", "compact", "flush"],
  );
  theme.apply({ theme: "light" });
  theme.setOverrides({ "--accent": "#3366ff" });
  assert.equal(changes, 2);
  assert.equal(theme.token("--accent"), "#3366ff");
  assert.equal(theme.token("--bg-surface"), "");
  assert.equal(theme.color(), null);
});

test("what only a window has is refused clearly", async () => {
  assert.equal(noAuxWindows.labelOf({} as Window), null);
  await assert.rejects(noAuxWindows.create({ title: "Chat" }), NeedsScreenError);
  assert.throws(
    () => noIframes.attach({} as HTMLElement, {} as HTMLIFrameElement),
    NeedsScreenError,
  );
});
