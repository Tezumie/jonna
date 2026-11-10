import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatEvent, ChatMessage, ToolSpec } from "../ipc/agent";
import { type Item, toMessages } from "./conversation";
import {
  callGroups,
  inParallel,
  type LoopDeps,
  type LoopState,
  NoToolsError,
  runTurn,
  VisibleText,
} from "./loop";

const tools: ToolSpec[] = [
  { name: "read_file", description: "Read", parameters: { type: "object" } },
];

function deps(
  script: ((
    req: { messages: ChatMessage[]; tools: ToolSpec[] },
    emit: (e: ChatEvent) => void,
  ) => void)[],
) {
  const seen: { messages: ChatMessage[]; tools: ToolSpec[] }[] = [];
  let n = 0;
  const d: LoopDeps = {
    system: () => "SYS",
    tools: () => tools,
    chat: async (req, emit) => {
      seen.push(req);
      const step = script.shift();
      if (!step) throw new Error("no more steps");
      step(req, emit);
    },
    execute: async (call) => ({
      result: `contents of ${(call.arguments as { path: string }).path}`,
      summary: "3 lines",
    }),
    update: () => {},
    newId: () => `id${++n}`,
    cancelled: () => false,
    budgetChars: 100000,
    maxSteps: 5,
  };
  return { d, seen };
}

test("native tool calls loop until the model answers", async () => {
  const { d, seen } = deps([
    (_r, emit) => {
      emit({ kind: "thinking", text: "need file" });
      emit({ kind: "toolCall", id: "c1", name: "read_file", arguments: { path: "a.ts" } });
      emit({ kind: "done", stopReason: "stop", inputTokens: 1, outputTokens: 1 });
    },
    (_r, emit) => emit({ kind: "text", text: "It exports x." }),
  ]);
  const state: LoopState = {
    items: [{ type: "user", id: "u", text: "what is in a.ts?" }],
    textProtocol: false,
  };
  assert.equal(await runTurn(state, d), 2);
  assert.deepEqual(
    state.items.map((i) => i.type),
    ["user", "assistant", "tool", "assistant"],
  );
  const second = seen[1]?.messages ?? [];
  assert.deepEqual(
    second.map((m) => m.role),
    ["system", "user", "assistant", "tool"],
  );
  assert.equal(second[2]?.toolCalls?.[0]?.name, "read_file");
  assert.equal(second[3]?.content, "contents of a.ts");
  assert.equal(second[3]?.toolCallId, "c1");
});

test("a group member's earlier steps in its turn are its own, not the main agent's", async () => {
  const { d, seen } = deps([
    (_r, emit) => {
      emit({ kind: "text", text: "Looking." });
      emit({ kind: "toolCall", id: "c1", name: "read_file", arguments: { path: "a.ts" } });
    },
    (_r, emit) => emit({ kind: "text", text: "[Agent] Fine." }),
  ]);
  d.speakerLabels = () => ({ current: "rev", label: (n) => (n === "rev" ? "Rev" : "Agent") });
  const state: LoopState = {
    items: [{ type: "user", id: "u", text: "@rev ok?" }],
    textProtocol: false,
  };
  await runTurn(state, d);
  const second = seen[1]?.messages ?? [];
  // Its own step, labelled as its (D253: every member's are), not the main agent's.
  assert.equal(second[2]?.content, "[Rev] Looking.");
  const replies = state.items.filter((i) => i.type === "assistant");
  assert.deepEqual(
    replies.map((r) => r.type === "assistant" && [r.speaker, r.text]),
    [
      ["rev", "Looking."],
      ["rev", "Fine."],
    ],
  );
});

test("falls back to the text protocol when the model has no tool support", async () => {
  const { d, seen } = deps([
    () => {
      throw new NoToolsError("qwen does not support tools");
    },
    (_r, emit) =>
      emit({
        kind: "text",
        text: 'Reading.\n<tool_call>{"name":"read_file","arguments":{"path":"b.ts"}}</tool_call>',
      }),
    (_r, emit) => emit({ kind: "text", text: "Done." }),
  ]);
  const state: LoopState = { items: [{ type: "user", id: "u", text: "hi" }], textProtocol: false };
  await runTurn(state, d);
  assert.equal(state.textProtocol, true);
  assert.ok(seen[1]?.messages[0]?.content.includes("<tool_call>"));
  assert.equal(seen[1]?.tools.length, 0);
  const last = seen[2]?.messages ?? [];
  assert.equal(last[last.length - 1]?.role, "user");
  assert.ok(last[last.length - 1]?.content.includes('<tool_result name="read_file">'));
  const visible = state.items.find((i) => i.type === "assistant");
  assert.ok(visible?.type === "assistant" && visible.text === "Reading.");
});

test("old tool output is shortened and early turns dropped to fit the budget", () => {
  const big = "x".repeat(5000);
  const items = [
    { type: "user" as const, id: "1", text: "first" },
    { type: "assistant" as const, id: "2", text: "", thinking: "", streaming: false },
    {
      type: "tool" as const,
      id: "3",
      callId: "c",
      name: "read_file",
      args: {},
      status: "done" as const,
      result: big,
    },
    { type: "user" as const, id: "4", text: "second" },
    { type: "user" as const, id: "5", text: "third" },
  ];
  const short = toMessages(items, { textProtocol: false, budgetChars: 2000 });
  const tool = short.find((m) => m.role === "tool");
  assert.ok(tool && tool.content.length < 1000 && tool.content.includes("omitted"));
  const tiny = toMessages(items, { textProtocol: false, budgetChars: 30 });
  assert.deepEqual(
    tiny.map((m) => m.content),
    ["first", "second", "third"],
  );
});

test("transient provider errors are retried, others are not", async () => {
  const { isTransientError, shortError } = await import("./loop");
  for (const m of [
    "Provider returned error (502)",
    "429 Too Many Requests: rate limit",
    "overloaded_error",
    "error sending request: connection reset",
    "Model is busy, try again later",
  ])
    assert.equal(isTransientError(m), true, m);
  for (const m of [
    "401 Unauthorized",
    "invalid api key",
    "model not found (404)",
    "does not support tools",
  ])
    assert.equal(isTransientError(m), false, m);
  assert.equal(shortError("a\nb"), "a");
});

test("the first reply's <title> names the chat and never shows (D124)", async () => {
  const { d, seen } = deps([
    (_r, emit) => {
      for (const piece of [
        "<ti",
        "tle>Snake game",
        " in Python</title>",
        "\n",
        "Here is the plan.",
      ])
        emit({ kind: "text", text: piece });
    },
  ]);
  const titles: string[] = [];
  const shown: string[] = [];
  const state: LoopState = {
    items: [{ type: "user", id: "u", text: "make a snake game", askTitle: true }],
    textProtocol: false,
  };
  d.title = { wanted: () => true, set: (t) => titles.push(t) };
  d.update = () => {
    const last = state.items[state.items.length - 1];
    if (last?.type === "assistant") shown.push(last.text);
  };
  await runTurn(state, d);
  assert.deepEqual(titles, ["Snake game in Python"]);
  assert.ok(
    shown.every((t) => !t.includes("<")),
    shown.join(" | "),
  );
  const last = state.items[state.items.length - 1];
  assert.equal(last?.type === "assistant" && last.text, "Here is the plan.");
  // The request rides on the first user message.
  assert.match(String(seen[0]?.messages[1]?.content), /<title>/);
});

test("VisibleText hides <tool_call> blocks incrementally, like the full-text regex", () => {
  const full = (raw: string) => raw.replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, "").trim();
  const pieces = [
    "Hi ",
    "<tool_call>",
    "{}",
    "</tool_call>",
    " there",
    "<",
    "/",
    "tool_call>",
    "x",
  ];
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let round = 0; round < 200; round++) {
    let text = "";
    for (let i = 0; i < 12; i++) text += pieces[rand(pieces.length)];
    const visible = new VisibleText();
    let raw = "";
    // Feed it in random chunks, so tags get split across deltas.
    for (let at = 0; at < text.length; ) {
      const next = Math.min(text.length, at + 1 + rand(6));
      raw += text.slice(at, next);
      at = next;
      assert.equal(visible.update(raw), full(raw), JSON.stringify(raw));
    }
  }
  const visible = new VisibleText();
  visible.update("abc <tool_call>x");
  visible.reset();
  assert.equal(visible.update("new"), "new");
});

test("a message sent while the agent works joins at the next step (D151)", async () => {
  const queue: Item[] = [];
  const { d, seen } = deps([
    (_r, emit) => {
      // The user writes while this step runs.
      queue.push({ type: "user", id: "q1", text: "also check b.ts", steer: true });
      emit({ kind: "toolCall", id: "c1", name: "read_file", arguments: { path: "a.ts" } });
    },
    (_r, emit) => emit({ kind: "text", text: "Done with a.ts." }),
    (_r, emit) => emit({ kind: "text", text: "never" }),
  ]);
  d.takeQueued = () => queue.splice(0);
  d.hasQueued = () => queue.length > 0;
  const state: LoopState = {
    items: [{ type: "user", id: "u", text: "read a.ts" }],
    textProtocol: false,
  };
  await runTurn(state, d);
  assert.deepEqual(
    state.items.map((i) => i.id),
    ["u", "id1", "id2", "q1", "id3"],
  );
  const sent = seen[1]?.messages.at(-1);
  assert.equal(sent?.role, "user");
  assert.ok(sent?.content.includes("also check b.ts"));
  assert.ok(sent?.content.includes("while you were working"));

  // Arriving as the model answers: the turn goes on to answer it instead of ending.
  const late: Item[] = [];
  const { d: d2 } = deps([
    (_r, emit) => {
      late.push({ type: "user", id: "q2", text: "and thanks", steer: true });
      emit({ kind: "text", text: "All done." });
    },
    (_r, emit) => emit({ kind: "text", text: "You're welcome." }),
  ]);
  d2.takeQueued = () => late.splice(0);
  d2.hasQueued = () => late.length > 0;
  const s2: LoopState = { items: [{ type: "user", id: "u", text: "go" }], textProtocol: false };
  assert.equal(await runTurn(s2, d2), 2);
  assert.deepEqual(
    s2.items.map((i) => i.type),
    ["user", "assistant", "user", "assistant"],
  );
});

test("Send now cuts the reply or the tools short and the next step reads the message (D363)", async () => {
  // While the reply is written: the request is cancelled, what was written stays.
  const queue: Item[] = [];
  let interrupt = false;
  const phases: (string | null)[] = [];
  const { d, seen } = deps([
    (_r, emit) => {
      emit({ kind: "text", text: "Writing a long plan" });
      queue.push({ type: "user", id: "q1", text: "stop, use b.ts", steer: true });
      interrupt = true;
      throw new Error("Cancelled");
    },
    (_r, emit) => emit({ kind: "text", text: "Using b.ts." }),
  ]);
  d.takeQueued = () => queue.splice(0);
  d.hasQueued = () => queue.length > 0;
  d.interrupt = {
    requested: () => interrupt,
    clear: () => {
      interrupt = false;
    },
    phase: (p) => phases.push(p),
  };
  const state: LoopState = { items: [{ type: "user", id: "u", text: "go" }], textProtocol: false };
  assert.equal(await runTurn(state, d), 2);
  const cut = state.items[1];
  assert.equal(cut?.type === "assistant" && cut.text, "Writing a long plan");
  assert.equal(cut?.type === "assistant" && cut.streaming, false);
  assert.ok(seen[1]?.messages.at(-1)?.content.includes("stop, use b.ts"));
  assert.deepEqual(phases.slice(0, 2), ["model", null]);

  // While tools run: the ones left don't run, and none after.
  const q2: Item[] = [];
  let int2 = false;
  const ran: string[] = [];
  const { d: d2 } = deps([
    (_r, emit) => {
      emit({ kind: "toolCall", id: "c1", name: "write_file", arguments: { path: "a.ts" } });
      emit({ kind: "toolCall", id: "c2", name: "write_file", arguments: { path: "b.ts" } });
    },
    (_r, emit) => emit({ kind: "text", text: "Ok." }),
  ]);
  d2.execute = async (call) => {
    const path = (call.arguments as { path: string }).path;
    ran.push(path);
    q2.push({ type: "user", id: "q2", text: "wait", steer: true });
    int2 = true;
    return { result: "cancelled", summary: "" };
  };
  d2.takeQueued = () => q2.splice(0);
  d2.hasQueued = () => q2.length > 0;
  d2.interrupt = {
    requested: () => int2,
    clear: () => {
      int2 = false;
    },
    phase: () => {},
  };
  const s2: LoopState = { items: [{ type: "user", id: "u", text: "go" }], textProtocol: false };
  assert.equal(await runTurn(s2, d2), 2);
  assert.deepEqual(ran, ["a.ts"]);
  assert.deepEqual(
    s2.items.map((i) => i.type),
    ["user", "assistant", "tool", "user", "assistant"],
  );
});

test("an echoed <ide_state> block never shows in the reply", async () => {
  const { d } = deps([
    (_r, emit) => {
      emit({ kind: "text", text: "<ide_state>\nActive editor: a.ts\n</ide_state>\n" });
      emit({ kind: "text", text: "Here you go." });
    },
  ]);
  const state: LoopState = { items: [{ type: "user", id: "u", text: "hi" }], textProtocol: false };
  await runTurn(state, d);
  const last = state.items.at(-1);
  assert.equal(last?.type === "assistant" && last.text, "Here you go.");
});

test("a reply cut off at the output limit carries on, at most twice in a row (D157)", async () => {
  const cut = (_r: unknown, emit: (e: ChatEvent) => void) => {
    emit({ kind: "thinking", text: "planning a huge file" });
    emit({ kind: "done", stopReason: "length", inputTokens: 1, outputTokens: 1 });
  };
  const { d, seen } = deps([cut, cut, cut, (_r, emit) => emit({ kind: "text", text: "never" })]);
  const state: LoopState = {
    items: [{ type: "user", id: "u", text: "build it" }],
    textProtocol: false,
  };
  assert.equal(await runTurn(state, d), 3);
  const notes = state.items.filter((i) => i.type === "user" && i.auto === "limit");
  assert.equal(notes.length, 2);
  assert.ok(seen[1]?.messages.at(-1)?.content.includes("cut off at the output limit"));
});

test("only an echo at the start is taken out; one in the answer stays (D160)", async () => {
  const { stripEchoedState } = await import("./conversation");
  assert.equal(stripEchoedState("<ide_state>\nx\n</ide_state>\nHi"), "Hi");
  assert.equal(stripEchoedState("<ide_state>\npartial"), "");
  const prose = "Each message starts with `<ide_state>` and the editor's state.";
  assert.equal(stripEchoedState(prose), prose);
});

test("a step that went on for a queued message taken back meanwhile ends (D160)", async () => {
  let takes = 0;
  const { d } = deps([
    (_r, emit) => emit({ kind: "text", text: "Done." }),
    (_r, emit) => emit({ kind: "text", text: "never" }),
  ]);
  // Something is queued as the first step ends, but it's taken back before the next starts.
  d.takeQueued = () => {
    takes++;
    return [];
  };
  d.hasQueued = () => takes === 1;
  const state: LoopState = { items: [{ type: "user", id: "u", text: "go" }], textProtocol: false };
  assert.equal(await runTurn(state, d), 1);
  assert.equal(takes, 2);
  assert.equal(state.items.at(-1)?.type, "assistant");
});

test("tool arguments: objects, JSON strings, nothing; text that isn't JSON is refused", async () => {
  const { toolArguments } = await import("./loop");
  assert.deepEqual(toolArguments({ path: "a" }), { path: "a" });
  assert.deepEqual(toolArguments('{"path":"a"}'), { path: "a" });
  assert.deepEqual(toolArguments(undefined), {});
  assert.deepEqual(toolArguments(""), {});
  assert.deepEqual(toolArguments([]), {});
  // Cut off at the output limit: the content never closed.
  assert.equal(toolArguments('{"path":"a.ts","content":"line 1\\nline'), null);
  assert.equal(toolArguments("[1]"), null);
  assert.equal(toolArguments(42), null);
});

test("a context overflow is summarized away once and the step tried again", async () => {
  const { ContextOverflowError, isContextOverflow } = await import("./loop");
  for (const m of [
    "Anthropic error 400: prompt is too long: 210345 tokens > 200000 maximum",
    "OpenAI: This model's maximum context length is 128000 tokens (context_length_exceeded)",
    "The input token count (1100000) exceeds the maximum number of tokens allowed (1048576).",
    "the request exceeds the available context size, try increasing it",
  ])
    assert.equal(isContextOverflow(m), true, m);
  assert.equal(isContextOverflow("rate limit exceeded"), false);
  assert.equal(isContextOverflow("503 Service Unavailable"), false);
  let recovered = 0;
  const { d, seen } = deps([
    () => {
      throw new ContextOverflowError("prompt is too long");
    },
    (_r, emit) => emit({ kind: "text", text: "Fits now." }),
  ]);
  d.recoverOverflow = async () => {
    recovered++;
    return true;
  };
  const state: LoopState = { items: [{ type: "user", id: "u", text: "go" }], textProtocol: false };
  assert.equal(await runTurn(state, d), 1);
  assert.equal(recovered, 1);
  assert.equal(seen.length, 2);
  assert.deepEqual(
    state.items.map((i) => i.type),
    ["user", "assistant"],
  );
  // A second overflow in the same turn fails it.
  const again = deps([
    () => {
      throw new ContextOverflowError("prompt is too long");
    },
    () => {
      throw new ContextOverflowError("prompt is too long");
    },
  ]);
  again.d.recoverOverflow = async () => true;
  await assert.rejects(
    runTurn({ items: [{ type: "user", id: "u", text: "go" }], textProtocol: false }, again.d),
    ContextOverflowError,
  );
  // Nothing freed: the error stands at once, its reply kept for the notice.
  const none = deps([
    () => {
      throw new ContextOverflowError("prompt is too long");
    },
  ]);
  none.d.recoverOverflow = async () => false;
  const kept: LoopState = { items: [{ type: "user", id: "u", text: "go" }], textProtocol: false };
  await assert.rejects(runTurn(kept, none.d), ContextOverflowError);
  assert.equal(kept.items.at(-1)?.type, "assistant");
});

test("a switch to the text protocol in beforeStep shapes that step's request (D233)", async () => {
  const { d, seen } = deps([
    (_r, emit) => {
      emit({ kind: "toolCall", id: "c1", name: "read_file", arguments: { path: "a.ts" } });
      emit({ kind: "done", stopReason: "stop", inputTokens: 1, outputTokens: 1 });
    },
    (_r, emit) => emit({ kind: "text", text: "It exports x." }),
  ]);
  const state: LoopState = {
    items: [{ type: "user", id: "u", text: "what is in a.ts?" }],
    textProtocol: false,
  };
  let step = 0;
  d.beforeStep = async () => {
    // After the first step a skill's model that has no native tools takes over.
    if (++step === 2) state.textProtocol = true;
  };
  await runTurn(state, d);
  const second = seen[1];
  assert.deepEqual(second?.tools, []);
  assert.match(second?.messages[0]?.content ?? "", /<tool_call>/);
  assert.match(second?.messages[2]?.content ?? "", /<tool_call>\n\{"name":"read_file"/);
  assert.equal(second?.messages[2]?.toolCalls, undefined);
  assert.match(second?.messages[3]?.content ?? "", /<tool_result name="read_file">/);
});

test("calls asked for together run together when they may; writes keep their place (D253)", () => {
  const calls = ["read", "read", "write", "read", "search", "write", "write"].map((name, i) => ({
    name,
    arguments: i,
  }));
  const groups = callGroups(calls, (c) => c.name !== "write");
  assert.deepEqual(
    groups.map((g) => g.map((c) => c.arguments)),
    [[0, 1], [2], [3, 4], [5], [6]],
  );
  // Without the dep: one at a time, as before.
  assert.equal(callGroups(calls, undefined).length, calls.length);
});

test("inParallel runs at most `limit` at once and all of them", async () => {
  let running = 0;
  let most = 0;
  const done: number[] = [];
  await inParallel([1, 2, 3, 4, 5], 2, async (n) => {
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 2));
    running--;
    done.push(n);
  });
  assert.equal(most, 2);
  assert.deepEqual(
    done.sort((a, b) => a - b),
    [1, 2, 3, 4, 5],
  );
});

test("a step's read-only calls run at the same time; results keep the asked order", async () => {
  const { d, seen } = deps([
    (_r, emit) => {
      for (const [id, path] of [
        ["c1", "slow.ts"],
        ["c2", "fast.ts"],
        ["c3", "mid.ts"],
      ] as const)
        emit({ kind: "toolCall", id, name: "read_file", arguments: { path } });
    },
    (_r, emit) => emit({ kind: "text", text: "Done." }),
  ]);
  const delays: Record<string, number> = { "slow.ts": 30, "fast.ts": 1, "mid.ts": 10 };
  let running = 0;
  let most = 0;
  const finished: string[] = [];
  d.concurrent = (call) => call.name === "read_file";
  d.execute = async (call) => {
    const path = (call.arguments as { path: string }).path;
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, delays[path]));
    running--;
    finished.push(path);
    return { result: `contents of ${path}` };
  };
  const state: LoopState = {
    items: [{ type: "user", id: "u", text: "read" }],
    textProtocol: false,
  };
  await runTurn(state, d);
  assert.equal(most, 3);
  assert.deepEqual(finished, ["fast.ts", "mid.ts", "slow.ts"]);
  const tools = (seen[1]?.messages ?? []).filter((m) => m.role === "tool");
  assert.deepEqual(
    tools.map((m) => m.toolCallId),
    ["c1", "c2", "c3"],
  );
  assert.equal(tools[0]?.content, "contents of slow.ts");
});

test("after Stop, a group's calls that haven't started don't run", async () => {
  const { d } = deps([
    (_r, emit) => {
      for (let i = 0; i < 10; i++)
        emit({ kind: "toolCall", id: `c${i}`, name: "read_file", arguments: { path: `${i}.ts` } });
    },
  ]);
  let stopped = false;
  let ran = 0;
  d.concurrent = () => true;
  d.cancelled = () => stopped;
  d.execute = async () => {
    ran++;
    stopped = true; // the first calls stop the turn
    await new Promise((r) => setTimeout(r, 1));
    return { result: "x" };
  };
  const state: LoopState = { items: [{ type: "user", id: "u", text: "go" }], textProtocol: false };
  await runTurn(state, d);
  // The first call stopped the turn before the others started: they were skipped, each with a
  // result (every call the model made gets one).
  assert.equal(ran, 1);
  const skipped = state.items.filter(
    (i) => i.type === "tool" && i.result === "Stopped by the user.",
  );
  assert.equal(skipped.length, 9);
});

test("a usage limit moves the step to another model, at most twice a turn (D254)", async () => {
  const { SwitchModelError, isUsageLimit } = await import("./loop");
  for (const m of [
    "429 Too Many Requests: rate limit reached for requests",
    "You exceeded your current quota, please check your plan and billing details.",
    "Groq error 429: Rate limit reached for model on tokens per day (TPD)",
    "402 Payment Required: insufficient credits",
    "RESOURCE_EXHAUSTED: Quota exceeded for free tier",
  ])
    assert.equal(isUsageLimit(m), true, m);
  for (const m of ["503 Service Unavailable", "401 invalid api key", "model not found"])
    assert.equal(isUsageLimit(m), false, m);
  let switched = 0;
  const { d, seen } = deps([
    () => {
      throw new SwitchModelError("429 quota");
    },
    (_r, emit) => emit({ kind: "text", text: "Answered on the backup." }),
  ]);
  d.beforeStep = async () => {
    switched++;
  };
  const state: LoopState = { items: [{ type: "user", id: "u", text: "go" }], textProtocol: false };
  assert.equal(await runTurn(state, d), 1);
  assert.equal(seen.length, 2);
  // The model switch happens before the step is taken again.
  assert.equal(switched, 2);
  assert.deepEqual(
    state.items.map((i) => i.type),
    ["user", "assistant"],
  );
  // A third switch in one turn fails it.
  const again = deps(
    [1, 2, 3].map(() => () => {
      throw new SwitchModelError("429 quota");
    }),
  );
  await assert.rejects(
    runTurn({ items: [{ type: "user", id: "u", text: "go" }], textProtocol: false }, again.d),
    SwitchModelError,
  );
  assert.equal(again.seen.length, 3);
});

test("a key that can't pay for the whole output limit is asked again with what it can (D366)", async () => {
  const { affordableOutput } = await import("./loop");
  assert.equal(
    affordableOutput(
      "This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 40434. (402)",
    ),
    36390,
  );
  assert.equal(
    affordableOutput("You requested up to 65536 tokens, but can only afford 500."),
    null,
  );
  assert.equal(affordableOutput("insufficient credits (402)"), null);
});

test("D376: a text-protocol widget is drawn while written, and keeps its id when it's done", async () => {
  const widget: ToolSpec = {
    name: "show_widget",
    description: "Draw",
    parameters: { type: "object" },
  };
  const drafts: { id?: string; args?: string }[] = [];
  const ran: string[] = [];
  const { d } = deps([
    (_r, emit) => {
      emit({
        kind: "text",
        text: '<tool_call>\n{"name": "show_widget", "arguments": {"title": "t", ',
      });
      emit({ kind: "text", text: `"widget_code": "<div>${"x".repeat(1200)}` });
      emit({ kind: "text", text: '</div>"}}\n</tool_call>' });
    },
    (_r, emit) => emit({ kind: "text", text: "Drawn." }),
  ]);
  const state: LoopState = {
    items: [{ type: "user", id: "u", text: "draw" }],
    textProtocol: true,
  };
  await runTurn(state, {
    ...d,
    tools: () => [widget],
    update: () => {
      const a = state.items.find((i) => i.type === "assistant");
      if (a?.type === "assistant" && a.toolDraft) drafts.push({ ...a.toolDraft });
    },
    execute: async (call) => {
      ran.push(call.id);
      return { result: "shown", summary: "shown" };
    },
  });
  const drawn = drafts.find((x) => x.args?.includes("<div>"));
  assert.ok(drawn?.id, "a draft with the widget's code");
  assert.ok(drawn.args?.startsWith('{"title"'));
  assert.deepEqual(ran, [drawn.id]);
});

test("a model's images and a tool's join the chat with ids (D381)", async () => {
  const { d } = deps([
    (_r, emit) => {
      emit({ kind: "text", text: "Drawing." });
      emit({ kind: "image", mime: "image/png", data: "AAAA" });
      emit({ kind: "toolCall", id: "c1", name: "read_file", arguments: { path: "a.ts" } });
    },
    (_r, emit) => {
      emit({ kind: "image", mime: "image/webp", data: "CCCC" });
      emit({ kind: "image", mime: "image/png", data: "", url: "https://example.com/x.png" });
      emit({ kind: "text", text: "Done." });
    },
  ]);
  d.execute = async () => ({
    result: "ok",
    media: [{ mime: "image/jpeg", data: "BBBB", name: "b.jpg", source: "a tool" }],
  });
  const state: LoopState = {
    items: [{ type: "user", id: "u", text: "draw" }],
    textProtocol: false,
  };
  await runTurn(state, d);
  const ids = state.items.flatMap((i) =>
    i.type === "assistant" || i.type === "tool"
      ? (i.media ?? []).map((m) => `${i.type}:${m.id}`)
      : [],
  );
  assert.deepEqual(ids, ["assistant:img1", "tool:img2", "assistant:img3"]);
  const tool = state.items.find((i) => i.type === "tool");
  assert.equal(tool?.type === "tool" && tool.media?.[0]?.name, "b.jpg");
  // A link stays a link in the text (nothing is loaded from the network).
  const last = state.items[state.items.length - 1];
  assert.match(
    last?.type === "assistant" ? last.text : "",
    /\[Image\]\(https:\/\/example\.com\/x\.png\)/,
  );
});
