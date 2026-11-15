// The agent in Node, with no window. One full turn: a message, a file written, read back,
// searched for, a command that asks permission (answered through `agent.respondPermission`, as a
// terminal or a remote client would), the answer, the chat saved. The backend is a fake that
// answers the handful of commands a turn makes; the services are the ones a turn needs, the rest
// absent. The same for an external agent over ACP: a fake program on the stdio host that asks
// permission and answers.
//
// There is no `document` and no `window` here, and the tests say so: the fake backend is a
// transport installed in the call layer (`setTransport`), so nothing of a page is defined at all.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { after, test } from "node:test";
import type { Item } from "../../core/agent/conversation";
import { ContextKeyService } from "../../core/context/index";
import { Dispatcher } from "../../core/dispatcher/index";
import { EventBus } from "../../core/events/index";
import { OperationHistory } from "../../core/history/index";
import { setTransport, type Transport } from "../../core/ipc/invoke";
import { DisposableStore } from "../../core/lifecycle/index";
import { ALLOW_ALL } from "../../core/permissions/index";
import { signal } from "../../core/reactive/index";
import { StateTree } from "../../core/state/index";
import { QuickDiffService, type WorkbenchServices } from "../../workbench/services";
import { agentHost, headlessAgentHost, setAgentHost } from "./agentHost";
import { registerAgentCommands } from "./commands";
import { ProviderRegistry } from "./providers";
import { NEEDS_SCREEN } from "./session";
import { observeSession, type SessionEvent } from "./sessionEvents";
import { SessionManager } from "./sessions";
import { PLAN_YES } from "./turnTools";

const slashes = (path: string) => path.split("\\").join("/");

/** What the fake backend was asked, in order. */
interface Call {
  command: string;
  args: unknown;
}

/** One answer of the fake model: a tool call, or its closing text. */
type ModelStep = { tool: string; args: Record<string, unknown> } | { text: string };

interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

/**
 * An external agent over ACP, as small as one can be: it starts a session, and answers a prompt
 * by asking permission for a command, then saying what the person chose.
 */
function fakeAcpAgent(message: RpcMessage, say: (body: string) => void): void {
  const send = (m: Record<string, unknown>) => say(JSON.stringify({ jsonrpc: "2.0", ...m }));
  if (message.method === "initialize")
    send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "a1" } });
  else if (message.method === "session/prompt") {
    promptId = message.id ?? null;
    send({
      id: 900,
      method: "session/request_permission",
      params: {
        sessionId: "a1",
        toolCall: { toolCallId: "t1", title: "echo ok", kind: "execute" },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      },
    });
  } else if (message.id === 900) {
    // The permission's answer: say it, and end the turn.
    const outcome = (message.result as { outcome?: { optionId?: string } } | undefined)?.outcome;
    send({
      method: "session/update",
      params: {
        sessionId: "a1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `You chose ${outcome?.optionId ?? "nothing"}.` },
        },
      },
    });
    send({ id: promptId, result: { stopReason: "end_turn" } });
  } else if (message.id !== undefined && message.method)
    // Anything else it's asked: nothing to say.
    send({ id: message.id, result: {} });
}
/** The fake external agent's open prompt (its answer ends the turn). */
let promptId: number | null = null;

interface FakeChannel<T> {
  onmessage: (message: T) => void;
}

/**
 * The backend, faked at the one place the call layer reaches it: a transport answered here. A
 * channel in a call's args is the live `Channel` object, so a command pushes its messages by
 * calling `onmessage`.
 */
function installFakeBackend(root: string, home: string) {
  const calls: Call[] = [];
  const unanswered = new Set<string>();
  /** The tools each model request offered. */
  const offered: string[][] = [];
  let steps: ModelStep[] = [];
  let callId = 0;
  /** The programs on the stdio host, by id: how each one's output reaches the page. */
  const programs = new Map<string, (body: string) => void>();
  const abs = (path: string) => (isAbsolute(path) ? path : join(root, path));
  const notFound = (path: string) => ({ code: "NotFound", message: `not found ${path}` });

  const invoke = async (command: string, args: unknown, options?: unknown): Promise<unknown> => {
    calls.push({ command, args });
    const a = (args ?? {}) as Record<string, unknown>;
    switch (command) {
      case "ai_chat": {
        const channel = a.onEvent as FakeChannel<unknown>;
        const tools = ((a.request as { tools?: { name?: string }[] }).tools ?? []).map(
          (t) => t.name ?? "",
        );
        offered.push(tools);
        const step = steps.shift() ?? { text: "" };
        if ("tool" in step)
          channel.onmessage({
            kind: "toolCall",
            id: `c${++callId}`,
            name: step.tool,
            arguments: step.args,
          });
        else channel.onmessage({ kind: "text", text: step.text });
        channel.onmessage({
          kind: "done",
          stopReason: "tool" in step ? "tool_use" : "end",
          inputTokens: 10,
          outputTokens: 5,
        });
        return undefined;
      }
      case "ai_list_models":
        return [{ id: "fake", name: "fake", contextLength: 200000, tools: true, remote: true }];
      case "ai_model_details":
        return { contextLength: 200000, tools: true, vision: false };
      case "app_info":
        return { homeDir: slashes(home), dataDir: home, os: "windows", version: "0" };
      case "fs_read": {
        const path = abs(String(a.path));
        if (!existsSync(path)) throw notFound(String(a.path));
        const bytes = readFileSync(path);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
      case "fs_stat": {
        const path = abs(String(a.path));
        if (!existsSync(path)) throw notFound(String(a.path));
        const stat = statSync(path);
        return {
          kind: stat.isDirectory() ? "dir" : "file",
          size: stat.size,
          mtime: stat.mtimeMs,
          readonly: false,
        };
      }
      case "fs_write": {
        const headers = (options as { headers: Record<string, string> }).headers;
        writeFileSync(
          abs(decodeURIComponent(headers["x-path"] ?? "")),
          Buffer.from(args as Uint8Array),
        );
        return null;
      }
      case "exec_run": {
        const channel = a.onOutput as FakeChannel<string>;
        channel.onmessage("ok");
        channel.onmessage("\u0000end");
        return { exitCode: 0, timedOut: false, cancelled: false, durationMs: 3 };
      }
      case "search_start": {
        // The folder's files holding the query, as the engine reports them.
        const channel = a.onEvent as FakeChannel<unknown>;
        const query = String((a.options as { query: string }).query);
        let files = 0;
        let matches = 0;
        for (const name of readdirSync(root)) {
          const hits = readFileSync(join(root, name), "utf8")
            .split("\n")
            .flatMap((text, i) =>
              text.includes(query) ? [{ line: i + 1, text, ranges: [] }] : [],
            );
          if (!hits.length) continue;
          files++;
          matches += hits.length;
          channel.onmessage({ kind: "file", path: `${root}/${name}`, rel: name, matches: hits });
        }
        channel.onmessage({
          kind: "done",
          files,
          matches,
          truncated: false,
          cancelled: false,
          durationMs: 1,
        });
        return undefined;
      }
      case "index_query": {
        const query = String(a.query);
        const items = readdirSync(root)
          .filter((name) => name.includes(query))
          .map((path) => ({ path, score: 1, positions: [] }));
        return { items, total: items.length, indexing: false, truncated: false };
      }
      case "lsp_start": {
        // An external agent's program: what it says goes back as messages on this channel.
        const channel = a.onEvent as FakeChannel<unknown>;
        programs.set(String(a.id), (body) => channel.onmessage({ kind: "message", body }));
        return 4242;
      }
      case "lsp_send": {
        const reply = programs.get(String(a.id));
        if (reply) fakeAcpAgent(JSON.parse(String(a.body)) as RpcMessage, reply);
        return null;
      }
      case "lsp_stop":
        programs.delete(String(a.id));
        return null;
      default:
        unanswered.add(command);
        return null;
    }
  };

  let nextChannel = 1;
  const transport: Transport = {
    kind: "fake",
    state: "open",
    request: (command, args) => invoke(command, args),
    requestRaw: (command, body, headers) => invoke(command, body, { headers }),
    openChannel: () => {
      const id = nextChannel++;
      return { id, wire: () => ({ __channel: id }), close: () => {} };
    },
    onClose: () => () => {},
  };
  setTransport(transport);
  return {
    calls,
    unanswered,
    offered,
    /** What the model answers, one step per request. */
    script: (next: ModelStep[]) => {
      steps = [...next];
    },
  };
}

/** A service nobody should need in a turn: what is read from it is recorded. */
function absent(name: string, used: Set<string>): unknown {
  const hole = (path: string): unknown =>
    new Proxy(() => {}, {
      get(_target, key) {
        if (key === "then" || typeof key === "symbol") return undefined;
        used.add(`${path}.${key}`);
        return hole(`${path}.${key}`);
      },
      apply() {
        used.add(`${path}()`);
        return hole(`${path}()`);
      },
    });
  return hole(name);
}

function stubServices(root: string, settingsMap: Record<string, unknown>, used: Set<string>) {
  const context = new ContextKeyService();
  const events = new EventBus();
  const dispatcher = new Dispatcher({
    context,
    permissions: ALLOW_ALL,
    events: { emit: (name: string, event: unknown) => events.emit(name as never, event as never) },
    audit: () => {},
  } as unknown as ConstructorParameters<typeof Dispatcher>[0]);
  const folder = { name: "ws", path: root };
  const settings = {
    peek: (key: string) => settingsMap[key],
    get: (key: string) => settingsMap[key],
    model: { onDidChange: () => ({ dispose() {} }), get: (key: string) => settingsMap[key] },
    version: signal(0),
    update: async () => {},
    filePath: () => null,
  };
  const workspace = {
    root: signal<string | null>(root),
    folders: signal([folder]),
    file: signal(null),
    resolve: (path: string) => (isAbsolute(path) ? slashes(path) : `${root}/${path}`),
    relative: (path: string) => slashes(relative(root, path)),
    folderOf: () => folder,
    folderPaths: () => [root],
    contains: (path: string) => resolve(path).startsWith(resolve(root)),
    onDidChangeFolders: () => ({ dispose() {} }),
  };
  const base: Record<string, unknown> = {
    platform: "windows",
    dispatcher,
    context,
    state: new StateTree(),
    events,
    settings,
    workspace,
    quickDiff: new QuickDiffService(),
    history: new OperationHistory(),
    trust: {
      trusted: signal(true),
      state: signal("trusted"),
      risky: {
        version: signal(0),
        key: () => "",
        riskOf: () => null,
        downloadsOf: () => null,
        downloadFolders: () => [],
      },
    },
    extensionGate: { folders: () => [], enabledIds: signal([]) },
    codeCheck: { newErrors: async () => null },
    // External agents also read these two: the agents extensions bring, and the installed ones.
    extensionFeatures: { agents: signal([]) },
    persistence: {
      globalState: () => ({}),
      saveGlobal: async () => {},
      scheduleSave: () => {},
    },
  };
  const services = new Proxy(base, {
    get(target, key) {
      if (typeof key === "symbol" || key in target) return target[key as string];
      return absent(`services.${key}`, used);
    },
  }) as unknown as WorkbenchServices;
  return { services, dispatcher };
}

const scratch = mkdtempSync(join(tmpdir(), "agent-turn-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// The proof that nothing here stands in for the screen: taken before the fake backend goes in,
// and checked again after each turn (`noScreen`).
const realm = globalThis as unknown as Record<string, unknown>;
const cleanAtStart =
  typeof realm.document === "undefined" &&
  typeof realm.window === "undefined" &&
  typeof realm.CSS === "undefined";

/** Nothing of a page exists in this realm (asserted after each turn: nothing defined one). */
const noScreen = () =>
  typeof realm.document === "undefined" &&
  typeof realm.window === "undefined" &&
  typeof realm.CSS === "undefined";

const root = slashes(join(scratch, "ws"));
mkdirSync(root, { recursive: true });
const backend = installFakeBackend(root, scratch);

const SETTINGS = {
  "agent.model": "fake/fake",
  "agent.runCommands": "ask",
  "agent.notifyWhenDone": true,
  "agent.maxSteps": 20,
  "agent.providers": [{ id: "fake", name: "fake", baseUrl: "http://x", kind: "openai" }],
  "agent.ollama.enabled": false,
  "agent.checkEdits": false,
  "agent.verify": "off",
  "agent.autoTitle": false,
  "agent.externalAgents": { fake: { command: "fake-agent" } },
  "agent.externalAgents.ideTools": false,
};

/** A window-less agent: providers, the session manager, and (asked for) the agent's commands. */
async function startAgent(commands: boolean) {
  const used = new Set<string>();
  const { services, dispatcher } = stubServices(root, SETTINGS, used);
  const providers = new ProviderRegistry(services);
  await providers.refresh();
  const sessions = new SessionManager(services, providers);
  const store = new DisposableStore();
  if (commands) registerAgentCommands(store, services, sessions, providers);
  const session = sessions.get();
  sessions.active.value = session.id;
  session.autoApply.value = true;
  return {
    services,
    dispatcher,
    session,
    /** Members read from services the stub leaves out. */
    used,
    dispose: () => {
      sessions.dispose();
      store.dispose();
    },
  };
}

/** `run`, failing when it takes longer than a turn against a fake model ever should. */
async function inTime<T>(run: Promise<T>, what: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the turn didn't end; ${what()}`)), 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const toolRows = (items: readonly Item[]) =>
  items.flatMap((i) => (i.type === "tool" ? [`${i.name}:${i.status}`] : []));

test("there is no document, window or CSS in this realm", () => {
  assert.equal(cleanAtStart, true);
  assert.equal(noScreen(), true);
});

test("a full turn with no window: write, read, search, a command asked for and answered, saved", async () => {
  const agent = await startAgent(true);
  const { services, dispatcher, session } = agent;
  // With nothing set, the agent's host is the one for no screen.
  assert.equal(agentHost(services).screen, false);
  assert.equal(agentHost(services).presence.away(), true);

  backend.script([
    { tool: "write_file", args: { path: "hello.txt", content: "hi from node\n" } },
    { tool: "read_file", args: { path: "hello.txt" } },
    { tool: "search", args: { pattern: "hi from" } },
    { tool: "find_files", args: { query: "hello" } },
    { tool: "run_command", args: { command: "echo ok" } },
    { text: "All done." },
  ]);

  // Whoever stands in for the person answers through the command, as a front end would.
  const asked: string[] = [];
  const answering = setInterval(() => {
    const pending = session.permissions.peek()[0];
    if (!pending || asked.includes(pending.id)) return;
    asked.push(pending.id);
    assert.equal(session.status.peek(), "waiting");
    void dispatcher.execute(
      "agent.respondPermission",
      { session: session.id, id: pending.id, answer: "once" },
      { kind: "test" },
    );
  }, 10);
  try {
    await inTime(
      session.send("write a file, read it, look for it, then run a command"),
      () => `status ${session.status.peek()}`,
    );
  } finally {
    clearInterval(answering);
  }

  assert.equal(session.error.peek(), null);
  assert.equal(session.status.peek(), "idle");
  const results = session.items.flatMap((i) => (i.type === "tool" ? [i.result ?? ""] : []));
  assert.deepEqual(
    toolRows(session.items),
    ["write_file:done", "read_file:done", "search:done", "find_files:done", "run_command:done"],
    results.join(" | "),
  );
  assert.equal(asked.length, 1, "the command asked once");
  assert.equal(readFileSync(join(root, "hello.txt"), "utf8"), "hi from node\n");
  const last = session.items.findLast((i) => i.type === "assistant");
  assert.equal(last?.type === "assistant" ? last.text : "", "All done.");

  // search and the fuzzy find_files went straight to the backend: no window command exists.
  assert.equal(dispatcher.has("search.find"), false);
  assert.equal(dispatcher.has("quickOpen.search"), false);
  assert.match(results[2] ?? "", /hello\.txt/);
  assert.match(results[3] ?? "", /hello\.txt/);
  assert.ok(backend.calls.some((c) => c.command === "search_start"));
  assert.ok(backend.calls.some((c) => c.command === "index_query"));

  await session.save();
  const saved = backend.calls.findLast((c) => c.command === "agent_session_save");
  assert.equal((saved?.args as { id?: string } | undefined)?.id, session.id);

  // Screen-only tools were never offered (left out, not present and failing).
  const offered = new Set(backend.offered.flat());
  for (const name of NEEDS_SCREEN)
    assert.equal(offered.has(name), false, `${name} offered with no screen`);
  for (const name of ["read_file", "write_file", "run_command", "search", "find_files", "notify"])
    assert.equal(offered.has(name), true, `${name} missing`);

  assert.equal(noScreen(), true, "a page was defined");
  // Of the services the stub leaves out, only notifications were used: nobody is watching, so
  // the chat said it needed an answer.
  assert.deepEqual(
    [...agent.used],
    ["services.notifications.show", "services.notifications.show()"],
  );
  agent.dispose();
});

test("enter_plan_mode switches the chat itself where its command isn't registered", async () => {
  const agent = await startAgent(false);
  const { dispatcher, session } = agent;
  assert.equal(dispatcher.has("agent.setChatMode"), false);
  backend.script([
    { tool: "enter_plan_mode", args: { reason: "several files" } },
    { text: "The plan." },
  ]);
  const answering = setInterval(() => {
    if (session.questions.peek().length) session.answer(PLAN_YES);
  }, 10);
  try {
    await inTime(session.send("plan it first"), () => `status ${session.status.peek()}`);
  } finally {
    clearInterval(answering);
  }
  assert.equal(session.error.peek(), null);
  assert.deepEqual(toolRows(session.items), ["enter_plan_mode:done"]);
  assert.equal(session.chatMode.peek(), "plan");
  assert.equal(noScreen(), true);
  agent.dispose();
});

test("with a screen, the same chat is offered the screen's tools again", async () => {
  const agent = await startAgent(false);
  const { services, session } = agent;
  const offers = (name: string) => session.tools().some((t) => t.spec.name === name);
  assert.equal(offers("show_widget"), false);
  setAgentHost(services, { ...headlessAgentHost(), screen: true });
  assert.equal(offers("show_widget"), true);
  setAgentHost(services, headlessAgentHost());
  assert.equal(offers("show_widget"), false);
  agent.dispose();
});

test("read_file shows a PNG as it is where there is no canvas to redraw it", async () => {
  const agent = await startAgent(false);
  const { session } = agent;
  // A one-pixel PNG.
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  writeFileSync(join(root, "dot.png"), Buffer.from(png, "base64"));
  backend.script([{ tool: "read_file", args: { path: "dot.png" } }, { text: "A dot." }]);
  await inTime(session.send("look at dot.png"), () => `status ${session.status.peek()}`);
  assert.equal(session.error.peek(), null);
  const read = session.items.find((i) => i.type === "tool");
  assert.equal(read?.type === "tool" ? read.status : "", "done");
  assert.equal(read?.type === "tool" ? read.summary : "", "image");
  assert.equal(noScreen(), true);
  agent.dispose();
});

test("an external agent's turn with no window: started, its permission answered, its reply shown", async () => {
  const agent = await startAgent(true);
  const { dispatcher, session } = agent;
  session.model.value = "acp/fake";
  const asked: string[] = [];
  const answering = setInterval(() => {
    const pending = session.permissions.peek()[0];
    if (!pending || asked.includes(pending.id)) return;
    asked.push(pending.id);
    void dispatcher.execute(
      "agent.respondPermission",
      { session: session.id, id: pending.id, answer: "once" },
      { kind: "test" },
    );
  }, 10);
  try {
    await inTime(session.send("run echo ok"), () => `status ${session.status.peek()}`);
  } finally {
    clearInterval(answering);
  }
  assert.equal(session.error.peek(), null);
  assert.equal(asked.length, 1, "the agent's permission request was shown once");
  const reply = session.items.findLast((i) => i.type === "assistant");
  assert.equal(reply?.type === "assistant" ? reply.text : "", "You chose yes.");
  assert.ok(backend.calls.some((c) => c.command === "lsp_start"));
  assert.equal(noScreen(), true);
  agent.dispose();
});

test("a run's policy: its deny list refuses, its allow list answers, the rest is refused; the chat tells it as events", async () => {
  const agent = await startAgent(true);
  const { services, session } = agent;
  setAgentHost(
    services,
    headlessAgentHost({
      permissions: { allow: ["echo"], deny: ["write_file"], otherwise: "deny" },
    }),
  );
  const events: SessionEvent[] = [];
  const watching = observeSession(services, session, (event) => events.push(event));
  backend.script([
    { tool: "write_file", args: { path: "refused.txt", content: "no\n" } },
    { tool: "run_command", args: { command: "echo ok" } },
    { tool: "run_command", args: { command: "curl http://example.invalid" } },
    { text: "Did what was allowed." },
  ]);
  await inTime(session.send("try three things"), () => `status ${session.status.peek()}`);
  watching.dispose();

  assert.equal(session.error.peek(), null);
  assert.deepEqual(toolRows(session.items), [
    "write_file:denied",
    "run_command:done",
    "run_command:denied",
  ]);
  assert.equal(existsSync(join(root, "refused.txt")), false);
  // Nothing waited on anybody: every question was decided as it came.
  assert.equal(session.permissions.peek().length, 0);
  assert.equal(
    events.some((e) => e.type === "permission.request"),
    false,
  );
  const decisions = events.flatMap((e) =>
    e.type === "permission.decision" ? [`${e.answer}/${e.by}/${e.rule ?? "-"}/${e.tool}`] : [],
  );
  assert.deepEqual(decisions, [
    "deny/policy/write_file/write_file",
    "once/policy/echo/run_command",
    "deny/policy/-/run_command",
  ]);

  // The stream: where the chat stood, the turn, each call and its end, the answer, the end.
  assert.equal(events[0]?.type, "session");
  const types = events.map((e) => e.type);
  assert.ok(types.indexOf("turn.start") > 0);
  assert.equal(types.filter((t) => t === "tool.start").length, 3);
  assert.equal(types.filter((t) => t === "tool.end").length, 3);
  const ends = events.flatMap((e) => (e.type === "tool.end" ? [`${e.name}:${e.status}`] : []));
  assert.deepEqual(ends, ["write_file:denied", "run_command:done", "run_command:denied"]);
  const text = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
  assert.equal(text, "Did what was allowed.");
  const end = events.at(-1);
  assert.equal(end?.type, "turn.end");
  assert.equal(end?.type === "turn.end" ? end.reason : "", "end");
  assert.equal(end?.type === "turn.end" ? end.text : "", "Did what was allowed.");
  assert.equal(end?.type === "turn.end" ? end.usage.totals.requests : 0, 4);
  // Every event is plain data: what a front end reads off a wire is what was told here.
  assert.deepEqual(JSON.parse(JSON.stringify(events)), events);
  assert.equal(noScreen(), true);
  agent.dispose();
});

test("a policy that waits: the question is an event, a front end answers it, the decision is told", async () => {
  const agent = await startAgent(true);
  const { services, dispatcher, session } = agent;
  setAgentHost(services, headlessAgentHost({ permissions: { otherwise: "wait" } }));
  const events: SessionEvent[] = [];
  const watching = observeSession(services, session, (event) => {
    events.push(event);
    // The front end: it hears the question and answers it with the command, as the person.
    if (event.type === "permission.request")
      void dispatcher.execute(
        "agent.respondPermission",
        { session: session.id, id: event.id, answer: "once" },
        { kind: "frontend", name: "test" },
      );
  });
  backend.script([{ tool: "run_command", args: { command: "echo ok" } }, { text: "Ran it." }]);
  await inTime(session.send("run it"), () => `status ${session.status.peek()}`);
  watching.dispose();
  assert.deepEqual(toolRows(session.items), ["run_command:done"]);
  const asked = events.find((e) => e.type === "permission.request");
  assert.equal(asked?.type === "permission.request" ? asked.code : "", "echo ok");
  assert.equal(asked?.type === "permission.request" ? asked.kind : "", "command");
  const decided = events.find((e) => e.type === "permission.decision");
  assert.equal(decided?.type === "permission.decision" ? decided.by : "", "user");
  assert.equal(decided?.type === "permission.decision" ? decided.answer : "", "once");
  assert.equal(
    decided?.type === "permission.decision" ? decided.id : "",
    asked?.type === "permission.request" ? asked.id : "-",
  );
  // It waited: the status went there and back.
  const statuses = events.flatMap((e) => (e.type === "status" ? [e.status] : []));
  assert.deepEqual(statuses, ["running", "waiting", "running", "idle"]);
  agent.dispose();
});

test("a stopped turn ends with its reason", async () => {
  const agent = await startAgent(true);
  const { services, session } = agent;
  setAgentHost(services, headlessAgentHost({ permissions: { otherwise: "wait" } }));
  const events: SessionEvent[] = [];
  const watching = observeSession(services, session, (event) => {
    events.push(event);
    // Nobody answers: the run is stopped instead (a time limit, Ctrl+C).
    if (event.type === "permission.request") session.stop("the time limit was reached");
  });
  backend.script([{ tool: "run_command", args: { command: "echo ok" } }, { text: "never" }]);
  await inTime(session.send("run it"), () => `status ${session.status.peek()}`);
  watching.dispose();
  const end = events.findLast((e) => e.type === "turn.end");
  assert.equal(end?.type === "turn.end" ? end.reason : "", "stopped");
  const notice = events.findLast((e) => e.type === "notice");
  assert.match(notice?.type === "notice" ? notice.text : "", /the time limit was reached/);
  // Stop refused the waiting question, and said so.
  const decided = events.find((e) => e.type === "permission.decision");
  assert.equal(decided?.type === "permission.decision" ? decided.answer : "", "deny");
  agent.dispose();
});
