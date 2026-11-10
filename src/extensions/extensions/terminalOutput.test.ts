import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandOutputCapture } from "./terminalOutput";

const C = "\x1b]633;C\x07";
const D = (code: number) => `\x1b]633;D;${code}\x07`;
const PROMPT = "\x1b]633;A\x07PS C:\\> \x1b]633;B\x07";

test("a command's output: from its executed mark to its finished one", () => {
  const sent: string[] = [];
  const capture = new CommandOutputCapture((t) => sent.push(t));
  // The chunk with the mark arrives before the renderer says the command started.
  capture.write(`${PROMPT}npm test\r\n\x1b]633;E;npm test\x07${C}first\r\n`);
  capture.started();
  assert.equal(capture.read(), "first\r\n");
  capture.write("\x1b[32msecond\x1b[0m\r\n");
  capture.write(`third${D(0)}${PROMPT}`);
  capture.ended();
  // Read from the start; later chunks were sent as they came, without the end mark or prompt.
  assert.deepEqual(sent, ["\x1b[32msecond\x1b[0m\r\n", "third"]);
  // After it ended, its output stays readable (once) until the next command.
  assert.equal(capture.read(), "first\r\n\x1b[32msecond\x1b[0m\r\nthird");
  capture.write("ls\r\n");
  capture.write(`${C}a b\r\n${D(1)}`);
  capture.started();
  assert.equal(capture.read(), "a b\r\n");
});

test("nothing is sent before someone reads, nor without a command", () => {
  const sent: string[] = [];
  const capture = new CommandOutputCapture((t) => sent.push(t));
  assert.equal(capture.read(), null);
  capture.write("output with no command\r\n");
  assert.equal(capture.read(), null);
  capture.write(C);
  capture.started();
  capture.write("x");
  assert.deepEqual(sent, []);
  assert.equal(capture.read(), "x");
  capture.write("y");
  assert.deepEqual(sent, ["y"]);
});
