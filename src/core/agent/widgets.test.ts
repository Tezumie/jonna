import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_PROMPT_CHARS,
  MAX_WIDGET_CHARS,
  MAX_WIDGET_HEIGHT,
  MIN_WIDGET_HEIGHT,
  PromptLimiter,
  parseWidget,
  promptText,
  widgetContent,
  widgetDocument,
  widgetFileName,
  widgetGuide,
  widgetHeight,
  widgetId,
  widgetLabel,
  widgetMode,
} from "./widgets";

test("widgetMode: <svg first is SVG, anything else HTML", () => {
  assert.equal(widgetMode('<svg viewBox="0 0 10 10"></svg>'), "svg");
  assert.equal(widgetMode("  \n<SVG>"), "svg");
  assert.equal(widgetMode('<?xml version="1.0"?>\n<!-- a chart -->\n<svg>'), "svg");
  assert.equal(widgetMode("<div><svg></svg></div>"), "html");
  assert.equal(widgetMode("<svgx>"), "html");
  assert.equal(widgetMode("<style>svg{}</style><svg>"), "html");
  assert.equal(widgetMode("hello"), "html");
});

test("widgetId / widgetLabel: snake_case ids, read as a sentence", () => {
  assert.equal(widgetId("Sales by month"), "sales_by_month");
  assert.equal(widgetId("  Café — chart!! "), "cafe_chart");
  assert.equal(widgetId("___"), "widget");
  assert.equal(widgetId(""), "widget");
  assert.ok(widgetId("x".repeat(200)).length <= 60);
  assert.equal(widgetLabel("sales_by_month"), "Sales by month");
  assert.equal(widgetLabel(""), "Widget");
});

test("parseWidget: title, code, mode and loading lines; errors say what's wrong", () => {
  const w = parseWidget({
    title: "Counter demo",
    widget_code: "<button>+1</button>",
    loading_messages: ["Counting  sheep", "", 3, "a", "b", "c", "d"],
  });
  assert.ok(!("error" in w));
  assert.equal(w.title, "counter_demo");
  assert.equal(w.mode, "html");
  assert.deepEqual(w.loading, ["Counting sheep", "a", "b", "c"]);
  const svg = parseWidget({ title: "pie", widget_code: "```svg\n<svg></svg>\n```" });
  assert.ok(!("error" in svg));
  assert.equal(svg.mode, "svg");
  assert.equal(svg.code, "<svg></svg>");
  assert.deepEqual(svg.loading, []);
  assert.match((parseWidget({ title: "x" }) as { error: string }).error, /empty/);
  assert.match(
    (parseWidget({ widget_code: "a".repeat(MAX_WIDGET_CHARS + 1) }) as { error: string }).error,
    /at most/,
  );
  assert.equal((parseWidget({ widget_code: "<p>x</p>" }) as { title: string }).title, "widget");
});

test("widgetContent: a whole page sent anyway keeps its head's styles and its body", () => {
  const page =
    "<!DOCTYPE html>\n<html><head><meta charset='utf-8'><title>T</title><style>p{}</style></head><body><p>x</p></body></html>";
  assert.equal(widgetContent(page), "<style>p{}</style>\n<p>x</p>");
  assert.equal(widgetContent("<html><p>y</p></html>"), "<p>y</p>");
  // Content that only mentions the tags stays as it is.
  const js = "<script>el.innerHTML = '<body>'</script>";
  assert.equal(widgetContent(js), js);
  assert.equal((parseWidget({ widget_code: page }) as { code: string }).code, widgetContent(page));
});

test("widgetFileName: the id with the mode's extension", () => {
  assert.equal(widgetFileName({ title: "Sales chart", mode: "svg" }), "sales_chart.svg");
  assert.equal(widgetFileName({ title: "", mode: "html" }), "widget.html");
});

test("widgetHeight: numbers only, clamped", () => {
  assert.equal(widgetHeight(120.2), 121);
  assert.equal(widgetHeight(2), MIN_WIDGET_HEIGHT);
  assert.equal(widgetHeight(99_999), MAX_WIDGET_HEIGHT);
  assert.equal(widgetHeight(5000, 2000), 2000);
  assert.equal(widgetHeight("300"), null);
  assert.equal(widgetHeight(Number.NaN), null);
  assert.equal(widgetHeight(Number.POSITIVE_INFINITY), null);
  assert.equal(widgetHeight(-1), null);
});

test("promptText: trimmed text, capped; nothing else", () => {
  assert.equal(promptText("  explain Q3  "), "explain Q3");
  assert.equal(promptText("   "), null);
  assert.equal(promptText(42), null);
  assert.equal(promptText({ text: "x" }), null);
  assert.equal(promptText("x".repeat(MAX_PROMPT_CHARS + 50))?.length, MAX_PROMPT_CHARS);
});

test("PromptLimiter: one per gap, a few per minute", () => {
  const limit = new PromptLimiter(1500, 3);
  assert.equal(limit.allow(0), true);
  assert.equal(limit.allow(500), false);
  assert.equal(limit.allow(1500), true);
  assert.equal(limit.allow(3000), true);
  // A fourth within the minute is refused, however spaced.
  assert.equal(limit.allow(10_000), false);
  assert.equal(limit.allow(59_999), false);
  // The first has left the window.
  assert.equal(limit.allow(60_000), true);
  // A refused call doesn't count.
  const other = new PromptLimiter(1000, 6);
  assert.equal(other.allow(0), true);
  for (let t = 1; t < 1000; t += 100) assert.equal(other.allow(t), false);
  assert.equal(other.allow(1000), true);
});

test("widgetDocument: an SVG gets its namespace; HTML a whole themed page", () => {
  assert.equal(
    widgetDocument({ title: "a", code: "<svg viewBox='0 0 1 1'></svg>", mode: "svg" }),
    "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox='0 0 1 1'></svg>\n",
  );
  const own = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  assert.equal(widgetDocument({ title: "a", code: own, mode: "svg" }), `${own}\n`);
  const html = widgetDocument(
    { title: "my_widget", code: "<p>hi</p>", mode: "html" },
    { "--fg-default": "#eee", "--bad": "red;}</style><script>", "not-a-var": "x" },
    "light",
  );
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>My widget<\/title>/);
  assert.match(html, /--fg-default: #eee;/);
  assert.match(html, /color-scheme: light;/);
  assert.doesNotMatch(html, /--bad|not-a-var/);
  assert.match(html, /<body>\n<p>hi<\/p>\n<\/body>/);
  assert.match(html, /window\.sendPrompt/);
});

test("widgetGuide: names the variables and the rules", () => {
  const g = widgetGuide();
  assert.match(g, /--label-1/);
  assert.match(g, /--bg-input/);
  assert.match(g, /sendPrompt/);
  assert.match(g, /No network/);
});
