import assert from "node:assert/strict";
import { test } from "node:test";
import { over, parseCssColor, toHex, withAlpha } from "./color";
import { mapVsCodeTheme, readableOnAccent } from "./importer";

test("parses computed color formats", () => {
  assert.deepEqual(parseCssColor("rgb(24, 25, 28)"), { r: 24, g: 25, b: 28, a: 1 });
  assert.deepEqual(parseCssColor("rgba(255, 255, 255, 0.06)"), { r: 255, g: 255, b: 255, a: 0.06 });
  assert.deepEqual(parseCssColor("rgb(255 255 255 / 6%)"), { r: 255, g: 255, b: 255, a: 0.06 });
  const mixed = parseCssColor("color(srgb 0.545098 0.592157 1 / 0.14)");
  assert.equal(toHex(mixed ?? { r: 0, g: 0, b: 0, a: 1 }), "#8b97ff24");
  assert.equal(toHex(parseCssColor("#8B97FF") ?? { r: 0, g: 0, b: 0, a: 0 }), "#8b97ff");
  assert.equal(toHex(parseCssColor("#abc") ?? { r: 0, g: 0, b: 0, a: 0 }), "#aabbcc");
  assert.equal(parseCssColor("nonsense"), null);
});

test("alpha helpers", () => {
  const accent = { r: 139, g: 151, b: 255, a: 1 };
  assert.equal(toHex(withAlpha(accent, 0.28)), "#8b97ff47");
  assert.equal(
    toHex(over(withAlpha({ r: 255, g: 255, b: 255, a: 1 }, 0.5), { r: 0, g: 0, b: 0, a: 1 })),
    "#808080",
  );
});

test("maps VS Code theme colors to semantic tokens", () => {
  const { kind, tokens } = mapVsCodeTheme({
    type: "light",
    colors: {
      "editor.background": "#fafafa",
      focusBorder: "#0066bf",
      "button.background": "#111",
      bogus: "#000",
      "editor.foreground": "red",
    },
  });
  assert.equal(kind, "light");
  assert.deepEqual(tokens, { "--bg-surface": "#fafafa", "--accent": "#0066bf" });
  assert.equal(mapVsCodeTheme({}).kind, "dark");
});

test("surfaces the theme's text can't be read on are left out (Slack Ochin)", () => {
  const { tokens } = mapVsCodeTheme({
    type: "light",
    colors: {
      "editor.background": "#FFF",
      "editor.foreground": "#000",
      "titleBar.activeBackground": "#2D3E4C",
      "activityBar.background": "#161F26",
      "menu.background": "#161F26",
      "input.background": "#FFF",
      "panel.border": "#bd93f9",
      focusBorder: "#161F26",
    },
  });
  assert.equal(tokens["--bg-surface"], "#FFF");
  assert.equal(tokens["--bg-surface-sunken"], "#FFF");
  assert.equal(tokens["--bg-app"], undefined);
  assert.equal(tokens["--bg-overlay"], undefined);
  assert.equal(tokens["--border-default"], undefined);
  assert.equal(tokens["--accent"], undefined, "a near-black focus border isn't an accent");
});

test("readableOnAccent: dark text on a light accent, the theme's own when it reads (D190)", async () => {
  const { readableOnAccent, mapVsCodeTheme } = await import("./importer");
  assert.deepEqual(readableOnAccent({ "--accent": "#f5c518" }), { "--fg-on-accent": "#000000" });
  assert.deepEqual(readableOnAccent({ "--accent": "#1f6feb" }), {});
  const t = mapVsCodeTheme({
    type: "dark",
    colors: { "button.background": "#f5c518", "button.foreground": "#ffffff" },
  });
  assert.equal(t.tokens["--fg-on-accent"], "#000000");
});

test("D258: a theme without menu colors gets VS Code's fallbacks for menus and tooltips", () => {
  const t = mapVsCodeTheme({
    type: "dark",
    colors: { "editor.foreground": "#d6deeb", "editorWidget.background": "#021320" },
  });
  assert.equal(t.tokens["--bg-overlay"], "#021320");
});

test("D258: a theme's scrollbar colors reach every scrollbar", () => {
  const t = mapVsCodeTheme({
    type: "dark",
    colors: {
      "scrollbarSlider.background": "#084d8180",
      "scrollbarSlider.activeBackground": "#084d81",
    },
  });
  assert.equal(t.tokens["--scrollbar-thumb"], "#084d8180");
  assert.equal(t.tokens["--scrollbar-thumb-near"], "#084d8180");
  assert.equal(t.tokens["--scrollbar-thumb-active"], "#084d81");
});

test("Claude Dark maps to the IDE's tokens: the Claude app's surfaces, the clay accent (D269)", async () => {
  const { CLAUDE_DARK } = await import("./claudeDark");
  const mapped = mapVsCodeTheme(CLAUDE_DARK);
  assert.equal(mapped.kind, "dark");
  assert.equal(mapped.tokens["--accent"], "#d97757");
  assert.equal(mapped.tokens["--bg-surface"], "#191919");
  assert.equal(mapped.tokens["--bg-app"], "#1f1f1f");
  assert.equal(mapped.tokens["--fg-default"], "#e5ecee");
});

test("a subtle text color as bright as the text isn't taken (D273: Claude Dark)", async () => {
  const { CLAUDE_DARK } = await import("./claudeDark");
  const bright = mapVsCodeTheme({
    type: "dark",
    colors: { "editor.foreground": "#e5e5e5", "editorLineNumber.activeForeground": "#e5e5e5" },
  });
  assert.equal(bright.tokens["--fg-subtle"], undefined);
  const dim = mapVsCodeTheme({
    type: "dark",
    colors: { "editor.foreground": "#e5e5e5", "editorLineNumber.activeForeground": "#7a7a7a" },
  });
  assert.equal(dim.tokens["--fg-subtle"], "#7a7a7a");
  assert.equal(mapVsCodeTheme(CLAUDE_DARK).tokens["--fg-subtle"], undefined);
});

test("colors that aren't strings (a corrupt stored theme) read as no color, not a throw", () => {
  assert.equal(parseCssColor(42 as unknown as string), null);
  assert.equal(parseCssColor(null as unknown as string), null);
  const tokens = { "--accent": { bad: true }, "--fg-on-accent": 7 } as unknown as Record<
    string,
    string
  >;
  assert.deepEqual(readableOnAccent(tokens), {});
});
