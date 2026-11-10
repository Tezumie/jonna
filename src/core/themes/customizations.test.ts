import assert from "node:assert/strict";
import { test } from "node:test";
import { mapColorCustomizations } from "./customizations";

test("Peacock's keys: the bars get their own tokens, not the whole shell", () => {
  const tokens = mapColorCustomizations([
    {
      "titleBar.activeBackground": "#42b883",
      "titleBar.activeForeground": "#15202b",
      "activityBar.background": "#65c89b",
      "statusBar.background": "#42b883",
      "statusBarItem.hoverBackground": "#359268",
      "statusBar.foreground": "#15202b",
    },
  ]);
  assert.equal(tokens["--bg-titlebar"], "#42b883");
  assert.equal(tokens["--fg-titlebar"], "#15202b");
  assert.equal(tokens["--bg-activitybar"], "#65c89b");
  assert.equal(tokens["--bg-statusbar"], "#42b883");
  assert.equal(tokens["--bg-statusbar-hover"], "#359268");
  assert.equal(tokens["--bg-app"], undefined);
});

test("theme ids map like a theme's; our tokens still work; bad values are dropped", () => {
  const tokens = mapColorCustomizations([
    {
      "editor.background": "#101010",
      focusBorder: "#ff8800",
      "--accent": "#5fb3a1",
      "--bad": "red; background: url(x)",
      "statusBar.background": "url(x)",
      "unknown.color": "#123456",
    },
  ]);
  assert.equal(tokens["--bg-surface"], "#101010");
  // Our token is more specific than the VS Code id.
  assert.equal(tokens["--accent"], "#5fb3a1");
  assert.equal(tokens["--bad"], undefined);
  assert.equal(tokens["--bg-statusbar"], undefined);
  assert.equal(Object.values(tokens).includes("#123456"), false);
});

test("the folder's layer wins; [Theme] blocks only under that theme", () => {
  const user = {
    "statusBar.background": "#111111",
    "[Light+]": { "statusBar.background": "#eeeeee" },
  };
  const folder = { "titleBar.activeBackground": "#222222" };
  const dark = mapColorCustomizations([user, folder], "Dark+");
  assert.equal(dark["--bg-statusbar"], "#111111");
  assert.equal(dark["--bg-titlebar"], "#222222");
  const light = mapColorCustomizations([user], "light+");
  assert.equal(light["--bg-statusbar"], "#eeeeee");
  const over = mapColorCustomizations([user, { "statusBar.background": "#333333" }], "Dark+");
  assert.equal(over["--bg-statusbar"], "#333333");
  assert.deepEqual(mapColorCustomizations([null, [], "x"]), {});
});
