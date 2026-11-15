import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunResult, SessionEvent } from "../run";
import {
  EXIT,
  endNote,
  exitCodeOf,
  failureRecord,
  jsonLine,
  jsonResult,
  money,
  resultRecord,
  textResult,
  tokens,
} from "./output";

const usage = {
  context: { tokens: 10, limit: 100, estimated: false },
  totals: { requests: 2, input: 20, cacheRead: 0, cacheWrite: 0, output: 5 },
  cost: null,
};
const result = (over: Partial<RunResult> = {}): RunResult => ({
  session: "s1",
  text: "Done.",
  reason: "end",
  usage,
  steps: 2,
  cost: null,
  denied: [],
  pending: [],
  ...over,
});
const refusal = {
  title: "Run `git push`",
  code: "git push",
  answer: "deny" as const,
  by: "policy" as const,
};

test("exit codes: 0 done, 1 failed or limited, 3 refused, 130 interrupted", () => {
  assert.equal(exitCodeOf(result()), 0);
  assert.equal(exitCodeOf(result({ reason: "error", error: "boom" })), 1);
  assert.equal(exitCodeOf(result({ reason: "max_steps" })), 1);
  assert.equal(exitCodeOf(result({ reason: "timeout" })), 1);
  assert.equal(exitCodeOf(result({ reason: "max_cost" })), 1);
  assert.equal(exitCodeOf(result({ reason: "stopped" })), 1);
  assert.equal(exitCodeOf(result({ denied: [refusal] })), 3);
  assert.equal(exitCodeOf(result({ reason: "cancelled" })), 130);
  // A failure outranks a refusal on the way.
  assert.equal(exitCodeOf(result({ reason: "error", denied: [refusal] })), 1);
  assert.equal(EXIT.usage, 2);
});

test("the note on stderr says why a run didn't simply answer", () => {
  assert.equal(endNote(result()), null);
  assert.match(
    endNote(result({ denied: [{ ...refusal, rule: "git push" }] })) ?? "",
    /git push \(denied by git push\)/,
  );
  assert.match(endNote(result({ reason: "error", error: "no route" })) ?? "", /no route/);
  assert.match(endNote(result({ reason: "max_steps" })) ?? "", /--max-steps/);
  assert.match(endNote(result({ reason: "timeout" })) ?? "", /--timeout/);
});

test("text: the answer and one newline, nothing for no answer", () => {
  assert.equal(textResult(result({ text: "Hello\n\n" })), "Hello\n");
  assert.equal(textResult(result({ text: "a\nb" })), "a\nb\n");
  assert.equal(textResult(result({ text: "" })), "");
});

test("json: one object on one line with the result's fields", () => {
  const line = jsonResult(resultRecord(result({ denied: [refusal], text: "multi\nline" }), 1234));
  assert.equal(line.split("\n").length, 2);
  assert.ok(line.endsWith("\n"));
  const parsed = JSON.parse(line);
  assert.deepEqual(
    {
      type: parsed.type,
      ok: parsed.ok,
      exitCode: parsed.exitCode,
      session: parsed.session,
      text: parsed.text,
      reason: parsed.reason,
      steps: parsed.steps,
      durationMs: parsed.durationMs,
    },
    {
      type: "result",
      ok: false,
      exitCode: 3,
      session: "s1",
      text: "multi\nline",
      reason: "end",
      steps: 2,
      durationMs: 1234,
    },
  );
  assert.equal(parsed.denied[0].code, "git push");
  assert.deepEqual(parsed.usage.totals, usage.totals);
  assert.equal("error" in parsed, false);
});

test("a run that never started still gives a result object", () => {
  const failed = failureRecord("config", 2, "No model is available.", 5);
  assert.deepEqual(
    [failed.type, failed.ok, failed.exitCode, failed.session, failed.reason, failed.error],
    ["result", false, 2, null, "config", "No model is available."],
  );
});

test("stream-json: one event per line, newlines inside text escaped, the result last", () => {
  const events: SessionEvent[] = [
    { session: "s1", type: "turn.start" },
    { session: "s1", type: "text", id: "i1", delta: "line one\nline two" },
    {
      session: "s1",
      type: "tool.end",
      id: "i2",
      callId: "c1",
      name: "run_command",
      status: "done",
      summary: "exit 0",
    },
  ];
  const stream =
    events.map(jsonLine).join("") +
    jsonLine(resultRecord(result({ text: "line one\nline two" }), 9));
  const lines = stream.split("\n");
  assert.equal(lines.pop(), "");
  assert.equal(lines.length, 4);
  const parsed = lines.map((l) => JSON.parse(l));
  assert.deepEqual(
    parsed.map((p) => p.type),
    ["turn.start", "text", "tool.end", "result"],
  );
  assert.equal(parsed[1].delta, "line one\nline two");
  assert.equal(parsed[3].ok, true);
});

test("money and token counts, short", () => {
  assert.equal(money(null), "");
  assert.equal(money(0), "$0.00");
  assert.equal(money(0.0123), "$0.0123");
  assert.equal(money(1.2), "$1.20");
  assert.equal(tokens(950), "950");
  assert.equal(tokens(1234), "1.2k");
  assert.equal(tokens(45_600), "46k");
  assert.equal(tokens(2_500_000), "2.5M");
});
