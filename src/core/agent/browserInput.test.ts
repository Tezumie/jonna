import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actLabel,
  coordinateFrame,
  findInOutline,
  isLocalPage,
  parseChord,
  parseKeys,
  parseModifiers,
  parsePoint,
  parseRegion,
  planAct,
  resizePreset,
  siteOf,
  textMatcher,
} from "./browserInput";

test("D316: key chords take DOM names, xdotool's and modifiers", () => {
  assert.deepEqual(parseChord("ctrl+shift+a"), { key: "a", modifiers: ["ctrl", "shift"] });
  assert.deepEqual(parseChord("Return"), { key: "Enter", modifiers: [] });
  assert.deepEqual(parseChord("BackSpace"), { key: "Backspace", modifiers: [] });
  assert.deepEqual(parseChord("cmd+a"), { key: "a", modifiers: ["meta"] });
  assert.deepEqual(parseChord("ctrl++"), { key: "+", modifiers: ["ctrl"] });
  assert.deepEqual(parseChord("shift"), { key: "Shift", modifiers: [] });
  assert.deepEqual(parseChord("F5"), { key: "F5", modifiers: [] });
  assert.deepEqual(parseChord("Page_Down"), { key: "PageDown", modifiers: [] });
  assert.throws(() => parseChord("hyper+a"), /Unknown modifier/);
  assert.throws(() => parseChord("notakey"), /Unknown key/);
  assert.deepEqual(
    parseKeys("Backspace Backspace Delete").map((k) => k.key),
    ["Backspace", "Backspace", "Delete"],
  );
  assert.deepEqual(parseKeys(" "), [{ key: " ", modifiers: [] }]);
  assert.deepEqual(parseModifiers("ctrl+shift"), ["ctrl", "shift"]);
  assert.deepEqual(parseModifiers(undefined), []);
});

test("D316: points and regions, also as text", () => {
  assert.deepEqual(parsePoint([10, 20]), [10, 20]);
  assert.deepEqual(parsePoint("[10, 20]"), [10, 20]);
  assert.deepEqual(parsePoint("10,20"), [10, 20]);
  assert.throws(() => parsePoint([10]), /two numbers/);
  assert.throws(() => parsePoint([-1, 2]), /two numbers/);
  assert.deepEqual(parseRegion([0, 0, 100, 50]), [0, 0, 100, 50]);
  assert.throws(() => parseRegion([10, 0, 5, 50]), /x1 > x0/);
});

test("D316: the coordinate frame is the viewport, scaled to fit the model's long side", () => {
  assert.deepEqual(coordinateFrame({ width: 1280, height: 800 }), {
    width: 1280,
    height: 800,
    scale: 1,
  });
  const big = coordinateFrame({ width: 3136, height: 1000 });
  assert.equal(big.width, 1568);
  assert.equal(big.height, 500);
  assert.equal(big.scale, 0.5);
});

test("D316: browser_act plans clicks by ref or coordinate", () => {
  assert.deepEqual(planAct({ action: "click", ref: "e3" }), {
    command: "browser.click",
    input: { ref: "e3" },
  });
  assert.deepEqual(planAct({ action: "left_click", coordinate: [5, 6] }), {
    command: "browser.input",
    input: { op: "click", x: 5, y: 6, button: 0, count: 1 },
  });
  assert.deepEqual(planAct({ action: "triple_click", ref: "e1", modifiers: "shift" }), {
    command: "browser.input",
    input: { op: "click", ref: "e1", button: 0, count: 3, modifiers: ["shift"] },
  });
  assert.deepEqual(planAct({ action: "right_click", coordinate: [1, 2] }).input, {
    op: "click",
    x: 1,
    y: 2,
    button: 2,
    count: 1,
  });
  assert.throws(() => planAct({ action: "double_click" }), /ref .* or a coordinate/);
  assert.throws(() => planAct({ action: "fly" }), /Unknown action "fly"/);
});

test("D316: keys, typing at the focus, scroll by ticks, drag and pauses", () => {
  assert.deepEqual(planAct({ action: "press", key: "Enter", ref: "e2" }), {
    command: "browser.press",
    input: { ref: "e2", key: "Enter" },
  });
  assert.deepEqual(planAct({ action: "key", text: "ctrl+a", repeat: 2 }), {
    command: "browser.input",
    input: { op: "key", keys: [{ key: "a", modifiers: ["ctrl"] }], repeat: 2 },
  });
  assert.equal(planAct({ action: "press", key: "Tab", repeat: 500 }).input?.repeat, 100);
  assert.deepEqual(planAct({ action: "type", text: "hi" }), {
    command: "browser.input",
    input: { op: "type", text: "hi" },
  });
  assert.equal(planAct({ action: "type", text: "hi", ref: "e4" }).command, "browser.type");
  assert.deepEqual(
    planAct({ action: "scroll", coordinate: [10, 10], scroll_direction: "up", scroll_amount: 2 }),
    { command: "browser.input", input: { op: "scroll", x: 10, y: 10, dx: 0, dy: -200 } },
  );
  assert.deepEqual(planAct({ action: "scroll", to: "bottom" }), {
    command: "browser.scroll",
    input: { to: "bottom" },
  });
  assert.deepEqual(planAct({ action: "scroll_to", ref: "e9" }), {
    command: "browser.scroll",
    input: { ref: "e9" },
  });
  assert.deepEqual(planAct({ action: "drag", start_coordinate: [1, 2], coordinate: [30, 40] }), {
    command: "browser.input",
    input: { op: "drag", fromX: 1, fromY: 2, x: 30, y: 40 },
  });
  assert.throws(() => planAct({ action: "drag", coordinate: [1, 1] }), /start_coordinate/);
  assert.deepEqual(planAct({ action: "wait", duration: 30 }), { sleepMs: 10000 });
  assert.equal(planAct({ action: "wait", text: "Done" }).command, "browser.wait");
});

test("D316: tabs: new, select, close", () => {
  assert.deepEqual(planAct({ action: "new_tab" }), {
    command: "browser.open",
    input: { newTab: true },
  });
  assert.deepEqual(planAct({ action: "new_tab", url: "localhost:5173" }).input, {
    newTab: true,
    url: "localhost:5173",
  });
  assert.deepEqual(planAct({ action: "select_tab", tab: "t4" }), {
    command: "browser.selectTab",
    input: { tab: "t4" },
  });
  assert.throws(() => planAct({ action: "close_tab" }), /tab id/);
});

test("D316: the row shows action_summary", () => {
  assert.equal(
    actLabel({ action: "click", ref: "e1", action_summary: "Opens the menu" }),
    "Opens the menu",
  );
  assert.equal(actLabel({ action: "click", ref: "e1" }), "click e1");
  assert.equal(actLabel({ action: "click", coordinate: [3, 4] }), "click (3, 4)");
});

test("D316: find matches outline lines by phrase, then by every word, one per ref", () => {
  const lines = [
    { ref: "e1", line: 'button "Sign in"' },
    { ref: "e2", line: 'link "Sign up for news"' },
    { ref: "e1", line: 'text "Sign in"' },
    { ref: "e3", line: 'textbox "Your name"' },
  ];
  assert.deepEqual(
    findInOutline(lines, "SIGN").map((l) => l.ref),
    ["e1", "e2"],
  );
  assert.deepEqual(
    findInOutline(lines, "name your").map((l) => l.ref),
    ["e3"],
  );
  assert.equal(findInOutline(lines, "sign", 1).length, 1);
  assert.deepEqual(findInOutline(lines, "nothing"), []);
  assert.throws(() => findInOutline(lines, "  "), /give the text/);
});

test("D316: presets, local pages and sites", () => {
  assert.deepEqual(resizePreset("mobile"), { width: 375, height: 812 });
  assert.deepEqual(resizePreset("Desktop"), { device: "responsive" });
  assert.throws(() => resizePreset("watch"), /mobile, tablet or desktop/);
  assert.equal(isLocalPage("http://localhost:5173/"), true);
  assert.equal(isLocalPage("http://127.0.0.1:8080/x"), true);
  assert.equal(isLocalPage("http://app.localhost/"), true);
  assert.equal(isLocalPage("index.html"), true);
  assert.equal(isLocalPage("https://example.com/"), false);
  assert.equal(isLocalPage("https://localhost.example.com/"), false);
  assert.equal(siteOf("https://example.com/a?b"), "https://example.com");
});

test("D316: console and request patterns: a regex, else text", () => {
  assert.equal(textMatcher("fail(ed)?")("Request FAILED"), true);
  assert.equal(textMatcher("[oops")("an [oops here"), true);
  assert.equal(textMatcher("")("anything"), true);
  assert.equal(textMatcher("x")("y"), false);
});
