import assert from "node:assert/strict";
import { test } from "node:test";
import { engineCommandTitle } from "./engineTitles";

test("engineCommandTitle: the table, then the id in words (D207)", () => {
  assert.equal(engineCommandTitle("cursorDown"), "Cursor down");
  assert.equal(engineCommandTitle("cursorHome"), "Cursor to line start");
  assert.equal(engineCommandTitle("cursorHomeSelect"), "Cursor to line start with selection");
  assert.equal(engineCommandTitle("cursorWordLeftSelect"), "Cursor word left with selection");
  assert.equal(engineCommandTitle("deleteWordLeft"), "Delete word left");
  assert.equal(engineCommandTitle("tab"), "Indent or insert tab");
  assert.equal(engineCommandTitle("editor.action.inlineSuggest.commit"), "Inline suggest commit");
  assert.equal(engineCommandTitle("scrollPageDown"), "Scroll page down");
  assert.equal(engineCommandTitle("expandLineSelection"), "Expand line selection");
  assert.equal(engineCommandTitle("editor.action.showHTMLPreview"), "Show HTML preview");
});
