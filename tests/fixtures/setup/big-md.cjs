// Writes a long Markdown file for the preview's speed test (D278): headings, paragraphs with
// inline marks, lists, code blocks (one per three sections), tables and quotes.
//   node big-md.cjs <file> [lines]
const { writeFileSync } = require("node:fs");

const file = process.argv[2] ?? "big.md";
const lines = Number(process.argv[3] ?? 10000);
const out = [];
for (let i = 1; out.length < lines; i++) {
  out.push(
    `## Section ${i}`,
    "",
    `Some *text* with **bold**, \`code\`, a [link](https://example.com/${i}) and more words on line ${i}.`,
    "Second line of the same paragraph with _emphasis_ and ~~strike~~.",
    "",
    `- item one ${i}`,
    "- item two with `x`",
    `  - nested ${i}`,
    "1. first",
    "2. second",
    "",
  );
  if (i % 3 === 0)
    out.push(
      "```ts",
      `const value${i} = ${i};`,
      `function times${i}(a: number) { return a * ${i}; }`,
      "```",
      "",
    );
  if (i % 5 === 0)
    out.push(
      "| a | b | c |",
      "|---|---|---|",
      `| ${i} | two | three |`,
      "| four | five | six |",
      "",
    );
  if (i % 7 === 0) out.push(`> A quote ${i}`, "> more quote", "");
}
writeFileSync(file, out.join("\n"));
