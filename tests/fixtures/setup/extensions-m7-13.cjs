// Writes what tests/scripts/extensions-m7-13.jsonc uses, in the sample copy: a ".extras" file for
// the API extras extension's providers and decoration type, and two Markdown files (findFiles).
const fs = require("node:fs");
fs.writeFileSync(
  "sample.extras",
  [
    "region start",
    "  inner line",
    "region end",
    "link https://example.com/docs",
    "file notes.md",
    "color #ff0000",
    "TODO first",
    "plain",
    "TODO second",
    "gree",
    "",
  ].join("\n"),
);
fs.mkdirSync("extras-docs", { recursive: true });
fs.writeFileSync("extras-docs/one.md", "# One\n");
fs.writeFileSync("extras-docs/two.md", "# Two\n");
console.log("extras ready");
