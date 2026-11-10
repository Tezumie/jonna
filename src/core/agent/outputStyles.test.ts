import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUILTIN_STYLES,
  ESSENTIALS,
  findStyle,
  mergeStyles,
  type OutputStyle,
  parseOutputStyleFile,
  styledPrompt,
  styleKey,
} from "./outputStyles";

const PROMPT = `You are a coding agent.

How to work:
- Look before you change.
- Read before editing.

How to talk to the user:
- Be brief.

Memory:
- a note`;

const builtin = (name: string) => findStyle(BUILTIN_STYLES, name).style;

test("parseOutputStyleFile: front matter, the file's name as a fallback", () => {
  const s = parseOutputStyleFile(
    "---\nname: Pirate\ndescription: Talks like a pirate\nkeep-coding-instructions: true\n---\n\nSpeak like a pirate.\n",
    "pirate.md",
    "user",
    "/c/output-styles/pirate.md",
  );
  assert.deepEqual(s, {
    name: "Pirate",
    description: "Talks like a pirate",
    text: "Speak like a pirate.",
    keepCodingInstructions: true,
    source: "user",
    path: "/c/output-styles/pirate.md",
  });
  const plain = parseOutputStyleFile("# Terse\nAnswer in one line.", "terse-mode.md", "project");
  assert.equal(plain?.name, "terse-mode");
  assert.equal(plain?.description, "Terse");
  // Claude Code's default: a custom style drops the coding instructions.
  assert.equal(plain?.keepCodingInstructions, false);
  // Nothing to say: not a style.
  assert.equal(parseOutputStyleFile("---\nname: Empty\n---\n", "e.md", "user"), null);
});

test("findStyle and mergeStyles: by name ignoring case, the first of a name wins", () => {
  assert.equal(builtin("explanatory").name, "Explanatory");
  assert.equal(builtin("  LEARNING ").name, "Learning");
  assert.deepEqual(findStyle(BUILTIN_STYLES, "default"), {
    style: BUILTIN_STYLES[0],
    missing: false,
  });
  // A style that's gone: Default, and says so.
  assert.equal(findStyle(BUILTIN_STYLES, "gone").missing, true);
  assert.equal(findStyle(BUILTIN_STYLES, "gone").style.name, "Default");
  const project: OutputStyle = {
    ...BUILTIN_STYLES[1],
    name: "explanatory",
    source: "project",
  } as OutputStyle;
  const mine: OutputStyle = { ...BUILTIN_STYLES[1], name: "Mine", source: "user" } as OutputStyle;
  const merged = mergeStyles(BUILTIN_STYLES, [project], [mine]);
  assert.deepEqual(
    merged.map((s) => `${s.name}/${s.source}`),
    ["Default/built-in", "Explanatory/built-in", "Learning/built-in", "Mine/user"],
  );
});

test("styledPrompt: built-ins add to how to talk; custom styles replace it", () => {
  // Default changes nothing.
  assert.equal(styledPrompt(PROMPT, builtin("default")), PROMPT);
  assert.equal(styledPrompt(PROMPT, null), PROMPT);
  const explained = styledPrompt(PROMPT, builtin("explanatory"));
  assert.ok(explained.includes('- Be brief.\n\nOutput style (the user chose "Explanatory"'));
  assert.ok(explained.includes("★ Insight"));
  assert.ok(explained.includes("Read before editing."));
  assert.ok(explained.endsWith("Memory:\n- a note"));
  const learning = styledPrompt(PROMPT, builtin("learning"));
  assert.ok(learning.includes("TODO(human)"));

  const custom = (keep: boolean): OutputStyle => ({
    name: "Pirate",
    description: "",
    text: "Speak like a pirate.",
    keepCodingInstructions: keep,
    source: "user",
  });
  // Keeping the coding instructions: only how to talk is replaced.
  const kept = styledPrompt(PROMPT, custom(true));
  assert.ok(kept.includes("Read before editing."));
  assert.ok(!kept.includes("Be brief."));
  assert.ok(kept.includes("Speak like a pirate.\n\nMemory:"));
  // Not keeping them: the essentials instead of how to work.
  const alone = styledPrompt(PROMPT, custom(false));
  assert.ok(alone.startsWith(`You are a coding agent.\n\n${ESSENTIALS}\n\nOutput style`));
  assert.ok(!alone.includes("Read before editing."));
  assert.ok(alone.endsWith("Speak like a pirate.\n\nMemory:\n- a note"));
  // A prompt without the sections (the small-model profile): at the end.
  assert.equal(
    styledPrompt("Small prompt.", custom(false)),
    'Small prompt.\n\nOutput style (the user chose "Pirate"; follow it in every reply):\nSpeak like a pirate.',
  );
});

test("styleKey: changes with what the style says, empty for Default", () => {
  assert.equal(styleKey(builtin("default")), "");
  const a = styleKey(builtin("explanatory"));
  assert.match(a, /^Explanatory:/);
  assert.notEqual(a, styleKey({ ...builtin("explanatory"), text: "other" }));
  assert.equal(a, styleKey(builtin("explanatory")));
});
