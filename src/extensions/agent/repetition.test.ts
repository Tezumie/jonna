import assert from "node:assert/strict";
import { test } from "node:test";
import { endsInLoop, RepetitionWatch } from "./repetition";

const loop =
  "Intro text about a React project. " +
  'So we need to name the project "my-app" or something else. But they want a React demo project in this empty folder, not an extra folder. '.repeat(
    20,
  );

test("a passage repeated many times is a loop; normal prose and code aren't", () => {
  assert.equal(endsInLoop(loop, "thinking"), true);
  assert.equal(endsInLoop("short ".repeat(3), "thinking"), false);
  const prose = Array.from(
    { length: 60 },
    (_, i) => `Step ${i}: read file ${i}.ts and check its exports for item ${i * 7}. `,
  ).join("");
  assert.equal(endsInLoop(prose, "thinking"), false);
  // A few identical lines (a table, repeated imports) aren't enough.
  assert.equal(endsInLoop(`${"| a | b |\n".repeat(5)}done`, "text"), false);
});

test("the watch stops a looping stream, and overlong reasoning", () => {
  const w = new RepetitionWatch();
  let why: string | null = null;
  for (let i = 0; i < loop.length && !why; i += 50) why = w.push("thinking", loop.slice(i, i + 50));
  assert.match(why ?? "", /repeating itself/);
  const long = new RepetitionWatch();
  let stop: string | null = null;
  for (let i = 0; i < 200 && !stop; i++)
    stop = long.push("thinking", `${i} ${"varied reasoning text ".repeat(40)}${Math.random()}`);
  assert.match(stop ?? "", /far longer/);
});
