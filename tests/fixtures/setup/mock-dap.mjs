// A scripted debug adapter (DAP over stdio) for tests/scripts/debug-m7-5.jsonc: two threads
// ("main" running, "worker" stopped at line 2 of `program` once configured), function and data
// breakpoints, the adapter's own exception filters, exceptionInfo, loadedSources and disassemble.
// Each `continue` moves the worker on: to a data breakpoint stop when one is set, then to a
// "raised" exception stop when that filter is on, then the program ends. D229 (debug-m7-8):
// disassemble from any address and offset (4-byte "instructions"), instruction breakpoints,
// stepping granularity (`evaluate "granularity"` says the last one), and with `"spawnChild": true`
// in the launch arguments a `startDebugging` request for a child session. m7-32
// (debug-extras-m7-32): step-in targets (two calls on the stopped line; `evaluate "stepInTarget"`
// says which was stepped into).
import process from "node:process";

let buffer = Buffer.alloc(0);
let seq = 1;
let program = "";
let filters = { filters: [] };
let dataBreakpoints = [];
let functionBreakpoints = [];
let instructionBreakpoints = [];
let lastGranularity = "none";
let lastStepInTarget = "none";
let launchArgs = {};
let childAnswer = "none";
let phase = "start";
const stopped = new Set();

function send(message) {
  const body = Buffer.from(JSON.stringify({ seq: seq++, ...message }), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
const event = (name, body = {}) => send({ type: "event", event: name, body });
const reply = (req, body = {}) =>
  send({ type: "response", request_seq: req.seq, command: req.command, success: true, body });

function stop(threadId, reason, extra = {}) {
  stopped.add(threadId);
  event("stopped", { reason, threadId, allThreadsStopped: false, ...extra });
}

function line() {
  return phase === "data" ? 3 : phase === "exception" ? 4 : 2;
}

function handle(req) {
  if (req.type === "response") {
    if (req.command === "startDebugging") childAnswer = req.success ? "ok" : "failed";
    return;
  }
  const a = req.arguments ?? {};
  switch (req.command) {
    case "initialize":
      reply(req, {
        supportsConfigurationDoneRequest: true,
        supportsFunctionBreakpoints: true,
        supportsConditionalBreakpoints: true,
        supportsDataBreakpoints: true,
        supportsExceptionInfoRequest: true,
        supportsExceptionFilterOptions: true,
        supportsLoadedSourcesRequest: true,
        supportsDisassembleRequest: true,
        supportsInstructionBreakpoints: true,
        supportsSteppingGranularity: true,
        supportsStepInTargetsRequest: true,
        exceptionBreakpointFilters: [
          { filter: "raised", label: "Raised exceptions", default: false, supportsCondition: true },
          { filter: "uncaught", label: "Uncaught exceptions", default: true },
        ],
      });
      return;
    case "launch":
      program = String(a.program ?? "");
      launchArgs = a;
      reply(req);
      event("initialized");
      return;
    case "setBreakpoints":
      reply(req, {
        breakpoints: (a.breakpoints ?? []).map((b, i) => ({
          id: i + 1,
          verified: true,
          line: b.line,
        })),
      });
      return;
    case "setFunctionBreakpoints":
      functionBreakpoints = a.breakpoints ?? [];
      reply(req, { breakpoints: functionBreakpoints.map(() => ({ verified: true })) });
      return;
    case "setExceptionBreakpoints":
      filters = a;
      reply(req);
      return;
    case "dataBreakpointInfo":
      reply(req, { dataId: `data:${a.name}`, description: a.name, accessTypes: ["write"] });
      return;
    case "setDataBreakpoints":
      dataBreakpoints = a.breakpoints ?? [];
      reply(req, { breakpoints: dataBreakpoints.map(() => ({ verified: true })) });
      return;
    case "configurationDone":
      reply(req);
      event("thread", { reason: "started", threadId: 1 });
      event("thread", { reason: "started", threadId: 2 });
      setTimeout(() => stop(2, "breakpoint"), 100);
      if (launchArgs.spawnChild === true)
        setTimeout(
          () =>
            send({
              type: "request",
              command: "startDebugging",
              arguments: {
                request: "launch",
                configuration: { name: "Mock child", program, childOf: process.pid },
              },
            }),
          200,
        );
      return;
    case "threads":
      reply(req, {
        threads: [
          { id: 1, name: "main" },
          { id: 2, name: "worker" },
        ],
      });
      return;
    case "stackTrace":
      reply(req, {
        stackFrames: [
          {
            id: a.threadId * 100,
            name: a.threadId === 2 ? "work" : "main",
            source: { path: program, name: program.split(/[\\/]/).pop() },
            line: a.threadId === 2 ? line() : 1,
            column: 1,
            instructionPointerReference: "0x1000",
          },
        ],
        totalFrames: 1,
      });
      return;
    case "scopes":
      reply(req, { scopes: [{ name: "Locals", variablesReference: 7, expensive: false }] });
      return;
    case "variables":
      reply(req, {
        variables: [{ name: "counter", value: "1", type: "int", variablesReference: 0 }],
      });
      return;
    case "evaluate":
      reply(req, {
        result:
          a.expression === "filters"
            ? JSON.stringify(filters)
            : a.expression === "granularity"
              ? lastGranularity
              : a.expression === "stepInTarget"
                ? lastStepInTarget
                : a.expression === "instructionBreakpoints"
                  ? JSON.stringify(instructionBreakpoints)
                  : a.expression === "child"
                    ? childAnswer
                    : a.expression === "launchArgs"
                      ? JSON.stringify(launchArgs)
                      : "42",
        variablesReference: 0,
      });
      return;
    case "exceptionInfo":
      reply(req, {
        exceptionId: "ValueError",
        description: "ValueError: bad value",
        breakMode: "always",
        details: {
          message: "bad value",
          stackTrace: "at work (client.js:4)\nat main (client.js:1)",
        },
      });
      return;
    case "loadedSources":
      reply(req, { sources: [{ name: program.split(/[\\/]/).pop(), path: program }] });
      return;
    case "disassemble": {
      // 4-byte instructions from 0x800 to 0x1800; "??" outside (as adapters answer past memory).
      const base = Number(a.memoryReference ?? 0) + (a.instructionOffset ?? 0) * 4;
      reply(req, {
        instructions: Array.from({ length: Math.min(a.instructionCount ?? 10, 400) }, (_, i) => {
          const n = base + i * 4;
          const inside = n >= 0x800 && n < 0x1800;
          return {
            address: `0x${n.toString(16)}`,
            instruction: !inside ? "??" : n === 0x1000 ? "call work" : "nop",
            ...(inside && { instructionBytes: "90" }),
          };
        }),
      });
      return;
    }
    case "setInstructionBreakpoints":
      instructionBreakpoints = (a.breakpoints ?? []).map((b) => b.instructionReference);
      reply(req, { breakpoints: instructionBreakpoints.map(() => ({ verified: true })) });
      return;
    case "pause":
      reply(req);
      stop(a.threadId, "pause");
      return;
    case "continue": {
      reply(req, { allThreadsContinued: true });
      stopped.clear();
      const raised =
        (filters.filters ?? []).includes("raised") ||
        (filters.filterOptions ?? []).some((f) => f.filterId === "raised");
      setTimeout(() => {
        if (phase === "start" && dataBreakpoints.length) {
          phase = "data";
          stop(2, "data breakpoint");
        } else if (phase !== "exception" && raised) {
          phase = "exception";
          stop(2, "exception", { text: "bad value" });
        } else {
          event("exited", { exitCode: 0 });
          event("terminated");
        }
      }, 100);
      return;
    }
    case "stepInTargets":
      reply(req, {
        targets: [
          {
            id: 11,
            label: "parse(input)",
            line: line(),
            column: 10,
            endLine: line(),
            endColumn: 22,
          },
          {
            id: 12,
            label: "render(tree)",
            line: line(),
            column: 3,
            endLine: line(),
            endColumn: 30,
          },
        ],
      });
      return;
    case "next":
    case "stepIn":
    case "stepOut":
      if (req.command === "stepIn") lastStepInTarget = String(a.targetId ?? "none");
      lastGranularity = a.granularity ?? "none";
      reply(req);
      setTimeout(() => stop(a.threadId, "step"), 50);
      return;
    case "disconnect":
      reply(req);
      setTimeout(() => process.exit(0), 20);
      return;
    default:
      reply(req);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const m = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString());
    if (!m) {
      buffer = buffer.subarray(end + 4);
      continue;
    }
    const len = Number(m[1]);
    if (buffer.length < end + 4 + len) return;
    const body = buffer.subarray(end + 4, end + 4 + len).toString("utf8");
    buffer = buffer.subarray(end + 4 + len);
    try {
      handle(JSON.parse(body));
    } catch (err) {
      process.stderr.write(`mock-dap: ${err}\n`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
