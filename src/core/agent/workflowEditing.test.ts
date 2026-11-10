import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type WorkflowAgentRecord,
  WorkflowRuntime,
  workflowEndText,
  workflowLimits,
} from "./workflow";
import {
  claimPath,
  editingCalls,
  FileClaims,
  maxEditingAgents,
  overlaps,
  pathsOverlap,
  type WorkflowWorktree,
  worktreeLines,
  worktreeResult,
} from "./workflowEditing";

test("editing calls are found in the script's text, with their labels", () => {
  const body = [
    "const a = await agent('fix the parser', { label: 'parser fix', isolation: 'worktree' })",
    'const b = await agent("docs", { isolation: "worktree", label: "docs" })',
    "const c = await agent('read only', { label: 'scout' })",
    "const d = await agent(`x`, {",
    "  isolation: `worktree`,",
    "})",
  ].join("\n");
  assert.deepEqual(editingCalls(body), ["parser fix", "docs", "the agent on line 5"]);
  assert.deepEqual(editingCalls("agent('x', { isolation: 'none' })"), []);
});

test("the editing cap stays in range", () => {
  assert.equal(maxEditingAgents(undefined), 3);
  assert.equal(maxEditingAgents(0), 1);
  assert.equal(maxEditingAgents(50), 10);
  assert.equal(workflowLimits({ maxEditing: 2 }).maxEditing, 2);
});

test("paths overlap when the same, nested, or under a glob's folder", () => {
  assert.equal(claimPath(".\\src\\A.ts"), "src/a.ts");
  assert.equal(claimPath("src/**/*.ts"), "src");
  assert.ok(pathsOverlap("src/a.ts", "./src/a.ts"));
  assert.ok(pathsOverlap("src", "src/a.ts"));
  assert.ok(pathsOverlap("src/**", "src/deep/b.ts"));
  assert.ok(!pathsOverlap("src/a.ts", "src/ab.ts"));
  assert.ok(!pathsOverlap("docs/x.md", "src/x.md"));
  // A whole-tree glob claims everything.
  assert.ok(pathsOverlap("**/*.ts", "src/a.ts"));
});

test("file claims: overlapping ones wait, others go at once, close refuses", async () => {
  const claims = new FileClaims();
  const first = await claims.acquire(["src/a.ts"]);
  const other = await claims.acquire(["docs/b.md"]);
  let second = false;
  const waiting = claims.acquire(["src"]).then((release) => {
    second = true;
    return release;
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(second, false);
  first();
  const release = await waiting;
  assert.equal(second, true);
  release();
  other();
  // Nothing named: nothing claimed.
  const none = await claims.acquire([]);
  none();
  const held = await claims.acquire(["x"]);
  const refused = claims.acquire(["x"]);
  claims.close(new Error("stopped"));
  await assert.rejects(refused, /stopped/);
  held();
  await assert.rejects(claims.acquire(["y"]), /stopped/);
});

const tree = (helper: string, files: string[]): WorkflowWorktree => ({
  helper,
  branch: `agent/${helper}`,
  folder: `/wt/${helper}`,
  files,
  added: files.length * 2,
  removed: 1,
  ended: true,
});

test("an editing agent's value carries its branch and changes", () => {
  assert.deepEqual(worktreeResult("done it", tree("h1", ["a.ts"])), {
    result: "done it",
    branch: "agent/h1",
    folder: "/wt/h1",
    changes: "1 file changed (+2 −1)",
    files: ["a.ts"],
  });
  assert.equal(worktreeResult(null, tree("h2", [])).changes, "no files changed");
});

test("branches that changed the same files are named in the end message", () => {
  const agents = [
    { label: "one", worktree: tree("h1", ["src/a.ts", "b.ts"]) },
    { label: "two", worktree: tree("h2", ["SRC/a.ts"]) },
    { label: "three", worktree: tree("h3", ["c.ts"]) },
    { label: "reader" },
  ];
  assert.deepEqual(overlaps(agents), [{ a: "one", b: "two", files: ["src/a.ts"] }]);
  const lines = worktreeLines(agents);
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /one: branch agent\/h1, 2 files changed/);
  assert.match(lines[0] ?? "", /NOT in this folder/);
  assert.match(lines[1] ?? "", /one and two \(src\/a\.ts\)/);
  assert.deepEqual(worktreeLines([{ label: "reader" }]), []);
});

/** A runner that plays a worktree helper: sets the record's worktree, answers after a tick. */
function fakeHelperRunner(log: string[]) {
  let n = 0;
  return async (prompt: string, opts: { isolation?: string }, record: WorkflowAgentRecord) => {
    log.push(`start ${prompt}`);
    if (opts.isolation === "worktree") {
      n++;
      record.worktree = { ...tree(`h${n}`, []), ended: false };
      await new Promise((r) => setTimeout(r, 5));
      record.worktree = tree(`h${n}`, [`${prompt}.ts`]);
    }
    log.push(`end ${prompt}`);
    return `did ${prompt}`;
  };
}

test("the runtime: editing agents need the script's say-so and return their branch", async () => {
  const log: string[] = [];
  const limits = { ...workflowLimits({}), maxEditing: 2 };
  const refused = new WorkflowRuntime(limits, fakeHelperRunner(log));
  await assert.rejects(refused.call("x", { isolation: "worktree" }), /written in the script/);

  const runtime = new WorkflowRuntime(limits, fakeHelperRunner(log));
  runtime.allowEditing = true;
  const value = (await runtime.call("fix", { isolation: "worktree", label: "fixer" })) as Record<
    string,
    unknown
  >;
  assert.equal(value.result, "did fix");
  assert.equal(value.branch, "agent/h1");
  assert.deepEqual(value.files, ["fix.ts"]);
  // A read-only agent's value is its text, as before.
  assert.equal(await runtime.call("look", {}), "did look");
  await runtime.call("fix2", { isolation: "worktree" });
  // The third editing agent is over the cap; read-only ones still run.
  await assert.rejects(runtime.call("fix3", { isolation: "worktree" }), /limit of 2 editing/);
  assert.equal(await runtime.call("look2", {}), "did look2");
  const text = workflowEndText({
    id: "wf1",
    name: "edit",
    status: "done",
    result: "{}",
    agents: runtime.agents,
    durationMs: 1000,
  });
  assert.match(text, /fixer: branch agent\/h1, 1 file changed/);
});

test("editing agents on the same files run one after the other", async () => {
  const log: string[] = [];
  const runtime = new WorkflowRuntime(workflowLimits({ concurrency: 4 }), fakeHelperRunner(log));
  runtime.allowEditing = true;
  await Promise.all([
    runtime.call("a", { isolation: "worktree", files: ["src/x.ts"] }),
    runtime.call("b", { isolation: "worktree", files: ["src"] }),
    runtime.call("c", { isolation: "worktree", files: ["docs"] }),
  ]);
  // b waited for a (src/x.ts is in src); c didn't wait.
  assert.ok(log.indexOf("end a") < log.indexOf("start b"));
  assert.ok(log.indexOf("start c") < log.indexOf("end a"));
});

test("an editing agent with a schema gets one try (a second would be a second worktree)", async () => {
  let calls = 0;
  const runtime = new WorkflowRuntime(workflowLimits({}), async (_p, _o, record) => {
    calls++;
    record.worktree = tree("h1", ["a.ts"]);
    return "not json";
  });
  runtime.allowEditing = true;
  const schema = { type: "object", properties: { ok: { type: "boolean" } } };
  assert.equal(await runtime.call("x", { isolation: "worktree", schema }), null);
  assert.equal(calls, 1);
  // Its worktree stays on the record (the card offers Review / Merge).
  assert.equal(runtime.agents[0]?.worktree?.branch, "agent/h1");
});

test("stopping the run refuses an editing agent waiting for its files", async () => {
  let release: () => void = () => {};
  const runtime = new WorkflowRuntime(workflowLimits({}), async () => {
    await new Promise<void>((r) => {
      release = r;
    });
    return "ok";
  });
  runtime.allowEditing = true;
  const first = runtime.call("a", { isolation: "worktree", files: ["f"] });
  await new Promise((r) => setTimeout(r, 1));
  const second = runtime.call("b", { isolation: "worktree", files: ["f"] });
  await new Promise((r) => setTimeout(r, 1));
  runtime.stop("Stopped.");
  await assert.rejects(second, /Stopped/);
  release();
  assert.equal(await first, null);
});
