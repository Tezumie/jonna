import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChord } from "./browserInput";
import {
  accessDecision,
  actionNeed,
  appKey,
  chordToVks,
  classifyApp,
  computerLabel,
  desktopFrame,
  inFrame,
  looksLikeCardNumber,
  tierAllows,
  toScreen,
  zoomCapture,
} from "./computerUse";

const app = (process: string, title = "", isSelf = false) =>
  classifyApp({ process, title, isSelf });

test("D353: apps are tiered by executable", () => {
  assert.equal(appKey("Notepad.EXE"), "notepad");
  assert.equal(app("notepad.exe").tier, "full");
  assert.equal(app("chrome.exe").tier, "read");
  assert.equal(app("msedge.exe").tier, "read");
  assert.equal(app("WindowsTerminal.exe").tier, "click");
  assert.equal(app("Code.exe").tier, "click");
  assert.equal(app("pwsh.exe").tier, "click");
  assert.equal(app("1Password.exe").tier, "refused");
  assert.equal(app("KeePassXC.exe").tier, "refused");
  assert.equal(app("thinkorswim.exe").tier, "refused");
  assert.equal(app("regedit.exe").tier, "ask");
  assert.equal(app("Taskmgr.exe").tier, "ask");
  // Budgeting apps stay at full (only trading and moving money are refused).
  assert.equal(app("QuickBooks.exe").tier, "full");
});

test("D353: store apps are named by their title; the IDE itself asks every time", () => {
  const settings = app("ApplicationFrameHost.exe", "Settings");
  assert.equal(settings.tier, "ask");
  assert.equal(settings.name, "Settings");
  assert.equal(settings.key, "app:settings");
  const calc = app("ApplicationFrameHost.exe", "Calculator");
  assert.equal(calc.tier, "full");
  assert.equal(calc.key, "app:calculator");
  const self = app("whatever.exe", "My project", true);
  assert.equal(self.tier, "ask");
  assert.equal(self.name, "the IDE");
  // A password vault open in any window is refused by its title.
  assert.equal(app("chrome.exe", "Bitwarden Web Vault").tier, "refused");
});

test("D353: what each action needs, and what each tier allows", () => {
  assert.equal(actionNeed("screenshot"), "see");
  assert.equal(actionNeed("left_click"), "click");
  assert.equal(actionNeed("scroll"), "click");
  assert.equal(actionNeed("left_click", "ctrl"), "input");
  assert.equal(actionNeed("right_click"), "input");
  assert.equal(actionNeed("left_click_drag"), "input");
  assert.equal(actionNeed("type"), "input");
  assert.equal(actionNeed("key"), "input");
  assert.equal(tierAllows("read", "see"), true);
  assert.equal(tierAllows("read", "click"), false);
  assert.equal(tierAllows("click", "click"), true);
  assert.equal(tierAllows("click", "input"), false);
  assert.equal(tierAllows("full", "input"), true);
  assert.equal(tierAllows("refused", "see"), false);
});

test("D353: access: granted for the chat, asked, asked every time, or refused", () => {
  const notepad = app("notepad.exe");
  assert.deepEqual(accessDecision(notepad, "input", false), {
    decision: "ask",
    everyTime: false,
  });
  assert.equal(accessDecision(notepad, "input", true).decision, "allowed");
  const regedit = app("regedit.exe");
  assert.deepEqual(accessDecision(regedit, "click", true), { decision: "ask", everyTime: true });
  const terminal = app("cmd.exe");
  const typing = accessDecision(terminal, "input", true);
  assert.equal(typing.decision, "refused");
  assert.match(typing.reason ?? "", /run_command/);
  assert.equal(accessDecision(terminal, "click", true).decision, "allowed");
  const browser = accessDecision(app("firefox.exe"), "click", false);
  assert.equal(browser.decision, "refused");
  assert.match(browser.reason ?? "", /browser tools/);
  assert.match(accessDecision(app("bitwarden.exe"), "see", true).reason ?? "", /never acts on it/);
});

test("D353: the coordinate frame of a desktop screenshot and back to screen pixels", () => {
  // A 4K monitor: the frame fits 1568 px on its long side.
  const frame = desktopFrame({ x: 0, y: 0, width: 3840, height: 2160 });
  assert.equal(frame.width, 1568);
  assert.equal(frame.height, 882);
  assert.deepEqual(toScreen(frame, [0, 0]), [0, 0]);
  assert.deepEqual(toScreen(frame, [784, 441]), [1920, 1080]);
  // Clamped inside the area.
  assert.deepEqual(toScreen(frame, [5000, 5000]), [3839, 2159]);
  assert.equal(inFrame(frame, [1568, 882]), true);
  assert.equal(inFrame(frame, [1600, 10]), false);
  // A second monitor left of the primary: negative screen coordinates.
  const left = desktopFrame({ x: -1920, y: 0, width: 1920, height: 1080 });
  assert.equal(left.width, 1568);
  assert.deepEqual(toScreen(left, [0, 0]), [-1920, 0]);
  assert.deepEqual(toScreen(left, [784, 441]), [-960, 540]);
  // A small screen isn't scaled up.
  const small = desktopFrame({ x: 0, y: 0, width: 1280, height: 720 });
  assert.deepEqual([small.width, small.height], [1280, 720]);
  assert.deepEqual(toScreen(small, [100, 200]), [100, 200]);
});

test("D353: a zoom captures the region at its own detail", () => {
  const frame = desktopFrame({ x: 0, y: 0, width: 3840, height: 2160 });
  const z = zoomCapture(frame, [0, 0, 392, 220.5]);
  assert.deepEqual(z.area, { x: 0, y: 0, width: 960, height: 540 });
  assert.deepEqual([z.outWidth, z.outHeight], [960, 540]);
  const half = zoomCapture(frame, [0, 0, 392, 220.5], 0.5);
  assert.deepEqual([half.outWidth, half.outHeight], [480, 270]);
});

test("D353: key chords become virtual-key codes", () => {
  assert.deepEqual(chordToVks(parseChord("ctrl+s")), [0x11, 0x53]);
  assert.deepEqual(chordToVks(parseChord("ctrl+shift+Escape")), [0x11, 0x10, 0x1b]);
  assert.deepEqual(chordToVks(parseChord("Enter")), [0x0d]);
  assert.deepEqual(chordToVks(parseChord("alt+F4")), [0x12, 0x73]);
  assert.deepEqual(chordToVks(parseChord("cmd+Down")), [0x5b, 0x28]);
  assert.deepEqual(chordToVks(parseChord("ctrl++")), [0x11, 0xbb]);
  assert.deepEqual(chordToVks(parseChord("shift")), [0x10]);
  assert.throws(() => chordToVks(parseChord("é")), /type/);
});

test("D353: card numbers aren't typed", () => {
  assert.equal(looksLikeCardNumber("4111 1111 1111 1111"), true);
  assert.equal(looksLikeCardNumber("pay with 4242-4242-4242-4242 now"), true);
  assert.equal(looksLikeCardNumber("4111 1111 1111 1112"), false);
  assert.equal(looksLikeCardNumber("call 555 0100 at 10:30"), false);
  assert.equal(looksLikeCardNumber("order 1234567890123"), false);
});

test("D353: the tool row's label", () => {
  assert.equal(computerLabel({ action: "left_click", coordinate: [10, 20] }), "left_click 10, 20");
  assert.equal(computerLabel({ action: "type", text: "hello" }), 'type "hello"');
  assert.equal(
    computerLabel({ action: "key", text: "ctrl+s", action_summary: "Saves the note" }),
    "Saves the note",
  );
});
