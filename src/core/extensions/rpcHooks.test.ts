// The worker side of the `type` override, URI handlers, applyEdit, will-save listeners, the
// cursor style, multi-select quick picks, tree drops and checkboxes, comments, chat participants
// and the language model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerApi, type FromWorker, type RequestMessage, type ToWorker } from "./rpc";

function fakeHost(
  answer: (method: string, params: Record<string, unknown>) => unknown = () => null,
) {
  const sent: FromWorker[] = [];
  let deliver: (m: ToWorker) => void = () => {};
  const { api } = createWorkerApi(
    {
      post: (m) => {
        sent.push(m);
        if (m.t === "req")
          queueMicrotask(() => {
            try {
              const value = answer(m.method, m.params as Record<string, unknown>);
              deliver({ t: "res", id: m.id, ok: true, value });
            } catch (err) {
              deliver({ t: "res", id: m.id, ok: false, error: (err as Error).message });
            }
          });
      },
      onMessage: (h) => (deliver = h),
    },
    { id: "acme.x", version: "1.0.0", uriScheme: "studio" },
  );
  const requests = () => sent.filter((m): m is RequestMessage => m.t === "req");
  const tick = () => new Promise((r) => setTimeout(r, 0));
  let id = 900;
  /** Calls one of the extension's callbacks as the host does; resolves with its answer. */
  const call = async (kind: "provider" | "command", target: string, args?: unknown) => {
    const callId = ++id;
    deliver({ t: "call", id: callId, kind, target, args });
    for (let i = 0; i < 20; i++) {
      await tick();
      const res = sent.find((m) => m.t === "res" && m.id === callId);
      if (res && res.t === "res") {
        if (!res.ok) throw new Error(res.error);
        return res.value;
      }
    }
    throw new Error("no answer");
  };
  return { api, requests, tick, call };
}

test("env.uriScheme; a URI handler gets the link's parts; one per extension", async () => {
  const h = fakeHost();
  assert.equal(h.api.env.uriScheme, "studio");
  const seen: unknown[] = [];
  const handler = h.api.ui.registerUriHandler({ handleUri: (uri) => seen.push(uri.toString()) });
  assert.throws(() => h.api.ui.registerUriHandler({ handleUri: () => {} }), /already/);
  await h.call("provider", "uri.handle", {
    scheme: "studio",
    authority: "acme.x",
    path: "/open",
    query: "a=1",
    fragment: "",
    text: "studio://acme.x/open?a=1",
  });
  assert.deepEqual(seen, ["studio://acme.x/open?a=1"]);
  handler.dispose();
  assert.deepEqual(
    h
      .requests()
      .map((r) => r.method)
      .filter((m) => m.startsWith("uri.")),
    ["uri.register", "uri.unregister"],
  );
});

test("applyEdit sends the WorkspaceEdit's entries in order; a refusal resolves false", async () => {
  let refuse = false;
  const h = fakeHost((method) => {
    if (method === "workspace.applyEdit" && refuse) throw new Error("nope");
    return null;
  });
  const edit = h.api.workspace.createWorkspaceEdit();
  edit.replace("a.ts", { startLine: 1, startColumn: 1, endColumn: 4 }, "let");
  edit.insert("a.ts", { line: 2, column: 1 }, "// x\n");
  edit.createFile("b.ts", { contents: "hi", ignoreIfExists: true });
  edit.renameFile("b.ts", "c.ts");
  edit.deleteFile("old.ts", { ignoreIfNotExists: true });
  assert.equal(edit.size, 5);
  assert.equal(await h.api.workspace.applyEdit(edit), true);
  const sent = h.requests().find((r) => r.method === "workspace.applyEdit")?.params as {
    entries: { kind: string }[];
  };
  assert.deepEqual(
    sent.entries.map((e) => e.kind),
    ["text", "text", "create", "rename", "delete"],
  );
  refuse = true;
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(await h.api.workspace.applyEdit([]), false);
  } finally {
    console.error = original;
  }
});

test("onWillSaveTextDocument: waitUntil's edits go back; subscribed while there are listeners", async () => {
  const h = fakeHost();
  const late: (() => void)[] = [];
  const a = h.api.workspace.onWillSaveTextDocument((e) => {
    e.waitUntil(Promise.resolve([{ startLine: 1, text: `// ${e.languageId}` }]));
    late.push(() => e.waitUntil(Promise.resolve()));
  });
  const b = h.api.workspace.onWillSaveTextDocument((e) =>
    e.waitUntil(Promise.resolve("not edits")),
  );
  const edits = await h.call("provider", "willSave.text", {
    path: "/ws/a.ts",
    languageId: "typescript",
    reason: "manual",
  });
  assert.deepEqual(edits, [{ startLine: 1, text: "// typescript" }]);
  // Too late: the save has moved on.
  assert.throws(() => late[0]?.(), /waitUntil/);
  a.dispose();
  b.dispose();
  const subs = h.requests().filter((r) => r.method === "workspace.willSave");
  assert.deepEqual(
    subs.map((r) => r.params),
    [
      { kind: "text", on: true },
      { kind: "text", on: false },
    ],
  );
});

test("setOptions sends the cursor style; quick pick with canPickMany returns the items", async () => {
  const h = fakeHost((method) => (method === "ui.showQuickPick" ? [0, 2] : null));
  await h.api.editor.setOptions({ cursorStyle: "block" });
  const items = [{ label: "a" }, { label: "b", picked: true }, { label: "c" }];
  const picked = await h.api.ui.showQuickPick(items, { canPickMany: true });
  assert.deepEqual(picked, [items[0], items[2]]);
  const req = h.requests().find((r) => r.method === "ui.showQuickPick")?.params as {
    canPickMany: boolean;
    items: { picked?: boolean }[];
  };
  assert.equal(req.canPickMany, true);
  assert.equal(req.items[1]?.picked, true);
  assert.deepEqual(h.requests()[0]?.params, { cursorStyle: "block" });
});

test("the type override is a command handler; default:type is a command", async () => {
  const h = fakeHost();
  const typed: string[] = [];
  h.api.commands.register("type", (input) => {
    const text = (input as { text: string }).text;
    typed.push(text);
    return h.api.commands.execute("default:type", { text: text.toUpperCase() });
  });
  await h.call("command", "type", { text: "j" });
  assert.deepEqual(typed, ["j"]);
  const exec = h.requests().find((r) => r.method === "commands.execute");
  assert.deepEqual(exec?.params, { id: "default:type", input: { text: "J" } });
});

test("tree views: drops and checkbox clicks reach the provider and listeners", async () => {
  const h = fakeHost();
  const drops: unknown[] = [];
  const checks: unknown[] = [];
  const view = h.api.ui.registerTreeView("acme.x.list", {
    getChildren: () => [],
    handleDrop: (target, sources) => drops.push([target?.id, sources.map((s) => s.id)]),
  });
  view.onDidChangeCheckboxState((changes) => checks.push(changes.map((c) => c.checked)));
  assert.deepEqual(h.requests()[0]?.params, { viewId: "acme.x.list", dragAndDrop: true });
  await h.call("provider", "tree.acme.x.list.drop", {
    target: { id: "t", label: "T" },
    sources: [{ id: "a", label: "A" }],
  });
  await h.call("provider", "tree.acme.x.list.checkbox", {
    changes: [{ item: { id: "a", label: "A" }, checked: true }],
  });
  assert.deepEqual(drops, [["t", ["a"]]]);
  assert.deepEqual(checks, [[true]]);
  view.dispose();
  await h.call("provider", "tree.acme.x.list.drop", { sources: [] });
  assert.equal(drops.length, 1);
});

test("comments: threads sync once per turn, replies reach the controller's handler", async () => {
  const h = fakeHost();
  const c = h.api.comments.createCommentController("notes", "Notes");
  const replies: string[] = [];
  c.replyHandler = ({ thread, text }) => {
    replies.push(text);
    thread.comments = [...thread.comments, { body: text, author: { name: "Me" } }];
  };
  const t = c.createCommentThread("a.md", { startLine: 3 }, [
    { body: { value: "**First**" }, author: { name: "Ann" } },
  ]);
  t.collapsibleState = 1;
  t.label = "Review";
  await h.tick();
  const sets = () => h.requests().filter((r) => r.method === "comments.set");
  assert.equal(sets().length, 1);
  const first = sets()[0]?.params as { threads: Record<string, unknown>[]; label: string };
  assert.equal(first.label, "Notes");
  assert.deepEqual(first.threads[0], {
    id: t.id,
    path: "a.md",
    range: { startLine: 3 },
    comments: [{ body: "**First**", author: "Ann" }],
    collapsed: false,
    label: "Review",
    canReply: true,
  });
  await h.call("provider", "comments.notes.reply", { thread: t.id, text: "Thanks" });
  await h.tick();
  assert.deepEqual(replies, ["Thanks"]);
  const last = sets().at(-1)?.params as { threads: { comments: unknown[] }[] };
  assert.equal(last.threads[0]?.comments.length, 2);
  // A thread the user starts on a line: created, then handed to the reply handler.
  await h.call("provider", "comments.notes.create", { path: "b.md", line: 7, text: "New" });
  assert.deepEqual(replies, ["Thanks", "New"]);
  c.dispose();
  assert.ok(h.requests().some((r) => r.method === "comments.dispose"));
});

test("lm: no model while access is off; a request streams its text; chat participants answer", async () => {
  let model: unknown = null;
  const h = fakeHost((method) => (method === "lm.model" ? model : null));
  assert.deepEqual(await h.api.lm.selectChatModels(), []);
  model = { id: "ollama/qwen", name: "qwen", family: "qwen" };
  const [chat] = await h.api.lm.selectChatModels({ vendor: "ide" });
  assert.ok(chat);
  const response = await chat.sendRequest([
    h.api.lm.LanguageModelChatMessage.User("Hi"),
    { role: 2, content: "Hello" },
  ]);
  const sent = h.requests().find((r) => r.method === "lm.sendRequest")?.params as {
    requestId: string;
    messages: unknown[];
  };
  assert.deepEqual(sent.messages, [
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello" },
  ]);
  await h.call("provider", "lm.chunk", { requestId: sent.requestId, text: "A" });
  await h.call("provider", "lm.chunk", { requestId: sent.requestId, text: "B" });
  await h.call("provider", "lm.end", { requestId: sent.requestId });
  let text = "";
  for await (const part of response.text) text += part;
  assert.equal(text, "AB");

  const participant = h.api.chat.createChatParticipant("acme.x.helper", (request, _c, stream) => {
    stream.markdown(`You asked: ${request.prompt}`);
    stream.progress("thinking");
  });
  assert.equal(participant.name, "helper");
  const answer = (await h.call("provider", "chat.acme.x.helper.request", {
    prompt: "why",
  })) as { markdown: string };
  assert.match(answer.markdown, /^You asked: why\n_thinking_/);
  participant.dispose();
  assert.ok(h.requests().some((r) => r.method === "chat.unregister"));
});
