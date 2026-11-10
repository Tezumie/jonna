import assert from "node:assert/strict";
import { test } from "node:test";
import { translateVscodeSettings } from "./vscode";

test("VS Code settings are translated", () => {
  const known = new Set([
    "editor.fontSize",
    "editor.wordWrap",
    "terminal.fontSize",
    "workbench.colorTheme",
    "terminal.bell",
  ]);
  const r = translateVscodeSettings(
    {
      "editor.fontSize": 15,
      "editor.wordWrap": "bounded",
      "terminal.integrated.fontSize": 12,
      "workbench.colorTheme": "Default Light Modern",
      "terminal.integrated.enableVisualBell": true,
      "python.analysis.typeCheckingMode": "basic",
      "[python]": { "editor.tabSize": 4 },
    },
    (k) => known.has(k),
  );
  assert.deepEqual(r.values, {
    "editor.fontSize": 15,
    "editor.wordWrap": "on",
    "terminal.fontSize": 12,
    "workbench.colorTheme": "Light+",
    "terminal.bell": "visual",
  });
  assert.deepEqual(r.skipped, ["python.analysis.typeCheckingMode", "[python] editor.tabSize"]);
});

test("VS Code terminal profiles and sessions keep their shape under the IDE's names", () => {
  const profiles = { "Git Bash": { source: "Git Bash" }, "Command Prompt": null };
  const r = translateVscodeSettings(
    {
      "terminal.integrated.profiles.windows": profiles,
      "terminal.integrated.defaultProfile.windows": null,
      "terminal.integrated.defaultProfile.linux": "zsh",
      "terminal.integrated.persistentSessionScrollback": 500,
      "terminal.integrated.suggest.enabled": false,
      "terminal.integrated.gpuAcceleration": "canvas",
    },
    () => true,
  );
  assert.deepEqual(r.values, {
    "terminal.profiles.windows": profiles,
    "terminal.defaultProfile.windows": "",
    "terminal.defaultProfile.linux": "zsh",
    "terminal.persistentSessionScrollback": 500,
    "terminal.suggest.enabled": false,
    "terminal.gpuAcceleration": "auto",
  });
});

test("VS Code color theme names", () => {
  const t = (name: string) =>
    translateVscodeSettings({ "workbench.colorTheme": name }, () => true).values[
      "workbench.colorTheme"
    ];
  assert.equal(t("Default Dark Modern"), "Dark+");
  assert.equal(t("Default Dark+"), "Dark+");
  assert.equal(t("Light+"), "Light+");
  assert.equal(t("Visual Studio Light"), "Light+");
  assert.equal(t("Dracula Theme"), "Dracula Theme");
});

test("the terminal's look and behavior come across from VS Code (D379)", () => {
  const known = (k: string) => k.startsWith("terminal.");
  const r = translateVscodeSettings(
    {
      "terminal.integrated.fontFamily": "Cascadia Mono",
      "terminal.integrated.cursorStyle": "line",
      "terminal.integrated.rightClickBehavior": "default",
      "terminal.integrated.scrollback": 5000,
    },
    known,
  );
  assert.deepEqual(r.values, {
    "terminal.fontFamily": "Cascadia Mono",
    "terminal.cursorStyle": "bar",
    "terminal.rightClickBehavior": "menu",
    "terminal.scrollback": 5000,
  });
  assert.deepEqual(r.skipped, []);
});
