import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CdpCall,
  chordSteps,
  chordsText,
  clickSteps,
  DRAG_STEPS,
  dragSteps,
  hostPoint,
  type InputStep,
  keyDefinition,
  modifierBits,
  placeSteps,
  TYPE_KEYS_MAX,
  typeSteps,
  wheelSteps,
} from "./trustedInput";

const types = (steps: readonly InputStep[]) =>
  steps.map((s) =>
    "method" in s ? `${s.method.slice(6)}:${String(s.params.type ?? "")}` : "wait",
  );

test("D346: modifier bits as the protocol counts them", () => {
  assert.equal(modifierBits([]), 0);
  assert.equal(modifierBits(["alt"]), 1);
  assert.equal(modifierBits(["ctrl", "shift"]), 10);
  assert.equal(modifierBits(["meta"]), 4);
});

test("D346: key definitions on a US keyboard", () => {
  assert.deepEqual(keyDefinition("a"), { key: "a", code: "KeyA", keyCode: 65, text: "a" });
  assert.deepEqual(keyDefinition("a", true), { key: "A", code: "KeyA", keyCode: 65, text: "A" });
  assert.deepEqual(keyDefinition("Enter"), {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    text: "\r",
  });
  assert.equal(keyDefinition("Tab")?.text, undefined);
  assert.deepEqual(keyDefinition("7", true), { key: "&", code: "Digit7", keyCode: 55, text: "&" });
  assert.deepEqual(keyDefinition("!"), { key: "!", code: "Digit1", keyCode: 49, text: "!" });
  assert.deepEqual(keyDefinition("?"), { key: "?", code: "Slash", keyCode: 191, text: "?" });
  assert.deepEqual(keyDefinition(" "), { key: " ", code: "Space", keyCode: 32, text: " " });
  assert.equal(keyDefinition("F5")?.keyCode, 116);
  assert.equal(keyDefinition("Control")?.code, "ControlLeft");
  assert.equal(keyDefinition("é"), null);
  assert.equal(keyDefinition("Nope"), null);
});

test("D346: a chord presses its modifiers around the key, and a shortcut types nothing", () => {
  const steps = chordSteps("a", ["ctrl", "shift"]);
  assert.deepEqual(
    steps.map((s) => [s.params.type, s.params.key, s.params.modifiers]),
    [
      ["rawKeyDown", "Control", 2],
      ["rawKeyDown", "Shift", 10],
      ["rawKeyDown", "A", 10],
      ["keyUp", "A", 10],
      ["keyUp", "Shift", 2],
      ["keyUp", "Control", 0],
    ],
  );
  assert.equal(steps[2]?.params.text, undefined);
  // A plain printable key types its character; Enter types a return.
  const plain = chordSteps("x");
  assert.deepEqual(
    plain.map((s) => [s.params.type, s.params.text]),
    [
      ["keyDown", "x"],
      ["keyUp", undefined],
    ],
  );
  assert.equal(chordSteps("Enter")[0]?.params.text, "\r");
  assert.equal(chordSteps("Escape")[0]?.params.type, "rawKeyDown");
  assert.equal(chordSteps("Escape")[0]?.params.windowsVirtualKeyCode, 27);
  // A character no key types: inserted as text; with a shortcut modifier, refused.
  assert.deepEqual(chordSteps("é"), [{ method: "Input.insertText", params: { text: "é" } }]);
  assert.throws(() => chordSteps("é", ["ctrl"]), /Unknown key/);
  assert.throws(() => chordSteps("Hyper"), /Unknown key "Hyper"/);
});

test("D346: typing is a key press per character; capitals hold Shift; others are inserted", () => {
  const steps = typeSteps("Hi!\né");
  const summary = steps.map((s: CdpCall) =>
    s.method === "Input.insertText"
      ? `insert ${String(s.params.text)}`
      : `${String(s.params.type)} ${String(s.params.key)}`,
  );
  assert.deepEqual(summary, [
    "rawKeyDown Shift",
    "keyDown H",
    "keyUp H",
    "keyUp Shift",
    "keyDown i",
    "keyUp i",
    "rawKeyDown Shift",
    "keyDown !",
    "keyUp !",
    "keyUp Shift",
    "keyDown Enter",
    "keyUp Enter",
    "insert é",
  ]);
  // Characters no key types, together, are one insertion; CRLF is one Enter.
  assert.equal(typeSteps("日本語").length, 1);
  assert.equal(typeSteps("a\r\nb").filter((s) => s.params.key === "Enter").length, 2);
  // Long text goes in at once.
  const long = typeSteps("x".repeat(TYPE_KEYS_MAX + 1));
  assert.equal(long.length, 1);
  assert.equal(long[0]?.method, "Input.insertText");
});

test("D346: clicks, wheel and drags as mouse events", () => {
  const click = clickSteps({ x: 10.123, y: 20 }, 0, 2, ["shift"]);
  assert.deepEqual(types(click), [
    "dispatchMouseEvent:mouseMoved",
    "dispatchMouseEvent:mousePressed",
    "dispatchMouseEvent:mouseReleased",
    "dispatchMouseEvent:mousePressed",
    "dispatchMouseEvent:mouseReleased",
  ]);
  const second = click[3] as CdpCall;
  assert.equal(second.params.clickCount, 2);
  assert.equal(second.params.button, "left");
  assert.equal(second.params.buttons, 1);
  assert.equal(second.params.modifiers, 8);
  assert.equal(second.params.x, 10.12);
  const right = clickSteps({ x: 1, y: 1 }, 2)[1] as CdpCall;
  assert.equal(right.params.button, "right");
  assert.equal(right.params.buttons, 2);
  const wheel = wheelSteps({ x: 5, y: 5 }, 0, 300)[1] as CdpCall;
  assert.equal(wheel.params.type, "mouseWheel");
  assert.equal(wheel.params.deltaY, 300);
  const drag = dragSteps({ x: 0, y: 0 }, { x: 80, y: 40 });
  assert.equal(drag.filter((s) => "waitMs" in s).length, DRAG_STEPS);
  const last = drag[drag.length - 1] as CdpCall;
  assert.deepEqual([last.params.type, last.params.x, last.params.y], ["mouseReleased", 80, 40]);
  const middle = drag[3] as CdpCall;
  assert.deepEqual([middle.params.x, middle.params.y, middle.params.buttons], [10, 5, 1]);
});

test("D346: a page point in the webview that shows the frame", () => {
  const box = { left: 100, top: 50, width: 400, height: 300 };
  assert.deepEqual(hostPoint({ x: 10, y: 20 }, { width: 400, height: 300 }, box), {
    x: 110,
    y: 70,
  });
  // Device mode draws the page at half size.
  assert.deepEqual(hostPoint({ x: 100, y: 100 }, { width: 800, height: 600 }, box), {
    x: 150,
    y: 100,
  });
  const placed = placeSteps(
    [...clickSteps({ x: 1, y: 2 }), { waitMs: 5 }, ...chordSteps("a")],
    (p) => ({ x: p.x + 100, y: p.y + 50 }),
  );
  assert.deepEqual([(placed[0] as CdpCall).params.x, (placed[0] as CdpCall).params.y], [101, 52]);
  assert.deepEqual(placed[3], { waitMs: 5 });
  assert.equal((placed[4] as CdpCall).params.x, undefined);
});

test("D346: chords read back as the bridge says them", () => {
  assert.equal(
    chordsText([{ key: "a", modifiers: ["ctrl"] }, { key: " " }, { key: "Enter" }], 3),
    "ctrl+a Space Enter ×3",
  );
});
