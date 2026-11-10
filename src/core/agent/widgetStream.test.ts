import assert from "node:assert/strict";
import { test } from "node:test";
import { drawableMarkup, partialJsonArgs, widgetDraft } from "./widgetStream";

test("partialJsonArgs: strings and string arrays, as far as they got", () => {
  const whole = partialJsonArgs(
    '{"loading_messages":["One","Two"],"title":"chart","n":3,"o":{"a":"}"},"widget_code":"<svg>\\n</svg>"}',
  );
  assert.deepEqual(whole.strings, { title: "chart", widget_code: "<svg>\n</svg>" });
  assert.deepEqual(whole.arrays, { loading_messages: ["One", "Two"] });
  // Cut in a string: the text so far.
  assert.equal(
    partialJsonArgs('{"title":"a","widget_code":"<div class=\\"x').strings.widget_code,
    '<div class="x',
  );
  // An escape cut in half is left out until it's whole.
  assert.equal(partialJsonArgs('{"widget_code":"ab\\').strings.widget_code, "ab");
  assert.equal(partialJsonArgs('{"widget_code":"ab\\u00').strings.widget_code, "ab");
  assert.equal(partialJsonArgs('{"widget_code":"ab\\u00e9"}').strings.widget_code, "abé");
  // A line still being written isn't shown; the finished ones are.
  assert.deepEqual(partialJsonArgs('{"loading_messages":["Done","Half').arrays.loading_messages, [
    "Done",
  ]);
  // A key cut off, or not JSON at all: nothing.
  assert.deepEqual(partialJsonArgs('{"wid').strings, {});
  assert.deepEqual(partialJsonArgs("").strings, {});
  assert.deepEqual(partialJsonArgs("nope").strings, {});
  // A `}` where an array item should be ends the array instead of looping forever.
  const broken = partialJsonArgs('{"loading_messages": ["a" }, "title": "x"}');
  assert.deepEqual(broken.arrays, { loading_messages: ["a"] });
  assert.deepEqual(partialJsonArgs('{"loading_messages":[1 }').arrays, { loading_messages: [] });
});

test("drawableMarkup: no scripts, and nothing half-written", () => {
  // An unclosed tag, and one cut in a half-written attribute.
  assert.equal(drawableMarkup("<div><p>Hi</p><spa"), "<div><p>Hi</p>");
  assert.equal(drawableMarkup('<svg><rect width="1'), "<svg>");
  assert.equal(drawableMarkup('<svg><rect title="a > b'), "<svg>");
  assert.equal(drawableMarkup('<svg><rect title="a > b" />'), '<svg><rect title="a > b" />');
  // Unclosed elements stay: the frame's parser closes them.
  assert.equal(drawableMarkup("<div><ul><li>One"), "<div><ul><li>One");
  // Scripts never run from a draft: complete ones are left out, an open one cuts the rest.
  assert.equal(drawableMarkup("<p>a</p><script>go()</script><p>b</p>"), "<p>a</p><p>b</p>");
  assert.equal(drawableMarkup("<p>a</p><script>let x = '<b>'; go("), "<p>a</p>");
  assert.equal(drawableMarkup("<p>a</p><SCRIPT type=module>"), "<p>a</p>");
  assert.equal(drawableMarkup("<p>a</p><scr"), "<p>a</p>");
  // An open comment, a lone `<`, an entity cut in half.
  assert.equal(drawableMarkup("<p>a</p><!-- note"), "<p>a</p>");
  assert.equal(drawableMarkup("<p>a</p><!-- note --><p>"), "<p>a</p><!-- note --><p>");
  assert.equal(drawableMarkup("<p>a <"), "<p>a ");
  assert.equal(drawableMarkup("<p>Tom &am"), "<p>Tom ");
  assert.equal(drawableMarkup("<p>Tom &amp; Jerry"), "<p>Tom &amp; Jerry");
  // Text with a less-than that isn't a tag stays.
  assert.equal(drawableMarkup("<p>1 < 2"), "<p>1 < 2");
});

test("widgetDraft: title, paintable code and loading lines from partial arguments", () => {
  const early = widgetDraft('{"loading_messages":["Plotting"],"title":"Sales by month","widget');
  assert.deepEqual(early, {
    title: "sales_by_month",
    code: "",
    mode: "html",
    loading: ["Plotting"],
    chars: 0,
  });
  const mid = widgetDraft(
    '{"title":"t","widget_code":"<svg viewBox=\\"0 0 100 50\\"><rect x=\\"1\\" width=\\"20\\"/><rect x=\\"3',
  );
  assert.equal(mid.mode, "svg");
  assert.equal(mid.code, '<svg viewBox="0 0 100 50"><rect x="1" width="20"/>');
  // Too little to draw yet.
  assert.equal(widgetDraft('{"widget_code":"<svg vi').code, "");
  // A fence's opening line is left out; a whole page's head and body as the frame draws them.
  assert.equal(
    widgetDraft('{"widget_code":"```html\\n<div>Hi there</div>').code,
    "<div>Hi there</div>",
  );
  assert.equal(
    widgetDraft(
      '{"widget_code":"<!doctype html><html><head><style>p{}</style></head><body><p>One</p><p>Tw',
    ).code,
    "<style>p{}</style>\n<p>One</p><p>Tw",
  );
});
