import assert from "node:assert/strict";
import { test } from "node:test";
import { selectionLabel } from "./selectionLabel";

test("selectionLabel: one cursor, a selection and several cursors, like VS Code (D207)", () => {
  const cursor = { line: 3, column: 7 };
  assert.equal(selectionLabel({ cursor, selections: 1, characters: 0 }), "Ln 3, Col 7");
  assert.equal(
    selectionLabel({ cursor, selections: 1, characters: 12 }),
    "Ln 3, Col 7 (12 selected)",
  );
  assert.equal(selectionLabel({ cursor, selections: 3, characters: 0 }), "3 selections");
  assert.equal(
    selectionLabel({ cursor, selections: 3, characters: 40 }),
    "3 selections (40 characters selected)",
  );
});
