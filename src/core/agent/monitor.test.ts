import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LineSplitter,
  MONITOR_DEFAULT_TIMEOUT_MS,
  MONITOR_MAX_LINES,
  MONITOR_MAX_PER_MINUTE,
  MONITOR_MAX_TIMEOUT_MS,
  MONITOR_MIN_TIMEOUT_MS,
  MonitorEvents,
  monitorEndText,
  monitorEventText,
  monitorTimeout,
  shortDuration,
  WS_FRAME_LIMIT,
  wsAddress,
  wsCloseLabel,
  wsExitCode,
  wsFrameEvent,
  wsProtocols,
} from "./monitor";

test("the timeout: default 5 minutes, at most 30, at least a few seconds", () => {
  assert.equal(monitorTimeout(undefined), MONITOR_DEFAULT_TIMEOUT_MS);
  assert.equal(monitorTimeout("soon"), MONITOR_DEFAULT_TIMEOUT_MS);
  assert.equal(monitorTimeout(-5), MONITOR_DEFAULT_TIMEOUT_MS);
  assert.equal(monitorTimeout(60_000), 60_000);
  assert.equal(monitorTimeout("120000"), 120_000);
  assert.equal(monitorTimeout(10 * 3600_000), MONITOR_MAX_TIMEOUT_MS);
  assert.equal(monitorTimeout(1), MONITOR_MIN_TIMEOUT_MS);
});

test("lines split across chunks are joined; colors and blank lines go", () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push("ERR"), []);
  assert.deepEqual(s.push("OR one\r\nok two\n\n"), ["ERROR one", "ok two"]);
  const esc = String.fromCharCode(27);
  assert.deepEqual(s.push(`${esc}[31mred${esc}[0m\rlast`), ["red"]);
  assert.deepEqual(s.end(), ["last"]);
  assert.deepEqual(s.end(), []);
});

test("a line that never ends is let out, and long lines are cut", () => {
  const s = new LineSplitter();
  const lines = s.push("x".repeat(3000));
  assert.equal(lines.length, 1);
  assert.ok((lines[0] ?? "").length <= 501);
});

test("lines within a batch go together; the first line of a batch asks for a flush", () => {
  const e = new MonitorEvents();
  assert.equal(e.add(["a"], 0), true);
  assert.equal(e.add(["b", "c"], 50), false);
  assert.equal(e.waiting, 3);
  const batch = e.take(200);
  assert.deepEqual(batch, { lines: ["a", "b", "c"], omitted: 0 });
  assert.equal(e.take(201), null);
  assert.equal(e.add(["d"], 300), true);
  assert.equal(e.total, 4);
  assert.equal(e.notifications, 1);
});

test("a big batch is capped, the rest counted", () => {
  const e = new MonitorEvents();
  e.add(
    Array.from({ length: MONITOR_MAX_LINES + 5 }, (_, i) => `line ${i}`),
    0,
  );
  const batch = e.take(200);
  assert.equal(batch?.lines.length, MONITOR_MAX_LINES);
  assert.equal(batch?.omitted, 5);
  const text = monitorEventText("bg3", "errors in the log", batch ?? { lines: [], omitted: 0 });
  assert.match(text, /^Monitor bg3 \(errors in the log\): 45 new lines/);
  assert.match(text, /5 more lines not shown/);
  assert.match(text, /kill_process \{ id: "bg3" \}/);
});

test("too many messages in a minute is a flood; a quiet minute later it isn't", () => {
  const e = new MonitorEvents();
  let t = 0;
  for (let i = 0; i < MONITOR_MAX_PER_MINUTE; i++) {
    e.add(["x"], t);
    assert.equal(e.flood(t), null, `message ${i + 1}`);
    e.take(t + 200);
    t += 1000;
  }
  e.add(["one more"], t);
  assert.deepEqual(e.flood(t), { messages: MONITOR_MAX_PER_MINUTE + 1, lines: 21 });
  e.clear();
  assert.equal(e.flood(t + 61_000), null);
});

test("too many lines in a minute is a flood", () => {
  const e = new MonitorEvents();
  e.add(
    Array.from({ length: 2001 }, () => "spam"),
    0,
  );
  assert.ok(e.flood(10));
});

test("end messages say why", () => {
  assert.equal(
    monitorEndText("bg1", "server", { kind: "exited", code: 0 }, 3),
    "Monitor bg1 (server) ended: its command exited with 0 after 3 events.",
  );
  assert.match(
    monitorEndText("bg1", "server", { kind: "expired", afterMs: 300_000 }, 1),
    /expired after 5m with 1 event; it was stopped/,
  );
  assert.match(
    monitorEndText("bg1", "server", { kind: "flood", messages: 21, lines: 40 }, 40),
    /too many events \(21 messages, 40 lines/,
  );
  assert.equal(shortDuration(90_000), "1m 30s");
  assert.equal(shortDuration(5_000), "5s");
});

test("ws: addresses and subprotocols are checked", () => {
  assert.equal(wsAddress(" WS://127.0.0.1:8080/events "), "ws://127.0.0.1:8080/events");
  assert.equal(wsAddress("wss://example.com"), "wss://example.com");
  assert.equal(wsAddress("http://example.com"), null);
  assert.equal(wsAddress("ws://"), null);
  assert.equal(wsAddress(42), null);
  assert.deepEqual(wsProtocols(undefined), []);
  assert.deepEqual(wsProtocols(["graphql-ws", "graphql-ws", "v1.json"]), ["graphql-ws", "v1.json"]);
  assert.deepEqual(wsProtocols("chat"), ["chat"]);
  assert.equal(wsProtocols(["a, b"]), null);
  assert.equal(wsProtocols(["x\r\nHost: y"]), null);
});

test("ws: a frame is one event, multiline kept; binary frames by size; long ones cut", () => {
  assert.equal(wsFrameEvent({ text: "one\r\ntwo\n" }), "one\ntwo");
  assert.equal(wsFrameEvent({ bytes: 12 }), "[binary frame, 12 bytes]");
  assert.equal(wsFrameEvent({ text: "  " }), "[empty frame]");
  const long = wsFrameEvent({ text: "x".repeat(WS_FRAME_LIMIT + 10) });
  assert.ok(long.endsWith("… [10 more characters]"));
  // A multiline frame is one event, sent in a block of its own.
  const e = new MonitorEvents();
  e.add([wsFrameEvent({ text: "a\nb" }), wsFrameEvent({ text: "c" })], 0);
  const batch = e.take(200);
  assert.ok(batch);
  const text = monitorEventText("bg4", "feed", batch, true);
  assert.match(text, /^Monitor bg4 \(feed\): 2 new frames/);
  assert.ok(text.includes("```\na\nb\n```\n```\nc\n```"));
});

test("ws: the close code is said in the end message", () => {
  assert.equal(wsCloseLabel(1000, ""), "with code 1000 (normal closure)");
  assert.equal(wsCloseLabel(4001, "bye"), 'with code 4001 "bye"');
  assert.equal(
    wsCloseLabel(null, "the connection was lost"),
    'without a close code "the connection was lost"',
  );
  assert.match(
    monitorEndText("bg4", "feed", { kind: "closed", code: 1001, reason: "" }, 3),
    /ended: its WebSocket closed with code 1001 \(going away\) after 3 events/,
  );
});

test("ws: a normal close is a clean exit, others aren't", () => {
  assert.equal(wsExitCode(1000), 0);
  assert.equal(wsExitCode(1001), 0);
  assert.equal(wsExitCode(1011), 1011);
  assert.equal(wsExitCode(null), 1);
});
