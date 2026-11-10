// D204: several sessions, compounds, child processes, function / data breakpoints, the
// exception widget, threads, launch settings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Emitter } from "../../core/events/index";
import {
  autoAttachEnv,
  nodeOptionsWith,
  parentFor,
  parseRegistration,
  registrationName,
  wantsChildAttach,
} from "./autoAttach";
import { pickFrameTarget } from "./browser";
import { findFunctionDeclarations } from "./cdp";
import { parseCompounds, resolveCompound, sessionsToStop } from "./compounds";
import {
  exceptionBreakpointsArgs,
  exceptionWidget,
  fromCdpException,
  fromDapExceptionInfo,
  parseExceptionFilters,
} from "./exceptionInfo";
import { adapterFor, dapLaunchArguments, parseLaunchJson, toConfig } from "./launch";
import { isPackageManager, shellLine, shellWord } from "./launchers";
import { OtherBreakpoints } from "./otherBreakpoints";
import {
  inspectPort,
  parsePs,
  parseWindowsProcesses,
  processChoices,
  programName,
} from "./processes";
import { feedServerReady, parseServerReady, serverReadyUri } from "./serverReady";
import { DapConnection, DapSession } from "./session";
import {
  focusAfter,
  pickThread,
  sessionTree,
  threadsAfterContinue,
  threadsAfterStop,
  uniqueName,
} from "./sessionModel";
import { CONFIG_SNIPPETS, insertSnippet } from "./snippets";

const v = { workspaceFolder: "/w", pathSeparator: "/" };

test("compounds: parsed, resolved in order, unknown names refused", () => {
  const json = {
    configurations: [
      { name: "Server", type: "node", request: "launch", program: "${workspaceFolder}/s.js" },
      { name: "Client", type: "chrome", request: "launch", url: "http://localhost:3000" },
    ],
    compounds: [
      {
        name: "Both",
        configurations: ["Server", { name: "Client" }],
        stopAll: true,
        preLaunchTask: "build",
      },
      { name: "Broken", configurations: ["Server", "Nope"] },
      { name: "", configurations: ["Server"] },
      { name: "Empty", configurations: [] },
    ],
  };
  const configs = parseLaunchJson(json, "launch.json", v);
  const compounds = parseCompounds(json, "launch.json", v);
  assert.deepEqual(
    compounds.map((c) => [c.name, c.configurations, c.stopAll, c.preLaunchTask ?? null]),
    [
      ["Both", ["Server", "Client"], true, "build"],
      ["Broken", ["Server", "Nope"], false, null],
    ],
  );
  const [both, broken] = compounds;
  assert.deepEqual(
    resolveCompound(both as never, configs).map((c) => c.name),
    ["Server", "Client"],
  );
  assert.throws(() => resolveCompound(broken as never, configs), /"Nope"/);
});

test("compounds: stopAll stops the compound's sessions and their children", () => {
  const sessions = [
    { id: "s1", parentId: null, compound: "c1" },
    { id: "s2", parentId: null, compound: "c1" },
    { id: "s3", parentId: "s1", compound: "c1" },
    { id: "s4", parentId: null, compound: null },
    { id: "s5", parentId: "s4", compound: null },
  ];
  assert.deepEqual(sessionsToStop("s2", sessions, () => true).sort(), ["s1", "s2", "s3"]);
  assert.deepEqual(
    sessionsToStop("s2", sessions, () => false),
    ["s2"],
  );
  // A child of a compound session: the whole compound too.
  assert.deepEqual(sessionsToStop("s3", sessions, () => true).sort(), ["s1", "s2", "s3"]);
  assert.deepEqual(
    sessionsToStop("s4", sessions, () => true),
    ["s4", "s5"],
  );
  assert.deepEqual(
    sessionsToStop("nope", sessions, () => true),
    [],
  );
});

test("session model: tree, focus after an end, unique names", () => {
  const list = [
    { id: "a", parentId: null, stopped: false },
    { id: "b", parentId: "a", stopped: true },
    { id: "c", parentId: null, stopped: false },
    { id: "d", parentId: "gone", stopped: false },
  ];
  assert.deepEqual(
    sessionTree(list).map((x) => [x.session.id, x.depth]),
    [
      ["a", 0],
      ["b", 1],
      ["c", 0],
      ["d", 0],
    ],
  );
  assert.equal(focusAfter(list, "b"), "a");
  assert.equal(focusAfter(list, "c"), "b");
  assert.equal(focusAfter([{ id: "x", parentId: null, stopped: false }], "x"), null);
  assert.equal(uniqueName("App", ["App", "App (2)"]), "App (3)");
  assert.equal(uniqueName("Web", ["App"]), "Web");
});

test("threads: a stop marks its thread (or all), continue clears one or all", () => {
  const listed = [
    { id: 1, name: "main" },
    { id: 2, name: "worker" },
  ];
  let t = threadsAfterStop([], listed, { threadId: 2, reason: "breakpoint" });
  assert.deepEqual(
    t.map((x) => [x.id, x.stopped, x.reason ?? null]),
    [
      [1, false, null],
      [2, true, "breakpoint"],
    ],
  );
  t = threadsAfterStop(t, listed, { threadId: 1, reason: "pause", allThreadsStopped: true });
  assert.deepEqual(
    t.map((x) => [x.id, x.stopped, x.reason]),
    [
      [1, true, "pause"],
      [2, true, "breakpoint"],
    ],
  );
  const one = threadsAfterContinue(t, { threadId: 1, all: false });
  assert.deepEqual(
    one.map((x) => x.stopped),
    [false, true],
  );
  assert.equal(pickThread(one, 1), 1);
  assert.equal(pickThread(one, 9), 2);
  assert.ok(threadsAfterContinue(t, { all: true }).every((x) => !x.stopped));
  // A stop before any thread list (Node): the thread is added.
  assert.deepEqual(
    threadsAfterStop([], null, { threadId: 1, reason: "step" }).map((x) => x.name),
    ["Main thread"],
  );
});

test("exception widget: DAP exceptionInfo and Node's exception object", () => {
  const dap = fromDapExceptionInfo({
    exceptionId: "ValueError",
    description: "ValueError: bad value",
    breakMode: "unhandled",
    details: {
      message: "bad value",
      stackTrace: '  File "a.py", line 3, in f\n    raise ValueError("bad value")',
      innerException: [{ typeName: "KeyError", message: "k" }],
    },
  });
  assert.ok(dap);
  const w = exceptionWidget(dap as never);
  assert.equal(w.title, "Exception has occurred: ValueError (uncaught)");
  assert.equal(w.message, "bad value");
  assert.deepEqual(w.stack, [
    'File "a.py", line 3, in f',
    'raise ValueError("bad value")',
    "Caused by KeyError: k",
  ]);
  assert.equal(fromDapExceptionInfo({}), null);

  const node = fromCdpException(
    {
      className: "TypeError",
      description:
        "TypeError: x.map is not a function\n    at f (/w/a.js:3:5)\n    at Object.<anonymous> (/w/a.js:9:1)",
    },
    false,
  );
  const n = exceptionWidget(node);
  assert.equal(n.title, "Exception has occurred: TypeError");
  assert.equal(n.message, "x.map is not a function");
  assert.deepEqual(n.stack, ["at f (/w/a.js:3:5)", "at Object.<anonymous> (/w/a.js:9:1)"]);
  // A thrown string.
  const str = exceptionWidget(fromCdpException({ type: "string", value: "oops" }, true));
  assert.equal(str.title, "Exception has occurred: string (uncaught)");
  assert.equal(str.message, '"oops"');
  // Long stacks are cut.
  const long = exceptionWidget({
    exceptionId: "E",
    breakMode: "always",
    stackTrace: Array.from({ length: 30 }, (_, i) => `at f${i}`).join("\n"),
  });
  assert.equal(long.stack.length, 12);
  assert.equal(long.more, 18);
});

test("exception filters: defaults, choices, conditions as filterOptions", () => {
  const filters = parseExceptionFilters([
    { filter: "raised", label: "Raised exceptions", default: false, supportsCondition: true },
    { filter: "uncaught", label: "Uncaught exceptions", default: true },
    { label: "no id" },
  ]);
  assert.equal(filters.length, 2);
  assert.deepEqual(exceptionBreakpointsArgs(filters, {}, false), { filters: ["uncaught"] });
  assert.deepEqual(
    exceptionBreakpointsArgs(
      filters,
      { raised: { enabled: true, condition: "ValueError" }, uncaught: { enabled: false } },
      true,
    ),
    { filters: [], filterOptions: [{ filterId: "raised", condition: "ValueError" }] },
  );
});

test("function and data breakpoints: kept, renamed, saved; data ones end with their session", () => {
  const o = new OtherBreakpoints();
  o.addFunction("render", { condition: "x > 1" });
  o.addFunction("render");
  assert.equal(o.functions.peek().length, 1);
  assert.equal(o.functions.peek()[0]?.condition, undefined);
  assert.throws(() => o.addFunction("  "), /name/);
  o.addData({ dataId: "d1", description: "count", accessType: "write", sessionId: "s1" });
  o.addData({ dataId: "d1", description: "count", accessType: "write", sessionId: "s1" });
  assert.equal(o.data.peek().length, 1);
  o.filters.value = parseExceptionFilters([
    { filter: "uncaught", label: "Uncaught", default: true },
  ]);
  assert.equal(o.filterOn("uncaught"), true);
  o.setFilter("uncaught", { enabled: false, condition: " E " });
  assert.deepEqual(o.filterChoices.peek().uncaught, { enabled: false, condition: "E" });
  const saved = JSON.parse(JSON.stringify(o.save()));
  o.sessionEnded("s1");
  assert.equal(o.data.peek().length, 0);
  const p = new OtherBreakpoints();
  p.restore(saved);
  assert.deepEqual(
    p.functions.peek().map((f) => f.name),
    ["render"],
  );
  assert.equal(p.filterOn("uncaught"), false);
  assert.equal(p.data.peek().length, 0);
});

test("function breakpoints in Node: declarations found, calls not", () => {
  const src = [
    "function add(a, b) {",
    "  return a + b;",
    "}",
    "const mul = (a, b) => a * b;",
    "class Cart {",
    "  total(items) {",
    "    return add(1, 2);",
    "  }",
    "}",
    "add(1, 2);",
    "obj.render = function () { return 1; };",
  ].join("\n");
  assert.deepEqual(findFunctionDeclarations(src, "add"), [{ line: 1, column: 2 }]);
  assert.deepEqual(findFunctionDeclarations(src, "mul"), [{ line: 3, column: 22 }]);
  assert.deepEqual(findFunctionDeclarations(src, "Cart.total"), [{ line: 6, column: 4 }]);
  assert.deepEqual(findFunctionDeclarations(src, "render"), [{ line: 10, column: 27 }]);
  assert.deepEqual(findFunctionDeclarations(src, "missing"), []);
  assert.deepEqual(findFunctionDeclarations(src, "a b"), []);
});

test("processes: ps and PowerShell listings, inspector ports, Node first", () => {
  const ps = parsePs(
    "    1     0 /sbin/init\n  420     1 [kworker/0:1]\n 5150   300 node --inspect=127.0.0.1:9230 server.js\n 5151   300 /usr/bin/python3 app.py\nbad line\n",
  );
  assert.deepEqual(
    ps.map((p) => [p.pid, p.ppid, p.name]),
    [
      [1, 0, "init"],
      [420, 1, "[kworker/0:1]"],
      [5150, 300, "node"],
      [5151, 300, "python3"],
    ],
  );
  const win = parseWindowsProcesses(
    JSON.stringify([
      { ProcessId: 4, ParentProcessId: 0, Name: "System", CommandLine: null },
      {
        ProcessId: 812,
        ParentProcessId: 40,
        Name: "node.exe",
        CommandLine: '"C:\\Program Files\\nodejs\\node.exe" --inspect-brk app.js',
      },
    ]),
  );
  assert.deepEqual(
    win.map((p) => [p.pid, p.name, p.command]),
    [
      [4, "System", "System"],
      [812, "node.exe", '"C:\\Program Files\\nodejs\\node.exe" --inspect-brk app.js'],
    ],
  );
  // One process comes as an object; garbage as nothing.
  assert.equal(parseWindowsProcesses('{"ProcessId": 9, "Name": "a.exe"}').length, 1);
  assert.deepEqual(parseWindowsProcesses("not json"), []);
  assert.equal(programName('"C:\\a b\\node.exe" x'), "node.exe");
  assert.equal(inspectPort("node --inspect app.js"), 9229);
  assert.equal(inspectPort("node --inspect-brk=0.0.0.0:9333 app.js"), 9333);
  assert.equal(inspectPort("node --inspect=9444"), 9444);
  assert.equal(inspectPort("node --inspect-port=9555 app.js"), 9555);
  assert.equal(inspectPort("node app.js --inspector"), null);
  const rows = processChoices([...ps, ...win], 1);
  assert.deepEqual(
    rows.map((r) => r.pid),
    [812, 5150, 4, 5151],
  );
  assert.equal(rows[1]?.port, 9230);
});

test("auto-attach: NODE_OPTIONS quoting, registrations, parents", () => {
  assert.equal(
    nodeOptionsWith(undefined, "C:\\Users\\A B\\boot.js"),
    '--require "C:\\\\Users\\\\A B\\\\boot.js"',
  );
  assert.equal(
    nodeOptionsWith("--max-old-space-size=4096", "/d/boot.js"),
    '--require "/d/boot.js" --max-old-space-size=4096',
  );
  const twice = nodeOptionsWith(nodeOptionsWith("", "/d/b.js"), "/d/b.js");
  assert.equal(twice, '--require "/d/b.js"');
  const env = autoAttachEnv({ FOO: "1" }, { dir: "/r", bootloader: "/b.js" }, "always");
  assert.equal(env.IDE_DEBUG_ATTACH, "/r");
  assert.equal(env.IDE_DEBUG_ATTACH_MODE, "always");
  assert.match(env.NODE_OPTIONS ?? "", /\$\{env:NODE_OPTIONS\}$/);
  const reg = parseRegistration(
    JSON.stringify({ pid: 12, ppid: 7, url: "ws://127.0.0.1:4000/abc", script: "/w/child.js" }),
  );
  assert.ok(reg);
  assert.equal(registrationName(reg as never), "child.js [12]");
  assert.equal(parseRegistration(JSON.stringify({ pid: 1, url: "ws://example.com:1/x" })), null);
  assert.equal(parseRegistration("{"), null);
  assert.equal(parentFor(reg as never, [{ id: "s1", pid: 7 }], "s9"), "s1");
  assert.equal(parentFor(reg as never, [{ id: "s1", pid: 8 }], "s9"), "s9");
  assert.equal(wantsChildAttach({}, undefined), true);
  assert.equal(wantsChildAttach({ autoAttachChildProcesses: false }, undefined), false);
  assert.equal(wantsChildAttach({}, "bun"), false);
  assert.equal(isPackageManager("npm"), true);
  assert.equal(isPackageManager("C:\\nodejs\\pnpm.cmd"), true);
  assert.equal(isPackageManager("node"), false);
});

test("a package manager's command line quotes words so sh doesn't expand them", () => {
  assert.equal(shellWord("run", false), "run");
  assert.equal(shellWord("app/routes/posts.$id.tsx", false), "'app/routes/posts.$id.tsx'");
  assert.equal(shellWord("it's `x`", false), "'it'\\''s `x`'");
  // PowerShell (Windows) expands $(…) inside double quotes: single quotes there too.
  assert.equal(shellWord("a b", true), "'a b'");
  assert.equal(shellWord("C:\\w\\$(calc).js", true), "'C:\\w\\$(calc).js'");
  assert.equal(shellLine(["npm", "run", "dev"], true), "npm run dev");
  assert.equal(
    shellLine(["C:\\Program Files\\nodejs\\npm.cmd", "run"], true),
    "& 'C:\\Program Files\\nodejs\\npm.cmd' run",
  );
  // The automation profile's shell (D209): its own quoting, no PowerShell `&`.
  assert.equal(
    shellLine(["C:\\Program Files\\nodejs\\node.exe", "a b.js"], true, "cmd"),
    '"C:\\Program Files\\nodejs\\node.exe" "a b.js"',
  );
  assert.equal(shellLine(["node", "it's.js"], true, "posix"), "node 'it'\\''s.js'");
});

test("serverReadyAction: patterns, ports, addresses, split lines", () => {
  const s = parseServerReady({ action: "debugWithChrome" });
  assert.ok(s);
  if (!s) return;
  assert.equal(serverReadyUri("Server listening on port 3000", s), "http://localhost:3000");
  assert.equal(
    serverReadyUri("\u001b[32mlistening on\u001b[0m http://127.0.0.1:8080/", s),
    "http://127.0.0.1:8080/",
  );
  const vite = parseServerReady({ pattern: "Local:\\s+(https?://\\S+)", uriFormat: "%s" });
  assert.equal(
    vite && serverReadyUri("  ➜  Local:   http://localhost:5173/", vite),
    "http://localhost:5173/",
  );
  let r = feedServerReady("", "listening on port 30", s);
  assert.equal(r.uri, null);
  r = feedServerReady(r.tail, "00\n", s);
  assert.equal(r.uri, "http://localhost:3000");
  assert.equal(parseServerReady({ pattern: "(" }), null);
  assert.equal(parseServerReady({ action: "startDebugging", name: "Web" })?.name, "Web");
});

test("add configuration: inserted into configurations, compounds created, comments kept", () => {
  const node = CONFIG_SNIPPETS.find((c) => c.label === "Node.js: Attach");
  const compound = CONFIG_SNIPPETS.find((c) => c.into === "compounds");
  assert.ok(node && compound);
  if (!node || !compound) return;
  const text = `{
  // mine
  "version": "0.2.0",
  "configurations": [
    {
      "name": "A", // the first
      "type": "node"
    }
  ]
}
`;
  const once = insertSnippet(text, node) ?? "";
  assert.match(once, /\/\/ the first/);
  const parsed = JSON.parse(once.replace(/\/\/.*$/gm, "")) as {
    configurations: { name: string }[];
  };
  assert.deepEqual(
    parsed.configurations.map((c) => c.name),
    ["A", "Attach"],
  );
  const withCompound = insertSnippet(once, compound) ?? "";
  const p2 = JSON.parse(withCompound.replace(/\/\/.*$/gm, "")) as { compounds: { name: string }[] };
  assert.equal(p2.compounds[0]?.name, "Server and client");
  const empty = insertSnippet('{ "configurations": [] }', node) ?? "";
  assert.equal((JSON.parse(empty) as { configurations: unknown[] }).configurations.length, 1);
  const fresh = insertSnippet("", node) ?? "";
  assert.match(fresh, /"compounds": \[\]/);
  assert.equal(insertSnippet("[1, 2]", node), null);
});

test("presets: Go (Delve over a port), .NET (netcoredbg), Java explained", () => {
  const tools = { python: "python3", lldbDap: "lldb-dap", gdb: "gdb" };
  const go = toConfig({ name: "g", type: "go", request: "launch", program: "/w" }, "x", v);
  const goAdapter = go && adapterFor(go, tools);
  assert.equal(goAdapter?.kind === "dap" && goAdapter.listen, true);
  assert.deepEqual(goAdapter?.kind === "dap" && goAdapter.args, [
    "dap",
    "--listen=127.0.0.1:{port}",
  ]);
  assert.equal(go && dapLaunchArguments(go).mode, "debug");
  const net = toConfig(
    { name: "n", type: "coreclr", request: "launch", stopOnEntry: true },
    "x",
    v,
  );
  const netAdapter = net && adapterFor(net, { ...tools, netcoredbg: "/opt/netcoredbg" });
  assert.equal(netAdapter?.kind === "dap" && netAdapter.command, "/opt/netcoredbg");
  assert.equal(net && dapLaunchArguments(net).stopAtEntry, true);
  const java = toConfig({ name: "j", type: "java", request: "launch" }, "x", v);
  assert.throws(() => java && adapterFor(java, tools), /java-debug/);
  const post = toConfig(
    { name: "p", type: "node", request: "launch", postDebugTask: "clean", serverReadyAction: {} },
    "x",
    v,
  );
  assert.equal(post?.postDebugTask, "clean");
  assert.equal(post && "serverReadyAction" in dapLaunchArguments(post), false);
});

test("browser pane: only the pane's frame, never the IDE's own page", () => {
  const targets = [
    {
      type: "page",
      url: "http://tauri.localhost/",
      webSocketDebuggerUrl: "ws://127.0.0.1:9333/ide",
    },
    {
      type: "iframe",
      url: "http://127.0.0.1:5555/index.html",
      webSocketDebuggerUrl: "ws://127.0.0.1:9333/f",
    },
  ];
  assert.equal(pickFrameTarget(targets, "http://127.0.0.1:5555"), "ws://127.0.0.1:9333/f");
  assert.equal(pickFrameTarget(targets, "http://127.0.0.1:6666"), null);
  assert.equal(pickFrameTarget(targets, ""), null);
});

/** A scripted DAP adapter (as in session.test.ts). */
function fakeAdapter(
  answer: (command: string, reply: (body?: Record<string, unknown>) => void) => void,
) {
  const incoming = new Emitter<string>();
  const sent: { command: string; arguments?: Record<string, unknown> }[] = [];
  let seq = 1000;
  const event = (name: string, body: Record<string, unknown> = {}) =>
    queueMicrotask(() =>
      incoming.fire(JSON.stringify({ seq: seq++, type: "event", event: name, body })),
    );
  const transport = {
    onMessage: incoming.event,
    send(raw: string): void {
      const msg = JSON.parse(raw) as {
        seq: number;
        type: string;
        command: string;
        arguments?: Record<string, unknown>;
      };
      if (msg.type !== "request") return;
      sent.push({ command: msg.command, ...(msg.arguments ? { arguments: msg.arguments } : {}) });
      answer(msg.command, (body = {}) =>
        queueMicrotask(() =>
          incoming.fire(
            JSON.stringify({
              seq: seq++,
              type: "response",
              request_seq: msg.seq,
              command: msg.command,
              success: true,
              body,
            }),
          ),
        ),
      );
      if (msg.command === "launch") event("initialized");
    },
  };
  return { dap: new DapConnection(transport, async () => ({})), sent, event };
}

test("DAP: capabilities, function breakpoints and filters before configurationDone, events", async () => {
  const { dap, sent, event } = fakeAdapter((command, reply) => {
    if (command === "initialize")
      reply({
        supportsConfigurationDoneRequest: true,
        supportsFunctionBreakpoints: true,
        supportsDataBreakpoints: true,
        supportsExceptionInfoRequest: true,
        supportsExceptionFilterOptions: true,
        exceptionBreakpointFilters: [
          { filter: "raised", label: "Raised", supportsCondition: true },
          { filter: "uncaught", label: "Uncaught", default: true },
        ],
      });
    else if (command === "setFunctionBreakpoints") reply({ breakpoints: [{ verified: true }] });
    else if (command === "exceptionInfo")
      reply({ exceptionId: "E", breakMode: "always", details: { message: "m" } });
    else if (command === "dataBreakpointInfo") reply({ dataId: "x@1", description: "x" });
    else reply();
  });
  const s = new DapSession(dap, {
    adapterId: "t",
    request: "launch",
    arguments: {},
    setup: {
      breakpoints: () => new Map(),
      exceptionStops: () => ({ uncaught: false, caught: false }),
      functionBreakpoints: () => [{ name: "main" }],
      exceptionFilters: (caps) =>
        exceptionBreakpointsArgs(caps.exceptionFilters, {}, caps.exceptionFilterOptions),
    },
    kill: async () => {},
  });
  const continued: unknown[] = [];
  s.onContinued((e) => continued.push(e));
  const threadEvents: unknown[] = [];
  s.onThread((e) => threadEvents.push(e));
  await s.start();
  const order = sent.map((m) => m.command);
  assert.ok(order.indexOf("setFunctionBreakpoints") < order.indexOf("configurationDone"));
  assert.deepEqual(sent.find((m) => m.command === "setExceptionBreakpoints")?.arguments, {
    filters: [],
    filterOptions: [{ filterId: "uncaught" }],
  });
  const caps = s.capabilities();
  assert.equal(caps.dataBreakpoints, true);
  assert.equal(caps.exceptionFilters.length, 2);
  assert.equal((await s.exceptionInfo(1))?.message, "m");
  assert.equal((await s.dataBreakpointInfo(5, "x")).dataId, "x@1");
  event("continued", { threadId: 2, allThreadsContinued: false });
  event("thread", { reason: "started", threadId: 3 });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(continued, [{ threadId: 2, all: false }]);
  assert.deepEqual(threadEvents, [{ reason: "started", threadId: 3 }]);
});
