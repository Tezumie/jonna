// Large files for large-files-m7-121, written into the current folder: a JSON file of 300,000
// lines, a JSONL file of long lines, and a binary file under the editor's limit.
const fs = require("node:fs");

// A tokenizer's shape: one object of 150,000 keys and an array of 150,000 strings.
const vocab = [];
const merges = [];
for (let i = 0; i < 150000; i++) {
  vocab.push(`      "token_${i}": ${i}`);
  merges.push(`      "a${i} b${i}"`);
}
fs.writeFileSync(
  "tokenizer.json",
  `{\n  "version": "1.0",\n  "model": {\n    "vocab": {\n${vocab.join(",\n")}\n    },\n    "merges": [\n${merges.join(",\n")}\n    ]\n  }\n}\n`,
);

const lines = [];
for (let i = 0; i < 18000; i++)
  lines.push(
    JSON.stringify({
      prompt: `question ${i} ${"x".repeat(150)}`,
      completion: `answer ${"y".repeat(150)}`,
    }),
  );
fs.writeFileSync("train.jsonl", `${lines.join("\n")}\n`);

// A NUL byte at the start, as a model file's header length has.
fs.writeFileSync("adapter.safetensors", Buffer.alloc(35 * 1024 * 1024, 7).fill(0, 0, 8));
