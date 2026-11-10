import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VSCODE_WEBVIEW_COLORS,
  vscodeColorVar,
  vscodeThemeClass,
  vscodeWebviewVars,
} from "./webviewVars";

test("VS Code's color ids become its CSS variable names", () => {
  assert.equal(vscodeColorVar("editorWidget.background"), "--vscode-editorWidget-background");
  assert.equal(vscodeColorVar("foreground"), "--vscode-foreground");
});

test("the variables take the IDE tokens' values, leaving out what the theme lacks", () => {
  const tokens: Record<string, string> = {
    "--bg-surface": "#1e1e1e",
    "--bg-app": " #181818 ",
    "--accent": "#0078d4",
    "--font-ui": "system-ui",
    "--text-md": "13px",
  };
  const vars = vscodeWebviewVars((t) => tokens[t] ?? "");
  assert.equal(vars["--vscode-editor-background"], "#1e1e1e");
  assert.equal(vars["--vscode-sideBar-background"], "#181818");
  assert.equal(vars["--vscode-button-background"], "#0078d4");
  assert.equal(vars["--vscode-font-family"], "system-ui");
  assert.equal(vars["--vscode-font-size"], "13px");
  assert.equal(vars["--vscode-font-weight"], "normal");
  assert.equal("--vscode-input-background" in vars, false);
});

test("every color maps onto a token", () => {
  for (const [id, token] of Object.entries(VSCODE_WEBVIEW_COLORS)) {
    assert.match(id, /^[A-Za-z][\w.]*$/, id);
    assert.match(token, /^--[a-z0-9-]+$/, `${id}: ${token}`);
  }
});

test("theme kinds become VS Code's body classes", () => {
  assert.equal(vscodeThemeClass("dark"), "vscode-dark");
  assert.equal(vscodeThemeClass("light"), "vscode-light");
  assert.equal(vscodeThemeClass("hc"), "vscode-high-contrast");
  assert.equal(vscodeThemeClass("hc-light"), "vscode-high-contrast-light");
});
