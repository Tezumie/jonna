import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_STATUS_CHARS,
  plainStatus,
  statusLineInput,
  statusLineSegments,
  statusLineSetting,
  statusLineText,
  statusLinkTarget,
  Throttle,
  type Timers,
} from "./statusLine";

const ESC = "\u001b";

test("statusLineSetting: Claude Code's object, a bare command, or off", () => {
  assert.deepEqual(statusLineSetting({ type: "command", command: " ~/s.sh ", padding: 2 }), {
    command: "~/s.sh",
    padding: 2,
  });
  assert.deepEqual(statusLineSetting("node s.mjs"), { command: "node s.mjs", padding: 0 });
  assert.deepEqual(statusLineSetting({ command: "x", padding: 99 }), { command: "x", padding: 8 });
  assert.equal(statusLineSetting(null), null);
  assert.equal(statusLineSetting({}), null);
  assert.equal(statusLineSetting({ command: "  " }), null);
  assert.equal(statusLineSetting({ type: "static", command: "x" }), null);
});

test("statusLineInput: Claude Code's field names", () => {
  const json = JSON.parse(
    statusLineInput({
      sessionId: "s1",
      transcriptPath: "/data/agent/sessions/s1.json",
      cwd: "/p",
      projectDir: "/p",
      model: { id: "claude/opus", displayName: "Opus" },
      version: "0.1.0",
      outputStyle: "Explanatory",
      cost: 0.0123,
      durationMs: 5000.4,
      apiDurationMs: 1200,
      linesAdded: 10,
      linesRemoved: 2,
      contextTokens: 1000,
      contextWindow: 200_000,
    }),
  ) as Record<string, unknown>;
  assert.deepEqual(json, {
    hook_event_name: "Status",
    session_id: "s1",
    transcript_path: "/data/agent/sessions/s1.json",
    cwd: "/p",
    model: { id: "claude/opus", display_name: "Opus" },
    workspace: { current_dir: "/p", project_dir: "/p" },
    version: "0.1.0",
    output_style: { name: "Explanatory" },
    cost: {
      total_cost_usd: 0.0123,
      total_duration_ms: 5000,
      total_api_duration_ms: 1200,
      total_lines_added: 10,
      total_lines_removed: 2,
    },
    exceeds_200k_tokens: false,
    context_window: { context_window_size: 200_000, current_usage: 1000 },
  });
});

test("statusLineText: the first line, colors kept, the rest of the escapes dropped", () => {
  assert.equal(statusLineText("one\ntwo\n"), "one");
  assert.equal(statusLineText("a\r\nb"), "a");
  assert.equal(statusLineText(""), "");
  const green = `${ESC}[32mOpus${ESC}[0m | main`;
  assert.equal(statusLineText(`${green}\n`), green);
  // A cursor move, a window title, a bell: gone.
  assert.equal(statusLineText(`${ESC}[2K${ESC}]0;title\u0007x\u0007y`), "xy");
  assert.equal(statusLineText("a\tb  "), "a b");
  // Too long: cut by visible characters, colors reset at the end.
  const long = `${ESC}[31m${"x".repeat(500)}`;
  const cut = statusLineText(long);
  assert.equal(plainStatus(cut).length, MAX_STATUS_CHARS);
  assert.ok(cut.startsWith(`${ESC}[31m`));
  assert.ok(cut.endsWith(`…${ESC}[0m`));
});

/** Fake timers: `tick(ms)` moves the clock and fires what's due. */
function fakeTimers(): Timers & { tick(ms: number): void } {
  let t = 0;
  let queue: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  return {
    now: () => t,
    set: (fn, ms) => {
      const id = next++;
      queue.push({ at: t + ms, fn, id });
      return id;
    },
    clear: (id) => {
      queue = queue.filter((q) => q.id !== id);
    },
    tick(ms) {
      t += ms;
      const due = queue.filter((q) => q.at <= t);
      queue = queue.filter((q) => q.at > t);
      for (const q of due) q.fn();
    },
  };
}

test("Throttle: at most once per gap, one at a time, asks in between come together", async () => {
  const timers = fakeTimers();
  let runs = 0;
  let finish: () => void = () => {};
  const throttle = new Throttle(
    300,
    () =>
      new Promise<void>((done) => {
        runs++;
        finish = done;
      }),
    timers,
  );
  const settle = () => new Promise((r) => setImmediate(r));
  throttle.request();
  assert.equal(runs, 1);
  // While it runs: asked three times, one more run after it.
  throttle.request();
  throttle.request();
  throttle.request();
  timers.tick(500);
  assert.equal(runs, 1);
  finish();
  await settle();
  assert.equal(runs, 2);
  finish();
  await settle();
  // Within the gap: waits for it.
  timers.tick(100);
  throttle.request();
  assert.equal(runs, 2);
  timers.tick(150);
  assert.equal(runs, 2);
  timers.tick(60);
  assert.equal(runs, 3);
  finish();
  await settle();
  // Disposed: nothing more.
  timers.tick(1000);
  throttle.dispose();
  throttle.request();
  assert.equal(runs, 3);
});

test("D373: OSC 8 links are kept, take no room, and cut the line into segments", () => {
  // The string terminator (ESC \).
  const ST = `${ESC}${String.fromCharCode(92)}`;
  const link = (uri: string, text: string) => `${ESC}]8;;${uri}${ST}${text}${ESC}]8;;${ST}`;
  const green = `${ESC}[32mPR #1${ESC}[0m`;
  const raw = `main ${link("https://example.com/pr/1", green)} ok`;
  const text = statusLineText(raw);
  assert.equal(plainStatus(text), "main PR #1 ok");
  assert.deepEqual(statusLineSegments(text), [
    { text: "main ", href: null },
    { text: green, href: "https://example.com/pr/1" },
    { text: " ok", href: null },
  ]);
  // BEL-terminated, as some tools write it.
  const bel = `${ESC}]8;;file:///C:/x/a.ts#L3\u0007a.ts${ESC}]8;;\u0007`;
  assert.deepEqual(statusLineSegments(statusLineText(bel)), [
    { text: "a.ts", href: "file:///C:/x/a.ts#L3" },
  ]);
  // A long line is cut by what shows, links not counted.
  const long = link("https://e.com", "x".repeat(MAX_STATUS_CHARS + 50));
  assert.equal(plainStatus(statusLineText(long)).length, MAX_STATUS_CHARS);
});

test("statusLinkTarget: web, files at a line, the IDE's commands; nothing else", () => {
  assert.deepEqual(statusLinkTarget("https://example.com"), {
    kind: "web",
    url: "https://example.com",
  });
  assert.deepEqual(statusLinkTarget("file:///C:/x/a%20b.ts#L12"), {
    kind: "file",
    path: "C:/x/a b.ts",
    line: 12,
  });
  assert.deepEqual(statusLinkTarget("file:///home/u/a.ts:4"), {
    kind: "file",
    path: "/home/u/a.ts",
    line: 4,
  });
  assert.deepEqual(
    statusLinkTarget(`command:git.checkout?${encodeURIComponent('{"ref":"main"}')}`),
    { kind: "command", id: "git.checkout", input: { ref: "main" } },
  );
  assert.deepEqual(statusLinkTarget("command:agent.showUsage"), {
    kind: "command",
    id: "agent.showUsage",
    input: {},
  });
  assert.deepEqual(statusLinkTarget("file://server/share/a.ts"), {
    kind: "file",
    path: "//server/share/a.ts",
  });
  assert.equal(statusLinkTarget("javascript:alert(1)"), null);
  assert.equal(statusLinkTarget("command:x?{bad"), null);
});
