// D267: product icon themes: their JSON, glyphs, and the IDE's icons mapped to codicons.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asProductIconTheme,
  CODICON_FOR,
  glyphText,
  iconForCodiconName,
  productGlyph,
} from "./productIcons";

test("an extension's codicon names find the IDE's icon (D284)", () => {
  assert.equal(iconForCodiconName("broadcast"), "radio-tower");
  assert.equal(iconForCodiconName("circle-slash"), "ban");
  assert.equal(iconForCodiconName("no-such-codicon"), undefined);
});

test("a product icon theme's fonts and definitions", () => {
  const doc = asProductIconTheme({
    fonts: [
      { id: "fluent", src: [{ path: "./fluent.woff", format: "woff" }], weight: "normal" },
      { id: "broken", src: [] },
    ],
    iconDefinitions: {
      files: { fontCharacter: "\\e001" },
      close: { fontCharacter: "\\e002", fontId: "fluent" },
      nothing: { fontCharacter: 5 },
    },
  });
  assert.deepEqual(doc.fonts, [
    { id: "fluent", src: [{ path: "./fluent.woff", format: "woff" }], weight: "normal" },
  ]);
  assert.deepEqual(Object.keys(doc.iconDefinitions), ["files", "close"]);
  assert.deepEqual(productGlyph(doc, "x"), { fontCharacter: "\\e002", fontId: "fluent" });
  assert.equal(productGlyph(doc, "files")?.fontCharacter, "\\e001");
  // No glyph in the theme, or no counterpart: the IDE's own icon.
  assert.equal(productGlyph(doc, "search"), undefined);
  assert.equal(productGlyph(doc, "kanban"), undefined);
  assert.deepEqual(asProductIconTheme("nonsense"), { fonts: [], iconDefinitions: {} });
});

test("glyph characters, escaped or not", () => {
  assert.equal(glyphText("\\eb44"), "");
  assert.equal(glyphText("\\1F600"), "\u{1F600}");
  assert.equal(glyphText("A"), "A");
  assert.equal(glyphText("\\110000"), "");
});

test("the activity bar's icons have their codicons", () => {
  for (const [icon, codicon] of [
    ["files", "files"],
    ["search", "search"],
    ["git-branch", "source-control"],
    ["bug-play", "debug-alt"],
    ["blocks", "extensions"],
    ["settings", "settings-gear"],
  ])
    assert.equal(CODICON_FOR[icon as string], codicon);
});
