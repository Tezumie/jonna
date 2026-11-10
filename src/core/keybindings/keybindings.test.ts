import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesWhen } from "../context/when";
import {
  chordFromEvent,
  KeybindingResolver,
  type KeybindingRule,
  keybindingLabel,
  normalizeChord,
  parseKeybinding,
} from "./index";

const always = () => true;

test("normalizes chords and keybindings", () => {
  assert.equal(normalizeChord("Shift+Cmd+P"), "shift+meta+p");
  assert.equal(normalizeChord("ctrl+`"), "ctrl+`");
  assert.equal(normalizeChord("Option+Esc"), "alt+escape");
  assert.equal(normalizeChord("ctrl++"), "ctrl++");
  assert.deepEqual(parseKeybinding("ctrl+k  ctrl+o"), ["ctrl+k", "ctrl+o"]);
  assert.throws(() => normalizeChord("ctrl+a+b"));
  assert.throws(() => normalizeChord("ctrl+shift"));
});

test("chordFromEvent uses physical keys and ignores bare modifiers", () => {
  const base = { key: "", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
  assert.equal(
    chordFromEvent({ ...base, code: "KeyP", key: "P", ctrlKey: true, shiftKey: true }),
    "ctrl+shift+p",
  );
  assert.equal(chordFromEvent({ ...base, code: "Backquote", key: "`", ctrlKey: true }), "ctrl+`");
  assert.equal(chordFromEvent({ ...base, code: "F1", key: "F1" }), "f1");
  assert.equal(chordFromEvent({ ...base, code: "ShiftLeft", key: "Shift", shiftKey: true }), null);
  assert.equal(chordFromEvent({ ...base, code: "KeyS", key: "s", metaKey: true }), "meta+s");
});

test("labels per platform", () => {
  assert.equal(keybindingLabel(["ctrl+shift+p"], "windows"), "Ctrl+Shift+P");
  assert.equal(keybindingLabel(["shift+meta+p"], "mac"), "⇧⌘P");
  assert.equal(keybindingLabel(["ctrl+k", "ctrl+o"], "linux"), "Ctrl+K Ctrl+O");
  assert.equal(keybindingLabel(["ctrl+`"], "mac"), "⌃`");
});

const rules: KeybindingRule[] = [
  { key: "ctrl+shift+p", mac: "cmd+shift+p", command: "palette.show" },
  { key: "ctrl+s", mac: "cmd+s", command: "editor.save", when: "activeEditor" },
  { key: "ctrl+s", command: "terminal.thing", when: "terminalFocus" },
  { key: "ctrl+k ctrl+o", mac: "cmd+o", command: "workspace.openFolder" },
];

test("platform-specific keys and later-rule precedence with when clauses", () => {
  const pc = new KeybindingResolver(rules, "linux");
  assert.deepEqual(pc.resolve("ctrl+shift+p", always), {
    kind: "command",
    command: "palette.show",
    args: undefined,
  });
  const ctx = new Set(["activeEditor"]);
  const when = (w: string | undefined) => w === undefined || ctx.has(w);
  assert.equal((pc.resolve("ctrl+s", when) as { command: string }).command, "editor.save");
  ctx.add("terminalFocus");
  assert.equal((pc.resolve("ctrl+s", when) as { command: string }).command, "terminal.thing");
  ctx.clear();
  assert.deepEqual(pc.resolve("ctrl+s", when), { kind: "none" });

  const mac = new KeybindingResolver(rules, "mac");
  assert.equal(mac.resolve("shift+meta+p", always).kind, "command");
  assert.equal(mac.resolve("ctrl+shift+p", always).kind, "none");
  assert.equal(mac.labelFor("workspace.openFolder"), "⌘O");
});

test("multi-chord bindings", () => {
  const r = new KeybindingResolver(rules, "windows");
  assert.deepEqual(r.resolve("ctrl+k", always), { kind: "chordStarted", prefix: "ctrl+k" });
  assert.equal(r.pending, "ctrl+k");
  assert.deepEqual(r.resolve("ctrl+o", always), {
    kind: "command",
    command: "workspace.openFolder",
    args: undefined,
  });
  r.resolve("ctrl+k", always);
  assert.deepEqual(r.resolve("x", always), { kind: "chordCancelled" });
  assert.equal(r.pending, null);
  assert.equal(r.labelFor("workspace.openFolder"), "Ctrl+K Ctrl+O");
});

test("removal rules and user overrides", () => {
  const r = new KeybindingResolver(
    [
      ...rules,
      { key: "ctrl+shift+p", command: "-palette.show" },
      { key: "f1", command: "palette.show" },
    ],
    "linux",
  );
  assert.deepEqual(r.resolve("ctrl+shift+p", always), { kind: "none" });
  assert.equal(r.labelFor("palette.show"), "F1");
});

test("a key that is a command and starts chords: Ctrl+K inline edit (D172)", () => {
  const r = new KeybindingResolver(
    [
      ...rules,
      { key: "ctrl+k v", command: "preview.toSide" },
      { key: "ctrl+k", command: "editor.inlineEdit", when: "editorFocus" },
      { key: "escape", command: "editor.inlineEdit.reject", when: "editorFocus" },
    ],
    "windows",
  );
  const editor = (w: string | undefined) => w === undefined || w === "editorFocus";
  // In the editor: the command runs now, and a chord can still follow.
  assert.deepEqual(r.resolve("ctrl+k", editor), {
    kind: "command",
    command: "editor.inlineEdit",
    args: undefined,
    chordPending: true,
  });
  assert.deepEqual(r.resolve("ctrl+o", editor), {
    kind: "command",
    command: "workspace.openFolder",
    args: undefined,
    after: "editor.inlineEdit",
  });
  // A plain key after it is typing (not Ctrl+K V), and nothing is "not a command".
  r.resolve("ctrl+k", editor);
  assert.deepEqual(r.resolve("v", editor), { kind: "none" });
  assert.equal(r.pending, null);
  r.resolve("ctrl+k", editor);
  assert.deepEqual(r.resolve("ctrl+x", editor), { kind: "none" });
  // Esc right after Ctrl+K closes the prompt (its own binding, not a chord's second key).
  r.resolve("ctrl+k", editor);
  assert.equal(
    (r.resolve("escape", editor) as { command: string }).command,
    "editor.inlineEdit.reject",
  );
  // Elsewhere (no editor focus): a plain chord prefix, as before.
  assert.deepEqual(
    r.resolve("ctrl+k", (w) => w === undefined),
    {
      kind: "chordStarted",
      prefix: "ctrl+k",
    },
  );
  assert.equal(
    (r.resolve("v", (w) => w === undefined) as { command: string }).command,
    "preview.toSide",
  );
});

test("the second key of a chord keeps the rule's args (D207)", () => {
  const r = new KeybindingResolver(
    [
      { key: "ctrl+k", command: "inline.edit" },
      { key: "ctrl+k ctrl+j", command: "cursorMove", args: { to: "down", value: 3 } },
      { key: "ctrl+m ctrl+j", command: "cursorMove", args: { to: "up" } },
    ],
    "linux",
  );
  const all = () => true;
  assert.equal(r.resolve("ctrl+k", all).kind, "command");
  assert.deepEqual(r.resolve("ctrl+j", all), {
    kind: "command",
    command: "cursorMove",
    args: { to: "down", value: 3 },
    after: "inline.edit",
  });
  assert.equal(r.resolve("ctrl+m", all).kind, "chordStarted");
  assert.deepEqual(r.resolve("ctrl+j", all), {
    kind: "command",
    command: "cursorMove",
    args: { to: "up" },
  });
});

test("F11: Step Into while debugging is paused, full screen otherwise, in either order (D387)", () => {
  const fullScreen = {
    key: "f11",
    mac: "ctrl+cmd+f",
    command: "window.toggleFullscreen",
    when: "debugState != 'stopped'",
  };
  const stepInto = { key: "f11", command: "debug.stepInto", when: "debugState == 'stopped'" };
  for (const order of [
    [fullScreen, stepInto],
    [stepInto, fullScreen],
  ]) {
    const r = new KeybindingResolver(order, "windows");
    const command = (debugState: string | undefined) =>
      (
        r.resolve("f11", (w) =>
          matchesWhen(w, (k) => (k === "debugState" ? debugState : undefined)),
        ) as {
          command?: string;
        }
      ).command;
    assert.equal(command(undefined), "window.toggleFullscreen");
    assert.equal(command("running"), "window.toggleFullscreen");
    assert.equal(command("stopped"), "debug.stepInto");
  }
  const mac = new KeybindingResolver([fullScreen], "mac");
  assert.equal(
    (mac.resolve("ctrl+meta+f", always) as { command?: string }).command,
    "window.toggleFullscreen",
  );
});

test("a rule whose key can't be read is skipped, not fatal to the whole table", () => {
  const resolver = new KeybindingResolver(
    [
      { key: "ctrl+a", command: "test.a" },
      { key: "ctrl+shift+", command: "test.broken" },
      { key: "ctrl+x", mac: "cmd+a+b", command: "test.brokenMac" },
      { key: "", command: "test.empty" },
    ],
    "mac",
  );
  const result = resolver.resolve("ctrl+a", () => true);
  assert.equal(result.kind === "command" && result.command, "test.a");
  assert.equal(resolver.keybindingFor("test.broken"), undefined);
});
