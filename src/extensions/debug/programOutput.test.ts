import assert from "node:assert/strict";
import { test } from "node:test";
import { toConfig } from "./launch";
import {
  captureProgramOutput,
  capturesOutput,
  PARTIAL_LINE_DELAY,
  ProgramOutput,
} from "./programOutput";

const v = { workspaceFolder: "/w", pathSeparator: "/" };
const config = (extra: Record<string, unknown>) => {
  const c = toConfig(
    { name: "n", type: "node", request: "launch", program: "a.js", ...extra },
    "x",
    v,
  );
  if (!c) throw new Error("no config");
  return c;
};

test("internalConsole and outputCapture std send a Node program's output to the debug console", () => {
  assert.equal(capturesOutput(config({})), false);
  assert.equal(capturesOutput(config({ console: "integratedTerminal" })), false);
  assert.equal(capturesOutput(config({ console: "internalConsole" })), true);
  assert.equal(capturesOutput(config({ outputCapture: "std" })), true);
  assert.equal(capturesOutput(config({ outputCapture: "console" })), false);
});

test("whole lines come out, the rest waits for its end", () => {
  const out = new ProgramOutput();
  assert.equal(out.feed("hel"), null);
  assert.equal(out.feed("lo\r\nwor"), "hello\n");
  assert.equal(out.feed("ld\r\n"), "world\n");
  assert.equal(out.feed("Name? "), null);
  // Without a line break: the console appends what comes next to it.
  assert.equal(out.flush(), "Name? ");
  assert.equal(out.flush(), null);
});

test("Node's inspector messages and escape sequences are left out", () => {
  const out = new ProgramOutput();
  const text = out.feed(
    [
      "Debugger listening on ws://127.0.0.1:9229/abc-def",
      "For help, see: https://nodejs.org/en/docs/inspector",
      "Debugger attached.",
      "\u001b[32mgreen\u001b[39m text",
      "\u001b]0;title\u0007plain",
      "Waiting for the debugger to disconnect...",
      "",
    ].join("\r\n"),
  );
  assert.equal(text, "green text\nplain\n");
  assert.equal(out.feed("Debugger attached.\r\n"), null);
});

test("a carriage-return redraw shows what the terminal would", () => {
  const out = new ProgramOutput();
  assert.equal(out.feed("10%\r50%\r100%\n"), "100%\n");
  // A very long line without its end is let out.
  const long = "x".repeat(20_000);
  assert.equal(out.feed(long), long);
});

test("captured output keeps stdout and stderr apart, inspector lines left out", async () => {
  let listener: ((text: string, stderr: boolean) => void) | null = null;
  let exit: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => {
    exit = r;
  });
  const seen: [string, boolean][] = [];
  captureProgramOutput(
    (l) => {
      listener = l;
      return { dispose: () => (listener = null) };
    },
    exited,
    (text, stderr) => seen.push([text, stderr]),
  );
  const send = (text: string, stderr: boolean) => listener?.(text, stderr);
  send("Debugger listening on ws://127.0.0.1:9229/abc\n", true);
  send("hello\n", false);
  send("\x1b[31moops\x1b[0m\n", true);
  send("\n", false);
  send("Name? ", false);
  exit(0);
  await exited;
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(seen, [
    ["hello\n", false],
    ["oops\n", true],
    ["\n", false],
    ["Name? ", false],
  ]);
  assert.equal(listener, null);
});

test("an unfinished line let out is continued: its carriage returns kept for the console", () => {
  const out = new ProgramOutput();
  assert.equal(out.feed("10%"), null);
  assert.equal(out.flush(), "10%");
  assert.equal(out.feed("\r50%\r100%\ndone\r\n"), "\r50%\r100%\ndone\n");
  // Finished: the next line is drawn on its own again.
  assert.equal(out.feed("a\rb\n"), "b\n");
});

test("a carriage return or a cut escape at a flush's edge waits for what follows", () => {
  const out = new ProgramOutput();
  assert.equal(out.feed("10%\r"), null);
  // The \r stays: the next text redraws the line from its start.
  assert.equal(out.flush(), "10%");
  assert.equal(out.feed("20%\r30%\r"), null);
  assert.equal(out.flush(), "\r20%\r30%");
  // An escape cut at the read's edge isn't shown as text.
  assert.equal(out.feed("\nfoo \x1b[3"), "\n");
  assert.equal(out.flush(), "foo ");
  assert.equal(out.feed("2mbar"), null);
  assert.equal(out.flush(), "bar");
  // At the end, what's left goes (an escape fragment is dropped).
  assert.equal(out.feed("\x1b["), null);
  assert.ok(!out.flush(true));
});

test("a prompt shows within the partial-line delay, even while other output keeps coming", async () => {
  let listener: ((text: string, stderr: boolean) => void) | null = null;
  let exit: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => {
    exit = r;
  });
  const seen: [string, boolean][] = [];
  captureProgramOutput(
    (l) => {
      listener = l;
      return { dispose: () => (listener = null) };
    },
    exited,
    (text, stderr) => seen.push([text, stderr]),
  );
  const send = (text: string, stderr: boolean) => listener?.(text, stderr);
  send("Name? ", false);
  const busy = setInterval(() => send("tick\n", true), 20);
  await new Promise((r) => setTimeout(r, PARTIAL_LINE_DELAY * 2));
  clearInterval(busy);
  assert.ok(seen.some(([t, e]) => t === "Name? " && !e));
  send("Bob\n", false);
  exit(0);
  await exited;
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(seen.some(([t, e]) => t === "Bob\n" && !e));
});
