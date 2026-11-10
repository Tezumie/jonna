import assert from "node:assert/strict";
import { test } from "node:test";
import { terminalSelection, themeColors } from "./vscodeColors";

test("a theme's colors: hex values only", () => {
  assert.deepEqual(
    themeColors({ colors: { "editor.background": "#1e1e1e", bad: "red", "x.y": 3 } }),
    { "editor.background": "#1e1e1e" },
  );
  assert.deepEqual(themeColors(null), {});
});

test("the terminal's selection follows the theme: its own, else the editor's", () => {
  assert.equal(
    terminalSelection({
      colors: {
        "terminal.selectionBackground": "#112233",
        "editor.selectionBackground": "#445566",
      },
    }),
    "#112233",
  );
  assert.equal(
    terminalSelection({ colors: { "editor.selectionBackground": "#3e4a5c" } }),
    "#3e4a5c",
  );
  assert.equal(terminalSelection({ colors: {} }), undefined);
});
