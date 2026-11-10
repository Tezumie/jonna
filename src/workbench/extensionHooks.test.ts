import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CommentThreadEntry,
  ExtensionHooks,
  lensesFor,
  lineInRanges,
  parseIdeUri,
  promptOf,
  threadMarkdown,
  threadSummary,
  toCursorStyle,
} from "./extensionHooks";

test("typing: one owner at a time; release gives it back and resets its cursor", () => {
  const hooks = new ExtensionHooks();
  const vim = { owner: "acme.vim", name: "Vim", type: async () => {} };
  const claim = hooks.claimTyping(vim);
  assert.throws(
    () => hooks.claimTyping({ owner: "acme.emacs", name: "Emacs", type: async () => {} }),
    /Vim already handles typing/,
  );
  // The same extension again (a reload) takes it over.
  hooks.claimTyping({ ...vim });
  hooks.setCursorStyle("acme.vim", "block");
  assert.equal(hooks.releaseTyping()?.owner, "acme.vim");
  assert.equal(hooks.typeOwner.peek(), null);
  assert.equal(hooks.cursorStyle.peek(), null);
  claim.dispose();
  assert.equal(hooks.typeOwner.peek(), null);
});

test("cursor styles: names, VS Code's numbers and camel case", () => {
  assert.equal(toCursorStyle("block"), "block");
  assert.equal(toCursorStyle(2), "block");
  assert.equal(toCursorStyle("BlockOutline"), "block-outline");
  assert.equal(toCursorStyle("beam"), null);
  assert.equal(toCursorStyle(9), null);
  const hooks = new ExtensionHooks();
  hooks.setCursorStyle("a", "underline");
  hooks.setCursorStyle("b", null);
  assert.equal(hooks.cursorStyle.peek()?.owner, "a");
});

test("will-save: in order, each sees the last's edits, a slow one is skipped", async () => {
  const hooks = new ExtensionHooks();
  const applied: string[] = [];
  hooks.addWillSave({
    owner: "a",
    kind: "text",
    run: async () => [{ startLine: 1, text: "a" }],
  });
  const slow = hooks.addWillSave({
    owner: "slow",
    kind: "text",
    run: () => new Promise(() => {}),
  });
  hooks.addWillSave({ owner: "nb", kind: "notebook", run: async () => [] });
  hooks.addWillSave({
    owner: "b",
    kind: "text",
    run: async () => {
      throw new Error("broken");
    },
  });
  const started = Date.now();
  await hooks.runWillSave(
    "text",
    { path: "/ws/a.ts", languageId: "typescript", reason: "manual" },
    (edits, owner) => {
      applied.push(`${owner}:${edits.length}`);
    },
    30,
  );
  assert.deepEqual(applied, ["a:1"]);
  assert.ok(Date.now() - started < 1000);
  slow.dispose();
  assert.ok(hooks.hasWillSave("notebook"));
});

test("URIs: the IDE's scheme and an extension id; the query stays encoded", () => {
  const uri = parseIdeUri("studio://Acme.Todo/open/a%20b?x=1%262#top", "studio");
  assert.deepEqual(uri, {
    scheme: "studio",
    authority: "acme.todo",
    path: "/open/a b",
    query: "x=1%262",
    fragment: "top",
    text: "studio://Acme.Todo/open/a%20b?x=1%262#top",
  });
  assert.equal(parseIdeUri("vscode://acme.todo/x", "studio"), null);
  assert.equal(parseIdeUri("studio://notanid/x", "studio"), null);
  assert.equal(parseIdeUri("studio://acme.todo", "studio")?.path, "/");
});

test("openUri: waits for the extension to register (activation), else false", async () => {
  const hooks = new ExtensionHooks();
  const got: string[] = [];
  hooks.onWillNeedUriHandler((id) => {
    if (id === "acme.todo")
      setTimeout(() => {
        hooks.registerUriHandler({
          owner: "acme.todo",
          handle: async (u) => void got.push(u.path),
        });
      }, 5);
  });
  const uri = parseIdeUri("studio://acme.todo/go", "studio");
  assert.ok(uri);
  assert.equal(await hooks.openUri(uri, 500), true);
  assert.deepEqual(got, ["/go"]);
  assert.throws(
    () => hooks.registerUriHandler({ owner: "acme.todo", handle: async () => {} }),
    /already/,
  );
  const other = parseIdeUri("studio://acme.none/go", "studio");
  assert.ok(other);
  assert.equal(await hooks.openUri(other, 20), false);
});

test("comment threads: per controller, summaries, Markdown, commenting ranges", () => {
  const hooks = new ExtensionHooks();
  const thread = (id: string, comments: { body: string; author: string }[], collapsed = false) =>
    ({
      owner: "acme.notes",
      controller: "c",
      controllerLabel: "Notes",
      id,
      path: "/ws/a.md",
      range: { startLine: 2 },
      comments,
      collapsed,
      canReply: true,
    }) satisfies CommentThreadEntry;
  const t1 = thread("t1", [
    { body: "First line\nmore", author: "Ann" },
    { body: "\nSecond", author: "Bo" },
  ]);
  hooks.setThreads("acme.notes", "c", [t1, thread("t2", [], true)]);
  hooks.setThreads("acme.notes", "d", [{ ...thread("t3", []), controller: "d" }]);
  assert.equal(hooks.commentThreads.peek().length, 3);
  assert.equal(hooks.findThread("acme.notes/c/t1"), hooks.commentThreads.peek()[0]);
  assert.equal(threadSummary(t1), "Bo: Second (2 comments)");
  assert.equal(threadSummary({ ...t1, collapsed: true }), "2 comments");
  assert.match(threadMarkdown(t1), /^\*\*Notes\*\*\n\n\*\*Ann\*\*: First line/);
  hooks.clearThreads("acme.notes", "c");
  assert.deepEqual(
    hooks.commentThreads.peek().map((t) => t.id),
    ["t3"],
  );
  hooks.clearThreads("acme.notes");
  assert.equal(hooks.commentThreads.peek().length, 0);
  assert.ok(lineInRanges(3, [{ startLine: 1, endLine: 4 }]));
  assert.ok(!lineInRanges(5, [{ startLine: 1, endLine: 4 }, { startLine: 6 }]));
});

test("chat participants: names are unique", () => {
  const hooks = new ExtensionHooks();
  const request = async () => ({ markdown: "" });
  const a = hooks.addChatParticipant({ owner: "x", id: "x.a", name: "Helper", request });
  assert.throws(
    () => hooks.addChatParticipant({ owner: "y", id: "y.a", name: "helper", request }),
    /@helper/,
  );
  a.dispose();
  assert.equal(hooks.chatParticipants.peek().length, 0);
});

test("comment lenses: the thread's summary opens it; Reply only when it takes replies", () => {
  const base: CommentThreadEntry = {
    owner: "acme.notes",
    controller: "c",
    controllerLabel: "Notes",
    id: "t1",
    path: "/ws/a.md",
    range: { startLine: 4, endLine: 6 },
    comments: [{ body: "Looks good", author: "Ann" }],
    collapsed: false,
    canReply: true,
  };
  const lenses = lensesFor([base, { ...base, id: "t2", path: "/ws/b.md" }], "/WS/a.md");
  assert.deepEqual(lenses, [
    {
      range: { startLine: 4 },
      title: "Ann: Looks good",
      command: { id: "extensions.showCommentThread", input: { thread: "acme.notes/c/t1" } },
    },
    {
      range: { startLine: 4 },
      title: "Reply",
      command: { id: "extensions.replyToComment", input: { thread: "acme.notes/c/t1" } },
    },
  ]);
  assert.equal(lensesFor([{ ...base, canReply: false }], base.path).length, 1);
});

test("a language model request's messages as one prompt", () => {
  assert.equal(promptOf([{ role: "user", content: "Hi" }]), "Hi");
  assert.equal(
    promptOf([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "More" },
    ]),
    "User: Hi\n\nAssistant: Hello\n\nUser: More",
  );
});
