import assert from "node:assert/strict";
import { test } from "node:test";
import { NeedsScreenError } from "../core/dispatcher/screen";
import { PersistenceService, type StateBackend } from "../workbench/persistence";
import type { TrustFolderRequest } from "../workbench/trust";
import {
  HeadlessNotifications,
  HeadlessQuickInput,
  HeadlessStatusBar,
  HeadlessTheme,
  keepWindowKeys,
  noAuxWindows,
  noIframes,
  policyTrustPrompts,
  screenlessStateBackend,
  WINDOW_GLOBAL_KEYS,
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

test("saved state: the window's own keys of the global state stay as the file has them", () => {
  const stored = JSON.stringify({
    version: 3,
    lastFolder: "/app/project",
    recentFolders: ["/app/project", "/other"],
    recentCommands: ["a.b"],
    trusted: ["/app/project"],
  });
  const next = JSON.stringify({
    version: 3,
    // What this session's workspace service would write for the folder it opened.
    lastFolder: "/scratch/run",
    recentFolders: ["/scratch/run", "/app/project", "/other"],
    pinnedFolders: ["/scratch/run"],
    trusted: ["/app/project", "/scratch/run"],
    acpSettings: { agent: { model: "fast" } },
  });
  assert.deepEqual(JSON.parse(keepWindowKeys(next, stored) ?? "null"), {
    version: 3,
    lastFolder: "/app/project",
    recentFolders: ["/app/project", "/other"],
    recentCommands: ["a.b"],
    // Shared decisions are saved as the window saves them.
    trusted: ["/app/project", "/scratch/run"],
    acpSettings: { agent: { model: "fast" } },
  });
  // No file yet: the window's keys are left out rather than invented.
  assert.deepEqual(JSON.parse(keepWindowKeys(next, null) ?? "null"), {
    version: 3,
    trusted: ["/app/project", "/scratch/run"],
    acpSettings: { agent: { model: "fast" } },
  });
  // Every key named is one the window owns.
  assert.ok(WINDOW_GLOBAL_KEYS.includes("lastFolder"));
  // Text that isn't JSON goes through untouched (the store's own problem to report).
  assert.equal(keepWindowKeys("not json", stored), "not json");
  // An empty file is no file.
  assert.equal(keepWindowKeys(next, ""), keepWindowKeys(next, null));
  // A stored text that can't be read says nothing about the window's keys: no answer, rather
  // than one without them.
  assert.equal(keepWindowKeys(next, '{"lastFolder": "/app/pro'), null);
  assert.equal(keepWindowKeys(next, "[1, 2]"), null);
});

/** The backend's state files, with reads that can be made to fail. */
function stateFiles(global: string | null) {
  const files: { global: string | null; workspace: string | null } = { global, workspace: "{}" };
  const calls = { loads: 0, saves: 0, pauses: 0 };
  let failing = 0;
  const store: StateBackend = {
    load: async (scope) => {
      calls.loads++;
      if (scope === "global" && failing-- > 0) throw new Error("sharing violation");
      return files[scope];
    },
    save: async (scope, json) => {
      calls.saves++;
      files[scope] = json;
    },
  };
  const backend = screenlessStateBackend(store, async () => {
    calls.pauses++;
  });
  return {
    files,
    calls,
    backend,
    /** The next `count` reads of the global state fail (the file is locked). */
    failLoads: (count: number) => {
      failing = count;
    },
    saved: () => JSON.parse(files.global ?? "null") as Record<string, unknown> | null,
  };
}

const windowState = JSON.stringify({
  version: 3,
  lastFolder: "/app/project",
  recentFolders: ["/app/project"],
  ui: { theme: "light" },
  trust: { "/app/project": true },
});
const sessionState = JSON.stringify({
  version: 3,
  lastFolder: "/scratch/run",
  trust: { "/app/project": true, "/scratch/run": true },
});

test("saved state: a global write keeps the window's keys, and the workspace's is never written", async () => {
  const disk = stateFiles(windowState);
  await disk.backend.save("workspace", '{"dock":1}');
  assert.equal(disk.files.workspace, "{}");
  assert.equal(disk.calls.saves, 0);
  await disk.backend.save("global", sessionState);
  assert.deepEqual(disk.saved(), {
    version: 3,
    lastFolder: "/app/project",
    recentFolders: ["/app/project"],
    ui: { theme: "light" },
    trust: { "/app/project": true, "/scratch/run": true },
  });
});

test("saved state: a file that isn't there yet is written, without the window's keys", async () => {
  for (const nothing of [null, ""]) {
    const disk = stateFiles(nothing);
    await disk.backend.save("global", sessionState);
    assert.deepEqual(disk.saved(), {
      version: 3,
      trust: { "/app/project": true, "/scratch/run": true },
    });
  }
});

test("saved state: a read that fails is tried again, and is never taken for no file", async () => {
  // Locked for a moment (the app is replacing the file): the next read has it.
  const brief = stateFiles(windowState);
  brief.failLoads(2);
  await brief.backend.save("global", sessionState);
  assert.equal(brief.calls.pauses, 2);
  assert.equal(brief.saved()?.lastFolder, "/app/project");
  assert.deepEqual(brief.saved()?.ui, { theme: "light" });

  // Still unreadable: nothing is written, and the caller hears why.
  const locked = stateFiles(windowState);
  locked.failLoads(100);
  await assert.rejects(locked.backend.save("global", sessionState), /could not be read/);
  assert.equal(locked.calls.saves, 0);
  assert.equal(locked.files.global, windowState);
});

test("saved state: a stored text that isn't a state file is left alone", async () => {
  const cut = '{"version":3,"lastFolder":"/app/pro';
  const disk = stateFiles(cut);
  await assert.rejects(disk.backend.save("global", sessionState), /not readable JSON/);
  assert.equal(disk.calls.saves, 0);
  assert.equal(disk.files.global, cut);
});

test("saved state: the persistence service goes on after a refused write", async () => {
  const disk = stateFiles(windowState);
  const persistence = new PersistenceService(disk.backend);
  await persistence.loadGlobal();
  disk.failLoads(100);
  const warn = console.warn;
  console.warn = () => {};
  try {
    // Never thrown at the caller: reported to who asks.
    assert.equal(await persistence.saveGlobalChecked({ lastPreset: "review" }), false);
  } finally {
    console.warn = warn;
  }
  assert.equal(disk.files.global, windowState);
  disk.failLoads(0);
  assert.equal(await persistence.saveGlobalChecked({ lastPreset: "review" }), true);
  assert.equal(disk.saved()?.lastFolder, "/app/project");
  assert.equal(disk.saved()?.lastPreset, "review");
  persistence.dispose();
});
