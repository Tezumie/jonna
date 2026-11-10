import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextKeyService } from "../core/context/index";
import type { Dispatcher } from "../core/dispatcher/index";
import type { Notifications } from "../ui/Notifications";
import { type EngineKeys, KeyboardService } from "./keyboard";

// The dev-only key log checks targets against Element (no DOM in node).
(globalThis as { Element?: unknown }).Element ??= class {};

/** A keydown with the fields the keyboard service reads. */
class Key extends Event {
  readonly isComposing = false;
  readonly shiftKey = false;
  readonly altKey = false;
  readonly metaKey = false;
  constructor(
    readonly code: string,
    readonly key: string,
    readonly ctrlKey = true,
  ) {
    super("keydown", { cancelable: true });
  }
}

function setup(engineChord: ((first: Key, second: Key) => string | null) | null) {
  const ran: string[] = [];
  const dispatcher = {
    has: (id: string) => id.startsWith("ide."),
    execute: async (id: string) => {
      ran.push(id);
    },
  } as unknown as Dispatcher;
  const context = new ContextKeyService();
  context.set("editorFocus", true);
  const keyboard = new KeyboardService("linux", dispatcher, context, {
    show: () => {},
  } as unknown as Notifications);
  const engineRan: string[] = [];
  const engine: EngineKeys = {
    defaults: [{ key: "ctrl+k ctrl+c", command: "editor.action.addCommentLine" }],
    has: (id) => id.startsWith("editor."),
    title: () => undefined,
    actions: () => [],
    apply: () => {},
    run: (command) => engineRan.push(command),
    handles: () => false,
    chordCommand: (first, second) => {
      const command = engineChord?.(first as unknown as Key, second as unknown as Key) ?? null;
      return command ? { command, args: undefined } : null;
    },
  };
  keyboard.setEngine(engine);
  const target = new EventTarget();
  keyboard.attach(target as unknown as Window);
  const press = (code: string, key: string) => target.dispatchEvent(new Key(code, key));
  return { keyboard, context, ran, engineRan, press };
}

test("a two-key chord the IDE and the editor share goes to the editor when its binding holds (D219)", () => {
  let holds = true;
  const t = setup((first, second) =>
    holds && first.code === "KeyK" && second.code === "KeyC"
      ? "editor.action.addCommentLine"
      : null,
  );
  // An IDE default's binding on the editor's chord.
  t.keyboard.setRules([{ key: "ctrl+k ctrl+c", command: "ide.other" }]);
  t.press("KeyK", "k");
  t.press("KeyC", "c");
  assert.deepEqual(t.engineRan, ["editor.action.addCommentLine"]);
  assert.deepEqual(t.ran, []);
  // The editor's binding doesn't hold now: the IDE's runs.
  holds = false;
  t.press("KeyK", "k");
  t.press("KeyC", "c");
  assert.deepEqual(t.ran, ["ide.other"]);
  // Outside an editor: the IDE's, without asking the editor.
  holds = true;
  t.context.set("editorFocus", false);
  t.press("KeyK", "k");
  t.press("KeyC", "c");
  assert.deepEqual(t.ran, ["ide.other", "ide.other"]);
  assert.equal(t.engineRan.length, 1);
});

test("an extension's binding on the editor's chord wins while its when holds (VS Code's weights)", () => {
  const t = setup(() => "editor.action.addCommentLine");
  t.keyboard.addRules([{ key: "ctrl+k ctrl+c", command: "ide.ext" }]);
  t.press("KeyK", "k");
  t.press("KeyC", "c");
  assert.deepEqual(t.ran, ["ide.ext"]);
  assert.deepEqual(t.engineRan, []);
});

test("the user's own binding on the editor's chord wins (D219)", () => {
  const t = setup(() => "editor.action.addCommentLine");
  t.keyboard.setUserRules([{ key: "ctrl+k ctrl+c", command: "ide.mine" }]);
  t.press("KeyK", "k");
  t.press("KeyC", "c");
  assert.deepEqual(t.ran, ["ide.mine"]);
  assert.deepEqual(t.engineRan, []);
});

test("a removal with a when takes the editor's default with that clause only (D219)", () => {
  const t = setup(null);
  // The editor's default runs through the IDE's table for the chord's second key.
  t.press("KeyK", "k");
  t.press("KeyC", "c");
  assert.deepEqual(t.engineRan, ["editor.action.addCommentLine"]);
  // A removal whose when isn't the default's (it has none) leaves it.
  t.keyboard.setUserRules([
    { key: "ctrl+k ctrl+c", command: "-editor.action.addCommentLine", when: "somethingElse" },
  ]);
  t.press("KeyK", "k");
  t.press("KeyC", "c");
  assert.deepEqual(t.engineRan, ["editor.action.addCommentLine", "editor.action.addCommentLine"]);
  // Without a when it goes.
  t.keyboard.setUserRules([{ key: "ctrl+k ctrl+c", command: "-editor.action.addCommentLine" }]);
  t.press("KeyK", "k");
  t.press("KeyC", "c");
  assert.equal(t.engineRan.length, 2);
});
