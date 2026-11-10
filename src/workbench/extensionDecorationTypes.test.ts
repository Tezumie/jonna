import assert from "node:assert/strict";
import { test } from "node:test";
import { decorationTypeCss, normalizeDecorationType, toCssColor } from "./extensionDecorationTypes";

test("colors: theme names, VS Code ids, literals; anything else dropped", () => {
  assert.equal(toCssColor("error"), "var(--status-danger-fg)");
  assert.equal(toCssColor({ id: "editorWarning.foreground" }), "var(--status-warning-fg)");
  assert.equal(toCssColor("label3"), "var(--label-3)");
  assert.equal(toCssColor("#abc"), "#abc");
  assert.equal(toCssColor("#a1b2c3d4"), "#a1b2c3d4");
  assert.equal(toCssColor("rgba(1, 2, 3, 0.5)"), "rgba(1, 2, 3, 0.5)");
  assert.equal(toCssColor("transparent"), "transparent");
  for (const bad of [
    "red; background: url(x)",
    "#12345",
    "rgb(1,2,3); x",
    "url(https://e.com)",
    "var(--anything)",
    "expression(alert(1))",
    "",
    42,
  ])
    assert.equal(toCssColor(bad), undefined, String(bad));
});

test("decoration types: checked options, light/dark, attachments, ruler, gutter", () => {
  const style = normalizeDecorationType({
    color: "error",
    backgroundColor: "#ff000022",
    borderColor: "warning",
    borderWidth: "9px",
    borderStyle: "groove",
    fontStyle: "italic",
    fontWeight: "bold",
    textDecoration: "underline wavy",
    opacity: "0.5",
    isWholeLine: true,
    after: { contentText: "  ← bad\nline", color: "subtle", margin: "2em" },
    before: { contentText: "" },
    overviewRulerColor: "error",
    overviewRulerLane: "right",
    gutterColor: "label1",
    dark: { color: "#fff" },
    light: { unknown: 1 },
  });
  assert.deepEqual(style.look, {
    color: "var(--status-danger-fg)",
    backgroundColor: "#ff000022",
    borderColor: "var(--status-warning-fg)",
    borderStyle: "solid",
    borderWidth: 3,
    fontStyle: "italic",
    fontWeight: "bold",
    textDecoration: "underline wavy",
    opacity: 0.5,
  });
  assert.equal(style.isWholeLine, true);
  assert.deepEqual(style.after, {
    contentText: "  ← bad line",
    color: "var(--fg-subtle)",
    marginEm: 2,
  });
  assert.equal(style.before, undefined);
  assert.equal(style.light, undefined);
  assert.deepEqual(style.dark, { color: "#fff" });
  assert.deepEqual(style.overviewRuler, { color: "var(--status-danger-fg)", lane: "right" });
  assert.equal(style.gutterColor, "var(--label-1)");
  // A bad color is left out; a type that shows nothing is allowed (as in VS Code).
  assert.equal(normalizeDecorationType({ color: "javascript:x" }).look.color, undefined);

  const css = decorationTypeCss("ext-dt-7", style);
  assert.match(css, /^\.ext-dt-7 \{ color: var\(--status-danger-fg\);/);
  assert.match(
    css,
    /\.monaco-editor\.vs-dark \.ext-dt-7, \.monaco-editor\.hc-black \.ext-dt-7 \{ color: #fff; \}/,
  );
  assert.match(css, /\.ext-dt-7-after \{ color: var\(--fg-subtle\); margin-left: 2em; \}/);
  assert.match(css, /\.ext-dt-7-gutter \{ border-left: 3px solid var\(--label-1\)/);
  assert.ok(!css.includes("url("));
});
