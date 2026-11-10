import assert from "node:assert/strict";
import { test } from "node:test";
import type { CdpCall } from "../../core/browser/trustedInput";
import type { Page } from "./page";
import { type InputSink, runInput, webviewSink } from "./trustedInput";

/** A page whose bridge answers prepare / report as the given functions say. */
function fakePage(answers: Record<string, (p: Record<string, unknown>) => unknown>) {
  const calls: string[] = [];
  const page = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push(method);
      const answer = answers[method];
      if (!answer) throw new Error(`no ${method}`);
      return answer(params);
    },
  } as unknown as Page;
  return { page, calls };
}

function fakeSink(overrides: Partial<InputSink> = {}) {
  const sent: CdpCall[] = [];
  const sink: InputSink = {
    send: async (call) => {
      sent.push(call);
      return {};
    },
    place: (at) => ({ x: at.x + 100, y: at.y + 50 }),
    focus: () => true,
    release: () => {},
    ...overrides,
  };
  return { sink, sent };
}

const viewport = { width: 800, height: 600 };

test("D346: a click goes as protocol events at the frame's place, and says so", async () => {
  const { page } = fakePage({
    "input.prepare": () => ({ viewport, x: 10, y: 20, target: 'button "Go" [ref=e1]' }),
    "input.report": () => ({ focused: "page", url: "http://localhost/" }),
  });
  const { sink, sent } = fakeSink();
  let bridged = false;
  const r = (await runInput(
    { page, inputSink: () => sink },
    { op: "click", ref: "e1" },
    async () => {
      bridged = true;
      return {};
    },
    true,
  )) as Record<string, unknown>;
  assert.equal(bridged, false);
  assert.equal(r.input, "trusted");
  assert.equal(r.clicked, 'button "Go" [ref=e1]');
  assert.equal(r.url, "http://localhost/");
  assert.equal(sent.length, 3);
  assert.deepEqual(
    [sent[1]?.params.type, sent[1]?.params.x, sent[1]?.params.y],
    ["mousePressed", 110, 70],
  );
});

test("D346: the bridge does it when the setting is off, the system can't, or the IDE covers the page", async () => {
  const { page } = fakePage({
    "input.prepare": () => ({ viewport, x: 1, y: 1, target: "x" }),
    "input.report": () => ({}),
  });
  const bridge = async () => ({ clicked: "x" });
  const off = (await runInput({ page }, { op: "click", x: 1, y: 1 }, bridge, false)) as Record<
    string,
    unknown
  >;
  assert.equal(off.input, "synthesized");
  assert.match(String(off.inputNote), /isTrusted false.*browser\.trustedInput is off/);
  const elsewhere = (await runInput(
    { page, inputSink: () => webviewSink("linux", "main", null) },
    { op: "click", x: 1, y: 1 },
    bridge,
    true,
  )) as Record<string, unknown>;
  assert.match(String(elsewhere.inputNote), /WebView2 only/);
  const { sink, sent } = fakeSink({ place: () => null });
  const covered = (await runInput(
    { page, inputSink: () => sink },
    { op: "click", x: 1, y: 1 },
    bridge,
    true,
  )) as Record<string, unknown>;
  assert.match(String(covered.inputNote), /covers the page/);
  assert.equal(sent.length, 0);
});

test("D346: keys need the page focused; a refusal before anything was sent falls back", async () => {
  const { page } = fakePage({
    "input.prepare": () => ({ viewport, focused: "page" }),
    "input.report": () => ({ focused: "page" }),
  });
  const bridge = async () => ({ pressed: "Enter" });
  const unfocused = fakeSink({ focus: () => false });
  const r1 = (await runInput(
    { page, inputSink: () => unfocused.sink },
    { op: "key", keys: [{ key: "Enter" }] },
    bridge,
    true,
  )) as Record<string, unknown>;
  assert.match(String(r1.inputNote), /keyboard focus/);
  const refusing = fakeSink({
    send: async () => {
      throw new Error("no protocol");
    },
  });
  const r2 = (await runInput(
    { page, inputSink: () => refusing.sink },
    { op: "key", keys: [{ key: "Enter" }] },
    bridge,
    true,
  )) as Record<string, unknown>;
  assert.match(String(r2.inputNote), /refused \(no protocol\)/);
  // A key name a keyboard doesn't have goes to the bridge, by name.
  const ok = fakeSink();
  const r3 = (await runInput(
    { page, inputSink: () => ok.sink },
    { op: "key", keys: [{ key: "MediaPlayPause" }] },
    bridge,
    true,
  )) as Record<string, unknown>;
  assert.equal(r3.input, "synthesized");
  assert.equal(ok.sent.length, 0);
  // Typing into an element replaces its text in one insertion, then Enter.
  const { page: typing } = fakePage({
    "input.prepare": () => ({ viewport, into: 'textbox "Name"' }),
    "input.report": () => ({ value: "Ada" }),
  });
  const t = fakeSink();
  const r4 = (await runInput(
    { page: typing, inputSink: () => t.sink },
    { op: "type", selector: "#name", text: "Ada", submit: true },
    bridge,
    true,
  )) as Record<string, unknown>;
  assert.deepEqual(
    [r4.input, r4.typed, r4.into, r4.value],
    ["trusted", 3, 'textbox "Name"', "Ada"],
  );
  assert.deepEqual(t.sent[0], { method: "Input.insertText", params: { text: "Ada" } });
  assert.equal(t.sent[1]?.params.key, "Enter");
});

test("D346: HTML drag and drop needs drag interception", async () => {
  const { page } = fakePage({
    "input.prepare": () => ({
      viewport,
      x: 5,
      y: 5,
      toX: 50,
      toY: 50,
      target: "a",
      draggable: true,
    }),
    "input.report": () => ({}),
  });
  const bridge = async () => ({ dragged: "a" });
  const plain = fakeSink();
  const r1 = (await runInput(
    { page, inputSink: () => plain.sink },
    { op: "drag", fromX: 5, fromY: 5, x: 50, y: 50 },
    bridge,
    true,
  )) as Record<string, unknown>;
  assert.match(String(r1.inputNote), /HTML drag and drop/);
  const dragged: unknown[] = [];
  const intercepting = fakeSink({
    htmlDrag: async (from, to) => {
      dragged.push(from, to);
      return true;
    },
  });
  const r2 = (await runInput(
    { page, inputSink: () => intercepting.sink },
    { op: "drag", fromX: 5, fromY: 5, x: 50, y: 50 },
    bridge,
    true,
  )) as Record<string, unknown>;
  assert.equal(r2.input, "trusted");
  assert.deepEqual(dragged, [
    { x: 105, y: 55 },
    { x: 150, y: 100 },
  ]);
});
