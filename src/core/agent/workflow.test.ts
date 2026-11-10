import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentCallKey,
  CallCache,
  Limiter,
  parallel,
  parseJsonAnswer,
  parseWorkflowScript,
  pipeline,
  readLiteral,
  schemaIssues,
  schemaProblem,
  usageLine,
  type WorkflowAgentRecord,
  WorkflowRuntime,
  workflowEndText,
  workflowLimits,
} from "./workflow";

const SCRIPT = `// A review
export const meta = {
  name: 'review-changes',
  description: "Review changed files, verify each finding",
  phases: [{ title: 'Review', detail: \`each dimension\` }, { title: "Verify", }],
  count: -1.5e2, hex: 0x1F, ok: true, none: null, // trailing
  /* block */ 'quoted key': 'it\\'s',
};
const r = await agent('x')
return r`;

test("meta is read as a literal; the body keeps the script's line numbers", () => {
  const parsed = parseWorkflowScript(SCRIPT);
  assert.ok(parsed.ok);
  assert.equal(parsed.meta.name, "review-changes");
  assert.equal(parsed.meta.description, "Review changed files, verify each finding");
  assert.deepEqual(parsed.meta.phases, [
    { title: "Review", detail: "each dimension" },
    { title: "Verify" },
  ]);
  const lines = parsed.body.split("\n");
  assert.equal(lines.length, SCRIPT.split("\n").length);
  assert.equal(lines[8], "const r = await agent('x')");
  assert.equal(lines.slice(0, 8).join("").trim(), "");
});

test("literal values: numbers, escapes, nesting", () => {
  const text = `{ a: [1, -2, .5, 1_000, 0b11], b: { c: "\\u0041\\x42\\n" }, d: \`plain\` }`;
  const { value, end } = readLiteral(text, 0);
  assert.deepEqual(value, { a: [1, -2, 0.5, 1000, 3], b: { c: "AB\n" }, d: "plain" });
  assert.equal(end, text.length);
});

test("anything but a pure literal in meta is refused", () => {
  const bad = [
    "export const meta = { name: NAME, description: 'd' }",
    "export const meta = { name: 'n', description: describe() }",
    "export const meta = { ...base, name: 'n', description: 'd' }",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a script's template, as text
    "export const meta = { name: `n${x}`, description: 'd' }",
    "export const meta = { name, description: 'd' }",
    "export const meta = { [k]: 'n', description: 'd' }",
    "export const meta = { name: 'n', description: 'd', phases: [...list] }",
    "export const meta = { name: 'n', description: 'd' + 'e' }",
    // A code point past U+10FFFF is a bad escape, not a thrown RangeError.
    "export const meta = { name: '\\u{110000}', description: 'd' }",
  ];
  for (const script of bad) {
    const parsed = parseWorkflowScript(`${script}\nreturn 1`);
    assert.equal(parsed.ok, false, script);
    if (!parsed.ok) assert.match(parsed.error, /^Bad meta/, script);
  }
});

test("meta must come first and name and description are required", () => {
  const first = parseWorkflowScript(
    "const x = 1\nexport const meta = { name: 'n', description: 'd' }",
  );
  assert.equal(first.ok, false);
  if (!first.ok) assert.match(first.error, /must begin with/);
  const noDescription = parseWorkflowScript("export const meta = { name: 'n' }");
  assert.equal(noDescription.ok, false);
  if (!noDescription.ok) assert.match(noDescription.error, /description/);
  const badPhase = parseWorkflowScript(
    "export const meta = { name: 'n', description: 'd', phases: ['x'] }",
  );
  assert.equal(badPhase.ok, false);
  // A leading comment is fine.
  assert.ok(
    parseWorkflowScript("/* hi */\n// there\nexport const meta={name:'n',description:'d'}").ok,
  );
});

test("parallel waits for every thunk, a throwing one is null, and the limit holds", async () => {
  let running = 0;
  let most = 0;
  const thunk =
    (v: number, fail = false) =>
    async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      if (fail) throw new Error("no");
      return v;
    };
  const out = await parallel([thunk(1), thunk(2, true), thunk(3), thunk(4)], { limit: 2 });
  assert.deepEqual(out, [1, null, 3, 4]);
  assert.equal(most, 2);
  await assert.rejects(parallel("nope" as unknown), TypeError);
  await assert.rejects(parallel(new Array(5000).fill(() => 1)), RangeError);
});

test("pipeline: no barrier between stages; a throwing stage drops that item", async () => {
  const order: string[] = [];
  const out = await pipeline(
    ["slow", "fast", "bad"],
    async (prev: unknown, _item: unknown, i: number) => {
      await new Promise((r) => setTimeout(r, prev === "slow" ? 30 : 1));
      order.push(`1:${String(prev)}`);
      if (prev === "bad") throw new Error("x");
      return `${String(prev)}#${i}`;
    },
    (prev: unknown, item: unknown) => {
      order.push(`2:${String(item)}`);
      return `${String(prev)}!`;
    },
  );
  assert.deepEqual(out, ["slow#0!", "fast#1!", null]);
  // The fast item finished both stages before the slow one finished its first.
  assert.ok(order.indexOf("2:fast") < order.indexOf("1:slow"));
  assert.ok(!order.includes("2:bad"));
});

test("the cache key ignores label and phase; each cached result is used once", () => {
  assert.equal(
    agentCallKey("p", { label: "a", phase: "x", model: "m" }),
    agentCallKey("p", { model: "m", label: "b" }),
  );
  assert.notEqual(agentCallKey("p", {}), agentCallKey("p", { model: "m" }));
  assert.equal(
    agentCallKey("p", { schema: { b: 1, a: 2 } }),
    agentCallKey("p", { schema: { a: 2, b: 1 } }),
  );
  const cache = new CallCache([
    { key: "k", value: 1 },
    { key: "k", value: 2 },
  ]);
  assert.deepEqual(cache.take("k"), { value: 1 });
  assert.deepEqual(cache.take("k"), { value: 2 });
  assert.equal(cache.take("k"), null);
});

const limits = { maxAgents: 3, concurrency: 2, timeoutMs: 60_000 };

test("the runtime: concurrency, the agent limit, failures are null", async () => {
  let running = 0;
  let most = 0;
  const runtime = new WorkflowRuntime(limits, async (prompt, _o, record) => {
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    record.inputTokens += 100;
    record.outputTokens += 10;
    return prompt === "fail" ? null : `answer to ${prompt}`;
  });
  const out = await Promise.all([
    runtime.call("a", { label: "A", phase: "One" }),
    runtime.call("fail", {}),
    runtime.call("c", {}),
  ]);
  assert.deepEqual(out, ["answer to a", null, "answer to c"]);
  assert.equal(most, 2);
  assert.deepEqual(
    runtime.agents.map((a) => [a.label, a.status, a.phase]),
    [
      ["A", "done", "One"],
      ["fail", "failed", null],
      ["c", "done", null],
    ],
  );
  await assert.rejects(runtime.call("d", {}), /limit of 3 agents/);
  assert.equal(usageLine(runtime.agents), "3 agents · 330 tokens");
});

test("a resumed run returns unchanged calls from the cache and runs only the changed ones", async () => {
  const ran: string[] = [];
  const runner = async (prompt: string) => {
    ran.push(prompt);
    return `r:${prompt}`;
  };
  const first = new WorkflowRuntime(limits, runner);
  await first.call("one", {});
  await first.call("two", { model: "m" });
  const second = new WorkflowRuntime(limits, runner, new CallCache(first.results));
  ran.length = 0;
  assert.equal(await second.call("one", { label: "renamed" }), "r:one");
  assert.equal(await second.call("two", { model: "other" }), "r:two");
  assert.deepEqual(ran, ["two"]);
  assert.deepEqual(
    second.agents.map((a) => a.status),
    ["cached", "done"],
  );
  // Cached calls don't count against the agent limit.
  assert.equal(second.liveCount, 1);
});

test("a schema's answer is parsed and checked, asked once more when invalid", async () => {
  const schema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  };
  const answers = ["not json", '```json\n{"ok": true}\n```'];
  const asked: string[] = [];
  const runtime = new WorkflowRuntime(limits, async (prompt) => {
    asked.push(prompt);
    return answers.shift() ?? null;
  });
  assert.deepEqual(await runtime.call("judge", { schema }), { ok: true });
  assert.equal(asked.length, 2);
  assert.match(asked[0] ?? "", /JSON Schema/);
  assert.match(asked[1] ?? "", /not valid: it isn't JSON/);
  // Twice wrong: null.
  const wrong = new WorkflowRuntime(limits, async () => '{"ok": "yes"}');
  assert.equal(await wrong.call("judge", { schema }), null);
  assert.match(wrong.agents[0]?.error ?? "", /expected boolean/);
  // An unusable schema throws at agent().
  await assert.rejects(runtime.call("x", { schema: { type: "string" } }), /root must be/);
});

test("stopping refuses queued and later calls", async () => {
  let release: () => void = () => {};
  const runtime = new WorkflowRuntime(
    { ...limits, concurrency: 1 },
    () =>
      new Promise((r) => {
        release = () => r("late");
      }),
  );
  const a = runtime.call("a", {});
  const b = runtime.call("b", {});
  await new Promise((r) => setTimeout(r, 0));
  runtime.stop("Stopped by the user.");
  release();
  assert.equal(await a, null);
  await assert.rejects(b, /Stopped/);
  await assert.rejects(runtime.call("c", {}), /Stopped/);
  assert.deepEqual(
    runtime.agents.map((x) => x.status),
    ["stopped", "stopped"],
  );
});

test("the limiter", async () => {
  const l = new Limiter(1);
  const r1 = await l.acquire();
  let got = false;
  const p = l.acquire().then((r) => {
    got = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(got, false);
  r1();
  (await p)();
  assert.equal(l.running, 0);
});

test("schemas: the subset checked", () => {
  const schema = {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: { file: { type: "string" }, line: { type: "integer", minimum: 1 } },
          required: ["file"],
          additionalProperties: false,
        },
      },
      kind: { enum: ["a", "b"] },
    },
    required: ["findings"],
  };
  assert.deepEqual(schemaIssues({ findings: [{ file: "x", line: 2 }], kind: "a" }, schema), []);
  assert.deepEqual(schemaIssues({ findings: [{ line: 0, extra: 1 }], kind: "c" }, schema), [
    "/findings/0/file: required",
    "/findings/0/line: below 1",
    "/findings/0/extra: not allowed",
    '/kind: expected one of ["a","b"]',
  ]);
  assert.deepEqual(schemaIssues([], schema), ["(answer): expected object"]);
  assert.equal(
    schemaProblem({ type: "object", properties: {}, required: ["x"] }),
    "required names properties it doesn't have: x.",
  );
  assert.equal(schemaProblem(schema), null);
  assert.deepEqual(parseJsonAnswer('Here: {"a": 1} done'), { ok: true, value: { a: 1 } });
});

test("limits from settings stay in range", () => {
  assert.deepEqual(workflowLimits({}), {
    maxAgents: 10,
    concurrency: 4,
    timeoutMs: 30 * 60_000,
    maxEditing: 3,
  });
  assert.deepEqual(workflowLimits({ maxAgents: 0, concurrency: 99, timeoutMinutes: 2.5 }), {
    maxAgents: 1,
    concurrency: 16,
    timeoutMs: 2 * 60_000,
    maxEditing: 3,
  });
});

test("the end message carries the result, the failures and how to resume", () => {
  const agents: WorkflowAgentRecord[] = [
    {
      n: 1,
      label: "a",
      phase: null,
      status: "done",
      inputTokens: 1000,
      outputTokens: 500,
      cost: 0.5,
    },
    {
      n: 2,
      label: "b",
      phase: null,
      status: "failed",
      inputTokens: 0,
      outputTokens: 0,
      cost: null,
      error: "boom",
    },
  ];
  const text = workflowEndText({
    id: "wf1",
    name: "demo",
    status: "done",
    result: '{"x":1}',
    agents,
    durationMs: 65_000,
    logs: ["hello"],
  });
  assert.match(
    text,
    /^Workflow wf1 \(demo\) finished after 1m 5s: 2 agents · 1\.5k tokens · \$0\.50\./,
  );
  assert.match(text, /b \(boom\)/);
  assert.match(text, /Its result:\n\{"x":1\}/);
  assert.match(text, /resume_from: "wf1"/);
});
