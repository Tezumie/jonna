import assert from "node:assert/strict";
import { test } from "node:test";
import { MarkdownStream, renderMarkdown } from "./markdown";
import { clip, colorEnabled, makeStyle, PLAIN, sanitize, stripAnsi, unicodeEnabled } from "./style";

const color = makeStyle(true, true);
const ascii = makeStyle(true, false);
const B = "\x1b[1m";
const B_OFF = "\x1b[22m";
const I = "\x1b[3m";
const I_OFF = "\x1b[23m";
const U = "\x1b[4m";
const C = "\x1b[36m";
const C_OFF = "\x1b[39m";
const RESET = "\x1b[0m";

/** The text in pieces of `size` characters, as a model streams it. */
const streamed = (text: string, size: number, style = color): string => {
  const stream = new MarkdownStream(style);
  let out = "";
  for (let i = 0; i < text.length; i += size) out += stream.write(text.slice(i, i + size));
  return out + stream.end();
};

test("without colour, Markdown passes through unchanged", () => {
  const text = "# Title\n\n- **bold** and `code`\n";
  assert.equal(renderMarkdown(text, PLAIN), text);
  assert.equal(streamed(text, 3, PLAIN), text);
});

test("inline marks: bold, italic, code", () => {
  assert.equal(renderMarkdown("a **bold** b", color), `a ${B}bold${B_OFF} b`);
  assert.equal(renderMarkdown("an *italic* word", color), `an ${I}italic${I_OFF} word`);
  assert.equal(renderMarkdown("an _italic_ word", color), `an ${I}italic${I_OFF} word`);
  assert.equal(renderMarkdown("run `npm test` now", color), `run ${C}npm test${C_OFF} now`);
  // Marks inside code are text.
  assert.equal(renderMarkdown("`a * b ** c _d_`", color), `${C}a * b ** c _d_${C_OFF}`);
});

test("what only looks like a mark stays text", () => {
  assert.equal(
    renderMarkdown("snake_case_name and 2 * 3 * 4", color),
    "snake_case_name and 2 * 3 * 4",
  );
  assert.equal(renderMarkdown("a ** b", color), "a ** b");
  assert.equal(renderMarkdown("\\*not italic\\*", color), "*not italic*");
  assert.equal(renderMarkdown("C:\\Users\\me", color), "C:\\Users\\me");
});

test("blocks: headings, lists, quotes, rules, fences", () => {
  assert.equal(renderMarkdown("# Title\nnext", color), `${B}${U}Title${RESET}\nnext`);
  assert.equal(renderMarkdown("### Small\n", color), `${B}Small${RESET}\n`);
  assert.equal(renderMarkdown("- one\n  * two\n", color), "• one\n  • two\n");
  assert.equal(renderMarkdown("- one\n", ascii), "- one\n");
  assert.equal(renderMarkdown("- [ ] todo\n- [x] done\n", color), "☐ todo\n☑ done\n");
  assert.equal(renderMarkdown("1. first\n", color), "1. first\n");
  assert.equal(stripAnsi(renderMarkdown("> quoted\n", color)), "│ quoted\n");
  assert.equal(stripAnsi(renderMarkdown("---\n", color)), `${"─".repeat(24)}\n`);
  const fenced = stripAnsi(renderMarkdown("```ts\nconst a = `x` * **2**;\n```\nafter", color));
  assert.equal(fenced, "┌ ts\n│ const a = `x` * **2**;\n\nafter");
});

test("links show their text and their address", () => {
  assert.equal(
    stripAnsi(renderMarkdown("see [the docs](https://example.com/a) here", color)),
    "see the docs (https://example.com/a) here",
  );
  assert.equal(
    stripAnsi(renderMarkdown("an array[0] and [x] stay", color)),
    "an array[0] and [x] stay",
  );
});

test("a style left open ends with its line", () => {
  assert.equal(renderMarkdown("**never closed\nnext", color), `${B}never closed${RESET}\nnext`);
});

test("streaming in any chunk size gives the same output as the whole text", () => {
  const text = [
    "# A heading with `code`",
    "",
    "Some **bold text**, an *italic*, a [link](https://example.com) and snake_case.",
    "- item **one**",
    "- item two",
    "1. numbered",
    "> a quote",
    "",
    "```js",
    "const x = a * b; // **not bold**",
    "```",
    "---",
    "The end * with stars ** alone.",
  ].join("\n");
  const whole = renderMarkdown(text, color);
  for (const size of [1, 2, 3, 5, 7, 16, 64])
    assert.equal(streamed(text, size), whole, `size ${size}`);
  // And the visible text is the source without its marks.
  assert.match(
    stripAnsi(whole),
    /A heading with code\n\nSome bold text, an italic, a link \(https:\/\/example\.com\)/,
  );
});

test("a streamed answer prints as it comes, holding only what can't be decided yet", () => {
  const stream = new MarkdownStream(color);
  assert.equal(stream.write("Hello wor"), "Hello wor");
  assert.equal(stream.write("ld *"), "ld ");
  assert.equal(stream.write("*bold"), `${B}bold`);
  assert.equal(stream.write("** done\n"), `${B_OFF} done\n`);
  // A line's first characters wait until they can't be a block mark any more.
  assert.equal(stream.write("#"), "");
  assert.equal(stream.write("# Title"), `${B}Title`);
  assert.equal(stream.end(), RESET);
});

test("escape sequences and control characters from the model never reach the terminal", () => {
  const evil = "safe\x1b[2J\x1b]0;title\x07 text\x07\x00 \x1b[31mred";
  assert.equal(sanitize(evil), "safe text red");
  assert.equal(renderMarkdown(evil, color), "safe text red");
  assert.equal(renderMarkdown(evil, PLAIN), "safe text red");
  assert.equal(sanitize("a\r\nb\tc"), "a\nb\tc");
});

test("colour: NO_COLOR, FORCE_COLOR, the flags, a terminal or not", () => {
  const env = (e: Record<string, string>, isTTY: boolean, flag?: boolean) =>
    colorEnabled({ isTTY, env: e, platform: "linux", flag });
  assert.equal(env({}, true), true);
  assert.equal(env({}, false), false);
  assert.equal(env({ NO_COLOR: "1" }, true), false);
  assert.equal(env({ NO_COLOR: "" }, true), true);
  assert.equal(env({ FORCE_COLOR: "1" }, false), true);
  assert.equal(env({ FORCE_COLOR: "0" }, true), false);
  assert.equal(env({ NO_COLOR: "1", FORCE_COLOR: "1" }, true), false);
  assert.equal(env({ TERM: "dumb" }, true), false);
  assert.equal(env({ NO_COLOR: "1" }, true, true), true);
  assert.equal(env({}, true, false), false);
});

test("glyphs beyond ASCII only where the console draws them", () => {
  const on = (platform: string, e: Record<string, string>) =>
    unicodeEnabled({ isTTY: true, env: e, platform });
  assert.equal(on("win32", {}), false);
  assert.equal(on("win32", { WT_SESSION: "x" }), true);
  assert.equal(on("win32", { TERM_PROGRAM: "vscode" }), true);
  assert.equal(on("linux", { LANG: "en_US.UTF-8" }), true);
  assert.equal(on("linux", { LANG: "C" }), false);
  assert.equal(unicodeEnabled({ isTTY: false, env: {}, platform: "win32" }), true);
});

test("clipping counts characters, not bytes", () => {
  assert.equal(clip("short", 10), "short");
  assert.equal(clip("a  b\n c", 10), "a b c");
  assert.equal(clip("ααααααααααα", 5), "αααα…");
  assert.equal(clip("abcdefghij", 6, false), "abc...");
});
