import assert from "node:assert/strict";
import { test } from "node:test";
import { isWithin, rebase } from "../paths/index";
import {
  actsOnWindowFolder,
  changesText,
  finalReply,
  followUpText,
  headlessHelperTask,
  headlessProgress,
  helperBranch,
  helperCap,
  helperOutcome,
  helperPath,
  helperReport,
  helperStatusText,
  helpersInWindows,
  helperTask,
  isolationRefusal,
  MESSAGE_TTL,
  messagesFor,
  NO_REPLY_MS,
  STOP_TTL,
  sanitizeMessages,
  sanitizeStops,
  stopRequested,
  wantsIsolation,
  withMessage,
  withoutMessages,
  withoutStop,
  withStop,
} from "./isolatedHelpers";
import { parseSubagentFile } from "./subagents";

test("isolation: the call's flag wins, else the agent's own setting", () => {
  assert.equal(wantsIsolation(true, {}), true);
  assert.equal(wantsIsolation(false, { isolation: "worktree" }), false);
  assert.equal(wantsIsolation(undefined, { isolation: "worktree" }), true);
  assert.equal(wantsIsolation(undefined, {}), false);
  assert.equal(wantsIsolation("yes", {}), false);
});

test("an agent file's isolation: worktree is read", () => {
  const def = parseSubagentFile(
    "---\nname: forge\ndescription: Builds things\nisolation: Worktree\n---\nBuild it.",
    "project",
  );
  assert.equal(def?.isolation, "worktree");
  const plain = parseSubagentFile(
    "---\nname: forge\ndescription: Builds things\nisolation: none\n---\n",
    "project",
  );
  assert.equal(plain?.isolation, undefined);
});

test("a helper's branch: the agent, then the task's first words", () => {
  assert.equal(
    helperBranch("forge", "Fix the login redirect on Windows!"),
    "agent/forge-fix-the-login-redirect",
  );
  assert.equal(helperBranch("Test_Runner", "..."), "agent/test-runner");
  assert.equal(helperBranch("", ""), "agent/helper");
});

test("the cap: a number from 1 to 10, default 3", () => {
  assert.equal(helperCap(undefined), 3);
  assert.equal(helperCap("5"), 3);
  assert.equal(helperCap(0), 1);
  assert.equal(helperCap(4.7), 4);
  assert.equal(helperCap(99), 10);
});

test("refusals: no git repository, a read-only agent, the cap", () => {
  const ok = { agent: "forge", readOnly: false, gitRepo: true, running: 0, max: 3 };
  assert.equal(isolationRefusal(ok), null);
  assert.match(isolationRefusal({ ...ok, gitRepo: false }) ?? "", /isn't a git repository/);
  assert.match(isolationRefusal({ ...ok, gitRepo: false }) ?? "", /without isolated/);
  assert.match(isolationRefusal({ ...ok, readOnly: true }) ?? "", /only reads/);
  assert.match(isolationRefusal({ ...ok, running: 3 }) ?? "", /3 helpers already work.*is 3/);
  assert.match(isolationRefusal({ ...ok, running: 1, max: 1 }) ?? "", /1 helper already works/);
  assert.match(isolationRefusal({ ...ok, parentReadOnly: true }) ?? "", /can't change files/);
  // No git repository is said first: the cap doesn't matter then.
  assert.match(isolationRefusal({ ...ok, gitRepo: false, running: 9 }) ?? "", /git repository/);
});

test("the final reply: the last answer after the last message the user sent", () => {
  assert.deepEqual(finalReply(null), { replied: false, report: "", error: "" });
  const items = [
    { type: "user", text: "do it" },
    { type: "assistant", text: "Working on it" },
    { type: "tool", name: "edit_file" },
    { type: "assistant", text: " Done: changed a.ts " },
  ];
  assert.deepEqual(finalReply({ items }), {
    replied: true,
    report: "Done: changed a.ts",
    error: "",
  });
  // A new message from the user after it: no answer to that one yet.
  assert.equal(finalReply({ items: [...items, { type: "user", text: "and b?" }] }).replied, false);
  // An automatic message (a subagent's report) doesn't count as a new task.
  assert.equal(
    finalReply({ items: [...items.slice(0, 3), { type: "user", auto: "subagent", text: "r" }] })
      .replied,
    true,
  );
  assert.equal(
    finalReply({
      items: [
        { type: "user", text: "x" },
        { type: "notice", tone: "error", text: "boom" },
      ],
    }).error,
    "boom",
  );
});

test("a helper's state follows its worktree chat", () => {
  const ctx = { stopRequested: false, startedAt: 0, now: 1000 };
  const replied = {
    items: [
      { type: "user", text: "t" },
      { type: "assistant", text: "Report" },
    ],
  };
  assert.deepEqual(helperOutcome("starting", null, ctx), {
    state: "starting",
    finished: false,
    report: "",
  });
  assert.equal(helperOutcome("working", null, ctx).state, "working");
  assert.equal(helperOutcome("waiting", null, ctx).state, "waiting");
  assert.equal(helperOutcome("working", null, { ...ctx, stopRequested: true }).state, "stopping");
  assert.deepEqual(helperOutcome("done", replied, ctx), {
    state: "done",
    finished: true,
    report: "Report",
  });
  // Idle before its first turn ran: still starting, until that's clearly not happening.
  const early = { items: [{ type: "user", text: "t" }] };
  assert.equal(helperOutcome("done", early, ctx).finished, false);
  assert.equal(helperOutcome("done", early, { ...ctx, now: NO_REPLY_MS + 1 }).finished, true);
  // Stopped on request: what it wrote last comes along.
  assert.deepEqual(helperOutcome("done", replied, { ...ctx, stopRequested: true }), {
    state: "stopped",
    finished: true,
    report: "Report",
  });
  assert.equal(helperOutcome("stopped", null, ctx).state, "stopped");
  assert.equal(helperOutcome("gone", null, ctx).state, "stopped");
  assert.equal(helperOutcome(undefined, null, ctx).finished, true);
  const failed = {
    items: [
      { type: "user", text: "t" },
      { type: "notice", tone: "error", text: "No model" },
    ],
  };
  assert.deepEqual(helperOutcome("error", failed, ctx), {
    state: "error",
    finished: true,
    report: "No model",
  });
});

test("report and status texts", () => {
  assert.equal(changesText({}), "");
  assert.equal(changesText({ files: 0 }), "no files changed");
  assert.equal(changesText({ files: 1, added: 3, removed: 1 }), "1 file changed (+3 −1)");
  const done = helperReport({
    label: "Forge",
    branch: "agent/fix",
    state: "done",
    report: "Fixed the login.",
    files: 2,
    added: 10,
    removed: 4,
  });
  assert.match(
    done,
    /^Report from helper Forge \(it worked in its own git worktree, branch agent\/fix\)/,
  );
  assert.match(done, /2 files changed \(\+10 −4\)\. Its changes are not in this folder/);
  assert.match(done, /agent\.applyWorktree with agent "agent\/fix"/);
  assert.match(done, /Fixed the login\.$/);
  assert.match(helperReport({ label: "F", branch: "b", state: "done", report: "" }), /no report/);
  assert.match(
    helperReport({ label: "F", branch: "b", state: "stopped", report: "" }),
    /was stopped/,
  );
  assert.match(helperReport({ label: "F", branch: "b", state: "error", report: "x" }), /error/);
  assert.ok(
    helperReport({ label: "F", branch: "b", state: "done", report: "y".repeat(20_000) }).length <
      13_000,
  );
  assert.equal(
    helperStatusText({
      label: "Forge",
      branch: "agent/x",
      state: "working",
      files: 1,
      added: 1,
      removed: 0,
    }),
    "Forge is working in a worktree (agent/x)… · 1 file changed (+1 −0)",
  );
  assert.match(
    helperStatusText({ label: "Forge", branch: "agent/x", state: "waiting" }),
    /waiting for you/,
  );
});

test("the helper's first message: who asked, where it works, its instructions, the task", () => {
  const text = helperTask({
    from: "C:\\work\\app",
    branch: "agent/fix",
    task: "Fix it",
    label: "Forge",
    instructions: "Be careful.",
  });
  assert.match(text, /a chat in C:\\work\\app handed you this task/);
  assert.match(text, /on branch agent\/fix/);
  assert.match(text, /Your instructions as Forge:\n\nBe careful\./);
  assert.match(text, /The task:\n\nFix it$/);
  assert.doesNotMatch(helperTask({ from: "a", branch: "b", task: "t" }), /instructions/);
});

test("stop requests: added once, dropped when handled or old", () => {
  const one = withStop(undefined, "s1", 1000);
  assert.deepEqual(one, [{ id: "s1", at: 1000 }]);
  const two = withStop(one, "s1", 2000);
  assert.deepEqual(two, [{ id: "s1", at: 2000 }]);
  assert.equal(stopRequested(two, "s1", 3000), true);
  assert.equal(stopRequested(two, "s2", 3000), false);
  assert.equal(stopRequested(two, "s1", 2000 + STOP_TTL), false);
  assert.deepEqual(withoutStop([...two, { id: "s2", at: 2500 }], "s1", 3000), [
    { id: "s2", at: 2500 },
  ]);
  assert.deepEqual(withStop([{ id: "old", at: 0 }], "s3", STOP_TTL + 1), [
    { id: "s3", at: STOP_TTL + 1 },
  ]);
  assert.deepEqual(sanitizeStops([{ id: "a", at: 1 }, { id: 2 }, null, "x"]), [{ id: "a", at: 1 }]);
  assert.deepEqual(sanitizeStops("nope"), []);
});

test("headless by default: a window per helper only when the setting says true", () => {
  assert.equal(helpersInWindows(undefined), false);
  assert.equal(helpersInWindows(false), false);
  assert.equal(helpersInWindows("true"), false);
  assert.equal(helpersInWindows(true), true);
});

test("a nested helper is refused before anything else", () => {
  const base = { agent: "Builder", readOnly: false, gitRepo: true, running: 0, max: 3 };
  assert.equal(isolationRefusal(base), null);
  assert.match(isolationRefusal({ ...base, nested: true }) ?? "", /helper in a worktree yourself/);
});

test("a headless helper's progress comes from its chat here", () => {
  const user = { type: "user", text: "do it" };
  assert.equal(headlessProgress(undefined), "gone");
  assert.equal(headlessProgress({ status: "running", error: false, items: [user] }), "working");
  assert.equal(headlessProgress({ status: "waiting", error: false, items: [user] }), "waiting");
  assert.equal(headlessProgress({ status: "idle", error: true, items: [user] }), "error");
  assert.equal(
    headlessProgress({
      status: "idle",
      error: false,
      items: [user, { type: "assistant", text: "Done." }],
    }),
    "done",
  );
  // Its turn was stopped: the notice after the last message says so.
  assert.equal(
    headlessProgress({
      status: "idle",
      error: false,
      items: [
        user,
        { type: "tool" },
        { type: "notice", text: "Stopped: the chat that started it stopped it." },
      ],
    }),
    "stopped",
  );
  // A stop before an earlier message doesn't count for the newer one.
  assert.equal(
    headlessProgress({
      status: "idle",
      error: false,
      items: [{ type: "notice", text: "Stopped." }, user, { type: "assistant", text: "ok" }],
    }),
    "done",
  );
  // A report from a subagent (an automatic message) doesn't end the search for the stop.
  assert.equal(
    headlessProgress({
      status: "idle",
      error: false,
      items: [user, { type: "notice", text: "Stopped." }, { type: "user", auto: "subagent" }],
    }),
    "stopped",
  );
});

test("a headless helper's paths stay in its worktree; the main folder's map onto it", () => {
  const paths = { isWithin, rebase };
  const main = "C:\\repo";
  const tree = "C:\\repo.agent-fix";
  assert.equal(
    helperPath("C:\\repo.agent-fix\\src\\a.ts", tree, main, paths),
    "C:\\repo.agent-fix\\src\\a.ts",
  );
  assert.equal(
    helperPath("C:\\repo\\src\\a.ts", tree, main, paths),
    "C:\\repo.agent-fix\\src\\a.ts",
  );
  assert.equal(helperPath("C:\\other\\a.ts", tree, main, paths), null);
  assert.equal(helperPath("C:\\repo\\a.ts", tree, null, paths), null);
  // A worktree inside the main folder is its own first.
  assert.equal(helperPath("/r/.wt/x/a", "/r/.wt/x", "/r", paths), "/r/.wt/x/a");
  assert.equal(helperPath("/r/a", "/r/.wt/x", "/r", paths), "/r/.wt/x/a");
});

test("commands on the window's folder are refused to a headless helper; the rest stay", () => {
  for (const id of [
    "git.commit",
    "editor.openFile",
    "fs.delete",
    "terminal.sendText",
    "search.run",
  ])
    assert.equal(actsOnWindowFolder(id), true, id);
  for (const id of ["web.fetch", "browser.open", "agent.openThread", "workbench.screenshot"])
    assert.equal(actsOnWindowFolder(id), false, id);
});

test("a headless helper's first message names its folder and what reaches the window's", () => {
  const text = headlessHelperTask({
    from: "repo",
    folder: "C:\\repo.agent-fix",
    branch: "agent/fix",
    task: "Fix the login.",
    label: "Builder",
    instructions: "Be careful.",
  });
  assert.match(text, /Your folder is C:\\repo\.agent-fix/);
  assert.match(text, /branch agent\/fix/);
  assert.match(text, /Be careful\./);
  assert.match(text, /Fix the login\./);
  assert.match(text, /refused/);
});

test("follow-up messages for window helpers: added, taken once, dropped when old", () => {
  const now = 1_000_000;
  const a = { id: "s1", msg: "m1", text: "also add tests", at: now };
  let list = withMessage([], a, now);
  list = withMessage(list, { id: "s2", msg: "m2", text: "x", at: now }, now);
  assert.deepEqual(
    messagesFor(list, "s1", now).map((m) => m.msg),
    ["m1"],
  );
  list = withoutMessages(list, ["m1"], now);
  assert.deepEqual(messagesFor(list, "s1", now), []);
  assert.equal(messagesFor(list, "s2", now + MESSAGE_TTL).length, 0);
  assert.equal(withMessage(list, a, now + MESSAGE_TTL).length, 1);
  assert.deepEqual(sanitizeMessages([a, { id: 1 }, null, "x"]), [a]);
  assert.deepEqual(sanitizeMessages("nope"), []);
  assert.match(followUpText("  also add tests "), /chat that started you[\s\S]*also add tests$/);
});

test("a headless helper waits in its chat, a window helper in its window", () => {
  const h = { label: "Builder", branch: "agent/x", state: "waiting" as const };
  assert.match(helperStatusText(h), /in its window/);
  assert.match(helperStatusText({ ...h, headless: true }), /in its chat/);
});
